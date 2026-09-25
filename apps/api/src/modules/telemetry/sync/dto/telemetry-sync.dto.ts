import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { PageQueryDto } from '../../../../common/pagination.js';

const SYNC_TRIGGERS = ['PLANIFIE', 'MANUEL', 'REPRISE_INITIALE', 'WEBHOOK'] as const;
const SYNC_STATUSES = ['EN_COURS', 'SUCCES', 'PARTIEL', 'ECHEC', 'IGNORE'] as const;
export const FUEL_EVENT_TYPES = ['REMPLISSAGE_DETECTE', 'BAISSE_ANORMALE', 'ECART_TICKET'] as const;
export const FUEL_EVENT_STATUSES = ['A_QUALIFIER', 'QUALIFIE'] as const;
export const FUEL_EVENT_QUALIFICATIONS = ['JUSTIFIE', 'ANOMALIE_CONFIRMEE', 'ERREUR_CAPTEUR'] as const;
const FUEL_MEASURE_KINDS = ['NIVEAU_CAN', 'NIVEAU_SONDE', 'CONSOMMATION_CAN'] as const;

// ---------------------------------------------------------------------------------------------
// Synchronisation manuelle (D-112, D-296)
// ---------------------------------------------------------------------------------------------

export class ManualSyncDto {
  @ApiPropertyOptional({ description: 'Limiter la synchronisation à une société couverte (sinon : toutes les sociétés couvertes, activées et gérées par l’appelant).' })
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @ApiPropertyOptional({ description: 'Reprise d’historique sur la période de reprise du fournisseur, bornée à la dernière désactivation du module (administrateur, D-101, D-295).', default: false })
  @IsOptional()
  @IsBoolean()
  reprise?: boolean;
}

export class ManualSyncRunDto {
  @ApiProperty({ nullable: true, type: String, description: 'Exécution créée, ou exécution déjà en cours pour ce couple fournisseur-société.' }) syncRunId!: string | null;
  @ApiProperty() companyId!: string;
  @ApiProperty({ enum: SYNC_TRIGGERS }) trigger!: string;
  @ApiProperty({ enum: SYNC_STATUSES, description: 'EN_COURS : exécution lancée en arrière-plan ; IGNORE : coupe-circuit ouvert, aucun appel au fournisseur.' }) status!: string;
  @ApiProperty({ description: 'Vrai si une exécution était déjà en cours (bail détenu) : aucune nouvelle exécution n’est lancée.' }) alreadyRunning!: boolean;
  @ApiProperty({ nullable: true, type: String }) message!: string | null;
}

export class ManualSyncResultDto {
  @ApiProperty() providerId!: string;
  @ApiProperty({ type: [ManualSyncRunDto] }) runs!: ManualSyncRunDto[];
}

// ---------------------------------------------------------------------------------------------
// Événements carburant (CDC 8.5 ; D-112, D-242)
// ---------------------------------------------------------------------------------------------

export class FuelEventsQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
  @ApiPropertyOptional({ enum: FUEL_EVENT_STATUSES }) @IsOptional() @IsIn(FUEL_EVENT_STATUSES) status?: (typeof FUEL_EVENT_STATUSES)[number];
  @ApiPropertyOptional({ enum: FUEL_EVENT_TYPES }) @IsOptional() @IsIn(FUEL_EVENT_TYPES) type?: (typeof FUEL_EVENT_TYPES)[number];
  @ApiPropertyOptional({ format: 'date-time', description: 'Détection à partir de cet instant.' }) @IsOptional() @IsDateString({ strict: true }) from?: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Détection jusqu’à cet instant.' }) @IsOptional() @IsDateString({ strict: true }) to?: string;
}

export class QualifyFuelEventDto {
  @ApiProperty({ enum: FUEL_EVENT_QUALIFICATIONS, description: 'JUSTIFIE, ANOMALIE_CONFIRMEE ou ERREUR_CAPTEUR ; aucune dépense ni retenue n’est jamais déduite.' })
  @IsIn(FUEL_EVENT_QUALIFICATIONS)
  qualification!: (typeof FUEL_EVENT_QUALIFICATIONS)[number];

  @ApiProperty({ description: 'Note de qualification (motif), conservée et auditée.' })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note!: string;

  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class FuelEventViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Vrai si l’événement provient d’un fournisseur SIMULATEUR : à afficher « SIMULATEUR — données fictives » (D-303).' }) isSimulator!: boolean;
  @ApiProperty() companyId!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty() vehicleRegistration!: string;
  @ApiProperty({ nullable: true, type: String }) unitId!: string | null;
  @ApiProperty({ enum: FUEL_EVENT_TYPES }) type!: string;
  @ApiProperty() typeLabel!: string;
  @ApiProperty({ enum: FUEL_MEASURE_KINDS, description: 'Nature de la mesure (affichée telle quelle, 8.5).' }) measureKind!: string;
  @ApiProperty() measureKindLabel!: string;
  @ApiProperty({ format: 'date-time' }) detectedAt!: string;
  @ApiProperty({ format: 'date-time' }) windowStart!: string;
  @ApiProperty({ format: 'date-time' }) windowEnd!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Variation en litres (décimal exact, positive).' }) litersDelta!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Variation en % du réservoir.' }) percentDelta!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Plein rapproché (ou le plus proche pour un écart).' }) fuelEntryId!: string | null;
  @ApiProperty({ enum: FUEL_EVENT_STATUSES }) status!: string;
  @ApiProperty({ nullable: true, enum: FUEL_EVENT_QUALIFICATIONS }) qualification!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) qualifiedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Nul pour une justification automatique (rapprochement d’un plein).' }) qualifiedById!: string | null;
  @ApiProperty({ nullable: true, type: String }) qualificationNote!: string | null;
  @ApiProperty({ nullable: true, type: Object, description: 'Nature, seuils appliqués et résultat du rapprochement.' }) details!: Record<string, unknown> | null;
  @ApiProperty() version!: number;
}

export class FuelEventsPageDto {
  @ApiProperty({ type: [FuelEventViewDto] }) items!: FuelEventViewDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}
