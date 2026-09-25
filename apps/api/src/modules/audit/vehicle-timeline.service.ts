import { Injectable } from '@nestjs/common';
import type { Prisma } from '@parc-auto/db';
import {
  DISTANCE_STATUS_LABELS,
  INCIDENT_SEVERITY_LABELS,
  INCIDENT_STATUS_LABELS,
  INCIDENT_TYPE_LABELS,
  INTERVENTION_STATUS_LABELS,
  MEASUREMENT_KIND_LABELS,
  READING_CONTEXT_LABELS,
  READING_SOURCE_LABELS,
  RESERVATION_STATUS_LABELS,
} from '@parc-auto/contracts';
import { Clock } from '../../common/clock.js';
import { type Page, pageOf } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { fromDbDate } from '../../domain/civil-date.js';
import {
  FOREIGN_COMPANY_POLICY,
  OTHER_COMPANY_AUTHOR,
  compareTimeline,
  mergeTimelinePage,
  sourceWindow,
  timelineAccess,
  type TimelineObjectKind,
  type TimelineOrder,
  type TimelineSortKey,
} from '../../domain/vehicle-timeline.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { companyAt } from '../odometer/odometer-ingestion.service.js';
import { VehiclesService } from '../vehicles/vehicles.service.js';
import {
  TIMELINE_CATEGORY_LABELS,
  TIMELINE_EVENT_TYPES,
  type TimelineCategory,
  type TimelineDetailDto,
  type TimelineEventDto,
  type TimelineEventType,
  type TimelineQueryDto,
} from './dto/timeline.dto.js';

/** Auteur d'un relevé automatique (même libellé que l'historique des relevés). */
const TELEMATICS_AUTHOR = 'Connecteur télématique';
const INTERVENTION_KIND_LABELS = { PREVENTIF: 'Préventive', CORRECTIF: 'Corrective' } as const;
/** Identifiant impossible : filtre vide explicite (conducteur sans fiche liée). */
const NOWHERE = '00000000-0000-0000-0000-000000000000';

const RANK: Readonly<Record<TimelineEventType, number>> = Object.fromEntries(
  TIMELINE_EVENT_TYPES.map((t, i) => [t, i]),
) as Record<TimelineEventType, number>;

type Actor =
  | { kind: 'UTILISATEUR'; userId: string | null }
  | { kind: 'TELEMATIQUE' }
  | { kind: 'AUTRE_SOCIETE' };

interface Draft extends TimelineSortKey {
  type: TimelineEventType;
  category: TimelineCategory;
  title: string;
  objectType: string;
  companyId: string | null;
  access: 'COMPLET' | 'TECHNIQUE';
  actor: Actor;
  objectAccessible: boolean;
  details: TimelineDetailDto[];
}

interface Source {
  category: TimelineCategory;
  count(): Promise<number>;
  fetch(take: number): Promise<Draft[]>;
}

/** Périmètre du lecteur, calculé côté serveur à partir de ses habilitations (jamais du client). */
interface ReaderScope {
  /** Conducteur seul : limité à ses propres utilisations et soumissions. */
  driver: { driverId: string; userId: string } | null;
  /** Sociétés lisibles ; null pour l'administrateur (toutes). */
  companyIn: readonly string[] | null;
  /** Versions de documents partagées lors d'un transfert vers l'une des sociétés lisibles (D-275). */
  sharedDocumentIds: string[];
}

type Decimalish = Prisma.Decimal | null | undefined;

const text = (label: string, value: string | null | undefined): TimelineDetailDto[] =>
  value !== null && value !== undefined && value.trim() !== ''
    ? [{ label, value, kind: 'TEXTE' }]
    : [];
const km = (label: string, value: Decimalish): TimelineDetailDto[] =>
  value ? [{ label, value: value.toFixed(3), kind: 'KM' }] : [];
const money = (label: string, value: Decimalish): TimelineDetailDto[] =>
  value ? [{ label, value: value.toFixed(3), kind: 'MONTANT' }] : [];
const day = (label: string, value: Date | null | undefined): TimelineDetailDto[] => {
  const d = fromDbDate(value);
  return d ? [{ label, value: d, kind: 'DATE' }] : [];
};
const instant = (label: string, value: Date | null | undefined): TimelineDetailDto[] =>
  value ? [{ label, value: value.toISOString(), kind: 'DATE_HEURE' }] : [];
const person = (p: { firstName: string; lastName: string } | null | undefined): string | null =>
  p ? `${p.firstName} ${p.lastName}`.trim() : null;

/**
 * Chronologie métier du dossier véhicule (onglet Historique, CDC 3.1 ; D-109, D-275) : événements tirés
 * des tables métier, triés par date et paginés. Mêmes règles de visibilité que les écrans : véhicule chargé
 * par VehiclesService.load (404 hors périmètre) ; conducteur limité à ses utilisations et soumissions ;
 * objets d'une autre société selon D-275 (relevés, plans, compteur, interventions terminées en vue
 * technique ; jamais utilisations, réservations, incidents, immobilisations ni affectations) ; aucun montant
 * sans costs.read sur la société de l'intervention.
 */
