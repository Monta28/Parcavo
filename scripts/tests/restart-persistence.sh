#!/usr/bin/env bash
# Persistance après redémarrage (CDC 17.2, R-17.2-07 ; T30) : démarre la pile de production
# (docker-compose.prod.yml : postgres, migrate, api, worker, web) dans un projet compose ISOLÉ aux volumes
# neufs, crée des données réelles par l'API (société, catégorie, véhicule, localisation déclarée, pièce
# jointe PDF), arrête toute la pile (`down`, volumes conservés) puis la redémarre (`up`) et vérifie :
#   1. l'API est prête (/health/ready) et le worker bat de nouveau (/health/worker « actif ») ;
#   2. les comptes de lignes des tables principales (hors écritures propres au worker : battements, baux,
#      alertes, traces système) sont identiques avant l'arrêt et après le redémarrage ;
#   3. la session ouverte avant l'arrêt reste valide, le véhicule et sa localisation sont intacts, la pièce
#      jointe se télécharge avec la même empreinte SHA-256 (volume « storage »).
# Le projet isolé (conteneurs et volumes) est supprimé à la fin, sauf avec --garder.
#
# Le reverse proxy n'est pas démarré : il publie les ports 80/443 de l'hôte (conflit avec une production
# sur la même machine) et ne porte aucune donnée métier ; ses volumes (certificats) sont des volumes nommés
# comme les autres.
#
# Prérequis : Docker Engine + Compose, images construites pour APP_VERSION (défaut « local ») :
#   docker compose -f docker-compose.prod.yml build            (ou APP_VERSION=<version> …)
# Usage : [APP_VERSION=<version>] scripts/tests/restart-persistence.sh [--garder]
# Les secrets du projet isolé (mot de passe PostgreSQL, clé de chiffrement, mot de passe administrateur)
# sont générés pour l'exécution, transmis par l'environnement et jamais affiché ni écrit dans le dépôt.
set -euo pipefail

keep="${1:-}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
export APP_VERSION="${APP_VERSION:-local}"
project="parc-auto-persistance-$(date -u +%Y%m%d%H%M%S)"
COMPOSE=(docker compose -f "$COMPOSE_FILE" -p "$project")
started="$(date +%s)"

# Environnement propre au projet isolé : prime sur un éventuel .env du répertoire (Compose donne la
# priorité aux variables du shell). Aucun e-mail n'est envoyé (SMTP vide).
export POSTGRES_USER=parc_auto POSTGRES_DB=parc_auto
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
SECRETS_ENCRYPTION_KEY="$(openssl rand -base64 32)"
export POSTGRES_PASSWORD SECRETS_ENCRYPTION_KEY
export SECRETS_ENCRYPTION_KEY_ID=k1 SECRETS_ENCRYPTION_PREVIOUS_KEYS=''
export DOMAIN="persistance.parc-auto.invalid" ACME_EMAIL="exploitation@parc-auto.invalid"
export SMTP_HOST='' SMTP_USER='' SMTP_PASSWORD='' SMTP_FROM='' LOG_LEVEL=warn
PROBE_EMAIL="controle.persistance@parc-auto.test"
# Mot de passe fort aléatoire (minuscules, majuscules, chiffres) pour le seul administrateur de contrôle.
PROBE_PASSWORD="$(printf 'Pers-%s-A9' "$(openssl rand -hex 12)")"
export PROBE_EMAIL PROBE_PASSWORD

state_file="$(mktemp)"
chmod 600 "$state_file"
cleanup() {
  rm -f "$state_file"
  if [ "$keep" != "--garder" ]; then
    echo "[persistance] suppression du projet isolé $project"
    "${COMPOSE[@]}" --profile migrate down -v --remove-orphans >/dev/null 2>&1 || true
  else
    echo "[persistance] projet isolé conservé : $project (docker compose -f $COMPOSE_FILE -p $project down -v pour le supprimer)"
  fi
}
trap cleanup EXIT

