import { Injectable } from '@nestjs/common';
import type { Prisma } from '@parc-auto/db';
import type { RequestContext } from '../../common/request-context.js';
import { endOfLocalDay, fromDbDate, localDate, monthBounds, startOfLocalDay, toDbDate } from '../../domain/civil-date.js';
import { truncatedKm } from '../../domain/maintenance-schedule.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import type { CalendarDueItemDto, CalendarInterventionDto, MaintenanceCalendarDto, MaintenanceCalendarQueryDto } from './dto/maintenance.dto.js';
import { MaintenancePlansService } from './maintenance-plans.service.js';
import { Decimal } from 'decimal.js';

/** Nombre maximal d'éléments de chaque nature renvoyés pour un mois (au-delà : truncated, affiner le filtre). */
const CALENDAR_LIMIT = 1000;

/**
 * Calendrier des échéances (CDC 10.2 « /entretiens : … calendrier ») : pour un mois civil du fuseau de
 * l'organisation, échéances en date des plans actifs (valeurs calculées et matérialisées par la règle unique
 * maintenance-schedule.ts, statut du jour local) et interventions planifiées. Le web n'affiche que ces
 * valeurs : aucune échéance ni statut n'est recalculé côté pages (14.2).
 */
@Injectable()
export class MaintenanceCalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly plans: MaintenancePlansService,
  ) {}

  async month(ctx: RequestContext, query: MaintenanceCalendarQueryDto): Promise<MaintenanceCalendarDto> {
    this.access.requireStaff(ctx);
    const { from, to } = monthBounds(`${query.month}-01`);
    const scope = { ...this.access.companyWhere(ctx, query.companyId), ...(query.vehicleId ? { vehicleId: query.vehicleId } : {}) };
    // Statuts matérialisés ramenés au jour local courant avant lecture (comme la liste des échéances).
    const timezone = await this.plans.refreshScope(ctx.organizationId, scope);
    const planWhere: Prisma.VehicleMaintenancePlanWhereInput = { ...scope, active: true, nextDueDate: { gte: toDbDate(from) as Date, lte: toDbDate(to) as Date } };
    const interventionWhere: Prisma.InterventionWhereInput = { ...scope, status: 'PLANIFIEE', plannedStartAt: { gte: startOfLocalDay(from, timezone), lte: endOfLocalDay(to, timezone) } };
    const [plans, overdueBeforeCount, interventions] = await Promise.all([
      this.prisma.client.vehicleMaintenancePlan.findMany({
        where: planWhere,
        select: { id: true, companyId: true, vehicleId: true, nextDueDate: true, nextDueKm: true, computedStatus: true, vehicle: { select: { code: true } }, maintenanceType: { select: { label: true } } },
        orderBy: [{ nextDueDate: 'asc' }, { vehicle: { code: 'asc' } }, { id: 'asc' }],
        take: CALENDAR_LIMIT + 1,
      }),
      this.prisma.client.vehicleMaintenancePlan.count({ where: { ...scope, active: true, computedStatus: 'EN_RETARD', nextDueDate: { lt: toDbDate(from) as Date } } }),
      this.prisma.client.intervention.findMany({
        where: interventionWhere,
        select: { id: true, reference: true, companyId: true, vehicleId: true, kind: true, plannedStartAt: true, plannedEndAt: true, vehicle: { select: { code: true } }, tasks: { select: { label: true }, orderBy: { createdAt: 'asc' } } },
        orderBy: [{ plannedStartAt: 'asc' }, { reference: 'asc' }],
        take: CALENDAR_LIMIT + 1,
      }),
    ]);
    const dueItems: CalendarDueItemDto[] = plans.slice(0, CALENDAR_LIMIT).map((p) => ({
      planId: p.id,
      companyId: p.companyId,
      vehicleId: p.vehicleId,
      vehicleCode: p.vehicle.code,
      maintenanceTypeLabel: p.maintenanceType.label,
      date: fromDbDate(p.nextDueDate) as string,
      nextDueKm: truncatedKm(p.nextDueKm === null ? null : new Decimal(p.nextDueKm.toString())),
      status: p.computedStatus,
    }));
    const planned: CalendarInterventionDto[] = interventions.slice(0, CALENDAR_LIMIT).map((i) => ({
      id: i.id,
      reference: i.reference,
      companyId: i.companyId,
      vehicleId: i.vehicleId,
      vehicleCode: i.vehicle.code,
      kind: i.kind,
      date: localDate(i.plannedStartAt as Date, timezone),
      plannedStartAt: (i.plannedStartAt as Date).toISOString(),
      plannedEndAt: i.plannedEndAt?.toISOString() ?? null,
      tasks: i.tasks.map((t) => t.label),
    }));
    return { month: query.month, from, to, timezone, dueItems, interventions: planned, overdueBeforeCount, truncated: plans.length > CALENDAR_LIMIT || interventions.length > CALENDAR_LIMIT };
  }
}
