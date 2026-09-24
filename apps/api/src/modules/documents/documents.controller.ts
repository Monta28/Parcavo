import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiIdempotent, IDEMPOTENCY_HEADER_NAME } from '../../common/idempotency.decorator.js';
import { ApiPageResponse, type Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import {
  ArchiveDocumentDto,
  ComplianceQueryDto,
  ComplianceRowDto,
  CorrectDocumentDto,
  CreateDocumentDto,
  CreateDocumentTypeDto,
  DocumentTypeViewDto,
  DocumentViewDto,
  DocumentsQueryDto,
  InstallDocumentCatalogResultDto,
  RenewDocumentDto,
  UpdateDocumentTypeDto,
} from './dto/documents.dto.js';
import { DocumentsService } from './documents.service.js';

@ApiTags('documents')
@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('document-types')
  @ApiOperation({ summary: 'Types de documents de l’organisation (actifs par défaut ; includeArchived=true pour les archivés).' })
  @ApiQuery({ name: 'includeArchived', required: false, enum: ['true', 'false'] })
  @ApiOkResponse({ type: [DocumentTypeViewDto] })
  listTypes(@Ctx() ctx: RequestContext, @Query('includeArchived') includeArchived?: string): Promise<DocumentTypeViewDto[]> {
    return this.documents.listTypes(ctx, includeArchived === 'true');
  }

  @Post('document-types')
  @HttpCode(201)
  @ApiOperation({ summary: 'Créer un type de document (administrateur) : expiration, exigence, blocage, préavis, portée.' })
  @ApiCreatedResponse({ type: DocumentTypeViewDto })
  createType(@Ctx() ctx: RequestContext, @Body() dto: CreateDocumentTypeDto): Promise<DocumentTypeViewDto> {
    return this.documents.createType(ctx, dto);
  }

  @Post('document-types/initial-catalog')
  @HttpCode(200)
  @ApiIdempotent({ required: false })
  @ApiOperation({ summary: 'Installer les types de documents usuels (administrateur) : ajoute seulement les types absents, facultatifs et non bloquants ; ne modifie aucun type existant ; rejouable sans effet, audité.' })
  @ApiOkResponse({ type: InstallDocumentCatalogResultDto })
  installInitialTypes(@Ctx() ctx: RequestContext, @Headers(IDEMPOTENCY_HEADER_NAME) idempotencyKey?: string): Promise<InstallDocumentCatalogResultDto> {
    return this.documents.installInitialTypes(ctx, idempotencyKey);
  }

  @Patch('document-types/:id')
  @ApiOperation({ summary: 'Modifier ou archiver un type de document (administrateur, expectedVersion).' })
  @ApiOkResponse({ type: DocumentTypeViewDto })
  updateType(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDocumentTypeDto): Promise<DocumentTypeViewDto> {
    return this.documents.updateType(ctx, id, dto);
  }

  @Get('documents/compliance')
  @ApiOperation({ summary: 'Conformité : une ligne par objet et type applicable (MANQUANT, VALIDE, A_RENOUVELER, EXPIRE).' })
  @ApiPageResponse(ComplianceRowDto)
  compliance(@Ctx() ctx: RequestContext, @Query() query: ComplianceQueryDto): Promise<Page<ComplianceRowDto>> {
    return this.documents.compliance(ctx, query);
  }

  @Get('documents')
  @ApiOperation({ summary: 'Versions de documents dans le périmètre (conducteur : ses documents et ceux du véhicule en cours).' })
  @ApiPageResponse(DocumentViewDto)
  list(@Ctx() ctx: RequestContext, @Query() query: DocumentsQueryDto): Promise<Page<DocumentViewDto>> {
    return this.documents.list(ctx, query);
  }

  @Get('documents/:id')
  @ApiOperation({ summary: 'Détail d’une version de document du périmètre.' })
  @ApiOkResponse({ type: DocumentViewDto })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<DocumentViewDto> {
    return this.documents.get(ctx, id);
  }

  @Post('documents')
  @HttpCode(201)
  @ApiIdempotent({ required: false })
  @ApiOperation({ summary: 'Enregistrer un document (véhicule ou conducteur) avec ses dates et son justificatif ; Idempotency-Key facultative.' })
  @ApiCreatedResponse({ type: DocumentViewDto })
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateDocumentDto, @Headers(IDEMPOTENCY_HEADER_NAME) idempotencyKey?: string): Promise<DocumentViewDto> {
    return this.documents.create(ctx, dto, idempotencyKey);
  }

  @Post('documents/:id/renew')
  @HttpCode(201)
  @ApiIdempotent({ required: false })
  @ApiOperation({ summary: 'Renouveler : nouvelle version ; la version future ne remplace pas une version encore valide.' })
  @ApiCreatedResponse({ type: DocumentViewDto })
  renew(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RenewDocumentDto, @Headers(IDEMPOTENCY_HEADER_NAME) idempotencyKey?: string): Promise<DocumentViewDto> {
    return this.documents.renew(ctx, id, dto, idempotencyKey);
  }

  @Patch('documents/:id')
  @ApiOperation({ summary: 'Corriger une faute de saisie (motif, audit avant/après).' })
  @ApiOkResponse({ type: DocumentViewDto })
  correct(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CorrectDocumentDto): Promise<DocumentViewDto> {
    return this.documents.correct(ctx, id, dto);
  }

  @Post('documents/:id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archiver une version erronée (jamais supprimée).' })
  @ApiOkResponse({ type: DocumentViewDto })
  archive(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ArchiveDocumentDto): Promise<DocumentViewDto> {
    return this.documents.archive(ctx, id, dto);
  }
}
