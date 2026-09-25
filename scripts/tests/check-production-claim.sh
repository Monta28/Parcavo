#!/usr/bin/env bash
# Contrôle de la définition de terminé (CDC 19.3, R-19.3-07) : le dépôt n'annonce jamais la V1 « prête pour
# la production » (en anglais ou en français). Seules les lignes qui énoncent l'interdiction elle-même (avec
# « jamais », « pas », « aucun » ou « interdit ») sont admises : cahier des charges, traçabilité, rapports.
#
# Usage : scripts/tests/check-production-claim.sh [--root <dossier>]   (code 1 et liste « fichier:ligne »)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
if [ "${1:-}" = "--root" ]; then root="$(cd "${2:?--root <dossier>}" && pwd)"; fi
cd "$root"

# Motif assemblé pour que ce script ne se signale pas lui-même.
# Alternatives plutôt que classes de caractères : correct aussi hors locale UTF-8 (octets de « ê », « à »).
claim="(production[ _-]?$(printf 'ready')|pr(ê|e)te?s? (pour|à|a) (la )?(mise en )?production)"
negation="(jamais|\bpas\b|aucun|interdit)"

if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  mapfile -t files < <(git -C "$root" ls-files -co --exclude-standard | grep -vE '(^|/)(node_modules|dist|\.next|playwright-report|test-results)/' || true)
else
  mapfile -t files < <(find . -type f ! -path '*/node_modules/*' ! -path '*/.git/*' | sed 's#^\./##')
fi

violations=0
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  case "$f" in *.png|*.jpg|*.jpeg|*.pdf|*.xlsx|*.ico|*.woff|*.woff2|*.lock|pnpm-lock.yaml) continue ;; esac
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    line="${hit#*:}"
    if ! printf '%s' "$line" | grep -qiE "$negation"; then
      echo "$f:${hit%%:*} — annonce « prête pour la production » interdite (CDC 19.3)" >&2
      violations=$((violations + 1))
    fi
  done < <(grep -niE "$claim" "$f" 2>/dev/null || true)
done

if [ "$violations" -gt 0 ]; then
  echo "Contrôle des annonces : $violations mention(s) interdite(s)." >&2
  exit 1
fi
echo "Contrôle des annonces : ${#files[@]} fichier(s) contrôlé(s) ; aucune annonce « prête pour la production »."
