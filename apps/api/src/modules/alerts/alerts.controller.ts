import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { AlertCenterService } from './alert-center.service.js';
import { AlertCountsDto, AlertCountsQueryDto, AlertPageDto, AlertViewDto, AlertsQueryDto, SnoozeAlertDto } from './dto/alerts.dto.js';

@ApiTags('alerts')
@Controller('alerts')
export class AlertsController {
  constructor(private readonly center: AlertCenterService) {}

  @Get()
  @ApiOperation({
    summary:
      'Centre d’alertes dans le périmètre (conducteur : 403) : ACTIVE par défaut, filtres type, gravité, société, véhicule, non lues, reportées ; tri gravité puis date ; état lu/reporté propre à l’utilisateur.',
  })
  @ApiOkResponse({ type: AlertPageDto })
  list(@Ctx() ctx: RequestContext, @Query() query: AlertsQueryDto): Promise<Page<AlertViewDto>> {
    return this.center.list(ctx, query);
  }

  @Get('counts')
  @ApiOperation({ summary: 'Compteurs des alertes actives du périmètre : par gravité, non lues et reportées par l’utilisateur.' })
  @ApiOkResponse({ type: AlertCountsDto })
  counts(@Ctx() ctx: RequestContext, @Query() query: AlertCountsQueryDto): Promise<AlertCountsDto> {
    return this.center.counts(ctx, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Détail d’une alerte (hors périmètre ou type non visible pour le rôle : introuvable).' })
  @ApiOkResponse({ type: AlertViewDto })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<AlertViewDto> {
    return this.center.get(ctx, id);
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marquer « lu » pour soi : ne résout pas l’alerte et ne modifie pas le statut métier (9.2, T20).' })
  @ApiOkResponse({ type: AlertViewDto })
  read(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<AlertViewDto> {
    return this.center.markRead(ctx, id);
  }

  @Post(':id/unread')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marquer « non lu » pour soi.' })
  @ApiOkResponse({ type: AlertViewDto })
  unread(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<AlertViewDto> {
    return this.center.markUnread(ctx, id);
  }

  @Post(':id/snooze')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reporter pour soi jusqu’à une date civile future (90 jours au plus) avec motif obligatoire : l’alerte reste ACTIVE et le retard persiste (D-252).',
  })
  @ApiOkResponse({ type: AlertViewDto })
  snooze(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SnoozeAlertDto): Promise<AlertViewDto> {
    return this.center.snooze(ctx, id, dto);
  }

  @Post(':id/unsnooze')
  @HttpCode(200)
  @ApiOperation({ summary: 'Annuler son propre report.' })
  @ApiOkResponse({ type: AlertViewDto })
  unsnooze(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<AlertViewDto> {
    return this.center.unsnooze(ctx, id);
  }
}
