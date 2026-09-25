import { Injectable } from '@nestjs/common';

/**
 * Seuils des exports (D-272, D-273) : synchrone en flux jusqu'à `syncMaxRows` lignes, job différé au-delà,
 * plafond `maxRows`, fichier différé conservé `retentionMs`. Fournisseur injectable : les tests
 * d'intégration abaissent le seuil synchrone sans créer des milliers de lignes.
 */
@Injectable()
export class ReportExportPolicy {
  syncMaxRows = 5_000;
  maxRows = 100_000;
  retentionMs = 24 * 3600 * 1000;
  /** Lignes lues par lot pendant un export différé (progression). */
  chunkSize = 2_000;
}
