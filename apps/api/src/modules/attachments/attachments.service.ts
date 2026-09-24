import { Injectable, Logger } from '@nestjs/common';
import { fileTypeFromBuffer } from 'file-type';
import type { Attachment, AttachmentOwnerType } from '@parc-auto/db';
import { AfterCommit } from '../../common/after-commit.js';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';
import { ObjectStorage } from '../../infra/storage.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { AttachmentViewDto } from './dto/attachments.dto.js';
import { sanitizeUpload } from './file-sanitizer.js';
import type { Readable } from 'node:stream';

/** Types autorisés (CDC 16.2) : PDF, JPEG, PNG ; contrôle du type réel par signature binaire. */
const ALLOWED_MIME = new Map<string, string>([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
]);

const TEMP_TTL_MS = 24 * 3600 * 1000;

export interface OwnerAuthorization {
  /** Vrai si le contexte peut lire l'objet propriétaire (vérification déléguée au module métier). */
  canRead(ctx: RequestContext, ownerType: AttachmentOwnerType, ownerId: string, companyId: string | null): Promise<boolean>;
  /** Exige le droit de GESTION du propriétaire (403 si l'objet est lisible sans être gérable). */
  assertCanManage(ctx: RequestContext, ownerType: AttachmentOwnerType, companyId: string | null): void;
}

/** Objet métier dont une colonne référençait la pièce jointe supprimée (détaché dans la même transaction). */
export interface DetachedReference {
  objectType: 'DocumentVersion' | 'OdometerReading' | 'OdometerSegment' | 'DriverPermit' | 'FuelEntry' | 'Expense' | 'Company';
  objectId: string;
  companyId: string | null;
  field: string;
}

