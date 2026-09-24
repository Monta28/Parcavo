import { Injectable, Logger } from '@nestjs/common';
import { fileTypeFromBuffer } from 'file-type';
import type { Attachment, AttachmentOwnerType } from '@parc-auto/db';
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
   */
  async attach(ctx: RequestContext, tx: Tx, attachmentId: string, ownerType: AttachmentOwnerType, ownerId: string, companyId: string | null): Promise<Attachment> {
    const att = await tx.attachment.findFirst({ where: { id: attachmentId, organizationId: ctx.organizationId, deletedAt: null } });
    if (!att) throw new NotFoundOrOutOfScopeError('Pièce jointe');
    if (att.companyId && !this.access.canReadCompany(ctx, att.companyId)) throw new NotFoundOrOutOfScopeError('Pièce jointe');
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

  /** Suppression logique autorisée et journalisée (CDC 16.2). */
  async remove(ctx: RequestContext, id: string, authorize: OwnerAuthorization, reason: string): Promise<void> {
    const att = await this.prisma.client.attachment.findFirst({ where: { id, organizationId: ctx.organizationId, deletedAt: null } });
    if (!att) throw new NotFoundOrOutOfScopeError('Pièce jointe');
    const allowed = att.ownerType && att.ownerId ? await authorize.canRead(ctx, att.ownerType, att.ownerId, att.companyId) : att.uploadedById === ctx.userId;
    if (!allowed) throw new NotFoundOrOutOfScopeError('Pièce jointe');
    await this.prisma.client.$transaction(async (tx) => {
      await tx.attachment.update({ where: { id }, data: { deletedAt: this.clock.now(), deletedById: ctx.userId } });
      await this.audit.record(ctx, { action: 'piece_jointe.suppression', objectType: 'Attachment', objectId: id, companyId: att.companyId, reason, before: { originalName: att.originalName, ownerType: att.ownerType, ownerId: att.ownerId } }, tx);
    });
    await this.storage.remove(att.storageKey);
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
