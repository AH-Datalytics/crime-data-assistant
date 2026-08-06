# Agency Scorecard Panel — design

**Status:** approved in brainstorming, not yet implemented
**Date:** 2026-08-05

## Problem

`buildAgencyScorecard` returns a good answer that looks unfinished.

It produces nine rows — `offense`, `offenses`, `rate_per_100k`, `clearance_rate` — with `section: true` on the violent and property totals, and sets `chartConfig: null`.

In `WorkspaceChatV2.tsx` (the component `/test` actually renders), that combination fails three gates:

- **line 229** builds the response object only when `rows.length > 0 || chartConfig`, so an *unavailable* scorecard is discarded outright and never reaches the UI at all;
- **line 346** computes `hasData` the same way, hiding the entire data region;
- **the chart slot** requires `chartConfig`, so even a populated scorecard renders nothing on the chart side.

What survives is the generic `DataTable`, which has no concept of section rows — so `VIOLENT CRIME` and `PROPERTY CRIME` appear as ordinary rows among the offences they summarise.

The result reads as a data dump rather than a product, and the builder's carefully-worded unavailable copy is unreachable.

## Goal

One Scorecard product: a boxed, titled, formatted table rendered on the chart side, replacing the generic table for this answer type.

## Reference design

The target is a supplied mock, reproduced in behaviour rather than approximated:

```
Tulsa, OK Crime Scorecard (2025)

Type                  Offenses   Change from 2024   Rate per 100k   Clearance Rate
──────────────────────────────────────────────────────────────────────────────────
Violent Crime            3,398             –12.3           829.5             38.3
Murder                      26             –33.3             6.3             88.5
Rape                       471               8.3           115.0             14.4
Robbery                    359             –11.6            87.6             35.9
Aggravated Assault       2,542             –15.1           620.5             42.6
Property Crime          14,138              –5.2         3,451.2             22.0
Burglary                 2,590             –15.7           632.2             16.1
Theft                    9,899               0.4         2,416.4             24.6
Motor Vehicle Theft      1,649             –16.9           402.5             15.6

Source CrimeIndex.org                                        [AH Datalytics mark]
```

- Warm cream ground (~`#F5F1E8`), dark slate type (~`#3A4450`).
- **The change column is coloured, and the polarity is inverted from a financial table: crime going DOWN is good.** Negative change reads as improvement (green), positive as deterioration (red). Getting this backwards would invert the meaning of the whole column, so it is stated explicitly rather than left to convention.
  - Colour is **redundant encoding, never the sole signal**: the `−` sign already carries the direction, so the table remains correct in greyscale, in print, and for a red-green colourblind reader. Colour makes the pattern scannable; it does not carry information by itself.
  - Coloured by sign, with no dead-band threshold. Theft at `+0.4` is coloured as an increase. A threshold would need justifying and would introduce a third visual state for values that are already legible as near-zero.
  - Muted, print-appropriate tones against cream — not saturated UI green and red.
- One heavy rule beneath the header row; hairlines between data rows.
- Figures right-aligned with tabular numerals.
- Footer: source attribution left, AH Datalytics mark right.
- 16:9 proportions — this is an exportable graphic, not only an in-app panel.
- **Flat layout with subtle emphasis:** `Violent Crime` and `Property Crime` are semibold but not indented and get no extra rules. No indentation of member offences.

Every figure in the mock reconciles against live production data for Tulsa 2025, so the mock was generated from real output and the chosen year is 2025.

## Non-goals

These were considered and explicitly rejected during design. Recording them so they are not re-litigated or quietly reintroduced:

- **No sparklines or trend lines.** A per-offence trend line would require a multi-year range. Rejected in favour of the single prior-year change column below, which needs one extra year rather than ten.
- **No state or national benchmark.** It would make the numbers more meaningful, but costs a query against `historical_state_national`, which has no 2025 rows — so it could not cover the years the scorecard often selects.
- **No new route.** Not `/scorecard/[ori]`. This is a component inside the existing chat result, so it needs no routing or auth-gate work.
- **No state or national comparison column.** The change column compares the agency against its own prior year, not against a benchmark.
- **No Recharts.** The graphic *is* a table. Reaching for a chart library here would add weight for nothing.

