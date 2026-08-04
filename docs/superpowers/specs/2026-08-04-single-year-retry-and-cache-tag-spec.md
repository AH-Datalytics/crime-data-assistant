# Spec: single-year recursive-series retry convergence + cache-hit typo tagging

**Date:** 2026-08-04
**Status:** Spec for Codex. Not implemented, not deployed.
**Scope:** Two narrow, independent items. Deliver as two commits.

---

## Item 1 — Single-year recursive-series violation must converge on retry

### Evidence

Production log **7855**, question `murders in new orlens 2020`, `rows=0`,
tags `geo-typo-corrected, historical-missing-gap-fill, contract-single-year-temporal-scope`.
The user received:

> "I couldn't build a reliable query that matched the requested source, geography, metric, and time period. Try narrowing the question or choosing one of the suggested alternatives."

The SQL that triggered it:

```sql
WITH agency AS (SELECT ha.ori FROM historical_agency ha
                WHERE ha.agency = 'New Orleans' AND ha.state = 'la' AND ha.type = 'city' LIMIT 1),
     years  AS (SELECT 2020 AS year UNION ALL SELECT year + 1 FROM years WHERE year < 2020)
SELECT y.year, hac.murder
FROM years y
LEFT JOIN agency a ON 1=1
LEFT JOIN historical_agency_crime hac ON hac.ori = a.ori AND hac.year = y.year
ORDER BY y.year LIMIT 1000
```

The same question succeeded on logs 7817, 7825 (and the 2019 variant on 7856, 7858)
with the simple form `... AND hac.year = 2020`. So this is **model SQL-shape
nondeterminism**, not a deterministic failure.

### Root cause — corrected from the initial reading

`contract-single-year-temporal-scope` is **already a retry**, not a hard block:
`lib/query-contract-validator.ts:432-437` pushes it to `warnings`, `retryIssues`,
and `enforced` — never to `blockReasons`. The refusal text is
`CONTRACT_SECOND_FAILURE_MESSAGE` (`lib/query-contract-validator.ts:17-18`),
emitted only after the **retry also failed**.

So the defect is not the escalation level. It is that the retry **does not
converge**: `singleYearTemporalScopeIssue` (line 177) correctly detects the
violation — the years CTE is a degenerate one-element series
(`SELECT 2020 AS year … WHERE year < 2020`) and no fact-table predicate pins
`hac.year = 2020`, so `hasRequestedSingleYearPredicate` is false — and emits a
`[SYSTEM:]` instruction (line 186) telling the model to use `= year` or
`BETWEEN year AND year`. The model then regenerates another non-conforming
query, plausibly re-reaching for the gap-fill scaffold (note
`historical-missing-gap-fill` also fired), and the second failure refuses.

**Do not broadly downgrade contract failures.** The block/retry classification
is correct. The fix is to make this one narrow case converge deterministically
instead of depending on the model getting it right on attempt two.

### Required change

Add a **narrowly scoped deterministic rewrite** for the degenerate single-year
recursive series, applied before the retry round-trip so convergence does not
depend on model behavior.

Detection must require **all** of:
1. The contract is a single-year point contract (reuse `isSingleYearPointContract`; do not reimplement).
2. The SQL contains a recursive year CTE whose seed and bound are the **same
   year** — i.e. `SELECT <Y> AS year UNION ALL SELECT year + 1 FROM <cte> WHERE year < <Y>`
   with the seed literal equal to the bound literal equal to the contract's
   `startYear`. A series spanning more than one year must **not** match.
3. The requested single-year predicate is absent (the existing
   `hasRequestedSingleYearPredicate` check already fails).

Rewrite: collapse the degenerate series so the fact-table year predicate becomes
`= <Y>`. Preferred shape — drop the `years` CTE and its `LEFT JOIN`, filtering
the fact table directly (`AND hac.year = <Y>`), matching the form the model
produces on its successful runs (7817/7825). If dropping the CTE is not safely
expressible with a textual transform, the acceptable fallback is to keep the CTE
but add the explicit fact-table predicate `AND <alias>.year = <Y>`, which
satisfies the contract and yields identical rows for a one-element series.

Constraints:
- **Preserve the normal retry limit.** This must not add a retry attempt, and
  must not bypass validation — the rewritten SQL is re-validated by the existing
  path like any other rewrite.
