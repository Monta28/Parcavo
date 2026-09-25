import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { trimmed } from './create-fuel-entry.dto.js';

class VersionedDto {
  @ApiProperty({ description: 'Version connue du plein (verrou optimiste).' })
  @Type(() => Number)
  @IsInt({ message: 'Version attendue : entier requis.' })
  @Min(1, { message: 'Version attendue : entier positif.' })
  expectedVersion!: number;
}

/** Validation d'une soumission conducteur (D-222, D-224) : crée la dépense unique du plein. */
export class ValidateFuelEntryDto extends VersionedDto {
  @ApiPropertyOptional({ description: 'Confirmation explicite requise quand un écart litres × prix / total est signalé.' })
  @IsOptional()
  @IsBoolean({ message: 'Confirmation de l’écart : vrai ou faux.' })
  confirmAmountMismatch?: boolean;

  @ApiPropertyOptional({ description: 'Station / fournisseur à compléter lors de la validation.' })
  @IsOptional()
  @IsUUID('all', { message: 'Fournisseur : identifiant invalide.' })
  supplierId?: string;

  @ApiPropertyOptional({ description: 'Clé d’idempotence (ou en-tête Idempotency-Key, 8 à 128 caractères).' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  idempotencyKey?: string;
}

export class RejectFuelEntryDto extends VersionedDto {
  @ApiProperty({ description: 'Motif du rejet, visible par le conducteur.' })
  @Transform(trimmed)
  @IsString({ message: 'Motif : texte attendu.' })
  @MinLength(3, { message: 'Motif : 3 caractères au moins.' })
  @MaxLength(500, { message: 'Motif : 500 caractères au plus.' })
  reason!: string;
}

export class CancelFuelEntryDto extends VersionedDto {
  @ApiPropertyOptional({ description: 'Motif : facultatif pour le retrait d’une soumission par le conducteur, obligatoire pour l’annulation d’un plein validé.' })
  @Transform(trimmed)
  @IsOptional()
  @IsString({ message: 'Motif : texte attendu.' })
  @MinLength(3, { message: 'Motif : 3 caractères au moins.' })
  @MaxLength(500, { message: 'Motif : 500 caractères au plus.' })
  reason?: string;
}

export class ConfirmCapacityDto extends VersionedDto {}
