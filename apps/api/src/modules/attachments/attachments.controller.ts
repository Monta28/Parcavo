import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { SETTING_DESCRIPTORS } from '@parc-auto/contracts';

/** Plafond technique du téléversement : borne haute du paramètre (10 Mo) ; la valeur paramétrée est contrôlée par le service. */
const UPLOAD_CEILING_BYTES = SETTING_DESCRIPTORS['attachments.maxSizeBytes'].max ?? 10 * 1024 * 1024;
import { BusinessRuleError } from '../../common/errors.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { OkDto } from '../auth/dto/auth.dto.js';
import { AttachmentsService } from './attachments.service.js';
import { AttachmentViewDto, UploadResultDto } from './dto/attachments.dto.js';
import { OwnerAuthorizationService } from './owner-authorization.service.js';

/** Fichier reçu par multer (sous-ensemble utilisé). */
interface UploadedMulterFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

class UploadBodyDto {
  @IsOptional() @IsUUID() companyId?: string;
}
class RemoveBodyDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

@ApiTags('attachments')
@Controller('attachments')
export class AttachmentsController {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly ownerAuth: OwnerAuthorizationService,
  ) {}

  @Post()
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UPLOAD_CEILING_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, companyId: { type: 'string', format: 'uuid' } }, required: ['file'] } })
  @ApiOperation({ summary: 'Téléverse un fichier privé (PDF, JPEG, PNG ; 10 Mo max) en zone temporaire.' })
  @ApiOkResponse({ type: UploadResultDto })
  async upload(@Ctx() ctx: RequestContext, @UploadedFile() file: UploadedMulterFile | undefined, @Body() body: UploadBodyDto): Promise<AttachmentViewDto> {
    if (!file) throw new BusinessRuleError('FICHIER_REQUIS', 'Aucun fichier reçu (champ « file »).', { fieldErrors: { file: ['Fichier requis.'] } });
    return this.attachments.upload(ctx, file, body.companyId ?? null);
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Téléchargement privé : autorisé après contrôle du propriétaire métier.' })
  async download(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const { attachment, stream } = await this.attachments.open(ctx, id, this.ownerAuth);
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Length', String(attachment.sizeBytes));
    // Images affichées en ligne (photos), PDF proposés en téléchargement ; aucun rendu HTML possible.
    const disposition = attachment.mimeType.startsWith('image/') ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream.pipe(res);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOkResponse({ type: OkDto })
  async remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RemoveBodyDto): Promise<OkDto> {
    await this.attachments.remove(ctx, id, this.ownerAuth, body.reason);
    return { ok: true };
  }
}
