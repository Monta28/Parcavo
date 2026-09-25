import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { ApiPageResponse, type Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { DriversService } from './drivers.service.js';
import { CreateDriverDto, DeactivateDriverDto, DriverSummaryDto, DriverViewDto, DriversQueryDto, PermitViewDto, ReactivateDriverDto, UpdateDriverDto, UpsertPermitDto } from './dto/drivers.dto.js';

class SummariesQueryDto {
  @ApiProperty({ type: String, format: 'uuid' }) @IsUUID() companyId!: string;
}

@ApiTags('drivers')
@Controller('drivers')
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Get()
  @ApiOperation({ summary: 'Conducteurs du périmètre (personnel de gestion).' })
  @ApiPageResponse(DriverViewDto)
  list(@Ctx() ctx: RequestContext, @Query() query: DriversQueryDto): Promise<Page<DriverViewDto>> {
    return this.drivers.list(ctx, query);
  }

  @Get('summaries')
  @ApiOperation({ summary: 'Liste réduite des conducteurs actifs d’une société (formulaires de remise et de réservation).' })
  @ApiOkResponse({ type: [DriverSummaryDto] })
  summaries(@Ctx() ctx: RequestContext, @Query() query: SummariesQueryDto): Promise<DriverSummaryDto[]> {
    return this.drivers.summaries(ctx, query.companyId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fiche conducteur (personnel : périmètre ; conducteur : sa propre fiche).' })
  @ApiOkResponse({ type: DriverViewDto })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<DriverViewDto> {
    return this.drivers.get(ctx, id);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Crée un conducteur (opérateur, chef de parc ou administrateur de la société).' })
  @ApiCreatedResponse({ type: DriverViewDto })
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateDriverDto): Promise<DriverViewDto> {
    return this.drivers.create(ctx, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Modifie un conducteur (expectedVersion, audité).' })
  @ApiOkResponse({ type: DriverViewDto })
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDriverDto): Promise<DriverViewDto> {
    return this.drivers.update(ctx, id, dto);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Désactive un conducteur (chef de parc, motif) ; refusé avec une utilisation en cours, 409 si des réservations futures ne sont pas annulées.' })
  @ApiOkResponse({ type: DriverViewDto })
  deactivate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeactivateDriverDto): Promise<DriverViewDto> {
    return this.drivers.deactivate(ctx, id, dto.reason, dto.expectedVersion, dto.cancelFutureReservations ?? false);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Réactive un conducteur désactivé (chef de parc, expectedVersion).' })
  @ApiOkResponse({ type: DriverViewDto })
  reactivate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReactivateDriverDto): Promise<DriverViewDto> {
    return this.drivers.reactivate(ctx, id, dto.expectedVersion);
  }

  @Put(':id/permit')
  @ApiOperation({ summary: 'Crée ou met à jour les informations de permis du conducteur.' })
  @ApiOkResponse({ type: PermitViewDto })
  upsertPermit(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpsertPermitDto): Promise<PermitViewDto> {
    return this.drivers.upsertPermit(ctx, id, dto);
  }
}
