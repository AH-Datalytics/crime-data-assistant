#!/usr/bin/env bash
# Release input: an exact commit, exported from Git objects.
#
# Extracted so the deploy script and its test run the SAME code, following
# scripts/lib/prune-releases.sh. A test that re-implemented these rules would assert that a copy was
# correct, not that the rule ships.
#
# WHY THIS EXISTS. Until P1.4a a release was `rsync -a` of the operations repo's WORKING TREE.
# `git reset --hard` restores tracked files but removes neither untracked nor ignored ones, and no
# `git clean` ran anywhere, so whatever sat in that tree shipped. Measured on the live release
# 20260824_134957: three paths present in production that belong to no commit -- two untracked
# documents and one GITIGNORED `.pyc`. The `.pyc` is the one that matters, because it is invisible to
# `git status -uall` and appears only under `--ignored`; a contamination check written against the
# obvious predicate would have called that release clean.
#
# The deploy also took a BRANCH, so the operator never named the artifact they got: the tip could move
# between deciding to deploy and fetching.
#
# Usage:
#   source scripts/lib/release-export.sh
#   release_export_validate_sha   <sha>
#   release_export_assert_commit  <repo> <sha>
#   release_export_assert_ancestor <repo> <sha> <branch>
#   release_export_tree           <repo> <sha> <dest>
#   release_export_verify_blobs   <repo> <sha> <dest>       # "missing P" / "differs P ..." on stdout
#   release_export_refuse_lfs     <repo> <sha> <dest>       # "lfs-pointer P" on stdout
#   release_export_unexplained    <repo> <sha> <dest> <allowlist.json>   # "unexplained P" on stdout
#
# Each returns 0 when the property holds and 1 when it does not. Findings go to stdout so the deploy
# can mirror them into its log; refusals to proceed go to stderr.

# ---------------------------------------------------------------------------
# 1. The input must be an immutable commit
# ---------------------------------------------------------------------------

# A full 40-character lowercase hex SHA and nothing else. An abbreviation is refused rather than
# resolved: an abbreviation is not an identity, and `deploy dev` must not silently mean "whatever dev
# points at now".
release_export_validate_sha() {
  local sha="${1:-}"
  local re='^[0-9a-f]{40}$'
  if [[ ! "$sha" =~ $re ]]; then
    echo "release_export: not a full 40-character lowercase commit SHA: '${sha}'" >&2
    return 1
  fi
  return 0
}

# The object must exist AND be a commit. A tree or blob whose hash happens to be supplied would
# otherwise export something, and it would not be a release of anything.
release_export_assert_commit() {
  local repo="$1" sha="$2" type
  if ! type=$(git --no-optional-locks -C "$repo" cat-file -t "$sha" 2>/dev/null); then
    echo "release_export: $sha is not present in the object store at $repo" >&2
    return 1
  fi
  if [[ "$type" != "commit" ]]; then
    echo "release_export: $sha is a $type, not a commit" >&2
    return 1
  fi
  return 0
}

