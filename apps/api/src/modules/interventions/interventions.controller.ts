import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiIdempotent, IdempotencyKey } from '../../common/idempotency.decorator.js';
import { ApiPageResponse, type Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import {
  CompleteInterventionDto,
  CreateInterventionDto,
  InterventionViewDto,
  InterventionsQueryDto,
  PlanInterventionDto,
  ReasonDto,
  RecordCostDto,
  StartInterventionDto,
  UpdateInterventionDto,
} from './dto/interventions.dto.js';
import { InterventionsService } from './interventions.service.js';

@ApiTags('interventions')
@Controller('interventions')
export class InterventionsController {
  constructor(private readonly interventions: InterventionsService) {}

  @Get()
  @ApiOperation({ summary: 'Interventions dans le périmètre : filtres (véhicule, fournisseur, statut, période en dates civiles du fuseau de l’organisation), tri sur liste autorisée.' })
  @ApiPageResponse(InterventionViewDto)
  list(@Ctx() ctx: RequestContext, @Query() query: InterventionsQueryDto): Promise<Page<InterventionViewDto>> {
    return this.interventions.list(ctx, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Détail d’une intervention : tâches, lignes de coût, pièces jointes et dépense liée.' })
  @ApiOkResponse({ type: InterventionViewDto })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<InterventionViewDto> {
    return this.interventions.get(ctx, id);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Créer une intervention (brouillon, ou planifiée si une date prévue est fournie).' })
  @ApiCreatedResponse({ type: InterventionViewDto })
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateInterventionDto): Promise<InterventionViewDto> {
    return this.interventions.create(ctx, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Modifier une intervention ouverte, sans changer son statut (« Planifier » passe par :id/plan ; le début prévu d’une intervention planifiée ne peut pas être effacé).' })
  @ApiOkResponse({ type: InterventionViewDto })
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateInterventionDto): Promise<InterventionViewDto> {
    return this.interventions.update(ctx, id, dto);
  }

  @Post(':id/plan')
  @HttpCode(200)
  @ApiOperation({ summary: 'Planifier ou replanifier une intervention en brouillon ou planifiée (dates prévues, expectedVersion, audit).' })
  @ApiOkResponse({ type: InterventionViewDto })
  plan(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PlanInterventionDto): Promise<InterventionViewDto> {
    return this.interventions.plan(ctx, id, dto);
  }

  @Post(':id/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Démarrer (immobilisation explicite facultative).' })
  @ApiOkResponse({ type: InterventionViewDto })
  start(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StartInterventionDto): Promise<InterventionViewDto> {
    return this.interventions.start(ctx, id, dto);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({ summary: 'Clôturer (CompleteIntervention, 15.3) : transactionnel, idempotent, versionné.' })
  @ApiOkResponse({ type: InterventionViewDto })
  complete(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CompleteInterventionDto, @IdempotencyKey() key: string): Promise<InterventionViewDto> {
    return this.interventions.complete(ctx, id, dto, key);
  }

  @Post(':id/cost')
  @HttpCode(200)
  @ApiOperation({ summary: 'Saisir le coût d’une intervention terminée (crée l’unique dépense liée ; facture refusée sur un total nul).' })
  @ApiOkResponse({ type: InterventionViewDto })
  cost(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordCostDto): Promise<InterventionViewDto> {
    return this.interventions.recordCost(ctx, id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Annuler une intervention ouverte (motif, expectedVersion) ; met fin par défaut à la cause d’immobilisation liée.' })
  @ApiOkResponse({ type: InterventionViewDto })
  cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto): Promise<InterventionViewDto> {
    return this.interventions.cancel(ctx, id, dto);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rouvrir une intervention terminée (chef ou administrateur, motif, audit) : dépense, lignes de coût et total annulés ensemble.' })
  @ApiOkResponse({ type: InterventionViewDto })
  reopen(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto): Promise<InterventionViewDto> {
    return this.interventions.reopen(ctx, id, dto);
  }
}
