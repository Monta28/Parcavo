# Architecture et arborescence du monorepo

Référence : cahier des charges v1.1, sections 13 et 14. Ce document décrit la structure retenue ; les choix motivés sont dans `DECISIONS.md`, la couverture des exigences dans `TRACEABILITY.md`.

## Socle figé

| Composant | Version | Justification |
| --- | --- | --- |
| Node.js | 24.21.0 (LTS « Krypton ») | LTS active à la date d'initialisation ; même version dans les images Docker (`.node-version`). |
| pnpm | 10.34.5 | Champ `packageManager`, workspaces. |
| TypeScript | 5.9.3 | Version supportée simultanément par Next 16, NestJS 12, Prisma 7 et typescript-eslint 8. |
| Next.js | 16.3.6 (App Router) | Frontend `apps/web`. React 19.2.8 (version épinglée par `create-next-app@16.3.6`). |
| NestJS | 12.1.0 | API REST `apps/api` et worker `apps/worker` (ESM, `nodenext`). |
| Prisma | 7.10.0 + `@prisma/adapter-pg` | Schéma `packages/db/prisma/schema.prisma`, migrations SQL versionnées. |
| PostgreSQL | 16 (image `postgres:16.15-alpine` par digest) | Contraintes d'exclusion `btree_gist`, index partiels, partitionnement. |
| Tailwind CSS | 4.3.3 | Avec composants shadcn/ui vendorisés (`apps/web/components/ui`). |
| Vitest | 4.1.11 | Tests unitaires et d'intégration (API, worker, packages). |
| Playwright | 1.63.0 | Parcours navigateur `tests/e2e` (Chromium). |
| ESLint | 9.39.5 + typescript-eslint 8.70.1 | Lint de l'ensemble du monorepo ; `eslint-config-next` pour `apps/web`. |

Aucune image Docker `:latest` ; les images sont épinglées par tag et digest dans `docker/` et `docker-compose.prod.yml`.

## Arborescence

```
.
├── apps/
│   ├── api/                       # NestJS — API REST /api/v1, OpenAPI, autorisations serveur
│   │   ├── src/
│   │   │   ├── main.ts            # bootstrap HTTP (cookies, CSRF, en-têtes, OpenAPI /api/docs)
│   │   │   ├── app.module.ts
│   │   │   ├── common/            # transverse : erreurs, pagination, clock, idempotence, verrou optimiste,
│   │   │   │                      #   contexte de requête, garde CSRF, limitation de débit, csv-safety
│   │   │   ├── domain/            # règles de calcul pures, une seule implémentation, testées avec horloge
│   │   │   │   ├── odometer-rules.ts        # chronologie, plausibilité, cumul par segment (5.2 à 5.4)
│   │   │   │   ├── freshness.ts             # INCONNU / A_ACTUALISER / A_JOUR (5.5)
│   │   │   │   ├── vehicle-status.ts        # IMMOBILISE > EN_UTILISATION > DISPONIBLE (3.2)
│   │   │   │   ├── maintenance-schedule.ts  # échéances km/date, statuts (6.2), mois calendaires
│   │   │   │   ├── document-status.ts       # MANQUANT / VALIDE / A_RENOUVELER / EXPIRE (7.1)
│   │   │   │   ├── consumption.ts           # L/100 km entre pleins complets (8.3)
│   │   │   │   ├── gps-calibration.ts       # kmEstime, dérive en % (5.6)
│   │   │   │   ├── fuel-events.ts           # remplissage, baisse anormale, écart ticket (8.5)
│   │   │   │   ├── civil-date.ts            # dates civiles Africa/Tunis, fin de journée locale
│   │   │   │   └── money.ts                 # décimaux exacts, tolérance litres x prix (8.2)
│   │   │   ├── infra/             # Prisma (adapter pg), stockage de fichiers, chiffrement, SMTP, audit sink
│   │   │   └── modules/           # un dossier par module de la section 14.2
│   │   │       ├── auth/            access-control/   organizations/   users/
│   │   │       ├── drivers/         vehicles/         attachments/     assignments/
│   │   │       ├── reservations/    usages/           odometer/        maintenance/
│   │   │       ├── interventions/   documents/        incidents/       immobilizations/
│   │   │       ├── suppliers/       fuel/             expenses/        alerts/
│   │   │       ├── notifications/   reports/          imports/         telemetry/
│   │   │       ├── audit/           settings/         health/
│   │   │       └── (chaque module : *.controller.ts, *.service.ts, dto/, *.spec.ts)
│   │   └── test/
│   │       ├── integration/       # vraie PostgreSQL (Docker), requêtes HTTP réelles, concurrence
│   │       └── support/           # démarrage app de test, horloge contrôlable, fabriques de données
│   ├── worker/                    # NestJS standalone : jobs PostgreSQL, outbox, synchronisation F11
│   │   └── src/jobs/              # alert-catch-up, outbox-dispatcher, daily-digest, telemetry-sync,
│   │                              #   retention, temp-files-cleanup, report-export, heartbeat
│   ├── web/                       # Next.js App Router, français, responsive
│   │   ├── app/(auth)/            # /login, /mot-de-passe-oublie, /reinitialisation
│   │   ├── app/(app)/             # routes de la section 10.2 (tableau-de-bord, vehicules, ..., mon-vehicule)
│   │   ├── components/ui/         # shadcn/ui vendorisé
│   │   ├── components/            # composants métier (tables, filtres, formulaires, états vides/erreur)
│   │   └── lib/                   # client API typé (contrats OpenAPI), session côté serveur, formats FR
│   └── telemetry-rpa/             # ABSENT en V1 : canal RPA non retenu (interface documentée seulement)
├── packages/
│   ├── db/                        # Prisma : schéma, migrations SQL, client généré, seed de démonstration
│   │   ├── prisma/schema.prisma
│   │   ├── prisma/migrations/     # migrations Prisma + SQL manuel (EXCLUDE, CHECK, triggers, partitions)
│   │   ├── prisma.config.ts
│   │   └── src/                   # client, seed-demo.ts (jamais en production), create-admin.ts (CLI)
│   ├── contracts/                 # types OpenAPI générés + énumérations et libellés français partagés
│   └── config/                    # configurations ESLint / TypeScript / Prettier partagées
├── tests/e2e/                     # Playwright : parcours clés (connexion, remise/retour, relevé, entretien, mobile)
├── scripts/                       # sauvegarde, restauration, tests d'exploitation, utilitaires CI
├── docker/                        # Dockerfiles api, worker, web ; configuration reverse proxy
├── docker-compose.yml             # développement local (PostgreSQL de dev et de test)
├── docker-compose.prod.yml        # production : web, api, worker, postgres, reverse proxy, volumes
├── .env.example
└── docs/
    ├── cahier-des-charges-v1.1.md # source de vérité fonctionnelle
    ├── ARCHITECTURE.md            # ce document
    ├── DECISIONS.md               # ambiguïtés tranchées
    ├── TRACEABILITY.md            # exigences ↔ modules ↔ fichiers ↔ tests
    ├── RECETTE.md                 # rapport de recette T01 à T44
    ├── installation.md, mise-a-jour.md, sauvegarde-restauration.md
    ├── guide-chef-de-parc.md, guide-conducteur.md
    └── connecteur-telematique.md
```

