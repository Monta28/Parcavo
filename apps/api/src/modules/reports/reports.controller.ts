import { Controller, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { ApiAcceptedResponse, ApiExtraModels, ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiTags, getSchemaPath } from '@nestjs/swagger';
import type { Response } from 'express';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { ExportAcceptedDto, ExportJobViewDto, ReportCatalogueDto, ReportExportQueryDto, ReportPageDto, ReportQueryDto } from './dto/reports.dto.js';
import { ReportExportService } from './export/report-export.service.js';
import { REPORT_CODES } from './report-types.js';
import { ReportsService } from './reports.service.js';

function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly exports: ReportExportService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Catalogue des rapports V1 (11.2) : vues, filtres, statuts filtrables et droits d’export.' })
  @ApiOkResponse({ type: ReportCatalogueDto })
  catalogue(@Ctx() ctx: RequestContext): ReportCatalogueDto {
    return this.reports.catalogue(ctx);
  }

  @Get('exports/:jobId')
  @ApiOperation({ summary: 'Suivi d’un export différé (statut, progression) — demandeur uniquement.' })
  @ApiOkResponse({ type: ExportJobViewDto })
  exportStatus(@Ctx() ctx: RequestContext, @Param('jobId', ParseUUIDPipe) jobId: string): Promise<ExportJobViewDto> {
    return this.exports.status(ctx, jobId);
  }

  @Get('exports/:jobId/download')
  @ApiOperation({ summary: 'Téléchargement d’un export différé : droits revérifiés (reports.export, costs.read si colonnes de coût, périmètre) ; conservé 24 h.' })
  @ApiProduces('text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiOkResponse({ description: 'Fichier CSV ou XLSX.', schema: { type: 'string', format: 'binary' } })
  async exportDownload(@Ctx() ctx: RequestContext, @Param('jobId', ParseUUIDPipe) jobId: string, @Res() res: Response): Promise<void> {
    const file = await this.exports.download(ctx, jobId);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.sizeBytes));
    res.setHeader('Content-Disposition', contentDisposition(file.fileName));
    res.setHeader('Cache-Control', 'no-store');
    file.stream.on('error', (error) => res.destroy(error));
    file.stream.pipe(res);
  }

  @Get(':code')
  @ApiOperation({ summary: 'Rapport paginé pour l’écran : lignes du périmètre, métadonnées (filtres appliqués, fuseau, date de génération, unités, colonnes).' })
  @ApiParam({ name: 'code', enum: REPORT_CODES })
  @ApiOkResponse({ type: ReportPageDto })
  page(@Ctx() ctx: RequestContext, @Param('code') code: string, @Query() query: ReportQueryDto): Promise<ReportPageDto> {
    return this.reports.page(ctx, code, query);
  }

  @Get(':code/export')
  @ApiOperation({ summary: 'Export CSV (UTF-8 BOM, « ; », virgule décimale) ou XLSX des mêmes données que l’écran : synchrone jusqu’à 5 000 lignes, sinon 202 et export différé.' })
  @ApiParam({ name: 'code', enum: REPORT_CODES })
  @ApiProduces('text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiOkResponse({ description: 'Fichier CSV ou XLSX (export synchrone).', schema: { type: 'string', format: 'binary' } })
  @ApiExtraModels(ExportAcceptedDto)
  @ApiAcceptedResponse({
    description: 'Export volumineux mis en file : suivre /reports/exports/{jobId}.',
    content: { 'application/json': { schema: { $ref: getSchemaPath(ExportAcceptedDto) } } },
  })
  async export(@Ctx() ctx: RequestContext, @Param('code') code: string, @Query() query: ReportExportQueryDto, @Res() res: Response): Promise<void> {
    const outcome = await this.exports.start(ctx, code, query);
    if (outcome.kind === 'job') {
      res.status(202).json({ jobId: outcome.jobId, rowCount: outcome.rowCount, statusPath: outcome.statusPath } satisfies ExportAcceptedDto);
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', outcome.contentType);
    res.setHeader('Content-Disposition', contentDisposition(outcome.fileName));
    res.setHeader('Cache-Control', 'no-store');
    try {
      await outcome.write(res);
    } catch (error) {
      res.destroy(error instanceof Error ? error : new Error('Écriture de l’export interrompue.'));
    }
  }
}