/**
 * Pièces jointes privées (CDC 16.2) : téléversement en zone temporaire (sans propriétaire), rattachement
 * explicite par le module métier, téléchargement après autorisation du propriétaire métier.
 * Un UUID n'est jamais une autorisation.
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorage,
    private readonly access: AccessControlService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  /** Téléversement : fichier temporaire rattaché à l'organisation et à une société du périmètre. */
  async upload(ctx: RequestContext, file: { originalname: string; buffer: Buffer; size: number }, companyId: string | null): Promise<AttachmentViewDto> {
    if (companyId) this.access.assertCompanyReadable(ctx, companyId);
    if (!ctx.isAdmin && !companyId) {
      throw new BusinessRuleError('SOCIETE_REQUISE', 'Indiquez la société de rattachement du fichier.', { fieldErrors: { companyId: ['Société requise.'] } });
    }
    if (file.size <= 0) throw new BusinessRuleError('FICHIER_VIDE', 'Le fichier est vide.');
    // Taille maximale paramétrée (17.1 : 10 Mo par défaut, jamais au-delà).
    const maxSizeBytes = await this.settings.get(ctx.organizationId, 'attachments.maxSizeBytes', companyId);
    if (file.size > maxSizeBytes) {
      throw new BusinessRuleError('FICHIER_TROP_VOLUMINEUX', `Le fichier dépasse la taille maximale de ${(maxSizeBytes / (1024 * 1024)).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo.`);
    }
    const detected = await fileTypeFromBuffer(file.buffer);
    const mime = detected?.mime ?? '';
    if (!ALLOWED_MIME.has(mime)) {
      throw new BusinessRuleError('TYPE_FICHIER_INTERDIT', 'Seuls les fichiers PDF, JPEG et PNG sont acceptés (type réel vérifié).', { details: { detected: mime || 'inconnu' } });
    }
    const sanitized = sanitizeUpload(mime, file.buffer);
    if (sanitized.rejected) throw new BusinessRuleError('FICHIER_CONTENU_ACTIF', sanitized.rejected);
    const safeName = sanitizeFileName(file.originalname, ALLOWED_MIME.get(mime) ?? 'bin');
    const stored = await this.storage.put(sanitized.buffer);
    const record = await this.prisma.client.attachment.create({
      data: {
        organizationId: ctx.organizationId,
        companyId,
        storageKey: stored.storageKey,
        originalName: safeName,
        mimeType: mime,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        uploadedById: ctx.userId,
        createdAt: this.clock.now(),
      },
    });
    return this.view(record);
  }

  /**
   * Rattache un fichier temporaire à son propriétaire métier (appelé dans la transaction du module).
   * Le fichier doit appartenir à l'organisation, être non rattaché et avoir été téléversé par
   * l'utilisateur courant ou un utilisateur du même périmètre.
   * `sameCompany` : le fichier doit en outre avoir été téléversé pour la société du propriétaire (ou sans
   * société, par l'administrateur) ; un fichier d'une autre société est hors périmètre de l'objet (404),
   * même si l'utilisateur voit les deux sociétés (15.3 : clôture d'intervention).
   */
  async attach(ctx: RequestContext, tx: Tx, attachmentId: string, ownerType: AttachmentOwnerType, ownerId: string, companyId: string | null, options: { sameCompany?: boolean } = {}): Promise<Attachment> {
    const att = await tx.attachment.findFirst({ where: { id: attachmentId, organizationId: ctx.organizationId, deletedAt: null } });
    if (!att) throw new NotFoundOrOutOfScopeError('Pièce jointe');
    if (att.companyId && !this.access.canReadCompany(ctx, att.companyId)) throw new NotFoundOrOutOfScopeError('Pièce jointe');
    if (options.sameCompany && companyId && att.companyId && att.companyId !== companyId) throw new NotFoundOrOutOfScopeError('Pièce jointe');
    // Un fichier temporaire (sans propriétaire) n'est rattachable que par l'utilisateur qui l'a téléversé :
    // connaître son identifiant ne permet pas de s'approprier le fichier d'un autre.
    if (!att.ownerId && att.uploadedById !== ctx.userId) throw new NotFoundOrOutOfScopeError('Pièce jointe');
    if (att.ownerId && (att.ownerType !== ownerType || att.ownerId !== ownerId)) {
      throw new BusinessRuleError('PIECE_JOINTE_DEJA_RATTACHEE', 'Cette pièce jointe est déjà rattachée à un autre objet.');
    }
    return tx.attachment.update({ where: { id: att.id }, data: { ownerType, ownerId, companyId: companyId ?? att.companyId, attachedAt: this.clock.now() } });
  }

  /** Lecture autorisée : l'appelant fournit la décision d'accès au propriétaire métier. */
  async open(ctx: RequestContext, id: string, authorize: OwnerAuthorization): Promise<{ attachment: Attachment; stream: Readable }> {
    const att = await this.prisma.client.attachment.findFirst({ where: { id, organizationId: ctx.organizationId, deletedAt: null } });
    if (!att) throw new NotFoundOrOutOfScopeError('Pièce jointe');
    let allowed = false;
    if (att.ownerType && att.ownerId) {
      allowed = await authorize.canRead(ctx, att.ownerType, att.ownerId, att.companyId);
    } else {
      // fichier temporaire : visible uniquement par son auteur
      allowed = att.uploadedById === ctx.userId;
    }
    if (!allowed) throw new NotFoundOrOutOfScopeError('Pièce jointe');
    const stream = await this.storage.openRead(att.storageKey);
    return { attachment: att, stream };
  }

  async listForOwner(ownerType: AttachmentOwnerType, ownerId: string): Promise<AttachmentViewDto[]> {
    const items = await this.prisma.client.attachment.findMany({ where: { ownerType, ownerId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
    return items.map((a) => this.view(a));
  }

  /**
   * Suppression logique autorisée et journalisée (CDC 16.2). Autorisation : lecture du propriétaire (sinon
   * 404), puis droit de GESTION du propriétaire (documents.manage pour un document, rôle opérationnel et
   * permission propre pour les autres objets) ; un fichier temporaire n'est supprimable que par son auteur.
   * La pièce est verrouillée en tête de transaction (lockForUpdate) : l'autorisation porte sur son état
   * courant, et une correction concurrente de l'objet qui la référence est sérialisée sans interblocage.
   */
  async remove(ctx: RequestContext, id: string, authorize: OwnerAuthorization, reason: string): Promise<{ detached: DetachedReference[] }> {
    const after = new AfterCommit();
    const detached = await this.prisma.transaction(async (tx) => {
      await this.lockForUpdate(tx, [id]);
      const att = await tx.attachment.findFirst({ where: { id, organizationId: ctx.organizationId, deletedAt: null } });
      if (!att) throw new NotFoundOrOutOfScopeError('Pièce jointe');
      if (att.ownerType && att.ownerId) {
        if (!(await authorize.canRead(ctx, att.ownerType, att.ownerId, att.companyId))) throw new NotFoundOrOutOfScopeError('Pièce jointe');
        authorize.assertCanManage(ctx, att.ownerType, att.companyId);
      } else if (att.uploadedById !== ctx.userId) {
        throw new NotFoundOrOutOfScopeError('Pièce jointe');
      }
      return this.discard(ctx, tx, att.id, reason, after);
    });
    await after.run();
    return { detached };
  }

  /**
   * Verrou des pièces jointes (SELECT … FOR UPDATE, ordre constant par identifiant), à prendre en tête de
   * transaction AVANT d'écrire l'objet métier qui les référence : ordre unique pièce jointe → objet métier,
   * partagé par la suppression (remove) et la correction d'un document qui détache ou remplace son
   * justificatif. Les lectures suivantes de la transaction voient l'état validé le plus récent.
   */
  async lockForUpdate(tx: Tx, ids: readonly string[]): Promise<void> {
    for (const id of [...new Set(ids)].sort()) await tx.$queryRaw`SELECT id FROM "Attachment" WHERE id = ${id}::uuid FOR UPDATE`;
  }

  /**
   * Suppression logique dans la transaction de l'appelant : la pièce est marquée supprimée, toute référence
   * métier directe (justificatif d'un document, photo d'un relevé, ticket, facture, permis, logo…) est
   * détachée avec incrément de version, et chaque objet détaché reçoit une trace d'audit portant le motif.
   * Les photos rattachées par propriétaire (véhicule, incident, intervention, utilisation) disparaissent de
   * leurs listes avec la pièce. Le contenu est effacé du stockage après validation de la transaction.
   * `alreadyDeletedOk` : un fichier déjà supprimé (référence antérieure restée en place) n'est pas une erreur.
   * Précondition : la pièce a été verrouillée en tête de transaction (lockForUpdate).
   */
  async discard(ctx: RequestContext, tx: Tx, attachmentId: string, reason: string, after: AfterCommit, options: { alreadyDeletedOk?: boolean } = {}): Promise<DetachedReference[]> {
    const att = await tx.attachment.findFirst({ where: { id: attachmentId, organizationId: ctx.organizationId, deletedAt: null } });
    if (!att) {
      if (options.alreadyDeletedOk) return [];
      throw new NotFoundOrOutOfScopeError('Pièce jointe');
    }
    // Condition deletedAt IS NULL : une suppression concurrente déjà validée laisse 0 ligne (introuvable).
    const marked = await tx.attachment.updateMany({ where: { id: att.id, deletedAt: null }, data: { deletedAt: this.clock.now(), deletedById: ctx.userId } });
    if (marked.count !== 1) {
      if (options.alreadyDeletedOk) return [];
      throw new NotFoundOrOutOfScopeError('Pièce jointe');
    }
    const detached = await this.detachReferences(tx, ctx.organizationId, att.id);
    await this.audit.record(
      ctx,
      {
        action: 'piece_jointe.suppression',
        objectType: 'Attachment',
        objectId: att.id,
        companyId: att.companyId,
        reason,
        before: { originalName: att.originalName, ownerType: att.ownerType, ownerId: att.ownerId },
        after: { deleted: true, detachedFrom: detached.map((d) => ({ objectType: d.objectType, objectId: d.objectId })) },
      },
      tx,
    );
    for (const ref of detached) {
      await this.audit.record(ctx, { action: 'piece_jointe.detachement', objectType: ref.objectType, objectId: ref.objectId, companyId: ref.companyId, reason, before: { [ref.field]: att.id }, after: { [ref.field]: null } }, tx);
    }
    after.add(`effacement du fichier ${att.id}`, () => this.storage.remove(att.storageKey));
    return detached;
  }

  /**
   * Détache la pièce de toutes les colonnes métier qui la référencent (version incrémentée : verrou optimiste).
   * Une seule instruction par table (UPDATE … WHERE colonne = pièce RETURNING) : seules les lignes qui la
   * référencent encore au moment de l'écriture sont détachées et tracées ; un remplacement concurrent déjà
   * validé n'est jamais écrasé.
   */
  private async detachReferences(tx: Tx, organizationId: string, attachmentId: string): Promise<DetachedReference[]> {
    const bump = { version: { increment: 1 } } as const;
    const [documents, readings, segments, permits, fuel, expenses, companies] = [
      await tx.documentVersion.updateManyAndReturn({ where: { organizationId, attachmentId }, data: { attachmentId: null, ...bump }, select: { id: true, companyId: true } }),
      await tx.odometerReading.updateManyAndReturn({ where: { organizationId, attachmentId }, data: { attachmentId: null, ...bump }, select: { id: true, companyId: true } }),
      await tx.odometerSegment.updateManyAndReturn({ where: { organizationId, justificationAttachmentId: attachmentId }, data: { justificationAttachmentId: null, ...bump }, select: { id: true, vehicle: { select: { companyId: true } } } }),
      await tx.driverPermit.updateManyAndReturn({ where: { organizationId, attachmentId }, data: { attachmentId: null, ...bump }, select: { id: true, driver: { select: { companyId: true } } } }),
      await tx.fuelEntry.updateManyAndReturn({ where: { organizationId, ticketAttachmentId: attachmentId }, data: { ticketAttachmentId: null, ...bump }, select: { id: true, companyId: true } }),
      await tx.expense.updateManyAndReturn({ where: { organizationId, attachmentId }, data: { attachmentId: null, ...bump }, select: { id: true, companyId: true } }),
      await tx.company.updateManyAndReturn({ where: { organizationId, logoAttachmentId: attachmentId }, data: { logoAttachmentId: null, ...bump }, select: { id: true } }),
    ];
    return [
      ...documents.map((r) => ({ objectType: 'DocumentVersion' as const, objectId: r.id, companyId: r.companyId, field: 'attachmentId' })),
      ...readings.map((r) => ({ objectType: 'OdometerReading' as const, objectId: r.id, companyId: r.companyId, field: 'attachmentId' })),
      ...segments.map((r) => ({ objectType: 'OdometerSegment' as const, objectId: r.id, companyId: r.vehicle.companyId, field: 'justificationAttachmentId' })),
      ...permits.map((r) => ({ objectType: 'DriverPermit' as const, objectId: r.id, companyId: r.driver.companyId, field: 'attachmentId' })),
      ...fuel.map((r) => ({ objectType: 'FuelEntry' as const, objectId: r.id, companyId: r.companyId, field: 'ticketAttachmentId' })),
      ...expenses.map((r) => ({ objectType: 'Expense' as const, objectId: r.id, companyId: r.companyId, field: 'attachmentId' })),
      ...companies.map((r) => ({ objectType: 'Company' as const, objectId: r.id, companyId: r.id, field: 'logoAttachmentId' })),
    ];
  }

  /** Nettoyage des fichiers temporaires abandonnés (job worker). */
  async purgeAbandoned(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - TEMP_TTL_MS);
    const stale = await this.prisma.client.attachment.findMany({ where: { ownerId: null, deletedAt: null, createdAt: { lt: cutoff } }, take: 500 });
    for (const att of stale) {
      await this.storage.remove(att.storageKey);
      await this.prisma.client.attachment.update({ where: { id: att.id }, data: { deletedAt: this.clock.now() } });
    }
    if (stale.length > 0) this.logger.log(`${stale.length} fichier(s) temporaire(s) abandonné(s) nettoyé(s).`);
    return stale.length;
  }

  view(a: Attachment): AttachmentViewDto {
    return {
      id: a.id,
      originalName: a.originalName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      sha256: a.sha256,
      ownerType: a.ownerType,
      ownerId: a.ownerId,
      createdAt: a.createdAt.toISOString(),
      downloadPath: `/api/v1/attachments/${a.id}/download`,
    };
  }
}

export function sanitizeFileName(name: string, extension: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const stem = base.replace(/\.[^.]*$/, '') || 'fichier';
  return `${stem}.${extension}`;
}
