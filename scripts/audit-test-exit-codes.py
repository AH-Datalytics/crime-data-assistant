"""Which test scripts can report a failure and still exit zero?

Read-only audit for the verification-integrity increment.

Two heuristics were wrong before this one, and both are worth remembering:

- Searching for the literal `process.exit(1)` flagged fifteen scripts that were fine. They end
  with `process.exit(fail > 0 ? 1 : 0)`, which is correct and does not contain `exit(1)`.
- Treating any `throw new` as a failing exit missed `test-stage2b-workbook.ts`, which throws
  inside every check, catches every one, prints "1 failed" and exits zero. A throw only ends the
  process if nothing catches it.

So a script is flagged only when it tracks failures and has no path that can end the process
non-zero: no explicit exit, no exit-code assignment, and no throw that could escape.
"""
import pathlib
import re

ROOT = pathlib.Path("scripts")
CANDIDATES = sorted(
    list(ROOT.glob("test-*.ts")) + list(ROOT.glob("test-*.js")) + list(ROOT.glob("validate-*.ts"))
)

EXIT_PATTERNS = [
    r"process\.exit\s*\(\s*[^0)\s]",   # exit(1), exit(fail > 0 ? 1 : 0), exit(failures ...)
    r"process\.exitCode\s*=",
]

# Only counted when the file has no catch block at all.
UNCAUGHT_THROW_PATTERNS = [
    r"\bthrow\s+new\s+",
    r"from\s+[\"']node:assert",
    r"require\([\"']assert",
]

# Deliberately narrow. A bare mention of "failures" also appears in test data and prose --
# `test-daily-query-analysis.js` carries "DB retry failed" inside a fixture -- and matching that
# flagged a script whose assertions throw and which exits 1 correctly. Only a counter being
# advanced counts as tracking failures.
FAILURE_PATTERNS = [
    r"\bfail(?:ures|ed|Count)?\b\s*(?:\+\+|\+=)",
    r"\bfail(?:ures|ed)?\.push\(",
    r"\bfailed\s*=\s*failed\s*\+\s*1",
]

flagged, sound, untracked = [], [], []
for path in CANDIDATES:
    src = path.read_text(encoding="utf-8", errors="replace")
    tracks = any(re.search(p, src) for p in FAILURE_PATTERNS)
    if not tracks:
        untracked.append(path)
        continue
    exits = any(re.search(p, src) for p in EXIT_PATTERNS)
    if not exits and not re.search(r"\bcatch\s*\(", src):
        exits = any(re.search(p, src) for p in UNCAUGHT_THROW_PATTERNS)
    (sound if exits else flagged).append(path)

print(f"scanned {len(CANDIDATES)} scripts")
print(f"  track failures and exit correctly : {len(sound)}")
print(f"  no failure tracking detected      : {len(untracked)}")
print(f"  CAN REPORT A FAILURE AND EXIT 0   : {len(flagged)}")
for path in flagged:
    print(f"    {str(path).replace(chr(92), '/')}")
raise SystemExit(1 if flagged else 0)
