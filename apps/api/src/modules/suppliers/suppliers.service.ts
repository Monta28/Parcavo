import { Injectable } from '@nestjs/common';
import type { Prisma, Supplier } from '@parc-auto/db';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isUniqueViolation } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import type { CopySupplierDto, CreateSupplierDto, SupplierStatusDto, SupplierViewDto, SuppliersQueryDto, UpdateSupplierDto } from './dto/suppliers.dto.js';

/** Contrainte d'unicité (D-221) : nom normalisé (minuscules, espaces compactés, sans accents) par société, parmi les ACTIF. */
const ACTIVE_NAME_UNIQUE = 'supplier_active_normalized_name';

function duplicateName(target: 'société' | 'société de destination' = 'société'): ConflictError {
  return new ConflictError('FOURNISSEUR_EXISTANT', `Un fournisseur actif porte déjà ce nom dans la ${target} (majuscules, accents et espaces ignorés).`);
}

function isDuplicateName(error: unknown): boolean {
  return isUniqueViolation(error, ACTIVE_NAME_UNIQUE) || isUniqueViolation(error, 'normalizedName');
}

/** Fournisseur archivé choisi dans un formulaire (D-221) : 422, le champ fautif est signalé. */
export function archivedSupplier(s: { name: string }, field: string | null = 'supplierId'): BusinessRuleError {
  return new BusinessRuleError('FOURNISSEUR_ARCHIVE', `Le fournisseur « ${s.name} » est archivé : choisissez un fournisseur actif ou réactivez-le.`, field ? { fieldErrors: { [field]: ['Fournisseur archivé.'] } } : undefined);
}

