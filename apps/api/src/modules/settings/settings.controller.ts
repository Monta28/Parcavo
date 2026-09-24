import { Body, Controller, Delete, Get, HttpCode, Param, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsDefined, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { SettingsService, type EffectiveSetting } from './settings.service.js';

class SettingsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
}

class SetSettingDto {
  @ApiProperty({ description: 'Nouvelle valeur (type selon le paramètre).' }) @IsDefined() value!: unknown;
  @ApiPropertyOptional({ description: 'Surcharge explicite pour une société (sinon valeur groupe).' }) @IsOptional() @IsUUID() companyId?: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

class ClearOverrideDto {
  @ApiProperty() @IsUUID() companyId!: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
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
  history(@Ctx() ctx: RequestContext, @Param('key') key: string) {
    return this.settings.history(ctx, key as never);
  }

  @Put(':key')
  @ApiOperation({ summary: 'Crée une nouvelle version du paramètre (administrateur, motif obligatoire, audité).' })
  set(@Ctx() ctx: RequestContext, @Param('key') key: string, @Body() dto: SetSettingDto): Promise<EffectiveSetting> {
    return this.settings.set(ctx, key, dto.value, dto.companyId ?? null, dto.reason);
  }

  @Delete(':key/override')
  @HttpCode(200)
  async clear(@Ctx() ctx: RequestContext, @Param('key') key: string, @Body() dto: ClearOverrideDto): Promise<{ ok: true }> {
    await this.settings.clearCompanyOverride(ctx, key, dto.companyId, dto.reason);
    return { ok: true };
  }
}
