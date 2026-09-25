import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiIdempotent, IdempotencyKey } from '../../common/idempotency.decorator.js';
import type { Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { ConsumptionQueryDto, ConsumptionViewDto, CreateFuelPurchaseGapDto, FuelPurchaseGapViewDto } from './dto/consumption.dto.js';
import { CorrectFuelEntryDto, CreateFuelEntryDto } from './dto/create-fuel-entry.dto.js';
import { FuelEntriesPageDto, FuelEntriesQueryDto, FuelEntryViewDto } from './dto/fuel-entry-view.dto.js';
import { CancelFuelEntryDto, ConfirmCapacityDto, RejectFuelEntryDto, ValidateFuelEntryDto } from './dto/validate-fuel-entry.dto.js';
import { FuelService } from './fuel.service.js';

@ApiTags('carburant')
@Controller()
export class FuelController {
  constructor(private readonly fuel: FuelService) {}

  @Get('fuel-entries')
  @ApiOperation({ summary: 'Pleins du périmètre (filtres société, véhicule, conducteur, statut, période, écart montant) ; conducteur : ses propres pleins.' })
  @ApiOkResponse({ type: FuelEntriesPageDto })
  list(@Ctx() ctx: RequestContext, @Query() query: FuelEntriesQueryDto): Promise<Page<FuelEntryViewDto>> {
    return this.fuel.list(ctx, query);
  }

  @Get('fuel-entries/:id')
  @ApiOperation({ summary: 'Détail d’un plein (montants visibles avec costs.read ; conducteur : ses propres saisies, jamais la dépense).' })
  @ApiOkResponse({ type: FuelEntryViewDto })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<FuelEntryViewDto> {
    return this.fuel.get(ctx, id);
  }

  @Post('fuel-entries')
  @HttpCode(201)
  @ApiIdempotent()
  @ApiOperation({ summary: 'Saisir un plein : personnel (costs.write) → VALIDE avec sa dépense ; conducteur → soumission SOUMIS (ticket obligatoire).' })
  @ApiCreatedResponse({ type: FuelEntryViewDto })
  @ApiOkResponse({ type: FuelEntryViewDto, description: 'Réponse rejouée pour une clé d’idempotence déjà traitée.' })
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateFuelEntryDto, @IdempotencyKey() key: string): Promise<FuelEntryViewDto> {
    return this.fuel.create(ctx, dto, key);
  }

  @Post('fuel-entries/:id/validate')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({ summary: 'Valider une soumission (costs.write) : VALIDE et dépense unique ; confirmation explicite si écart de montant.' })
  @ApiOkResponse({ type: FuelEntryViewDto })
  validate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ValidateFuelEntryDto, @IdempotencyKey() key: string): Promise<FuelEntryViewDto> {
    return this.fuel.validate(ctx, id, dto, key);
  }

  @Post('fuel-entries/:id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rejeter une soumission avec un motif (costs.write).' })
  @ApiOkResponse({ type: FuelEntryViewDto })
  reject(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectFuelEntryDto): Promise<FuelEntryViewDto> {
    return this.fuel.reject(ctx, id, dto);
  }

  @Post('fuel-entries/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Retirer sa soumission (conducteur, tant que SOUMIS) ou annuler un plein validé (chef/admin, motif ; dépense annulée).' })
  @ApiOkResponse({ type: FuelEntryViewDto })
  cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelFuelEntryDto): Promise<FuelEntryViewDto> {
    return this.fuel.cancel(ctx, id, dto);
  }

  @Post('fuel-entries/:id/correct')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({ summary: 'Corriger un plein validé (chef/admin, costs.write) : nouvelle ligne, dépense remplacée, motif et audit.' })
  @ApiOkResponse({ type: FuelEntryViewDto, description: 'Nouvelle version du plein.' })
  correct(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CorrectFuelEntryDto, @IdempotencyKey() key: string): Promise<FuelEntryViewDto> {
    return this.fuel.correct(ctx, id, dto, key);
  }

  @Post('fuel-entries/:id/confirm-capacity')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirmer un dépassement de capacité du réservoir (chef/admin) : le plein redevient admissible à la consommation.' })
  @ApiOkResponse({ type: FuelEntryViewDto })
  confirmCapacity(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmCapacityDto): Promise<FuelEntryViewDto> {
    return this.fuel.confirmCapacity(ctx, id, dto);
  }

  @Get('vehicles/:id/consumption')
  @ApiOperation({ summary: 'Consommation estimée (L/100 km) : intervalles retenus et exclus avec motifs, N/D jamais remplacé par une estimation.' })
  @ApiOkResponse({ type: ConsumptionViewDto })
  consumption(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: ConsumptionQueryDto): Promise<ConsumptionViewDto> {
    return this.fuel.consumption(ctx, id, query);
  }

  @Get('vehicles/:id/fuel-purchase-gaps')
  @ApiOperation({ summary: 'Périodes déclarées « achats incomplets » du véhicule.' })
  @ApiOkResponse({ type: [FuelPurchaseGapViewDto] })
  listPurchaseGaps(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<FuelPurchaseGapViewDto[]> {
    return this.fuel.listPurchaseGaps(ctx, id);
  }

  @Post('vehicles/:id/fuel-purchase-gaps')
  @HttpCode(201)
  @ApiOperation({ summary: 'Déclarer une période « achats incomplets » (chef/admin, motif) : les intervalles qui la recoupent deviennent N/D.' })
  @ApiCreatedResponse({ type: FuelPurchaseGapViewDto })
  @ApiOkResponse({ type: FuelPurchaseGapViewDto })
  createPurchaseGap(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateFuelPurchaseGapDto): Promise<FuelPurchaseGapViewDto> {
    return this.fuel.createPurchaseGap(ctx, id, dto);
  }
}
