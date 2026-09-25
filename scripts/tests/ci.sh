#!/usr/bin/env bash
# Chaîne de contrôle reproductible (CDC 19.3, R-19.3-03) : s'arrête à la première étape en échec.
#
#   1. contrôles statiques d'exploitation : images épinglées sans latest, seul le proxy publie des ports,
#      .env.example complet et sans secret, aucune annonce « prête pour la production » (pnpm check:ops) ;
#   2. lint, dont le contrôle des secrets du dépôt (pnpm lint) ;
#   3. vérification des types (pnpm typecheck) ;
#   4. tests : unitaires et intégration PostgreSQL réelle (pnpm test ; base TEST_DATABASE_URL, défaut
#      docker compose « postgres-test » sur le port 5433), ou unitaires seuls avec --unitaires ;
#   5. build de tous les paquets, puis contrôle des secrets du bundle client (pnpm build) ;
#   6. facultatif --e2e : parcours Playwright contre la pile compilée (pnpm test:e2e) ;
#   7. facultatif --exploitation : construction des images de production puis persistance après
#      redémarrage (scripts/tests/restart-persistence.sh, Docker requis).
#
# Usage : scripts/tests/ci.sh [--unitaires] [--e2e] [--exploitation] [--sans-build]
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
unit_only=0; e2e=0; ops=0; build=1
for arg in "$@"; do
  case "$arg" in
    --unitaires) unit_only=1 ;;
    --e2e) e2e=1 ;;
    --exploitation) ops=1 ;;
    --sans-build) build=0 ;;
    *) echo "Option inconnue : $arg" >&2; exit 2 ;;
  esac
done
if [ "$e2e" = "1" ] && [ "$build" = "0" ]; then echo "--e2e exige le build (retirez --sans-build)." >&2; exit 2; fi

started="$(date +%s)"
step() {
  local name="$1"; shift
  local t0; t0="$(date +%s)"
  echo "::: [ci] $name — $*"
  if ! "$@"; then
    echo "::: [ci] ÉCHEC à l'étape « $name » après $(( $(date +%s) - t0 )) s" >&2
    exit 1
  fi
  echo "::: [ci] $name : réussi en $(( $(date +%s) - t0 )) s"
}

echo "::: [ci] révision $(git rev-parse --short HEAD 2>/dev/null || echo inconnue), Node $(node --version), pnpm $(pnpm --version)"
step "contrôles d'exploitation" pnpm check:ops
step "lint" pnpm lint
step "types" pnpm typecheck
if [ "$unit_only" = "1" ]; then
  step "tests unitaires" pnpm test:unit
  step "tests des contrôles" pnpm test:secrets
  step "tests des contrôles d'exploitation" pnpm test:ops
else
  step "tests unitaires et d'intégration" pnpm test
fi
if [ "$build" = "1" ]; then step "build" pnpm build; fi
if [ "$e2e" = "1" ]; then step "parcours e2e" pnpm test:e2e; fi
if [ "$ops" = "1" ]; then
  version="ci-$(git rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)"
  step "images de production" env APP_VERSION="$version" docker compose -f docker-compose.prod.yml build
  step "persistance après redémarrage" env APP_VERSION="$version" bash scripts/tests/restart-persistence.sh
fi
echo "::: [ci] RÉUSSI en $(( $(date +%s) - started )) s (aucune conclusion de mise en production n'est tirée d'un build seul)."
