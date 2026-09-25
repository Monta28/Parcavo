import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';
import { ApiPageResponse, type Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import {
  CompaniesQueryDto, CompanyViewDto, CreateCompanyDto, CreateDepartmentDto, CreateSiteDto, CreateVehicleCategoryDto, DepartmentViewDto,
  OrganizationViewDto, SiteViewDto, SitesQueryDto, UpdateCompanyDto, UpdateDepartmentDto, UpdateOrganizationDto, UpdateSiteDto, UpdateVehicleCategoryDto, VehicleCategoryViewDto,
} from './dto/organizations.dto.js';
import { OrganizationsService } from './organizations.service.js';

class ExpectedVersionDto {
  @ApiProperty({ type: Number, minimum: 1, description: 'Version connue de la société (verrou optimiste).' }) @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}
class CompanyFilterDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' }) @IsOptional() @IsUUID() companyId?: string;
}

@ApiTags('organizations')
@Controller()
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Get('organization')
  @ApiOperation({ summary: 'Organisation de l’utilisateur : code, nom, fuseau horaire et devise.' })
  @ApiOkResponse({ type: OrganizationViewDto })
  getOrganization(@Ctx() ctx: RequestContext): Promise<OrganizationViewDto> {
    return this.orgs.getOrganization(ctx);
  }

  @Patch('organization')
  @ApiOperation({ summary: 'Modifie l’organisation (administrateur, expectedVersion, audité).' })
  @ApiOkResponse({ type: OrganizationViewDto })
  updateOrganization(@Ctx() ctx: RequestContext, @Body() dto: UpdateOrganizationDto): Promise<OrganizationViewDto> {
    return this.orgs.updateOrganization(ctx, dto);
  }

  @Get('companies')
  @ApiOperation({ summary: 'Sociétés visibles selon les habilitations.' })
  @ApiPageResponse(CompanyViewDto)
  listCompanies(@Ctx() ctx: RequestContext, @Query() query: CompaniesQueryDto): Promise<Page<CompanyViewDto>> {
    return this.orgs.listCompanies(ctx, query);
  }

  @Get('companies/:id')
  @ApiOperation({ summary: 'Détail d’une société du périmètre.' })
  @ApiOkResponse({ type: CompanyViewDto })
  getCompany(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<CompanyViewDto> {
    return this.orgs.getCompany(ctx, id);
  }

  @Post('companies')
  @HttpCode(201)
  @ApiOperation({ summary: 'Crée une société (administrateur, audité).' })
  @ApiCreatedResponse({ type: CompanyViewDto })
  createCompany(@Ctx() ctx: RequestContext, @Body() dto: CreateCompanyDto): Promise<CompanyViewDto> {
    return this.orgs.createCompany(ctx, dto);
  }

  @Patch('companies/:id')
  @ApiOperation({ summary: 'Modifie une société (administrateur, expectedVersion, audité).' })
  @ApiOkResponse({ type: CompanyViewDto })
  updateCompany(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCompanyDto): Promise<CompanyViewDto> {
    return this.orgs.updateCompany(ctx, id, dto);
  }

  @Post('companies/:id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archive une société (administrateur) ; refusé tant que des véhicules actifs ou des utilisations ouvertes existent.' })
  @ApiOkResponse({ type: CompanyViewDto })
  archiveCompany(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExpectedVersionDto): Promise<CompanyViewDto> {
    return this.orgs.archiveCompany(ctx, id, dto.expectedVersion);
  }

  @Get('sites')
  @ApiOperation({ summary: 'Sites des sociétés du périmètre (filtres société, statut, recherche).' })
  @ApiPageResponse(SiteViewDto)
  listSites(@Ctx() ctx: RequestContext, @Query() query: SitesQueryDto): Promise<Page<SiteViewDto>> {
    return this.orgs.listSites(ctx, query);
  }

  @Post('sites')
  @HttpCode(201)
  @ApiOperation({ summary: 'Crée un site (gestionnaire de la société, audité).' })
  @ApiCreatedResponse({ type: SiteViewDto })
  createSite(@Ctx() ctx: RequestContext, @Body() dto: CreateSiteDto): Promise<SiteViewDto> {
    return this.orgs.createSite(ctx, dto);
  }

  @Patch('sites/:id')
  @ApiOperation({ summary: 'Modifie un site (gestionnaire de la société, expectedVersion, audité).' })
  @ApiOkResponse({ type: SiteViewDto })
  updateSite(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSiteDto): Promise<SiteViewDto> {
    return this.orgs.updateSite(ctx, id, dto);
  }

  @Get('departments')
  @ApiOperation({ summary: 'Services (départements) des sociétés du périmètre.' })
  @ApiOkResponse({ type: [DepartmentViewDto] })
  listDepartments(@Ctx() ctx: RequestContext, @Query() query: CompanyFilterDto): Promise<DepartmentViewDto[]> {
    return this.orgs.listDepartments(ctx, query.companyId);
  }

  @Post('departments')
  @HttpCode(201)
  @ApiOperation({ summary: 'Crée un service (gestionnaire de la société, audité).' })
  @ApiCreatedResponse({ type: DepartmentViewDto })
  createDepartment(@Ctx() ctx: RequestContext, @Body() dto: CreateDepartmentDto): Promise<DepartmentViewDto> {
    return this.orgs.createDepartment(ctx, dto);
  }

  @Patch('departments/:id')
  @ApiOperation({ summary: 'Modifie un service (gestionnaire de la société, expectedVersion, audité).' })
  @ApiOkResponse({ type: DepartmentViewDto })
  updateDepartment(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDepartmentDto): Promise<DepartmentViewDto> {
    return this.orgs.updateDepartment(ctx, id, dto);
  }

  @Get('vehicle-categories')
  @ApiOperation({ summary: 'Catégories de véhicules de l’organisation.' })
  @ApiOkResponse({ type: [VehicleCategoryViewDto] })
  listVehicleCategories(@Ctx() ctx: RequestContext): Promise<VehicleCategoryViewDto[]> {
    return this.orgs.listVehicleCategories(ctx);
  }

  @Post('vehicle-categories')
  @HttpCode(201)
  @ApiOperation({ summary: 'Crée une catégorie de véhicules (administrateur, audité).' })
  @ApiCreatedResponse({ type: VehicleCategoryViewDto })
  createVehicleCategory(@Ctx() ctx: RequestContext, @Body() dto: CreateVehicleCategoryDto): Promise<VehicleCategoryViewDto> {
    return this.orgs.createVehicleCategory(ctx, dto);
  }

  @Patch('vehicle-categories/:id')
  @ApiOperation({ summary: 'Modifie une catégorie de véhicules (administrateur, expectedVersion, audité).' })
  @ApiOkResponse({ type: VehicleCategoryViewDto })
  updateVehicleCategory(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVehicleCategoryDto): Promise<VehicleCategoryViewDto> {
    return this.orgs.updateVehicleCategory(ctx, id, dto);
  }
}
