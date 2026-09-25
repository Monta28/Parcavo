import { Body, Controller, Delete, Get, HttpCode, Param, Put, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, type SchemaObject } from '@nestjs/swagger';
import { SETTING_DEFAULTS } from '@parc-auto/contracts';
import { IsDefined, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { OkDto } from '../auth/dto/auth.dto.js';
import { SettingsService, type EffectiveSetting, type SettingVersionView } from './settings.service.js';

/** Valeur d'un paramètre selon sa nature (CDC 17.1) : entier, nombre, booléen, heure « HH:MM » ou liste. */
const SETTING_VALUE_SCHEMA: Pick<SchemaObject, 'oneOf'> = {
  oneOf: [{ type: 'number' }, { type: 'boolean' }, { type: 'string' }, { type: 'array', items: { oneOf: [{ type: 'number' }, { type: 'string' }] } }],
};

class EffectiveSettingDto {
  @ApiProperty({ type: String, enum: Object.keys(SETTING_DEFAULTS) }) key!: string;
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({ type: String, nullable: true }) unit!: string | null;
  @ApiProperty({ ...SETTING_VALUE_SCHEMA, description: 'Valeur effective.' }) value!: unknown;
  @ApiProperty({ type: String, enum: ['defaut', 'groupe', 'societe'], description: 'Origine : défaut du produit, valeur groupe ou surcharge société.' }) source!: 'defaut' | 'groupe' | 'societe';
  @ApiProperty({ type: Number, nullable: true }) settingVersion!: number | null;
  @ApiProperty({ type: Boolean, description: 'Surcharge société possible pour ce paramètre.' }) companyOverride!: boolean;
  @ApiProperty({ type: Boolean, description: 'Faux pour une valeur fixe du produit (bornes de pagination de l’API) : affichée, jamais modifiable.' }) editable!: boolean;
}

class SettingVersionDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'Société de la surcharge ; null pour la valeur groupe.' }) companyId!: string | null;
  @ApiProperty({ ...SETTING_VALUE_SCHEMA }) value!: unknown;
  @ApiProperty({ type: Number }) settingVersion!: number;
  @ApiProperty({ type: Boolean }) isCurrent!: boolean;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) createdById!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Prénom et nom de l’auteur de la version.' }) createdByName!: string | null;
}

class SettingsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
}

class SetSettingDto {
  @ApiProperty({ ...SETTING_VALUE_SCHEMA, description: 'Nouvelle valeur (type selon le paramètre).' }) @IsDefined() value!: unknown;
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
  @ApiOkResponse({ type: [EffectiveSettingDto] })
  list(@Ctx() ctx: RequestContext, @Query() query: SettingsQueryDto): Promise<EffectiveSetting[]> {
    return this.settings.list(ctx, query.companyId ?? null);
  }

  @Get(':key/history')
  @ApiOperation({ summary: 'Historique des versions d’un paramètre, valeur groupe et surcharges société (administrateur).' })
  @ApiOkResponse({ type: [SettingVersionDto] })
  history(@Ctx() ctx: RequestContext, @Param('key') key: string): Promise<SettingVersionView[]> {
    return this.settings.history(ctx, key);
  }

  @Put(':key')
  @ApiOperation({ summary: 'Crée une nouvelle version du paramètre (administrateur, motif obligatoire, audité ; valeur fixe du produit refusée en 422).' })
  @ApiOkResponse({ type: EffectiveSettingDto })
  set(@Ctx() ctx: RequestContext, @Param('key') key: string, @Body() dto: SetSettingDto): Promise<EffectiveSetting> {
    return this.settings.set(ctx, key, dto.value, dto.companyId ?? null, dto.reason, dto.expectedVersion);
  }

  @Delete(':key/override')
  @HttpCode(200)
  @ApiOperation({ summary: 'Retire la surcharge société d’un paramètre (retour à la valeur groupe ; administrateur, motif obligatoire, audité ; 404 sans surcharge en vigueur).' })
  @ApiOkResponse({ type: OkDto })
  async clear(@Ctx() ctx: RequestContext, @Param('key') key: string, @Body() dto: ClearOverrideDto): Promise<{ ok: true }> {
    await this.settings.clearCompanyOverride(ctx, key, dto.companyId, dto.reason, dto.expectedVersion);
    return { ok: true };
  }
}
