#!/usr/bin/env bash
# Contrôle des images Docker (CDC 14.1, R-14.1-06) : aucune image « latest » ni sans version précise.
#
#  - Dockerfile* : chaque FROM vise une étape déjà déclarée, ou une image « nom:version@sha256:<empreinte> »
#    (les arguments ${ARG} sont résolus par leur valeur par défaut) ; « latest » est refusé.
#  - docker-compose*.yml : une image téléchargée (service sans « build ») est épinglée « nom:version@sha256:… » ;
#    une image construite localement (service avec « build ») porte une étiquette explicite, jamais « latest ».
#
# Usage : scripts/tests/check-image-tags.sh [--root <dossier>]   (code 1 et liste « fichier:ligne — motif »)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
if [ "${1:-}" = "--root" ]; then root="$(cd "${2:?--root <dossier>}" && pwd)"; fi
cd "$root"

errors=0
fail() { echo "$1 — $2" >&2; errors=$((errors + 1)); }
PINNED='^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?(:[0-9]+)?(/[a-z0-9._/-]+)?:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}@sha256:[0-9a-f]{64}$'
is_latest() { case "$1" in *:latest|*:latest@*) return 0 ;; *) return 1 ;; esac; }

mapfile -t dockerfiles < <(find . -path ./node_modules -prune -o -path '*/node_modules' -prune -o -path './.git' -prune -o -type f \( -name 'Dockerfile' -o -name 'Dockerfile.*' -o -name '*.Dockerfile' \) -print | sort)
mapfile -t composes < <(find . -maxdepth 2 -path '*/node_modules' -prune -o -type f \( -name 'docker-compose*.yml' -o -name 'docker-compose*.yaml' -o -name 'compose*.yml' -o -name 'compose*.yaml' \) -print | sort)
if [ "${#dockerfiles[@]}" -eq 0 ] && [ "${#composes[@]}" -eq 0 ]; then
  echo "Aucun Dockerfile ni fichier compose trouvé dans $root" >&2
  exit 1
fi

checked=0
for file in "${dockerfiles[@]}"; do
  f="${file#./}"
  declare -A args=()
  stages=" "
  lineno=0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    trimmed="$(printf '%s' "$line" | sed -E 's/^[[:space:]]+//')"
    upper="$(printf '%s' "$trimmed" | cut -d' ' -f1 | tr '[:lower:]' '[:upper:]')"
    if [ "$upper" = "ARG" ]; then
      decl="$(printf '%s' "$trimmed" | sed -E 's/^[Aa][Rr][Gg][[:space:]]+//')"
      name="${decl%%=*}"
      if [ "$decl" != "$name" ]; then args["$name"]="${decl#*=}"; fi
    elif [ "$upper" = "FROM" ]; then
      checked=$((checked + 1))
      set -- $trimmed
      shift
      while [ "${1:-}" != "" ] && [ "${1#--}" != "$1" ]; do shift; done
      image="${1:-}"
      alias=""
      if [ "$(printf '%s' "${2:-}" | tr '[:lower:]' '[:upper:]')" = "AS" ]; then alias="${3:-}"; fi
      resolved="$image"
      if [[ "$image" =~ ^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$ ]]; then
        var="${BASH_REMATCH[1]}"
        resolved="${args[$var]:-}"
        [ -n "$resolved" ] || fail "$f:$lineno" "FROM $image : argument sans valeur par défaut, version non vérifiable"
      fi
      if [ -n "$resolved" ]; then
        if [[ "$stages" == *" $resolved "* ]] || [ "$resolved" = "scratch" ]; then
          :
        elif is_latest "$resolved"; then
          fail "$f:$lineno" "image « $resolved » : étiquette latest interdite"
        elif ! [[ "$resolved" =~ $PINNED ]]; then
          fail "$f:$lineno" "image « $resolved » non épinglée (attendu nom:version@sha256:<empreinte>)"
        fi
      fi
      if [ -n "$alias" ]; then stages="$stages$alias "; fi
    fi
  done < "$file"
  unset args
done

for file in "${composes[@]}"; do
  f="${file#./}"
  # service ␟ build(0/1) ␟ image ␟ ligne, pour chaque service du bloc « services: » (séparateur non blanc :
  # un champ vide n'est pas absorbé par read).
  while IFS=$'\x1f' read -r service build image line; do
    [ -n "$service" ] || continue
    if [ -z "$image" ]; then
      if [ "$build" = "1" ]; then fail "$f" "service $service : image construite sans étiquette explicite (latest implicite)"; fi
      continue
    fi
    checked=$((checked + 1))
    image="${image%\"}"; image="${image#\"}"; image="${image%\'}"; image="${image#\'}"
    if is_latest "$image"; then
      fail "$f:$line" "service $service : image « $image » en latest"
    elif [ "$build" = "1" ]; then
      case "$image" in
        *:*) ;;
        *) fail "$f:$line" "service $service : image construite « $image » sans étiquette explicite (latest implicite)" ;;
      esac
    elif ! [[ "$image" =~ $PINNED ]]; then
      fail "$f:$line" "service $service : image « $image » non épinglée (attendu nom:version@sha256:<empreinte>)"
    fi
  done < <(awk '
    /^services:[[:space:]]*$/ { in_services = 1; next }
    /^[^[:space:]#]/ { in_services = 0 }
    in_services && /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ { svc = $1; sub(/:$/, "", svc); order[++n] = svc; next }
    in_services && svc != "" && /^    build:/ { build[svc] = 1 }
    in_services && svc != "" && /^    image:/ { v = $0; sub(/^    image:[[:space:]]*/, "", v); sub(/[[:space:]]+#.*$/, "", v); image[svc] = v; line[svc] = NR }
    END { for (i = 1; i <= n; i++) { s = order[i]; printf "%s\037%d\037%s\037%s\n", s, (s in build) ? 1 : 0, image[s], line[s] } }
  ' "$file")
done

if [ "$checked" -eq 0 ]; then
  echo "Aucune image contrôlée (FROM ou image:) : contrôle sans objet, refusé." >&2
  exit 1
fi
if [ "$errors" -gt 0 ]; then
  echo "Contrôle des images : $errors écart(s)." >&2
  exit 1
fi
echo "Contrôle des images : ${#dockerfiles[@]} Dockerfile(s), ${#composes[@]} fichier(s) compose, $checked image(s) — aucune image latest ni non épinglée."
