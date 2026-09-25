import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { TimelinePageDto, TimelineQueryDto, type TimelineEventDto } from './dto/timeline.dto.js';
import { VehicleTimelineService } from './vehicle-timeline.service.js';

/** Onglet Historique du dossier véhicule (CDC 3.1, 15.2 « timeline » ; D-109, D-275). */
@ApiTags('vehicles')
@Controller('vehicles')
export class VehicleTimelineController {
  constructor(private readonly timeline: VehicleTimelineService) {}

  @Get(':id/timeline')
  @ApiOperation({
    summary:
      'Chronologie métier du véhicule, paginée : dossier, sociétés, utilisations, relevés, compteur, entretien, documents, incidents, immobilisations, réservations et affectations visibles du lecteur.',
  })
  @ApiOkResponse({ type: TimelinePageDto })
  @ApiNotFoundResponse({ description: 'Véhicule introuvable ou hors périmètre.' })
  get(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: TimelineQueryDto,
  ): Promise<Page<TimelineEventDto>> {
    return this.timeline.timeline(ctx, id, query);
  }
}
