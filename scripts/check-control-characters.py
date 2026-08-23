"""Escape-integrity gate: no stray control characters in tracked text.

WHY THIS EXISTS. Four defects in one working session, all the same class, all invisible to `grep`, to
an editor, and to a file reader:

  1. A PowerShell regex meant to end in a word boundary ended in byte 0x08 instead. The tripwire it
     guarded -- "the shipped script must not invoke ssh directly" -- was VACUOUS and passed three
     review rounds before a reviewer found it.
  2. and 3. Two documents corrupted where an escape was written through a shell: a newline split a
     line mid-path, a carriage return was injected, and a backspace silently ate a character.
  4. A Windows path parsed as a unicode escape.

Every one of them renders as ordinary text. A byte-level check is the only thing that sees them.

TWO VIEWS, TWO INDEPENDENT VERDICTS. There are two different questions here, they have different
answers, and collapsing them into one verdict loses information either way round:

  VERDICT A -- REPOSITORY INTEGRITY. Scans the bytes Git has RECORDED: the index blob for each tracked
  path. This is what every checkout is derived from and therefore what actually propagates to other
  machines. It is checkout-INDEPENDENT: it reports the same result on a developer with
  core.autocrlf=true as on one with autocrlf=false, because it never looks at the working tree. This
  is the verdict that says "what we committed is portable."

  VERDICT B -- WORKING-TREE EXECUTABILITY. Scans the bytes on disk for each tracked path -- the bytes
  the test suite and the runtime actually open, parse and execute. A clean index proves nothing about
  a file that has an unstaged control byte in it right now, and that file is the one running. This is
  the verdict that says "what we are about to run is sound."

  Neither subsumes the other. A file can be clean in the index and corrupt on disk (an unstaged edit
  -- and the tests still execute the corrupt copy). A file can be sound on disk and corrupt in the
  index (staged separately from what was verified, and every other checkout gets the corrupt one).
  Both verdicts are always computed and always reported, even when one of them fails.

THE RULE, AND WHERE THE TWO VIEWS DIVERGE.

    Reject any byte below 0x20 other than TAB (0x09) and LF (0x0A).
    CR (0x0D) is never permitted alone. A lone CR is a defect in either view.

    CRLF is where the views legitimately differ:

      In the INDEX, a CRLF pair is permitted only on a path whose attributes DECLARE `eol=crlf`.
      Recorded content is meant to be normalised, so a CRLF that nothing declared is a defect.

      In the WORKING TREE, a CRLF pair is ORDINARY and permitted by default. A developer with
      core.autocrlf=true has CRLF in every file, legitimately, and failing that is failing a
      configuration rather than a defect. The one exception is a path that declares `eol=lf`: there,
      Git has promised LF on checkout, something downstream depends on that promise (this repository
      has a digest that does), and CRLF on disk means the promise is broken.

An earlier draft of this gate permitted every CR, which would have missed defect 2 above -- one of its
own motivating incidents. That is why the lone-CR case is spelled out rather than waved through.

BINARY EXCLUSION, AND THE TWO HOLES IT WOULD OTHERWISE LEAVE. Binary files are excluded using Git's
own classification (`git ls-files --eol` reporting `i/-text`), never by guessing from the extension.
That exclusion leaks in two directions, and both leaks were found by running it rather than by reading
it:

  RULE 2. Excluding all Git-classified binaries once excluded `lib/result-digest.ts`, a TYPESCRIPT
  SOURCE that Git called binary because it held a raw NUL byte where an escape belonged -- so the
  exclusion would have hidden a source file from the gate whose whole purpose is protecting source
  files. A source-extension file that Git classifies binary is therefore reported in its own right.

  RULE 3. Git's binary heuristic treats a LONE CR as binary, with no NUL byte anywhere in the file.
  So a bare-CR defect -- one of this gate's own motivating incidents -- classified its file `i/-text`
  and the exclusion skipped it. Rule 2 caught that only by luck, because the file happened to have a
  source extension; on a `.csv` or an extensionless path it would have been invisible.

  Rule 3 closes it without reimplementing Git's heuristic: a path Git calls binary whose content has
  NO NUL byte was not called binary for a binary reason. It is reported AND byte-scanned, so the
  actual offending byte gets named. A path that does contain a NUL is genuinely binary and stays
  excluded. A path whose ATTRIBUTES declare `-text` -- an LFS pointer, for instance -- is a deliberate
  declaration rather than a heuristic verdict, and is excluded without comment.

WHAT THIS GATE CANNOT DO. It proves no corrupted escape is PRESENT. It cannot prove a required escape
is ABSENT -- a regex silently missing its word boundary is perfectly well-formed text. That needs a
positive assertion at the point of use, which is a separate mechanism and not this file's job.

Read-only. Exits non-zero if EITHER verdict fails.
"""
import os
import subprocess
import sys

