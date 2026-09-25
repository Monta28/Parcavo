import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';

/** Réponse de /health/live (CDC 16.3). */
export class LivenessDto {
  @ApiProperty({ type: String, enum: ['vivant'] }) status!: 'vivant';
}

/** Résultat d'un contrôle de disponibilité ; le détail ne contient jamais de secret. */
export class ReadinessCheckDto {
  @ApiProperty({ type: Boolean }) ok!: boolean;
  @ApiProperty({ type: String }) detail!: string;
}

/**
 * Réponse de /health/ready (D-315) : 200 « pret » si la base (lecture, hors mode lecture seule) et le
 * stockage (répertoire lisible et inscriptible) sont accessibles, 503 « degrade » sinon. Le battement du
 * worker y figure à titre d'information ; son état fait autorité sur /health/worker.
 */
@ApiExtraModels(ReadinessCheckDto)
export class ReadinessReportDto {
  @ApiProperty({ type: String, enum: ['pret', 'degrade'] }) status!: 'pret' | 'degrade';

  @ApiProperty({
    type: 'object',
    description: 'Contrôles par composant : database et storage (déterminent le code HTTP), worker (information, même règle que /health/worker).',
    additionalProperties: { $ref: getSchemaPath(ReadinessCheckDto) },
  })
  checks!: Record<string, ReadinessCheckDto>;

  @ApiProperty({ type: String, format: 'date-time' }) checkedAt!: string;
}

/**
 * Réponse de /health/worker (D-315) : 200 « actif » si un battement date de deux minutes au plus, 503
 * sinon (« arrete » : aucun battement récent ; « inconnu » : battement illisible, base injoignable).
 * Aucun identifiant d'hôte, version ni secret n'est exposé.
 */
export class WorkerHealthDto {
  @ApiProperty({ type: String, enum: ['actif', 'arrete', 'inconnu'] }) status!: 'actif' | 'arrete' | 'inconnu';
  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Dernier battement enregistré (UTC), tous processus worker confondus.' }) lastBeatAt!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Âge du dernier battement en secondes.' }) ageSeconds!: number | null;
  @ApiProperty({ type: Number, description: 'Seuil au-delà duquel le worker est considéré arrêté (secondes).' }) staleAfterSeconds!: number;
  @ApiProperty({ type: String }) detail!: string;
  @ApiProperty({ type: String, format: 'date-time' }) checkedAt!: string;
}
