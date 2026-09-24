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


## Commandes de qualité

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

- `pnpm test` exécute les tests unitaires et les tests d'intégration sur la base PostgreSQL de test (`docker compose up -d postgres-test`, démarrée automatiquement si absente).
- `pnpm test:e2e` lance les parcours Playwright contre la pile compilée (`pnpm build` au préalable).

## Structure

```
apps/api        API REST NestJS (/api/v1), OpenAPI, autorisations serveur
apps/worker     Jobs PostgreSQL : alertes, outbox e-mail, synchronisation télématique
apps/web        Interface Next.js
packages/db     Schéma Prisma, migrations SQL, client, seed de démonstration, CLI d'administration
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
- `docs/guide-chef-de-parc.md`, `docs/guide-conducteur.md` — guides utilisateur.
- `docs/connecteur-telematique.md` — module F11.
