import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiPageResponse, type Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { CreateReservationDto, PlanningQueryDto, PlanningResponseDto, ReservationDecisionDto, ReservationViewDto, ReservationsQueryDto, UpdateReservationDto } from './dto/reservations.dto.js';
import { ReservationsService } from './reservations.service.js';

@ApiTags('reservations')
@Controller()
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Get('reservations')
  @ApiOperation({ summary: 'Réservations filtrées (calendrier) ; conducteur : les siennes.' })
  @ApiPageResponse(ReservationViewDto)
  list(@Ctx() ctx: RequestContext, @Query() query: ReservationsQueryDto): Promise<Page<ReservationViewDto>> {
    return this.reservations.list(ctx, query);
  }

  @Get('reservations/:id')
  @ApiOperation({ summary: 'Détail d’une réservation du périmètre (conducteur : les siennes).' })
  @ApiOkResponse({ type: ReservationViewDto })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<ReservationViewDto> {
    return this.reservations.get(ctx, id);
  }

  @Post('reservations')
  @HttpCode(201)
  @ApiOperation({ summary: 'Confirme une réservation [début, fin[ (chevauchements refusés en base).' })
  @ApiCreatedResponse({ type: ReservationViewDto })
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateReservationDto): Promise<ReservationViewDto> {
    return this.reservations.create(ctx, dto);
  }

  @Patch('reservations/:id')
  @ApiOperation({ summary: 'Modifie une réservation confirmée (motif, expectedVersion) : véhicule, conducteur, créneau et informations avant le début prévu ; seulement la fin ensuite.' })
  @ApiOkResponse({ type: ReservationViewDto })
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReservationDto): Promise<ReservationViewDto> {
    return this.reservations.update(ctx, id, dto);
  }

  @Post('reservations/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Annule une réservation confirmée (motif, expectedVersion).' })
  @ApiOkResponse({ type: ReservationViewDto })
  cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReservationDecisionDto): Promise<ReservationViewDto> {
    return this.reservations.cancel(ctx, id, dto.reason, dto.expectedVersion);
  }

  @Post('reservations/:id/no-show')
  @HttpCode(200)
  @ApiOperation({ summary: 'Constate la non-présentation (motif, expectedVersion) à partir du début prévu + reservations.noShowGraceMinutes.' })
  @ApiOkResponse({ type: ReservationViewDto })
  noShow(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReservationDecisionDto): Promise<ReservationViewDto> {
    return this.reservations.markNoShow(ctx, id, dto.reason, dto.expectedVersion);
  }

  @Get('planning')
  @ApiOperation({ summary: 'Planning : réservations, utilisations, immobilisations et interventions planifiées ou en cours sur une fenêtre (93 jours max), avec avertissements de chevauchement intervention / réservation (D-205).' })
  @ApiOkResponse({ type: PlanningResponseDto })
  planning(@Ctx() ctx: RequestContext, @Query() query: PlanningQueryDto): Promise<PlanningResponseDto> {
    return this.reservations.planning(ctx, query);
  }
}
