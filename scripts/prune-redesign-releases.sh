#!/usr/bin/env bash
# Prune old /redesign releases under /opt/nibrs-beta/releases (never /opt/nibrs).
#
# Keeps: the 3 newest release directories, whatever `current` resolves to, and the release just before it.
# Deletes only real directories (never symlinks) directly under the releases directory whose names are
# YYYYMMDD_HHMMSS. Read-only fuser (and a /proc cwd/exe scan) must show nothing using a directory before it goes;
# if any check fails nothing is deleted. PRUNE_DRY_RUN=1 lists what would be removed and deletes nothing.
set -euo pipefail

BASE=/opt/nibrs-beta
REL="$BASE/releases"
KEEP_NEWEST=3

REL_REAL=$(readlink -f "$REL")
[ "$REL_REAL" = "$REL" ] || { echo "prune: $REL is not a plain directory ($REL_REAL); nothing deleted" >&2; exit 1; }

CUR=$(readlink -f "$BASE/current")
[ "$(dirname "$CUR")" = "$REL" ] || { echo "prune: current resolves outside $REL ($CUR); nothing deleted" >&2; exit 1; }
CUR_NAME=$(basename "$CUR")

# Timestamp-named real directories, oldest first (names sort chronologically).
mapfile -t ALL < <(find "$REL" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E '^[0-9]{8}_[0-9]{6}$' | sort)
echo "prune: ${#ALL[@]} releases; current=$CUR_NAME"

declare -A KEEP=()
for ((i = ${#ALL[@]} - KEEP_NEWEST; i < ${#ALL[@]}; i++)); do [ "$i" -ge 0 ] && KEEP[${ALL[$i]}]=1; done
KEEP[$CUR_NAME]=1
for i in "${!ALL[@]}"; do
  if [ "${ALL[$i]}" = "$CUR_NAME" ] && [ "$i" -gt 0 ]; then KEEP[${ALL[$((i - 1))]}]=1; fi
done

DEL=()
for n in "${ALL[@]}"; do [ -z "${KEEP[$n]:-}" ] && DEL+=("$n"); done
echo "prune: keeping: $(printf '%s\n' "${!KEEP[@]}" | sort | tr '\n' ' ')"
echo "prune: removing ${#DEL[@]}: ${DEL[*]:-none}"
[ "${#DEL[@]}" -gt 0 ] || exit 0

# Every check before any delete.
for n in "${DEL[@]}"; do
  d="$REL/$n"
  [ -d "$d" ] && [ ! -L "$d" ] && [ "$(readlink -f "$d")" = "$d" ] || { echo "prune: $d is not a plain directory; nothing deleted" >&2; exit 1; }
  if fuser -s "$d" 2>/dev/null; then echo "prune: $d is in use (fuser); nothing deleted" >&2; exit 1; fi
  for p in /proc/[0-9]*; do
    for l in cwd exe root; do
      t=$(readlink "$p/$l" 2>/dev/null || true)
      case "$t" in "$d"|"$d"/*) echo "prune: pid ${p#/proc/} has $l in $d; nothing deleted" >&2; exit 1 ;; esac
    done
  done
done

if [ "${PRUNE_DRY_RUN:-0}" = 1 ]; then echo "prune: dry run, nothing deleted"; exit 0; fi
for n in "${DEL[@]}"; do rm -rf --one-file-system -- "$REL/$n"; echo "prune: removed $n"; done
