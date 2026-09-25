# Modèle de données

Référence : cahier des charges v1.1, section 13 (13.1 conventions, 13.2 entités, 13.3 intégrité). Schéma : `packages/db/prisma/schema.prisma` ; contraintes non représentables en Prisma (EXCLUDE, CHECK, déclencheurs, partitions) : migrations SQL `packages/db/prisma/migrations`. Décisions : D-003, D-283 (conventions, tables globales, suppression physique), D-312 (fichiers). Les durées de conservation sont détaillées dans [`conservation-des-donnees.md`](conservation-des-donnees.md).

Ce document est contrôlé automatiquement : `apps/api/src/data-model-doc.spec.ts` échoue si une table du schéma n'y figure pas, si la liste des tables globales ne correspond plus au schéma ou si le code supprime physiquement des lignes d'une table absente de la section « Suppressions physiques » ; `apps/api/test/integration/data-model.int.spec.ts` compare la liste des tables globales à la base PostgreSQL réelle migrée.

## Conventions (13.1)

- Identifiants UUID v7 ; `createdAt`, `updatedAt`, `createdById` et `version` (verrou optimiste, `expectedVersion`) sur toute table modifiée par l'API. Les tables en ajout seul n'ont pas de `version`.
- `organizationId` sur toutes les données métier ; relations protégées par des clés composites `(id, organizationId)` : une relation entre organisations est impossible. `companyId` sur les objets appartenant à une société ; les événements (relevés, utilisations, pleins, dépenses, incidents, audit…) portent leur `companyId` historique, jamais recalculé après un transfert.
- Montants et quantités `DECIMAL(18,3)`, kilomètres `DECIMAL(15,3)` ; horodatages `TIMESTAMPTZ` (UTC) ; échéances civiles en `DATE`.
- Statuts en énumérations PostgreSQL. Les colonnes d'acteur (`createdById`, `approvedById`…) ne portent pas de clé étrangère : les utilisateurs ne sont jamais supprimés.

## Tables techniques globales

Tables sans `organizationId`, volontairement communes à l'installation :

| Table | Rôle | Pourquoi globale |
| --- | --- | --- |
| `Organization` | Racine : le groupe (une seule organisation en V1, D-102). | C'est l'organisation elle-même ; toutes les autres tables s'y rattachent. |
| `JobLease` | Bail d'exécution d'un traitement planifié du worker (une ligne par traitement). | Élection d'une seule instance du worker, quelle que soit l'organisation (D-004). |
| `WorkerHeartbeat` | Battement de chaque processus worker (une ligne par processus). | Santé « prêt » de l'installation (16.3), indépendante des organisations. |
| `LoginAttempt` | Tentatives de connexion (adresse normalisée, IP, succès). | Limitation de débit avant authentification : l'organisation n'est pas connue et un compte inexistant doit être traité comme les autres (messages non énumérants). |
| `_prisma_migrations` | Historique des migrations appliquées (géré par Prisma). | Technique, propre au schéma de la base. |

Les partitions mensuelles des échantillons télématiques (`TelemetryOdometerSample_AAAAMM`, `FuelLevelSample_AAAAMM` et leurs partitions `_default`) sont des tables filles créées par les fonctions SQL `ensure_month_partitions` ; elles portent les colonnes de leur table mère, dont `organizationId`.

## Politique de fin de vie

