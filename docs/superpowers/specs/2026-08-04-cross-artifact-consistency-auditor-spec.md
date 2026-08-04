# Spec: cross-artifact consistency auditor

**Date:** 2026-08-04
**Status:** Spec for review. Not implemented.
**Sink:** existing `audit_findings` table (677 rows; unique index on `(query_log_id, category)` already makes writes idempotent — no new table needed)

---

## 1. The frame

Every wrong-answer incident found today was a **mismatch between four artifacts**:

| Artifact | Meaning | Stored in `query_log`? |
|---|---|---|
| **question** | what the user asked | yes |
| **SQL** | what was actually computed | yes |
| **chart** | what was drawn | **no** |
| **narrative** | what the answer claimed | yes (`response`) |

| Incident | Mismatch |
|---|---|
| 7881 police shootings (42×) | question says police; SQL and narrative do not |
| 7772/7773 "cities in the dataset City" | SQL targets one ORI; narrative names a generic placeholder |
| 7780 "Asianpacific Islander" | data value vs narrative label |
| 7845 rolling window (404 rows) | narrative claims "12-month rolling"; SQL rolls ~3 months |
| Hate-crime stale title | data range vs chart title |
| 7855 / 7900 refusal | user gets "I couldn't build a reliable query" for an answerable question |
| 1413 / 5524 rate fan-out | narrative claims a rate; denominator is inflated 12–48× |

**None of these produced a guardrail tag.** The digest counts tags, so it was blind to all of them. It answers *"did a guardrail fire?"*; these needed *"do the artifacts agree?"*

That framing is the point: consistency checks catch classes **without anticipating the mechanism**. We found each of the above by hand. Codifying the comparison means each incident becomes a permanent detector.

**Coverage today:**

| Pair | Auditable now |
|---|---|
| question ↔ SQL | **yes** |
| question ↔ narrative | **yes** |
| SQL ↔ narrative | **yes** |
| data values ↔ narrative | needs SQL re-execution (Phase 4) |
| chart ↔ data / narrative | **blocked** — no `chart_config` column (Phase 3) |

---

## 2. Phase 1 — deterministic cross-artifact detectors

No schema change. Runs over all ~7,900 logged rows in milliseconds, so **adding a detector retroactively surfaces every past instance**. Each detector below is anchored to a real incident and must be validated against the §5 corpus before its count is trusted.

**D1 — qualifier drop** *(7881)*
A salient qualifier appears in the question but in neither the SQL nor the narrative. Lexicon: police/officer-involved, domestic/intimate-partner, gang, juvenile, stranger, self-defense, mass, drug, attempted, cleared, arrest-vs-offense, rate-vs-count, statewide-vs-city. Precedent already in the codebase: `lib/guardrails.ts:1536` — *"Do not silently drop the weapon filter."*

**D2 — place mismatch** *(7772/7773)*
Narrative contains a generic placeholder ("cities in the dataset", "the dataset", "that city") while the SQL filters a specific ORI/agency; or the narrative names a place absent from both question and SQL.

**D3 — claimed grain vs SQL structure** *(7845)*
Narrative claims "rolling", "12-month", "monthly", or "per month" but the SQL lacks the corresponding structure (`ROWS BETWEEN`, monthly `GROUP BY`). Also flag the inverse: monthly SQL described as annual.

**D4 — claimed year range vs SQL predicates**
Years named in the narrative fall outside what the SQL's year predicates can return.

**D5 — claimed metric vs SQL aggregate**
Narrative says "rate"/"per 100k"/"per capita" but the SQL has no population denominator; or says "share"/"percent" with no ratio.

**D6 — malformed label token** *(7780)*
Narrative contains a token that is a mangled form of a known canonical value — e.g. matches a source value after stripping non-alphanumerics but not exactly (`Asianpacific Islander` vs `Asian/Pacific Islander`). Build the canonical list from the source columns, not hardcoded.

