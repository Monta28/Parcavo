# Conservation des données

Référence : cahier des charges v1.1, sections 16.1, 16.2 (« définir la conservation selon les obligations validées avec le client ; ne pas annoncer une conformité juridique universelle »), 16.4 et 17.1. Ce document recense **les durées réellement appliquées par le code en V1** et ce qui reste à décider avec le client. Il ne constitue pas un avis juridique : aucune conformité à une réglementation particulière (protection des données personnelles, obligations comptables ou fiscales) n'est annoncée.

La correspondance entre ce document et le code est vérifiée par `apps/api/src/data-retention-doc.spec.ts` (constantes et paramètres) ; le rôle et la politique de fin de vie de chaque table sont dans [`modele-de-donnees.md`](modele-de-donnees.md).

## Durées appliquées par le code

| Donnée | Durée | Ce qui se passe à l'échéance | Où |
| --- | --- | --- | --- |
| Session de connexion | 12 h par défaut, paramètre `session.ttlHours` (1 à 72 h, Administration › Paramètres) | La session expire ; elle est révocable avant (déconnexion, désactivation du compte, révocation manuelle). | `SessionService.issue` |
| Ligne de session expirée ou révoquée | 30 jours après l'expiration ou la révocation | Suppression physique (purge quotidienne du worker). | `SessionService.purge`, `DailyPurgeJob` |
| Lien de réinitialisation du mot de passe | 30 minutes, usage unique | Lien refusé ; seule l'empreinte du jeton est stockée, la ligne est conservée. | `AuthService` (`RESET_TOKEN_TTL_MS`) |
| Lien d'invitation (généré par l'administrateur) | 72 heures, usage unique | Lien refusé ; ligne conservée (empreinte). | `UsersService.createAccessLink` |
| Tentatives de connexion | Fenêtre de limitation de 15 minutes ; lignes conservées 30 jours | Suppression physique après 30 jours (purge quotidienne). | `AuthService` (`LOCKOUT_WINDOW_MS`), `DailyPurgeJob` (`LOGIN_ATTEMPT_RETENTION_DAYS`) |
| Clés d'idempotence | 24 heures | Suppression physique (purge quotidienne) ; clé libérée aussitôt si l'opération échoue. | `IdempotencyService` |
| Fichier temporaire jamais rattaché à son objet | 24 heures | Contenu effacé du stockage, ligne marquée supprimée (`deletedAt`). | `AttachmentsService.purgeAbandoned`, `DailyPurgeJob` |
| Fichier d'export différé (CSV, XLSX) | 24 heures | Contenu effacé du stockage (contrôle toutes les 15 minutes), téléchargement refusé comme expiré ; la trace du job est conservée. | `ReportExportPolicy.retentionMs`, `JobQueueJob` |
| Lot d'import non confirmé | 7 jours | Lot abandonné automatiquement (action système auditée). | `ImportRetentionService` (`IMPORT_ABANDON_AFTER_DAYS`) |
| Valeurs brutes des lignes et fichier source d'un lot d'import | 90 jours après la fin du lot (confirmation ou abandon) | Valeurs brutes vidées, fichier source effacé du stockage ; statut, erreurs et rapport conservés. | `ImportRetentionService` (`IMPORT_DATA_RETENTION_DAYS`) |
| Échantillons carburant télématiques | 90 jours, paramètre `telemetry.fuelSampleRetentionDays` (7 à 730 jours) | Suppression physique, puis suppression des partitions mensuelles échues (rétention quotidienne). | `TelemetryPurgeService`, `DailyRetentionJob` |
| Échantillons d'odomètre télématiques (calibrage GPS) | 90 jours, paramètre `telemetry.odometerSampleRetentionDays` (7 à 730 jours) | Idem. | `TelemetryPurgeService`, `DailyRetentionJob` |
| Lots reçus par webhook télématique | 7 jours après leur traitement | Suppression physique. | `TelemetrySyncService` (`WEBHOOK_RETENTION_DAYS`) |
| Ancien secret de signature webhook | Période de recouvrement du fournisseur (`rotationOverlapHours`) | Suppression physique du secret remplacé. | `TelemetryCredentialsService.purgeExpiredSigningSecrets` |
| Traces des traitements planifiés du worker | 30 jours après leur fin | Suppression physique. | `DailyPurgeJob` (`SCHEDULED_RUN_RETENTION_DAYS`) |
| Pièce jointe supprimée par un utilisateur habilité | Immédiat, après validation de la transaction | Contenu effacé du stockage ; ligne conservée avec `deletedAt`, motif et audit (`piece_jointe.suppression`). | `AttachmentsService.discard` |
| Sauvegardes (base et pièces jointes) | 30 jours, variable `BACKUP_RETENTION_DAYS` | Archives chiffrées plus anciennes supprimées par le script de sauvegarde. | `scripts/ops/backup.sh`, [`sauvegarde-restauration.md`](sauvegarde-restauration.md) |

## Données conservées sans limite en V1

Aucune purge automatique n'est faite pour :

- les données métier : sociétés, sites, utilisateurs, conducteurs et permis, véhicules et leur historique de société, affectations, réservations, utilisations, relevés et segments de compteur, plans et interventions d'entretien, documents et leurs justificatifs, incidents, immobilisations, fournisseurs, pleins, dépenses, alertes et événements carburant. Elles sont archivées, désactivées ou clôturées par statut, jamais effacées (voir `modele-de-donnees.md`) ;
- le journal d'audit (`AuditEvent`), en ajout seul, protégé contre la modification et la suppression par un déclencheur SQL ;
- les versions de paramètres (`SettingValue`) et les exécutions de synchronisation télématique (`TelemetrySyncRun`) ;
- la file des e-mails (`NotificationOutbox`), y compris le texte des messages envoyés ; les liens d'invitation ou de réinitialisation qu'ils contiennent deviennent inutilisables à leur expiration (72 h ou 30 min) ou après usage ;
- les lignes de liens d'accès utilisés ou expirés (`PasswordResetToken`, empreintes seulement) et les battements des processus worker (`WorkerHeartbeat`).

## À valider avec le client (dépendance externe)

Le cahier des charges renvoie la conservation aux « obligations validées avec le client ». Les points suivants ne peuvent pas être décidés par l'équipe de réalisation et restent ouverts :

1. Durée de conservation des pièces justificatives et des dépenses (factures, tickets de carburant) au regard des obligations comptables et fiscales applicables au client, et sort des fichiers à l'échéance.
2. Durée de conservation des données personnelles des conducteurs et des utilisateurs après leur départ (fiche désactivée, permis et justificatifs, historique des utilisations), et procédure d'anonymisation ou d'effacement sur demande.
3. Durée de conservation du journal d'audit et des traces de connexion au-delà des durées techniques ci-dessus.
4. Purge de la file des e-mails envoyés (`NotificationOutbox`) et des traces d'exécution télématique (`TelemetrySyncRun`).
5. Durée de rétention des sauvegardes (30 jours proposés par le CDC 16.4) et de la copie hors du serveur, selon le contrat d'hébergement.
6. Rotation et durée de conservation des journaux applicatifs des conteneurs, fixées par la configuration Docker de l'hébergeur.

Tant que ces points ne sont pas arbitrés, aucune suppression n'est faite au-delà des durées techniques listées plus haut ; une suppression de fichier par un utilisateur reste logique pour la ligne, motivée et auditée (CDC 16.2).
