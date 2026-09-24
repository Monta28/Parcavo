import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiPageResponse, type Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { CopySupplierDto, CreateSupplierDto, SupplierStatusDto, SupplierViewDto, SuppliersQueryDto, UpdateSupplierDto } from './dto/suppliers.dto.js';
import { SuppliersService } from './suppliers.service.js';

@ApiTags('suppliers')
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  @ApiOperation({ summary: 'Répertoire des fournisseurs dans le périmètre (actifs par défaut).' })
  @ApiPageResponse(SupplierViewDto)
  list(@Ctx() ctx: RequestContext, @Query() query: SuppliersQueryDto): Promise<Page<SupplierViewDto>> {
    return this.suppliers.list(ctx, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fiche d’un fournisseur du périmètre.' })
  @ApiOkResponse({ type: SupplierViewDto })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<SupplierViewDto> {
    return this.suppliers.get(ctx, id);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Créer un fournisseur dans une société (opérateur, chef de parc ou administrateur).' })
  @ApiCreatedResponse({ type: SupplierViewDto })
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateSupplierDto): Promise<SupplierViewDto> {
    return this.suppliers.create(ctx, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Modifier un fournisseur (expectedVersion).' })
  @ApiOkResponse({ type: SupplierViewDto })
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierDto): Promise<SupplierViewDto> {
    return this.suppliers.update(ctx, id, dto);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archiver un fournisseur (historique conservé).' })
  @ApiOkResponse({ type: SupplierViewDto })
  archive(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SupplierStatusDto): Promise<SupplierViewDto> {
    return this.suppliers.archive(ctx, id, dto);
  }

  @Post(':id/copy')
  @HttpCode(201)
  @ApiOperation({ summary: 'Copier vers une autre société : nouvelle fiche active dans la société cible, sans historique ni montants (D-221). 409 FOURNISSEUR_EXISTANT si un fournisseur actif y porte déjà ce nom.' })
  @ApiCreatedResponse({ type: SupplierViewDto })
  copy(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CopySupplierDto): Promise<SupplierViewDto> {
    return this.suppliers.copy(ctx, id, dto);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Réactiver un fournisseur archivé.' })
  @ApiOkResponse({ type: SupplierViewDto })
  restore(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SupplierStatusDto): Promise<SupplierViewDto> {
    return this.suppliers.restore(ctx, id, dto);
  }
}
