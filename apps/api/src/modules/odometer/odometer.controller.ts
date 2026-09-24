import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiIdempotent, IdempotencyKey } from '../../common/idempotency.decorator.js';
import { ApiPageResponse, type Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { BatchReadingsDto, BatchResultItemDto, CorrectReadingDto, CreateReadingDto, CurrentOdometerDto, DecideReadingDto, IngestResultDto, InitSegmentDto, ReadingViewDto, ReadingsQueryDto, SegmentViewDto } from './dto/odometer.dto.js';
import { OdometerService } from './odometer.service.js';
import type { Request } from 'express';
import { Req } from '@nestjs/common';

@ApiTags('odometer')
@Controller()
export class OdometerController {
  constructor(private readonly odometer: OdometerService) {}

  @Post('vehicles/:id/readings')
  @HttpCode(201)
  @ApiIdempotent({ required: false })
  @ApiOperation({ summary: 'Crée un relevé manuel (source et auteur déterminés par le serveur ; conducteur : soumission en attente).' })
  @ApiCreatedResponse({ type: IngestResultDto })
  create(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateReadingDto, @Req() req: Request): Promise<IngestResultDto> {
    const key = req.header('idempotency-key') ?? undefined;
    return this.odometer.create(ctx, id, dto, key);
  }

  @Get('vehicles/:id/readings')
  @ApiOperation({ summary: 'Historique des relevés du véhicule (tous statuts), même filtre de périmètre et même tri (order) que GET /readings.' })
  @ApiPageResponse(ReadingViewDto)
  listForVehicle(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: ReadingsQueryDto): Promise<Page<ReadingViewDto>> {
    return this.odometer.listForVehicle(ctx, id, query);
  }

  @Get('vehicles/:id/odometer')
  @ApiOperation({ summary: 'Compteur courant : dernier relevé accepté selon la date d’observation, fraîcheur et aide télématique.' })
  @ApiOkResponse({ type: CurrentOdometerDto })
  current(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<CurrentOdometerDto> {
    return this.odometer.current(ctx, id);
  }

  @Get('vehicles/:id/odometer-segments')
  @ApiOperation({ summary: 'Segments de compteur du véhicule (initialisations et remplacements), dans l’ordre.' })
  @ApiOkResponse({ type: [SegmentViewDto] })
  segments(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<SegmentViewDto[]> {
    return this.odometer.segments(ctx, id);
  }

  @Post('vehicles/:id/odometer-segments')
  @HttpCode(201)
  @ApiOperation({ summary: 'Initialisation explicite du compteur (chef, administrateur : base cumulée différente ou cumul incomplet) ou remplacement autorisé (readings.correct, justificatif obligatoire).' })
  @ApiCreatedResponse({ type: SegmentViewDto })
  initSegment(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: InitSegmentDto): Promise<SegmentViewDto> {
    return this.odometer.initSegment(ctx, id, dto);
  }

  @Get('readings')
  @ApiOperation({ summary: 'Relevés du périmètre (file de validation) ; conducteur : ses propres soumissions ; mine=true : relevés dont l’utilisateur est l’auteur.' })
  @ApiPageResponse(ReadingViewDto)
  list(@Ctx() ctx: RequestContext, @Query() query: ReadingsQueryDto): Promise<Page<ReadingViewDto>> {
    return this.odometer.list(ctx, query);
  }

  @Post('readings/batch')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({ summary: 'Saisie rapide par parc (D-265) : clé d’idempotence du lot obligatoire ; chaque ligne est traitée indépendamment sous la clé « <cléLot>:<vehicleId> ».' })
  @ApiOkResponse({ type: [BatchResultItemDto] })
  batch(@Ctx() ctx: RequestContext, @Body() dto: BatchReadingsDto, @IdempotencyKey() key: string): Promise<BatchResultItemDto[]> {
    return this.odometer.batch(ctx, dto, key);
  }

  @Post('readings/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Valide un relevé en attente (permission readings.approve, expectedVersion).' })
  @ApiOkResponse({ type: ReadingViewDto })
  approve(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideReadingDto): Promise<ReadingViewDto> {
    return this.odometer.approve(ctx, id, dto);
  }

  @Post('readings/:id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rejette un relevé en attente avec motif (permission readings.approve, expectedVersion).' })
  @ApiOkResponse({ type: ReadingViewDto })
  reject(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideReadingDto): Promise<ReadingViewDto> {
    return this.odometer.reject(ctx, id, dto);
  }

  @Post('readings/:id/correct')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({ summary: 'Correction motivée : original conservé (REMPLACE), remplacement créé, dépendances recalculées.' })
  @ApiOkResponse({ type: ReadingViewDto })
  correct(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CorrectReadingDto, @IdempotencyKey() key: string): Promise<ReadingViewDto> {
    return this.odometer.correct(ctx, id, dto, key);
  }
}
