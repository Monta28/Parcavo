import { Injectable, Logger } from '@nestjs/common';
import type { DocumentType, DocumentVersion, Prisma } from '@parc-auto/db';
import { AfterCommit } from '../../common/after-commit.js';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { compareCivil, fromDbDate, localDate, toDbDate } from '../../domain/civil-date.js';
import { documentAlertSeverity, isDocumentTypeApplicable } from '../../domain/document-applicability.js';
import { computeDocumentStatus, type DocumentStatusResult } from '../../domain/document-status.js';
import { INITIAL_DOCUMENT_TYPES, planCatalogInstall } from '../../domain/initial-catalog.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isUniqueViolation, type Tx } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type {
  ArchiveDocumentDto,
  ComplianceQueryDto,
  ComplianceRowDto,
  CorrectDocumentDto,
  CreateDocumentDto,
  CreateDocumentTypeDto,
  DocumentFieldsDto,
  DocumentTypeViewDto,
  DocumentViewDto,
  DocumentsQueryDto,
  InstallDocumentCatalogResultDto,
  RenewDocumentDto,
  UpdateDocumentTypeDto,
} from './dto/documents.dto.js';

type VersionRow = DocumentVersion & { documentType: { label: string; visibleToDriver: boolean; hasExpiry: boolean }; vehicle: { code: string; registration: string } | null; driver: { firstName: string; lastName: string } | null };

interface OwnerRef {
  ownerType: 'VEHICULE' | 'CONDUCTEUR';
  id: string;
  companyId: string;
  categoryId: string | null;
  label: string;
}

const versionInclude = {
  documentType: { select: { label: true, visibleToDriver: true, hasExpiry: true } },
  vehicle: { select: { code: true, registration: true } },
  driver: { select: { firstName: true, lastName: true } },
} satisfies Prisma.DocumentVersionInclude;

