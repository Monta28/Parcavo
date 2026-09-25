# Parc Auto

Application web de gestion de parc automobile multi-sociétés (cahier des charges v1.1 : `docs/cahier-des-charges-v1.1.md`). Interface en français, fuseau Africa/Tunis, devise TND à trois décimales.

## Socle

Node.js 24 LTS, pnpm 10, Next.js 16 (App Router), NestJS 12, PostgreSQL 16, Prisma 7, Tailwind CSS 4 avec shadcn/ui, Vitest, Playwright. Versions figées dans `pnpm-lock.yaml` ; détail dans `docs/ARCHITECTURE.md`.

## Démarrage local en une commande

Prérequis : Docker (avec Compose), Node.js 24 et pnpm 10 (`corepack enable` suffit).

```bash
cp .env.example .env && docker compose up -d --wait && pnpm install && pnpm db:migrate && pnpm dev
```

- Web : http://localhost:3000 — API : http://localhost:3001/api/v1 — OpenAPI : http://localhost:3001/api/docs
- Premier administrateur sur une base vierge (le mot de passe est demandé au clavier, jamais passé en argument) :

```bash
pnpm --filter @parc-auto/db create-admin \
  --org-code GROUPE --org-name "Mon groupe" --email admin@exemple.tn --first-name Prénom --last-name Nom
```

Sans terminal interactif (script de déploiement), le mot de passe vient de la variable `ADMIN_PASSWORD`, alimentée par le gestionnaire de secrets : jamais écrite dans un fichier versionné (contrôle `pnpm check:secrets`).

## Démonstration

> **Jamais en production.** Le jeu de démonstration est fictif ; la commande refuse de s'exécuter si `NODE_ENV=production` (code de sortie 1, aucune écriture) et n'est jamais appelée par les migrations.

Sur une base vierge (migrations appliquées, API compilée par `pnpm install` ou `pnpm --filter @parc-auto/api build`), avec les variables de `.env` exportées :

```bash
set -a && . ./.env && set +a
pnpm seed:demo                  # refuse une base non vide
pnpm seed:demo -- --reset       # vide d'abord une base de démonstration (hors production uniquement)
```

- Mot de passe commun des comptes : `DEMO_PASSWORD` s'il est fourni (12 caractères minimum, minuscules, majuscules et chiffres), sinon généré aléatoirement et affiché **une seule fois** à la fin (seule son empreinte Argon2id est stockée).
- Contenu, dates relatives au jour d'exécution : organisation `DEMO`, trois sociétés (`ATLAS`, `CARTHAGE`, `OASIS`), douze véhicules, dix conducteurs ; utilisations ouvertes et clôturées, retour en retard et réservation compromise, réservations future et non honorée, responsables habituels, relevés (validé, en attente au-delà du seuil, corrigé, remplacement de compteur, relevé ancien), plans d'entretien à jour / bientôt dus / en retard, interventions ouverte et clôturée, documents valide / à renouveler / expiré bloquant, incidents mineur et critique, immobilisation active, pleins (normal, écart en attente, doublon rejeté), dépenses, alertes, transfert entre sociétés et lot d'import confirmé. Tout passe par les services de l'API (règles, références, audit et alertes).
- Télématique : un fournisseur « SIMULATEUR — données fictives » n'est créé que si `TELEMETRY_SIMULATOR_ENABLED=true` ; sinon le module F11 reste désactivé.
- `--reset` ne vide qu'une base qui ne contient que l'organisation `DEMO` : une base portant une autre organisation est refusée sans aucune suppression. Les fichiers déjà présents dans `STORAGE_DIR` ne sont pas supprimés.

| Compte | Rôle |
| --- | --- |
| `admin@demo.parc-auto.test` | Administrateur groupe |
| `chef.atlas@demo.parc-auto.test`, `chef.carthage@demo.parc-auto.test`, `chef.oasis@demo.parc-auto.test` | Chef de parc (une société chacun) |
| `karim.mansour@demo.parc-auto.test` (ATLAS), `youssef.gharbi@demo.parc-auto.test` (CARTHAGE), `ines.chaabane@demo.parc-auto.test` (OASIS) | Conducteur |


## Commandes de qualité

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

