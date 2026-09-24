import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { ApiIdempotent, IdempotencyKey } from '../../common/idempotency.decorator.js';
import { ApiPageResponse, type Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { CheckoutDto, CheckoutPreviewDto, ExtendUsageDto, RegularizeReturnReadingDto, ReturnDto, UsageViewDto, UsagesQueryDto } from './dto/usages.dto.js';
import { UsagesService } from './usages.service.js';

class PreviewQueryDto {
  @ApiProperty() @IsUUID() vehicleId!: string;
  @ApiProperty() @IsUUID() driverId!: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() at?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expectedReturnAt?: string;
}

@ApiTags('usages')
@Controller('usages')
export class UsagesController {
  constructor(private readonly usages: UsagesService) {}

  @Get()
  @ApiOperation({ summary: 'Utilisations (en cours, historique, retards) ; conducteur : les siennes.' })
  @ApiPageResponse(UsageViewDto)
  list(@Ctx() ctx: RequestContext, @Query() query: UsagesQueryDto): Promise<Page<UsageViewDto>> {
    return this.usages.list(ctx, query);
  }

  @Get('checkout-preview')
  @ApiOperation({ summary: 'Contrôles préalables à une remise (blocages, dernier relevé, aide télématique, checklist).' })
  @ApiOkResponse({ type: CheckoutPreviewDto })
  preview(@Ctx() ctx: RequestContext, @Query() query: PreviewQueryDto): Promise<CheckoutPreviewDto> {
    return this.usages.preview(ctx, query.vehicleId, query.driverId, query.at, query.expectedReturnAt);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Détail d’une utilisation du périmètre (conducteur : les siennes).' })
  @ApiOkResponse({ type: UsageViewDto })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<UsageViewDto> {
    return this.usages.get(ctx, id);
  }

  @Post('checkout')
  @HttpCode(201)
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Remise : transactionnelle et idempotente ; crée une utilisation EN_COURS et convertit la réservation du même couple.',
    description: 'Lieu obligatoire (site actif de la société du véhicule ou lieu libre). 409 RESERVATION_CONFLIT si l’occupation réelle [départ, max(retour prévu, maintenant)[ chevauche la réservation confirmée d’un autre conducteur ou véhicule ; 422 RESERVATION_HORS_FENETRE si la réservation indiquée ne peut pas être convertie à cette heure.',
  })
  @ApiCreatedResponse({ type: UsageViewDto })
  checkout(@Ctx() ctx: RequestContext, @Body() dto: CheckoutDto, @IdempotencyKey() key: string): Promise<UsageViewDto> {
    return this.usages.checkout(ctx, dto, key);
  }

  @Post(':id/return')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({ summary: 'Restitution : toujours possible ; distance validée seulement avec deux relevés acceptés ; lieu obligatoire ; dommage éventuel ouvert en incident.' })
  @ApiOkResponse({ type: UsageViewDto })
  return(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReturnDto, @IdempotencyKey() key: string): Promise<UsageViewDto> {
    return this.usages.return(ctx, id, dto, key);
  }

  @Post(':id/return-reading')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Régularise la distance non validée : rattache un relevé accepté au retour (chef ou administrateur, exceptions.override).',
    description:
      'Après un retour constaté sans relevé ou avec un relevé rejeté : nouveau relevé (reading, observé par défaut à l’heure du retour) ou relevé accepté existant (readingId), observé entre le retour et la remise suivante. Transactionnelle, idempotente, versionnée (expectedVersion) et auditée ; motif obligatoire. 409 ETAT_INVALIDE (non restituée ou déjà validée), 409 RELEVE_EN_ATTENTE, 409 RELEVE_DEJA_UTILISE, 422 DEPART_SANS_RELEVE, RELEVE_NON_ACCEPTE, RELEVE_HORS_PERIODE.',
  })
  @ApiOkResponse({ type: UsageViewDto })
  regularizeReturnReading(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RegularizeReturnReadingDto, @IdempotencyKey() key: string): Promise<UsageViewDto> {
    return this.usages.regularizeReturnReading(ctx, id, dto, key);
  }

  @Post(':id/extend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Prolonge le retour prévu (motif obligatoire, version attendue) ; 409 RESERVATION_CONFLIT si le nouveau créneau chevauche la réservation confirmée d’autrui.' })
  @ApiOkResponse({ type: UsageViewDto })
  extend(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExtendUsageDto): Promise<UsageViewDto> {
    return this.usages.extend(ctx, id, dto);
  }
}
