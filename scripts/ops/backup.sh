#!/usr/bin/env bash
# Sauvegarde Parc Auto (CDC 16.4) : base PostgreSQL (pg_dump format personnalisé) puis pièces jointes,
# manifeste avec empreintes SHA-256, archive chiffrée (AES-256, clé hors dépôt), rétention locale,
# copie hors site facultative via rclone. Ordre : base puis fichiers (voir docs/sauvegarde-restauration.md).
#
# Variables : BACKUP_ENCRYPTION_KEY (obligatoire), BACKUP_DIR (./backups), BACKUP_RETENTION_DAYS (30),
#             BACKUP_REMOTE (ex. « offsite:parc-auto », facultatif), COMPOSE_FILE (docker-compose.prod.yml),
#             COMPOSE_PROJECT_NAME (facultatif), POSTGRES_USER / POSTGRES_DB (défauts parc_auto).
set -euo pipefail

: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY est obligatoire (clé conservée hors du serveur)}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
PG_USER="${POSTGRES_USER:-parc_auto}"
PG_DB="${POSTGRES_DB:-parc_auto}"
COMPOSE=(docker compose -f "$COMPOSE_FILE")
if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then COMPOSE+=(-p "$COMPOSE_PROJECT_NAME"); fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$BACKUP_DIR"

echo "[sauvegarde] base de données…"
"${COMPOSE[@]}" exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" --format=custom --no-owner > "$work/db.dump"

echo "[sauvegarde] pièces jointes…"
"${COMPOSE[@]}" run --rm --no-deps -T --entrypoint sh api -c 'tar -C /data/storage -czf - .' > "$work/storage.tar.gz"

db_sha="$(sha256sum "$work/db.dump" | cut -d' ' -f1)"
st_sha="$(sha256sum "$work/storage.tar.gz" | cut -d' ' -f1)"
cat > "$work/manifest.json" <<JSON
{
  "createdAt": "$stamp",
  "appVersion": "${APP_VERSION:-}",
  "database": { "file": "db.dump", "format": "pg_dump custom", "sha256": "$db_sha", "bytes": $(stat -c %s "$work/db.dump") },
  "storage": { "file": "storage.tar.gz", "sha256": "$st_sha", "bytes": $(stat -c %s "$work/storage.tar.gz") },
  "order": "base puis fichiers"
}
JSON

archive="$BACKUP_DIR/parc-auto-$stamp.tar.enc"
tar -C "$work" -cf - manifest.json db.dump storage.tar.gz \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_ENCRYPTION_KEY -out "$archive"
sha256sum "$archive" | sed "s#  .*#  $(basename "$archive")#" > "$archive.sha256"
echo "[sauvegarde] archive chiffrée : $archive ($(stat -c %s "$archive") octets)"

echo "[sauvegarde] rétention : suppression des archives de plus de $RETENTION_DAYS jours"
find "$BACKUP_DIR" -name 'parc-auto-*.tar.enc*' -type f -mtime +"$RETENTION_DAYS" -print -delete

if [ -n "${BACKUP_REMOTE:-}" ]; then
  echo "[sauvegarde] copie hors site vers $BACKUP_REMOTE"
  rclone copy "$archive" "$BACKUP_REMOTE" && rclone copy "$archive.sha256" "$BACKUP_REMOTE"
else
  echo "[sauvegarde] ATTENTION : BACKUP_REMOTE non défini, aucune copie hors site n'a été faite." >&2
fi
echo "[sauvegarde] terminé"
