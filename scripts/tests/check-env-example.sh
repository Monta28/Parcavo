#!/usr/bin/env bash
# Contrôle du modèle .env.example (CDC 16.3, R-16.3-03) : il documente toutes les variables lues par
#  - l'API et le worker (apps/api/src/infra/env.ts : read/readInt/readBool) ;
#  - le web (process.env dans apps/web/app, apps/web/lib) ;
#  - les commandes d'administration (apps/api/src/cli, packages/db/src/cli) ;
#  - docker-compose.prod.yml, docker-compose.yml, deploy/Caddyfile ({$VAR}) et scripts/ops/*.sh
#    (${VAR}, ${VAR:-…}, ${VAR:?…}) ;
# et aucune variable sensible n'y reçoit de valeur (clés, mots de passe, jetons, secrets : valeur vide).
# Une variable peut être documentée active (« VAR=… ») ou en commentaire (« # VAR=… »).
#
# Usage : scripts/tests/check-env-example.sh [--root <dossier>]   (code 1 et liste des variables absentes)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
if [ "${1:-}" = "--root" ]; then root="$(cd "${2:?--root <dossier>}" && pwd)"; fi
cd "$root"
example=".env.example"
[ -f "$example" ] || { echo ".env.example absent de $root" >&2; exit 1; }

# Variables propres au shell ou à l'outillage, jamais à renseigner dans .env.
IGNORED=' PATH HOME PWD USER SHELL TMPDIR HOSTNAME '
files_ts=()
for d in apps/web/app apps/web/lib apps/api/src/cli packages/db/src/cli; do
  [ -d "$d" ] && while IFS= read -r f; do files_ts+=("$f"); done < <(find "$d" -type f \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.spec.ts' ! -path '*/node_modules/*' | sort)
done

{
  [ -f apps/api/src/infra/env.ts ] && grep -ohE "read(Int|Bool)?\('[A-Z][A-Z0-9_]*'" apps/api/src/infra/env.ts | sed -E "s/.*\('([A-Z0-9_]+)'/\1/"
  if [ "${#files_ts[@]}" -gt 0 ]; then
    grep -ohE "(process\.env|source|env)\[['\"][A-Z][A-Z0-9_]*['\"]\]|process\.env\.[A-Z][A-Z0-9_]*" "${files_ts[@]}" 2>/dev/null | sed -E "s/.*[.\[]['\"]?([A-Z][A-Z0-9_]*)['\"]?\]?$/\1/"
  fi
  for f in docker-compose.prod.yml docker-compose.yml; do
    [ -f "$f" ] && grep -v '^[[:space:]]*#' "$f" | grep -ohE '\$\{[A-Z][A-Z0-9_]*' | sed 's/^\${//'
  done
  [ -f deploy/Caddyfile ] && grep -ohE '\{\$[A-Z][A-Z0-9_]*\}' deploy/Caddyfile | sed -E 's/^\{\$([A-Z0-9_]+)\}$/\1/'
  for f in scripts/ops/*.sh; do
    [ -f "$f" ] && grep -v '^[[:space:]]*#' "$f" | grep -ohE '\$\{[A-Z][A-Z0-9_]*:?[-?]' | sed -E 's/^\$\{([A-Z0-9_]+).*/\1/'
  done
} | sort -u > "${TMPDIR:-/tmp}/parc-auto-env-vars.$$"
trap 'rm -f "${TMPDIR:-/tmp}/parc-auto-env-vars.$$"' EXIT

documented="$(grep -oE '^[[:space:]]*#?[[:space:]]*[A-Z][A-Z0-9_]*=' "$example" | sed -E 's/^[[:space:]]*#?[[:space:]]*([A-Z0-9_]+)=/\1/' | sort -u)"
missing=0
total=0
while IFS= read -r var; do
  [ -n "$var" ] || continue
  case "$IGNORED" in *" $var "*) continue ;; esac
  total=$((total + 1))
  if ! grep -qx "$var" <<< "$documented"; then
    echo ".env.example — variable « $var » lue par l'application ou l'exploitation mais non documentée" >&2
    missing=$((missing + 1))
  fi
done < "${TMPDIR:-/tmp}/parc-auto-env-vars.$$"

# Variables sensibles : aucune valeur dans le modèle (ni active, ni en commentaire).
leaks=0
while IFS= read -r entry; do
  name="${entry%%=*}"; value="${entry#*=}"
  if [[ "$name" =~ (PASSWORD|SECRET|TOKEN|_KEY|_KEYS|API_KEY)$ ]] && [ -n "$value" ]; then
    echo ".env.example — la variable sensible « $name » a une valeur ; laisser vide (secret généré à l'installation)" >&2
    leaks=$((leaks + 1))
  fi
done < <(grep -E '^[[:space:]]*#?[[:space:]]*[A-Z][A-Z0-9_]*=' "$example" | sed -E 's/^[[:space:]]*#?[[:space:]]*//')

if [ "$total" -eq 0 ]; then echo "Aucune variable trouvée dans les sources : contrôle sans objet, refusé." >&2; exit 1; fi
if [ "$missing" -gt 0 ] || [ "$leaks" -gt 0 ]; then
  echo "Contrôle de .env.example : $missing variable(s) non documentée(s), $leaks valeur(s) sensible(s)." >&2
  exit 1
fi
echo "Contrôle de .env.example : $total variable(s) lue(s) par l'application et l'exploitation, toutes documentées ; aucune valeur sensible."
