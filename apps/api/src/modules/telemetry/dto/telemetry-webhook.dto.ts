import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CredentialStatusDto } from './telemetry.dto.js';

const DELIVERY_STATUSES = ['EN_ATTENTE', 'EN_COURS', 'TRAITE', 'IGNORE', 'ECHEC'] as const;

/** Réponse 202 à un lot accepté : déposé dans la file, ingéré ensuite par le worker. */
export class WebhookAcceptedDto {
  @ApiProperty({ description: 'Identifiant du lot dans la file (à communiquer au support).' }) deliveryId!: string;
  @ApiProperty({ enum: ['EN_ATTENTE'] }) status!: 'EN_ATTENTE';
  @ApiProperty({ format: 'date-time' }) receivedAt!: string;
  @ApiProperty() units!: number;
  @ApiProperty() odometers!: number;
  @ApiProperty() fuel!: number;
}

export class WebhookDeliveryViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: DELIVERY_STATUSES }) status!: string;
  @ApiProperty({ format: 'date-time', description: 'Horodatage signé par le fournisseur.' }) signedAt!: string;
  @ApiProperty({ format: 'date-time' }) receivedAt!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty() units!: number;
  @ApiProperty() odometers!: number;
  @ApiProperty() fuel!: number;
  @ApiProperty() attempts!: number;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) processedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Motif expurgé d’un lot ignoré ou en échec.' }) lastError!: string | null;
  @ApiProperty({ type: [String], description: 'Exécutions de synchronisation (une par société) créées par le traitement du lot.' }) syncRunIds!: string[];
}

export class WebhookCountsDto {
  @ApiProperty() pending!: number;
  @ApiProperty() receivedLast24h!: number;
  @ApiProperty() processedLast24h!: number;
  @ApiProperty() ignoredLast24h!: number;
  @ApiProperty() failedLast24h!: number;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) lastReceivedAt!: string | null;
}

/** Configuration de réception à communiquer au fournisseur (administrateur) ; jamais le secret. */
export class WebhookViewDto {
  @ApiProperty() providerId!: string;
  @ApiProperty({ description: 'URL de réception à communiquer au fournisseur (méthode POST).' }) url!: string;
  @ApiProperty() method!: 'POST';
  @ApiProperty({ description: 'En-tête portant l’horodatage signé (secondes Unix, UTC).' }) timestampHeader!: string;
  @ApiProperty({ description: 'En-tête portant la signature « sha256=<hex> ».' }) signatureHeader!: string;
  @ApiProperty({ description: 'Chaîne signée par HMAC-SHA256 avec le secret de signature.' }) signedContent!: string;
  @ApiProperty() formatVersion!: number;
  @ApiProperty() maxBodyBytes!: number;
  @ApiProperty() maxSamplesPerList!: number;
  @ApiProperty() maxRequestsPerMinute!: number;
  @ApiProperty() toleranceSeconds!: number;
  @ApiProperty() rotationOverlapHours!: number;
  @ApiProperty({ type: CredentialStatusDto, description: 'État du secret de signature (jamais sa valeur).' }) secret!: CredentialStatusDto;
  @ApiProperty({ type: WebhookCountsDto }) counts!: WebhookCountsDto;
  @ApiProperty({ type: [WebhookDeliveryViewDto], description: 'Derniers lots reçus (20 au plus).' }) recent!: WebhookDeliveryViewDto[];
  @ApiPropertyOptional({ nullable: true, type: String, description: 'Avertissement (fournisseur non actif, secret absent).' }) notice?: string | null;
}
