# Plan de réalisation et lots

Ordre de construction retenu (CDC 19.1). Chaque lot comprend API, base, interface, droits et tests ; l'état de chaque exigence (implémentée, testée, non testée, dépendance externe) est suivi dans `docs/traceability/status.json`, et les écarts assumés sont consignés dans `docs/DECISIONS.md` (D-016).

| Lot | Contenu (CDC 19.1) | Emplacements principaux |
| --- | --- | --- |
| A | Socle, authentification, habilitations, sociétés, sites, fichiers privés, véhicules et conducteurs | `apps/api/src/modules/auth`, `apps/api/src/modules/access-control`, `apps/api/src/modules/organizations`, `apps/api/src/modules/attachments`, `apps/api/src/modules/vehicles`, `apps/api/src/modules/drivers` ; écrans `vehicules`, `conducteurs`, `administration` |
| B | Responsable habituel, réservations, utilisations, relevés, corrections et localisation déclarative | `apps/api/src/modules/assignments`, `apps/api/src/modules/reservations`, `apps/api/src/modules/usages`, `apps/api/src/modules/odometer` ; écrans `planning`, `utilisations`, `kilometrage`, `mon-vehicule` |
| C | Plans d'entretien, interventions, documents, incidents et immobilisations | `apps/api/src/modules/maintenance`, `apps/api/src/modules/interventions`, `apps/api/src/modules/documents`, `apps/api/src/modules/incidents`, `apps/api/src/modules/immobilizations` ; écrans `entretiens`, `interventions`, `documents`, `incidents`, `immobilisations` |
| D | Carburant, registre de dépenses, alertes, e-mail et worker, ainsi que le transfert inter-sociétés | voir ci-dessous |
| E | Tableaux de bord, mobile, imports/exports, audit, tests complets et déploiement | `apps/api/src/modules/dashboard`, `apps/api/src/modules/reports`, `apps/api/src/modules/imports`, `apps/api/src/modules/audit` ; écrans `tableau-de-bord`, `rapports`, `imports` |
| F | Connecteur télématique (qualification du fournisseur, canal retenu, mapping des unités, kilométrage, carburant, alertes F11) | `apps/api/src/modules/telemetry` ; écran `telematique` ; `docs/connecteur-telematique.md` |

## Lot D — carburant, dépenses, alertes, e-mail, worker et transfert

| Domaine | API | Écrans (`apps/web/app/(app)/…`) | Tests automatisés |
| --- | --- | --- | --- |
| Carburant (8.2, 8.3) | `apps/api/src/modules/fuel` (saisie, soumission conducteur, validation, correction, consommation) | `carburant`, `mon-vehicule`, onglet consommation du véhicule | `apps/api/test/integration/fuel.int.spec.ts` (T24, T25), `apps/api/src/domain/consumption.spec.ts`, `tests/e2e/specs/carburant.spec.ts` |
| Registre des dépenses (8.4) | `apps/api/src/modules/expenses` (saisie, avoir, correction, annulation, synthèse, détail) | `depenses`, `depenses/[id]` | `apps/api/test/integration/expenses.int.spec.ts`, `apps/api/test/integration/expenses-ledger-integrity.int.spec.ts`, `tests/e2e/specs/depenses-alertes.spec.ts`, `tests/e2e/specs/depenses-fournisseurs.spec.ts` |
| Fournisseurs (8.1) | `apps/api/src/modules/suppliers` (répertoire, archivage, copie) | `fournisseurs` | `apps/api/test/integration/suppliers.int.spec.ts`, `apps/api/test/integration/suppliers-directory.int.spec.ts`, `tests/e2e/specs/depenses-fournisseurs.spec.ts` |
| Alertes (9.1 à 9.3) | `apps/api/src/modules/alerts` (création dédupliquée, lecture, report, compteurs) | `alertes` | `apps/api/test/integration/alerts.int.spec.ts` (T19, T20), `apps/api/test/integration/alerts-occurrences.int.spec.ts`, `apps/api/test/integration/organization-timezone.int.spec.ts`, `tests/e2e/specs/alertes-notifications.spec.ts` |
| E-mail (9.4) | `apps/api/src/modules/notifications` (outbox, préférences, état du canal) | `administration/notifications`, `profil/notifications` | `apps/api/test/integration/alerts.int.spec.ts` (T29), `apps/worker/src/jobs/outbox-dispatcher.job.spec.ts` |
| Worker (14.1, 14.4) | `apps/worker/src/scheduler`, `apps/worker/src/jobs` (rattrapage, outbox, récapitulatif, purge, file de jobs), battement contrôlé par `apps/api/src/modules/health` | — | `apps/worker/src/scheduler/worker-scheduler.service.spec.ts`, `apps/worker/src/jobs/daily-jobs.spec.ts`, `apps/api/test/integration/health.int.spec.ts` |
| Transfert (2.4) | `apps/api/src/modules/vehicles/vehicle-transfer.service.ts` (aperçu, objets bloquants, responsables éligibles, transfert transactionnel) | fiche du véhicule (`vehicules/[id]`) | `apps/api/test/integration/vehicle-transfer.int.spec.ts` (T26), `apps/api/test/integration/vehicle-transfer-preconditions.int.spec.ts`, `tests/e2e/specs/transfert.spec.ts` |

Tests de recette du lot : T19, T20, T24, T25, T26 et T29 (CDC 18), exécutés contre PostgreSQL réel (intégration) et contre la pile compilée (parcours Playwright). Le rapport de recette avec les commandes et les résultats réels (docs/rapport-recette.md, CDC 19.2) relève du lot E et n'est pas encore rédigé.
