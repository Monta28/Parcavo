import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiConflictResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiIdempotent, IdempotencyKey } from '../../common/idempotency.decorator.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { TransferPreviewDto, TransferResponsiblesDto, TransferResponsiblesQueryDto, TransferResultDto, TransferVehicleDto } from './dto/transfer-vehicle.dto.js';
import { VehicleTransferService } from './vehicle-transfer.service.js';

@ApiTags('vehicles')
@Controller('vehicles')
export class VehicleTransferController {
  constructor(private readonly transfers: VehicleTransferService) {}

  @Get(':id/transfer-preview')
  @ApiOperation({ summary: 'Aperçu du transfert (administrateur) : objets bloquants avec liens, avertissements, affectation, plans, documents partageables, mapping télématique.' })
  @ApiOkResponse({ type: TransferPreviewDto })
  preview(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<TransferPreviewDto> {
    return this.transfers.preview(ctx, id);
  }

  @Get(':id/transfer-responsibles')
  @ApiOperation({ summary: 'Responsables de plan éligibles dans la société cible (administrateur) : comptes actifs administrateurs groupe, chefs de parc ou opérateurs de cette société — même règle que le contrôle du transfert.' })
  @ApiOkResponse({ type: TransferResponsiblesDto })
  responsibles(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: TransferResponsiblesQueryDto): Promise<TransferResponsiblesDto> {
    return this.transfers.responsibles(ctx, id, query.companyId);
  }

  @Post(':id/transfer')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({ summary: 'Transférer le véhicule vers une autre société (administrateur) : transactionnel, idempotent, versionné, effet à l’heure du serveur ; 409 TRANSFERT_BLOQUE tant qu’une opération est ouverte.' })
  @ApiOkResponse({ type: TransferResultDto })
  @ApiConflictResponse({ description: 'TRANSFERT_BLOQUE (liste typée des objets bloquants dans details.blockers) ou VERSION_OBSOLETE.' })
  transfer(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransferVehicleDto, @IdempotencyKey() key: string): Promise<TransferResultDto> {
    return this.transfers.transfer(ctx, id, dto, key);
  }
}
