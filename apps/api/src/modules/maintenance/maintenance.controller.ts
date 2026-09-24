import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiIdempotent, IDEMPOTENCY_HEADER_NAME } from '../../common/idempotency.decorator.js';
import type { Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import {
  ApplyTemplateDto,
  ApplyTemplateResultDto,
  CatalogQueryDto,
  CreateMaintenanceTypeDto,
  CreatePlanDto,
  CreateTemplateDto,
  DeactivatePlanDto,
  InstallMaintenanceCatalogResultDto,
  MaintenanceCalendarDto,
  MaintenanceCalendarQueryDto,
  MaintenanceTypeViewDto,
  PlanPageDto,
  PlanViewDto,
  PlansQueryDto,
  ReactivatePlanDto,
  TemplateViewDto,
  UpdateMaintenanceTypeDto,
  UpdatePlanDto,
  UpdateTemplateDto,
} from './dto/maintenance.dto.js';
import { MaintenanceCalendarService } from './maintenance-calendar.service.js';
import { MaintenanceCatalogService } from './maintenance-catalog.service.js';
import { MaintenancePlansService } from './maintenance-plans.service.js';

@ApiTags('maintenance')
@Controller()
export class MaintenanceController {
  constructor(
    private readonly catalog: MaintenanceCatalogService,
    private readonly plans: MaintenancePlansService,
    private readonly calendar: MaintenanceCalendarService,
  ) {}

  // Catalogue ----------------------------------------------------------------

  @Get('maintenance-types')
  @ApiOperation({ summary: 'Catalogue des opérations d’entretien (6.1).' })
  @ApiOkResponse({ type: [MaintenanceTypeViewDto] })
  listTypes(@Ctx() ctx: RequestContext, @Query() query: CatalogQueryDto): Promise<MaintenanceTypeViewDto[]> {
    return this.catalog.listTypes(ctx, query);
  }

  @Post('maintenance-types')
  @HttpCode(201)
  @ApiOperation({ summary: 'Ajouter une opération au catalogue (administrateur).' })
  @ApiCreatedResponse({ type: MaintenanceTypeViewDto })
  createType(@Ctx() ctx: RequestContext, @Body() dto: CreateMaintenanceTypeDto): Promise<MaintenanceTypeViewDto> {
    return this.catalog.createType(ctx, dto);
  }

  @Post('maintenance-types/initial-catalog')
  @HttpCode(200)
  @ApiIdempotent({ required: false })
  @ApiOperation({ summary: 'Installer le catalogue initial (administrateur) : ajoute seulement les opérations absentes (même code ou même libellé : ignorée), ne modifie aucune opération existante ; rejouable sans effet, audité.' })
  @ApiOkResponse({ type: InstallMaintenanceCatalogResultDto })
  installInitialTypes(@Ctx() ctx: RequestContext, @Headers(IDEMPOTENCY_HEADER_NAME) idempotencyKey?: string): Promise<InstallMaintenanceCatalogResultDto> {
    return this.catalog.installInitialTypes(ctx, idempotencyKey);
  }

  @Patch('maintenance-types/:id')
  @ApiOperation({ summary: 'Modifier ou archiver une opération du catalogue (administrateur, expectedVersion).' })
  @ApiOkResponse({ type: MaintenanceTypeViewDto })
  updateType(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMaintenanceTypeDto): Promise<MaintenanceTypeViewDto> {
    return this.catalog.updateType(ctx, id, dto);
  }

  @Get('maintenance-templates')
  @ApiOperation({ summary: 'Modèles de plans (actifs par défaut ; includeArchived=true pour les archivés).' })
  @ApiOkResponse({ type: [TemplateViewDto] })
  listTemplates(@Ctx() ctx: RequestContext, @Query() query: CatalogQueryDto): Promise<TemplateViewDto[]> {
    return this.catalog.listTemplates(ctx, query);
  }

  @Get('maintenance-templates/:id')
  @ApiOperation({ summary: 'Détail d’un modèle de plan et de ses lignes.' })
  @ApiOkResponse({ type: TemplateViewDto })
  getTemplate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<TemplateViewDto> {
    return this.catalog.getTemplate(ctx, id);
  }

  @Post('maintenance-templates')
  @HttpCode(201)
  @ApiOperation({ summary: 'Créer un modèle de plan copiable (administrateur).' })
  @ApiCreatedResponse({ type: TemplateViewDto })
  createTemplate(@Ctx() ctx: RequestContext, @Body() dto: CreateTemplateDto): Promise<TemplateViewDto> {
    return this.catalog.createTemplate(ctx, dto);
  }

  @Patch('maintenance-templates/:id')
  @ApiOperation({ summary: 'Modifier un modèle de plan (administrateur, expectedVersion) ; les plans déjà copiés ne changent pas.' })
  @ApiOkResponse({ type: TemplateViewDto })
  updateTemplate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTemplateDto): Promise<TemplateViewDto> {
    return this.catalog.updateTemplate(ctx, id, dto);
  }

  @Post('maintenance-templates/:id/apply')
  @HttpCode(200)
  @ApiIdempotent({ required: false })
  @ApiOperation({ summary: 'Copier un modèle vers des véhicules (instantané, sans effet rétroactif) ; choix par véhicule pour les plans existants (D-198). Idempotency-Key facultative : même clé et même corps rejouent le résultat initial.' })
  @ApiOkResponse({ type: ApplyTemplateResultDto })
  applyTemplate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApplyTemplateDto, @Headers(IDEMPOTENCY_HEADER_NAME) idempotencyKey?: string): Promise<ApplyTemplateResultDto> {
    return this.catalog.applyTemplate(ctx, id, dto, idempotencyKey);
  }

  // Plans ----------------------------------------------------------------------

  @Get('maintenance-plans')
  @ApiOperation({ summary: 'Plans et échéances dans le périmètre : statut matérialisé (rafraîchi au jour local) filtré, trié et affiché ; recherche et tri.' })
  @ApiOkResponse({ type: PlanPageDto })
  list(@Ctx() ctx: RequestContext, @Query() query: PlansQueryDto): Promise<Page<PlanViewDto>> {
    return this.plans.list(ctx, query);
  }

  @Get('maintenance-calendar')
  @ApiOperation({ summary: 'Calendrier mensuel (fuseau de l’organisation) : échéances en date des plans actifs et interventions planifiées, valeurs calculées par l’API.' })
  @ApiOkResponse({ type: MaintenanceCalendarDto })
  monthCalendar(@Ctx() ctx: RequestContext, @Query() query: MaintenanceCalendarQueryDto): Promise<MaintenanceCalendarDto> {
    return this.calendar.month(ctx, query);
  }

  @Get('maintenance-plans/:id')
  @ApiOperation({ summary: 'Détail d’un plan d’entretien et de son échéance calculée.' })
  @ApiOkResponse({ type: PlanViewDto })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<PlanViewDto> {
    return this.plans.get(ctx, id);
  }

  @Post('maintenance-plans')
  @HttpCode(201)
  @ApiOperation({ summary: 'Créer un plan véhicule/opération avec sa base de calcul.' })
  @ApiCreatedResponse({ type: PlanViewDto })
  create(@Ctx() ctx: RequestContext, @Body() dto: CreatePlanDto): Promise<PlanViewDto> {
    return this.plans.create(ctx, dto);
  }

  @Patch('maintenance-plans/:id')
  @ApiOperation({ summary: 'Modifier intervalles, préavis ou base (preview=true pour prévisualiser l’impact).' })
  @ApiOkResponse({ type: PlanViewDto })
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlanDto): Promise<PlanViewDto> {
    return this.plans.update(ctx, id, dto);
  }

  @Post('maintenance-plans/:id/deactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Désactiver un plan actif (motif, audit) ; 409 si déjà désactivé.' })
  @ApiOkResponse({ type: PlanViewDto })
  deactivate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeactivatePlanDto): Promise<PlanViewDto> {
    return this.plans.deactivate(ctx, id, dto);
  }

  @Post('maintenance-plans/:id/reactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Réactiver un plan désactivé (chef de parc ou administrateur, motif, audit) ; 409 si un plan actif suit déjà cette opération.' })
  @ApiOkResponse({ type: PlanViewDto })
  reactivate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReactivatePlanDto): Promise<PlanViewDto> {
    return this.plans.reactivate(ctx, id, dto);
  }
}
