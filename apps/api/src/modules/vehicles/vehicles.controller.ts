import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PageQueryDto, type Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { AttachPhotoDto, ChangeLifecycleDto, CreateLocationReportDto, CreateVehicleDto, LocationReportViewDto, QrResolveDto, UpdateVehicleDto, VehicleSynthesisDto, VehicleViewDto, VehiclesQueryDto } from './dto/vehicles.dto.js';
import { VehiclesService } from './vehicles.service.js';

@ApiTags('vehicles')
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Get()
  @ApiOperation({ summary: 'Recherche multicritère des véhicules du périmètre.' })
  list(@Ctx() ctx: RequestContext, @Query() query: VehiclesQueryDto): Promise<Page<VehicleViewDto>> {
    return this.vehicles.list(ctx, query);
  }

  @Get('qr/:token')
  @ApiOperation({ summary: 'Résout un QR code interne vers un véhicule du périmètre (session requise).' })
  @ApiOkResponse({ type: QrResolveDto })
  resolveQr(@Ctx() ctx: RequestContext, @Param('token') token: string): Promise<QrResolveDto> {
    return this.vehicles.resolveQr(ctx, token);
  }

  @Get(':id')
  @ApiOkResponse({ type: VehicleViewDto })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<VehicleViewDto> {
    return this.vehicles.get(ctx, id);
  }

  @Get(':id/synthesis')
  @ApiOperation({ summary: 'Synthèse : responsable, utilisateur actuel, statut, dernière localisation, dernier relevé, échéances.' })
  @ApiOkResponse({ type: VehicleSynthesisDto })
  synthesis(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<VehicleSynthesisDto> {
    return this.vehicles.synthesis(ctx, id);
  }

  @Post()
  @HttpCode(201)
  @ApiOkResponse({ type: VehicleViewDto })
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateVehicleDto): Promise<VehicleViewDto> {
    return this.vehicles.create(ctx, dto);
  }

  @Patch(':id')
  @ApiOkResponse({ type: VehicleViewDto })
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVehicleDto): Promise<VehicleViewDto> {
    return this.vehicles.update(ctx, id, dto);
  }

  @Post(':id/lifecycle')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change le cycle de vie (ACTIF, HORS_SERVICE, CEDE, ARCHIVE) avec motif.' })
  @ApiOkResponse({ type: VehicleViewDto })
  changeLifecycle(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeLifecycleDto): Promise<VehicleViewDto> {
    return this.vehicles.changeLifecycle(ctx, id, dto);
  }

  @Get(':id/location-reports')
  listLocationReports(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: PageQueryDto): Promise<Page<LocationReportViewDto>> {
    return this.vehicles.listLocationReports(ctx, id, query);
  }

  @Post(':id/location-reports')
  @HttpCode(201)
  @ApiOperation({ summary: 'Déclare une localisation (site ou lieu libre, date d’observation, commentaire).' })
  @ApiOkResponse({ type: LocationReportViewDto })
  addLocationReport(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateLocationReportDto): Promise<LocationReportViewDto> {
    return this.vehicles.addLocationReport(ctx, id, dto);
  }

  @Post(':id/photos')
  @HttpCode(201)
  attachPhoto(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AttachPhotoDto): Promise<{ attachmentId: string }> {
    return this.vehicles.attachPhoto(ctx, id, dto.attachmentId);
  }

  @Post(':id/qr/regenerate')
  @HttpCode(200)
  regenerateQr(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<{ qrToken: string }> {
    return this.vehicles.regenerateQr(ctx, id);
  }
}