# The commit must be reachable from the branch the operator named. This is what stops an arbitrary
# commit -- a side branch, an abandoned experiment, a reverted change -- being deployed because its
# hash was pasted. It is also the assertion that will later carry L1: once `dev` accepts commits only
# through a checked pull request, "this SHA is an ancestor of origin/dev" is the evidence that it
# passed, and it needs no credential beyond the existing deploy key.
release_export_assert_ancestor() {
  local repo="$1" sha="$2" branch="$3"
  local ref="refs/remotes/origin/$branch"

  if ! git --no-optional-locks -C "$repo" rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then
    echo "release_export: no such remote-tracking ref: $ref (fetch first, or name the right branch)" >&2
    return 1
  fi

  local rc=0
  git --no-optional-locks -C "$repo" merge-base --is-ancestor "$sha" "$ref" || rc=$?
  if (( rc == 1 )); then
    echo "release_export: $sha is not an ancestor of $ref; refusing to deploy a commit that is not on the branch" >&2
    return 1
  fi
  if (( rc != 0 )); then
    echo "release_export: could not determine whether $sha is an ancestor of $ref (git exited $rc)" >&2
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# 2. Export from the object store, never from a working tree
# ---------------------------------------------------------------------------

release_export_tree() {
  local repo="$1" sha="$2" dest="$3"
  [[ -d "$dest" ]] || { echo "release_export: destination does not exist: $dest" >&2; return 1; }

  # PIPESTATUS rather than pipefail, so the check holds whether or not the caller set pipefail.
  git --no-optional-locks -C "$repo" archive --format=tar "$sha" | tar -x -C "$dest"
  local status=("${PIPESTATUS[@]}")
  if (( status[0] != 0 )); then
    echo "release_export: git archive failed for $sha (exit ${status[0]})" >&2
    return 1
  fi
  if (( status[1] != 0 )); then
    echo "release_export: extracting the archive into $dest failed (tar exit ${status[1]})" >&2
    return 1
  fi
  return 0
}

# Per-path blob equality against the commit tree.
#
# Stated as byte equality rather than "the archive extracted cleanly", because two `.gitattributes`
# mechanisms change what `git archive` emits while it still exits 0: `export-ignore` omits a path
# entirely, and `export-subst` rewrites its bytes. Both are caught here; neither would be caught by
# checking an exit code. `git hash-object` without `-w` computes and stores nothing.
release_export_verify_blobs() {
  local repo="$1" sha="$2" dest="$3"
  local problems=0 oid rel got

  while IFS=$'\t' read -r oid rel; do
    [[ -z "${oid:-}" ]] && continue
    if [[ ! -f "$dest/$rel" ]]; then
      echo "missing $rel"
      problems=$((problems + 1))
      continue
    fi
    got=$(cd "$dest" && git hash-object --no-filters -- "$rel" 2>/dev/null)
    if [[ "$got" != "$oid" ]]; then
      echo "differs $rel expected=$oid actual=${got:-unreadable}"
      problems=$((problems + 1))
    fi
  done < <(git --no-optional-locks -C "$repo" ls-tree -r --format='%(objectname)%x09%(path)' "$sha")

  (( problems == 0 )) || return 1
  return 0
}

# ---------------------------------------------------------------------------
# 3. Refuse a tracked Git LFS pointer
# ---------------------------------------------------------------------------
#
# When a path is LFS-tracked the pointer text IS the committed blob, so `release_export_verify_blobs`
# recomputes that blob's hash, matches the tree object exactly, and passes -- correctly, by its own
# definition. Without this refusal a release would publish a 130-byte text file where a database was
# expected. `.gitattributes` currently carries `*.db filter=lfs`, inert only because no `.db` path is
# tracked; materialized LFS exports are not supported and must not be reached by accident.
#
# The predicate parses the WHOLE FILE, never a substring. A pointer contains only the version, oid and
# size keys and nothing else, so a document that merely quotes the format -- the P1.4 contract itself
# does -- is not a pointer and must not be refused.
release_export_is_lfs_pointer() {
  local file="$1"
  [[ -f "$file" ]] || return 1

  local size
  size=$(wc -c < "$file" 2>/dev/null) || return 1
  size="${size// /}"
  (( size > 0 && size < 1024 )) || return 1

  local lines
  lines=$(wc -l < "$file" 2>/dev/null) || return 1
  lines="${lines// /}"
  (( lines == 3 )) || return 1

  local l1 l2 l3 extra
  { IFS= read -r l1; IFS= read -r l2; IFS= read -r l3; IFS= read -r extra; } < "$file"
  [[ -z "${extra:-}" ]] || return 1

  local re_version='^version https://git-lfs\.github\.com/spec/v[0-9]+$'
  local re_oid='^oid sha256:[0-9a-f]{64}$'
  local re_size='^size [0-9]+$'
  [[ "$l1" =~ $re_version ]] || return 1
  [[ "$l2" =~ $re_oid ]] || return 1
  [[ "$l3" =~ $re_size ]] || return 1
  return 0
}

# Scans the commit's own tracked path list rather than the directory, so the result cannot depend on
# what else has been added to the release by the time it runs.
release_export_refuse_lfs() {
  local repo="$1" sha="$2" dest="$3"
  local found=0 rel

  while IFS= read -r rel; do
    [[ -z "${rel:-}" ]] && continue
    [[ -f "$dest/$rel" ]] || continue
    if release_export_is_lfs_pointer "$dest/$rel"; then
      echo "lfs-pointer $rel"
      found=$((found + 1))
    fi
  done < <(git --no-optional-locks -C "$repo" ls-tree -r --name-only "$sha")

  (( found == 0 )) || return 1
  return 0
}

# ---------------------------------------------------------------------------
# 4. A closed set of post-export additions
# ---------------------------------------------------------------------------

# Validate and flatten the allowlist. Emits one TAB-separated
# "<expected_type>\t<scope>\t<path>" line per entry on stdout; on any schema problem it names the
# problem on stderr and fails. An absent or unparseable allowlist is a refusal, never an empty
# allowlist -- defaulting to empty would let a deleted fixture widen the gate to everything.
#
# THE EXPECTED OBJECT TYPE IS DERIVED HERE, from the (kind, scope) pair, so the mapping lives in one
# place and only the five reviewed combinations exist. Declaring a kind and then not enforcing it was
# a false acceptance: the gate matched on pathname alone, so `.env` could arrive as a regular file,
# `node_modules` as a symlink, and a permitted file as a directory -- all accepted.
release_export_read_allowed() {
  local file="$1"
  node -e '
const fs = require("fs");
const file = process.argv[1];
const DOC_FIELDS = ["_README", "entries"];
const FIELDS = ["path", "kind", "scope", "produced_by", "detail"];
const SCOPES = ["path", "tree"];
// The complete set of reviewed (kind, scope) pairs, and the object type each one requires.
const TYPES = {
  "shared_symlink|path": "symlink",
  "deploy_stamp|path": "file",
  "build_output|path": "file",
  "build_output|tree": "directory",
  "dependency_tree|tree": "directory"
};
const KINDS = ["shared_symlink", "deploy_stamp", "build_output", "dependency_tree"];
function die(message) { console.error("release_export: " + message); process.exit(1); }
let raw;
try { raw = fs.readFileSync(file, "utf8"); } catch (e) { die("allowlist is not readable: " + file); }
let doc;
try { doc = JSON.parse(raw); } catch (e) { die("allowlist is not valid JSON: " + file + ": " + e.message); }
if (!doc || typeof doc !== "object" || Array.isArray(doc)) die("allowlist must be a JSON object: " + file);
for (const field of Object.keys(doc)) {
  if (!DOC_FIELDS.includes(field)) {
    die("unknown top-level field " + field + " (allowed: " + DOC_FIELDS.join(", ") + ")");
  }
}
if (!Array.isArray(doc.entries) || doc.entries.length === 0) {
  die("allowlist must contain a non-empty entries array: " + file);
}
const seen = new Set();
for (const entry of doc.entries) {
  const label = entry && typeof entry.path === "string" ? entry.path : JSON.stringify(entry);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) die(label + ": each entry must be an object");
  for (const field of Object.keys(entry)) {
    if (!FIELDS.includes(field)) die(label + ": unknown field " + field + " (allowed: " + FIELDS.join(", ") + ")");
  }
  for (const field of FIELDS) {
    if (typeof entry[field] !== "string" || entry[field].length === 0) {
      die(label + ": missing or empty required field " + field);
    }
  }
  if (!KINDS.includes(entry.kind)) die(label + ": unknown kind " + entry.kind + " (allowed: " + KINDS.join(", ") + ")");
  if (!SCOPES.includes(entry.scope)) die(label + ": unknown scope " + entry.scope + " (allowed: " + SCOPES.join(", ") + ")");
  const expected = TYPES[entry.kind + "|" + entry.scope];
  if (!expected) die(label + ": kind " + entry.kind + " is not a reviewed combination with scope " + entry.scope);
  const parts = entry.path.split("/");
  if (entry.path.startsWith("/") || entry.path.includes("\\") || entry.path.endsWith("/") ||
      parts.includes("..") || parts.includes(".") || parts.includes("")) {
    die(label + ": path must be a relative POSIX path inside the release");
  }
  if (seen.has(entry.path)) die("duplicate path " + entry.path);
  seen.add(entry.path);
}
for (const entry of doc.entries) {
  console.log(TYPES[entry.kind + "|" + entry.scope] + "\t" + entry.scope + "\t" + entry.path);
}
' "$file"
}

