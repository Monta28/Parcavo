import { Injectable } from '@nestjs/common';
import type { ASSIGNMENT_STATUS_LABELS } from '@parc-auto/contracts';
import type { Prisma } from '@parc-auto/db';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, ErrorCodes, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import type { RequestContext } from '../../common/request-context.js';
import { type AssignmentField, type AssignmentStatus, assignmentStatus, canEndAssignment, currentAssignmentWhere, editableAssignmentFields, isAcceptableUpdatedEnd, replacementDecision, vehicleAcceptsAssignment } from '../../domain/responsible-assignment.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isConstraintViolation } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { OPERATIONAL_ROLES } from '../access-control/permissions.js';
import { DriversService } from '../drivers/drivers.service.js';
import { lockDriver, lockVehicle } from '../odometer/odometer-ingestion.service.js';
import { VehiclesService } from '../vehicles/vehicles.service.js';

/** États calculés (domain/responsible-assignment.ts), libellés dans @parc-auto/contracts (ASSIGNMENT_STATUS_LABELS). */
export const ASSIGNMENT_STATUSES = ['A_VENIR', 'EN_COURS', 'TERMINEE'] as const satisfies readonly (AssignmentStatus & keyof typeof ASSIGNMENT_STATUS_LABELS)[];

export class CreateAssignmentDto {
  @ApiProperty() @IsUUID() vehicleId!: string;
  @ApiProperty() @IsUUID() driverId!: string;
  @ApiProperty({ description: 'Début de la responsabilité.' }) @IsDateString() startsAt!: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional({ description: 'Clôture explicitement l’affectation EN_COURS (avec ou sans fin prévue) à la date de début de la nouvelle.' }) @IsOptional() @IsBoolean() replaceCurrent?: boolean;
  @ApiPropertyOptional({ description: 'Avec replaceCurrent : identifiant de l’affectation EN_COURS que l’utilisateur a choisi de remplacer. Si une autre affectation est en cours au moment de l’enregistrement, le remplacement est refusé (409 VERSION_OBSOLETE).' })
  @IsOptional()
  @IsUUID()
  replacedAssignmentId?: string;
  @ApiPropertyOptional({ description: 'Avec replacedAssignmentId : version affichée de cette affectation (verrou optimiste, 409 VERSION_OBSOLETE si elle a changé).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  replacedExpectedVersion?: number;
}

export class EndAssignmentDto {
  @ApiProperty() @IsDateString() endsAt!: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

/** Champ non effaçable : absent = inchangé ; null refusé (422). */
const present = (_object: object, value: unknown): boolean => value !== undefined;
/** Texte obligatoire : espaces de bord retirés avant les contrôles de longueur. */
const trimmed = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
/** Texte effaçable : espaces de bord retirés, chaîne vide enregistrée comme absente (null). */
const blankToNull = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() || null : value);

const ASSIGNMENT_FIELDS = ['driverId', 'startsAt', 'endsAt', 'notes'] as const satisfies readonly AssignmentField[];

/**
 * Modification d'une affectation habituelle (CDC 15.2) : motif et version attendue obligatoires. Une
 * affectation à venir est entièrement modifiable ; une affectation EN_COURS ne change que sa fin prévue
 * (future ou aucune) et ses notes ; une affectation terminée n'est plus modifiable (editableFields).
 */
export class UpdateAssignmentDto {
  @ApiPropertyOptional({ description: 'Affectation à venir seulement : autre responsable (conducteur actif de la société du véhicule) ; null refusé.' }) @ValidateIf(present) @IsUUID() driverId?: string;
  @ApiPropertyOptional({ description: 'Affectation à venir seulement : nouveau début ; null refusé.' }) @ValidateIf(present) @IsDateString() startsAt?: string;
  @ApiPropertyOptional({ nullable: true, type: String, description: 'Nouvelle fin prévue, strictement future et postérieure au début ; null : sans fin prévue. Terminer maintenant ou à une date passée : POST /:id/end.' })
  @IsOptional()
  @IsDateString()
  endsAt?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 1000, description: 'null ou texte blanc pour les retirer.' }) @Transform(blankToNull) @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
  @ApiProperty({ minLength: 3, maxLength: 500, description: 'Motif de la modification (journalisé avec l’auteur, la date et les valeurs avant/après).' }) @Transform(trimmed) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class AssignmentViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty() driverId!: string;
  @ApiProperty() driverName!: string;
  @ApiProperty() startsAt!: string;
  @ApiProperty({ nullable: true, type: String }) endsAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty({ nullable: true, type: String }) endReason!: string | null;
  @ApiProperty({ enum: ASSIGNMENT_STATUSES, description: 'État calculé par le serveur à l’instant de la réponse : A_VENIR (début futur), EN_COURS (début passé, sans fin ou fin future), TERMINEE.' })
  status!: AssignmentStatus;
  @ApiProperty({ description: 'Équivaut à status = EN_COURS.' }) isCurrent!: boolean;
  @ApiProperty({ description: 'Vrai si l’utilisateur peut terminer l’affectation : non terminée et rôle opérationnel sur sa société.' }) canEnd!: boolean;
  @ApiProperty({ enum: ASSIGNMENT_FIELDS, isArray: true, description: 'Champs que l’utilisateur peut modifier (PATCH) : tous pour une affectation à venir, fin prévue et notes pour une affectation en cours, aucun si elle est terminée ou sans rôle opérationnel sur sa société.' })
  editableFields!: AssignmentField[];
  @ApiProperty() version!: number;
}