- **Archivage ou désactivation** : l'objet reste en base, masqué des listes courantes et des choix, avec son historique complet (statut `ARCHIVE`, `DESACTIVE`, `INACTIF`, cycle de vie véhicule, `active = false`).
- **Clôture par statut** : les événements ne sont jamais effacés ; ils sont annulés, remplacés, rejetés ou terminés (`ANNULEE`, `REMPLACE`, `REJETE`, `TERMINEE`…), avec motif et audit.
- **Ajout seul** : lignes jamais modifiées (journal d'audit protégé par déclencheur SQL, historiques, versions).
- **Suppression logique** : `deletedAt` renseigné, ligne conservée (pièces jointes), audit motivé.
- **Suppression physique** : seulement les cas listés plus bas (données techniques expirées, brouillons jamais utilisés, lignes dépendantes remplacées dans la même transaction que leur objet), toujours bornée par le code.

## Tables

| Table | Rôle | Portée | Fin de vie |
| --- | --- | --- | --- |
| `Organization` | Groupe : nom, fuseau, devise TND, décimales. | globale | Jamais supprimée. |
| `Company` | Société du groupe. | organisation | Archivage (`status`, `archivedAt`) ; jamais supprimée. |
| `Site` | Site d'une société. | société | Archivage (`status`). |
| `Department` | Service d'un site ou d'une société. | société | Archivage (`status`). |
| `User` | Compte utilisateur. | organisation | Désactivation (`status = DESACTIVE`, sessions révoquées) ; jamais supprimé. |
| `Membership` | Rôle d'un compte dans une société (ou ADMIN au niveau groupe) et permissions accordées ou retirées. | organisation | Remplacement en bloc lors de la modification des habilitations d'un compte (suppression physique, audit avant/après). |
| `Session` | Session serveur révocable (empreinte du jeton, jeton CSRF lié). | organisation | Révocation (`revokedAt`) ; purge 30 jours après expiration ou révocation. |
| `PasswordResetToken` | Lien d'invitation ou de réinitialisation à usage unique (empreinte). | organisation | Invalidation (`usedAt`, `expiresAt`) ; conservé. |
| `LoginAttempt` | Tentative de connexion pour la limitation persistante. | globale | Purge après 30 jours. |
| `NotificationPreference` | Préférences e-mail d'un utilisateur (gravité minimale, récapitulatif). | organisation | Modifiée ; conservée. |
| `VehicleCategory` | Catégorie de véhicule et catégories de permis exigées. | organisation | Archivage (`status`). |
| `Driver` | Fiche conducteur. | société | Désactivation (`status = INACTIF`, affectation habituelle close) ; jamais supprimée. |
| `DriverPermit` | Permis : numéro, catégories, dates, justificatif. | organisation | Versionné, conservé. |
| `Vehicle` | Véhicule. | société | Cycle de vie (`HORS_SERVICE`, `CEDE`, `ARCHIVE`, `archivedAt`) ; jamais supprimé. |
| `VehicleCompanyHistory` | Sociétés gestionnaires successives (création, transferts). | organisation | Ajout seul. |
| `VehicleResponsibleAssignment` | Affectation habituelle (responsable principal sur une période). | société | Terminée (`endsAt`, motif) ; une affectation à venir est retirée physiquement lors d'un transfert ou de la sortie du conducteur ou du véhicule (audit). |
| `Reservation` | Réservation d'un véhicule. | société | Statut (`ANNULEE`, `NON_HONOREE`, `CONVERTIE`) ; jamais supprimée. |
| `VehicleUsage` | Utilisation réelle : remise puis restitution. | société | Statut (`TERMINEE`) ; jamais supprimée. |
| `VehicleLocationReport` | Dernière localisation déclarée (jamais une position temps réel). | société | Ajout seul. |
| `OdometerSegment` | Segment de compteur (remplacement de compteur). | organisation | Clos (`endedAt`) ; jamais supprimé. |
| `OdometerReading` | Relevé kilométrique. | société | Statut (`REJETE`, `REMPLACE`) ; jamais écrasé ni supprimé. |
| `MaintenanceType` | Opération d'entretien du catalogue. | organisation | Archivage (`status`). |
| `MaintenancePlanTemplate` | Modèle de plan d'entretien. | organisation | Archivage (`status`). |
| `MaintenancePlanTemplateItem` | Ligne d'un modèle de plan. | organisation | Remplacée en bloc à la modification du modèle (les plans déjà copiés ne changent pas). |
| `VehicleMaintenancePlan` | Plan d'entretien d'un véhicule pour une opération (échéances matérialisées). | société | Désactivation (`active = false`) ; conservé. |
| `Intervention` | Intervention d'entretien ou de réparation. | société | Statut (`ANNULEE`, `TERMINEE`, réouverture motivée) ; jamais supprimée. |
| `ReferenceSequence` | Compteur des références métier par portée et année. | organisation | Conservé. |
| `InterventionTask` | Opération réalisée par une intervention (met à jour son plan). | organisation | Remplacée en bloc tant que l'intervention est modifiable. |
| `InterventionLine` | Ligne de coût (pièces, main-d'œuvre). | organisation | Remplacée à chaque saisie du coût ou à la clôture ; retirée à la réouverture, dont la dépense est annulée (audit). |
| `DocumentType` | Type de document exigé (véhicule ou conducteur). | organisation | Archivage (`status`). |
| `DocumentVersion` | Version d'un document (assurance, visite…) avec échéance. | société | Renouvellement par nouvelle version ; retrait logique (`archivedAt`) motivé. |
| `Incident` | Incident déclaré. | société | Statut (`RESOLU`, `CLOTURE`) ; jamais supprimé. |
| `IncidentComment` | Commentaire d'incident. | organisation | Ajout seul. |
| `Immobilization` | Immobilisation d'un véhicule. | société | Statut (`TERMINEE`, `endedAt`) ; jamais supprimée. |
| `ImmobilizationCause` | Cause d'une immobilisation. | organisation | Close (`endedAt`) ; conservée. |
| `Supplier` | Fournisseur (garage, station…). | société | Archivage (`status`, `archivedAt`). |
| `FuelEntry` | Plein ou achat de carburant. | société | Statut (`REJETE`, `ANNULE`, `REMPLACE`) ; jamais supprimé. |
| `FuelPurchaseGap` | Période déclarée « achats incomplets ». | société | Conservée. |
| `Expense` | Registre unique des dépenses. | société | Statut (`ANNULEE`, `REMPLACEE`) ; jamais supprimée. |
| `Attachment` | Métadonnées d'un fichier privé (le contenu est dans le stockage). | société ou groupe | Suppression logique (`deletedAt`) motivée et auditée ; contenu effacé du stockage (voir plus bas). |
| `Alert` | Alerte métier dédupliquée. | société | Statut (`RESOLUE`) ; conservée. |
| `AlertRecipientState` | État de lecture et report d'une alerte par utilisateur. | organisation | Conservé avec son alerte. |
| `NotificationOutbox` | File persistante des e-mails. | organisation | Statut (`ENVOYE`, `ABANDONNE`, `ANNULE`) ; conservée en V1. |
| `Job` | Traitement différé (exports) et trace des traitements planifiés. | organisation ou installation | Traces `planifie.*` purgées 30 jours après leur fin ; les autres conservées. |
| `JobLease` | Bail d'exécution d'un traitement planifié. | globale | Une ligne par traitement, réutilisée. |
| `WorkerHeartbeat` | Battement d'un processus worker. | globale | Une ligne par processus, mise à jour ; conservée. |
| `TelemetryProvider` | Fournisseur télématique configuré (F11). | organisation | Statut (`SUSPENDU`, `DESACTIVE`) ; un brouillon jamais synchronisé peut être supprimé (audit). |
| `TelemetryProviderCompany` | Société couverte par un fournisseur. | société | Retirée quand la couverture est réduite ; supprimée avec un brouillon. |
| `TelemetryCredential` | Secret chiffré au repos d'un fournisseur. | organisation | Remplacé ou révoqué par suppression (le secret n'est jamais conservé) ; secret de signature remplacé supprimé après sa période de recouvrement. |
| `TelemetryUnit` | Boîtier déclaré par le fournisseur. | organisation | Ignoré (`ignoredAt`, motif) ; conservé. |
| `TelemetryVehicleMapping` | Association unité ↔ véhicule. | société | Statut (`REJETE`, `CLOTURE`) ; conservée. |
| `TelemetryUnitState` | Dernier état reçu d'une unité. | organisation | Mis à jour à chaque synchronisation. |
| `TelemetrySyncRun` | Exécution de synchronisation (volumes, résultat). | organisation | Ajout seul ; conservée. |
| `TelemetryReportFile` | Fichier de rapport déjà traité (idempotence par empreinte). | organisation | Conservé. |
| `TelemetryCalibration` | Calibrage d'une distance GPS sur un relevé manuel. | organisation | Ajout seul. |
| `TelemetryOdometerSample` | Échantillon brut d'odomètre (partitionné par mois). | organisation | Purge après `telemetry.odometerSampleRetentionDays` (90 jours) ; partitions échues supprimées. |
| `FuelLevelSample` | Échantillon de niveau ou de consommation carburant (partitionné par mois). | organisation | Purge après `telemetry.fuelSampleRetentionDays` (90 jours) ; partitions échues supprimées. |
| `FuelEvent` | Événement carburant détecté, à qualifier. | société | Statut (`QUALIFIE`) ; conservé. |
| `AuditEvent` | Journal d'audit (acteur, objet, motif, avant/après expurgés). | société ou groupe | Ajout seul, `UPDATE`/`DELETE` bloqués par déclencheur ; conservé. |
| `ImportBatch` | Lot d'import CSV/XLSX. | organisation | Abandon automatique après 7 jours sans confirmation ; statut conservé. |
| `ImportRow` | Ligne d'un lot et son résultat de contrôle. | société | Remplacée à chaque nouveau contrôle du lot ; valeurs brutes vidées 90 jours après la fin du lot. |
| `SettingValue` | Version d'un paramètre (valeur groupe ou surcharge société). | organisation | Ajout seul (`isCurrent` désigne la version en vigueur). |
| `IdempotencyRecord` | Clé d'idempotence liée à l'utilisateur, l'organisation et l'opération. | organisation | Purge après 24 h ; supprimée aussitôt si l'opération échoue. |

## Suppressions physiques

Suppressions de lignes réellement faites par le code (hors tests), toutes dans une transaction avec leur objet ou par un traitement planifié du worker :

| Table | Cas | Code |
| --- | --- | --- |
| `Session` | Sessions expirées ou révoquées depuis plus de 30 jours (purge quotidienne). | `apps/api/src/modules/auth/session.service.ts` (`purge`), `apps/worker/src/jobs/daily-purge.job.ts` |
| `LoginAttempt` | Tentatives de plus de 30 jours (purge quotidienne). | `apps/worker/src/jobs/daily-purge.job.ts` |
| `IdempotencyRecord` | Clés expirées (24 h) ; clé d'une opération en échec, libérée pour une nouvelle tentative. | `apps/api/src/common/idempotency.service.ts` |
| `Job` | Traces des traitements planifiés (`planifie.*`) terminés depuis plus de 30 jours. | `apps/worker/src/jobs/daily-purge.job.ts` |
| `Membership` | Habilitations d'un compte remplacées en bloc par l'administrateur (audit avant/après). | `apps/api/src/modules/users/users.service.ts` |
| `VehicleResponsibleAssignment` | Affectation habituelle à venir retirée lors d'un transfert de véhicule ou de la sortie d'un conducteur ou d'un véhicule (l'affectation en cours est seulement terminée). | `apps/api/src/modules/vehicles/vehicle-transfer.service.ts`, `apps/api/src/modules/assignments/assignment-exit.ts` |
| `MaintenancePlanTemplateItem` | Lignes d'un modèle de plan remplacées à sa modification. | `apps/api/src/modules/maintenance/maintenance-catalog.service.ts` |
| `InterventionTask` | Opérations d'une intervention remplacées tant qu'elle est modifiable. | `apps/api/src/modules/interventions/interventions.service.ts` |
| `InterventionLine` | Lignes de coût remplacées à la clôture ou à la saisie du coût, retirées à la réouverture (dépense liée annulée, audit). | `apps/api/src/modules/interventions/interventions.service.ts` |
| `ImportRow` | Résultats de contrôle d'un lot remplacés à chaque nouveau contrôle, avant confirmation. | `apps/api/src/modules/imports/imports.service.ts` |
| `TelemetryProvider` | Fournisseur en brouillon jamais synchronisé (ni unité ni exécution), avec ses sociétés et secrets (cascade). | `apps/api/src/modules/telemetry/telemetry-providers.service.ts` |
| `TelemetryProviderCompany` | Sociétés retirées de la couverture d'un fournisseur. | `apps/api/src/modules/telemetry/telemetry-providers.service.ts` |
| `TelemetryCredential` | Secret remplacé ou révoqué ; secret de signature webhook remplacé, après sa période de recouvrement. | `apps/api/src/modules/telemetry/telemetry-credentials.service.ts` |
| `FuelLevelSample` | Échantillons au-delà de la rétention ; partitions mensuelles échues supprimées (`drop_month_partitions_before`). | `apps/api/src/modules/telemetry/sync/telemetry-purge.service.ts` |
| `TelemetryOdometerSample` | Échantillons au-delà de la rétention ; partitions mensuelles échues supprimées. | `apps/api/src/modules/telemetry/sync/telemetry-purge.service.ts` |

Suppressions en cascade (clés étrangères `ON DELETE CASCADE`) : `TelemetryProviderCompany` et `TelemetryCredential` avec leur fournisseur brouillon ; `MaintenancePlanTemplateItem`, `InterventionTask`, `InterventionLine`, `AlertRecipientState`, `TelemetryUnitState` et `ImportRow` avec leur parent, lequel n'est jamais supprimé par le code (archivage ou statut).

La commande de démonstration `seed:demo --reset` vide toutes les tables (`TRUNCATE`) d'une base de démonstration ; elle refuse de s'exécuter en production.

## Fichiers du stockage privé

Le contenu d'un fichier est effacé du stockage (la ligne `Attachment` reste, avec `deletedAt`) : fichier temporaire jamais rattaché depuis 24 h, export différé au-delà de 24 h, fichier source d'un lot d'import 90 jours après la fin du lot, et pièce supprimée par un utilisateur habilité (après validation de la transaction, suppression motivée et auditée). Tous les autres fichiers métier sont conservés en V1 (D-312).