@Injectable()
export class VehicleTimelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly vehicles: VehiclesService,
    private readonly clock: Clock,
  ) {}

  async timeline(
    ctx: RequestContext,
    vehicleId: string,
    query: TimelineQueryDto,
  ): Promise<Page<TimelineEventDto>> {
    const vehicle = await this.vehicles.load(ctx, vehicleId);
    const [history, companies] = await Promise.all([
      this.prisma.client.vehicleCompanyHistory.findMany({
        where: { vehicleId, organizationId: ctx.organizationId },
        orderBy: [{ effectiveAt: 'asc' }, { createdAt: 'asc' }],
      }),
      this.companyCodes(ctx),
    ]);
    const scope = this.scope(ctx, history);
    const order: TimelineOrder = query.order;
    const all = ctx.isDriverOnly
      ? this.driverSources(vehicleId, scope, order)
      : this.staffSources(
          ctx,
          {
            id: vehicle.id,
            companyId: vehicle.companyId,
            createdAt: vehicle.createdAt,
            createdById: vehicle.createdById,
          },
          history,
          scope,
          order,
          companies,
        );
    const sources = query.category ? all.filter((s) => s.category === query.category) : all;
    const window = sourceWindow(query);
    const [counts, batches] = await Promise.all([
      Promise.all(sources.map((s) => s.count())),
      Promise.all(sources.map((s) => s.fetch(window))),
    ]);
    const page = mergeTimelinePage(batches, order, query);
    const names = await this.userNames(ctx, page);
    const total = counts.reduce((sum, n) => sum + n, 0);
    return pageOf(
      page.map((d) => this.view(d, names, companies)),
      total,
      query,
    );
  }

  // ---------------------------------------------------------------------------
  // Périmètre
  // ---------------------------------------------------------------------------

  private scope(
    ctx: RequestContext,
    history: ReadonlyArray<{ toCompanyId: string; sharedDocumentIds: string[] }>,
  ): ReaderScope {
    if (ctx.isDriverOnly)
      return {
        driver: { driverId: ctx.driverId ?? NOWHERE, userId: ctx.userId },
        companyIn: [],
        sharedDocumentIds: [],
      };
    const companyIn = ctx.isAdmin ? null : [...ctx.visibleCompanyIds];
    const sharedDocumentIds = [
      ...new Set(
        history
          .filter((h) => this.access.canReadCompany(ctx, h.toCompanyId))
          .flatMap((h) => h.sharedDocumentIds),
      ),
    ];
    return { driver: null, companyIn, sharedDocumentIds };
  }

  /** Restriction aux sociétés lisibles pour une famille dont la politique étrangère est MASQUE (D-275). */
  private ownCompanies(
    scope: ReaderScope,
    kind: TimelineObjectKind,
  ): { companyId?: { in: string[] } } {
    if (scope.companyIn === null || FOREIGN_COMPANY_POLICY[kind] === 'TECHNIQUE') return {};
    return { companyId: { in: [...scope.companyIn] } };
  }

  private readable(ctx: RequestContext, companyId: string | null): boolean {
    return companyId !== null && this.access.canReadCompany(ctx, companyId);
  }

  // ---------------------------------------------------------------------------
  // Sources du personnel (administrateur, chef, opérateur, lecteur)
  // ---------------------------------------------------------------------------

  private staffSources(
    ctx: RequestContext,
    vehicle: { id: string; companyId: string; createdAt: Date; createdById: string | null },
    history: ReadonlyArray<{
      id: string;
      fromCompanyId: string | null;
      toCompanyId: string;
      effectiveAt: Date;
      reason: string | null;
      createdById: string | null;
    }>,
    scope: ReaderScope,
    order: TimelineOrder,
    companies: ReadonlyMap<string, string>,
  ): Source[] {
    const db = this.prisma.client;
    const vehicleId = vehicle.id;
    const dir = order;
    const accessOf = (
      kind: TimelineObjectKind,
      companyId: string | null,
      facts: { interventionCompleted?: boolean; sharedWithReader?: boolean } = {},
    ): 'COMPLET' | 'TECHNIQUE' =>
      visibleLevel(kind, { companyReadable: this.readable(ctx, companyId), ...facts });
    const authorOf = (level: 'COMPLET' | 'TECHNIQUE', userId: string | null): Actor =>
      level === 'COMPLET' ? { kind: 'UTILISATEUR', userId } : { kind: 'AUTRE_SOCIETE' };
    const sources: Source[] = [];

    // Création du dossier : entrée d'historique de création (société de création), sinon la fiche elle-même.
    const creation = history.find((h) => h.fromCompanyId === null);
    const creationAt = creation?.effectiveAt ?? vehicle.createdAt;
    const creationCompany = creation?.toCompanyId ?? vehicle.companyId;
    sources.push({
      category: 'DOSSIER',
      count: () => Promise.resolve(1),
      fetch: () => {
        const level = accessOf('DOSSIER', creationCompany);
        return Promise.resolve([
          this.draft('VEHICULE_CREE', 'Création du dossier véhicule', {
            occurredAt: creationAt,
            objectType: 'Vehicle',
            objectId: vehicleId,
            companyId: creationCompany,
            access: level,
            actor: authorOf(level, creation?.createdById ?? vehicle.createdById),
            objectAccessible: true,
            details: [],
          }),
        ]);
      },
    });

    // Changements de société gestionnaire (2.4) : complets si l'une des deux sociétés est lisible.
    const transfers = history.filter((h) => h.fromCompanyId !== null);
    const codeOf = (companyId: string | null): string =>
      companyId ? (companies.get(companyId) ?? '—') : '—';
    sources.push({
      category: 'DOSSIER',
      count: () => Promise.resolve(transfers.length),
      fetch: (take) => {
        const drafts = transfers.map((h) => {
          const level = visibleLevel('SOCIETE', {
            companyReadable:
              this.readable(ctx, h.toCompanyId) || this.readable(ctx, h.fromCompanyId),
          });
          return this.draft('SOCIETE_TRANSFERT', 'Changement de société gestionnaire', {
            occurredAt: h.effectiveAt,
            objectType: 'VehicleCompanyHistory',
            objectId: h.id,
            companyId: h.toCompanyId,
            access: level,
            actor: authorOf(level, h.createdById),
            objectAccessible: false,
            details: [
              ...text('Société précédente', codeOf(h.fromCompanyId)),
              ...text('Nouvelle société', codeOf(h.toCompanyId)),
              ...(level === 'COMPLET' ? text('Motif', h.reason) : []),
            ],
          });
        });
        return Promise.resolve(drafts.sort(compareTimeline(order)).slice(0, take));
      },
    });

    // Utilisations : remise et retour (jamais celles d'une autre société, D-275).
    const usageWhere: Prisma.VehicleUsageWhereInput = {
      vehicleId,
      ...this.ownCompanies(scope, 'UTILISATION'),
    };
    const usageInclude = {
      driver: { select: { firstName: true, lastName: true } },
      checkoutReading: { select: { physicalKm: true } },
      returnReading: { select: { physicalKm: true } },
    } as const;
    sources.push(...this.usageSources(ctx, usageWhere, usageInclude, dir, false));

    // Relevés (5.1) : tous les relevés du véhicule, ceux d'une autre société en vue technique (D-275).
    // Les relevés télématiques acceptés, routiniers et non audités (D-309), ne sont pas repris : seules
    // leurs anomalies (attente, rejet, remplacement) apparaissent.
    const readingWhere: Prisma.OdometerReadingWhereInput = {
      vehicleId,
      NOT: { source: 'TELEMATICS', status: 'ACCEPTE' },
    };
    sources.push(
      this.readingSource(readingWhere, dir, (companyId) => accessOf('RELEVE', companyId)),
    );

    // Compteur : initialisation et remplacements (5.4).
    for (const [type, title, where] of [
      ['COMPTEUR_INITIALISE', 'Initialisation du compteur', { vehicleId, sequence: 1 }],
      ['COMPTEUR_REMPLACE', 'Remplacement du compteur', { vehicleId, sequence: { gt: 1 } }],
    ] as const) {
      sources.push({
        category: 'KILOMETRAGE',
        count: () => db.odometerSegment.count({ where }),
        fetch: async (take) => {
          const rows = await db.odometerSegment.findMany({
            where,
            orderBy: [{ startedAt: dir }, { id: dir }],
            take,
          });
          // Société gestionnaire au début du segment : règle unique des événements datés (2.4).
          const companyIds = await Promise.all(
            rows.map((s) => companyAt(db, vehicleId, s.startedAt, vehicle.companyId)),
          );
          return rows.map((s, index) => {
            const companyId = companyIds[index] ?? vehicle.companyId;
            const level = accessOf('COMPTEUR', companyId);
            return this.draft(type, title, {
              occurredAt: s.startedAt,
              objectType: 'OdometerSegment',
              objectId: s.id,
              companyId,
              access: level,
              actor: authorOf(level, s.createdById),
              objectAccessible: level === 'COMPLET',
              details: [
                ...km('Compteur de départ', s.startPhysicalKm),
                ...(s.cumulativeKnown
                  ? km('Cumul de départ', s.startCumulativeKm)
                  : text('Cumul', 'Cumul incomplet : historique antérieur inconnu')),
                ...(level === 'COMPLET' ? text('Motif', s.replacementReason) : []),
              ],
            });
          });
        },
      });
    }

    // Plans d'entretien : création et désactivation (visibles en vue technique après transfert, D-275).
    const planInclude = { maintenanceType: { select: { label: true } } } as const;
    for (const [type, title, where, field] of [
      ['PLAN_CREE', 'Plan d’entretien créé', { vehicleId }, 'createdAt'],
      [
        'PLAN_DESACTIVE',
        'Plan d’entretien désactivé',
        { vehicleId, deactivatedAt: { not: null } },
        'deactivatedAt',
      ],
    ] as const) {
      sources.push({
        category: 'ENTRETIEN',
        count: () => db.vehicleMaintenancePlan.count({ where }),
        fetch: async (take) => {
          const rows = await db.vehicleMaintenancePlan.findMany({
            where,
            orderBy:
              field === 'createdAt'
                ? [{ createdAt: dir }, { id: dir }]
                : [{ deactivatedAt: dir }, { id: dir }],
            take,
            include: planInclude,
          });
          return rows.map((p) => {
            const level = accessOf('PLAN', p.companyId);
            const at = field === 'createdAt' ? p.createdAt : (p.deactivatedAt as Date);
            return this.draft(type, title, {
              occurredAt: at,
              objectType: 'VehicleMaintenancePlan',
              objectId: p.id,
              companyId: p.companyId,
              access: level,
              actor:
                field === 'createdAt'
                  ? authorOf(level, p.createdById)
                  : level === 'COMPLET'
                    ? { kind: 'UTILISATEUR', userId: null }
                    : { kind: 'AUTRE_SOCIETE' },
              objectAccessible: level === 'COMPLET',
              details: [
                ...text('Opération', p.maintenanceType.label),
                ...km('Intervalle', p.intervalKm),
                ...text(
                  'Intervalle en mois',
                  p.intervalMonths !== null ? String(p.intervalMonths) : null,
                ),
                ...text(
                  'Intervalle en jours',
                  p.intervalDays !== null ? String(p.intervalDays) : null,
                ),
                ...(field === 'deactivatedAt' && level === 'COMPLET'
                  ? text('Motif', p.deactivationReason)
                  : []),
              ],
            });
          });
        },
      });
    }

    // Interventions : création, annulation, réouverture (société historique seulement) et clôture (vue
    // technique d'une intervention TERMINEE d'une autre société, D-275).
    const interventionInclude = {
      tasks: { select: { label: true }, orderBy: { createdAt: 'asc' } },
      supplier: { select: { name: true } },
    } as const;
    const ownInterventions =
      scope.companyIn === null ? {} : { companyId: { in: [...scope.companyIn] } };
    const closedInterventions: Prisma.InterventionWhereInput =
      scope.companyIn === null
        ? {}
        : { OR: [{ companyId: { in: [...scope.companyIn] } }, { status: 'TERMINEE' }] };
    for (const [type, title, where, field] of [
      ['INTERVENTION_CREEE', 'Intervention créée', { vehicleId, ...ownInterventions }, 'createdAt'],
      [
        'INTERVENTION_TERMINEE',
        'Intervention terminée',
        { vehicleId, completedAt: { not: null }, ...closedInterventions },
        'completedAt',
      ],
      [
        'INTERVENTION_ROUVERTE',
        'Intervention rouverte',
        { vehicleId, reopenedAt: { not: null }, ...ownInterventions },
        'reopenedAt',
      ],
      [
        'INTERVENTION_ANNULEE',
        'Intervention annulée',
        { vehicleId, cancelledAt: { not: null }, ...ownInterventions },
        'cancelledAt',
      ],
    ] as const) {
      sources.push({
        category: 'ENTRETIEN',
        count: () => db.intervention.count({ where }),
        fetch: async (take) => {
          const rows = await db.intervention.findMany({
            where,
            orderBy: [{ [field]: dir }, { id: dir }],
            take,
            include: interventionInclude,
          });
          return rows.map((i) => {
            const level = accessOf('INTERVENTION', i.companyId, {
              interventionCompleted: i.status === 'TERMINEE',
            });
            const full = level === 'COMPLET';
            const at = i[field] as Date;
            const operations = i.tasks.map((t) => t.label).join(' ; ');
            const details: TimelineDetailDto[] = [
              ...(full ? text('Référence', i.reference) : []),
              ...text('Nature', INTERVENTION_KIND_LABELS[i.kind]),
              ...text('Opérations', operations),
            ];
            if (type === 'INTERVENTION_CREEE')
              details.push(...text('Statut actuel', INTERVENTION_STATUS_LABELS[i.status]));
            if (type === 'INTERVENTION_TERMINEE') {
              details.push(
                ...day('Réalisée le', i.performedOn),
                ...km('Kilométrage', i.performedKm),
              );
              if (full) {
                details.push(...text('Fournisseur', i.supplier?.name));
                // Aucun montant sans costs.read sur la société historique de l'intervention (2.2, D-266).
                if (this.access.hasPermission(ctx, i.companyId, 'costs.read'))
                  details.push(...money('Montant', i.totalAmount));
              }
            }
            if (type === 'INTERVENTION_ROUVERTE') details.push(...text('Motif', i.reopenReason));
            if (type === 'INTERVENTION_ANNULEE') details.push(...text('Motif', i.cancelReason));
            return this.draft(type, title, {
              occurredAt: at,
              objectType: 'Intervention',
              objectId: i.id,
              companyId: i.companyId,
              access: level,
              actor:
                type === 'INTERVENTION_CREEE'
                  ? authorOf(level, i.createdById)
                  : full
                    ? { kind: 'UTILISATEUR', userId: null }
                    : { kind: 'AUTRE_SOCIETE' },
              objectAccessible: full,
              details,
            });
          });
        },
      });
    }

    // Documents du véhicule : enregistrement et renouvellement ; ceux d'une autre société seulement s'ils
    // ont été partagés avec l'une des sociétés lisibles (D-275).
    const sharedClause: Prisma.DocumentVersionWhereInput =
      scope.companyIn === null
        ? {}
        : {
            OR: [
              { companyId: { in: [...scope.companyIn] } },
              { sharedWithCompanyIds: { hasSome: [...scope.companyIn] } },
              ...(scope.sharedDocumentIds.length > 0
                ? [{ id: { in: scope.sharedDocumentIds } }]
                : []),
            ],
          };
    for (const [type, title, previous] of [
      ['DOCUMENT_ENREGISTRE', 'Document enregistré', null],
      ['DOCUMENT_RENOUVELE', 'Document renouvelé', { not: null }],
    ] as const) {
      const where: Prisma.DocumentVersionWhereInput = {
        AND: [{ vehicleId, ownerType: 'VEHICULE', previousVersionId: previous }, sharedClause],
      };
      sources.push({
        category: 'DOCUMENTS',
        count: () => db.documentVersion.count({ where }),
        fetch: async (take) => {
          const rows = await db.documentVersion.findMany({
            where,
            orderBy: [{ createdAt: dir }, { id: dir }],
            take,
            include: { documentType: { select: { label: true } } },
          });
          return rows.map((d) => {
            const shared =
              scope.companyIn === null ||
              d.sharedWithCompanyIds.some((c) => scope.companyIn?.includes(c)) ||
              scope.sharedDocumentIds.includes(d.id);
            const level = accessOf('DOCUMENT', d.companyId, { sharedWithReader: shared });
            const full = level === 'COMPLET';
            return this.draft(type, title, {
              occurredAt: d.createdAt,
              objectType: 'DocumentVersion',
              objectId: d.id,
              companyId: d.companyId,
              access: level,
              actor: authorOf(level, d.createdById),
              objectAccessible: full,
              details: [
                ...text('Type', d.documentType.label),
                ...(full ? text('Numéro', d.number) : []),
                ...day('Valable à partir du', d.validFrom),
                ...day('Valable jusqu’au', d.validTo),
                ...(d.archivedAt ? text('État', 'Version archivée') : []),
              ],
            });
          });
        },
      });
    }

    // Incidents (7.3) : société historique seulement.
    sources.push(
      ...this.incidentSources(
        ctx,
        { vehicleId, ...this.ownCompanies(scope, 'INCIDENT') },
        dir,
        false,
      ),
    );

    // Immobilisations (7.4) : début et fin, société historique seulement.
    const immobilizationInclude = {
      causes: { select: { reason: true }, orderBy: { startedAt: 'asc' } },
      garageSupplier: { select: { name: true } },
      site: { select: { name: true } },
    } as const;
    for (const [type, title, where, field] of [
      [
        'IMMOBILISATION_DEBUT',
        'Début d’immobilisation',
        { vehicleId, ...this.ownCompanies(scope, 'IMMOBILISATION') },
        'startedAt',
      ],
      [
        'IMMOBILISATION_FIN',
        'Fin d’immobilisation',
        { vehicleId, endedAt: { not: null }, ...this.ownCompanies(scope, 'IMMOBILISATION') },
        'endedAt',
      ],
    ] as const) {
      sources.push({
        category: 'IMMOBILISATIONS',
        count: () => db.immobilization.count({ where }),
        fetch: async (take) => {
          const rows = await db.immobilization.findMany({
            where,
            orderBy: [{ [field]: dir }, { id: dir }],
            take,
            include: immobilizationInclude,
          });
          return rows.map((m) =>
            this.draft(type, title, {
              occurredAt: m[field] as Date,
              objectType: 'Immobilization',
              objectId: m.id,
              companyId: m.companyId,
              access: accessOf('IMMOBILISATION', m.companyId),
              actor: {
                kind: 'UTILISATEUR',
                userId: field === 'startedAt' ? m.createdById : m.endedById,
              },
              objectAccessible: true,
              details: [
                ...text('Causes', m.causes.map((c) => c.reason).join(' ; ')),
                ...text('Lieu', m.garageSupplier?.name ?? m.site?.name ?? m.locationLabel),
                ...(field === 'startedAt' ? instant('Fin prévue', m.expectedEndAt) : []),
              ],
            }),
          );
        },
      });
    }

    // Réservations (4.2) : enregistrement, annulation, non-présentation ; société historique seulement.
    const reservationInclude = { driver: { select: { firstName: true, lastName: true } } } as const;
    for (const [type, title, where, field] of [
      [
        'RESERVATION_CREEE',
        'Réservation enregistrée',
        { vehicleId, ...this.ownCompanies(scope, 'RESERVATION') },
        'createdAt',
      ],
      [
        'RESERVATION_ANNULEE',
        'Réservation annulée',
        { vehicleId, cancelledAt: { not: null }, ...this.ownCompanies(scope, 'RESERVATION') },
        'cancelledAt',
      ],
      [
        'RESERVATION_NON_HONOREE',
        'Réservation non honorée',
        { vehicleId, noShowAt: { not: null }, ...this.ownCompanies(scope, 'RESERVATION') },
        'noShowAt',
      ],
    ] as const) {
      sources.push({
        category: 'RESERVATIONS',
        count: () => db.reservation.count({ where }),
        fetch: async (take) => {
          const rows = await db.reservation.findMany({
            where,
            orderBy: [{ [field]: dir }, { id: dir }],
            take,
            include: reservationInclude,
          });
          return rows.map((r) =>
            this.draft(type, title, {
              occurredAt: r[field] as Date,
              objectType: 'Reservation',
              objectId: r.id,
              companyId: r.companyId,
              access: accessOf('RESERVATION', r.companyId),
              actor: {
                kind: 'UTILISATEUR',
                userId:
                  field === 'createdAt'
                    ? r.createdById
                    : field === 'cancelledAt'
                      ? r.cancelledById
                      : null,
              },
              objectAccessible: true,
              details: [
                ...text('Conducteur', person(r.driver)),
                ...instant('Début', r.startAt),
                ...instant('Fin', r.endAt),
                ...(field === 'createdAt'
                  ? [
                      ...text('Objet', r.purpose),
                      ...text('Statut actuel', RESERVATION_STATUS_LABELS[r.status]),
                    ]
                  : []),
                ...(field === 'cancelledAt' ? text('Motif', r.cancelReason) : []),
              ],
            }),
          );
        },
      });
    }

    // Affectations habituelles (4.1) : début et fin effectifs (pas d'événement futur), société historique seulement.
    const now = this.clock.now();
    const assignmentInclude = { driver: { select: { firstName: true, lastName: true } } } as const;
    for (const [type, title, where, field] of [
      [
        'AFFECTATION_DEBUT',
        'Début d’affectation habituelle',
        { vehicleId, startsAt: { lte: now }, ...this.ownCompanies(scope, 'AFFECTATION') },
        'startsAt',
      ],
      [
        'AFFECTATION_FIN',
        'Fin d’affectation habituelle',
        { vehicleId, endsAt: { not: null, lte: now }, ...this.ownCompanies(scope, 'AFFECTATION') },
        'endsAt',
      ],
    ] as const) {
      sources.push({
        category: 'AFFECTATIONS',
        count: () => db.vehicleResponsibleAssignment.count({ where }),
        fetch: async (take) => {
          const rows = await db.vehicleResponsibleAssignment.findMany({
            where,
            orderBy: [{ [field]: dir }, { id: dir }],
            take,
            include: assignmentInclude,
          });
          return rows.map((a) =>
            this.draft(type, title, {
              occurredAt: a[field] as Date,
              objectType: 'VehicleResponsibleAssignment',
              objectId: a.id,
              companyId: a.companyId,
              access: accessOf('AFFECTATION', a.companyId),
              actor: {
                kind: 'UTILISATEUR',
                userId: field === 'startsAt' ? a.createdById : a.endedById,
              },
              objectAccessible: true,
              details: [
                ...text('Responsable', person(a.driver)),
                ...(field === 'endsAt' ? text('Motif', a.endReason) : []),
              ],
            }),
          );
        },
      });
    }

    return sources;
  }

  // ---------------------------------------------------------------------------
  // Sources du conducteur : ses utilisations, ses relevés soumis, ses incidents (2.2, 2.3)
  // ---------------------------------------------------------------------------

  private driverSources(vehicleId: string, scope: ReaderScope, order: TimelineOrder): Source[] {
    const driver = scope.driver as { driverId: string; userId: string };
    const usageInclude = {
      driver: { select: { firstName: true, lastName: true } },
      checkoutReading: { select: { physicalKm: true } },
      returnReading: { select: { physicalKm: true } },
    } as const;
    return [
      ...this.usageSources(
        null,
        { vehicleId, driverId: driver.driverId },
        usageInclude,
        order,
        true,
      ),
      this.readingSource({ vehicleId, createdById: driver.userId }, order, () => 'COMPLET'),
      ...this.incidentSources(
        null,
        { vehicleId, OR: [{ driverId: driver.driverId }, { reportedById: driver.userId }] },
        order,
        true,
      ),
    ];
  }

  // ---------------------------------------------------------------------------
  // Sources partagées
  // ---------------------------------------------------------------------------

  private usageSources(
    ctx: RequestContext | null,
    where: Prisma.VehicleUsageWhereInput,
    include: {
      driver: { select: { firstName: true; lastName: true } };
      checkoutReading: { select: { physicalKm: true } };
      returnReading: { select: { physicalKm: true } };
    },
    dir: TimelineOrder,
    forDriver: boolean,
  ): Source[] {
    const db = this.prisma.client;
    const returned: Prisma.VehicleUsageWhereInput = { AND: [where, { returnedAt: { not: null } }] };
    return [
      {
        category: 'UTILISATIONS',
        count: () => db.vehicleUsage.count({ where }),
        fetch: async (take) => {
          const rows = await db.vehicleUsage.findMany({
            where,
            orderBy: [{ checkedOutAt: dir }, { id: dir }],
            take,
            include,
          });
          return rows.map((u) =>
            this.draft('UTILISATION_REMISE', 'Remise du véhicule', {
              occurredAt: u.checkedOutAt,
              objectType: 'VehicleUsage',
              objectId: u.id,
              companyId: u.companyId,
              access: ctx ? this.usageAccess(ctx, u.companyId) : 'COMPLET',
              actor: { kind: 'UTILISATEUR', userId: u.checkedOutById ?? u.createdById },
              objectAccessible: true,
              details: [
                ...text('Conducteur', person(u.driver)),
                ...text('Objet', u.purpose),
                ...instant('Retour prévu', u.expectedReturnAt),
                ...km('Compteur au départ', u.checkoutReading?.physicalKm),
                ...(u.checkoutWithoutReading
                  ? text(
                      'Départ sans relevé',
                      forDriver ? 'Oui' : (u.checkoutExceptionReason ?? 'Oui'),
                    )
                  : []),
              ],
            }),
          );
        },
      },
      {
        category: 'UTILISATIONS',
        count: () => db.vehicleUsage.count({ where: returned }),
        fetch: async (take) => {
          const rows = await db.vehicleUsage.findMany({
            where: returned,
            orderBy: [{ returnedAt: dir }, { id: dir }],
            take,
            include,
          });
          return rows.map((u) =>
            this.draft('UTILISATION_RETOUR', 'Retour du véhicule', {
              occurredAt: u.returnedAt as Date,
              objectType: 'VehicleUsage',
              objectId: u.id,
              companyId: u.companyId,
              access: ctx ? this.usageAccess(ctx, u.companyId) : 'COMPLET',
              actor: { kind: 'UTILISATEUR', userId: u.returnedById },
              objectAccessible: true,
              details: [
                ...text('Conducteur', person(u.driver)),
                ...km('Compteur au retour', u.returnReading?.physicalKm),
                ...km('Distance', u.distanceKm),
                ...text('Qualité de la distance', DISTANCE_STATUS_LABELS[u.distanceStatus]),
                ...(u.returnWithoutReading
                  ? text(
                      'Retour sans relevé',
                      forDriver ? 'Oui' : (u.returnExceptionReason ?? 'Oui'),
                    )
                  : []),
              ],
            }),
          );
        },
      },
    ];
  }

  private usageAccess(ctx: RequestContext, companyId: string): 'COMPLET' | 'TECHNIQUE' {
    return visibleLevel('UTILISATION', { companyReadable: this.readable(ctx, companyId) });
  }

  private readingSource(
    where: Prisma.OdometerReadingWhereInput,
    dir: TimelineOrder,
    accessOf: (companyId: string) => 'COMPLET' | 'TECHNIQUE',
  ): Source {
    const db = this.prisma.client;
    return {
      category: 'KILOMETRAGE',
      count: () => db.odometerReading.count({ where }),
      fetch: async (take) => {
        const rows = await db.odometerReading.findMany({
          where,
          orderBy: [{ observedAt: dir }, { id: dir }],
          take,
        });
        return rows.map((r) => {
          const level = accessOf(r.companyId);
          const full = level === 'COMPLET';
          const title =
            r.status === 'ACCEPTE'
              ? r.replacesReadingId
                ? 'Relevé corrigé'
                : 'Relevé accepté'
              : r.status === 'EN_ATTENTE'
                ? 'Relevé en attente de validation'
                : r.status === 'REJETE'
                  ? 'Relevé rejeté'
                  : 'Relevé remplacé par une correction';
          const reason =
            r.status === 'ACCEPTE' && r.replacesReadingId
              ? r.correctionReason
              : r.status === 'REJETE'
                ? (r.decisionReason ?? r.statusReason)
                : r.status === 'EN_ATTENTE'
                  ? r.statusReason
                  : null;
          return this.draft('RELEVE', title, {
            occurredAt: r.observedAt,
            objectType: 'OdometerReading',
            objectId: r.id,
            companyId: r.companyId,
            access: level,
            actor:
              r.source === 'TELEMATICS'
                ? { kind: 'TELEMATIQUE' }
                : full
                  ? { kind: 'UTILISATEUR', userId: r.createdById }
                  : { kind: 'AUTRE_SOCIETE' },
            objectAccessible: full,
            details: [
              ...km(
                r.isEstimate ? 'Kilométrage estimé' : 'Compteur',
                r.physicalKm ?? (r.isEstimate ? r.cumulativeKm : null),
              ),
              ...(r.isEstimate ? [] : km('Kilométrage cumulé', r.cumulativeKm)),
              ...text('Source', READING_SOURCE_LABELS[r.source]),
              ...text('Contexte', READING_CONTEXT_LABELS[r.context]),
              ...(r.measurementKind !== 'COMPTEUR_AFFICHE'
                ? text('Nature', MEASUREMENT_KIND_LABELS[r.measurementKind])
                : []),
              ...(full ? text('Motif', reason) : []),
            ],
          });
        });
      },
    };
  }

  private incidentSources(
    ctx: RequestContext | null,
    where: Prisma.IncidentWhereInput,
    dir: TimelineOrder,
    forDriver: boolean,
  ): Source[] {
    const db = this.prisma.client;
    const include = { driver: { select: { firstName: true, lastName: true } } } as const;
    const variants: Array<
      [
        TimelineEventType,
        string,
        Prisma.IncidentWhereInput,
        'occurredAt' | 'resolvedAt' | 'closedAt',
      ]
    > = [
      ['INCIDENT_DECLARE', 'Incident déclaré', where, 'occurredAt'],
      [
        'INCIDENT_RESOLU',
        'Incident résolu',
        { AND: [where, { resolvedAt: { not: null } }] },
        'resolvedAt',
      ],
      [
        'INCIDENT_CLOTURE',
        'Incident clôturé',
        { AND: [where, { closedAt: { not: null } }] },
        'closedAt',
      ],
    ];
    return variants.map(([type, title, w, field]) => ({
      category: 'INCIDENTS' as const,
      count: () => db.incident.count({ where: w }),
      fetch: async (take: number) => {
        const rows = await db.incident.findMany({
          where: w,
          orderBy: [{ [field]: dir }, { id: dir }],
          take,
          include,
        });
        return rows.map((i) => {
          const level = ctx
            ? visibleLevel('INCIDENT', { companyReadable: this.readable(ctx, i.companyId) })
            : 'COMPLET';
          return this.draft(type, title, {
            occurredAt: i[field] as Date,
            objectType: 'Incident',
            objectId: i.id,
            companyId: i.companyId,
            access: level,
            actor: {
              kind: 'UTILISATEUR',
              userId:
                field === 'occurredAt'
                  ? (i.reportedById ?? i.createdById)
                  : field === 'resolvedAt'
                    ? i.resolvedById
                    : i.closedById,
            },
            objectAccessible: true,
            details: [
              ...text('Référence', i.reference),
              ...text('Type', INCIDENT_TYPE_LABELS[i.type]),
              ...text('Gravité', INCIDENT_SEVERITY_LABELS[i.severity]),
              ...(forDriver ? [] : text('Conducteur', person(i.driver))),
              ...(field === 'occurredAt'
                ? text('Statut actuel', INCIDENT_STATUS_LABELS[i.status])
                : []),
              ...(field === 'resolvedAt' && !forDriver ? text('Résolution', i.resolutionNote) : []),
              ...(field === 'closedAt' && !forDriver ? text('Clôture', i.closureNote) : []),
            ],
          });
        });
      },
    }));
  }

  // ---------------------------------------------------------------------------
  // Mise en forme
  // ---------------------------------------------------------------------------

  private draft(
    type: TimelineEventType,
    title: string,
    rest: Omit<Draft, 'type' | 'title' | 'category' | 'rank'>,
  ): Draft {
    return { type, title, category: CATEGORY_OF[type], rank: RANK[type], ...rest };
  }

  private async userNames(
    ctx: RequestContext,
    drafts: readonly Draft[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        drafts.flatMap((d) =>
          d.actor.kind === 'UTILISATEUR' && d.actor.userId ? [d.actor.userId] : [],
        ),
      ),
    ];
    // Conducteur : aucun autre utilisateur n'est nommé (2.3) ; seul son propre nom peut apparaître.
    const allowed = ctx.isDriverOnly ? ids.filter((id) => id === ctx.userId) : ids;
    if (allowed.length === 0) return new Map();
    const users = await this.prisma.client.user.findMany({
      where: { organizationId: ctx.organizationId, id: { in: allowed } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
  }

  private async companyCodes(ctx: RequestContext): Promise<Map<string, string>> {
    const companies = await this.prisma.client.company.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, code: true },
    });
    return new Map(companies.map((c) => [c.id, c.code]));
  }

  private view(
    d: Draft,
    names: ReadonlyMap<string, string>,
    companies: ReadonlyMap<string, string>,
  ): TimelineEventDto {
    const actorName =
      d.actor.kind === 'TELEMATIQUE'
        ? TELEMATICS_AUTHOR
        : d.actor.kind === 'AUTRE_SOCIETE'
          ? OTHER_COMPANY_AUTHOR
          : d.actor.userId
            ? (names.get(d.actor.userId) ?? null)
            : null;
    return {
      id: `${d.type}:${d.objectId}`,
      type: d.type,
      category: d.category,
      categoryLabel: TIMELINE_CATEGORY_LABELS[d.category],
      occurredAt: d.occurredAt.toISOString(),
      title: d.title,
      companyId: d.companyId,
      companyCode: d.companyId ? (companies.get(d.companyId) ?? null) : null,
      access: d.access,
      actorName,
      objectType: d.objectType,
      objectId: d.objectId,
      objectAccessible: d.objectAccessible,
      details: d.details,
    };
  }
}

