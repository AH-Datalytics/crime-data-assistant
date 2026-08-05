# Phase 2 handoff — advisory alignment judge

**Date:** 2026-08-04
**Status:** Handoff for Codex. Not implemented.
**Prerequisite:** Phase 1 complete — 8 detectors, 35/35 corpus rows clean, zero misses/misattributions/false positives.

---

## 1. Boundaries (non-negotiable)

| Boundary | Rule |
|---|---|
| **Advisory only** | The judge never alters a response, never blocks a query, never fails a test, never gates a build or deployment. It writes findings and nothing else. |
| **Offline execution** | Runs after the nightly log scan, against `query_log`. It sits on no request path and can never add latency to a user query. |
| **Input is sanitized narrative + compact SQL summary** | Question, stored narrative/title, result column names with a few redacted sample values, and a **derived SQL summary** — tables, filters, metric, geography, time grain. **Never raw SQL.** |
| **Corpus rates only** | Report agreement/disagreement against the 35-row corpus. **Do not report a production false-negative rate** — see §4. |
| **Known blind spots stated up front** | Chart-title defects and numeric-computation defects are outside its reach — see §3. |

Promoting any judge finding into a blocking guardrail is a separate, explicit decision made only after precision is measured, and a guardrail belongs in `lib/guardrails.ts`, not here.

---

## 2. Model and API

> **Re-verify before implementing.** Model IDs, pricing, and per-model API behavior below were checked on 2026-08-04. Confirm them against the current reference at implementation time rather than trusting this table — the four behaviors in this section are exactly the kind that shift between model releases.

**Use `claude-opus-5`.** The app answers queries with Haiku 4.5; using a *stronger, different* model as the judge is the point — a judge that shares the answerer's blind spots inherits them. At this volume the cost difference is noise:

| Model | Input $/MTok | Output $/MTok | ~50 judgments/day |
|---|---|---|---|
| `claude-opus-5` | $5.00 | $25.00 | **~$0.45/day (~$14/mo)** |
| `claude-sonnet-5` | $3.00 | $15.00 | ~$0.27/day |
| `claude-haiku-4-5` | $1.00 | $5.00 | ~$0.09/day |

Fourteen dollars a month to reduce false positives in a queue a human reads is the right trade. Do not downgrade for cost without asking.

**Strict JSON via `output_config.format`** — not the deprecated top-level `output_format`:

```python
response = client.messages.create(
    model="claude-opus-5",
    max_tokens=4096,
    output_config={
        "effort": "medium",
        "format": {"type": "json_schema", "schema": ALIGNMENT_SCHEMA},
    },
    messages=[{"role": "user", "content": judge_input}],
)
```

`ALIGNMENT_SCHEMA` must set `additionalProperties: false` and list every field in `required`. Numeric/string constraints (`minimum`, `maxLength`) are not supported — validate those client-side. Structured outputs are compatible with thinking. Prefer `client.messages.parse()` with a schema object if you want automatic validation.

**Four model-specific behaviors that will bite if ignored:**

1. **Thinking is ON by default on `claude-opus-5`.** Omitting `thinking` runs adaptive thinking, and **`max_tokens` caps thinking *plus* output together** — size it generously (4096+) or judgments truncate mid-JSON. This differs from Opus 4.8, where omitting it meant no thinking.
2. **`thinking: {type: "disabled"}` is rejected above `high` effort** (400). If you disable thinking, keep effort at `high` or below. Better: leave thinking on and use `effort: "medium"` — low/medium are unusually strong on this model and are the real cost lever.
3. **Check `stop_reason` before parsing.** Safety classifiers can return `stop_reason: "refusal"` with a 200 and a schema-violating body. Our content is violence-adjacent (homicide, shootings, weapons), so treat this as a live path: on refusal, record the judgment as `skipped` with the reason — **never** let a refusal surface as an alignment finding, and never retry it into a loop.
4. **Optionally add `fallbacks: "default"`** with beta header `server-side-fallback-2026-07-01` so a refused judgment retries server-side instead of being lost. Optional here because a skipped judgment is harmless — this is an observability tool.

Do not set `temperature`, `top_p`, or `top_k` — all three are **rejected with a 400** on `claude-opus-5`. Steer with the prompt.

---

## 3. Reach — state this plainly, do not oversell

The judge sees question + narrative. It can therefore catch **claim mismatches** and cannot catch **computation errors**. Measured against the 19 known corpus defects:

| Likely caught (~5 of 19) | Why |
|---|---|
| 7881 police-shooting qualifier drop | question says "police", answer never does |
| 7772 / 7773 / 3133 place garbling | "cities in the dataset City" is visibly wrong prose |
| 7780 malformed label | "Asianpacific Islander" is visibly malformed |

