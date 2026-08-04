# Spec: inflated rate denominators (population fan-out)

**Date:** 2026-08-04
**Status:** Spec for Codex. Not implemented, not deployed.
**Priority:** Highest open correctness item — silently wrong rates shown to users.

---

## 1. The defect

`agency_population` has **one row per (ori, year)**. `agency_monthly` has **one row
per (ori, year, month, offense)** — measured avg 6.9, max 7 rows per ori-month.
Joining them fans the population row out across every matching crime row, so
`SUM(<alias>.population)` counts each agency's population once per crime row
instead of once per agency.

Inflation factor = `(months in scope) × (offenses in scope)`, i.e.
`12 × N` for an annual query, `N` for a monthly query, `1` only when the query
groups at (year, month) with a single offense.

### Proven arithmetically

National murder rate, 2024, `GROUP BY year`, single offense
(`SUM(am.count)*100000.0/SUM(ap.population)`):

| | |
|---|---|
| Denominator as computed | **1,385,992,716** (1.39 billion — 4× the US population) |
| Correct denominator | 115,499,393 |
| Rate reported | **0.63 per 100k** |
| Rate correct | **7.54 per 100k** |

Second case — King County WA, 2024, four offenses (`GROUP BY am.year`):
computed population **40,454,592** vs correct **842,804** = **48×**, so the
violent crime rate read ~13.5 per 100k instead of ~648.

### Production impact (audited, not estimated)

Precise-shape scan — literal `SUM(<alias>.population)` over an `agency_monthly`
join with no `DISTINCT` — returned 22 queries, 2026-04-13 → 2026-07-31. Each was
classified by GROUP BY grain and offense cardinality:

| Verdict | Count | Log ids |
|---|---|---|
| **INFLATED ×48** | 2 | 5536, 5524 |
| **INFLATED ×12** | 6 | 7518, 7463, 2849, 2822, 2031, 1413 |
| **INFLATED ×4** | 1 | 1939 |
| No GROUP BY — inspect | 1 | 2305 |
| Correct (monthly grain, single offense) | 12 | 3736, 3234, 3133, 2872, 2591, 2535, 2534, 2533, 1937, 1936, 1935, 1934 |

**10 of 22 produced wrong rates.** Zero carried any rate or population guardrail.

### Scope is bounded

The fan-out requires a per-entity numeric column summed across the monthly join.
Only `agency_population` qualifies. `agencies` (132 log hits alongside
`agency_monthly`) is `ori PRIMARY KEY` with only `total_months` and
`national_sample` as numerics — nothing summable as a denominator, so those joins
are filtering and correct. `national_clearance_rate`,
`historical_agency_population`, and `historical_staffing` never appear in this
shape (0 hits each). `national_monthly` has no `ori` and cannot fan out this way.

**Do not widen the fix beyond `agency_population` × `agency_monthly`.**

---

## 2. Required change — two layers

### Layer 1: structural guardrail `rate-population-fanout`

New guardrail in `lib/guardrails.ts`, tab `current`. Fire when **all** hold:

1. SQL references `agency_monthly`.
2. SQL sums the population column of a joined `agency_population` — match
   `SUM(<alias>.population)` / `SUM(population)`, not merely the substring
   `SUM(` … `population` (that also matches the *correct*
   `SUM(count)*100000.0/MAX(ap.population)` idiom — my first scan over-counted
   250 queries because of exactly this mistake; the tight pattern yields 22).
3. The computed inflation factor exceeds 1, where
   `factor = (GROUP BY includes month ? 1 : 12) × max(offense count in filter, 1)`.
   Offense count comes from the `offense IN (...)` list or `offense = '...'`.

Must **not** fire on any of these correct idioms:
- Dedupe-by-agency-first, i.e. summing over `SELECT DISTINCT ori, population`
  (this is what `7bb55bb` does in `app/api/query/route.ts`).
- `MAX(CASE WHEN … THEN ap.population END)` per the multi-city rate pattern
  already documented in `lib/claude.ts`.
- Monthly grain with a single offense (the 12 correct ids above).

Retry message must name the correct idiom explicitly — deduplicate population to
one row per agency before summing, e.g. aggregate `agency_monthly` to one row per
(ori, year) in a CTE first, then join population; or sum over
`SELECT DISTINCT ori, population`. Do not tell the model merely "the population
is wrong."

This is a **retry**, not a block, consistent with the other contract/guardrail
rate rules.

### Layer 2: numeric plausibility backstop

Pattern matching cannot cover SQL shapes nobody has written yet, and this class
is invisible in the narrative — the 1.39-billion denominator never reached the
user, only the 0.63 rate did. Add a result-level check:

- When a Current Trends result exposes a population denominator (chartMeta
  population, or a population/`total_pop` column in the rows), flag when it
  exceeds a sane ceiling for the RTCI sample. The sample's true population is
  ~115.5M; a value above roughly **2× the largest plausible sample** (or simply
  above the US population, ~340M) cannot be correct.
- Tag it (e.g. `implausible-population-denominator`) and surface it in the digest
  as an unresolved reliability signal.
- This is a **backstop**, not the primary fix: it catches novel shapes and
  regressions that Layer 1's pattern misses.

Prefer reusing existing machinery — the `RTCI` facts in `lib/dynamic-facts.ts`
already expose sample population bounds; do not hardcode a magic number without
sourcing it from there.

---

## 3. Tests

Assert returned values; all assertions execute before the file's final log; no
assertion after any exit; nothing that cannot fail.

**Regression corpus from real production SQL** (pull the exact SQL from
`query_log` for each id):

- Must fire: 5536, 5524 (×48), 7518, 7463, 2849, 2822, 2031, 1413 (×12), 1939 (×4).
- Must **not** fire: 3736, 3234, 3133, 2872, 2591, 2535, 2534, 2533, 1937, 1936,
  1935, 1934 (correct monthly single-offense).
- Must **not** fire: the deduped national population query from `7bb55bb`.
- Must **not** fire: a `MAX(CASE WHEN … THEN ap.population END)` multi-city rate.
- 2305 (no GROUP BY) — inspect and add to whichever list it belongs in, with the
  reasoning recorded in a comment.

**Arithmetic test** (the one that actually proves correctness): against a fixture
DB, run a rate query in the buggy shape and in the deduped shape and assert the
deduped denominator equals the sum of one population per distinct ori, and that
the buggy denominator equals that value × the expected factor. A pattern-match
test alone does not prove the factor logic is right.

**Backstop test:** a result carrying a denominator above the ceiling raises
`implausible-population-denominator`; a normal national result does not.

---

## 4. Verification gate

Full `npm test` + `npx tsc --noEmit` (re-run once on the transient `EXIT=127`
npx flake). Then production replay after deploy:

- `annual murder rate nationwide and in Baltimore` (the 1413 shape) — the
  national rate must land in a plausible range (~6–8 per 100k), not ~0.6.
- `calculate the percent change in violent crime rates for King County, WA`
  (the 5523/5524 shape) — denominator must reflect ~0.84M, not ~40M.
- One known-correct monthly single-offense rate query (e.g. the 2533 shape) must
  return unchanged values — this is the critical negative case.
- Confirm via `chartMeta` that national population still reads **122,283,158**
  (the `7bb55bb` value), i.e. this change does not disturb it.

Commit separately from any other work, report the hash, no deployment without
explicit approval.

---

## 5. Open question for the user, not for Codex

Ten historical queries returned materially wrong rates between 2026-04-13 and
2026-07-31. Whether anything should be done about already-delivered answers
(annotation, outreach, or nothing) is a judgment call and is deliberately left
out of this spec.
