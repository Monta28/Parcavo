import { Body, Controller, Get, HttpCode, Injectable, Param, ParseEnumPipe, ParseUUIDPipe, PayloadTooLargeException, Post, Query, Res, UploadedFile, UseInterceptors, type CallHandler, type ExecutionContext, type NestInterceptor, type Type } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import { SETTING_DESCRIPTORS } from '@parc-auto/contracts';
import { BusinessRuleError } from '../../common/errors.js';
import { ApiIdempotent, IdempotencyKey } from '../../common/idempotency.decorator.js';
import { ApiPageResponse, type Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { AbandonImportDto, IMPORT_KINDS, ImportBatchViewDto, ImportModelDto, ImportRowViewDto, ImportRowsQueryDto, ImportsQueryDto, type ImportKindValue, TemplateQueryDto, UploadImportDto, ValidateImportDto } from './dto/imports.dto.js';
import { ImportsService } from './imports.service.js';

/** Plafond technique du téléversement : borne haute du paramètre imports.maxSizeBytes (5 Mo). */
const IMPORT_CEILING_BYTES = SETTING_DESCRIPTORS['imports.maxSizeBytes'].max ?? 5 * 1024 * 1024;

const ImportFileMulter: Type<NestInterceptor> = FileInterceptor('file', { limits: { fileSize: IMPORT_CEILING_BYTES, files: 1 } });

/**
 * Lecture du fichier d'import (12.1, 17.1) : au-delà du plafond, multer interrompt la lecture (413) ; le
 * refus est alors le même que pour la limite paramétrée (422 FICHIER_TROP_VOLUMINEUX, message en français),
 * et aucune donnée n'est conservée.
 */
@Injectable()
class ImportFileInterceptor implements NestInterceptor {
  private readonly multer = new ImportFileMulter();

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    try {
      return await (this.multer.intercept(context, next) as Promise<Observable<unknown>>);
    } catch (error) {
      if (error instanceof PayloadTooLargeException) {
        const limit = (IMPORT_CEILING_BYTES / (1024 * 1024)).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
        throw new BusinessRuleError('FICHIER_TROP_VOLUMINEUX', `Le fichier dépasse la taille maximale d’un import (${limit} Mo).`, { fieldErrors: { file: [`${limit} Mo au plus par lot, hors pièces jointes.`] } });
      }
      throw error;
    }
  }
}

interface UploadedMulterFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

@ApiTags('imports')
@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get('models')
  @ApiOperation({ summary: 'Modèles d’import et colonnes attendues (12.2).' })
  @ApiOkResponse({ type: [ImportModelDto] })
  models(@Ctx() ctx: RequestContext): ImportModelDto[] {
    return this.imports.models(ctx);
  }

  @Get('templates/:kind')
  @ApiOperation({ summary: 'Télécharge le modèle vierge (CSV UTF-8 ou XLSX avec feuille d’aide).' })
  @ApiProduces('text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiParam({ name: 'kind', enum: IMPORT_KINDS })
  @ApiOkResponse({ description: 'Modèle vierge CSV ou XLSX (en pièce jointe).', schema: { type: 'string', format: 'binary' } })
  async template(@Ctx() ctx: RequestContext, @Param('kind', new ParseEnumPipe(IMPORT_KINDS)) kind: ImportKindValue, @Query() query: TemplateQueryDto, @Res() res: Response): Promise<void> {
    const file = await this.imports.template(ctx, kind, query.format ?? 'xlsx');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.content);
  }

  @Get()
  @ApiOperation({ summary: 'Lots d’import (administrateur : tous ; chef de parc : les siens).' })
  @ApiPageResponse(ImportBatchViewDto)
  list(@Ctx() ctx: RequestContext, @Query() query: ImportsQueryDto): Promise<Page<ImportBatchViewDto>> {
    return this.imports.list(ctx, query);
  }

  @Post()
  @HttpCode(201)
  @UseInterceptors(ImportFileInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, kind: { type: 'string', enum: [...IMPORT_KINDS] } }, required: ['file', 'kind'] } })
  @ApiOperation({ summary: 'Téléverse un fichier CSV ou XLSX (5 Mo, 2 000 lignes) ; aucune donnée métier n’est écrite.' })
  @ApiCreatedResponse({ type: ImportBatchViewDto })
  upload(@Ctx() ctx: RequestContext, @UploadedFile() file: UploadedMulterFile | undefined, @Body() body: UploadImportDto): Promise<ImportBatchViewDto> {
    if (!file) throw new BusinessRuleError('FICHIER_REQUIS', 'Aucun fichier reçu (champ « file »).', { fieldErrors: { file: ['Fichier requis.'] } });
    return this.imports.upload(ctx, file, body.kind);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Détail d’un lot d’import : statut, compteurs et association des colonnes.' })
  @ApiOkResponse({ type: ImportBatchViewDto })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<ImportBatchViewDto> {
    return this.imports.get(ctx, id);
  }

  @Get(':id/rows')
  @ApiOperation({ summary: 'Résultat ligne par ligne (erreurs par colonne, avertissements, objet créé).' })
  @ApiPageResponse(ImportRowViewDto)
  rows(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: ImportRowsQueryDto): Promise<Page<ImportRowViewDto>> {
    return this.imports.rows(ctx, id, query);
  }

  @Post(':id/validate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Associe les colonnes et contrôle toutes les lignes sans rien écrire (transaction annulée).' })
  @ApiOkResponse({ type: ImportBatchViewDto })
  validate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ValidateImportDto): Promise<ImportBatchViewDto> {
    return this.imports.validate(ctx, id, dto);
  }

  @Post(':id/commit')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({ summary: 'Confirme le lot : transaction unique qui revalide tout ; idempotente (une seule importation).' })
  @ApiOkResponse({ type: ImportBatchViewDto })
  commit(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @IdempotencyKey() key: string): Promise<ImportBatchViewDto> {
    return this.imports.commit(ctx, id, key);
  }

  @Post(':id/abandon')
  @HttpCode(200)
  @ApiOperation({ summary: 'Abandonne un lot non confirmé (expectedVersion) ; aucune donnée métier n’est écrite.' })
  @ApiOkResponse({ type: ImportBatchViewDto })
  abandon(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AbandonImportDto): Promise<ImportBatchViewDto> {
    return this.imports.abandon(ctx, id, dto);
  }

  @Get(':id/report')
  @ApiOperation({ summary: 'Rapport ligne/colonne/message au format CSV (cellules neutralisées).' })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'Rapport CSV UTF-8 (en pièce jointe).', schema: { type: 'string', format: 'binary' } })
  async report(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const file = await this.imports.reportCsv(ctx, id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.send(file.content);
  }
}