TAB, LF, CR = 0x09, 0x0A, 0x0D

INDEX_VIEW = "index"
WORKTREE_VIEW = "worktree"

# A file with one of these extensions should never be Git-classified binary.
SOURCE_EXTENSIONS = (
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".ps1", ".psm1",
    ".json", ".md", ".sql", ".yml", ".yaml", ".css", ".html", ".sh", ".txt",
)

# Rule 3 has to read the content of a Git-classified binary to find out whether it holds a NUL. A
# tracked asset can be arbitrarily large, so anything past this is taken at Git's word and counted in
# the report rather than read. Git's own heuristic only inspects the first 8000 bytes; this is three
# orders of magnitude more generous than it needs to be and still bounded.
BINARY_INSPECTION_LIMIT = 8 * 1024 * 1024


# The allowlist is EMPTY, and that is the point.
#
# Its first run found two real pre-existing defects: four regex word boundaries in
# scripts/replay-production-queries.js that had become 0x08 bytes (so the pattern matched
# "myagency_monthlyx"), and a raw 0x1F delimiter in scripts/historical_core.py. Both were recorded
# here, keyed by (view, path, byte, exact count) so neither adding nor removing an occurrence could
# pass unnoticed, and both have now been repaired with behavioural and runtime-equivalence tests.
#
# Kept as an empty structure deliberately: the mechanism stays available and reviewable, while the
# steady state is zero known exceptions. An allowlist that carries entries indefinitely stops being a
# record and becomes permanent debt, so anything added here needs a disposition and an owner.
#
# Keyed by VIEW as well as path, because the two views ask different questions: an exception granted
# for recorded content is not automatically an exception for the bytes being executed.
KNOWN = {}


def git(args):
    result = subprocess.run(["git"] + args, capture_output=True)
    if result.returncode != 0:
        sys.stderr.write("git %s failed: %s\n" % (" ".join(args), result.stderr.decode("utf-8", "replace")))
        raise SystemExit(2)
    return result.stdout


def repo_root():
    return git(["rev-parse", "--show-toplevel"]).decode("utf-8", "surrogateescape").strip()


ATTR_MARKER = "attr/"


def parse_eol_record(line):
    """Parse one `git ls-files --eol` line into path, index/worktree eol, and attribute TOKENS.

    Format: "i/lf    w/crlf  attr/text eol=lf     \tpath"

    The attribute field is `attr/` followed by SPACE-SEPARATED attributes, so only the first of them
    carries the `attr/` prefix. A previous version of this parser kept just the prefixed token, which
    silently discarded `eol=lf` and `eol=crlf` -- the two values every eol decision in this file
    depends on. Both branches that consult them were therefore dead, and nothing failed, because a
    dropped attribute reads exactly like an absent one. That is why attributes are returned as a token
    list and matched exactly, and why `test_escape_integrity_gate.py` asserts this function's output
    directly rather than only its downstream effect.
    """
    if "\t" not in line:
        return None
    meta, path = line.split("\t", 1)
    marker = meta.find(ATTR_MARKER)
    head = meta[:marker] if marker >= 0 else meta
    fields = head.split()
    attrs = meta[marker + len(ATTR_MARKER):].split() if marker >= 0 else []
    return {
        "path": path,
        "index_eol": next((f[2:] for f in fields if f.startswith("i/")), ""),
        "worktree_eol": next((f[2:] for f in fields if f.startswith("w/")), ""),
        "attrs": attrs,
    }


def tracked_files():
    """Every tracked path with Git's own eol classification and declared attributes."""
    records = []
    for raw in git(["ls-files", "--eol", "-z"]).split(b"\x00"):
        if not raw:
            continue
        record = parse_eol_record(raw.decode("utf-8", "surrogateescape"))
        if record is not None:
            records.append(record)
    return records