## Principes structurants

- **Autorisation au point d'accès aux données** : chaque service reçoit un `RequestContext` (utilisateur, organisation, sociétés autorisées par rôle, permissions). Les requêtes Prisma passent par des « portées » (`scope.companyIds`) construites côté serveur ; le `companyId` envoyé par le client n'est qu'un filtre recoupé. Un objet hors périmètre renvoie 404.
- **Une règle, un endroit** : les calculs de la section 5 à 8 vivent dans `apps/api/src/domain/` sous forme de fonctions pures avec injection de l'horloge (`Clock`). Le worker réutilise les modules de l'API (même package) ; le frontend n'implémente aucune formule.
- **Ingestion unique des relevés** : `OdometerIngestionService` traite MANUAL, IMPORT et TELEMATICS avec les mêmes contrôles ; seuls le worker et les tests peuvent produire la source TELEMATICS.
- **Transactions, idempotence, verrou optimiste** : remise, retour, correction, validation de plein, clôture d'intervention, transfert et ingestion télématique s'exécutent dans une transaction Prisma (isolation `Serializable` avec reprise bornée sur `P2034`), avec `IdempotencyRecord` (utilisateur + organisation + opération + clé) et `expectedVersion`.
- **Contraintes en base** : index uniques partiels (une utilisation ouverte par véhicule et par conducteur, une dépense par source, un segment ouvert par véhicule), contraintes d'exclusion `gist` sur les réservations et affectations, contrôles `CHECK`, trigger d'immuabilité de l'audit, partitionnement mensuel des échantillons télématiques.
- **Décimaux et temps** : `Decimal` (decimal.js via Prisma) pour montants, litres et kilomètres ; horodatages `timestamptz` en UTC ; dates civiles en `date` ; calculs de jour local avec le fuseau du groupe (`Africa/Tunis`).
- **Sécurité** : Argon2id (`@node-rs/argon2`), session serveur en cookie `HttpOnly`/`Secure`/`SameSite=Lax` avec jeton haché, CSRF par jeton synchronisé + contrôle d'origine, limitation de débit persistante, secrets télématiques chiffrés AES-256-GCM avec clé hors base, fichiers privés servis après autorisation, exports neutralisés contre l'injection de formules.
