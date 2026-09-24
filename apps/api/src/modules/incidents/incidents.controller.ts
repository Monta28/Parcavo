import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiIdempotent, IDEMPOTENCY_HEADER_NAME } from '../../common/idempotency.decorator.js';
import { ApiPageResponse, type Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { InterventionViewDto } from '../interventions/dto/interventions.dto.js';
import {
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
import { IncidentsService } from './incidents.service.js';

@ApiTags('incidents')
@Controller('incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  @ApiOperation({ summary: 'Incidents du périmètre (conducteur : les siens).' })
  @ApiPageResponse(IncidentViewDto)
  list(@Ctx() ctx: RequestContext, @Query() query: IncidentsQueryDto): Promise<Page<IncidentViewDto>> {
    return this.incidents.list(ctx, query);
  }

  @Get('follow-up-candidates')
  @ApiOperation({ summary: 'Responsables de suivi possibles pour une société : administrateurs, chefs de parc et opérateurs actifs (nom seulement).' })
  @ApiOkResponse({ type: [FollowUpCandidateDto] })
  followUpCandidates(@Ctx() ctx: RequestContext, @Query() query: FollowUpCandidatesQueryDto): Promise<FollowUpCandidateDto[]> {
    return this.incidents.followUpCandidates(ctx, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Détail d’un incident du périmètre (conducteur : les siens).' })
  @ApiOkResponse({ type: IncidentViewDto })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<IncidentViewDto> {
    return this.incidents.get(ctx, id);
  }

  @Post()
  @HttpCode(201)
  @ApiIdempotent({ required: false })
  @ApiOperation({ summary: 'Déclarer un incident (le conducteur déclare sur son utilisation). En-tête Idempotency-Key facultatif : même clé et même corps rejouent la déclaration initiale, corps différent : 409.' })
  @ApiCreatedResponse({ type: IncidentViewDto })
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateIncidentDto, @Headers(IDEMPOTENCY_HEADER_NAME) idempotencyKey?: string): Promise<IncidentViewDto> {
    return this.incidents.create(ctx, dto, idempotencyKey);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Modifier le dossier d’un incident non clôturé (personnel, expectedVersion ; gravité : chef ou administrateur).' })
  @ApiOkResponse({ type: IncidentViewDto })
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateIncidentDto): Promise<IncidentViewDto> {
    return this.incidents.update(ctx, id, dto);
  }

  @Post(':id/transition')
  @HttpCode(200)
  @ApiOperation({ summary: 'Transition de traitement (résolution technique, clôture administrative, réouverture).' })
  @ApiOkResponse({ type: IncidentViewDto })
  transition(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionIncidentDto): Promise<IncidentViewDto> {
    return this.incidents.transition(ctx, id, dto);
  }

  @Get(':id/comments')
  @ApiOperation({ summary: 'Commentaires de l’incident (conducteur : commentaires partagés seulement).' })
  @ApiOkResponse({ type: [IncidentCommentViewDto] })
  comments(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<IncidentCommentViewDto[]> {
    return this.incidents.comments(ctx, id);
  }

  @Post(':id/comments')
  @HttpCode(201)
  @ApiOperation({ summary: 'Ajouter un commentaire (interne ou partagé ; le conducteur partage toujours) ; refusé sur un incident clôturé.' })
  @ApiCreatedResponse({ type: IncidentCommentViewDto })
  addComment(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateCommentDto): Promise<IncidentCommentViewDto> {
    return this.incidents.addComment(ctx, id, dto);
  }

  @Post(':id/intervention')
  @HttpCode(201)
  @ApiOperation({ summary: 'Ouvrir une intervention depuis l’incident.' })
  @ApiCreatedResponse({ type: InterventionViewDto })
  openIntervention(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: IncidentInterventionDto): Promise<InterventionViewDto> {
    return this.incidents.openIntervention(ctx, id, dto);
  }

  @Post(':id/immobilize')
  @HttpCode(200)
  @ApiOperation({ summary: 'Immobiliser le véhicule pour cet incident (cause INCIDENT) : renvoie l’immobilisation créée ou complétée.' })
  @ApiOkResponse({ type: IncidentImmobilizeResultDto })
  immobilize(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: IncidentImmobilizeDto): Promise<IncidentImmobilizeResultDto> {
    return this.incidents.immobilize(ctx, id, dto);
  }
}
