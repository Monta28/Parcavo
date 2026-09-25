import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiPageResponse, type Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import {
  CloseMappingDto,
  CloseMappingResultDto,
  CompanyTelemetryDto,
  CompanyTelemetryViewDto,
  ConfirmMappingDto,
  CreateMappingDto,
  CreateProviderDto,
  CredentialStatusDto,
  DiscoveryResultDto,
  ExpectedVersionQueryDto,
  IgnoreUnitDto,
  MappingViewDto,
  MappingsQueryDto,
  ProviderHealthDto,
  ProviderKindDto,
  ProviderTransitionDto,
  ProviderViewDto,
  ProvidersQueryDto,
  PutCredentialDto,
  RejectMappingDto,
  SyncRunViewDto,
  SyncRunsQueryDto,
  UnignoreUnitDto,
  UnitViewDto,
  UnitsPageDto,
  UnitsQueryDto,
  UpdateProviderDto,
} from './dto/telemetry.dto.js';
import { CREDENTIAL_KINDS } from './telemetry-settings.js';
import { TelemetryProvidersService } from './telemetry-providers.service.js';
import { TelemetryUnitsService } from './telemetry-units.service.js';

/**
 * Connecteur télématique F11 (CDC 14.3 à 14.6 ; D-112). Configuration réservée à l'administrateur ;
 * le chef de parc consulte l'état de ses sociétés et décide des associations de ses véhicules ;
 * opérateur et lecteur consultent ; le conducteur n'a aucun accès. Aucun secret n'est jamais renvoyé.
 */
@ApiTags('telemetry')
@Controller('telemetry')
export class TelemetryController {
  constructor(
    private readonly providers: TelemetryProvidersService,
    private readonly units: TelemetryUnitsService,
  ) {}

  // ---- Fournisseurs ------------------------------------------------------------------------

  @Get('provider-kinds')
  @ApiOperation({ summary: 'Types de fournisseur et disponibilité de leur adaptateur (administrateur).' })
  @ApiOkResponse({ type: [ProviderKindDto] })
  kinds(@Ctx() ctx: RequestContext): ProviderKindDto[] {
    return this.providers.kinds(ctx);
  }

  @Get('providers')
  @ApiOperation({ summary: 'Fournisseurs visibles : tous (administrateur) ou couvrant les sociétés du lecteur, sans configuration.' })
  @ApiPageResponse(ProviderViewDto)
  list(@Ctx() ctx: RequestContext, @Query() query: ProvidersQueryDto): Promise<Page<ProviderViewDto>> {
    return this.providers.list(ctx, query);
  }