def blob_bytes(paths):
    """Read each path's INDEX blob in one git process."""
    if not paths:
        return {}
    request = b"".join((":" + p).encode("utf-8", "surrogateescape") + b"\n" for p in paths)
    proc = subprocess.run(["git", "cat-file", "--batch"], input=request, capture_output=True)
    if proc.returncode != 0:
        sys.stderr.write("git cat-file --batch failed\n")
        raise SystemExit(2)
    data, out, i = proc.stdout, {}, 0
    for path in paths:
        newline = data.index(b"\n", i)
        header = data[i:newline].decode("utf-8", "replace")
        if header.endswith("missing"):
            i = newline + 1
            continue
        size = int(header.rsplit(" ", 1)[1])
        start = newline + 1
        out[path] = data[start:start + size]
        i = start + size + 1  # trailing newline after the blob
    return out


def blob_sizes(paths):
    """Each path's index blob size, in one git process."""
    if not paths:
        return {}
    request = b"".join((":" + p).encode("utf-8", "surrogateescape") + b"\n" for p in paths)
    proc = subprocess.run(["git", "cat-file", "--batch-check"], input=request, capture_output=True)
    if proc.returncode != 0:
        sys.stderr.write("git cat-file --batch-check failed\n")
        raise SystemExit(2)
    sizes = {}
    for path, raw in zip(paths, proc.stdout.decode("utf-8", "replace").splitlines()):
        if raw.strip().endswith("missing"):
            continue
        sizes[path] = int(raw.rsplit(" ", 1)[1])
    return sizes


def triage_binaries(binary_records):
    """Rule 2 and rule 3 over the paths Git classifies binary.

    Returns (problems, recovered paths, deferred count). A `recovered` path is one Git called binary
    that holds no NUL byte -- so it was not called binary for a binary reason -- and which therefore
    rejoins the byte scan.
    """
    problems, recovered, deferred = [], [], 0

    heuristic = [r for r in binary_records if "-text" not in r["attrs"]]
    for r in binary_records:
        if r["path"].lower().endswith(SOURCE_EXTENSIONS):
            problems.append("%s: Git classifies this source file as BINARY -- it almost certainly "
                            "contains a raw control byte where an escape belongs" % r["path"])

    sizes = blob_sizes([r["path"] for r in heuristic])
    inspect = [r["path"] for r in heuristic if sizes.get(r["path"], 0) <= BINARY_INSPECTION_LIMIT]
    deferred = len(heuristic) - len(inspect)

    for path, data in blob_bytes(inspect).items():
        if b"\x00" in data:
            continue  # genuinely binary; stays excluded from the byte scan
        problems.append("%s: Git classifies this as BINARY although it contains no NUL byte -- Git's "
                        "heuristic also calls a lone CR binary, so this is a control-character "
                        "defect, not a binary file" % path)
        recovered.append(path)

    return problems, recovered, deferred


def worktree_bytes(root, paths):
    """Read each path's WORKING-TREE bytes. Returns (contents, absent paths).

    A tracked path can legitimately be absent from disk -- staged for deletion, for instance. That is
    not this gate's concern, but it is not silently dropped either: absent paths are counted and
    reported, because "scanned nothing" and "scanned everything" must not look alike.
    """
    contents, absent = {}, []
    for path in paths:
        full = os.path.join(root, path.replace("/", os.sep))
        if not os.path.isfile(full):
            absent.append(path)
            continue
        with open(full, "rb") as handle:
            contents[path] = handle.read()
    return contents, absent


def scan(data, crlf_allowed):
    """Findings as (offset, line, byte, why)."""
    findings, i, n = [], 0, len(data)
    line = 1
    while i < n:
        b = data[i]
        if b == LF:
            line += 1
            i += 1
            continue
        if b >= 0x20 or b == TAB:
            i += 1
            continue
        if b == CR:
            paired = i + 1 < n and data[i + 1] == LF
            if not paired:
                findings.append((i, line, b, "lone CR"))
            elif not crlf_allowed:
                findings.append((i, line, b, "CRLF where attributes require LF"))
            else:
                i += 1  # consume the LF of a legitimate pair
                line += 1
            i += 1
            continue
        findings.append((i, line, b, "control byte 0x%02x" % b))
        i += 1
    return findings


def crlf_allowed_for(view, attrs):
    """The one rule that differs between the two views. `attrs` is a token list, matched exactly."""
    if view == INDEX_VIEW:
        # Recorded content is normalised content: a CRLF nobody declared is a defect.
        return "eol=crlf" in attrs
    # On disk, CRLF is ordinary -- unless a declared eol=lf promised otherwise.
    return "eol=lf" not in attrs


