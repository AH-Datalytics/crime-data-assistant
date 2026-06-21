#!/usr/bin/env python3
"""Harden /opt/nibrs/scripts/shr-auto-update.js.

Adds two protections to the monthly SHR importer:
- default to current-year-only updates, with PROTECTED_UPDATE_YEARS blocking 2025
- rebuild derived tables so shr_agency_identity/shr_agency_alias/state_population
  persist across refreshes

Idempotent: skips each patch if it is already present.
"""
import io

P = "/opt/nibrs/scripts/shr-auto-update.js"
DERIVED_ANCHOR = "  console.log('\\nUpdate complete!');"
DERIVED_MARKER = "Rebuilding SHR derived tables"
YEAR_MARKER = "PROTECTED_UPDATE_YEARS"

OLD_YEAR_BLOCK = """const currentYear = now.getFullYear();
const yearsToUpdate = [currentYear - 1, currentYear];"""

NEW_YEAR_BLOCK = """const currentYear = now.getFullYear();
const protectedYears = new Set((process.env.PROTECTED_UPDATE_YEARS || '2025')
  .split(',')
  .map(s => parseInt(s.trim(), 10))
  .filter(Number.isFinite));
const requestedYears = (process.env.SHR_UPDATE_YEARS || String(currentYear))
  .split(',')
  .map(s => parseInt(s.trim(), 10))
  .filter(Number.isFinite);
const yearsToUpdate = [...new Set(requestedYears)].sort();
const blockedYears = yearsToUpdate.filter(y => protectedYears.has(y));
if (blockedYears.length) {
  throw new Error(`Refusing to update protected SHR year(s): ${blockedYears.join(', ')}`);
}"""

DERIVED_POST = """  // Post-import: rebuild derived tables so prompt/allowlist dependencies persist.
  // See docs/query-audit-2026-06-09-proposals.md.
  console.log('\\nRebuilding SHR derived tables...');
  execSync('cd /opt/nibrs/repo && SHR_DB_PATH=/opt/nibrs/shr.db NIBRS_DB_PATH=/opt/nibrs/nibrs.db npx tsx scripts/normalize-shr-agencies.ts --apply', { stdio: 'inherit', timeout: 600000 });
  execSync('cd /opt/nibrs/repo && SHR_DB_PATH=/opt/nibrs/shr.db RTCI_DB_PATH=/opt/nibrs/shared/crime_data.db npx tsx scripts/build-shr-state-population.ts --apply', { stdio: 'inherit', timeout: 600000 });
  console.log('Derived tables rebuilt.');

"""


def main():
    source = io.open(P, encoding="utf-8").read()
    changed = False

    if YEAR_MARKER in source:
        print("year protection already patched")
    elif OLD_YEAR_BLOCK in source:
        source = source.replace(OLD_YEAR_BLOCK, NEW_YEAR_BLOCK)
        changed = True
        print("patched year protection")
    else:
        raise SystemExit("year block anchor not found; aborting")

    if DERIVED_MARKER in source:
        print("derived-table rebuild already patched")
    elif source.count(DERIVED_ANCHOR) == 1:
        source = source.replace(DERIVED_ANCHOR, DERIVED_POST + DERIVED_ANCHOR)
        changed = True
        print("patched derived-table rebuild")
    else:
        raise SystemExit(
            f"derived-table anchor not found exactly once "
            f"(count={source.count(DERIVED_ANCHOR)}); aborting"
        )

    if changed:
        io.open(P, "w", encoding="utf-8").write(source)
    else:
        print("already patched; no change")


if __name__ == "__main__":
    main()
