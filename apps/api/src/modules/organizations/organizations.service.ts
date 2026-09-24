import { Injectable } from '@nestjs/common';
import type { Company, Department, Prisma, Site, VehicleCategory } from '@parc-auto/db';
import { BusinessRuleError, ConflictError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, resolveSort, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isUniqueViolation } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { Clock } from '../../common/clock.js';
import type {
  CompaniesQueryDto,
  CompanyViewDto,
  CreateCompanyDto,
  CreateDepartmentDto,
  CreateSiteDto,
  CreateVehicleCategoryDto,
  DepartmentViewDto,
  OrganizationViewDto,
  SiteViewDto,
  SitesQueryDto,
  UpdateCompanyDto,
  UpdateDepartmentDto,
  UpdateOrganizationDto,
  UpdateSiteDto,
  UpdateVehicleCategoryDto,
  VehicleCategoryViewDto,
} from './dto/organizations.dto.js';

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Organisation, sociétés, sites, services et catégories de véhicules (CDC 2.1, 3.3). */
@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ----- Organisation -------------------------------------------------------

  async getOrganization(ctx: RequestContext): Promise<OrganizationViewDto> {
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
    return { id: org.id, code: org.code, name: org.name, timezone: org.timezone, currency: org.currency, currencyDecimals: org.currencyDecimals, version: org.version };
  }

  async updateOrganization(ctx: RequestContext, dto: UpdateOrganizationDto): Promise<OrganizationViewDto> {
    this.access.requireAdmin(ctx);
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
    assertExpectedVersion(org, dto.expectedVersion, 'organisation');
    if (dto.timezone !== undefined && !isValidTimezone(dto.timezone)) {
      throw new BusinessRuleError('FUSEAU_INVALIDE', 'Fuseau horaire inconnu.', { fieldErrors: { timezone: ['Fuseau horaire inconnu.'] } });
    }
    await this.prisma.client.$transaction(async (tx) => {
      await tx.organization.update({ where: { id: org.id, version: dto.expectedVersion }, data: { ...(dto.name !== undefined ? { name: dto.name } : {}), ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}), version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'organisation.modification', objectType: 'Organization', objectId: org.id, before: { name: org.name, timezone: org.timezone }, after: { name: dto.name ?? org.name, timezone: dto.timezone ?? org.timezone } }, tx);
    });
    return this.getOrganization(ctx);
  }

  // ----- Sociétés ------------------------------------------------------------

  async listCompanies(ctx: RequestContext, query: CompaniesQueryDto): Promise<Page<CompanyViewDto>> {
    const where: Prisma.CompanyWhereInput = {
      organizationId: ctx.organizationId,
      ...(ctx.isAdmin ? {} : { id: { in: [...ctx.visibleCompanyIds] } }),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { OR: [{ code: { contains: query.q, mode: 'insensitive' } }, { legalName: { contains: query.q, mode: 'insensitive' } }] } : {}),
    };
    const sort = resolveSort(query.sort, ['code', 'legalName', 'createdAt'] as const, 'code');
    const [items, total] = await Promise.all([
      this.prisma.client.company.findMany({ where, ...skipTake(query), orderBy: { [sort]: query.order } }),
      this.prisma.client.company.count({ where }),
    ]);
    return pageOf(items.map(companyView), total, query);
  }

  async getCompany(ctx: RequestContext, id: string): Promise<CompanyViewDto> {
    this.access.assertCompanyReadable(ctx, id);
    const c = await this.prisma.client.company.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!c) throw new NotFoundOrOutOfScopeError('Société');
    return companyView(c);
  }

  async createCompany(ctx: RequestContext, dto: CreateCompanyDto): Promise<CompanyViewDto> {
    this.access.requireAdmin(ctx);
    try {
      const created = await this.prisma.client.$transaction(async (tx) => {
        const c = await tx.company.create({
          data: { organizationId: ctx.organizationId, code: dto.code, legalName: dto.legalName.trim(), address: dto.address ?? null, phone: dto.phone ?? null, email: dto.email ?? null, taxIdentifier: dto.taxIdentifier ?? null, createdById: ctx.userId },
        });
        await this.audit.record(ctx, { action: 'societe.creation', objectType: 'Company', objectId: c.id, companyId: c.id, after: companyView(c) }, tx);
        return c;
      });
      return companyView(created);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('CODE_SOCIETE_EXISTANT', 'Ce code de société existe déjà.');
      throw error;
    }
  }

  async updateCompany(ctx: RequestContext, id: string, dto: UpdateCompanyDto): Promise<CompanyViewDto> {
    this.access.requireAdmin(ctx);
    const current = await this.prisma.client.company.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!current) throw new NotFoundOrOutOfScopeError('Société');
    assertExpectedVersion(current, dto.expectedVersion, 'société');
    if (dto.logoAttachmentId) {
      const att = await this.prisma.client.attachment.findFirst({ where: { id: dto.logoAttachmentId, organizationId: ctx.organizationId, deletedAt: null } });
      if (!att) throw new NotFoundOrOutOfScopeError('Pièce jointe');
    }
    const updated = await this.prisma.client.$transaction(async (tx) => {
      const c = await tx.company.update({
        where: { id, version: dto.expectedVersion },
        data: {
          ...(dto.legalName !== undefined ? { legalName: dto.legalName.trim() } : {}),
          ...(dto.address !== undefined ? { address: dto.address } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.email !== undefined ? { email: dto.email } : {}),
          ...(dto.taxIdentifier !== undefined ? { taxIdentifier: dto.taxIdentifier } : {}),
          ...(dto.logoAttachmentId !== undefined ? { logoAttachmentId: dto.logoAttachmentId } : {}),
          ...(dto.telemetryEnabled !== undefined ? { telemetryEnabled: dto.telemetryEnabled } : {}),
          version: { increment: 1 },
        },
      });
      if (dto.logoAttachmentId) {
        await tx.attachment.update({ where: { id: dto.logoAttachmentId }, data: { ownerType: 'SOCIETE_LOGO', ownerId: id, companyId: id, attachedAt: this.clock.now() } });
      }
      await this.audit.record(ctx, { action: 'societe.modification', objectType: 'Company', objectId: id, companyId: id, before: companyView(current), after: companyView(c) }, tx);
      return c;
    });
    return companyView(updated);
  }

  /** Archivage : refusé tant que des véhicules actifs ou des utilisations ouvertes existent. */
  async archiveCompany(ctx: RequestContext, id: string, expectedVersion: number): Promise<CompanyViewDto> {
    this.access.requireAdmin(ctx);
    const current = await this.prisma.client.company.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!current) throw new NotFoundOrOutOfScopeError('Société');
    assertExpectedVersion(current, expectedVersion, 'société');
    const [activeVehicles, openUsages] = await Promise.all([
      this.prisma.client.vehicle.count({ where: { companyId: id, lifecycleStatus: { in: ['ACTIF', 'HORS_SERVICE'] } } }),
      this.prisma.client.vehicleUsage.count({ where: { companyId: id, status: 'EN_COURS' } }),
    ]);
    if (activeVehicles > 0 || openUsages > 0) {
      throw new BusinessRuleError('SOCIETE_NON_ARCHIVABLE', 'Archivage refusé : des véhicules actifs ou des utilisations ouvertes existent encore.', { details: { activeVehicles, openUsages } });
    }
    const updated = await this.prisma.client.$transaction(async (tx) => {
      const c = await tx.company.update({ where: { id, version: expectedVersion }, data: { status: 'ARCHIVE', archivedAt: this.clock.now(), version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'societe.archivage', objectType: 'Company', objectId: id, companyId: id }, tx);
      return c;
    });
    return companyView(updated);
  }

  // ----- Sites ---------------------------------------------------------------

  async listSites(ctx: RequestContext, query: SitesQueryDto): Promise<Page<SiteViewDto>> {
    const where: Prisma.SiteWhereInput = {
      ...this.access.companyWhere(ctx, query.companyId),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.client.site.findMany({ where, ...skipTake(query), orderBy: { name: query.order } }),
      this.prisma.client.site.count({ where }),
    ]);
    return pageOf(items.map(siteView), total, query);
  }

  async createSite(ctx: RequestContext, dto: CreateSiteDto): Promise<SiteViewDto> {
    this.access.requireManager(ctx, dto.companyId);
    try {
      const s = await this.prisma.client.$transaction(async (tx) => {
        const created = await tx.site.create({ data: { organizationId: ctx.organizationId, companyId: dto.companyId, name: dto.name.trim(), address: dto.address ?? null, managerName: dto.managerName ?? null, createdById: ctx.userId } });
        await this.audit.record(ctx, { action: 'site.creation', objectType: 'Site', objectId: created.id, companyId: dto.companyId, after: siteView(created) }, tx);
        return created;
      });
      return siteView(s);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('SITE_EXISTANT', 'Un site porte déjà ce nom dans cette société.');
      throw error;
    }
  }

  async updateSite(ctx: RequestContext, id: string, dto: UpdateSiteDto): Promise<SiteViewDto> {
    const current = await this.prisma.client.site.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!current || !this.access.canReadCompany(ctx, current.companyId)) throw new NotFoundOrOutOfScopeError('Site');
    this.access.requireManager(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'site');
    try {
      const s = await this.prisma.client.$transaction(async (tx) => {
        const updated = await tx.site.update({
          where: { id, version: dto.expectedVersion },
          data: { ...(dto.name !== undefined ? { name: dto.name.trim() } : {}), ...(dto.address !== undefined ? { address: dto.address } : {}), ...(dto.managerName !== undefined ? { managerName: dto.managerName } : {}), ...(dto.status !== undefined ? { status: dto.status } : {}), version: { increment: 1 } },
        });
        await this.audit.record(ctx, { action: 'site.modification', objectType: 'Site', objectId: id, companyId: current.companyId, before: siteView(current), after: siteView(updated) }, tx);
        return updated;
      });
      return siteView(s);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('SITE_EXISTANT', 'Un site porte déjà ce nom dans cette société.');
      throw error;
    }
  }

  // ----- Services ------------------------------------------------------------

  async listDepartments(ctx: RequestContext, companyId: string | undefined): Promise<DepartmentViewDto[]> {
    const items = await this.prisma.client.department.findMany({ where: { ...this.access.companyWhere(ctx, companyId) }, orderBy: { name: 'asc' } });
    return items.map(departmentView);
  }

  async createDepartment(ctx: RequestContext, dto: CreateDepartmentDto): Promise<DepartmentViewDto> {
    this.access.requireManager(ctx, dto.companyId);
    try {
      const d = await this.prisma.client.$transaction(async (tx) => {
        const created = await tx.department.create({ data: { organizationId: ctx.organizationId, companyId: dto.companyId, name: dto.name.trim(), createdById: ctx.userId } });
        await this.audit.record(ctx, { action: 'service.creation', objectType: 'Department', objectId: created.id, companyId: dto.companyId, after: departmentView(created) }, tx);
        return created;
      });
      return departmentView(d);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('SERVICE_EXISTANT', 'Un service porte déjà ce nom dans cette société.');
      throw error;
    }
  }

  async updateDepartment(ctx: RequestContext, id: string, dto: UpdateDepartmentDto): Promise<DepartmentViewDto> {
    const current = await this.prisma.client.department.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!current || !this.access.canReadCompany(ctx, current.companyId)) throw new NotFoundOrOutOfScopeError('Service');
    this.access.requireManager(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'service');
    const d = await this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.department.update({ where: { id, version: dto.expectedVersion }, data: { ...(dto.name !== undefined ? { name: dto.name.trim() } : {}), ...(dto.status !== undefined ? { status: dto.status } : {}), version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'service.modification', objectType: 'Department', objectId: id, companyId: current.companyId, before: departmentView(current), after: departmentView(updated) }, tx);
      return updated;
    });
    return departmentView(d);
  }

  // ----- Catégories de véhicules --------------------------------------------

  async listVehicleCategories(ctx: RequestContext): Promise<VehicleCategoryViewDto[]> {
    const items = await this.prisma.client.vehicleCategory.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { code: 'asc' } });
    return items.map(categoryView);
  }

  async createVehicleCategory(ctx: RequestContext, dto: CreateVehicleCategoryDto): Promise<VehicleCategoryViewDto> {
    this.access.requireAdmin(ctx);
    try {
      const c = await this.prisma.client.$transaction(async (tx) => {
        const created = await tx.vehicleCategory.create({ data: { organizationId: ctx.organizationId, code: dto.code, label: dto.label.trim(), requiredPermitCategories: dto.requiredPermitCategories ?? [], createdById: ctx.userId } });
        await this.audit.record(ctx, { action: 'categorie_vehicule.creation', objectType: 'VehicleCategory', objectId: created.id, after: categoryView(created) }, tx);
        return created;
      });
      return categoryView(c);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('CATEGORIE_EXISTANTE', 'Ce code de catégorie existe déjà.');
      throw error;
    }
  }

  async updateVehicleCategory(ctx: RequestContext, id: string, dto: UpdateVehicleCategoryDto): Promise<VehicleCategoryViewDto> {
    this.access.requireAdmin(ctx);
    const current = await this.prisma.client.vehicleCategory.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!current) throw new NotFoundOrOutOfScopeError('Catégorie');
    assertExpectedVersion(current, dto.expectedVersion, 'catégorie');
    const c = await this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.vehicleCategory.update({ where: { id, version: dto.expectedVersion }, data: { ...(dto.label !== undefined ? { label: dto.label.trim() } : {}), ...(dto.requiredPermitCategories !== undefined ? { requiredPermitCategories: dto.requiredPermitCategories } : {}), ...(dto.status !== undefined ? { status: dto.status } : {}), version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'categorie_vehicule.modification', objectType: 'VehicleCategory', objectId: id, before: categoryView(current), after: categoryView(updated) }, tx);
      return updated;
    });
    return categoryView(c);
  }
}

export function companyView(c: Company): CompanyViewDto {
  return { id: c.id, code: c.code, legalName: c.legalName, address: c.address, phone: c.phone, email: c.email, taxIdentifier: c.taxIdentifier, logoAttachmentId: c.logoAttachmentId, status: c.status, telemetryEnabled: c.telemetryEnabled, archivedAt: c.archivedAt?.toISOString() ?? null, createdAt: c.createdAt.toISOString(), version: c.version };
}
export function siteView(s: Site): SiteViewDto {
  return { id: s.id, companyId: s.companyId, name: s.name, address: s.address, managerName: s.managerName, status: s.status, version: s.version };
}
export function departmentView(d: Department): DepartmentViewDto {
  return { id: d.id, companyId: d.companyId, name: d.name, status: d.status, version: d.version };
}
export function categoryView(c: VehicleCategory): VehicleCategoryViewDto {
  return { id: c.id, code: c.code, label: c.label, requiredPermitCategories: c.requiredPermitCategories, status: c.status, version: c.version };
}
