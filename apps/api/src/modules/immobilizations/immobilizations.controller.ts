import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiPageResponse, type Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { AddCauseDto, CreateImmobilizationDto, EndCauseDto, ImmobilizationViewDto, ImmobilizationsQueryDto, UpdateImmobilizationDto } from './dto/immobilizations.dto.js';
import { ImmobilizationsService } from './immobilizations.service.js';

@ApiTags('immobilizations')
@Controller('immobilizations')
export class ImmobilizationsController {
  constructor(private readonly immobilizations: ImmobilizationsService) {}

  @Get()
  @ApiOperation({ summary: 'Immobilisations dans le périmètre (actives et terminées).' })
  @ApiPageResponse(ImmobilizationViewDto)
  list(@Ctx() ctx: RequestContext, @Query() query: ImmobilizationsQueryDto): Promise<Page<ImmobilizationViewDto>> {
    return this.immobilizations.list(ctx, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Détail d’une immobilisation et de ses causes.' })
  @ApiOkResponse({ type: ImmobilizationViewDto })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<ImmobilizationViewDto> {
    return this.immobilizations.get(ctx, id);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Immobiliser un véhicule (ou ajouter la cause à son immobilisation active).' })
  @ApiCreatedResponse({ type: ImmobilizationViewDto })
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateImmobilizationDto): Promise<ImmobilizationViewDto> {
    return this.immobilizations.create(ctx, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Modifier le lieu ou la fin prévue d’une immobilisation active (expectedVersion) ; une immobilisation terminée ne se modifie pas.' })
  @ApiOkResponse({ type: ImmobilizationViewDto })
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateImmobilizationDto): Promise<ImmobilizationViewDto> {
    return this.immobilizations.update(ctx, id, dto);
  }

  @Post(':id/causes')
  @HttpCode(201)
  @ApiOperation({ summary: 'Ajouter une cause à une immobilisation active.' })
  @ApiCreatedResponse({ type: ImmobilizationViewDto })
  addCause(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddCauseDto): Promise<ImmobilizationViewDto> {
    return this.immobilizations.addCause(ctx, id, dto);
  }

  @Post(':id/causes/:causeId/end')
  @HttpCode(200)
  @ApiOperation({ summary: 'Terminer une cause ; la dernière cause terminée met fin à l’immobilisation.' })
  @ApiOkResponse({ type: ImmobilizationViewDto })
  endCause(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('causeId', ParseUUIDPipe) causeId: string, @Body() dto: EndCauseDto): Promise<ImmobilizationViewDto> {
    return this.immobilizations.endCause(ctx, id, causeId, dto);
  }

  @Post(':id/end')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fin d’immobilisation : termine toutes les causes ouvertes (remise en disponibilité).' })
  @ApiOkResponse({ type: ImmobilizationViewDto })
  end(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EndCauseDto): Promise<ImmobilizationViewDto> {
    return this.immobilizations.end(ctx, id, dto);
  }
}
