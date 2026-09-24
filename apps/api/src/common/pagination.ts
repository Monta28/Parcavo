import type { Type as ClassType } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PAGINATION } from '@parc-auto/contracts';

/** Paramètres de liste (CDC 15.1) : pagination bornée, tri sur liste autorisée. */
export class PageQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: PAGINATION.maxPageSize, default: PAGINATION.defaultPageSize })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION.maxPageSize)
  pageSize: number = PAGINATION.defaultPageSize;

  @ApiPropertyOptional({ description: 'Champ de tri (liste autorisée par ressource).' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sort?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order: 'asc' | 'desc' = 'asc';

  @ApiPropertyOptional({ description: 'Recherche plein texte simple.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function pageOf<T>(items: T[], total: number, query: { page: number; pageSize: number }): Page<T> {
  return { items, total, page: query.page, pageSize: query.pageSize };
}

export function skipTake(query: { page: number; pageSize: number }): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
}

/** Résout un tri demandé contre la liste autorisée ; un tri inconnu renvoie le tri par défaut. */
export function resolveSort<K extends string>(
  requested: string | undefined,
  allowed: readonly K[],
  fallback: K,
): K {
  return requested !== undefined && (allowed as readonly string[]).includes(requested) ? (requested as K) : fallback;
}

export class PageMetaDto {
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

const PAGE_DTOS = new Map<ClassType<unknown>, ClassType<PageMetaDto>>();

/**
 * Schéma OpenAPI nommé d'une page de résultats Page<T> (métadonnées + items) : « VehicleViewDto » donne
 * « VehicleViewPageDto ». Une seule classe par type d'élément, pour un document stable.
 */
export function pageDtoOf(item: ClassType<unknown>): ClassType<PageMetaDto> {
  const existing = PAGE_DTOS.get(item);
  if (existing) return existing;
  class ItemsPageDto extends PageMetaDto {
    @ApiProperty({ type: [item] }) items!: unknown[];
  }
  Object.defineProperty(ItemsPageDto, 'name', { value: `${item.name.replace(/Dto$/, '')}PageDto` });
  PAGE_DTOS.set(item, ItemsPageDto);
  return ItemsPageDto;
}

/** Réponse 200 d'une liste paginée (CDC 15.1) renvoyant Page<T>. */
export function ApiPageResponse(item: ClassType<unknown>, description?: string): MethodDecorator & ClassDecorator {
  return ApiOkResponse({ type: pageDtoOf(item), ...(description ? { description } : {}) });
}
