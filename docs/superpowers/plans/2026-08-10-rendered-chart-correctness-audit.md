# Plan: rendered chart correctness audit

**Date:** 2026-08-10
**Status:** Implemented and verified locally; not deployed
**Owner:** Codex
**First production regression:** query 8388

## Outcome

For every chart produced for a real user, answer four distinct questions:

1. Did the SQL return the values and shape needed by the request?
2. Did the final chart configuration select the correct type, axes, series, title, and units?
3. Did the production chart component render the expected marks, legend, ticks, and values?
4. What remains unverified?

The audit is asynchronous and advisory. It must not delay a user response, submit synthetic questions, call a model, or silently describe missing evidence as a pass.

## Why configuration checks alone are insufficient

Query 8388 asked for Las Vegas murder clearances by type in 2025. The source row was:

| Measure | Value |
|---|---:|
| Total offenses | 82 |
| Cleared by arrest | 62 |
| Death of offender | 11 |
| Other exceptional reasons | 0 |
| Not cleared | 9 |

The delivered query instead returned a `Cleared by Arrest` row containing several measures and a `Not Cleared` row whose numeric fields were all zero. It never returned `not_cleared = 9`. A renderer can faithfully draw that payload and still show a wrong chart. Therefore the audit must cover data shape, chart configuration, and the rendered artifact separately.

## Artifact model

### Server-side response artifact

Capture the finalized chart artifact after all title corrections and chart customizations, immediately before logging and returning the response:

- stable random `request_id` shared by the query log, response payload, and render receipt;
- finalized `chart_config` (existing allowlisted serializer);
- result columns and row count;
- bounded chart-data snapshot containing only scalar output values;
- canonical hash of the complete chart rows before bounding;
- snapshot row/column counts and a `truncated` flag.

Use a separate `chart_audit_artifacts` table keyed by `request_id`, rather than continually widening `query_log`. Suggested limits:

- at most 200 rows;
- at most 25 columns;
- at most 64 KiB serialized;
- strings capped at 300 characters;
- no SQL, prompts, model text, annotations, or arbitrary object properties in the artifact.

If a chart exceeds a limit, preserve the full counts and hash and mark exact offline reproduction `unavailable-truncated`. Never treat that as clean.

### Actual browser render receipt

After `ChartPanel` or `NibrsChartPanel` renders, post a small sanitized receipt keyed by `request_id`:

- component and chart type;
- effective X key and effective Y keys after auto-pivoting;
- rendered line, bar, point, and area counts;
- legend labels;
- visible X/Y tick labels;
- SVG width and height;
- overflow, zero-size, `NaN`, `undefined`, and render-error indicators;
- receipt timestamp and viewport class.

Do not upload screenshots or tooltip bodies from a user's browser. The receipt contains structure only. Failure to receive a receipt is `render-unverified`, not success.

### Offline production-component render

For chart artifacts with a complete bounded snapshot, render the exact saved rows and configuration through the production component in Playwright. This does not call an API or model and does not create a query-log row.

Inspect the SVG/DOM and exercise representative tooltips. Save a screenshot only for a flagged audit finding, in a restricted audit directory with retention limits.

The browser receipt answers what the user's browser rendered. The offline render provides reproducibility and richer inspection. Disagreement between them is itself a finding.

## Deterministic detectors

### Data-shape checks

- Requested categorical breakdown has a category column and one numeric value column, or an explicitly supported wide-to-long mapping.
- A category label is not paired with an unrelated or permanently zero numeric field.
- Duplicate X values are allowed only when a category column exists and the renderer will pivot them.
- Requested places/categories are not silently omitted.
- Numeric identities hold when derivable. For clearance outcomes:

  `not_cleared = total_offenses - cleared_by_arrest - sum(exceptional reasons)`

- Missing values remain missing; they are not converted to zero without evidence.

### Configuration checks

- X and every Y key exist in the returned columns.
- The configuration does not omit requested numeric series.
- The chart type matches the requested/data shape: temporal line, categorical bar, composition pie/stacked bar only when appropriate.
- Title, place, offense, time range, and units agree with the question, SQL summary, and returned columns.
- Series count stays within the supported rendering limit.
- Axis labels and percentage/rate formatting match the measures.

### Render checks

