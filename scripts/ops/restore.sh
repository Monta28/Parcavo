#!/usr/bin/env bash
# Restauration Parc Auto (CDC 16.4) : vérifie l'empreinte, déchiffre, contrôle le manifeste, puis
# restaure la base (pg_restore --clean) et les pièces jointes dans le projet compose ciblé.
# Usage : BACKUP_ENCRYPTION_KEY=… scripts/ops/restore.sh <archive.tar.enc> [projet]
# Le projet par défaut est le projet courant : restaurer d'abord dans un projet isolé (exercice automatisé : restore-test.sh).
set -euo pipefail

archive="${1:?Usage : restore.sh <archive.tar.enc> [projet compose]}"
project="${2:-${COMPOSE_PROJECT_NAME:-}}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY est obligatoire}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
PG_USER="${POSTGRES_USER:-parc_auto}"
PG_DB="${POSTGRES_DB:-parc_auto}"
COMPOSE=(docker compose -f "$COMPOSE_FILE")
if [ -n "$project" ]; then COMPOSE+=(-p "$project"); fi

if [ -f "$archive.sha256" ]; then
  echo "[restauration] contrôle de l'empreinte de l'archive"
  (cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256")
fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENCRYPTION_KEY -in "$archive" | tar -C "$work" -xf -
for part in db.dump storage.tar.gz; do
  expected="$(sed -n "s/.*\"file\": \"$part\".*\"sha256\": \"\([0-9a-f]*\)\".*/\1/p" "$work/manifest.json")"
  actual="$(sha256sum "$work/$part" | cut -d' ' -f1)"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then echo "[restauration] empreinte invalide pour $part" >&2; exit 1; fi
done
echo "[restauration] manifeste vérifié ($(sed -n 's/.*"createdAt": "\([^"]*\)".*/\1/p' "$work/manifest.json"))"

echo "[restauration] arrêt des services applicatifs"
"${COMPOSE[@]}" stop api worker web >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d postgres
# TCP seulement : le serveur temporaire d'initialisation d'un volume neuf n'écoute que sur le socket local.
until "${COMPOSE[@]}" exec -T postgres pg_isready -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; do sleep 1; done

echo "[restauration] base de données"
"${COMPOSE[@]}" exec -T postgres psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$PG_DB' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS \"$PG_DB\";" -c "CREATE DATABASE \"$PG_DB\" OWNER \"$PG_USER\";" >/dev/null
"${COMPOSE[@]}" exec -T postgres pg_restore -U "$PG_USER" -d "$PG_DB" --no-owner --exit-on-error < "$work/db.dump"
# Tables techniques propres à l'instance sauvegardée : battements et baux des anciens workers. Les vider
# garantit que la disponibilité (/health/ready) reflète le worker restauré et qu'aucun bail périmé ne bloque.
"${COMPOSE[@]}" exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q \
  -c 'DELETE FROM "WorkerHeartbeat";' -c 'DELETE FROM "JobLease";' >/dev/null

echo "[restauration] pièces jointes"
"${COMPOSE[@]}" run --rm --no-deps -T --user root --entrypoint sh api -c 'find /data/storage -mindepth 1 -delete && tar -C /data/storage -xzf - && chown -R parcauto:parcauto /data/storage' < "$work/storage.tar.gz"

echo "[restauration] redémarrage des services"
"${COMPOSE[@]}" up -d api worker
echo "[restauration] terminé : vérifiez /api/v1/health/ready et la recette de restauration."
