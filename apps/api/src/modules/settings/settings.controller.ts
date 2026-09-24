import { Body, Controller, Delete, Get, HttpCode, Param, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsDefined, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { SettingsService, type EffectiveSetting, type SettingVersionView } from './settings.service.js';

class SettingsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
}

class SetSettingDto {
  @ApiProperty({ description: 'Nouvelle valeur (type selon le paramètre).' }) @IsDefined() value!: unknown;
  @ApiPropertyOptional({ description: 'Surcharge explicite pour une société (sinon valeur groupe).' }) @IsOptional() @IsUUID() companyId?: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiPropertyOptional({ type: Number, minimum: 0, description: 'Verrou optimiste : version courante du niveau modifié (groupe ou société), 0 quand ce niveau n’a encore aucune valeur ; 409 si elle a changé.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

class ClearOverrideDto {
  @ApiProperty() @IsUUID() companyId!: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiPropertyOptional({ type: Number, minimum: 1, description: 'Verrou optimiste : version de la surcharge à retirer ; 409 si elle a changé.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Paramètres effectifs (valeur, origine : défaut, groupe ou société).' })
  list(@Ctx() ctx: RequestContext, @Query() query: SettingsQueryDto): Promise<EffectiveSetting[]> {
    return this.settings.list(ctx, query.companyId ?? null);
  }

  @Get(':key/history')
  history(@Ctx() ctx: RequestContext, @Param('key') key: string): Promise<SettingVersionView[]> {
    return this.settings.history(ctx, key);
  }

  @Put(':key')
  @ApiOperation({ summary: 'Crée une nouvelle version du paramètre (administrateur, motif obligatoire, audité ; valeur fixe du produit refusée en 422).' })
  set(@Ctx() ctx: RequestContext, @Param('key') key: string, @Body() dto: SetSettingDto): Promise<EffectiveSetting> {
    return this.settings.set(ctx, key, dto.value, dto.companyId ?? null, dto.reason, dto.expectedVersion);
  }

  @Delete(':key/override')
  @HttpCode(200)
  async clear(@Ctx() ctx: RequestContext, @Param('key') key: string, @Body() dto: ClearOverrideDto): Promise<{ ok: true }> {
    await this.settings.clearCompanyOverride(ctx, key, dto.companyId, dto.reason, dto.expectedVersion);
    return { ok: true };
  }
}