def scan_view(view, records, contents):
    """Byte-scan one view's contents under that view's CRLF rule. Returns (problems, accounted)."""
    by_path = {r["path"]: r for r in records}
    problems, accounted = [], {}
    for path, data in sorted(contents.items()):
        allowed = crlf_allowed_for(view, by_path[path]["attrs"])
        for offset, line, byte, why in scan(data, allowed):
            key = (view, path, byte)
            if key in KNOWN:
                accounted[key] = accounted.get(key, 0) + 1
                continue
            problems.append("%s:%d: %s (byte offset %d)" % (path, line, why, offset))
    return problems, accounted


def stale_allowlist_problems(view, accounted):
    """A recorded finding must still be exactly as recorded.

    One more or one fewer is a change worth failing on, which is what keeps the allowlist from
    silently becoming a blindfold.
    """
    problems = []
    for key, entry in KNOWN.items():
        if key[0] != view:
            continue
        seen = accounted.get(key, 0)
        if seen != entry["count"]:
            problems.append("%s: expected %d recorded occurrence(s) of byte 0x%02x, found %d -- the "
                            "allowlist entry is stale and must be revisited"
                            % (key[1], entry["count"], key[2], seen))
    return problems


def report(label, question, problems, notes):
    verdict = "PASS" if not problems else "FAIL"
    print("  %s: %s" % (label, verdict))
    print("      %s" % question)
    for line in notes:
        print("      " + line)
    for p in problems:
        print("      PROBLEM  " + p)
    return verdict


def main():
    records = tracked_files()
    binary = [r for r in records if r["index_eol"] == "-text"]
    text = [r for r in records if r["index_eol"] != "-text"]

    # Rules 2 and 3, reported under repository integrity: what Git calls binary is not always binary,
    # and both directions of that mistake hide exactly the defects this gate exists to find.
    binary_problems, recovered, deferred = triage_binaries(binary)

    # Recovered paths rejoin BOTH scans: the offending byte is in the recorded blob and, unless
    # someone has already fixed it on disk, in the file being executed too.
    paths = [r["path"] for r in text] + recovered

    index_problems, index_accounted = scan_view(INDEX_VIEW, records, blob_bytes(paths))
    index_problems = binary_problems + index_problems
    index_problems += stale_allowlist_problems(INDEX_VIEW, index_accounted)

    contents, absent = worktree_bytes(repo_root(), paths)
    worktree_problems, worktree_accounted = scan_view(WORKTREE_VIEW, records, contents)
    worktree_problems += stale_allowlist_problems(WORKTREE_VIEW, worktree_accounted)

    print("escape-integrity gate: %d tracked files (%d text, %d binary by Git classification)"
          % (len(records), len(text), len(binary)))
    if KNOWN:
        print("  %d recorded pre-existing finding(s), each awaiting its own decision:" % len(KNOWN))
        for (view, path, byte), entry in sorted(KNOWN.items()):
            print("    [%s] %s  byte 0x%02x x%d" % (view, path, byte, entry["count"]))

    # Both verdicts are always computed and always printed. Reporting only the first failure would
    # hide the other view's state at exactly the moment someone needs to know it.
    a_notes = ["scanned %d recorded blob(s); CRLF permitted only where eol=crlf is declared"
               % len(paths)]
    if recovered:
        a_notes.append("%d path(s) Git called binary rejoined the scan under rule 3" % len(recovered))
    if deferred:
        a_notes.append("%d Git-classified binary path(s) exceeded the %d-byte inspection limit and "
                       "were taken at Git's word" % (deferred, BINARY_INSPECTION_LIMIT))
    a = report("verdict A  repository integrity (index blobs)",
               "question: is what we committed portable and checkout-independent?",
               index_problems, a_notes)

    notes = ["scanned %d file(s) on disk; ordinary CRLF permitted, LF enforced where eol=lf is declared"
             % len(contents)]
    if absent:
        shown = ", ".join(absent[:5]) + (" ..." if len(absent) > 5 else "")
        notes.append("%d tracked path(s) absent from the working tree, not scanned: %s"
                     % (len(absent), shown))
    b = report("verdict B  working-tree executability (bytes on disk)",
               "question: is what we are about to run sound?",
               worktree_problems, notes)

    if a == "PASS" and b == "PASS":
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