# The deployment rules must come from the commit being deployed.
#
# The deploy sources its helper and reads its allowlist from the checkout it happens to be running
# from. Since the deploy no longer checks anything out, that checkout drifts: a release could be built
# from SHA X while the rules deciding what may be in it come from SHA Y, and the gap widens with every
# future deployment. This binds the executing bundle to DEPLOY_SHA before any release directory exists.
release_export_assert_self_matches() {
  local repo="$1" sha="$2" script_dir="$3"
  local problems=0 name tracked_path expected actual
  local names=("deploy-zero-downtime.sh" "lib/release-export.sh" "fixtures/release-allowed-extras.json")

  for name in "${names[@]}"; do
    tracked_path="scripts/$name"
    if ! expected=$(git --no-optional-locks -C "$repo" rev-parse "$sha:$tracked_path" 2>/dev/null); then
      echo "deploy-bundle-untracked $tracked_path is not in the tree of $sha"
      problems=$((problems + 1))
      continue
    fi
    if [[ ! -f "$script_dir/$name" ]]; then
      echo "deploy-bundle-absent $tracked_path is missing from the executing bundle"
      problems=$((problems + 1))
      continue
    fi
    actual=$(git hash-object --no-filters -- "$script_dir/$name" 2>/dev/null)
    if [[ "$actual" != "$expected" ]]; then
      echo "deploy-bundle-differs $tracked_path expected=$expected actual=${actual:-unreadable}"
      problems=$((problems + 1))
    fi
  done

  (( problems == 0 )) || return 1
  return 0
}