| Will **not** reliably catch (~14 of 19) | Why |
|---|---|
| 7845 / 2305 rolling-window fan-out | "12-month rolling totals of murder, rape, robbery" reads perfectly correct |
| The 8 rate-denominator rows | "annual murder rates nationwide" reads perfectly correct — the *number* is 12–48× wrong |
| 4570 year-range overstatement | requires comparing the claim to SQL bounds |
| 7770 unresolved contract tag | not visible in prose at all |

**The judge is not watching the arithmetic.** Wrong numbers with correct-sounding prose are invisible to it — that is what the deterministic detectors and Phase 4's value invariants are for. Anyone reading its output later must not assume otherwise.

**Chart defects are entirely out of reach** until Phase 3 lands. `query_log` stores no chart data, so the hate-crime stale-title bug — a chart title reading "2015–2024" while data ran to 2026 — cannot be seen by the judge or by D4. **D4's chart-title gap stays documented until chart capture exists.** D4 today compares narrative claims to *SQL bounds*, not to the returned data range (which the log also doesn't store), so even its narrative-level coverage is partial.

---

## 4. Measurement — corpus rates only

**Against the 35-row corpus** (19 must-flag with known defect types, 16 must-not-flag), measure and report:

- Per-defect-type recall — the corpus labels *which* defect each row carries, so report recall per type rather than one aggregate. This is what reveals the claim/computation split empirically instead of by assertion.
- False positives on the 16 must-not-flag rows.
- Agreement and disagreement with the deterministic detectors.

**On production traffic there is no ground truth, so a false-negative rate is not computable.** Report only:

- `detector-confirmed` — flagged by a detector *and* the judge. High confidence.
- `judge-only` — flagged by the judge alone. Triage candidate, never a defect claim.
- `detector-only` — flagged by a detector the judge missed. Feeds the reach table in §3.

Keep these three counts strictly separate and never merge judge-only into deterministic totals. **Never label any production number a "false-negative rate."** If the judge's disagreement rate is high (say it flags >20% of sampled traffic), report it as *uncalibrated* and stop there — a miscalibrated judge is worse than none, because it trains the reader to ignore the queue.

Findings go to the existing `audit_findings` table with category `alignment-*`. The unique index on `(query_log_id, category)` makes writes idempotent — no new table.

---

## 5. Scope and rollout

- **Corpus first.** Run against all 35 corpus rows and report the §4 table *before* any production sampling. If per-type recall on the claim-mismatch rows is poor, the prompt needs work before it sees real traffic.
- **Then judge ALL of the previous day's eligible traffic — no sampling cap.** Do not scan all 7,900 rows; do not cap the day.

### Why no per-day cap

An earlier draft said "capped at 50". Measured over 21 days that cap is both inert and harmful:

| | |
|---|---|
| Median eligible/day | **40** — the cap never binds |
| Days over 50 | **7 of 21** (max 203) |
| Cost at median | $0.36/day (~$11/month) |
| Cost at max (203) | $1.83/day |

On two-thirds of days it does nothing. On the days it binds it discards up to **75% of eligible traffic to save about $1.47** — and those are the highest-usage days, with the most varied questions and the best chance of surfacing a class nobody anticipated. A cap that only ever fires on the most informative days is backwards.

**Three separate concerns were collapsed into that one number. Separate them:**

| Concern | Mechanism | Value |
|---|---|---|
| **Coverage** | judge all eligible rows | no cap |
| **Runaway protection** | hard daily ceiling — a safety valve against a log flood, a loop, or a bad exclusion filter, *not* a sampling decision | **500/day** (~$4.50 worst case); log loudly when hit, never silently truncate |
| **Review capacity** | cap *surfaced findings*, not judgments — judge everything, surface the top N by confidence for human triage | start at **15/day**, tune from the real finding rate |

The review cap is the one that actually protects the human: if the judge flags 20% of 200 queries, that is 40 findings nobody will read, and an unread queue is worse than no queue. Capping findings keeps coverage full while keeping the queue readable.

### Volume reality (measured 2026-07-22 → 08-04)

| | |
|---|---|
| 14-day total | 1,115 queries |
| Typical day | **~25–50** |
| Test-heavy days | 168–217 (07-27, 07-28, 08-03, 08-04) |

A flat 50/day sample would be *nearly all* of a normal day's traffic and, on a test-heavy day, mostly synthetic. Size the sample from what is actually eligible after the exclusion below.

### Synthetic traffic MUST be excluded

