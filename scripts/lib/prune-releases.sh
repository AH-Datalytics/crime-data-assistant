#!/usr/bin/env bash
# Release pruning, extracted so the deploy script and its test run the SAME code.
#
# This lived inline in scripts/deploy-zero-downtime.sh. Its test necessarily
# copied the logic into a here-doc, which meant the test could pass while the
# deployed pruning diverged -- the test asserted that a copy of the rule was
# correct, not that the rule shipped. Sourcing one file from both places removes
# that gap.
#
# Usage:
#   source scripts/lib/prune-releases.sh
#   prune_releases <releases_dir> <current_target> <keep_count> [pinned_file]
#
# Emits one line per decision on stdout: "keep-current NAME", "keep-pinned NAME",
# or "remove NAME". The deploy script mirrors these into its own log.

# Read the pin list: one release name per line, blank lines and #-comments
# ignored, CR and trailing whitespace stripped so a file edited on Windows or
# with a stray space still matches.
prune_read_pinned() {
  local pinned_file="$1"
  [[ -f "$pinned_file" ]] || return 0
  grep -vE '^[[:space:]]*(#|$)' "$pinned_file" 2>/dev/null | tr -d '\r' | sed 's/[[:space:]]*$//'
}

prune_is_pinned() {
  local name="$1" pinned="$2"
  [[ -z "$pinned" ]] && return 1
  local pin
  while IFS= read -r pin; do
    [[ -n "$pin" && "$pin" == "$name" ]] && return 0
  done <<< "$pinned"
  return 1
}

# Two releases are never removed: the one the symlink currently points at, and
# any release named in the pin file.
#
# Pinning exists because "keep the last N" is not a rollback guarantee. A
# baseline preserved for an observation window is exactly the release that ages
# out while it is still needed -- N deploys after pinning, the artifact you
# planned to roll back to is gone. A git tag does not help: it preserves the
# source, not the built release directory, and a rebuild is not the same artifact.
prune_releases() {
  local releases_dir="$1" current_target="$2" keep_releases="$3" pinned_file="${4:-$1/.pinned}"

  [[ -d "$releases_dir" ]] || { echo "prune_releases: no such directory: $releases_dir" >&2; return 1; }

  local pinned
  pinned="$(prune_read_pinned "$pinned_file")"

  local release_count remove_count candidates old name old_full
  # A subshell for the listing keeps the caller's working directory untouched.
  release_count=$(cd "$releases_dir" && ls -1d */ 2>/dev/null | wc -l)
  (( release_count > keep_releases )) || return 0
  remove_count=$(( release_count - keep_releases ))
  candidates=$(cd "$releases_dir" && ls -1d */ | head -n "$remove_count")

  # A while-read over a here-string rather than a pipe, so the loop body runs in
  # this shell and any state it sets survives.
  while IFS= read -r old; do
    [[ -z "$old" ]] && continue
    name="${old%/}"
    old_full="$releases_dir/$name"
    if [[ "$old_full" == "$current_target" ]]; then
      echo "keep-current $name"
    elif prune_is_pinned "$name" "$pinned"; then
      echo "keep-pinned $name"
    else
      echo "remove $name"
      rm -rf "$old_full"
    fi
  done <<< "$candidates"
}