- `pnpm test` exécute les tests unitaires et les tests d'intégration sur la base PostgreSQL de test (`docker compose up -d postgres-test`, démarrée automatiquement si absente).
- `pnpm test:e2e` lance les parcours Playwright contre la pile compilée (`pnpm build` au préalable).
- `pnpm check:ops` (inclus dans `pnpm lint`) : images Docker épinglées par version et empreinte, jamais `latest` (`scripts/tests/check-image-tags.sh`) ; en production seul le reverse proxy publie des ports, 80 et 443, en HTTPS avec HSTS (`scripts/tests/check-exposed-ports.sh`) ; `.env.example` documente toutes les variables lues, sans valeur secrète (`scripts/tests/check-env-example.sh`) ; aucune annonce « prête pour la production » n'est faite dans le dépôt (`scripts/tests/check-production-claim.sh`, CDC 19.3). `pnpm test:ops` (inclus dans `pnpm test`) vérifie ces contrôles sur des cas refusés.
- `scripts/tests/ci.sh` (`pnpm ci:check` ; `pnpm ci` est la réinstallation propre de pnpm) enchaîne contrôles d'exploitation, lint, types, tests unitaires et d'intégration, build ; options `--unitaires`, `--e2e`, `--exploitation` (construction des images de production puis `scripts/tests/restart-persistence.sh`) et `--sans-build`. Il s'arrête à la première étape en échec.
- `scripts/tests/restart-persistence.sh` (Docker, images construites) : pile de production dans un projet isolé, données créées par l'API, arrêt complet puis redémarrage, vérification des données, de la session et de l'empreinte des pièces jointes.

## API et contrat OpenAPI

- API REST : `http://localhost:3001/api/v1` ; documentation interactive : `http://localhost:3001/api/docs` (document JSON : `/api/docs.json`).
- Contrat versionné : `docs/openapi.json` (D-306), produit à partir de la même configuration que l'API servie (titre, version, préfixe `/api/v1`, sécurité par cookie de session `pa_session` et en-tête `X-CSRF-Token` sur les mutations), sans serveur HTTP ni base de données. Sortie déterministe : clés triées, paramètres triés, indentation de 2 espaces. Après toute modification d'un contrôleur ou d'un DTO :

```bash
pnpm --filter @parc-auto/api openapi:export   # compile l'API puis réécrit docs/openapi.json
```

- Le test `apps/api/src/openapi-drift.spec.ts` (inclus dans `pnpm test`) échoue tant que `docs/openapi.json` diffère du code ; il vérifie aussi que chaque opération a un résumé, une réponse de succès typée au code HTTP réellement renvoyé et ses exigences de sécurité.
- Types TypeScript générés depuis ce document : `pnpm --filter @parc-auto/contracts openapi:types`.

## Structure

```
apps/api        API REST NestJS (/api/v1), OpenAPI, autorisations serveur, CLI (jeu de démonstration, rotation des secrets)
apps/worker     Jobs PostgreSQL : alertes, outbox e-mail, synchronisation télématique
apps/web        Interface Next.js
packages/db     Schéma Prisma, migrations SQL, client, CLI d'administration (premier administrateur)
packages/contracts  Énumérations, libellés français, types partagés
tests/e2e       Parcours navigateur Playwright
docs/           Cahier des charges, architecture, décisions, traçabilité, recette, procédures d'exploitation
```

## Documentation

- `docs/ARCHITECTURE.md` — socle, arborescence et principes.
- `docs/DECISIONS.md` — ambiguïtés du cahier des charges et options retenues.
- `docs/TRACEABILITY.md` — exigences ↔ modules ↔ fichiers ↔ tests (T01 à T44).
- `docs/RECETTE.md` — rapport de recette avec commandes et résultats réels.
- `docs/installation.md`, `docs/mise-a-jour.md`, `docs/sauvegarde-restauration.md` — exploitation.
- [`docs/guide-chef-de-parc.md`](docs/guide-chef-de-parc.md) (chef de parc, opérateur, lecteur et administration) et [`docs/guide-conducteur.md`](docs/guide-conducteur.md) (conducteur, sur téléphone) — guides utilisateur.
- `docs/connecteur-telematique.md` — module F11.