  @Post('providers')
  @HttpCode(201)
  @ApiOperation({ summary: 'Créer un fournisseur en brouillon (administrateur). RPA et simulateur en production refusés (422).' })
  @ApiCreatedResponse({ type: ProviderViewDto })
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateProviderDto): Promise<ProviderViewDto> {
    return this.providers.create(ctx, dto);
  }

  @Get('providers/:id')
  @ApiOperation({ summary: 'Détail d’un fournisseur télématique visible (configuration non secrète réservée à l’administrateur).' })
  @ApiOkResponse({ type: ProviderViewDto })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<ProviderViewDto> {
    return this.providers.get(ctx, id);
  }

  @Patch('providers/:id')
  @ApiOperation({ summary: 'Modifier nom, URL, paramètres non secrets, intervalle, reprise, sociétés couvertes (administrateur).' })
  @ApiOkResponse({ type: ProviderViewDto })
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProviderDto): Promise<ProviderViewDto> {
    return this.providers.update(ctx, id, dto);
  }

  @Delete('providers/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Supprimer un brouillon jamais synchronisé (administrateur).' })
  @ApiNoContentResponse({ description: 'Brouillon supprimé (aucun contenu).' })
  async remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: ExpectedVersionQueryDto): Promise<void> {
    await this.providers.remove(ctx, id, query.expectedVersion);
  }

  @Post('providers/:id/activate')
  @HttpCode(200)
  @ApiOperation({ summary: 'BROUILLON/SUSPENDU → ACTIF (administrateur) : configuration complète exigée.' })
  @ApiOkResponse({ type: ProviderViewDto })
  activate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ProviderTransitionDto): Promise<ProviderViewDto> {
    return this.providers.transition(ctx, id, 'ACTIF', dto);
  }

  @Post('providers/:id/suspend')
  @HttpCode(200)
  @ApiOperation({ summary: 'ACTIF → SUSPENDU (administrateur, motif).' })
  @ApiOkResponse({ type: ProviderViewDto })
  suspend(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ProviderTransitionDto): Promise<ProviderViewDto> {
    return this.providers.transition(ctx, id, 'SUSPENDU', dto);
  }

  @Post('providers/:id/deactivate')
  @HttpCode(200)
  @ApiOperation({ summary: '→ DESACTIVE (administrateur, motif) ; données conservées.' })
  @ApiOkResponse({ type: ProviderViewDto })
  deactivate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ProviderTransitionDto): Promise<ProviderViewDto> {
    return this.providers.transition(ctx, id, 'DESACTIVE', dto);
  }

  @Put('providers/:id/credentials/:kind')
  @HttpCode(200)
  @ApiOperation({ summary: 'Déposer ou remplacer un secret en écriture seule (administrateur) ; la réponse ne contient que { kind, configured, rotatedAt }.' })
  @ApiParam({ name: 'kind', enum: CREDENTIAL_KINDS })
  @ApiOkResponse({ type: CredentialStatusDto })
  putCredential(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('kind') kind: string, @Body() dto: PutCredentialDto): Promise<CredentialStatusDto> {
    return this.providers.putCredential(ctx, id, kind, dto.secret);
  }

  @Delete('providers/:id/credentials/:kind')
  @HttpCode(200)
  @ApiOperation({ summary: 'Révoquer (supprimer) un secret (administrateur).' })
  @ApiParam({ name: 'kind', enum: CREDENTIAL_KINDS })
  @ApiOkResponse({ type: CredentialStatusDto })
  removeCredential(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('kind') kind: string): Promise<CredentialStatusDto> {
    return this.providers.removeCredential(ctx, id, kind);
  }

  @Post('providers/:id/health')
  @HttpCode(200)
  @ApiOperation({ summary: 'Test de connexion réel (healthCheck de l’adaptateur), message expurgé (administrateur).' })
  @ApiOkResponse({ type: ProviderHealthDto })
  health(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<ProviderHealthDto> {
    return this.providers.health(ctx, id);
  }

  @Post('providers/:id/discover')
  @HttpCode(200)
  @ApiOperation({ summary: 'Lister les unités chez le fournisseur et proposer les associations par immatriculation (administrateur ou chef d’une société couverte). Aucun relevé n’est ingéré.' })
  @ApiOkResponse({ type: DiscoveryResultDto })
  discover(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<DiscoveryResultDto> {
    return this.units.discover(ctx, id);
  }

  // ---- Activation par société ------------------------------------------------------------------

  @Get('companies')
  @ApiOperation({ summary: 'Sociétés visibles, état du module F11 et fournisseurs couvrants.' })
  @ApiOkResponse({ type: [CompanyTelemetryViewDto] })
  companies(@Ctx() ctx: RequestContext): Promise<CompanyTelemetryViewDto[]> {
    return this.providers.companies(ctx);
  }

  @Post('companies/:companyId/enable')
  @HttpCode(200)
  @ApiOperation({ summary: 'Activer le module F11 pour une société (administrateur, motif, audit).' })
  @ApiOkResponse({ type: CompanyTelemetryViewDto })
  enable(@Ctx() ctx: RequestContext, @Param('companyId', ParseUUIDPipe) companyId: string, @Body() dto: CompanyTelemetryDto): Promise<CompanyTelemetryViewDto> {
    return this.providers.setCompanyEnabled(ctx, companyId, true, dto);
  }

  @Post('companies/:companyId/disable')
  @HttpCode(200)
  @ApiOperation({ summary: 'Désactiver le module F11 (administrateur, motif) : plus d’ingestion, données conservées, alertes F11 résolues.' })
  @ApiOkResponse({ type: CompanyTelemetryViewDto })
  disable(@Ctx() ctx: RequestContext, @Param('companyId', ParseUUIDPipe) companyId: string, @Body() dto: CompanyTelemetryDto): Promise<CompanyTelemetryViewDto> {
    return this.providers.setCompanyEnabled(ctx, companyId, false, dto);
  }

  // ---- Unités et associations -------------------------------------------------------------------

  @Get('units')
  @ApiOperation({ summary: 'Unités non associées, propositions, associations en cours, véhicules sans unité active, unités ignorées (périmètre).' })
  @ApiOkResponse({ type: UnitsPageDto })
  listUnits(@Ctx() ctx: RequestContext, @Query() query: UnitsQueryDto): Promise<UnitsPageDto> {
    return this.units.listUnits(ctx, query);
  }

  @Post('units/:id/ignore')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Ignorer une unité volontairement sans véhicule (remorque, boîtier de rechange ; D-249), motif obligatoire : administrateur ou chef d’une société couverte. Propositions en attente rejetées, alerte « unité non associée » résolue ; 409 si une association confirmée est en cours.',
  })
  @ApiOkResponse({ type: UnitViewDto })
  ignoreUnit(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: IgnoreUnitDto): Promise<UnitViewDto> {
    return this.units.ignoreUnit(ctx, id, dto);
  }

  @Post('units/:id/unignore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ne plus ignorer une unité (D-249), motif facultatif : elle redevient à associer et son alerte « unité non associée » est relevée de nouveau.' })
  @ApiOkResponse({ type: UnitViewDto })
  unignoreUnit(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UnignoreUnitDto): Promise<UnitViewDto> {
    return this.units.unignoreUnit(ctx, id, dto);
  }

  @Get('mappings')
  @ApiOperation({ summary: 'Associations unité ↔ véhicule du périmètre.' })
  @ApiPageResponse(MappingViewDto)
  listMappings(@Ctx() ctx: RequestContext, @Query() query: MappingsQueryDto): Promise<Page<MappingViewDto>> {
    return this.units.listMappings(ctx, query);
  }

  @Get('mappings/:id')
  @ApiOperation({ summary: 'Détail d’une association unité ↔ véhicule du périmètre.' })
  @ApiOkResponse({ type: MappingViewDto })
  getMapping(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<MappingViewDto> {
    return this.units.getMapping(ctx, id);
  }

  @Post('mappings')
  @HttpCode(201)
  @ApiOperation({ summary: 'Association manuelle confirmée par le chef de la société du véhicule (ou l’administrateur).' })
  @ApiCreatedResponse({ type: MappingViewDto })
  createMapping(@Ctx() ctx: RequestContext, @Body() dto: CreateMappingDto): Promise<MappingViewDto> {
    return this.units.createMapping(ctx, dto);
  }

  @Post('mappings/:id/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirmer une proposition : date d’effet (D-301), nature du kilométrage et du carburant.' })
  @ApiOkResponse({ type: MappingViewDto })
  confirm(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmMappingDto): Promise<MappingViewDto> {
    return this.units.confirm(ctx, id, dto);
  }

  @Post('mappings/:id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rejeter une proposition (motif).' })
  @ApiOkResponse({ type: MappingViewDto })
  reject(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectMappingDto): Promise<MappingViewDto> {
    return this.units.reject(ctx, id, dto);
  }

  @Post('mappings/:id/close')
  @HttpCode(200)
  @ApiOperation({ summary: 'Clôturer une association ; avec remplacement : changement de boîtier (D-300), kilométrage cumulé inchangé.' })
  @ApiOkResponse({ type: CloseMappingResultDto })
  close(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseMappingDto): Promise<CloseMappingResultDto> {
    return this.units.close(ctx, id, dto);
  }

  // ---- Exécutions ---------------------------------------------------------------------------

  @Get('sync-runs')
  @ApiOperation({ summary: 'Exécutions de synchronisation et de découverte (périmètre ; résumés d’erreur expurgés).' })
  @ApiPageResponse(SyncRunViewDto)
  syncRuns(@Ctx() ctx: RequestContext, @Query() query: SyncRunsQueryDto): Promise<Page<SyncRunViewDto>> {
    return this.units.listSyncRuns(ctx, query);
  }
}
