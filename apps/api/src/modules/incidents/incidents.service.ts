import { Injectable } from '@nestjs/common';
import type { IncidentSeverity, IncidentStatus, IncidentType, Prisma } from '@parc-auto/db';
import { AfterCommit } from '../../common/after-commit.js';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, ForbiddenActionError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { localDate } from '../../domain/civil-date.js';
import { netAmount } from '../../domain/expense-ledger.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';
import { ReferenceService } from '../../infra/reference.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { DriverSubmissionService } from '../assignments/driver-submission.service.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { costsReadableWhere, incidentExpensesWhere } from '../expenses/expense-links.js';
import { ImmobilizationsService } from '../immobilizations/immobilizations.service.js';
import { eventCompany } from '../vehicles/event-company.js';
import type { InterventionViewDto } from '../interventions/dto/interventions.dto.js';
import { assertIncidentAcceptsIntervention } from '../interventions/incident-link.js';
import { InterventionsService } from '../interventions/interventions.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { VehiclesService } from '../vehicles/vehicles.service.js';
import type {
  CreateCommentDto,
  CreateIncidentDto,
  FollowUpCandidateDto,
  FollowUpCandidatesQueryDto,
  IncidentCommentViewDto,
  IncidentImmobilizeDto,
  IncidentImmobilizeResultDto,
  IncidentInterventionDto,
  IncidentViewDto,
  IncidentsQueryDto,
  TransitionIncidentDto,
  UpdateIncidentDto,
} from './dto/incidents.dto.js';

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const NOWHERE = '00000000-0000-0000-0000-000000000000';

const incidentInclude = {
  vehicle: { select: { code: true, registration: true } },
  driver: { select: { firstName: true, lastName: true } },
  site: { select: { name: true } },
  interventions: { select: { id: true } },
  immobilizationCauses: { where: { endedAt: null }, select: { id: true } },
} satisfies Prisma.IncidentInclude;

type IncidentRow = Prisma.IncidentGetPayload<{ include: typeof incidentInclude }>;

/**
 * Personnel pouvant suivre un incident de la société (CDC 7.3) : utilisateur ACTIF de l'organisation,
 * administrateur, ou chef de parc / opérateur de la société. Définition unique (contrôle et liste).
 */
function followUpCandidateWhere(organizationId: string, companyId: string): Prisma.UserWhereInput {
  return { organizationId, status: 'ACTIF', memberships: { some: { OR: [{ companyId: null, role: 'ADMIN' }, { companyId, role: { in: ['CHEF_PARC', 'OPERATEUR'] } }] } } };
}

/** Un incident clôturé n'accepte plus d'immobilisation (D-215 : la clôture exige des causes terminées). */
function assertAcceptsImmobilization(status: IncidentStatus): void {
  if (status === 'CLOTURE') throw new ConflictError('ETAT_INVALIDE', 'Incident clôturé : aucune immobilisation ne peut plus y être rattachée.');
}

/** Utilisation en cours à un instant donné : départ au plus tard à cet instant, pas encore restituée. */
function usageCoversInstant(usage: { checkedOutAt: Date; returnedAt: Date | null }, at: Date): boolean {
  return usage.checkedOutAt <= at && (usage.returnedAt === null || usage.returnedAt > at);
}

/** Déclaration validée, prête à être enregistrée (autorisation et contrôles déjà passés). */
interface PreparedIncident {
  vehicle: { id: string; companyId: string };
  driverId: string | null;
  usageId: string | null;
  occurredAt: Date;
  severity: IncidentSeverity;
  timezone: string;
}

/**
 * Incidents (CDC 7.3, D-215 à D-218) : déclaration par le personnel ou par le conducteur sur son
 * utilisation, commentaires chronologiques jamais modifiés, résolution technique distincte de la
 * clôture administrative, alerte « incident critique non traité ». Une contravention reste une
 * information de suivi : aucune responsabilité ni retenue n'est déduite automatiquement.
 */