/**
 * Documents et conformité (CDC 7.1, 7.2) : types paramétrables, versions (un renouvellement crée une
 * nouvelle version), statut calculé par la règle unique document-status.ts au jour local du groupe,
 * alertes dédupliquées dont la gravité suit les paliers de préavis. Aucun calendrier réglementaire.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly attachments: AttachmentsService,
    private readonly alerts: AlertsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ---------------------------------------------------------------------------
  // Types de documents (paramétrage administrateur)
  // ---------------------------------------------------------------------------

  async listTypes(ctx: RequestContext, includeArchived: boolean): Promise<DocumentTypeViewDto[]> {
    this.access.requireStaff(ctx);
    const items = await this.prisma.client.documentType.findMany({ where: { organizationId: ctx.organizationId, ...(includeArchived ? {} : { status: 'ACTIF' }) }, orderBy: [{ ownerType: 'asc' }, { label: 'asc' }] });
    return items.map(typeView);
  }

  async createType(ctx: RequestContext, dto: CreateDocumentTypeDto): Promise<DocumentTypeViewDto> {
    this.access.requireAdmin(ctx);
    if (dto.blocksCheckout && !dto.required) throw new BusinessRuleError('BLOQUANT_IMPLIQUE_REQUIS', 'Un document bloquant est nécessairement requis.', { fieldErrors: { required: ['Cochez « requis » pour un document bloquant.'] } });
    await this.assertScopeIds(ctx, dto.vehicleCategoryIds ?? [], dto.companyIds ?? []);
    const noticeDays = dto.noticeDays ?? (await this.settings.get(ctx.organizationId, 'documents.noticeDays'));
    try {
      const created = await this.prisma.client.$transaction(async (tx) => {
        const t = await tx.documentType.create({
          data: {
            organizationId: ctx.organizationId,
            code: dto.code,
            label: dto.label.trim(),
            ownerType: dto.ownerType,
            hasExpiry: dto.hasExpiry,
            required: dto.required,
            blocksCheckout: dto.blocksCheckout,
            noticeDays: [...noticeDays],
            visibleToDriver: dto.visibleToDriver ?? false,
            vehicleCategoryIds: dto.ownerType === 'VEHICULE' ? (dto.vehicleCategoryIds ?? []) : [],
            companyIds: dto.companyIds ?? [],
            createdById: ctx.userId,
          },
        });
        await this.audit.record(ctx, { action: 'type_document.creation', objectType: 'DocumentType', objectId: t.id, after: typeView(t) }, tx);
        return t;
      });
      await this.evaluateAll(ctx.organizationId);
      return typeView(created);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('CODE_EXISTANT', `Le code ${dto.code} existe déjà.`);
      throw error;
    }
  }

  /**
   * Installation des types de documents usuels (7.1) par l'administrateur : seuls les types absents (ni
   * même code, ni même libellé pour le même objet, actifs ou archivés) sont ajoutés, facultatifs et non
   * bloquants, avec les préavis paramétrés ; aucun type existant n'est modifié. Rejouable sans effet
   * (ON CONFLICT DO NOTHING sur le code unique) ; Idempotency-Key facultative ; audité.
   */
  async installInitialTypes(ctx: RequestContext, idempotencyKey?: string): Promise<InstallDocumentCatalogResultDto> {
    this.access.requireAdmin(ctx);
    const noticeDays = await this.settings.get(ctx.organizationId, 'documents.noticeDays');
    return this.idempotency.runOptional({ organizationId: ctx.organizationId, userId: ctx.userId, operation: 'type_document.catalogue_initial' }, idempotencyKey, {}, async () => ({
      status: 200,
      body: await this.prisma.client.$transaction(async (tx) => {
        const existing = await tx.documentType.findMany({ where: { organizationId: ctx.organizationId }, select: { code: true, label: true, ownerType: true } });
        const plan = planCatalogInstall(
          INITIAL_DOCUMENT_TYPES.map((t) => ({ ...t, scope: t.ownerType })),
          existing.map((e) => ({ code: e.code, label: e.label, scope: e.ownerType })),
        );
        const created =
          plan.toCreate.length > 0
            ? await tx.documentType.createManyAndReturn({
                data: plan.toCreate.map((t) => ({
                  organizationId: ctx.organizationId,
                  code: t.code,
                  label: t.label,
                  ownerType: t.ownerType,
                  hasExpiry: t.hasExpiry,
                  required: false,
                  blocksCheckout: false,
                  noticeDays: [...noticeDays],
                  visibleToDriver: false,
                  createdById: ctx.userId,
                })),
                skipDuplicates: true,
              })
            : [];
        const createdCodes = new Set(created.map((c) => c.code));
        const ownerOf = new Map(INITIAL_DOCUMENT_TYPES.map((t) => [t.code, t.ownerType]));
        const skipped = [
          ...plan.skipped.map((k) => ({ ...k, ownerType: ownerOf.get(k.code) as string })),
          ...plan.toCreate.filter((t) => !createdCodes.has(t.code)).map((t) => ({ code: t.code, label: t.label, ownerType: t.ownerType, reason: 'CODE_EXISTANT' as const })),
        ];
        const views = created.sort((a, b) => a.ownerType.localeCompare(b.ownerType) || a.label.localeCompare(b.label, 'fr')).map(typeView);
        for (const v of views) await this.audit.record(ctx, { action: 'type_document.creation', objectType: 'DocumentType', objectId: v.id, reason: 'Installation du catalogue initial', after: v }, tx);
        await this.audit.record(ctx, { action: 'type_document.catalogue_initial', objectType: 'Organization', objectId: ctx.organizationId, after: { created: views.map((v) => v.code), skipped } }, tx);
        return { created: views, skipped };
      }),
    }));
  }

  async updateType(ctx: RequestContext, id: string, dto: UpdateDocumentTypeDto): Promise<DocumentTypeViewDto> {
    this.access.requireAdmin(ctx);
    const current = await this.prisma.client.documentType.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!current) throw new NotFoundOrOutOfScopeError('Type de document');
    assertExpectedVersion(current, dto.expectedVersion, 'type de document');
    const required = dto.required ?? current.required;
    const blocks = dto.blocksCheckout ?? current.blocksCheckout;
    if (blocks && !required) throw new BusinessRuleError('BLOQUANT_IMPLIQUE_REQUIS', 'Un document bloquant est nécessairement requis.');
    await this.assertScopeIds(ctx, dto.vehicleCategoryIds ?? [], dto.companyIds ?? []);
    const updated = await this.prisma.client.$transaction(async (tx) => {
      const t = await tx.documentType.update({
        where: { id, version: dto.expectedVersion },
        data: {
          ...(dto.label !== undefined ? { label: dto.label.trim() } : {}),
          required,
          blocksCheckout: blocks,
          ...(dto.noticeDays !== undefined ? { noticeDays: dto.noticeDays } : {}),
          ...(dto.visibleToDriver !== undefined ? { visibleToDriver: dto.visibleToDriver } : {}),
          ...(dto.vehicleCategoryIds !== undefined ? { vehicleCategoryIds: current.ownerType === 'VEHICULE' ? dto.vehicleCategoryIds : [] } : {}),
          ...(dto.companyIds !== undefined ? { companyIds: dto.companyIds } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          version: { increment: 1 },
        },
      });
      await this.audit.record(ctx, { action: 'type_document.modification', objectType: 'DocumentType', objectId: id, before: typeView(current), after: typeView(t) }, tx);
      return t;
    });
    await this.evaluateAll(ctx.organizationId);
    return typeView(updated);
  }

  // ---------------------------------------------------------------------------
  // Versions
  // ---------------------------------------------------------------------------

  async list(ctx: RequestContext, query: DocumentsQueryDto): Promise<Page<DocumentViewDto>> {
    const where: Prisma.DocumentVersionWhereInput = { AND: [await this.readScope(ctx, query.vehicleId, query.driverId), query.documentTypeId ? { documentTypeId: query.documentTypeId } : {}, query.includeArchived === 'true' && !ctx.isDriverOnly ? {} : { archivedAt: null }, !ctx.isDriverOnly && query.companyId ? this.access.companyWhere(ctx, query.companyId) : {}] };
    const [items, total] = await Promise.all([
      this.prisma.client.documentVersion.findMany({ where, include: versionInclude, ...skipTake(query), orderBy: [{ validTo: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }] }),
      this.prisma.client.documentVersion.count({ where }),
    ]);
    return pageOf(items.map(versionView), total, query);
  }

  async get(ctx: RequestContext, id: string): Promise<DocumentViewDto> {
    return versionView(await this.load(ctx, id));
  }

  /** Enregistrement d'un document ; en-tête Idempotency-Key facultatif (D-308) : un nouvel envoi identique ne crée pas de doublon. */
  async create(ctx: RequestContext, dto: CreateDocumentDto, idempotencyKey?: string): Promise<DocumentViewDto> {
    return this.idempotency.runOptional({ organizationId: ctx.organizationId, userId: ctx.userId, operation: 'document.creation' }, idempotencyKey, dto, async () => {
      const view = await this.createOnce(ctx, dto);
      return { status: 201, body: view, resourceId: view.id };
    });
  }

  private async createOnce(ctx: RequestContext, dto: CreateDocumentDto): Promise<DocumentViewDto> {
    if (Boolean(dto.vehicleId) === Boolean(dto.driverId)) throw new BusinessRuleError('PROPRIETAIRE_REQUIS', 'Indiquez un véhicule ou un conducteur.');
    const owner = await this.owner(ctx, dto.vehicleId ? 'VEHICULE' : 'CONDUCTEUR', (dto.vehicleId ?? dto.driverId) as string);
    this.access.requirePermission(ctx, owner.companyId, 'documents.manage', 'La gestion des documents requiert la permission documents.manage.');
    const type = await this.writableType(ctx, dto.documentTypeId);
    if (type.ownerType !== owner.ownerType) throw new BusinessRuleError('TYPE_INCOMPATIBLE', `Ce type de document concerne un ${type.ownerType === 'VEHICULE' ? 'véhicule' : 'conducteur'}.`);
    const fields = this.validateFields(type, dto);
    const id = await this.prisma.client.$transaction(async (tx) => {
      const v = await this.insertVersion(tx, ctx, type, owner, fields, null);
      await this.audit.record(ctx, { action: 'document.creation', objectType: 'DocumentVersion', objectId: v.id, companyId: owner.companyId, after: { type: type.code, owner: owner.label, ...fields } }, tx);
      return v.id;
    });
    await this.evaluateOwner(owner);
    return this.get(ctx, id);
  }

  /** Renouvellement : nouvelle version liée à la précédente ; une version future ne remplace pas une version valide. */
  async renew(ctx: RequestContext, id: string, dto: RenewDocumentDto, idempotencyKey?: string): Promise<DocumentViewDto> {
    return this.idempotency.runOptional({ organizationId: ctx.organizationId, userId: ctx.userId, operation: `document.renouvellement:${id}` }, idempotencyKey, dto, async () => {
      const view = await this.renewOnce(ctx, id, dto);
      return { status: 201, body: view, resourceId: view.id };
    });
  }

  private async renewOnce(ctx: RequestContext, id: string, dto: RenewDocumentDto): Promise<DocumentViewDto> {
    const previous = await this.load(ctx, id);
    const owner = await this.owner(ctx, previous.ownerType, (previous.vehicleId ?? previous.driverId) as string);
    this.access.requirePermission(ctx, owner.companyId, 'documents.manage', 'La gestion des documents requiert la permission documents.manage.');
    if (previous.archivedAt) throw new ConflictError('ETAT_INVALIDE', 'Cette version est archivée.');
    const type = await this.writableType(ctx, previous.documentTypeId);
    const fields = this.validateFields(type, dto);
    const newId = await this.prisma.client.$transaction(async (tx) => {
      const v = await this.insertVersion(tx, ctx, type, owner, fields, previous.id);
      await this.audit.record(ctx, { action: 'document.renouvellement', objectType: 'DocumentVersion', objectId: v.id, companyId: owner.companyId, after: { previousVersionId: previous.id, ...fields } }, tx);
      return v.id;
    });
    await this.evaluateOwner(owner);
    return this.get(ctx, newId);
  }

  /**
   * Correction d'une faute de saisie : modification en place, auditée avant/après avec motif (D-209).
   * Champ absent : conservé ; null (ou texte vide) : effacé — une date facultative (émission, début) et la
   * fin de validité d'un type sans expiration peuvent être effacées. attachmentId null détache le
   * justificatif (version « justificatif absent ») ; un justificatif détaché ou remplacé est supprimé
   * logiquement dans la même transaction, avec le motif de la correction.
   */
  async correct(ctx: RequestContext, id: string, dto: CorrectDocumentDto): Promise<DocumentViewDto> {
    const current = await this.load(ctx, id);
    this.access.requirePermission(ctx, current.companyId, 'documents.manage', 'La gestion des documents requiert la permission documents.manage.');
    assertExpectedVersion(current, dto.expectedVersion, 'document');
    if (current.archivedAt) throw new ConflictError('ETAT_INVALIDE', 'Cette version est archivée.');
    const type = await this.writableType(ctx, current.documentTypeId);
    const keep = <T>(value: T | null | undefined, stored: T | null): T | undefined => (value === undefined ? stored : value) ?? undefined;
    const merged: DocumentFieldsDto = {
      number: keep(dto.number, current.number),
      issuer: keep(dto.issuer, current.issuer),
      issuedOn: keep(dto.issuedOn, fromDbDate(current.issuedOn)),
      validFrom: keep(dto.validFrom, fromDbDate(current.validFrom)),
      validTo: keep(dto.validTo, fromDbDate(current.validTo)),
      notes: keep(dto.notes, current.notes),
    };
    const fields = this.validateFields(type, merged);
    const attachmentId = dto.attachmentId === undefined ? current.attachmentId : dto.attachmentId;
    const attachmentChanged = attachmentId !== current.attachmentId;
    const owner = await this.owner(ctx, current.ownerType, (current.vehicleId ?? current.driverId) as string);
    const after = new AfterCommit();
    await this.prisma.transaction(async (tx) => {
      // Ordre de verrouillage unique pièce jointe → version (comme DELETE /attachments/:id) : une suppression
      // concurrente du justificatif est sérialisée sans interblocage ; la clause de version protège la ligne.
      if (attachmentChanged) await this.attachments.lockForUpdate(tx, [current.attachmentId, attachmentId].filter((a): a is string => a !== null));
      await tx.documentVersion.update({
        where: { id, version: dto.expectedVersion },
        data: { number: fields.number, issuer: fields.issuer, issuedOn: toDbDate(fields.issuedOn), validFrom: toDbDate(fields.validFrom), validTo: toDbDate(fields.validTo), notes: fields.notes, attachmentId, version: { increment: 1 } },
      });
      if (attachmentChanged && attachmentId) await this.attachments.attach(ctx, tx, attachmentId, 'DOCUMENT', id, current.companyId);
      if (attachmentChanged && current.attachmentId) await this.attachments.discard(ctx, tx, current.attachmentId, dto.reason, after, { alreadyDeletedOk: true });
      await this.audit.record(
        ctx,
        { action: 'document.correction', objectType: 'DocumentVersion', objectId: id, companyId: current.companyId, reason: dto.reason, before: versionView(current), after: { number: fields.number, issuer: fields.issuer, issuedOn: fields.issuedOn, validFrom: fields.validFrom, validTo: fields.validTo, notes: fields.notes, attachmentId, missingFile: attachmentId === null } },
        tx,
      );
    });
    await after.run();
    await this.evaluateOwner(owner);
    return this.get(ctx, id);
  }

  /** Version erronée : archivée (jamais supprimée), motif audité. */
  async archive(ctx: RequestContext, id: string, dto: ArchiveDocumentDto): Promise<DocumentViewDto> {
    const current = await this.load(ctx, id);
    this.access.requirePermission(ctx, current.companyId, 'documents.manage', 'La gestion des documents requiert la permission documents.manage.');
    assertExpectedVersion(current, dto.expectedVersion, 'document');
    if (current.archivedAt) throw new ConflictError('ETAT_INVALIDE', 'Version déjà archivée.');
    const owner = await this.owner(ctx, current.ownerType, (current.vehicleId ?? current.driverId) as string);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.documentVersion.update({ where: { id, version: dto.expectedVersion }, data: { archivedAt: this.clock.now(), version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'document.archivage', objectType: 'DocumentVersion', objectId: id, companyId: current.companyId, reason: dto.reason }, tx);
    });
    await this.alerts.resolve({ organizationId: ctx.organizationId, type: 'DOCUMENT_ECHEANCE', objectType: 'DocumentVersion', objectId: id }, 'version archivée');
    await this.evaluateOwner(owner);
    return this.get(ctx, id);
  }

  // ---------------------------------------------------------------------------
  // Conformité et alertes
  // ---------------------------------------------------------------------------

  /** Tableau de conformité : une ligne par objet et type applicable (MANQUANT inclus pour les types requis). */
  async compliance(ctx: RequestContext, query: ComplianceQueryDto): Promise<Page<ComplianceRowDto>> {
    this.access.requireStaff(ctx);
    const scope = this.access.companyWhere(ctx, query.companyId);
    const types = await this.prisma.client.documentType.findMany({ where: { organizationId: ctx.organizationId, status: 'ACTIF', ...(query.documentTypeId ? { id: query.documentTypeId } : {}), ...(query.ownerType ? { ownerType: query.ownerType } : {}) } });
    const owners: OwnerRef[] = [];
    if (!query.driverId && types.some((t) => t.ownerType === 'VEHICULE')) {
      const vehicles = await this.prisma.client.vehicle.findMany({ where: { ...scope, lifecycleStatus: { in: ['ACTIF', 'HORS_SERVICE'] }, ...(query.vehicleId ? { id: query.vehicleId } : {}) }, select: { id: true, companyId: true, categoryId: true, code: true, registration: true }, orderBy: { code: 'asc' } });
      owners.push(...vehicles.map((v) => ({ ownerType: 'VEHICULE' as const, id: v.id, companyId: v.companyId, categoryId: v.categoryId, label: `${v.code} · ${v.registration}` })));
    }
    if (!query.vehicleId && types.some((t) => t.ownerType === 'CONDUCTEUR')) {
      const drivers = await this.prisma.client.driver.findMany({ where: { ...scope, status: 'ACTIF', ...(query.driverId ? { id: query.driverId } : {}) }, select: { id: true, companyId: true, firstName: true, lastName: true, code: true }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }] });
      owners.push(...drivers.map((d) => ({ ownerType: 'CONDUCTEUR' as const, id: d.id, companyId: d.companyId, categoryId: null, label: `${d.firstName} ${d.lastName} (${d.code})` })));
    }
    const today = await this.today(ctx.organizationId);
    const rows = await this.rowsFor(owners, types, today);
    const filtered = rows.filter((r) => (!query.status || r.status === query.status) && (query.blocking !== 'true' || r.blocksCheckout));
    const start = (query.page - 1) * query.pageSize;
    return pageOf(filtered.slice(start, start + query.pageSize), filtered.length, query);
  }

  /** Recalcule les alertes documentaires d'un objet (après toute écriture ou au rattrapage). */
  async evaluateOwner(owner: OwnerRef): Promise<void> {
    const organizationId = (await this.prisma.client.company.findUniqueOrThrow({ where: { id: owner.companyId }, select: { organizationId: true } })).organizationId;
    const types = await this.prisma.client.documentType.findMany({ where: { organizationId, ownerType: owner.ownerType } });
    const today = await this.today(organizationId);
    const active = types.filter((t) => t.status === 'ACTIF');
    const rows = await this.rowsFor([owner], active, today, true);
    for (const type of types) {
      const row = rows.find((r) => r.documentTypeId === type.id);
      await this.syncAlerts(organizationId, owner, type, row ?? null);
    }
  }

  /** Rattrapage (15 min) : transitions au jour local (T21), idempotent. */
  async evaluateAll(organizationId?: string): Promise<number> {
    const orgFilter = organizationId ? { organizationId } : {};
    const [vehicles, drivers] = await Promise.all([
      this.prisma.client.vehicle.findMany({ where: { ...orgFilter }, select: { id: true, companyId: true, categoryId: true, code: true, registration: true, lifecycleStatus: true } }),
      this.prisma.client.driver.findMany({ where: { ...orgFilter }, select: { id: true, companyId: true, firstName: true, lastName: true, code: true, status: true } }),
    ]);
    let count = 0;
    for (const v of vehicles) {
      try {
        await this.evaluateOwner({ ownerType: 'VEHICULE', id: v.id, companyId: v.companyId, categoryId: v.categoryId, label: `${v.code} · ${v.registration}` });
        count += 1;
      } catch (error) {
        this.logger.error(`Évaluation documentaire du véhicule ${v.id} en échec : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const d of drivers) {
      try {
        await this.evaluateOwner({ ownerType: 'CONDUCTEUR', id: d.id, companyId: d.companyId, categoryId: null, label: `${d.firstName} ${d.lastName} (${d.code})` });
        count += 1;
      } catch (error) {
        this.logger.error(`Évaluation documentaire du conducteur ${d.id} en échec : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return count;
  }

  private async rowsFor(owners: OwnerRef[], types: DocumentType[], today: string, includeInactiveOwners = false): Promise<ComplianceRowDto[]> {
    if (owners.length === 0 || types.length === 0) return [];
    const versions = await this.prisma.client.documentVersion.findMany({
      where: { archivedAt: null, documentTypeId: { in: types.map((t) => t.id) }, OR: [{ vehicleId: { in: owners.filter((o) => o.ownerType === 'VEHICULE').map((o) => o.id) } }, { driverId: { in: owners.filter((o) => o.ownerType === 'CONDUCTEUR').map((o) => o.id) } }] },
      select: { id: true, documentTypeId: true, vehicleId: true, driverId: true, validFrom: true, validTo: true },
    });
    const rows: ComplianceRowDto[] = [];
    void includeInactiveOwners;
    for (const owner of owners) {
      for (const type of types) {
        if (!isDocumentTypeApplicable(type, owner)) continue;
        const own = versions.filter((v) => v.documentTypeId === type.id && (owner.ownerType === 'VEHICULE' ? v.vehicleId === owner.id : v.driverId === owner.id));
        const result = computeDocumentStatus(type, own.map((v) => ({ id: v.id, validFrom: fromDbDate(v.validFrom), validTo: fromDbDate(v.validTo) })), today);
        if (result.status === null) continue;
        rows.push(complianceRow(owner, type, result));
      }
    }
    return rows;
  }

  private async syncAlerts(organizationId: string, owner: OwnerRef, type: DocumentType, row: ComplianceRowDto | null): Promise<void> {
    const versionIds = (await this.prisma.client.documentVersion.findMany({ where: { documentTypeId: type.id, ...(owner.ownerType === 'VEHICULE' ? { vehicleId: owner.id } : { driverId: owner.id }) }, select: { id: true } })).map((v) => v.id);
    const missingKey = { organizationId, type: 'DOCUMENT_MANQUANT' as const, objectType: owner.ownerType === 'VEHICULE' ? 'Vehicle' : 'Driver', objectId: owner.id, occurrenceKey: type.id };
    const actionPath = owner.ownerType === 'VEHICULE' ? `/documents?vehicule=${owner.id}` : `/documents?conducteur=${owner.id}`;
    const ownerInactive = await this.ownerInactive(owner);
    if (!row || ownerInactive || type.status !== 'ACTIF') {
      await this.alerts.resolve(missingKey, 'document non exigé');
      for (const v of versionIds) await this.alerts.resolve({ organizationId, type: 'DOCUMENT_ECHEANCE', objectType: 'DocumentVersion', objectId: v }, 'document non exigé');
      return;
    }
    if (row.status === 'MANQUANT') {
      for (const v of versionIds) await this.alerts.resolve({ organizationId, type: 'DOCUMENT_ECHEANCE', objectType: 'DocumentVersion', objectId: v }, 'document manquant signalé à part');
      await this.alerts.raise({
        ...missingKey,
        companyId: owner.companyId,
        severity: type.blocksCheckout ? 'URGENT' : 'ATTENTION',
        vehicleId: owner.ownerType === 'VEHICULE' ? owner.id : null,
        title: `${type.label} manquant — ${owner.label}`,
        message: `${row.detail}${type.blocksCheckout ? ' Ce document bloque un nouveau départ.' : ''}`,
        condition: { documentTypeId: type.id, ownerType: owner.ownerType, objectId: owner.id },
        actionPath,
      });
      return;
    }
    await this.alerts.resolve(missingKey, 'document enregistré');
    const target = row.status === 'EXPIRE' || row.status === 'A_RENOUVELER' ? row.currentVersionId : null;
    for (const v of versionIds) if (v !== target) await this.alerts.resolve({ organizationId, type: 'DOCUMENT_ECHEANCE', objectType: 'DocumentVersion', objectId: v }, 'document valide ou renouvelé');
    if (!target) return;
    const expired = row.status === 'EXPIRE';
    await this.alerts.raise({
      organizationId,
      companyId: owner.companyId,
      type: 'DOCUMENT_ECHEANCE',
      severity: documentAlertSeverity(type.noticeDays, expired ? null : row.daysRemaining === null ? null : [...type.noticeDays].sort((a, b) => a - b).find((n) => (row.daysRemaining as number) <= n) ?? null, expired, type.blocksCheckout),
      objectType: 'DocumentVersion',
      objectId: target,
      vehicleId: owner.ownerType === 'VEHICULE' ? owner.id : null,
      occurrenceKey: `echeance:${row.validTo ?? '-'}`,
      title: `${type.label} ${expired ? 'expiré' : 'à renouveler'} — ${owner.label}`,
      message: `${row.detail}${expired && type.blocksCheckout ? ' Nouveau départ bloqué (restitution toujours possible).' : ''}`,
      condition: { documentTypeId: type.id, ownerType: owner.ownerType, objectId: owner.id, validTo: row.validTo, status: row.status },
      actionPath,
    });
  }

  private async ownerInactive(owner: OwnerRef): Promise<boolean> {
    if (owner.ownerType === 'VEHICULE') {
      const v = await this.prisma.client.vehicle.findUnique({ where: { id: owner.id }, select: { lifecycleStatus: true } });
      // D-171 : aucune alerte documentaire pour un véhicule hors service, cédé ou archivé.
      return !v || v.lifecycleStatus !== 'ACTIF';
    }
    const d = await this.prisma.client.driver.findUnique({ where: { id: owner.id }, select: { status: true } });
    return !d || d.status !== 'ACTIF';
  }

  // ---------------------------------------------------------------------------

  /** Périmètre de lecture : personnel dans ses sociétés ; conducteur limité à ses documents et au véhicule de son utilisation en cours (D-209). */
  private async readScope(ctx: RequestContext, vehicleId?: string, driverId?: string): Promise<Prisma.DocumentVersionWhereInput> {
    if (!ctx.isDriverOnly) {
      return { ...this.access.companyWhere(ctx), ...(vehicleId ? { vehicleId } : {}), ...(driverId ? { driverId } : {}) };
    }
    if (!ctx.driverId) return { id: '00000000-0000-0000-0000-000000000000' };
    if (vehicleId) {
      const usage = await this.prisma.client.vehicleUsage.findFirst({ where: { vehicleId, driverId: ctx.driverId, status: 'EN_COURS' }, select: { id: true } });
      if (!usage) return { id: '00000000-0000-0000-0000-000000000000' };
      return { organizationId: ctx.organizationId, vehicleId, documentType: { visibleToDriver: true } };
    }
    if (driverId && driverId !== ctx.driverId) return { id: '00000000-0000-0000-0000-000000000000' };
    return { organizationId: ctx.organizationId, driverId: ctx.driverId };
  }

  private async load(ctx: RequestContext, id: string): Promise<VersionRow> {
    const v = await this.prisma.client.documentVersion.findFirst({ where: { id, organizationId: ctx.organizationId }, include: versionInclude });
    if (!v) throw new NotFoundOrOutOfScopeError('Document');
    if (ctx.isDriverOnly) {
      const scope = await this.readScope(ctx, v.vehicleId ?? undefined, v.driverId ?? undefined);
      const visible = await this.prisma.client.documentVersion.count({ where: { AND: [{ id }, scope] } });
      if (!visible) throw new NotFoundOrOutOfScopeError('Document');
    } else if (!this.access.canReadCompany(ctx, v.companyId)) {
      throw new NotFoundOrOutOfScopeError('Document');
    }
    return v;
  }

  private async owner(ctx: RequestContext, ownerType: 'VEHICULE' | 'CONDUCTEUR', id: string): Promise<OwnerRef> {
    if (ctx.isDriverOnly) throw new NotFoundOrOutOfScopeError(ownerType === 'VEHICULE' ? 'Véhicule' : 'Conducteur');
    if (ownerType === 'VEHICULE') {
      const v = await this.prisma.client.vehicle.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true, companyId: true, categoryId: true, code: true, registration: true } });
      if (!v || !this.access.canReadCompany(ctx, v.companyId)) throw new NotFoundOrOutOfScopeError('Véhicule');
      return { ownerType, id: v.id, companyId: v.companyId, categoryId: v.categoryId, label: `${v.code} · ${v.registration}` };
    }
    const d = await this.prisma.client.driver.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true, companyId: true, firstName: true, lastName: true, code: true } });
    if (!d || !this.access.canReadCompany(ctx, d.companyId)) throw new NotFoundOrOutOfScopeError('Conducteur');
    return { ownerType, id: d.id, companyId: d.companyId, categoryId: null, label: `${d.firstName} ${d.lastName} (${d.code})` };
  }

  /** Type utilisable pour écrire une version : 404 s'il n'existe pas, 422 TYPE_ARCHIVE explicite s'il est archivé. */
  private async writableType(ctx: RequestContext, id: string): Promise<DocumentType> {
    const type = await this.prisma.client.documentType.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!type) throw new NotFoundOrOutOfScopeError('Type de document');
    if (type.status !== 'ACTIF') {
      throw new BusinessRuleError('TYPE_ARCHIVE', `Le type de document « ${type.label} » est archivé : ses versions ne peuvent plus être enregistrées, renouvelées ni corrigées. Un administrateur peut le réactiver ; une version erronée peut toujours être archivée.`, {
        details: { documentTypeId: type.id },
      });
    }
    return type;
  }

  private validateFields(type: DocumentType, dto: DocumentFieldsDto): { number: string | null; issuer: string | null; issuedOn: string | null; validFrom: string | null; validTo: string | null; notes: string | null; attachmentId: string | null } {
    if (type.hasExpiry && !dto.validTo) throw new BusinessRuleError('FIN_VALIDITE_REQUISE', 'Ce type de document a une date de fin de validité.', { fieldErrors: { validTo: ['Date de fin requise.'] } });
    if (!type.hasExpiry && dto.validTo) throw new BusinessRuleError('SANS_EXPIRATION', 'Ce type de document n’a pas de date de fin : aucune échéance n’est calculée.', { fieldErrors: { validTo: ['Sans objet pour ce type.'] } });
    if (dto.validFrom && dto.validTo && compareCivil(dto.validFrom, dto.validTo) > 0) throw new BusinessRuleError('DATES_INCOHERENTES', 'La fin de validité précède le début.', { fieldErrors: { validTo: ['Fin avant le début.'] } });
    return {
      number: dto.number?.trim() || null,
      issuer: dto.issuer?.trim() || null,
      issuedOn: dto.issuedOn ?? null,
      validFrom: dto.validFrom ?? null,
      validTo: dto.validTo ?? null,
      notes: dto.notes?.trim() || null,
      attachmentId: dto.attachmentId ?? null,
    };
  }

  private async insertVersion(tx: Tx, ctx: RequestContext, type: DocumentType, owner: OwnerRef, fields: ReturnType<DocumentsService['validateFields']>, previousVersionId: string | null): Promise<DocumentVersion> {
    const v = await tx.documentVersion.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: owner.companyId,
        documentTypeId: type.id,
        ownerType: owner.ownerType,
        vehicleId: owner.ownerType === 'VEHICULE' ? owner.id : null,
        driverId: owner.ownerType === 'CONDUCTEUR' ? owner.id : null,
        number: fields.number,
        issuer: fields.issuer,
        issuedOn: toDbDate(fields.issuedOn),
        validFrom: toDbDate(fields.validFrom),
        validTo: toDbDate(fields.validTo),
        notes: fields.notes,
        previousVersionId,
        createdById: ctx.userId,
      },
    });
    if (fields.attachmentId) {
      await this.attachments.attach(ctx, tx, fields.attachmentId, 'DOCUMENT', v.id, owner.companyId);
      return tx.documentVersion.update({ where: { id: v.id }, data: { attachmentId: fields.attachmentId } });
    }
    return v;
  }

  private async assertScopeIds(ctx: RequestContext, categoryIds: string[], companyIds: string[]): Promise<void> {
    if (categoryIds.length) {
      const n = await this.prisma.client.vehicleCategory.count({ where: { id: { in: categoryIds }, organizationId: ctx.organizationId } });
      if (n !== new Set(categoryIds).size) throw new NotFoundOrOutOfScopeError('Catégorie de véhicule');
    }
    if (companyIds.length) {
      const n = await this.prisma.client.company.count({ where: { id: { in: companyIds }, organizationId: ctx.organizationId } });
      if (n !== new Set(companyIds).size) throw new NotFoundOrOutOfScopeError('Société');
    }
  }

  private async today(organizationId: string): Promise<string> {
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } });
    return localDate(this.clock.now(), org.timezone);
  }
}