- Emit a guardrail tag for observability (e.g. `single-year-series-collapsed`),
  and register it in the digest's reliability categories the same way as other
  non-contract tags.
- If the rewrite cannot be applied confidently, fall through to the existing
  behavior unchanged. A missed rewrite is acceptable; a wrong rewrite is not.
- Do not touch `hasBroadYearPredicateForSingleYear`,
  `hasRequestedSingleYearPredicate`, `isSingleYearPointContract`, or the
  block/retry sets.

### Tests (Item 1)

Assert returned values; all assertions execute before the file's final log; no
assertion after any exit; nothing that cannot fail.

- **Converges:** the exact 7855 SQL + question `murders in new orlens 2020` →
  after the rewrite the contract validates clean (no
  `contract-single-year-temporal-scope` in the final enforced set) and the
  rewritten SQL contains a `year = 2020` fact-table predicate.
- **Rows preserved:** the rewritten SQL returns the same row for 2020 as the
  known-good form from 7817 (`SELECT hac.year, hac.murder … AND hac.year = 2020`).
  Run both against a fixture/in-memory DB and compare.
- **Multi-year series untouched:** a genuine multi-year gap-fill series
  (`SELECT 1980 AS year … WHERE year < 2025`, e.g. the Chicago staffing shape
  from 7783/7823) is **not** rewritten and still validates as it does today.
  This is the critical negative test — the staffing gap-fill pattern is correct
  behavior and must not regress.
- **True violation still caught:** a single-year question whose SQL uses
  `year >= 2015` still raises `contract-single-year-temporal-scope`.
- **Retry budget unchanged:** assert the rewrite path does not increment the
  retry counter.

---

## Item 2 — `geo-typo-corrected` must be recorded on cache hits

### Evidence

| Log | Question | Tag |
|---|---|---|
| 7856 | `murders in new orlens 2019` | **absent** |
| 7858 | `murders in new orlens 2019` (identical) | present |

Identical question, identical SQL, different tagging. Task 22 pushes the tag
only on the non-cached branch (`app/api/query/route.ts` ~line 998, inside the
`else` of the cache check), so a cache hit records nothing. This is a **second,
independent** cause of the tag's absence — distinct from the
`firedGuardrails = guardrailResult.fired` reassignment fixed in `0a88cc5`. I
previously reported the caching explanation as retired; that was wrong, and
7856/7858 are the counter-evidence.

Consequence: the digest under-counts typo corrections by however often responses
are served from cache, so the Reliability Signals table cannot be read as a true
typo rate.

### Required change

Compute the geo-correction hint **once per request, before the cache branch**,
and record `geo-typo-corrected` whenever the hint is non-null — on both the hit
and miss paths. The hint must continue to be injected into model input only on
the miss path (a cache hit makes no model call), so this is an observability
change with **no behavioral change** to SQL or narrative.

Apply to all four routes for consistency, matching each route's existing tag
mechanism. Do not call `geoCorrectionHint` twice; reuse the single computed
value (the `applyGeoCorrection(question, hint)` signature from `58b2578`
already supports passing it in).

### Tests (Item 2)

- Cache-miss path with a typo question records `geo-typo-corrected`.
- Cache-**hit** path with the same question also records `geo-typo-corrected`.
- A correctly spelled question records the tag on **neither** path.
- The cached response's SQL, rows, and narrative are byte-identical before and
  after the change — this is observability only.
- A route-level assertion that the hint is computed before the cache branch, so
  the ordering cannot silently regress (the isolated-unit-test gap is what let
  the `:1145` defect ship).

---

## Verification gate (both items)

Full `npm test` + `npx tsc --noEmit`, re-running once on the transient
`EXIT=127` npx flake. Then production replay after deploy:

- `murders in new orlens 2020` repeated ~5× to exercise SQL-shape
  nondeterminism — every run must return the New Orleans row, never the
  second-failure refusal.
- `police staffing in Chicago since 1980` — must still return the full 46-row
  1980-present series (guards the multi-year gap-fill negative case).
- The cached/uncached diagnostic pair — `geo-typo-corrected` must now appear on
  **both**, so `diag-typo-cached`'s expectation flips and its INFO note should
  be updated in `scripts/replay-production-queries.js`.

Commit separately, report hashes, no deployment without explicit approval.