const include = { vehicle: { select: { code: true } }, driver: { select: { firstName: true, lastName: true } } } as const;
type Row = Prisma.VehicleResponsibleAssignmentGetPayload<{ include: typeof include }>;

const OVERLAP_MESSAGE = 'Un responsable habituel est déjà affecté sur cette période ; clôturez-le ou demandez son remplacement explicite.';

/**
 * Responsable habituel (CDC 4.1, T08) : responsabilité sur une période, sans preuve de conduite, historique
 * indépendant des utilisations. Une utilisation ponctuelle ne le remplace jamais silencieusement.
 * Mutations sérialisées par le verrou du véhicule (puis du conducteur), état et version relus sous verrou ;
 * la contrainte d'exclusion responsible_no_overlap_vehicle garantit un seul responsable à la fois (D-136).
 */
@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly vehicles: VehiclesService,
    private readonly drivers: DriversService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(ctx: RequestContext, filter: { vehicleId?: string; driverId?: string }): Promise<AssignmentViewDto[]> {
    // Liste de gestion : refusée (403) à un compte conducteur seul avant toute lecture (D-009).
    this.access.requireStaff(ctx);
    if (!filter.vehicleId && !filter.driverId) throw new BusinessRuleError('FILTRE_REQUIS', 'Indiquez un véhicule ou un conducteur.');
    if (filter.vehicleId) await this.vehicles.load(ctx, filter.vehicleId);
    if (filter.driverId) await this.drivers.load(ctx, filter.driverId);
    const items = await this.prisma.client.vehicleResponsibleAssignment.findMany({
      where: { organizationId: ctx.organizationId, ...(filter.vehicleId ? { vehicleId: filter.vehicleId } : {}), ...(filter.driverId ? { driverId: filter.driverId } : {}), ...(ctx.isAdmin ? {} : { companyId: { in: [...ctx.visibleCompanyIds] } }) },
      include,
      orderBy: { startsAt: 'desc' },
    });
    const now = this.clock.now();
    return items.map((a) => this.view(ctx, a, now));
  }

  async create(ctx: RequestContext, dto: CreateAssignmentDto): Promise<AssignmentViewDto> {
    // Action de gestion : refusée (403) à un compte conducteur seul avant toute lecture (D-009).
    this.access.requireStaff(ctx);
    const vehicle = await this.vehicles.load(ctx, dto.vehicleId);
    this.access.requireOperational(ctx, vehicle.companyId);
    await this.drivers.load(ctx, dto.driverId);
    const startsAt = new Date(dto.startsAt);
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    if (endsAt && endsAt <= startsAt) throw new BusinessRuleError('INTERVALLE_INVALIDE', 'La fin doit suivre le début.', { fieldErrors: { endsAt: ['La fin doit suivre le début.'] } });
    if ((dto.replacedAssignmentId || dto.replacedExpectedVersion !== undefined) && !dto.replaceCurrent) {
      throw new BusinessRuleError('REMPLACEMENT_INCOHERENT', 'L’affectation à remplacer n’est prise en compte qu’avec une demande de remplacement explicite.', { fieldErrors: { replaceCurrent: ['Cochez le remplacement du responsable en cours.'] } });
    }
    if (dto.replacedExpectedVersion !== undefined && !dto.replacedAssignmentId) {
      throw new BusinessRuleError('REMPLACEMENT_INCOHERENT', 'Indiquez l’affectation dont la version est fournie.', { fieldErrors: { replacedAssignmentId: ['Affectation à remplacer requise avec sa version.'] } });
    }
    try {
      const id = await this.prisma.serializable(async (tx) => {
        // Ordre constant véhicule → conducteur (D-138) ; règles relues sur l'état verrouillé.
        await lockVehicle(tx, dto.vehicleId);
        await lockDriver(tx, dto.driverId);
        const v = await tx.vehicle.findUniqueOrThrow({ where: { id: dto.vehicleId }, select: { companyId: true, lifecycleStatus: true } });
        const d = await tx.driver.findUniqueOrThrow({ where: { id: dto.driverId }, select: { companyId: true, status: true } });
        this.access.requireOperational(ctx, v.companyId);
        this.assertAssignable(v, d);
        const now = this.clock.now();
        let replaced: { id: string; driverId: string; endsAt: Date | null; closedAt: Date } | null = null;
        if (dto.replaceCurrent) {
          const current = await tx.vehicleResponsibleAssignment.findFirst({ where: { vehicleId: dto.vehicleId, ...currentAssignmentWhere(now) } });
          // Verrou optimiste relu sous verrou : on ne remplace que l'affectation que l'utilisateur a vue (CDC 15.3).
          if (dto.replacedAssignmentId) {
            if (!current || current.id !== dto.replacedAssignmentId) {
              throw new ConflictError(ErrorCodes.VERSION_OBSOLETE, 'Le responsable habituel en cours a changé depuis l’affichage : rechargez l’historique avant de le remplacer.', { currentAssignmentId: current?.id ?? null });
            }
            if (dto.replacedExpectedVersion !== undefined) assertExpectedVersion(current, dto.replacedExpectedVersion, 'affectation en cours');
          }
          const decision = replacementDecision(current, startsAt);
          if (decision.action === 'REFUS_DEBUT_ANTERIEUR') {
            throw new BusinessRuleError('INTERVALLE_INVALIDE', 'Le nouveau responsable doit prendre effet après le début de l’affectation en cours.', { fieldErrors: { startsAt: ['Doit suivre le début de l’affectation en cours.'] } });
          }
          if (decision.action === 'CLOTURER' && current) {
            await tx.vehicleResponsibleAssignment.update({ where: { id: current.id, version: current.version }, data: { endsAt: decision.endsAt, endReason: 'Remplacé par un nouveau responsable habituel', endedById: ctx.userId, version: { increment: 1 } } });
            replaced = { id: current.id, driverId: current.driverId, endsAt: current.endsAt, closedAt: decision.endsAt };
            await this.audit.record(ctx, { action: 'responsable_habituel.remplacement', objectType: 'VehicleResponsibleAssignment', objectId: current.id, companyId: current.companyId, reason: 'Remplacé par un nouveau responsable habituel', before: { endsAt: current.endsAt }, after: { endsAt: decision.endsAt, remplacantDriverId: dto.driverId } }, tx);
          }
        }
        const a = await tx.vehicleResponsibleAssignment.create({ data: { organizationId: ctx.organizationId, companyId: v.companyId, vehicleId: dto.vehicleId, driverId: dto.driverId, startsAt, endsAt, notes: dto.notes ?? null, createdById: ctx.userId } });
        await this.audit.record(
          ctx,
          {
            action: 'responsable_habituel.affectation',
            objectType: 'VehicleResponsibleAssignment',
            objectId: a.id,
            companyId: v.companyId,
            before: replaced ? { assignmentId: replaced.id, driverId: replaced.driverId, endsAt: replaced.endsAt } : undefined,
            after: { driverId: dto.driverId, startsAt, endsAt, ...(replaced ? { remplace: replaced.id, clotureA: replaced.closedAt } : {}) },
          },
          tx,
        );
        return a.id;
      });
      return this.view(ctx, await this.prisma.client.vehicleResponsibleAssignment.findUniqueOrThrow({ where: { id }, include }), this.clock.now());
    } catch (error) {
      throw this.mapOverlap(error);
    }
  }

  async end(ctx: RequestContext, id: string, dto: EndAssignmentDto): Promise<AssignmentViewDto> {
    this.access.requireStaff(ctx);
    const a = await this.prisma.client.vehicleResponsibleAssignment.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!a || !this.access.canReadCompany(ctx, a.companyId)) throw new NotFoundOrOutOfScopeError('Affectation');
    this.access.requireOperational(ctx, a.companyId);
    const endsAt = new Date(dto.endsAt);
    try {
      await this.prisma.serializable(async (tx) => {
        await lockVehicle(tx, a.vehicleId);
        const fresh = await tx.vehicleResponsibleAssignment.findUnique({ where: { id } });
        if (!fresh) throw new NotFoundOrOutOfScopeError('Affectation');
        this.access.requireOperational(ctx, fresh.companyId);
        assertExpectedVersion(fresh, dto.expectedVersion, 'affectation');
        if (!canEndAssignment(fresh, this.clock.now())) throw new ConflictError('ETAT_INVALIDE', 'Cette affectation est déjà terminée.');
        if (endsAt <= fresh.startsAt) throw new BusinessRuleError('INTERVALLE_INVALIDE', 'La fin doit suivre le début.', { fieldErrors: { endsAt: ['La fin doit suivre le début.'] } });
        await tx.vehicleResponsibleAssignment.update({ where: { id, version: fresh.version }, data: { endsAt, endReason: dto.reason, endedById: ctx.userId, version: { increment: 1 } } });
        await this.audit.record(ctx, { action: 'responsable_habituel.fin', objectType: 'VehicleResponsibleAssignment', objectId: id, companyId: fresh.companyId, reason: dto.reason, before: { endsAt: fresh.endsAt }, after: { endsAt } }, tx);
      });
    } catch (error) {
      throw this.mapOverlap(error);
    }
    return this.view(ctx, await this.prisma.client.vehicleResponsibleAssignment.findUniqueOrThrow({ where: { id }, include }), this.clock.now());
  }

  /**
   * Modification (CDC 15.2 « modifier ») : motif et expectedVersion obligatoires, mêmes contrôles que la
   * nomination (véhicule dans le parc, conducteur actif de la même société, chevauchement refusé par la
   * contrainte d'exclusion), sous verrou du véhicule puis des conducteurs concernés (ordre constant), état et
   * version relus sous verrou, audit avant/après. Champs admis selon l'état (editableAssignmentFields).
   */
  async update(ctx: RequestContext, id: string, dto: UpdateAssignmentDto): Promise<AssignmentViewDto> {
    this.access.requireStaff(ctx);
    const a = await this.prisma.client.vehicleResponsibleAssignment.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!a || !this.access.canReadCompany(ctx, a.companyId)) throw new NotFoundOrOutOfScopeError('Affectation');
    this.access.requireOperational(ctx, a.companyId);
    const requested = ASSIGNMENT_FIELDS.filter((field) => dto[field] !== undefined);
    if (requested.length === 0) throw new BusinessRuleError('MODIFICATION_VIDE', 'Indiquez au moins un champ à modifier (responsable, début, fin prévue ou notes).');
    // Un autre conducteur doit être lisible dans le périmètre (404 sinon, comme à la nomination).
    if (dto.driverId !== undefined && dto.driverId !== a.driverId) await this.drivers.load(ctx, dto.driverId);
    try {
      await this.prisma.serializable(async (tx) => {
        // Ordre constant véhicule → conducteurs (D-138) ; règles relues sur l'état verrouillé.
        await lockVehicle(tx, a.vehicleId);
        for (const driverId of [...new Set([a.driverId, dto.driverId ?? a.driverId])].sort()) await lockDriver(tx, driverId);
        const fresh = await tx.vehicleResponsibleAssignment.findUnique({ where: { id } });
        if (!fresh) throw new NotFoundOrOutOfScopeError('Affectation');
        this.access.requireOperational(ctx, fresh.companyId);
        assertExpectedVersion(fresh, dto.expectedVersion, 'affectation');
        const now = this.clock.now();
        const editable = editableAssignmentFields(fresh, now);
        if (editable.length === 0) throw new ConflictError('ETAT_INVALIDE', 'Cette affectation est terminée : son historique n’est plus modifiable.');
        const next = {
          driverId: dto.driverId ?? fresh.driverId,
          startsAt: dto.startsAt !== undefined ? new Date(dto.startsAt) : fresh.startsAt,
          endsAt: dto.endsAt === undefined ? fresh.endsAt : dto.endsAt === null ? null : new Date(dto.endsAt),
          notes: dto.notes === undefined ? fresh.notes : dto.notes,
        };
        const changed: Record<AssignmentField, boolean> = {
          driverId: next.driverId !== fresh.driverId,
          startsAt: next.startsAt.getTime() !== fresh.startsAt.getTime(),
          endsAt: (next.endsAt?.getTime() ?? null) !== (fresh.endsAt?.getTime() ?? null),
          notes: next.notes !== fresh.notes,
        };
        const forbidden = ASSIGNMENT_FIELDS.filter((field) => changed[field] && !editable.includes(field));
        if (forbidden.length > 0) {
          const message = 'Affectation en cours : seuls la fin prévue et les notes sont modifiables. Pour confier le véhicule à un autre responsable, nommez-le avec un remplacement explicite (l’historique est conservé).';
          throw new BusinessRuleError('MODIFICATION_INTERDITE', message, { fieldErrors: Object.fromEntries(forbidden.map((field) => [field, ['Non modifiable pour une affectation en cours.']])) });
        }
        if (next.endsAt && next.endsAt <= next.startsAt) throw new BusinessRuleError('INTERVALLE_INVALIDE', 'La fin doit suivre le début.', { fieldErrors: { endsAt: ['La fin doit suivre le début.'] } });
        if (changed.endsAt && !isAcceptableUpdatedEnd(next.endsAt, now)) {
          throw new BusinessRuleError('FIN_PASSEE', 'Une modification ne fixe qu’une fin future (ou aucune fin) : pour terminer l’affectation maintenant ou à une date passée, utilisez « Terminer l’affectation » avec son motif.', { fieldErrors: { endsAt: ['Fin future attendue.'] } });
        }
        const v = await tx.vehicle.findUniqueOrThrow({ where: { id: fresh.vehicleId }, select: { companyId: true, lifecycleStatus: true } });
        const d = await tx.driver.findUniqueOrThrow({ where: { id: next.driverId }, select: { companyId: true, status: true } });
        this.access.requireOperational(ctx, v.companyId);
        this.assertAssignable(v, d);
        await tx.vehicleResponsibleAssignment.update({ where: { id, version: fresh.version }, data: { ...next, version: { increment: 1 } } });
        await this.audit.record(
          ctx,
          {
            action: 'responsable_habituel.modification',
            objectType: 'VehicleResponsibleAssignment',
            objectId: id,
            companyId: fresh.companyId,
            reason: dto.reason,
            before: { driverId: fresh.driverId, startsAt: fresh.startsAt, endsAt: fresh.endsAt, notes: fresh.notes },
            after: { ...next, changedFields: ASSIGNMENT_FIELDS.filter((field) => changed[field]) },
          },
          tx,
        );
      });
    } catch (error) {
      throw this.mapOverlap(error);
    }
    return this.view(ctx, await this.prisma.client.vehicleResponsibleAssignment.findUniqueOrThrow({ where: { id }, include }), this.clock.now());
  }

  /** Règles d'une nouvelle affectation, sur l'état verrouillé (CDC 3.3 ; D-136). */
  private assertAssignable(vehicle: { companyId: string; lifecycleStatus: string }, driver: { companyId: string; status: string }): void {
    if (!vehicleAcceptsAssignment(vehicle.lifecycleStatus)) throw new BusinessRuleError('VEHICULE_INACTIF', 'Un véhicule cédé ou archivé ne peut pas recevoir de responsable habituel.', { fieldErrors: { vehicleId: ['Véhicule cédé ou archivé.'] } });
    if (driver.companyId !== vehicle.companyId) throw new BusinessRuleError('SOCIETE_DIFFERENTE', 'Le conducteur et le véhicule n’appartiennent pas à la même société.', { fieldErrors: { driverId: ['Conducteur d’une autre société.'] } });
    if (driver.status !== 'ACTIF') throw new BusinessRuleError('CONDUCTEUR_INACTIF', 'Le conducteur est inactif.', { fieldErrors: { driverId: ['Conducteur inactif.'] } });
  }

  private mapOverlap(error: unknown): unknown {
    if (isConstraintViolation(error, 'responsible_no_overlap_vehicle')) return new ConflictError('RESPONSABLE_CHEVAUCHEMENT', OVERLAP_MESSAGE);
    return error;
  }

  private view(ctx: RequestContext, a: Row, now: Date): AssignmentViewDto {
    const status = assignmentStatus(a, now);
    return {
      id: a.id,
      companyId: a.companyId,
      vehicleId: a.vehicleId,
      vehicleCode: a.vehicle.code,
      driverId: a.driverId,
      driverName: `${a.driver.firstName} ${a.driver.lastName}`,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt?.toISOString() ?? null,
      notes: a.notes,
      endReason: a.endReason,
      status,
      isCurrent: status === 'EN_COURS',
      canEnd: canEndAssignment(a, now) && this.access.hasRole(ctx, a.companyId, OPERATIONAL_ROLES),
      editableFields: this.access.hasRole(ctx, a.companyId, OPERATIONAL_ROLES) ? editableAssignmentFields(a, now) : [],
      version: a.version,
    };
  }
}

