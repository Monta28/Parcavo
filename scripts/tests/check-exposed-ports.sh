#!/usr/bin/env bash
# Contrôle de l'exposition réseau en production (CDC 16.3, R-16.3-04) sur docker-compose.prod.yml :
#  - seul le reverse proxy (service dont l'image est Caddy) publie des ports sur l'hôte, et uniquement 80
#    et 443 ; web, api, worker, migrate et PostgreSQL n'en publient aucun (ni « ports », ni mode réseau
#    « host ») : la base et le stockage des pièces jointes restent privés ;
#  - le Caddyfile sert le site par son nom de domaine en HTTPS automatique (pas d'adresse « http:// »,
#    pas de « auto_https off ») avec l'en-tête Strict-Transport-Security.
#
# Usage : scripts/tests/check-exposed-ports.sh [--root <dossier>]   (code 1 et liste des écarts)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
if [ "${1:-}" = "--root" ]; then root="$(cd "${2:?--root <dossier>}" && pwd)"; fi
compose="$root/docker-compose.prod.yml"
caddyfile="$root/deploy/Caddyfile"
errors=0
fail() { echo "$1 — $2" >&2; errors=$((errors + 1)); }

[ -f "$compose" ] || { echo "docker-compose.prod.yml absent de $root" >&2; exit 1; }

# service ␟ image ␟ ports publiés (séparés par des espaces) ␟ network_mode ␟ ligne de « ports » (séparateur
# non blanc : un champ vide n'est pas absorbé par read).
report="$(awk '
  function flush() { if (svc != "") printf "%s\037%s\037%s\037%s\037%s\n", svc, image, ports, netmode, portsline }
  /^services:[[:space:]]*$/ { in_services = 1; next }
  /^[^[:space:]#]/ { if (in_services) flush(); in_services = 0; svc = ""; next }
  !in_services { next }
  /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ { flush(); svc = $1; sub(/:$/, "", svc); image = ""; ports = ""; netmode = ""; portsline = ""; section = ""; next }
  /^    [A-Za-z_]+:/ {
    key = $1; sub(/:$/, "", key); section = key
    if (key == "image") { v = $0; sub(/^    image:[[:space:]]*/, "", v); image = v }
    if (key == "network_mode") { v = $0; sub(/^    network_mode:[[:space:]]*/, "", v); gsub(/["\047]/, "", v); netmode = v }
    if (key == "ports") { portsline = NR; v = $0; sub(/^    ports:[[:space:]]*/, "", v); gsub(/[][,"\047]/, " ", v); if (v ~ /[^[:space:]]/) ports = ports " " v }
    next
  }
  section == "ports" && /^      - / { v = $0; sub(/^      - [[:space:]]*/, "", v); gsub(/["\047]/, "", v); ports = ports " " v }
  END { if (in_services) flush() }
' "$compose")"

proxy_found=0
while IFS=$'\x1f' read -r service image ports netmode line; do
  [ -n "$service" ] || continue
  is_proxy=0
  case "$image" in caddy:*|*/caddy:*) is_proxy=1 ;; esac
  if [ -n "$netmode" ] && [ "$netmode" = "host" ]; then fail "docker-compose.prod.yml" "service $service : network_mode host interdit (exposition directe sur l'hôte)"; fi
  if [ "$is_proxy" = "1" ]; then
    proxy_found=1
    published=""
    for p in $ports; do
      host_part="${p%:*}"
      container_port="${p##*:}"; container_port="${container_port%%/*}"
      [ "$host_part" = "$p" ] && host_part="$container_port"
      host_port="${host_part##*:}"
      case "$host_port:$container_port" in
        80:80|443:443) published="$published $host_port" ;;
        *) fail "docker-compose.prod.yml:$line" "proxy $service : port « $p » inattendu (seuls 80 et 443)" ;;
      esac
    done
    case " $published " in *" 443 "*) ;; *) fail "docker-compose.prod.yml" "proxy $service : le port 443 (HTTPS) n'est pas publié" ;; esac
  elif [ -n "${ports// /}" ]; then
    fail "docker-compose.prod.yml:$line" "service $service : publie des ports sur l'hôte ($(echo $ports)) ; seul le reverse proxy le peut"
  fi
done <<< "$report"
[ "$proxy_found" = "1" ] || fail "docker-compose.prod.yml" "aucun reverse proxy Caddy trouvé"

if [ -f "$caddyfile" ]; then
  grep -Eq '^[[:space:]]*auto_https[[:space:]]+off' "$caddyfile" && fail "deploy/Caddyfile" "auto_https off : HTTPS automatique désactivé"
  grep -Eq '^[[:space:]]*(http://|:80[[:space:]{])' "$caddyfile" && fail "deploy/Caddyfile" "site servi en HTTP clair"
  grep -Eq '^\{\$DOMAIN\}[[:space:]]*\{' "$caddyfile" || fail "deploy/Caddyfile" "le site n'est pas servi par son nom de domaine {\$DOMAIN} (certificat automatique)"
  grep -Eq 'Strict-Transport-Security' "$caddyfile" || fail "deploy/Caddyfile" "en-tête Strict-Transport-Security absent"
else
  fail "deploy/Caddyfile" "fichier absent"
fi

if [ "$errors" -gt 0 ]; then
  echo "Contrôle de l'exposition : $errors écart(s)." >&2
  exit 1
fi
count="$(printf '%s\n' "$report" | grep -c . || true)"
echo "Contrôle de l'exposition : $count service(s) ; seul le reverse proxy publie 80 et 443, en HTTPS automatique avec HSTS ; PostgreSQL et le stockage restent privés."
