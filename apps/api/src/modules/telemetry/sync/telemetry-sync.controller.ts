import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Page } from '../../../common/pagination.js';
import { Ctx, type RequestContext } from '../../../common/request-context.js';
import { FuelEventViewDto, FuelEventsPageDto, FuelEventsQueryDto, ManualSyncDto, ManualSyncResultDto, QualifyFuelEventDto } from './dto/telemetry-sync.dto.js';
import { TelemetryFuelService } from './telemetry-fuel.service.js';
import { TelemetrySyncService } from './telemetry-sync.service.js';

/**
 * Synchronisation télématique et événements carburant (CDC 8.5, 14.4 ; D-112, D-242, D-296) :
 * synchronisation manuelle par l'administrateur ou le chef de parc des sociétés couvertes ; consultation
 * des événements carburant dans le périmètre ; qualification par le chef de parc ou l'administrateur.
 * Le conducteur n'a aucun accès. Aucune route n'accepte d'échantillon ni de relevé TELEMATICS.
 */
@ApiTags('telemetry')
@Controller('telemetry')
export class TelemetrySyncController {
  constructor(
    private readonly sync: TelemetrySyncService,
    private readonly fuel: TelemetryFuelService,
  ) {}

  @Post('providers/:id/sync')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Synchronisation manuelle (administrateur ; chef de parc pour ses sociétés couvertes et activées). Lancée en arrière-plan : réponse 202 avec l’identifiant du run, ou du run déjà en cours ; run IGNORE si le coupe-circuit est ouvert. Reprise d’historique réservée à l’administrateur.',
  })
  @ApiAcceptedResponse({ type: ManualSyncResultDto })
  requestSync(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ManualSyncDto): Promise<ManualSyncResultDto> {
    return this.sync.requestSync(ctx, id, dto);
  }

  @Get('fuel-events')
  @ApiOperation({ summary: 'Événements carburant dérivés (remplissage, baisse anormale, écart ticket) du périmètre : anomalies à qualifier, jamais des dépenses.' })
  @ApiOkResponse({ type: FuelEventsPageDto })
  listFuelEvents(@Ctx() ctx: RequestContext, @Query() query: FuelEventsQueryDto): Promise<Page<FuelEventViewDto>> {
    return this.fuel.list(ctx, query);
  }

  @Get('fuel-events/:id')
  @ApiOperation({ summary: 'Détail d’un événement carburant dérivé du périmètre (remplissage, baisse anormale, écart ticket) et de sa qualification.' })
  @ApiOkResponse({ type: FuelEventViewDto })
  getFuelEvent(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<FuelEventViewDto> {
    return this.fuel.get(ctx, id);
  }

  @Post('fuel-events/:id/qualify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Qualifier un événement carburant (chef de parc ou administrateur) : JUSTIFIE, ANOMALIE_CONFIRMEE ou ERREUR_CAPTEUR, note obligatoire, verrou optimiste. Aucune dépense ni retenue n’est créée.' })
  @ApiOkResponse({ type: FuelEventViewDto })
  qualify(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: QualifyFuelEventDto): Promise<FuelEventViewDto> {
    return this.fuel.qualify(ctx, id, dto);
  }
}