for target in api worker web migrate; do
  if ! docker image inspect "parc-auto/$target:$APP_VERSION" >/dev/null 2>&1; then
    echo "[persistance] image parc-auto/$target:$APP_VERSION absente : construisez d'abord la pile (APP_VERSION=$APP_VERSION docker compose -f $COMPOSE_FILE build)." >&2
    exit 1
  fi
done

wait_http() { # <chemin> <motif attendu> <tentatives>
  local body=""
  for _ in $(seq 1 "$3"); do
    if body="$("${COMPOSE[@]}" exec -T api wget -qO- "http://127.0.0.1:3001/api/v1/health/$1" 2>/dev/null)"; then
      case "$body" in *"$2"*) echo "$body"; return 0 ;; esac
    fi
    sleep 3
  done
  echo "[persistance] ÉCHEC : /health/$1 ne répond pas « $2 » (${body:-aucune réponse})" >&2
  return 1
}

pg_counts() {
  "${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tA -c \
    "SELECT 'Organization=' || (SELECT count(*) FROM \"Organization\") || ' Company=' || (SELECT count(*) FROM \"Company\") || ' Vehicle=' || (SELECT count(*) FROM \"Vehicle\") || ' VehicleLocationReport=' || (SELECT count(*) FROM \"VehicleLocationReport\") || ' Attachment=' || (SELECT count(*) FROM \"Attachment\") || ' User=' || (SELECT count(*) FROM \"User\") || ' Session=' || (SELECT count(*) FROM \"Session\") || ' AuditEvent(utilisateurs)=' || (SELECT count(*) FROM \"AuditEvent\" WHERE \"actorType\" = 'UTILISATEUR') || ' migrations=' || (SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL);"
}

echo "[persistance] projet isolé $project (images $APP_VERSION)"
"${COMPOSE[@]}" up -d --no-build postgres
until "${COMPOSE[@]}" exec -T postgres pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do sleep 1; done
echo "[persistance] migrations"
"${COMPOSE[@]}" --profile migrate run --rm --no-build migrate >/dev/null
echo "[persistance] administrateur de contrôle (create-admin)"
"${COMPOSE[@]}" --profile migrate run --rm --no-build -e ADMIN_PASSWORD="$PROBE_PASSWORD" migrate \
  node dist/cli/create-admin.js --org-code PERSISTANCE --org-name "Contrôle de persistance" \
  --email "$PROBE_EMAIL" --first-name Controle --last-name Persistance >/dev/null
"${COMPOSE[@]}" up -d --no-build api worker web
wait_http ready '"status":"pret"' 60 >/dev/null
wait_http worker '"status":"actif"' 40 >/dev/null

echo "[persistance] données créées par l'API"
"${COMPOSE[@]}" exec -T -e PROBE_EMAIL -e PROBE_PASSWORD api node --input-type=module - seed < "$here/restart-persistence-probe.mjs" > "$state_file"
before="$(pg_counts)"
echo "[persistance] avant l'arrêt : $before"

echo "[persistance] arrêt complet (down, volumes conservés) puis redémarrage (up)"
"${COMPOSE[@]}" down
"${COMPOSE[@]}" up -d --no-build postgres api worker web
wait_http ready '"status":"pret"' 60 >/dev/null
echo "[persistance] API prête après redémarrage"
wait_http worker '"status":"actif"' 40 >/dev/null
echo "[persistance] worker actif après redémarrage"

after="$(pg_counts)"
echo "[persistance] après le redémarrage : $after"
if [ "$before" != "$after" ]; then
  echo "[persistance] ÉCHEC : les comptes de lignes diffèrent après le redémarrage" >&2
  exit 1
fi
PROBE_STATE="$(cat "$state_file")" "${COMPOSE[@]}" exec -T -e PROBE_STATE api node --input-type=module - verify < "$here/restart-persistence-probe.mjs"
echo "[persistance] RÉUSSI en $(( $(date +%s) - started )) s"