/**
 * Niveau d'accès d'un objet extrait par une requête de la chronologie. Les filtres de requête appliquent la
 * même politique (D-275) : un objet MASQUE à ce stade trahirait une incohérence, jamais montrée.
 */
function visibleLevel(
  kind: TimelineObjectKind,
  facts: Parameters<typeof timelineAccess>[1],
): 'COMPLET' | 'TECHNIQUE' {
  const level = timelineAccess(kind, facts);
  if (level === 'MASQUE')
    throw new Error(`Objet ${kind} hors périmètre extrait de la chronologie.`);
  return level;
}

const CATEGORY_OF: Readonly<Record<TimelineEventType, TimelineCategory>> = {
  VEHICULE_CREE: 'DOSSIER',
  SOCIETE_TRANSFERT: 'DOSSIER',
  AFFECTATION_DEBUT: 'AFFECTATIONS',
  AFFECTATION_FIN: 'AFFECTATIONS',
  RESERVATION_CREEE: 'RESERVATIONS',
  RESERVATION_ANNULEE: 'RESERVATIONS',
  RESERVATION_NON_HONOREE: 'RESERVATIONS',
  COMPTEUR_INITIALISE: 'KILOMETRAGE',
  COMPTEUR_REMPLACE: 'KILOMETRAGE',
  RELEVE: 'KILOMETRAGE',
  UTILISATION_REMISE: 'UTILISATIONS',
  UTILISATION_RETOUR: 'UTILISATIONS',
  INCIDENT_DECLARE: 'INCIDENTS',
  INCIDENT_RESOLU: 'INCIDENTS',
  INCIDENT_CLOTURE: 'INCIDENTS',
  IMMOBILISATION_DEBUT: 'IMMOBILISATIONS',
  IMMOBILISATION_FIN: 'IMMOBILISATIONS',
  PLAN_CREE: 'ENTRETIEN',
  PLAN_DESACTIVE: 'ENTRETIEN',
  INTERVENTION_CREEE: 'ENTRETIEN',
  INTERVENTION_TERMINEE: 'ENTRETIEN',
  INTERVENTION_ROUVERTE: 'ENTRETIEN',
  INTERVENTION_ANNULEE: 'ENTRETIEN',
  DOCUMENT_ENREGISTRE: 'DOCUMENTS',
  DOCUMENT_RENOUVELE: 'DOCUMENTS',
};