- A nonempty chart produces visible marks.
- Rendered series and legend labels equal the effective post-pivot series.
- Expected nonzero values produce nonzero-size marks.
- Tick labels are present, nonduplicated where required, and not visibly clipped.
- SVG dimensions are nonzero and no container overflow hides the plot or legend.
- Representative tooltip labels and values match the saved chart data.
- No rendered text contains `NaN`, `undefined`, internal field names, or unsanitized technical content.

## Query 8388 acceptance fixture

The corrected query result should be long-form and chartable, for example:

| clearance_outcome | count |
|---|---:|
| Cleared by arrest | 62 |
| Death of offender | 11 |
| Not cleared | 9 |

Zero exceptional categories may be retained or omitted according to one documented policy, but the configuration, narrative, and legend must use the same policy.

Required assertions:

- the data-shape detector rejects the original two-row payload;
- the numeric-identity detector reports the missing nine uncleared offenses;
- the corrected payload produces three visible bars;
- legend/category labels and tooltip values are 62, 11, and 9;
- the chart title names Las Vegas, murder clearances, and 2025;
- the human digest describes the concrete mismatch rather than emitting an internal detector code.

## Human email presentation

Add one chart line to each real-user query card:

> **Chart:** Bar chart; three expected outcome bars rendered — no mismatch detected.

For a failure:

> **Chart problem:** Expected Cleared by arrest (62), Death of offender (11), and Not cleared (9). The returned data omitted the numeric value for Not cleared, and the rendered chart showed it as zero.

Use four states only:

- `verified-rendered`;
- `incorrect`;
- `needs-review`;
- `unverified` (missing/truncated artifact or missing browser receipt).

Never translate `unverified` into “no problem detected.” Technical detector names remain in `audit_findings`, not in the human email.

## Schema and deployment sequence

1. Run the already-tested additive `chart_config` migration in production so collection can begin.
2. Add `request_id`, `chart_audit_artifacts`, and `chart_render_receipts` through additive, idempotent migrations.
3. Capture the exact finalized server artifact on every chart-bearing response, fail-open.
4. Add deterministic data-shape and configuration detectors, calibrated against good and bad fixtures.
5. Add browser render receipts behind an observation-only feature flag.
6. Add offline Playwright rendering for complete artifacts and screenshots for failures only.
7. Add the human chart status to the answer-review email.

Each step ships separately. Do not deploy any step without explicit approval. Existing rows cannot be treated as chart-clean because production did not capture their configurations or rendered artifacts.

## Tests and operational limits

- Unit tests for bounding, hashing, parsing, and every detector.
- Wiring tests for every chart-bearing route and both chart components.
- Good controls for line, grouped bar, stacked bar, pie, scatter, auto-pivot, missing years, and zero-valued categories.
- Bad controls for query 8388, missing series, duplicate X values, false zeroes, stale titles, invalid axes, blank renders, clipped labels, and series overflow.
- Browser tests at desktop and narrow mobile viewport sizes.
- Accounting identity per run: `eligible = verified + incorrect + needs_review + unverified`.
- Read-only/offline work only after the response; no model calls and no synthetic production queries.
- Hard wall-clock and artifact-retention limits; audit failure never affects the user response.

## Ownership boundary

Claude completes the active query-correctness branch, including multi-city and Jacksonville decisions. Codex implements this chart-audit plan afterward. Until Claude finishes, Codex changes only this specification so the shared worktree does not overlap.

## Implemented operational flow

1. Deploy the application code and run `node scripts/migrate-chart-audit-artifacts.js /opt/nibrs/shared/query_log.db` before expecting capture. Code and migration remain safe in either order; an unmigrated database simply leaves chart auditing unavailable.
2. Run `npm run chart-audit -- /opt/nibrs/shared/query_log.db` before the daily answer-review email. Its accounting line must satisfy `eligible = verified + incorrect + needs-review + unverified`.
3. Browser receipts are observation-only and post no chart values, screenshots, questions, SQL, or tooltip bodies.
4. For reproducible offline inspection, start a local production build with `CHART_AUDIT_PREVIEW_ENABLED=1`, then run `npm run chart-audit:render -- <query_log.db> <request-id> <base-url>`. The preview route is a 404 unless explicitly enabled. Screenshots are written only for failures.
5. Do not deploy or schedule these steps without explicit approval.

Local acceptance completed with the corrected query 8388 fixture: the production NIBRS chart component rendered three bars for 62, 11, and 9; axes were present; and the exercised tooltip matched saved numeric data. The intentionally bad original payload is rejected with the human-readable missing-nine finding.