**D7 — refusal on answerable data** *(7855/7900)*
`CONTRACT_SECOND_FAILURE_MESSAGE` or a no-SQL refusal emitted where the contract shows a resolved geography, metric, and period — i.e. the request was expressible and the pipeline failed anyway. `query_contract` is stored, so this is checkable.

**D8 — unresolved contract tag on a delivered answer**
An unsuffixed `contract-*` tag on a row that returned data, meaning the delivered result still violates its contract. Depends on the three-state semantics from `0a88cc5`.

---

## 3. Phase 2 — LLM alignment judge

Deterministic detectors only catch what someone anticipated. This is the layer with real reach, and it is what the user described: compare the question text to the answer text.

- **Input:** question + narrative (+ a compact SQL summary: tables, filters, aggregate, grain).
- **Prompt:** does the answer address the question as asked? List any qualifier, geography, metric, or period in the question that the answer does not reflect. Reply structured.
- **Model:** Haiku 4.5, matching the app.
- **Volume:** ~30–170 queries/day; run over the previous day plus a rolling sample of history. Cost is negligible at this volume.
- **Output:** `audit_findings` with category `alignment-*`, severity from the judge's confidence.

**Guardrails on the judge itself:**
- It is **advisory** — never blocks a response and never gates a deploy. It is nondeterministic and will produce false positives.
- Report the judge's disagreement rate alongside its findings. A judge that flags 40% of queries is miscalibrated and should be tuned before anyone acts on it.
- Cross-check: any query flagged by both a deterministic detector and the judge is high-confidence; judge-only findings are triage candidates, not defects.
- Never feed it the internal SQL verbatim in a way that could echo into user-facing output — this runs offline against the log, so it never touches a response path.

---

## 4. Phase 3 — charts (requires a schema change)

**Prerequisite:** `ALTER TABLE query_log ADD COLUMN chart_config TEXT;` — additive, nullable, no table rewrite. Populate from the existing payload (`{type, xAxis, yAxis, title, yAxisLabel, xAxisLabel}` — already assembled at response time). Add an **optional trailing parameter** to the four log helpers so the ~110 existing call sites are untouched and non-chart paths log `NULL`. Query with `json_extract(chart_config,'$.title')`; do not add one column per field.

Detectors once available:

| Check | Catches |
|---|---|
| Chart title year range == data range | the hate-crime stale-title bug, which passed the whole suite and was caught only in a browser |
| Every `yAxis` key exists in the result columns | silently missing series — a live risk from the Fix 2 pivot, where `yAxis` is derived from `rows[0]` alone |
| Axis label unit vs metric | "per 100k" on a count chart |
| Chart type vs data shape | line chart on a ranking, pie on a time series |
| Series count ≤ 15 | unreadable overflow |
| Y-axis starts at 0 | standing charting preference |

Rendered-structure canaries (asserting on the SVG: series marks, tick labels, legend entries) are a **later** phase. A probe confirmed series marks are readable via `.recharts-line-curve`, but tick and legend selectors need work; `scripts/test-chart-panel-ticks.ts` has prior art.

---

## 5. Phase 4 — value-level invariants by re-execution

`query_log` stores `sql` but only a row **count**, not values. So value checks require re-running the stored SQL — readonly, no model calls, and it works retroactively.

- Population denominator ≤ a **dynamically sourced** ceiling (`RTCI` facts), not a hardcoded number.
- Row count vs implied grain — would have caught 404 rows where 101 were expected.
- Rolling 12-month value ≥ any single month in the window.
- Cross-source agreement within tolerance — the single highest-leverage check, because it finds wrong numbers without knowing the mechanism.
- **Metric vs its own history**, not against published national figures. The RTCI sample is 586 agencies / ~119M people, 497 of them cities, and runs ~1.5× the US rate (sample 10.3 in 2021 vs US ~6.8). A murder rate moving 9.9 → 0.63 is an anomaly regardless of the correct absolute value. Banding against national figures would be wrong.

Bound by wall-clock. **Skip or sample NIBRS** — avg 9s, some queries exceed 100s, and the database is 118GB.

