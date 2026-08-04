# Handoff for Codex review — 2026-08-04

**Production:** release `20260804_204514` (nibrsai.com, VPS `/opt/nibrs/current`)
**dev HEAD:** `64d3894` — one commit ahead of production, operational-only (replay harness), inert in the release tree
**Verification standard used all session:** every claim measured against production data or the real code path, not inferred. Where I asserted something without measuring it, I was wrong at least four times — see §5.

**Related documents**

| Document | Status |
|---|---|
| [`plans/2026-08-03-followup-policy-and-response-firewall.md`](plans/2026-08-03-followup-policy-and-response-firewall.md) | **Canonical record for Tasks 1–22** — the reliability backlog shipped 08-03/08-04, including the 7674 instruction-boundary leak, Suffolk clarifier, hate-crime partial-year work, and Tasks 16–22 (completeness, grain, metadata routing, schema validation, missing-year disclosure, typo tolerance, monitoring). Read this for anything predating today's fixes. |
| [`specs/2026-08-04-single-year-retry-and-cache-tag-spec.md`](specs/2026-08-04-single-year-retry-and-cache-tag-spec.md) | Open — not implemented |
| [`specs/2026-08-04-rate-denominator-fanout-spec.md`](specs/2026-08-04-rate-denominator-fanout-spec.md) | Implemented (`7ddbfb2`, `2fc5d58`) |
| [`specs/2026-08-04-structured-response-assembly-design.md`](specs/2026-08-04-structured-response-assembly-design.md) | Cancelled — retained as history; §1a records why |

---

## 1. Shipped today (all deployed and production-verified)

| Commit | Fix | Evidence it worked |
|---|---|---|
| `b558d3e` | `resolvedPlaces` on `extractQueryContext`; explain path unions it into `validateExplanationEntities` | 7772 narrative went from "carjacking counts for **cities in the dataset City**" → "Carjacking incidents in **Baltimore City**" |
| `3d8668a` | Pivot carries `{key, canonicalLabel}` into `applyResultDisclosures` | 7780: `Asianpacific Islander` → `Asian/Pacific Islander` (log 7822, comparison line confirmed present, not vacuous) |
| `0a88cc5` | `lib/guardrail-tag-state.ts`: three-state contract tags (`-resolved-on-retry`), non-contract tags preserved | 7783 no unsuffixed lower-bound tag; `geo-typo-corrected` now reaches the log |
| `9e9f9e0` | Route-contract guard on tag accumulation | Verified it **fails** when `:1145` is reverted |
| `076fb71` | Monthly-aggregating CTE before rolling window; prompt example; `rolling-multi-offense-not-aggregated`; latest-period chart metadata | log 7873/7890: **101 rows** with `GROUP BY year, month` (was 404 = 101 months × 4 offenses) |
| `7bb55bb` | National population = latest-month reporters, deduped by ORI | `chartMeta {agencyCount: 586, population: 122283158}` — confirmed live |
| `7ddbfb2` | `rate-population-fanout` guardrail | Fired live on log 7891; retry produced deduped SQL |
| `2fc5d58` | `implausible-population-denominator` backstop (2× sample ceiling) | Unit-tested; no live trip |
| `ea8accb` | Removed question-wording gate from the rolling guardrail | 4 of 58 candidate queries fire — exactly the 4 broken ones, 0 false positives |

**The headline numbers.** The rate fan-out understated rates by (months × offenses). National annual murder rate read **0.63 per 100k** against a correct **7.9**; a King County query computed a denominator of **40,454,592** against a correct **842,804** (48×). Post-fix production values: national 7.9→10.3, Baltimore 50.7→58.6.

**Audit of historical impact:** of 22 queries matching the precise fan-out shape (2026-04-13 → 07-31), **10 produced wrong rates** — ×48 (5536, 5524), ×12 (7518, 7463, 2849, 2822, 2031, 1413), ×4 (1939); 12 were correct. Zero carried any guardrail tag. The rolling bug had **4 instances** (7845, 7844, 2305, 1229) spanning 2026-04-10 → 08-04.

---

## 2. Open items, in the priority I'd take them