The replay harness drives the real `/test` UI, so its queries are indistinguishable from human ones in `query_log` except by question text. On 2026-08-04, **74 of 168 rows (44%) were exact matches to the harness case list**, and more were ad-hoc probes not on that list. Judging them would waste judgments on questions whose answers we already know and skew every alignment rate.

Exclude, in this order:

1. **Exact question match** against the harness case list in `scripts/replay-production-queries.js` (both `question` and `loggedQuestion`, since clarifiers rewrite the logged text).
2. **Any row sharing a `session_id`** with a row excluded by (1) — this catches ad-hoc probes run in the same browser session, which exact matching misses.
3. Report the excluded count alongside the judged count every run. A day where exclusion removes most of the traffic is a day the judge has little to say, and that should be visible rather than inferred.

This is a floor, not a solution: exact matching cannot catch a probe phrased freshly. If synthetic volume grows, the durable fix is marking test traffic at the source (a dedicated column or a reserved `session_id` prefix the harness sets) rather than maintaining an exclusion list — worth doing before the judge's numbers are trusted for anything.
- **Human confirmation before any action.** No fix is written and no detector is promoted on the judge's word alone.

## 6. Run accounting — every row is accounted for

Every run records four counts, and they **must reconcile**:

```
eligible = judged + skipped + failed
```

Assert that identity. If it does not hold, the run is buggy and its numbers are not reportable.

| Count | Meaning |
|---|---|
| **eligible** | rows remaining after synthetic exclusion (section 5) |
| **judged** | rows for which the judge returned a valid, schema-conforming verdict |
| **skipped** | rows deliberately not judged — ceiling reached, refusal, truncation, malformed output |
| **failed** | rows where the call itself did not complete — transport error, rate limit, timeout, budget guard |

**Skipped rows are recorded individually, never dropped.** When the 500/day ceiling is reached, every remaining eligible row is written with reason `ceiling-reached` — so the next run can see exactly which rows went unjudged instead of inferring it from a shortfall. The same applies to every other skip reason.

| Reason | Class | Produces a finding? |
|---|---|---|
| `ceiling-reached` | skipped | never |
| `refusal` (`stop_reason: "refusal"`) | skipped | never |
| `truncated` (`stop_reason: "max_tokens"`) | skipped | never |
| `malformed-output` (schema violation) | skipped | never |
| `api-error` (4xx/5xx, transport) | failed | never |
| `rate-limited` (429) | failed | never |
| `budget-exceeded` | failed | never |

**No finding is ever written from a refusal, a truncation, or malformed judge output.** Those are the *absence* of a judgment, not evidence of misalignment. Equally, a skipped row is **not** a clean row — it must not count toward an alignment rate in either direction.

**API, token, and cost failures are reported separately from alignment findings.** They describe the auditor's health, not the product's. A day where 80% of judgments failed on rate limits must never read as a good alignment day — that is a broken run, and the digest has to say so.

**Digest visibility.** The daily email shows, for the judge: eligible / judged / skipped / failed, the reason breakdown for skips and failures, and tokens plus estimated cost. **Hitting the ceiling gets its own named line, not a buried count** — it means coverage was incomplete that day, and the reader needs that before reading any rate. Same treatment for a run where `failed` is a material share of `eligible`.

---

## 7. Tests

Assert returned values; all assertions before the file's final log; none after any exit; nothing that cannot fail.

- Schema conformance: a malformed model response is rejected, not silently coerced.
- `stop_reason: "refusal"` records `skipped` and produces **no** alignment finding.
- A truncated response (`stop_reason: "max_tokens"`) records `skipped` rather than a partial finding.
- `judge-only` vs `detector-confirmed` classification is correct against a fixture where detector output is known.
- The digest keeps the three counts separate and labels an uncalibrated judge as such.
- **Accounting reconciles:** `eligible == judged + skipped + failed` on a fixture with a deliberate mix of all three outcomes.
- **Ceiling records rows individually:** with the ceiling set low, every unjudged eligible row is present with reason `ceiling-reached` — assert the row count, not just the aggregate.
- **No findings from non-judgments:** refusal, truncation, and malformed-output fixtures each produce zero findings and are classed `skipped`.
- **Failures are classed apart from skips:** an api-error and a 429 fixture are counted `failed`, not `skipped`, and produce zero findings.
- **Skipped rows are not clean rows:** a skipped row contributes to neither the aligned nor the misaligned side of any rate.
- **Digest names a ceiling hit** as its own line, and flags a run whose `failed` share is material.
- No response path imports the judge module — assert this by source scan, the same way the route-contract test guards the tag-accumulation fix.

Run full `npm test` + `npx tsc --noEmit`; re-run once on the transient `EXIT=127` npx flake. Commit, report the hash, **do not deploy.**
