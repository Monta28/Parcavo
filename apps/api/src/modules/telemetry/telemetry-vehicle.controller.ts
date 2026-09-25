import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { UpdateVehicleFuelThresholdsDto, VehicleFuelThresholdsViewDto } from './dto/telemetry-fuel-thresholds.dto.js';
import { VehicleTelemetryViewDto } from './dto/telemetry-vehicle.dto.js';
import { TelemetryFuelThresholdsService } from './telemetry-fuel-thresholds.service.js';
import { TelemetryVehicleService } from './telemetry-vehicle.service.js';

/**
 * État télématique d'un véhicule (CDC 5.6, 14.5 ; D-112) : personnel de gestion dans son périmètre
 * (administrateur, chef, opérateur, lecteur) ; conducteur : 403 ; hors périmètre : 404. Aucune
 * configuration de fournisseur ni secret n'est renvoyé, et aucun suivi en direct.
 */
@ApiTags('telemetry')
@Controller('telemetry')
export class TelemetryVehicleController {
  constructor(
    private readonly vehicles: TelemetryVehicleService,
    private readonly fuelThresholds: TelemetryFuelThresholdsService,
  ) {}

  @Get('vehicles/:vehicleId')
  @ApiOperation({
    summary: 'État télématique d’un véhicule : association en cours, fournisseur, dernière observation reçue, dernière estimation « estimé GPS » avec sa référence, dernier calibrage et dernière dérive.',
  })
  @ApiOkResponse({ type: VehicleTelemetryViewDto })
  status(@Ctx() ctx: RequestContext, @Param('vehicleId', ParseUUIDPipe) vehicleId: string): Promise<VehicleTelemetryViewDto> {
    return this.vehicles.status(ctx, vehicleId);
  }

  @Get('vehicles/:vehicleId/fuel-thresholds')
  @ApiOperation({
    summary: 'Seuils carburant du véhicule (baisse à l’arrêt, remplissage détecté) : surcharge propre au véhicule, valeur de la société et valeur appliquée, avec leur origine (D-238, D-240).',
  })
  @ApiOkResponse({ type: VehicleFuelThresholdsViewDto })
  fuelThresholdsView(@Ctx() ctx: RequestContext, @Param('vehicleId', ParseUUIDPipe) vehicleId: string): Promise<VehicleFuelThresholdsViewDto> {
    return this.fuelThresholds.view(ctx, vehicleId);
  }

  @Put('vehicles/:vehicleId/fuel-thresholds')
  @ApiOperation({
    summary: 'Remplace les seuils carburant propres au véhicule (chef de parc de la société ou administrateur ; motif, verrou optimiste, audit) ; tous les champs nuls retirent la surcharge.',
  })
  @ApiOkResponse({ type: VehicleFuelThresholdsViewDto })
  updateFuelThresholds(@Ctx() ctx: RequestContext, @Param('vehicleId', ParseUUIDPipe) vehicleId: string, @Body() dto: UpdateVehicleFuelThresholdsDto): Promise<VehicleFuelThresholdsViewDto> {
    return this.fuelThresholds.update(ctx, vehicleId, dto);
  }
}
