# Agency Scorecard Panel — design

**Status:** approved in brainstorming, not yet implemented
**Date:** 2026-08-05

## Problem

`buildAgencyScorecard` returns a good answer that looks unfinished.

It produces nine rows — `offense`, `offenses`, `rate_per_100k`, `clearance_rate` — with `section: true` on the violent and property totals, and sets `chartConfig: null`. In the client, `RtciChat.tsx:543` renders the chart slot **only when `response.chartConfig` is truthy**, so a scorecard renders nothing on the chart side. What remains is the generic `DataTable`, which has no concept of section rows, so `VIOLENT CRIME` and `PROPERTY CRIME` appear as ordinary rows among the offences they summarise.

The result reads as a data dump rather than a product.

## Goal

One Scorecard product: a boxed, titled, formatted table rendered on the chart side, replacing the generic table for this answer type.

## Non-goals

These were considered and explicitly rejected during design. Recording them so they are not re-litigated or quietly reintroduced:

- **No sparklines or trend lines.** Would require the builder to fetch a year range instead of one row. The scorecard is one year for one identified city.
- **No state or national benchmark.** It would make the numbers more meaningful, but costs a query against `historical_state_national`, which has no 2025 rows — so it could not cover the years the scorecard often selects.
- **No new route.** Not `/scorecard/[ori]`. This is a component inside the existing chat result, so it needs no routing or auth-gate work.
- **No SQL change.** The builder's query is unchanged apart from returning the population it already selects.
- **No Recharts.** The graphic *is* a table. Reaching for a chart library here would add weight for nothing.

## Design

### 1. Routing the scorecard into the chart slot

Add an explicit marker to the result payload:

```ts
// lib/types.ts — QueryResponse and the StreamEvent result variant
scorecard?: boolean;
```

`app/api/query/route.ts` sets `scorecard: true` on the scorecard branch (around line 557, where the result event is enqueued).

**Rejected alternative:** detecting a scorecard by comparing `columns` against `SCORECARD_COLUMNS`. That needs no payload change but couples the client to a column list by coincidence, and breaks silently the first time a column is added. It is the same failure class as `chartConfig.title` bypassing the response firewall — a property that held by accident until it didn't. State the intent instead of inferring it.

### 2. `components/ScorecardPanel.tsx`

Self-contained, no chart library.

**Props:** `agencyLabel`, `year`, `population`, `rows: AgencyScorecardRow[]`, `explanation`.

`agencyLabel` is the agency and state alone (`"Tulsa, Oklahoma"`), passed separately rather than parsed out of the existing `title` string (`"Tulsa, Oklahoma Scorecard (2024)"`). The header renders the agency and the year with different emphasis, and splitting a formatted string to recover its parts is the kind of fragility that breaks the first time the title wording changes. The builder already has both pieces before it composes the title, so it should expose them: add `agencyLabel: string` to `AgencyScorecardResult` alongside `population`.

The panel does not receive `title` — it composes its own header from `agencyLabel` and `year`. `title` remains on the result for the chat header and the export filename.

**Header block**
- Agency and state, prominent.
- `Crime Scorecard · <year>` as a secondary line.
- Population and source (`FBI SRS`) quieter still.

**Body — the nine rows as a formatted table**
- `VIOLENT CRIME` and `PROPERTY CRIME` are section rows: heavier weight, a rule above, and **their totals populated** (counts, rate, and clearance), not blank.
- Member offences indent beneath their section.
- Columns: `Offense · Offenses · Rate /100k · Cleared`.
- Numerals right-aligned with tabular figures so digits align column-wise. This is the difference between a table that looks designed and one that looks emitted.

**Clearance rates above 100%**
- Rendered as-is, never clamped. UCR clearances can exceed 100% because the FBI can clear cases in the current year that originated in prior years — Tulsa's 2023 murder clearance is 162.5% in real data.
- Marked with a footnote symbol, and the existing disclosure printed **inside the box**, not only in the surrounding chat text. A number that looks impossible needs its explanation adjacent to it.

**Unavailable state**
- When `rows.length === 0`, the box renders its title and the builder's `explanation`.
- An unavailable scorecard must look deliberate, not like an empty frame. The builder already returns explicit copy for the no-complete-year, no-valid-population, and ambiguous-agency cases.

**Styling**
- Existing tokens (`var(--border)`, `var(--muted)`).
- No gradients, no heavy rounding, no emoji. Editorial density, consistent with the house style.

### 3. `RtciChat.tsx` changes

- Render `ScorecardPanel` in the chart slot when `response.scorecard` is set. The slot's condition currently requires `response.chartConfig`, so it must become `response.chartConfig || response.scorecard`.
- **Suppress `DataTable` when `response.scorecard` is set.** One scorecard, not a designed one beside a plain one. This is what makes it a single product.
- `ExportButtons` already targets `chartRef`, so the box becomes PNG-exportable with no extra work.

### 4. Builder addition

`AgencyScorecardResult` currently returns `title, explanation, columns, rows, year, sql`. The panel needs two more fields, both of which the builder already holds:

- `population: number` — already selected into `data.population` and validated as positive.
- `agencyLabel: string` — already composed as `` `${agency}, ${stateName}` `` before being folded into `title`.

For the unavailable paths, `unavailableScorecard` returns `population: 0` and `agencyLabel: ""`; the panel omits the population line when it is zero and falls back to the explanation-only layout.

## Data flow

```
buildAgencyScorecard(db, question)
  → { title, explanation, columns, rows, year, population, sql }
      ↓ route sets scorecard: true
  → sseEvent result payload
      ↓ client
  → ScorecardPanel (chart slot)   [DataTable suppressed]
```

## Testing

The repository has no React component test infrastructure, so this will not claim rendering coverage it cannot assert. Instead:

- **Logic-level tests** on the panel's exported pure helpers — row grouping into sections, number formatting, the >100% detection that drives the footnote — in `scripts/test-agency-scorecard-panel.ts`, chained into `npm test`.
- **Extend `scripts/test-agency-scorecard.ts`** to assert the builder returns a positive `population` on the success path and `0` on each unavailable path.
- **Manual verification** against live data once deployed, since the existing scorecard has only ever been verified against a fixture. Check what year a real agency resolves to, that section totals are populated, and that a >100% clearance renders with its footnote.

## Risks

- **The scorecard is not currently deployed.** `5c6462a` is on `dev`; production runs `20260805_205601` from `hotfix/nibrs-rollup-attach`, where `agency-scorecard.ts` is absent. Nothing here can be verified against live data until that changes, and `dev` and production have diverged.
- **Suppressing `DataTable` removes sorting and the raw-value view** for scorecard answers. Deliberate — the scorecard is a fixed nine-row layout where sorting is meaningless — but it is a capability removed, and CSV export via `ExportButtons` should be confirmed to still work.
- **`section: true` is presentation metadata travelling in a data row.** Acceptable at this size; if a second panel type ever needs it, it belongs in a separate structure rather than mixed into the row.

## Out of scope, worth doing later

- `requiresClarification` on a geo mention is still not consulted; ambiguity is caught only by the "exactly one candidate" check.
- The builder's complete-year selection requires all nine crime *and* all nine clearance columns non-null, so one missing `rape_clr` silently selects an older year. The explanation names the year, but the panel could surface the gap when the selected year is not the latest available.
