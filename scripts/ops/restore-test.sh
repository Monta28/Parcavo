#!/usr/bin/env bash
# Exercice de restauration (CDC 16.4, T30) : restaure une archive dans un projet compose ISOLÉ (volumes
# distincts, sans proxy ni port exposé), puis vérifie :
#   1. l'API restaurée répond « prêt » (/health/ready : base et stockage), puis le worker restauré bat
#      (/health/worker : « actif », battement de moins de deux minutes) ;
#   2. la base est lisible et l'historique des migrations est complet ;
#   3. chaque pièce jointe non supprimée référencée par la base a son fichier, avec la bonne empreinte SHA-256.
# Le projet isolé est supprimé à la fin, sauf avec --garder.
# Usage : BACKUP_ENCRYPTION_KEY=… scripts/ops/restore-test.sh <archive.tar.enc> [--garder]
set -euo pipefail

archive="${1:?Usage : restore-test.sh <archive.tar.enc> [--garder]}"
keep="${2:-}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY est obligatoire}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
PG_USER="${POSTGRES_USER:-parc_auto}"
PG_DB="${POSTGRES_DB:-parc_auto}"
project="parc-auto-restauration-$(date -u +%Y%m%d%H%M%S)"
COMPOSE=(docker compose -f "$COMPOSE_FILE" -p "$project")
here="$(cd "$(dirname "$0")" && pwd)"
started="$(date +%s)"

cleanup() {
  if [ "$keep" != "--garder" ]; then
    echo "[exercice] suppression du projet isolé $project"
    "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  else
    echo "[exercice] projet isolé conservé : $project (docker compose -p $project down -v pour le supprimer)"
  fi
}
trap cleanup EXIT

COMPOSE_FILE="$COMPOSE_FILE" "$here/restore.sh" "$archive" "$project"

echo "[exercice] attente de l'API restaurée"
ready=""
for _ in $(seq 1 60); do
  if ready="$("${COMPOSE[@]}" exec -T api wget -qO- http://127.0.0.1:3001/api/v1/health/ready 2>/dev/null)"; then break; fi
  sleep 3
done
case "$ready" in
  *'"status":"pret"'*) echo "[exercice] API prête : $ready" ;;
  *) echo "[exercice] ÉCHEC : l'API restaurée n'est pas prête ($ready)" >&2; exit 1 ;;
esac

# restore.sh vide les battements de l'instance sauvegardée : seul le worker restauré peut rendre « actif ».
echo "[exercice] attente du battement du worker restauré"
worker=""
for _ in $(seq 1 40); do
  if worker="$("${COMPOSE[@]}" exec -T api wget -qO- http://127.0.0.1:3001/api/v1/health/worker 2>/dev/null)"; then break; fi
  sleep 3
done
case "$worker" in
  *'"status":"actif"'*) echo "[exercice] worker actif : $worker" ;;
  *) echo "[exercice] ÉCHEC : le worker restauré ne bat pas ($worker)" >&2; exit 1 ;;
esac

echo "[exercice] contrôle de la base"
psql=("${COMPOSE[@]}" exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -tA)
"${psql[@]}" -c "SELECT 'migrations appliquées : ' || count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"
"${psql[@]}" -c "SELECT 'organisations : ' || (SELECT count(*) FROM \"Organization\") || ', véhicules : ' || (SELECT count(*) FROM \"Vehicle\") || ', conducteurs : ' || (SELECT count(*) FROM \"Driver\") || ', événements d''audit : ' || (SELECT count(*) FROM \"AuditEvent\");"

echo "[exercice] contrôle des pièces jointes"
"${psql[@]}" -c "SELECT \"storageKey\" || ' ' || sha256 FROM \"Attachment\" WHERE \"deletedAt\" IS NULL AND \"ownerId\" IS NOT NULL;" > /tmp/"$project"-attachments.txt
expected="$(wc -l < /tmp/"$project"-attachments.txt | tr -d ' ')"
missing="$("${COMPOSE[@]}" run --rm --no-deps -T --entrypoint sh api -c '
  bad=0
  while read -r key sum; do
    [ -z "$key" ] && continue
    f="/data/storage/objects/$(printf %s "$key" | cut -c1-2)/$key"
    if [ ! -f "$f" ] || [ "$(sha256sum "$f" | cut -d" " -f1)" != "$sum" ]; then echo "$key"; bad=$((bad+1)); fi
  done
  exit 0' < /tmp/"$project"-attachments.txt)"
rm -f /tmp/"$project"-attachments.txt
if [ -n "$missing" ]; then
  echo "[exercice] ÉCHEC : fichiers absents ou altérés :" >&2
  echo "$missing" >&2
  exit 1
fi
echo "[exercice] $expected pièce(s) jointe(s) rattachée(s) présente(s) avec la bonne empreinte"
echo "[exercice] RÉUSSI en $(( $(date +%s) - started )) s"