1. **SHR police-shootings qualifier drop — highest severity, spec not yet written.** See §3.
2. **Single-year recursive-series refusal.** Spec written: `docs/superpowers/specs/2026-08-04-single-year-retry-and-cache-tag-spec.md` §Item 1. Reproduced twice (7855, 7900) — recurrent, not rare. User gets `CONTRACT_SECOND_FAILURE_MESSAGE` for a trivially answerable question.
3. **Cache-hit `geo-typo-corrected`.** Same spec, Item 2. Evidence: log 7856 (no tag) vs 7858 (tag), identical question.
4. **`agency_monthly` rolling gap.** `rolling-multi-offense-not-aggregated` matches only `national_monthly`; `agency_monthly` is structurally identical (avg 6.9 rows/ori-month, max 7). Never hit in production, but reachable.
5. **The rolling guard's GROUP BY check is text-proximity, not structural.** `/\bGROUP\s+BY\b[\s\S]*?\byear\b[\s,]*\bmonth\b/` lets a lazy match reach any later "year, month", so a buggy query containing an unrelated `GROUP BY` evades it (proven).
6. **Hygiene A:** move `writeLog`/`writeNibrsLog`/`logQuery` after wrapper sanitization — NIBRS/SHR/HC currently log pre-sanitization text, so `query_log.response` can differ from what the user saw.
7. **Hygiene B:** route `hc-query:118` through `jsonResp`; document captcha/OPTIONS/middleware as protocol-only exits.
8. **`chart_config` column + chart invariants.** `query_log` stores no chart data, so charts cannot be audited at all today. One additive JSON column (`ALTER TABLE query_log ADD COLUMN chart_config TEXT`), queryable via `json_extract`. Unlocks: title year-range vs actual data range (the hate-crime stale-title bug), `yAxis` keys ⊆ result columns, unit/label mismatch, series overflow.
9. **Automated auditing tiers.** Tier 1 SQL-shape lint over full history (7,881 rows, milliseconds, retroactive); Tier 2 value-level invariants by re-executing stored SQL; Tier 3 golden canaries. Full rationale in §4.

**Time-based, not queue-based:** the digest fires at **13:00 UTC daily**. Tomorrow's is the first covering these fixes.

---

## 3. SHR police-shootings — full diagnosis, spec pending

**Log 7881**, question *"What is the trend of police fatal shootings over the last…"*, tag `deterministic-shooting`:

```sql
WHERE i.homicide_type = 'Murder' AND i.weapon_group = 'Firearm' AND i.year >= 2000
```

The "police" qualifier is **absent from the SQL and from the narrative**, which reads "Fatal shootings (firearm homicides) by year since 2000."

| 2023 | |
|---|---|
| Delivered (all firearm murders) | **14,777** |
| Correct answer (`circumstance = 'Felon Killed by Police'`) | **349** |

**42× overstatement.** It is fully answerable: `circumstance = 'Felon Killed by Police'` has 18,697 records, all with `homicide_type='Murder'`, so one added predicate fixes it.

**Root cause is deterministic, not model drift.** `lib/shr-deterministic-shooting.ts` pattern-matches "fatal shootings"; its `shootingYearIntent` parses **only years** and has no concept of qualifiers. So this is 100% reproducible, bypasses the model entirely, and no prompt change can fix it. Log scan: 2 instances (7881, and 7639 which returned 0 rows).

**Required fix, three parts:**
1. The deterministic matcher must **decline to fire** when the question carries a qualifier it does not implement, falling through to the model path rather than answering a different question.
2. Add police-shooting support via the `circumstance` predicate.
3. Disclose that SHR substantially undercounts officer-involved killings relative to Washington Post / Mapping Police Violence tallies — 349 for 2023 is itself well below the true figure.

**Generalization worth building:** a qualifier-drop detector. Precedent already exists at `lib/guardrails.ts:1536` — *"Do not silently drop the weapon filter"* for weapon-qualified person crimes. This is that idea generalized: if a salient qualifier appears in the question, it must appear as a SQL predicate **or** be explicitly disclaimed in the narrative.

---

## 4. Why automated auditing, and what shape

Both of today's wrong-number classes produced **zero guardrail tags** — 0 of 22 rate queries, 0 of 4 rolling queries. The digest counts tags, so it was structurally blind to both. It answers *"did a guardrail fire?"*; these bugs needed *"is this answer plausible?"*

- **Tier 1 — SQL-shape lint over all history.** A detector registry (pattern + counter-pattern for the correct idiom) run nightly over all 7,881 rows, not just yesterday, so adding a detector retroactively surfaces every past instance. This is literally what I did by hand four times today. The principle: **each incident becomes a permanent detector.**
- **Tier 2 — value-level invariants by re-executing stored SQL.** Possible only because `sql` is stored (`rows` is a count; row values are not). No model calls. Would have caught the 1.39-billion denominator, the 404-vs-101 row count, and the 0.63 rate. Bound by wall-clock; skip or sample NIBRS (avg 9s, some >100s).
- **Tier 3 — golden canaries with numeric assertions.** The replay harness already solves the hard parts (real `/test` flow, row attribution by question text, clarifier handling).
- **Semantic alignment judge (for the §3 class).** Feed question + narrative to Haiku nightly: *"does this answer the question as asked; is any qualifier unaddressed?"* At ~130 queries/day this costs pennies and needs no lexicon. It is the only mechanism that generalizes to classes nobody anticipated.