## Design

### 1. Routing the scorecard into the chart slot

Add an explicit marker in three places, all of which must agree or the marker silently vanishes mid-path:

```ts
// lib/types.ts — QueryResponse
scorecard?: boolean;

// lib/types.ts — the StreamEvent "result" variant
scorecard?: boolean;
```

```ts
// app/api/query/route.ts — the scorecard branch (~line 557)
sseEvent({ type: "result", ..., scorecard: true })
```

The marker crosses a serialization boundary: route → `sseEvent` → JSON → client parse → `QueryResponse`. A field present on the route object but absent from the `StreamEvent` type, or dropped when the client reconstructs `qr`, would fail silently — the scorecard would simply render as it does today. **This path must be tested end to end, not just at the endpoints.**

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
- `Violent Crime` and `Property Crime` are **semibold, flush-left, with no indentation of the offences beneath them and no extra rules** — the flat treatment from the reference mock. Their totals are fully populated (count, change, rate, and clearance), not blank.
- Sentence case throughout, matching the mock: `Violent Crime`, not `VIOLENT CRIME`.
- Columns: `Type · Offenses · Change from <prior year> · Rate per 100k · Clearance Rate`.
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

### 3. Client changes — `components/WorkspaceChatV2.tsx`

**The client target is `WorkspaceChatV2`, not `RtciChat`.** `app/test/page.tsx:4` imports `WorkspaceChatV2`, and `/test` is where this is exercised. `RtciChat` is a different surface and is out of scope here.

There are **two** gates that discard a zero-row scorecard, and both must change. The second is the one that makes the deliberate unavailable state reachable at all:

**a. Response construction — line 229.** Currently:

```ts
const qr: QueryResponse | null = event.rows.length > 0 || event.chartConfig ? { ... } : null;
```

An unavailable scorecard has `rows.length === 0` and `chartConfig: null`, so `qr` is `null` and **nothing downstream ever sees the response**. The condition must also admit `event.scorecard`, and the constructed object must carry the marker through.

**b. `hasData` — line 346.** Currently `response.chartConfig || response.rows.length > 0`. Must become `response.chartConfig || response.rows.length > 0 || response.scorecard`. Without this the whole data region is hidden and the empty-state branches at lines 641/648 take over, so the builder's carefully-worded unavailable copy could never appear.

These two are why pure-helper tests are insufficient: a perfectly correct `ScorecardPanel` renders nothing if either gate drops the response.

**c. Chart slot.** Condition becomes `response.chartConfig || response.scorecard`, rendering `ScorecardPanel` when the marker is present.

**d. `DataTable` suppressed** when `response.scorecard` is set. One scorecard, not a designed one beside a plain one — this is what makes it a single product.

**e. Table toggle.** The show/hide-table control must not offer an empty table for a scorecard. For an unavailable scorecard there are no rows at all, and for a populated one the table is redundant with the panel. Hide the toggle when `response.scorecard` is set.

**f. Export.** `ExportButtons` targets `chartRef`, so the box is PNG-exportable once the panel renders inside that ref. Confirm the CSV path still produces the nine rows for a populated scorecard, and that export is either suppressed or yields something sensible for an unavailable one rather than an empty file.

### 4. Builder addition

#### The change column requires prior-year data

This is the one part of the design that reaches into the data layer.

**It is percent change in COUNTS, not in rates.** Determined empirically rather than assumed: against live Tulsa data (2024 → 2025), count-change reproduces all nine of the mock's figures exactly — `−12.3`, `−33.3`, `8.3`, `−11.6`, `−15.1`, `−5.2`, `−15.7`, `0.4`, `−16.9` — with zero deviation, while rate-change deviates by 8.4 points in total. Tulsa's population rose 1.03% over that span, which is precisely the gap that makes the two diverge. Implementing rate-change would make every value in the column subtly and invisibly wrong.