---

## 6. Regression corpus — validate every detector against this

**Must flag:** 7881 (D1), 7772/7773 (D2), 7845 + 2305 (D3), 7780 (D6), 7855/7900 (D7), 1413 + 5524 + 7518 + 7463 + 2849 + 2822 + 2031 + 1939 (rate fan-out, D5-adjacent).

**Must NOT flag:** the 12 verified-correct rate queries (3736, 3234, 3133, 2872, 2591, 2535, 2534, 2533, 1937, 1936, 1935, 1934), plus current controls (7920 plain shootings, 7915 Chicago violent crime).

**Non-negotiable, learned today:** validate each detector's pattern against this corpus before trusting its count. A loose pattern (`sql LIKE '%SUM(%population%'`) reported **250** affected queries; the tight one reported **22**, of which 10 were real. Report both flagged and unflagged counts for every detector so over-breadth is visible immediately.

---

## 7. What this does not do

- It does not prove correctness. A rate off by 15% passes every check here.
- Phase 4 re-runs stored SQL, so it cannot reproduce model nondeterminism — the mechanism behind 7855/7900 (same question, different SQL shape per run). Only live canaries touch that.
- The judge will be wrong sometimes. It is a triage input, not a verdict.

## 8. Hard constraints on the whole auditor

These apply to every phase and are not negotiable without an explicit decision.

**8.1 Nothing here gates anything, initially.** Neither the deterministic detectors nor the judge may block a user response, fail a build, or gate a deployment. The auditor is an observation system. It runs offline against `query_log` and writes to `audit_findings`. Promoting any detector to a blocking guardrail is a separate, deliberate decision made only after its precision is measured on real traffic — and a guardrail belongs in `lib/guardrails.ts`, not here.

**8.2 The digest must preserve calibration data, not just findings.** For each detector, every run records and reports:

| Field | Why |
|---|---|
| flagged count | the signal |
| **unflagged count** (rows examined but clean) | makes over-breadth visible immediately — a detector flagging 40% of traffic is miscalibrated, and that is invisible from the flagged count alone |
| confirmed-true / confirmed-false after review | the running **false-positive rate** per detector |
| `detector-confirmed` vs `judge-only` | a finding raised by both a deterministic detector and the judge is high-confidence; judge-only findings are triage candidates and must be counted and displayed separately, never merged into the deterministic totals |

A detector whose false-positive rate is not yet measured must be reported as **uncalibrated** rather than presented alongside calibrated ones. My own loose pattern reported 250 affected queries where the truth was 22, of which 10 were real — that failure mode must be visible in the digest, not discovered by hand later.

**8.3 Phase 4 is historical-state validation, and must be labeled as such.** Re-executing stored SQL evaluates *today's data* against *yesterday's query*. Databases change — RTCI imports monthly, NIBRS and SHR are rebuilt — so a re-execution result is **not** proof of what the user saw at the time. Findings from Phase 4 must be labeled `historical-state` in `audit_findings` so nobody reads them as reproductions of the original response. Execution must be strictly **read-only and sandboxed**: readonly DB handles, a hard per-query timeout, a total wall-clock budget, and no writes to any source database. NIBRS is skipped or sampled (118GB; avg 9s, some queries exceed 100s).

---

## 9. Sequencing (agreed 2026-08-04)

1. **Phase 1 — deterministic detectors D1–D8**, calibrated against the §6 corpus: **15 must-flag, 14 must-not-flag**. Report per-detector precision before anything else is built on top.
2. **Phase 3 — chart artifact capture**: the additive `chart_config` column and its migration, in **its own commit**, separate from any detector work. Chart detectors follow once the column has data.
3. **Phase 2 — advisory LLM judge**, only after deterministic precision has been measured, so its findings can be compared against a known baseline rather than a vacuum.
4. **Phase 4 — SQL re-execution**, sandboxed and read-only, findings labeled `historical-state`.

Each phase ships separately with its own review and its own corpus run. No deployment without explicit approval.
