import { ApiProperty } from '@nestjs/swagger';
import { MAPPING_FUEL_KINDS, MappingViewDto } from './telemetry.dto.js';

const PROVIDER_STATUSES = ['BROUILLON', 'ACTIF', 'SUSPENDU', 'DESACTIVE'] as const;
const CALIBRATION_STATUSES = ['CALIBRE', 'NON_CALIBRABLE'] as const;

/**
 * État télématique d'un véhicule (CDC 5.6, 14.5 ; D-101, D-112, D-147, D-178, D-190) : lecture seule,
 * sans configuration ni secret du fournisseur. Aucun « suivi en direct » : uniquement la dernière
 * observation reçue, la dernière estimation GPS historisée et le dernier calibrage.
 */
export class VehicleTelemetryProviderDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() kind!: string;
  @ApiProperty({ description: 'Libellé du type ; « SIMULATEUR — données fictives » pour le simulateur.' }) kindLabel!: string;
  @ApiProperty() isSimulator!: boolean;
  @ApiProperty({ enum: PROVIDER_STATUSES }) status!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) lastSuccessAt!: string | null;
  @ApiProperty() consecutiveFailures!: number;
  @ApiProperty({ nullable: true, type: String, format: 'date-time', description: 'Coupe-circuit ouvert jusqu’à cet instant (D-297).' }) circuitOpenUntil!: string | null;
}

export class VehicleTelemetryObservationDto {
  @ApiProperty({ nullable: true, type: String, description: 'Dernière valeur d’odomètre reçue (km, décimal exact) ; jamais un relevé accepté en soi.' }) odometerKm!: string | null;
  @ApiProperty({ nullable: true, enum: ['COMPTEUR_CAN', 'DISTANCE_GPS'], type: String }) odometerKind!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) odometerObservedAt!: string | null;
  @ApiProperty({ nullable: true, enum: MAPPING_FUEL_KINDS, type: String }) fuelKind!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Dernier échantillon carburant stocké : litres (décimal exact), si le fournisseur les donne.' }) fuelLiters!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Dernier échantillon carburant stocké : pourcentage du réservoir, si le fournisseur le donne.' }) fuelPercent!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) fuelObservedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time', description: 'Dernière réception d’une donnée de l’unité (synchronisation).' }) receivedAt!: string | null;
}

export class VehicleGpsEstimateDto {
  @ApiProperty() readingId!: string;
  @ApiProperty({ description: 'Kilométrage cumulé estimé (décimal exact), jamais présenté comme un compteur.' }) cumulativeKm!: string;
  @ApiProperty({ nullable: true, type: String }) gpsDistanceKm!: string | null;
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Libellé « Estimé GPS (réf. manuelle du …, … km) » enregistré avec l’estimation.' }) label!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time', description: 'Date de la référence manuelle du calibrage.' }) referenceAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) referenceKm!: string | null;
}

export class VehicleCalibrationDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: CALIBRATION_STATUSES }) status!: string;
  @ApiProperty({ format: 'date-time' }) referenceAt!: string;
  @ApiProperty() referenceKm!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Estimation GPS à l’instant de la référence, selon le calibrage précédent.' }) estimatedKmAtReference!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Distance manuelle depuis la référence précédente.' }) distanceSincePreviousKm!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Écart estimation − relevé manuel (km).' }) deviationKm!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Dérive en % de la distance manuelle (3 décimales, D-190).' }) deviationPercent!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Dérive affichée à une décimale, virgule décimale (« 4,2 »).' }) deviationPercentLabel!: string | null;
  @ApiProperty({ description: 'Vrai si la dérive a dépassé le seuil et levé l’alerte « dérive GPS ».' }) driftAlertRaised!: boolean;
  @ApiProperty({ nullable: true, type: String }) statusReason!: string | null;
}

export class VehicleTelemetryViewDto {
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty({ description: 'Module F11 activé pour la société gestionnaire du véhicule.' }) telemetryEnabled!: boolean;
  @ApiProperty({ type: MappingViewDto, nullable: true, description: 'Association confirmée en cours.' }) mapping!: MappingViewDto | null;
  @ApiProperty({ description: 'Propositions d’association en attente de confirmation pour ce véhicule.' }) pendingProposals!: number;
  @ApiProperty({ type: VehicleTelemetryProviderDto, nullable: true }) provider!: VehicleTelemetryProviderDto | null;
  @ApiProperty({ type: VehicleTelemetryObservationDto, nullable: true, description: 'Dernière observation reçue de l’unité associée, depuis la date d’effet de l’association en cours (un boîtier réutilisé ne restitue pas les valeurs de son véhicule précédent).' })
  lastObservation!: VehicleTelemetryObservationDto | null;
  @ApiProperty({ type: VehicleGpsEstimateDto, nullable: true }) lastEstimate!: VehicleGpsEstimateDto | null;
  @ApiProperty({ type: VehicleCalibrationDto, nullable: true, description: 'Dernier calibrage (référence manuelle), calibrable ou non.' }) lastCalibration!: VehicleCalibrationDto | null;
  @ApiProperty({ type: VehicleCalibrationDto, nullable: true, description: 'Dernier calibrage ayant mesuré une dérive.' }) lastDrift!: VehicleCalibrationDto | null;
}