**SQL change.** The builder's final query currently selects one row for the chosen year. It must also retrieve the prior year's nine offence counts. The complete-year selection logic is unchanged — completeness is still assessed on the scorecard year alone, because requiring a complete prior year too would push the card further back in time for no benefit.

**Missing prior year.** When the prior year is absent, or a given offence count is null there, the change cell renders **blank** — never `0.0`, never `—0.0`, and never a change computed against a partial year. A blank cell says "not known"; a zero says "no change", and they are not the same claim.

**Division by zero.** When a prior-year count is `0`, percent change is undefined. Render blank rather than infinity or 100%.

**Column set** becomes:

```ts
export const SCORECARD_COLUMNS = [
  "offense", "offenses", "change_pct", "rate_per_100k", "clearance_rate",
] as const;
```

The header label is composed with the actual prior year — `Change from 2024`, not `Change from prior year` — so an exported card remains readable away from its context.

#### Other builder additions

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

The repository has no React component test infrastructure, so this will not claim rendering coverage it cannot assert. But **pure-helper tests alone are not sufficient here** — the likeliest failure is a missing branch in `WorkspaceChatV2`, which no helper test can see. Three layers:

**1. Pure helpers** — `scripts/test-agency-scorecard-panel.ts`, chained into `npm test`. Row grouping into sections, number formatting, and the >100% detection that drives the footnote.

**2. Marker survives the SSE path** — assert the marker is present at every hop, since it crosses a serialization boundary:
- the route's result payload carries `scorecard: true`
- `StreamEvent` and `QueryResponse` both declare the field, so it is not stripped by typing
- a captured SSE `data:` line parses back to an object with `scorecard === true`

**3. Wiring tests, both states** — proving the panel is reachable, which is the gap that pure helpers leave open. Source-level assertions on `WorkspaceChatV2.tsx`, in the manner of `scripts/test-chart-capture-wiring.ts`:
- the response-construction condition at ~line 229 admits `event.scorecard`, and the constructed object carries the marker
- `hasData` includes `response.scorecard`
- the chart-slot condition includes `response.scorecard`
- `DataTable` is suppressed when `response.scorecard` is set
- the table toggle is hidden when `response.scorecard` is set

Each assertion must fail if its branch is removed. A wiring test that passes against the current unmodified `WorkspaceChatV2` proves nothing — verify non-vacuity by checking the tests fail before the changes are made.

**4. Manual verification against live data.** The scorecard is deployed (see Risks), so this is possible now: check what year a real agency resolves to, that section totals are populated, that a >100% clearance shows its footnote, and that an ambiguous request renders the unavailable box rather than an empty region.

**Extend `scripts/test-agency-scorecard.ts`** to assert the builder returns a positive `population` and a non-empty `agencyLabel` on the success path, and `0` / `""` on each unavailable path.

## Risks

- **The scorecard IS deployed.** Production runs release `20260805_231101` from `dev@93048e4`, with `lib/agency-scorecard.ts` present. Live verification is therefore possible, and should be done — the scorecard has so far only ever been checked against a fixture. (An earlier draft of this spec said it was not deployed; that was true at the time of writing and is now stale.)
- **Production has moved from the hotfix branch back to `dev`.** It previously ran `hotfix/nibrs-rollup-attach`. Anyone reasoning about what is live should check the deployed commit rather than assume, since the branch in use has changed twice today.
- **Suppressing `DataTable` removes sorting and the raw-value view** for scorecard answers. Deliberate — the scorecard is a fixed nine-row layout where sorting is meaningless — but it is a capability removed, and CSV export via `ExportButtons` should be confirmed to still work.
- **`section: true` is presentation metadata travelling in a data row.** Acceptable at this size; if a second panel type ever needs it, it belongs in a separate structure rather than mixed into the row.

## Out of scope, worth doing later

- `requiresClarification` on a geo mention is still not consulted; ambiguity is caught only by the "exactly one candidate" check.
- The builder's complete-year selection requires all nine crime *and* all nine clearance columns non-null, so one missing `rape_clr` silently selects an older year. The explanation names the year, but the panel could surface the gap when the selected year is not the latest available.
