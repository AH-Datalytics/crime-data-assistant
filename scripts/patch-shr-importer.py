#!/usr/bin/env python3
"""One-time patch: add derived-table rebuild to /opt/nibrs/scripts/shr-auto-update.js.

Appends normalize-shr-agencies + build-shr-state-population (--apply) after the
monthly SHR import so shr_agency_identity/shr_agency_alias/state_population
persist across refreshes. Idempotent — skips if already patched.
"""
import io

P = "/opt/nibrs/scripts/shr-auto-update.js"
ANCHOR = "  console.log('\\nUpdate complete!');"
MARKER = "Rebuilding SHR derived tables"

POST = """  // Post-import: rebuild derived tables so prompt/allowlist dependencies persist
  // (shr_agency_identity, shr_agency_alias, state_population — see repo docs/query-audit-2026-06-09-proposals.md)
  console.log('\\nRebuilding SHR derived tables...');
  execSync('cd /opt/nibrs/repo && SHR_DB_PATH=/opt/nibrs/shr.db NIBRS_DB_PATH=/opt/nibrs/nibrs.db npx tsx scripts/normalize-shr-agencies.ts --apply', { stdio: 'inherit', timeout: 600000 });
  execSync('cd /opt/nibrs/repo && SHR_DB_PATH=/opt/nibrs/shr.db RTCI_DB_PATH=/opt/nibrs/shared/crime_data.db npx tsx scripts/build-shr-state-population.ts --apply', { stdio: 'inherit', timeout: 600000 });
  console.log('Derived tables rebuilt.');

"""

s = io.open(P, encoding="utf-8").read()
if MARKER in s:
    print("already patched — no change")
elif s.count(ANCHOR) != 1:
    raise SystemExit(f"anchor not found exactly once (count={s.count(ANCHOR)}) — aborting")
else:
    io.open(P, "w", encoding="utf-8").write(s.replace(ANCHOR, POST + ANCHOR))
    print("patched")