**Invariant design caveat (learned the hard way, §5):** for Current Trends, do **not** band rates against published national figures. The RTCI sample is 586 agencies / ~119M people, 497 of them cities, and runs ~1.5× the US rate (sample 10.3 in 2021 vs US ~6.8). Compare a metric against **its own history** instead — 9.9 → 0.63 is an anomaly regardless of the correct absolute value.

---

## 5. Traps — things that are counterintuitive or that I got wrong

Codex should treat these as settled and not re-derive them:

1. **7783 is NOT a validator false positive.** Measured via `runGuardrails(extractQueryContext(...))`: the final recursive-CTE SQL does **not** fire `contract-year-lower-bound-missing`; a no-lower-bound SQL does. `recursiveYearSeedRe` (`lib/guardrails.ts:547`) already handles `SELECT 1980 AS year`. Do **not** modify year-bound detection. The tag was inherited from a superseded attempt.
2. **The internal-leak firewall is already centralized.** `sseEvent` (`app/api/query/route.ts:55-66`) and `jsonResp` (each route, ~48-76) already call `sanitizeUserFacingNarrative` on every payload. My "14 of 102 exits" claim was wrong — 14 counted import lines, and the real coverage is near-universal. This is why the structured-assembly redesign was cancelled; `/query` is also deliberately two-phase SSE (`type:"result"` at 1792, then `type:"explanation"` at 1846/1893), so a single terminal render point cannot be byte-identical. Design retained as history at `docs/superpowers/specs/2026-08-04-structured-response-assembly-design.md` (§1a records the correction).
3. **Over-broad SQL patterns wildly over-count.** `sql LIKE '%SUM(%population%'` matched 250 queries because it also matches the *correct* `SUM(count)*100000.0/MAX(ap.population)`. The tight pattern `SUM(<alias>.population)` yields 22. Always validate a detector against the real corpus before trusting its count.
4. **There are three correct population idioms**, not two: dedupe-first (`SELECT DISTINCT ori, population`), `MAX(CASE WHEN … THEN ap.population END)`, and **structural separation** (population aggregated in its own CTE, or joined to `agencies` which is one row per ORI). My first replay assertion failed a correct query (log 7892) by ignoring the third.
5. **Never gate a guardrail on question wording.** Follow-ups drop the original keyword. The word-gated rolling guard caught only **2 of 4** real instances; 2305 ("yes show me how you Baltimore's rate alongside the national rate") and 7844 ("now violent crime") both lacked "rolling".
6. **A tag test must cross the reassignment point.** `app/api/query/route.ts:1145` reassigned `firedGuardrails` wholesale, discarding `geo-typo-corrected` pushed at line 998 — so that tag never reached the log on the two busiest tabs. It shipped past review because the test exercised `geoCorrectionHint` in isolation. Unit tests on a helper do not prove route-level accumulation.
7. **A guard test is not trustworthy until you have watched it fail.** Both the `:1145` guard and the 2305 regression case were verified by deliberately reintroducing the defect and confirming a failure.
8. **The replay harness must match on question text.** Production serves live traffic; matching only `id > sinceId` + tab read a stranger's row (log 7816, "Kentucky agencies by population and type in 2024") and produced a fabricated bug report. A false PASS is equally possible.
9. **An ambiguous place replaces the Ask button with a clarifier** ("Baltimore city" / "Baltimore County" / "Clarify first") and the clarifier **rewrites the logged question**. This is correct product behavior, not a UI failure.
10. **RTCI sample rates are not national rates** (~1.5×). I incorrectly described 7.9→10.3 as matching known US murder rates; the US figures are ~5.3 and ~6.8. The app's own disclaimer is more careful than my summary was.

---

## 6. What I'd like Codex to check in this handoff

1. Do the §1 evidence claims reproduce — particularly `rate-population-fanout` firing on log 7891 and the 101-row rolling result?
2. Is the §2 priority order right, or does something outrank the SHR qualifier drop?
3. For §3, is declining-to-fire the right first move, or should the matcher gain qualifier support in the same change?
4. In §4, is re-executing stored SQL safe on NIBRS at any scale, or should Tier 2 exclude it entirely?
5. Anything in §5 that Codex believes is wrong — with file:line or a measurement, not inference.

Report findings ranked by severity. Do not implement anything from this document without explicit approval.
