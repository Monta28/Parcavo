import { Injectable } from '@nestjs/common';
import type { AttachmentOwnerType } from '@parc-auto/db';
import type { RequestContext } from '../../common/request-context.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import type { OwnerAuthorization } from './attachments.service.js';

/**
 * Décide si un utilisateur peut lire la pièce jointe d'un objet métier (CDC 16.2, 2.3).
 * Un conducteur ne voit que ses propres soumissions et les fichiers de son utilisation en cours.
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

  private async staffCanRead(ctx: RequestContext, ownerType: AttachmentOwnerType, ownerId: string, companyId: string): Promise<boolean> {
    switch (ownerType) {
      case 'PLEIN':
      case 'DEPENSE':
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
        const entry = await this.prisma.client.fuelEntry.findFirst({ where: { id: ownerId, driverId: ctx.driverId }, select: { id: true } });
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
      default:
        return false;
    }
  }
}
