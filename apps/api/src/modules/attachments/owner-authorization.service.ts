import { Injectable } from '@nestjs/common';
import type { AttachmentOwnerType } from '@parc-auto/db';
import { BusinessRuleError, ForbiddenActionError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { driverOwnWhere } from '../fuel/fuel-visibility.js';
import type { OwnerAuthorization } from './attachments.service.js';

/** Fichiers techniques : leur conservation suit leur module (imports, exports, rapports de télématique). */
const TECHNICAL_OWNERS: readonly AttachmentOwnerType[] = ['IMPORT', 'EXPORT', 'TELEMETRIE_RAPPORT'];

/**
 * Décide si un utilisateur peut lire la pièce jointe d'un objet métier (CDC 16.2, 2.3), et s'il peut la
 * gérer (supprimer). Un conducteur ne voit que ses propres soumissions et les fichiers de son utilisation
 * en cours ; il ne supprime jamais une pièce rattachée.
 */
@Injectable()
export class OwnerAuthorizationService implements OwnerAuthorization {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  async canRead(ctx: RequestContext, ownerType: AttachmentOwnerType, ownerId: string, companyId: string | null): Promise<boolean> {
    if (ctx.isAdmin) return true;
    if (ctx.isDriverOnly) return this.driverCanRead(ctx, ownerType, ownerId);
    if (companyId) return this.access.canReadCompany(ctx, companyId) && this.staffCanRead(ctx, ownerType, ownerId, companyId);
    return false;
  }

  /**
   * Droit de GESTION du propriétaire, exigé pour supprimer une pièce rattachée (appelé après canRead) :
   *  - DOCUMENT : permission documents.manage (comme la correction d'une version, D-209) ;
   *  - RELEVE, SEGMENT_COMPTEUR : rôle opérationnel et permission readings.correct (preuve du compteur) ;
   *  - PLEIN, DEPENSE : rôle opérationnel et permission costs.write ;
   *  - VEHICULE, CONDUCTEUR, PERMIS, UTILISATION, INCIDENT, INTERVENTION : rôle opérationnel ;
   *  - SOCIETE_LOGO : administrateur ; fichiers techniques : jamais par cette voie.
   * La lecture seule (lecteur, conducteur) ne suffit jamais.
   */
  assertCanManage(ctx: RequestContext, ownerType: AttachmentOwnerType, companyId: string | null): void {
    if (ctx.isDriverOnly) throw new ForbiddenActionError('Un conducteur ne supprime pas une pièce jointe enregistrée : signalez l’erreur au gestionnaire du parc.');
    if (TECHNICAL_OWNERS.includes(ownerType)) {
      throw new BusinessRuleError('PIECE_JOINTE_TECHNIQUE', 'Ce fichier technique (import, export ou rapport de télématique) suit la conservation de son module : il ne se supprime pas ici.');
    }
    if (ownerType === 'SOCIETE_LOGO') {
      this.access.requireAdmin(ctx);
      return;
    }
    if (!companyId) {
      if (ctx.isAdmin) return;
      throw new NotFoundOrOutOfScopeError('Pièce jointe');
    }
    switch (ownerType) {
      case 'DOCUMENT':
        this.access.requirePermission(ctx, companyId, 'documents.manage', 'La suppression du justificatif d’un document requiert la permission documents.manage.');
        return;
      case 'RELEVE':
      case 'SEGMENT_COMPTEUR':
        this.access.requireOperational(ctx, companyId);
        this.access.requirePermission(ctx, companyId, 'readings.correct', 'La suppression de la preuve d’un relevé requiert la permission readings.correct.');
        return;
      case 'PLEIN':
      case 'DEPENSE':
        this.access.requireOperational(ctx, companyId);
        this.access.requirePermission(ctx, companyId, 'costs.write', 'La suppression d’un justificatif de coût requiert la permission costs.write.');
        return;
      default:
        this.access.requireOperational(ctx, companyId);
    }
  }

  private async staffCanRead(ctx: RequestContext, ownerType: AttachmentOwnerType, ownerId: string, companyId: string): Promise<boolean> {
    switch (ownerType) {
      // Ticket de plein et facture de dépense : pièces de coût, lisibles seulement avec costs.read (D-266).
      case 'PLEIN':
      case 'DEPENSE':
        return this.access.hasPermission(ctx, companyId, 'costs.read');
      // Pièces d'intervention (rapports, photos, factures) : costs.read ou rôle opérationnel de la société.
      case 'INTERVENTION':
        return this.access.hasPermission(ctx, companyId, 'costs.read') || this.access.hasRole(ctx, companyId, ['CHEF_PARC', 'OPERATEUR']);
      case 'PERMIS':
      case 'CONDUCTEUR': {
        const driver = await this.prisma.client.driver.findFirst({ where: ownerType === 'PERMIS' ? { permits: { some: { id: ownerId } } } : { id: ownerId }, select: { companyId: true } });
        return driver !== null && this.access.canReadCompany(ctx, driver.companyId);
      }
      default:
        return true;
    }
  }

  private async driverCanRead(ctx: RequestContext, ownerType: AttachmentOwnerType, ownerId: string): Promise<boolean> {
    if (!ctx.driverId) return false;
    switch (ownerType) {
      case 'RELEVE': {
        const reading = await this.prisma.client.odometerReading.findFirst({ where: { id: ownerId, createdById: ctx.userId }, select: { id: true } });
        return reading !== null;
      }
      case 'PLEIN': {
        // Ses propres soumissions uniquement (règle unique du module carburant) : jamais le ticket ou la
        // facture d'un plein saisi par le personnel, même à son nom (2.3).
        const entry = await this.prisma.client.fuelEntry.findFirst({ where: { AND: [{ id: ownerId }, driverOwnWhere(ctx)] }, select: { id: true } });
        return entry !== null;
      }
      case 'INCIDENT': {
        const incident = await this.prisma.client.incident.findFirst({ where: { id: ownerId, OR: [{ driverId: ctx.driverId }, { reportedById: ctx.userId }] }, select: { id: true } });
        return incident !== null;
      }
      case 'UTILISATION': {
        const usage = await this.prisma.client.vehicleUsage.findFirst({ where: { id: ownerId, driverId: ctx.driverId }, select: { id: true } });
        return usage !== null;
      }
      case 'PERMIS': {
        const permit = await this.prisma.client.driverPermit.findFirst({ where: { id: ownerId, driverId: ctx.driverId }, select: { id: true } });
        return permit !== null;
      }
      case 'DOCUMENT': {
        // Ses propres documents, ou ceux marqués visibles du véhicule de son utilisation en cours (D-209).
        const doc = await this.prisma.client.documentVersion.findFirst({ where: { id: ownerId, archivedAt: null }, select: { driverId: true, vehicleId: true, documentType: { select: { visibleToDriver: true } } } });
        if (!doc) return false;
        if (doc.driverId === ctx.driverId) return true;
        if (!doc.vehicleId || !doc.documentType.visibleToDriver) return false;
        const usage = await this.prisma.client.vehicleUsage.findFirst({ where: { vehicleId: doc.vehicleId, driverId: ctx.driverId, status: 'EN_COURS' }, select: { id: true } });
        return usage !== null;
      }
      default:
        return false;
    }
  }
}