# Report every path in the release that is neither tracked at <sha> nor permitted by the allowlist.
#
# Reports the HIGHEST unexplained entry: an untracked, unpermitted directory is named once rather than
# every file beneath it, which is the difference between one actionable line and 26,798 of them. A
# directory that contains tracked content is descended into, so a stray file dropped beside tracked
# files is still named individually -- which is how the two untracked documents measured under docs/ in
# production would surface.
#
# Symlinks are reported by name and never followed: no target is read, opened or hashed, so a link into
# shared state cannot pull a secret or a database into this check.
release_export_unexplained() {
  local repo="$1" sha="$2" dest="$3" allowed_file="$4"
  [[ -d "$dest" ]] || { echo "release_export: no such release directory: $dest" >&2; return 1; }

  local allowed_lines
  allowed_lines=$(release_export_read_allowed "$allowed_file") || return 1

  local -A allow_exact=() allow_tree=() allow_type=() tracked=() tracked_dir=()
  local expected_type scope rel dir

  while IFS=$'\t' read -r expected_type scope rel; do
    [[ -z "${expected_type:-}" ]] && continue
    allow_type["$rel"]="$expected_type"
    if [[ "$scope" == "tree" ]]; then
      allow_tree["$rel"]=1
    else
      allow_exact["$rel"]=1
    fi
  done <<< "$allowed_lines"

  while IFS= read -r rel; do
    [[ -z "${rel:-}" ]] && continue
    tracked["$rel"]=1
    dir="$rel"
    while [[ "$dir" == */* ]]; do
      dir="${dir%/*}"
      tracked_dir["$dir"]=1
    done
  done < <(git --no-optional-locks -C "$repo" ls-tree -r --name-only "$sha")

  if (( ${#tracked[@]} == 0 )); then
    echo "release_export: $sha has no tracked paths; refusing to judge a release against an empty tree" >&2
    return 1
  fi

  local problems=0
  local -a queue=("")
  local prefix name candidate here actual_type

  while (( ${#queue[@]} > 0 )); do
    prefix="${queue[0]}"
    queue=("${queue[@]:1}")
    here="$dest${prefix:+/$prefix}"

    while IFS= read -r name; do
      [[ -z "${name:-}" ]] && continue
      candidate="${prefix:+$prefix/}$name"

      # Tracked: accepted, and not descended into.
      if [[ -n "${tracked[$candidate]:-}" ]]; then
        continue
      fi

      # Explicitly permitted: the DECLARED OBJECT TYPE is enforced, not merely the pathname. `-L` is
      # tested first and the branch never dereferences, so a symlink is classified as a link whatever
      # it points at -- which is what keeps this check from reading shared state.
      if [[ -n "${allow_exact[$candidate]:-}" || -n "${allow_tree[$candidate]:-}" ]]; then
        if [[ -L "$here/$name" ]]; then
          actual_type="symlink"
        elif [[ -d "$here/$name" ]]; then
          actual_type="directory"
        elif [[ -f "$here/$name" ]]; then
          actual_type="file"
        else
          actual_type="missing-or-other"
        fi
        if [[ "$actual_type" != "${allow_type[$candidate]}" ]]; then
          echo "wrong-type $candidate expected=${allow_type[$candidate]} actual=$actual_type"
          problems=$((problems + 1))
        fi
        continue
      fi

      # A symlink is judged as a link. -L is tested before -d so a link to a directory is never
      # followed.
      if [[ -L "$here/$name" ]]; then
        echo "unexplained $candidate"
        problems=$((problems + 1))
        continue
      fi

      if [[ -d "$here/$name" ]]; then
        if [[ -n "${tracked_dir[$candidate]:-}" ]]; then
          queue+=("$candidate")
        else
          echo "unexplained $candidate"
          problems=$((problems + 1))
        fi
        continue
      fi

      echo "unexplained $candidate"
      problems=$((problems + 1))
    done < <(find "$here" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | sort)
  done

  (( problems == 0 )) || return 1
  return 0
}