function typeView(t: DocumentType): DocumentTypeViewDto {
  return {
    id: t.id,
    code: t.code,
    label: t.label,
    ownerType: t.ownerType,
    hasExpiry: t.hasExpiry,
    required: t.required,
    blocksCheckout: t.blocksCheckout,
    noticeDays: t.noticeDays,
    visibleToDriver: t.visibleToDriver,
    vehicleCategoryIds: t.vehicleCategoryIds,
    companyIds: t.companyIds,
    status: t.status,
    version: t.version,
  };
}

function versionView(v: VersionRow): DocumentViewDto {
  return {
    id: v.id,
    companyId: v.companyId,
    documentTypeId: v.documentTypeId,
    documentTypeLabel: v.documentType.label,
    ownerType: v.ownerType,
    vehicleId: v.vehicleId,
    driverId: v.driverId,
    ownerLabel: v.vehicle ? `${v.vehicle.code} · ${v.vehicle.registration}` : v.driver ? `${v.driver.firstName} ${v.driver.lastName}` : '—',
    number: v.number,
    issuer: v.issuer,
    issuedOn: fromDbDate(v.issuedOn),
    validFrom: fromDbDate(v.validFrom),
    validTo: fromDbDate(v.validTo),
    attachmentId: v.attachmentId,
    missingFile: v.attachmentId === null,
    notes: v.notes,
    previousVersionId: v.previousVersionId,
    archivedAt: v.archivedAt?.toISOString() ?? null,
    createdAt: v.createdAt.toISOString(),
    version: v.version,
  };
}

function complianceRow(owner: OwnerRef, type: DocumentType, r: DocumentStatusResult): ComplianceRowDto {
  return {
    ownerType: owner.ownerType,
    objectId: owner.id,
    objectLabel: owner.label,
    companyId: owner.companyId,
    documentTypeId: type.id,
    documentTypeLabel: type.label,
    status: r.status as string,
    detail: r.detail,
    validFrom: r.validFrom,
    validTo: r.validTo,
    daysRemaining: r.daysRemaining,
    currentVersionId: r.currentVersionId,
    upcomingVersionId: r.upcomingVersionId,
    nextValidFrom: r.nextValidFrom,
    nextValidTo: r.nextValidTo,
    renewed: r.renewed,
    blocksCheckout: r.blocksCheckout,
  };
}
