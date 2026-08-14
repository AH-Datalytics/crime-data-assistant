# Stage 2A taxonomy — correction and retraction

**Date:** 2026-08-13 · **Branch:** `feature/verified-answer-only`
**Status:** Corrects `5348410`, which is **superseded**. Stage 2A implementation remains blocked.

## 1. Retraction

`5348410` and its review claimed:

| Claim in `5348410` | Status |
|---|---|
| "55/55 branches verified" | **RETRACTED** — the denominator was never enforced. A missing case printed a NOTE; deleting a case and its catalog entry passed silently. |
| "Register A = 40 (39 operation-backed + sweep-only)" | **RETRACTED** — derived from a catalog with no health contracts, and inflated by phantom capabilities minted from synthetic "unavailable" answers. |
| "deterministic-shooting verified through the real handler" | **RETRACTED and FALSE** — the case recorded `tables:["incidents"]` with `prepOnly:["incidents"]`, i.e. **emitted SQL was empty**. A genuine shooting exit joins `victims` (`shr-query/route.ts:551`). The guardrail string matched a non-factual exit. The disproof was inside the artifact the commit shipped. |
| "capability contracts carry artifact, columns, coverage, integrity, availability, receipt" | **RETRACTED** — the catalog held only `family, capability, artifact, tables, prepOnly`. |
| "column checks are exact" | **RETRACTED** — the check was `columnsIn(...).length > 0`; removing `cleared_E` still passed. |

The root failure was not the method — executing builders is right — but **asserting more than the
instrument measured**, and not checking the instrument's own output against the claims made about
it. That is the same failure as the three static-extraction rounds, one level up.

`5348410` is preserved as the error record. Git history preserves the earlier plan drafts.

## 2. Corrected results

| Measure | Value |
|---|---|
| Sealed families today / after Task 1A | 26 / 29 |
| Operation cases | **56** |
| — factual | **54** |
| — unavailable (seal no capability) | **2** |
| Importable-builder / route-handler cases | 54 / 2 |
| **Operation-backed capabilities** | **50** |
| Registry-sweep only (`current.national`) | 1 |

The count moved from 40 because **exact required columns are part of capability identity**:
`shr:metadata-agency-directory` and `shr:metadata-year-coverage` read the same table with
materially different contracts and are now distinct.

**Unavailable operations are not health capabilities.** The unavailable exits return a synthetic
`SELECT '…' AS answer` (`lib/metadata-coverage.ts:247`); classifying by SQL presence minted
phantom capabilities. Classification is now by **tables actually read**.

## 3. What changed in the instrument

| Weakness in `5348410` | Correction |
|---|---|
| One flat catalog, no contracts | Split: `operation-cases.json` (branch → family, terminalKind, capability) and `capability-registry.json` (artifact, handlePath, prep/emitted dependencies, exact required columns, coverage, integrity, availability, provisional receipt identity) |
| Bare SQL strings in one global array | `{dbPath, sql}` per prepare, scoped per case, attributed by artifact path |
| Route imports recorded | All lib **and route** modules imported with recording off; initialization clean by construction (`national_clearance_rate`, `nibrs_state_coverage`, `summary_state_monthly` seeded) |
| Missing case → NOTE | Denominator equality: missing **or extra** fails |
| No family enumeration | Re-derived from source each run; seal sites pinned at 12; literal, ternary and template guardrails resolved; compared to a pinned set of 26 |
| Guardrail match = pass | Factual exits require non-null SQL, expected tables, **and SQL that executes** |
| Column check `length > 0` | Exact set comparison, with four sensitivity probes |
| Hate Crime absent state only | **Both** states exercised; present-crosswalk contract registered |
| Error trap recorded and swallowed | Prints and exits non-zero — it had turned a fatal error into a silent exit 0 |

### Sensitivity probes

Probes drive the **extractor and real SQL**, not the equality helper:

1. Removing `cleared_E` from the schema input changes the observed contract **and** the real SQL
   stops executing against a fixture built without the column.
2. Every declared required column across every factual case is removed in turn; each removal must
   change the observed contract (>200 removals exercised).
3. Adding a column no operation reads changes neither the contract nor capability identity.
4. Identical table sets with different required columns produce distinct capabilities, with a
   pinned SHR example.

**Proven to bite, not asserted:** mutating `columnsFor` to ignore the schema it is handed
produced 5 failures including both column probes. All probe failures occur before any summary
line and exit non-zero.

## 4. Preserved findings

- **Preparation-time dependencies** — five capabilities read tables absent from their SQL;
  `historical:agency_scorecard` reads live RTCI `agencies` and `agency_monthly`.
- **County/state parser defect** — `"Dallas County, Texas"` is rejected while
  `"Dallas County in Texas"` resolves the county to **Alabama** and filters on Texas. Coverage
  taken only with the internally consistent `Maricopa County in Arizona`. **Not fixed in 2A**; a
  reproducer is specified in the plan.
- **Hate Crime county is conditionally unavailable**, not unhealthy — the crosswalk is absent in
  production, so the builder takes the SQL-less exit and seals nothing.

## 5. Fixture defects found in my own harness

Recorded because each could have been misread as a product finding: `executes()` ignored the
override path; four fixture cities shared one `county_key`, making `countyStates()` ambiguous;
and `sed 's/$/;/'` corrupted an appended DDL block. All fixed.

## 6. Plan

`docs/superpowers/plans/2026-08-13-stage2-source-health-registry.md` is rewritten, not
banner-ed. The superseded inventory listing, family map, correction banners, `stage2aReachable`
skip machinery and contradictory completion criteria are **removed**. Task 1 now generates the
inventory from the two catalogs and asserts inventory/registry equality; Task 11 adds the
digest-time sweep that evaluates `current.national`.

## 7. Status

Blocked pending independent review. No Stage 2A product code, no proof-mode change, no
migration, no production change.