@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly vehicles: VehiclesService,
    private readonly attachments: AttachmentsService,
    private readonly alerts: AlertsService,
    private readonly immobilizations: ImmobilizationsService,
    private readonly interventions: InterventionsService,
    private readonly settings: SettingsService,
    private readonly references: ReferenceService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly clock: Clock,
    private readonly submissions: DriverSubmissionService,
  ) {}

  async list(ctx: RequestContext, query: IncidentsQueryDto): Promise<Page<IncidentViewDto>> {
    const scope: Prisma.IncidentWhereInput = ctx.isDriverOnly
      ? { organizationId: ctx.organizationId, OR: [{ driverId: ctx.driverId ?? NOWHERE }, { reportedById: ctx.userId }] }
      : this.access.companyWhere(ctx, query.companyId);
    const where: Prisma.IncidentWhereInput = {
      AND: [
        scope,
        query.vehicleId ? { vehicleId: query.vehicleId } : {},
        query.driverId && !ctx.isDriverOnly ? { driverId: query.driverId } : {},
        query.usageId ? { usageId: query.usageId } : {},
        query.status ? { status: query.status } : {},
        query.open === 'true' ? { status: { in: ['OUVERT', 'EN_TRAITEMENT', 'RESOLU'] } } : {},
        query.type ? { type: query.type } : {},
        query.severity ? { severity: query.severity } : {},
        query.q ? { OR: [{ reference: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } }] } : {},
      ],
    };
    const [items, total] = await Promise.all([
      this.prisma.client.incident.findMany({ where, include: incidentInclude, ...skipTake(query), orderBy: [{ occurredAt: 'desc' }] }),
      this.prisma.client.incident.count({ where }),
    ]);
    return pageOf(await this.views(ctx, items), total, query);
  }

  async get(ctx: RequestContext, id: string): Promise<IncidentViewDto> {
    const [view] = await this.views(ctx, [await this.load(ctx, id)]);
    if (!view) throw new NotFoundOrOutOfScopeError('Incident');
    return view;
  }

  /**
   * Responsables de suivi possibles pour une société (sélecteur des formulaires) : nom seulement,
   * pour le personnel de la société (lecteur compris, en lecture seule) ; le conducteur n'y a pas accès.
   */
  async followUpCandidates(ctx: RequestContext, query: FollowUpCandidatesQueryDto): Promise<FollowUpCandidateDto[]> {
    this.access.requireStaff(ctx);
    this.access.requireReader(ctx, query.companyId);
    const users = await this.prisma.client.user.findMany({
      where: followUpCandidateWhere(ctx.organizationId, query.companyId),
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    });
    return users.map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}` }));
  }

  /**
   * Déclaration. Personnel : véhicule du périmètre, conducteur/utilisation facultatifs.
   * Conducteur : véhicule, utilisation et conducteur fixés par le serveur (utilisation en cours ou
   * terminée depuis moins du délai paramétré, D-216) ; sans utilisation retenue, véhicule dont il est
   * responsable habituel si drivers.allowHabitualVehicleSubmissions est actif (D-268, règle unique de
   * DriverSubmissionService), pour un fait survenu depuis moins du même délai. En-tête Idempotency-Key facultatif (D-308) :
   * clé liée à l'organisation, à l'utilisateur et à l'opération ; même clé et même corps rejouent la
   * réponse initiale, corps différent : 409. Le rejeu n'a lieu qu'après les contrôles d'autorisation.
   */
  async create(ctx: RequestContext, dto: CreateIncidentDto, idempotencyKey?: string): Promise<IncidentViewDto> {
    if (idempotencyKey !== undefined && (idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
      throw new BusinessRuleError('IDEMPOTENCE_CLE_INVALIDE', 'La clé d’idempotence doit compter de 8 à 128 caractères.', { fieldErrors: { idempotencyKey: ['Clé de 8 à 128 caractères.'] } });
    }
    const prepared = await this.prepareDeclaration(ctx, dto);
    if (idempotencyKey === undefined) return this.get(ctx, await this.declare(ctx, dto, prepared));
    const result = await this.idempotency.run({ organizationId: ctx.organizationId, userId: ctx.userId, operation: 'incident.declaration', key: idempotencyKey }, dto, async () => {
      const id = await this.declare(ctx, dto, prepared);
      return { status: 201, body: await this.get(ctx, id), resourceId: id };
    });
    return result.body;
  }

  private async prepareDeclaration(ctx: RequestContext, dto: CreateIncidentDto): Promise<PreparedIncident> {
    const now = this.clock.now();
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : now;
    if (occurredAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) throw new BusinessRuleError('DATE_FUTURE', 'La date du fait ne peut pas être dans le futur.', { fieldErrors: { occurredAt: ['Date future refusée.'] } });
    let vehicle: { id: string; companyId: string };
    let driverId: string | null = null;
    let usageId: string | null = null;
    if (ctx.isDriverOnly) {
      if (!ctx.driverId) throw new ForbiddenActionError('Compte conducteur sans fiche conducteur liée.');
      const hours = await this.settings.get(ctx.organizationId, 'incidents.driverLateDeclarationHours');
      const since = new Date(now.getTime() - hours * 3_600_000);
      const usage = await this.prisma.client.vehicleUsage.findFirst({
        where: { driverId: ctx.driverId, ...(dto.vehicleId ? { vehicleId: dto.vehicleId } : {}), OR: [{ status: 'EN_COURS' }, { returnedAt: { gte: since } }] },
        orderBy: { checkedOutAt: 'desc' },
      });
      if (usage) {
        vehicle = { id: usage.vehicleId, companyId: usage.companyId };
        usageId = usage.id;
      } else {
        vehicle = await this.habitualVehicle(ctx, dto.vehicleId, occurredAt, now);
      }
      driverId = ctx.driverId;
      if (dto.driverId || dto.usageId || dto.followUpUserId || dto.siteId) throw new BusinessRuleError('CHAMP_RESERVE', 'Le conducteur, l’utilisation, le site et le responsable sont fixés par le serveur.');
    } else {
      if (!dto.vehicleId) throw new BusinessRuleError('VEHICULE_REQUIS', 'Indiquez le véhicule.', { fieldErrors: { vehicleId: ['Véhicule requis.'] } });
      const v = await this.vehicles.load(ctx, dto.vehicleId);
      this.access.requireOperational(ctx, v.companyId);
      vehicle = { id: v.id, companyId: v.companyId };
      if (dto.usageId) {
        const usage = await this.prisma.client.vehicleUsage.findFirst({ where: { id: dto.usageId, vehicleId: v.id, organizationId: ctx.organizationId } });
        if (!usage) throw new NotFoundOrOutOfScopeError('Utilisation');
        usageId = usage.id;
        driverId = dto.driverId ?? usage.driverId;
      } else if (dto.driverId) {
        driverId = dto.driverId;
      }
      if (driverId) {
        const driver = await this.prisma.client.driver.findFirst({ where: { id: driverId, organizationId: ctx.organizationId } });
        if (!driver || !this.access.canReadCompany(ctx, driver.companyId)) throw new NotFoundOrOutOfScopeError('Conducteur');
      }
      await this.assertFollowUp(ctx, dto.followUpUserId ?? null, v.companyId);
      if (dto.siteId) await this.assertSite(ctx, dto.siteId, v.companyId);
    }
    const severity: IncidentSeverity = dto.severity ?? (dto.type === 'ACCIDENT' ? 'ELEVEE' : 'MOYENNE');
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } });
    return { vehicle, driverId, usageId, occurredAt, severity, timezone: org.timezone };
  }

  /**
   * D-268 : sans utilisation retenue, véhicule dont le conducteur est responsable habituel actif, si le
   * paramètre drivers.allowHabitualVehicleSubmissions l'autorise (règle unique de DriverSubmissionService :
   * jamais pendant une utilisation EN_COURS d'un autre véhicule). Aucune utilisation n'est rattachée. Le fait
   * doit dater de moins de incidents.driverLateDeclarationHours (délai de la société du véhicule), comme une
   * déclaration après restitution (D-216). Autre véhicule ou paramètre inactif : 404, comme sans utilisation.
   */
  private async habitualVehicle(ctx: RequestContext, vehicleId: string | undefined, occurredAt: Date, now: Date): Promise<{ id: string; companyId: string }> {
    const habitual = (await this.submissions.targets(ctx)).filter((t) => t.basis === 'RESPONSABLE_HABITUEL' && (vehicleId === undefined || t.vehicleId === vehicleId));
    const [target] = habitual;
    if (!target) throw new NotFoundOrOutOfScopeError('Utilisation');
    if (habitual.length > 1) throw new BusinessRuleError('VEHICULE_REQUIS', 'Vous êtes responsable habituel de plusieurs véhicules : indiquez le véhicule concerné.', { fieldErrors: { vehicleId: ['Véhicule requis.'] } });
    const hours = await this.settings.get(ctx.organizationId, 'incidents.driverLateDeclarationHours', target.companyId);
    if (occurredAt.getTime() < now.getTime() - hours * 3_600_000) {
      throw new BusinessRuleError('DATE_HORS_DELAI', `Sans utilisation en cours, un problème se signale au plus tard ${hours} h après les faits.`, { fieldErrors: { occurredAt: [`Fait survenu il y a plus de ${hours} h.`] } });
    }
    return { id: target.vehicleId, companyId: target.companyId };
  }

  /** Enregistrement transactionnel de la déclaration préparée ; renvoie l'identifiant créé. */
  private async declare(ctx: RequestContext, dto: CreateIncidentDto, p: PreparedIncident): Promise<string> {
    const { id } = await this.prisma.client.$transaction((tx) =>
      this.insertInTx(tx, ctx, {
        companyId: p.vehicle.companyId,
        vehicleId: p.vehicle.id,
        driverId: p.driverId,
        usageId: p.usageId,
        type: dto.type,
        severity: p.severity,
        occurredAt: p.occurredAt,
        timezone: p.timezone,
        locationLabel: dto.locationLabel?.trim() || null,
        siteId: ctx.isDriverOnly ? null : (dto.siteId ?? null),
        description: dto.description.trim(),
        followUpUserId: ctx.isDriverOnly ? null : (dto.followUpUserId ?? null),
        photoAttachmentIds: dto.photoAttachmentIds ?? [],
        audit: { byDriver: ctx.isDriverOnly },
      }),
    );
    await this.syncCriticalAlert(id);
    return id;
  }

  /**
   * Écriture unique d'un incident dans une transaction existante (déclaration directe ou dommage constaté à
   * la restitution, 4.4) : référence INC-AAAA-NNNNNN de l'année locale, photos rattachées, audit. L'appelant
   * synchronise l'alerte d'incident critique après validation (syncCriticalAlert).
   */
  async insertInTx(
    tx: Tx,
    ctx: RequestContext,
    input: {
      companyId: string;
      vehicleId: string;
      driverId: string | null;
      usageId: string | null;
      type: IncidentType;
      severity: IncidentSeverity;
      occurredAt: Date;
      timezone: string;
      locationLabel: string | null;
      siteId: string | null;
      description: string;
      followUpUserId: string | null;
      photoAttachmentIds: readonly string[];
      audit: Record<string, unknown>;
    },
  ): Promise<{ id: string; reference: string }> {
    // Société à la date du fait (D-121) : un incident antérieur à un transfert appartient à la société d'origine.
    const companyId = await eventCompany(tx, this.access, ctx, { id: input.vehicleId, companyId: input.companyId }, input.occurredAt, 'un incident');
    const reference = await this.references.next(tx, ctx.organizationId, 'INC', Number(localDate(input.occurredAt, input.timezone).slice(0, 4)));
    const incident = await tx.incident.create({
      data: {
        organizationId: ctx.organizationId,
        reference,
        companyId,
        vehicleId: input.vehicleId,
        driverId: input.driverId,
        usageId: input.usageId,
        type: input.type,
        severity: input.severity,
        occurredAt: input.occurredAt,
        locationLabel: input.locationLabel,
        siteId: input.siteId,
        description: input.description,
        followUpUserId: input.followUpUserId,
        reportedById: ctx.userId,
        createdById: ctx.userId,
      },
    });
    for (const photo of input.photoAttachmentIds) await this.attachments.attach(ctx, tx, photo, 'INCIDENT', incident.id, companyId);
    await this.audit.record(ctx, { action: 'incident.declaration', objectType: 'Incident', objectId: incident.id, companyId, after: { reference, type: input.type, severity: input.severity, ...input.audit } }, tx);
    return { id: incident.id, reference };
  }

  async update(ctx: RequestContext, id: string, dto: UpdateIncidentDto): Promise<IncidentViewDto> {
    const current = await this.load(ctx, id);
    if (ctx.isDriverOnly) throw new ForbiddenActionError('Le conducteur ne modifie pas un dossier d’incident : ajoutez un commentaire.');
    this.access.requireOperational(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'incident');
    if (current.status === 'CLOTURE') throw new ConflictError('ETAT_INVALIDE', 'Incident clôturé.');
    if (dto.severity !== undefined && dto.severity !== current.severity) this.access.requireManager(ctx, current.companyId);
    if (dto.driverId !== undefined && dto.driverId !== current.driverId) {
      // Lien explicite avec un conducteur (ex. contravention) : action du chef, jamais automatique (D-217).
      this.access.requireManager(ctx, current.companyId);
      if (dto.driverId) {
        const driver = await this.prisma.client.driver.findFirst({ where: { id: dto.driverId, organizationId: ctx.organizationId } });
        if (!driver || !this.access.canReadCompany(ctx, driver.companyId)) throw new NotFoundOrOutOfScopeError('Conducteur');
      }
    }
    if (dto.followUpUserId !== undefined) await this.assertFollowUp(ctx, dto.followUpUserId, current.companyId);
    if (dto.siteId) await this.assertSite(ctx, dto.siteId, current.companyId);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.incident.update({
        where: { id, version: dto.expectedVersion },
        data: {
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.severity !== undefined ? { severity: dto.severity } : {}),
          ...(dto.description !== undefined ? { description: dto.description.trim() } : {}),
          ...(dto.locationLabel !== undefined ? { locationLabel: dto.locationLabel?.trim() || null } : {}),
          ...(dto.siteId !== undefined ? { siteId: dto.siteId } : {}),
          ...(dto.followUpUserId !== undefined ? { followUpUserId: dto.followUpUserId } : {}),
          ...(dto.driverId !== undefined ? { driverId: dto.driverId } : {}),
          version: { increment: 1 },
        },
      });
      for (const photo of dto.photoAttachmentIds ?? []) await this.attachments.attach(ctx, tx, photo, 'INCIDENT', id, current.companyId);
      await this.audit.record(ctx, { action: 'incident.modification', objectType: 'Incident', objectId: id, companyId: current.companyId, before: { type: current.type, severity: current.severity, driverId: current.driverId, followUpUserId: current.followUpUserId }, after: dto }, tx);
    });
    await this.syncCriticalAlert(id);
    return this.get(ctx, id);
  }

  /**
   * Transitions (D-215) : OUVERT → EN_TRAITEMENT ; OUVERT|EN_TRAITEMENT → RESOLU (note) ;
   * RESOLU → CLOTURE (interventions terminées/annulées, causes d'immobilisation terminées) ;
   * RESOLU → EN_TRAITEMENT (réouverture motivée) ; OUVERT → CLOTURE « sans suite » (motif) ;
   * CLOTURE → EN_TRAITEMENT réservé à l'administrateur. Opérateur : jusqu'à RESOLU.
   */
  async transition(ctx: RequestContext, id: string, dto: TransitionIncidentDto): Promise<IncidentViewDto> {
    const current = await this.load(ctx, id);
    if (ctx.isDriverOnly) throw new ForbiddenActionError('Le suivi des incidents est réservé au personnel.');
    this.access.requireOperational(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'incident');
    const from = current.status;
    const to = dto.to;
    const allowed: Record<IncidentStatus, IncidentStatus[]> = { OUVERT: ['EN_TRAITEMENT', 'RESOLU', 'CLOTURE'], EN_TRAITEMENT: ['RESOLU'], RESOLU: ['CLOTURE', 'EN_TRAITEMENT'], CLOTURE: ['EN_TRAITEMENT'] };
    if (!allowed[from].includes(to)) throw new ConflictError('TRANSITION_INVALIDE', `Passage de ${from} à ${to} non autorisé.`);
    if (to === 'CLOTURE' || (from === 'RESOLU' && to === 'EN_TRAITEMENT')) this.access.requireManager(ctx, current.companyId);
    if (from === 'CLOTURE' && !ctx.isAdmin) throw new ForbiddenActionError('Seul l’administrateur rouvre un incident clôturé.');
    const needsNote = to === 'RESOLU' || (from === 'OUVERT' && to === 'CLOTURE') || (to === 'EN_TRAITEMENT' && (from === 'RESOLU' || from === 'CLOTURE'));
    if (needsNote && !dto.note) throw new BusinessRuleError('NOTE_REQUISE', 'Une note ou un motif est requis pour cette transition.', { fieldErrors: { note: ['Note requise.'] } });
    const now = this.clock.now();
    await this.prisma.client.$transaction(async (tx) => {
      // La mise à jour versionnée verrouille la ligne de l'incident : une immobilisation ou une intervention
      // en cours de rattachement (verrou partagé sur l'incident) est validée avant, puis comptée ci-dessous.
      await tx.incident.update({
        where: { id, version: dto.expectedVersion },
        data: {
          status: to,
          ...(to === 'RESOLU' ? { resolvedAt: now, resolvedById: ctx.userId, resolutionNote: dto.note?.trim() ?? null } : {}),
          ...(to === 'CLOTURE' ? { closedAt: now, closedById: ctx.userId, closureNote: dto.note?.trim() ?? (from === 'RESOLU' ? 'Clôture administrative' : null) } : {}),
          ...(to === 'EN_TRAITEMENT' && from !== 'OUVERT' ? { resolvedAt: null, resolvedById: null, closedAt: null, closedById: null } : {}),
          version: { increment: 1 },
        },
      });
      if (to === 'CLOTURE' && from === 'RESOLU') {
        const openInterventions = await tx.intervention.count({ where: { incidentId: id, status: { in: ['BROUILLON', 'PLANIFIEE', 'EN_COURS'] } } });
        const openCauses = await tx.immobilizationCause.count({ where: { incidentId: id, endedAt: null } });
        if (openInterventions > 0 || openCauses > 0) throw new ConflictError('CLOTURE_IMPOSSIBLE', 'Des interventions ou une immobilisation liées sont encore ouvertes.', { openInterventions, openCauses });
      }
      if (dto.note) await tx.incidentComment.create({ data: { organizationId: ctx.organizationId, incidentId: id, authorId: ctx.userId, body: `[${from} → ${to}] ${dto.note.trim()}`, visibility: 'INTERNE' } });
      await this.audit.record(ctx, { action: 'incident.transition', objectType: 'Incident', objectId: id, companyId: current.companyId, reason: dto.note ?? null, before: { status: from }, after: { status: to } }, tx);
    });
    await this.syncCriticalAlert(id);
    return this.get(ctx, id);
  }

  async comments(ctx: RequestContext, id: string): Promise<IncidentCommentViewDto[]> {
    await this.load(ctx, id);
    const items = await this.prisma.client.incidentComment.findMany({ where: { incidentId: id, ...(ctx.isDriverOnly ? { visibility: 'PARTAGE_CONDUCTEUR' } : {}) }, orderBy: { createdAt: 'asc' } });
    const authorIds = [...new Set(items.map((c) => c.authorId).filter((x): x is string => Boolean(x)))];
    const authors = authorIds.length ? await this.prisma.client.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
    return items.map((c) => {
      const a = authors.find((u) => u.id === c.authorId);
      return { id: c.id, body: c.body, visibility: c.visibility, authorName: a ? `${a.firstName} ${a.lastName}` : null, createdAt: c.createdAt.toISOString() };
    });
  }

  /** Commentaire chronologique, jamais modifié. Un conducteur commente ses propres incidents (partagé). */
  async addComment(ctx: RequestContext, id: string, dto: CreateCommentDto): Promise<IncidentCommentViewDto> {
    const incident = await this.load(ctx, id);
    if (!ctx.isDriverOnly) this.access.requireOperational(ctx, incident.companyId);
    if (incident.status === 'CLOTURE') throw new ConflictError('ETAT_INVALIDE', 'Incident clôturé : commentaires fermés.');
    const visibility = ctx.isDriverOnly ? 'PARTAGE_CONDUCTEUR' : (dto.visibility ?? 'INTERNE');
    const c = await this.prisma.client.incidentComment.create({ data: { organizationId: ctx.organizationId, incidentId: id, authorId: ctx.userId, body: dto.body.trim(), visibility } });
    const me = await this.prisma.client.user.findUnique({ where: { id: ctx.userId }, select: { firstName: true, lastName: true } });
    return { id: c.id, body: c.body, visibility: c.visibility, authorName: me ? `${me.firstName} ${me.lastName}` : null, createdAt: c.createdAt.toISOString() };
  }

  /** Intervention urgente ouverte depuis l'incident (6.3). */
  async openIntervention(ctx: RequestContext, id: string, dto: IncidentInterventionDto): Promise<InterventionViewDto> {
    const incident = await this.load(ctx, id);
    if (ctx.isDriverOnly) throw new ForbiddenActionError('Action réservée au personnel.');
    // Contrôle d'état partagé avec POST /interventions (incidentId), réappliqué par create().
    assertIncidentAcceptsIntervention(incident);
    return this.interventions.create(ctx, {
      vehicleId: incident.vehicleId,
      kind: dto.kind ?? 'CORRECTIF',
      supplierId: dto.supplierId,
      plannedStartAt: dto.plannedStartAt,
      diagnosis: dto.diagnosis ?? incident.description,
      incidentId: incident.id,
      tasks: dto.tasks?.length ? dto.tasks : [{ label: `Traitement de l’incident ${incident.reference}` }],
    });
  }

  /**
   * Immobilisation explicite liée à l'incident (cause INCIDENT, 7.4) : nouvelle immobilisation ou cause
   * ajoutée à l'immobilisation active du véhicule, dont l'identifiant est renvoyé. Lieu et fin prévue
   * fournis s'appliquent explicitement à cette immobilisation (jamais ignorés).
   */
  async immobilize(ctx: RequestContext, id: string, dto: IncidentImmobilizeDto): Promise<IncidentImmobilizeResultDto> {
    const incident = await this.load(ctx, id);
    if (ctx.isDriverOnly) throw new ForbiddenActionError('Action réservée au personnel.');
    this.access.requireOperational(ctx, incident.companyId);
    assertAcceptsImmobilization(incident.status);
    const now = this.clock.now();
    const startedAt = dto.startedAt ? new Date(dto.startedAt) : now;
    if (startedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) throw new BusinessRuleError('DEBUT_FUTUR', 'Une immobilisation ne commence pas dans le futur.');
    const after = new AfterCommit();
    const opened = await this.prisma.serializable(async (tx: Tx) => {
      // Statut relu sous verrou partagé : une clôture concurrente attend la fin de cette transaction et
      // compte alors la cause ; une clôture déjà validée est vue ici (409).
      const [locked] = await tx.$queryRaw<Array<{ status: IncidentStatus }>>`SELECT status::text AS status FROM "Incident" WHERE id = ${id}::uuid FOR SHARE`;
      if (!locked) throw new NotFoundOrOutOfScopeError('Incident');
      assertAcceptsImmobilization(locked.status);
      return this.immobilizations.openCause(tx, ctx, { vehicle: { id: incident.vehicleId, companyId: incident.companyId, code: incident.vehicle.code }, kind: 'INCIDENT', reason: dto.reason, incidentId: id, startedAt, expectedEndAt: dto.expectedEndAt ? new Date(dto.expectedEndAt) : null, place: { siteId: dto.siteId, garageSupplierId: dto.garageSupplierId, locationLabel: dto.locationLabel } }, after);
    });
    await after.run();
    return { ...opened, incident: await this.get(ctx, id) };
  }

  /** Alerte « incident critique non traité » (D-218) : CRITIQUE et OUVERT ; résolue au passage en traitement ou si la gravité baisse. */
  async syncCriticalAlert(id: string): Promise<void> {
    const i = await this.prisma.client.incident.findUniqueOrThrow({ where: { id }, include: { vehicle: { select: { code: true } } } });
    const key = { organizationId: i.organizationId, type: 'INCIDENT_CRITIQUE' as const, objectType: 'Incident', objectId: i.id };
    if (i.severity === 'CRITIQUE' && i.status === 'OUVERT') {
      await this.alerts.raise({ ...key, companyId: i.companyId, severity: 'CRITIQUE', vehicleId: i.vehicleId, occurrenceKey: 'ouvert', title: `Incident critique non traité — ${i.vehicle.code}`, message: `${i.reference} : ${i.description.slice(0, 180)}`, condition: { incidentId: i.id, status: i.status, severity: i.severity }, actionPath: `/incidents/${i.id}`, responsibleUserId: i.followUpUserId });
    } else {
      await this.alerts.resolve(key, i.status !== 'OUVERT' ? 'incident pris en charge' : 'gravité abaissée');
    }
  }

  // ---------------------------------------------------------------------------

  async load(ctx: RequestContext, id: string): Promise<IncidentRow> {
    const i = await this.prisma.client.incident.findFirst({ where: { id, organizationId: ctx.organizationId }, include: incidentInclude });
    if (!i) throw new NotFoundOrOutOfScopeError('Incident');
    if (ctx.isDriverOnly) {
      if (i.driverId !== ctx.driverId && i.reportedById !== ctx.userId) throw new NotFoundOrOutOfScopeError('Incident');
    } else if (!this.access.canReadCompany(ctx, i.companyId)) {
      throw new NotFoundOrOutOfScopeError('Incident');
    }
    return i;
  }

  private async assertFollowUp(ctx: RequestContext, userId: string | null, companyId: string): Promise<void> {
    if (!userId) return;
    const member = await this.prisma.client.user.findFirst({ where: { id: userId, ...followUpCandidateWhere(ctx.organizationId, companyId) }, select: { id: true } });
    if (!member) throw new NotFoundOrOutOfScopeError('Responsable du suivi');
  }

  private async assertSite(ctx: RequestContext, siteId: string, companyId: string): Promise<void> {
    const site = await this.prisma.client.site.findFirst({ where: { id: siteId, organizationId: ctx.organizationId, companyId } });
    if (!site) throw new NotFoundOrOutOfScopeError('Site');
  }

  /**
   * Vues en lot (liste sans requête par ligne) : photos, noms des responsables, coûts liés et
   * utilisations à l'instant des contraventions chargés en une requête chacun. Le compte conducteur ne
   * reçoit ni le suivi interne (responsable, note de résolution, note de clôture) ni les coûts (D-216).
   */
  private async views(ctx: RequestContext, rows: readonly IncidentRow[]): Promise<IncidentViewDto[]> {
    if (rows.length === 0) return [];
    const staff = !ctx.isDriverOnly;
    const ids = rows.map((i) => i.id);
    const costRows = staff ? rows.filter((i) => this.access.hasPermission(ctx, i.companyId, 'costs.read')) : [];
    const contraventions = staff ? rows.filter((i) => i.type === 'CONTRAVENTION') : [];
    const followUpIds = staff ? [...new Set(rows.map((i) => i.followUpUserId).filter((x): x is string => x !== null))] : [];
    const [photos, followUps, expenses, usages] = await Promise.all([
      this.prisma.client.attachment.findMany({ where: { ownerType: 'INCIDENT', ownerId: { in: ids }, deletedAt: null }, select: { id: true, ownerId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      followUpIds.length ? this.prisma.client.user.findMany({ where: { id: { in: followUpIds }, organizationId: ctx.organizationId }, select: { id: true, firstName: true, lastName: true } }) : [],
      // Définition unique du registre (D-217) : dépenses validées rattachées et interventions issues,
      // limitées aux sociétés où l'appelant détient costs.read (costsReadableWhere).
      costRows.length
        ? this.prisma.client.expense.findMany({
            where: { AND: [costsReadableWhere(ctx, this.access), { status: 'VALIDEE', OR: costRows.map((i) => incidentExpensesWhere(i.id, i.interventions.map((x) => x.id))) }] },
            select: { id: true, amount: true, kind: true, relatedIncidentId: true, sourceType: true, sourceId: true },
          })
        : [],
      contraventions.length
        ? this.prisma.client.vehicleUsage.findMany({
            where: { vehicleId: { in: [...new Set(contraventions.map((i) => i.vehicleId))] }, checkedOutAt: { lte: new Date(Math.max(...contraventions.map((i) => i.occurredAt.getTime()))) }, OR: [{ returnedAt: null }, { returnedAt: { gt: new Date(Math.min(...contraventions.map((i) => i.occurredAt.getTime()))) } }] },
            select: { id: true, vehicleId: true, driverId: true, checkedOutAt: true, returnedAt: true, driver: { select: { firstName: true, lastName: true } } },
            orderBy: [{ checkedOutAt: 'desc' }, { id: 'asc' }],
          })
        : [],
    ]);
    return rows.map((i) => {
      let linkedCost: string | null = null;
      if (costRows.includes(i)) {
        const interventionIds = new Set(i.interventions.map((x) => x.id));
        // Même critère que incidentExpensesWhere, appliqué au lot chargé (chaque dépense comptée une fois).
        const linked = expenses.filter((e) => e.relatedIncidentId === i.id || (e.sourceType === 'INTERVENTION' && e.sourceId !== null && interventionIds.has(e.sourceId)));
        linkedCost = netAmount(linked.map((e) => ({ kind: e.kind, amount: e.amount.toString() }))).toFixed(3);
      }
      const usageAtTime = staff && i.type === 'CONTRAVENTION' ? (usages.find((u) => u.vehicleId === i.vehicleId && usageCoversInstant(u, i.occurredAt)) ?? null) : null;
      const followUp = staff && i.followUpUserId ? followUps.find((u) => u.id === i.followUpUserId) : undefined;
      return {
        id: i.id,
        reference: i.reference,
        companyId: i.companyId,
        vehicleId: i.vehicleId,
        vehicleCode: i.vehicle.code,
        vehicleRegistration: i.vehicle.registration,
        driverId: i.driverId,
        driverName: i.driver ? `${i.driver.firstName} ${i.driver.lastName}` : null,
        usageId: i.usageId,
        type: i.type,
        severity: i.severity,
        status: i.status,
        occurredAt: i.occurredAt.toISOString(),
        locationLabel: i.locationLabel,
        siteId: i.siteId,
        siteName: i.site?.name ?? null,
        description: i.description,
        followUpUserId: staff ? i.followUpUserId : null,
        followUpUserName: followUp ? `${followUp.firstName} ${followUp.lastName}` : null,
        resolutionNote: staff ? i.resolutionNote : null,
        resolvedAt: i.resolvedAt?.toISOString() ?? null,
        closureNote: staff ? i.closureNote : null,
        closedAt: i.closedAt?.toISOString() ?? null,
        photoAttachmentIds: photos.filter((ph) => ph.ownerId === i.id).map((ph) => ph.id),
        interventionIds: staff ? i.interventions.map((x) => x.id) : [],
        openImmobilizationCauseId: staff ? (i.immobilizationCauses[0]?.id ?? null) : null,
        linkedCost,
        usageAtTimeId: usageAtTime?.id ?? null,
        usageAtTimeDriverId: usageAtTime?.driverId ?? null,
        usageAtTimeDriverName: usageAtTime ? `${usageAtTime.driver.firstName} ${usageAtTime.driver.lastName}` : null,
        version: i.version,
      };
    });
  }
}