/**
 * Répertoire des fournisseurs par société (CDC 8.1, D-221) : garages, stations, assureurs, loueurs.
 * Nom unique par société parmi les fournisseurs actifs (nom normalisé, colonne calculée par la base) ;
 * archivage sans suppression de l'historique ; copie explicite vers une autre société ; aucun accès conducteur.
 */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(ctx: RequestContext, query: SuppliersQueryDto): Promise<Page<SupplierViewDto>> {
    this.access.requireStaff(ctx);
    const where: Prisma.SupplierWhereInput = {
      AND: [
        this.access.companyWhere(ctx, query.companyId),
        query.category ? { category: query.category } : {},
        { status: query.status ?? 'ACTIF' },
        query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { contactName: { contains: query.q, mode: 'insensitive' } }] } : {},
      ],
    };
    const [items, total] = await Promise.all([
      this.prisma.client.supplier.findMany({ where, ...skipTake(query), orderBy: [{ name: 'asc' }] }),
      this.prisma.client.supplier.count({ where }),
    ]);
    return pageOf(items.map(view), total, query);
  }

  async get(ctx: RequestContext, id: string): Promise<SupplierViewDto> {
    return view(await this.load(ctx, id));
  }

  async create(ctx: RequestContext, dto: CreateSupplierDto): Promise<SupplierViewDto> {
    this.access.assertCompanyReadable(ctx, dto.companyId);
    this.access.requireOperational(ctx, dto.companyId);
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const created = await tx.supplier.create({
          data: {
            organizationId: ctx.organizationId,
            companyId: dto.companyId,
            name: dto.name.trim(),
            category: dto.category,
            contactName: dto.contactName?.trim() || null,
            phone: dto.phone?.trim() || null,
            email: dto.email?.trim().toLowerCase() || null,
            address: dto.address?.trim() || null,
            notes: dto.notes?.trim() || null,
            createdById: ctx.userId,
          },
        });
        await this.audit.record(ctx, { action: 'fournisseur.creation', objectType: 'Supplier', objectId: created.id, companyId: dto.companyId, after: view(created) }, tx);
        return view(created);
      });
    } catch (error) {
      if (isDuplicateName(error)) throw duplicateName();
      throw error;
    }
  }

  async update(ctx: RequestContext, id: string, dto: UpdateSupplierDto): Promise<SupplierViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireOperational(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'fournisseur');
    const clean = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const updated = await tx.supplier.update({
          where: { id, version: dto.expectedVersion },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.category !== undefined ? { category: dto.category } : {}),
            contactName: clean(dto.contactName),
            phone: clean(dto.phone),
            email: dto.email === undefined ? undefined : dto.email?.trim().toLowerCase() || null,
            address: clean(dto.address),
            notes: clean(dto.notes),
            version: { increment: 1 },
          },
        });
        await this.audit.record(ctx, { action: 'fournisseur.modification', objectType: 'Supplier', objectId: id, companyId: current.companyId, before: view(current), after: view(updated) }, tx);
        return view(updated);
      });
    } catch (error) {
      if (isDuplicateName(error)) throw duplicateName();
      throw error;
    }
  }

  async archive(ctx: RequestContext, id: string, dto: SupplierStatusDto): Promise<SupplierViewDto> {
    return this.setStatus(ctx, id, dto, 'ARCHIVE');
  }

  async restore(ctx: RequestContext, id: string, dto: SupplierStatusDto): Promise<SupplierViewDto> {
    return this.setStatus(ctx, id, dto, 'ACTIF');
  }

  private async setStatus(ctx: RequestContext, id: string, dto: SupplierStatusDto, status: 'ACTIF' | 'ARCHIVE'): Promise<SupplierViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireManager(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'fournisseur');
    if (current.status === status) throw new ConflictError('ETAT_INVALIDE', status === 'ARCHIVE' ? 'Fournisseur déjà archivé.' : 'Fournisseur déjà actif.');
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const updated = await tx.supplier.update({ where: { id, version: dto.expectedVersion }, data: { status, archivedAt: status === 'ARCHIVE' ? this.clock.now() : null, version: { increment: 1 } } });
        await this.audit.record(ctx, { action: status === 'ARCHIVE' ? 'fournisseur.archivage' : 'fournisseur.reactivation', objectType: 'Supplier', objectId: id, companyId: current.companyId }, tx);
        return view(updated);
      });
    } catch (error) {
      // Réactivation : un autre fournisseur actif porte entre-temps le même nom normalisé.
      if (isDuplicateName(error)) throw duplicateName();
      throw error;
    }
  }

  /**
   * « Copier vers une autre société » (D-221) : nouvel enregistrement dans la société cible avec la fiche
   * du répertoire (nom, catégorie, contact, coordonnées, notes), sans historique ni montants — aucune
   * dépense, intervention ou plein n'est rattaché à la copie. Chef de parc des deux sociétés ou administrateur.
   */
  async copy(ctx: RequestContext, id: string, dto: CopySupplierDto): Promise<SupplierViewDto> {
    const source = await this.load(ctx, id);
    this.access.requireManager(ctx, source.companyId);
    if (dto.companyId === source.companyId) {
      throw new BusinessRuleError('MEME_SOCIETE', 'Choisissez une société différente de celle du fournisseur.', { fieldErrors: { companyId: ['Société identique à celle du fournisseur.'] } });
    }
    this.access.requireManager(ctx, dto.companyId);
    const target = await this.prisma.client.company.findFirst({ where: { id: dto.companyId, organizationId: ctx.organizationId }, select: { id: true, status: true } });
    if (!target) throw new NotFoundOrOutOfScopeError('Société');
    if (target.status !== 'ACTIF') throw new BusinessRuleError('SOCIETE_ARCHIVEE', 'La société de destination est archivée.', { fieldErrors: { companyId: ['Société archivée.'] } });
    if (source.status !== 'ACTIF') throw archivedSupplier(source, null);
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const created = await tx.supplier.create({
          data: {
            organizationId: ctx.organizationId,
            companyId: target.id,
            name: source.name,
            category: source.category,
            contactName: source.contactName,
            phone: source.phone,
            email: source.email,
            address: source.address,
            notes: source.notes,
            createdById: ctx.userId,
          },
        });
        await this.audit.record(ctx, { action: 'fournisseur.copie', objectType: 'Supplier', objectId: created.id, companyId: target.id, after: { ...view(created), copiedFromSupplierId: source.id, copiedFromCompanyId: source.companyId } }, tx);
        return view(created);
      });
    } catch (error) {
      if (isDuplicateName(error)) throw duplicateName('société de destination');
      throw error;
    }
  }

  /**
   * Fournisseur utilisable dans un nouveau formulaire (interventions, pleins, dépenses, immobilisations) :
   * de la société indiquée et dans le périmètre (sinon 404), et ACTIF — un fournisseur archivé reste
   * affiché dans l'historique mais est refusé ici par 422 FOURNISSEUR_ARCHIVE (D-221).
   */
  async requireUsable(ctx: RequestContext, id: string, companyId: string, field = 'supplierId'): Promise<Supplier> {
    const s = await this.prisma.client.supplier.findFirst({ where: { id, organizationId: ctx.organizationId, companyId } });
    if (!s || !this.access.canReadCompany(ctx, s.companyId)) throw new NotFoundOrOutOfScopeError('Fournisseur');
    if (s.status !== 'ACTIF') throw archivedSupplier(s, field);
    return s;
  }

  private async load(ctx: RequestContext, id: string): Promise<Supplier> {
    this.access.requireStaff(ctx);
    const s = await this.prisma.client.supplier.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!s || !this.access.canReadCompany(ctx, s.companyId)) throw new NotFoundOrOutOfScopeError('Fournisseur');
    return s;
  }
}

function view(s: Supplier): SupplierViewDto {
  return {
    id: s.id,
    companyId: s.companyId,
    name: s.name,
    category: s.category,
    contactName: s.contactName,
    phone: s.phone,
    email: s.email,
    address: s.address,
    notes: s.notes,
    status: s.status,
    archivedAt: s.archivedAt?.toISOString() ?? null,
    version: s.version,
  };
}
