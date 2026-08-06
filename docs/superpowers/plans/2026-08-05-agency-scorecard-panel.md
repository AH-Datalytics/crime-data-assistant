# Agency Scorecard Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the agency scorecard as a designed, boxed, exportable table on the chart side of `/test`, replacing the generic data table, and make the unavailable state reachable.

**Architecture:** Presentation-layer change plus response plumbing. A new `ScorecardPanel` component draws the card; two new fields (`population`, `agencyLabel`) join `year` and a `scorecard` marker in crossing route → SSE → client; `WorkspaceChatV2` gains branches at the two gates that currently discard a zero-row scorecard. The scorecard SQL builder is already complete and live — this plan does not touch its query logic.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind v4, better-sqlite3 (readonly), `tsx` for test scripts.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-05-agency-scorecard-panel-design.md` at `0da98bb`. Where this plan and the spec disagree, the plan is authoritative — it was written against the current code.
- **Client target is `components/WorkspaceChatV2.tsx`.** `app/test/page.tsx:4` renders it. Do NOT modify `RtciChat.tsx`.
- **No SQL/query changes.** `lib/agency-scorecard.ts` already fetches the prior year and computes `offense_change_pct`. Only its return object and type gain fields.
- **Change column is percent change in COUNTS, never rates.** Verified against live Tulsa data: count-change reproduces the reference mock exactly; rate-change deviates 8.4 points.
- **Change colour polarity is INVERTED from finance: negative (crime down) = good/green, positive = bad/red.** Colour is redundant encoding only — the `−` sign carries direction, so the card must remain correct in greyscale.
- **Blank, never zero,** when a change value is unavailable. A blank means "not known"; `0.0` means "no change".
- **Palette:** cream ground `#F5F1E8`, dark slate text `#3A4450`, muted print-appropriate red/green. No gradients, no heavy rounding, no emoji.
- **Run `npx tsc --noEmit` and `npm test` before each commit.** On the known transient `npx` exit 127, rerun once and report both results.
- **Preserve unrelated dirty files.** The tree has ~50. Stage only files named in the task.

## Already Done — Do Not Reimplement

Verified in committed code before writing this plan:

- `SCORECARD_COLUMNS` has five entries including `offense_change_pct` (`lib/agency-scorecard.ts:4`).
- The prior-year query exists (`previousSql`, line 98) and `offense_change_pct` is computed with a `previousCount > 0` guard (line 113), which already satisfies the divide-by-zero rule.
- `AgencyScorecardRow.offense_change_pct: number | null` and `AgencyScorecardResult.year: number | null`, `sql: string | null` already exist.
- `unavailableScorecard` already returns `year: null, sql: null`.
- Section totals populated, >100% clearance preserved with disclosure, positive-denominator enforcement, explicit unavailable/ambiguous copy — all live in release `20260805_231101`.

**Known discrepancy to resolve in Task 1:** `SCORECARD_COLUMNS` orders change **last** (`offense, offenses, rate_per_100k, clearance_rate, offense_change_pct`) but the reference mock and spec place it **third** (`Type, Offenses, Change from 2024, Rate per 100k, Clearance Rate`). The panel controls its own column order, so the array order does not constrain the visual. Do not reorder the array — other consumers (CSV export) read it.

## File Structure

| File | Responsibility |
|---|---|
| `lib/agency-scorecard.ts` (modify) | Add `population` and `agencyLabel` to the result type and both return paths. No query change. |
| `lib/scorecard-format.ts` (create) | Pure formatting/derivation helpers, framework-free so they are unit-testable: number formatting, change sign classification, header label composition. |
| `lib/types.ts` (modify) | Declare the four boundary fields on `QueryResponse` and the `StreamEvent` result variant. |
| `app/api/query/route.ts` (modify) | Emit the four fields on the scorecard result event. |
| `components/ScorecardPanel.tsx` (create) | Presentation only. Consumes helpers from `lib/scorecard-format.ts`. |
| `components/WorkspaceChatV2.tsx` (modify) | Both discard gates, chart slot, `DataTable` suppression, table toggle. |
| `scripts/test-scorecard-format.ts` (create) | Unit tests for the pure helpers. |
| `scripts/test-scorecard-wiring.ts` (create) | Source-level wiring + SSE boundary tests. |
| `scripts/test-agency-scorecard.ts` (modify) | Assert the two new builder fields on both paths. |
| `package.json` (modify) | Chain the two new test scripts. |

Helpers live in `lib/scorecard-format.ts` rather than inside the component because the repo has **no React component test infrastructure** — extracting the logic is what makes it testable at all.

---

### Task 1: Pure formatting helpers

**Files:**
- Create: `lib/scorecard-format.ts`
- Create: `scripts/test-scorecard-format.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `AgencyScorecardRow` from `lib/agency-scorecard.ts`.
- Produces:
  - `formatCount(value: number | null): string`
  - `formatRate(value: number | null): string`
  - `formatClearance(value: number | null): string`
  - `formatChange(value: number | null): string`
  - `changeDirection(value: number | null): "improved" | "worsened" | "none"`
  - `changeHeaderLabel(year: number | null): string`
  - `SCORECARD_DISPLAY_COLUMNS: readonly string[]`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-scorecard-format.ts`:

```ts
import assert from "node:assert/strict";
import {
  formatCount, formatRate, formatClearance, formatChange,
  changeDirection, changeHeaderLabel, SCORECARD_DISPLAY_COLUMNS,
} from "../lib/scorecard-format";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); process.exitCode = 1; }
}

console.log("\n1. Counts use thousands separators; null renders blank");
check("thousands separator", () => assert.equal(formatCount(14138), "14,138"));
check("small number unchanged", () => assert.equal(formatCount(26), "26"));
check("null is blank, not zero", () => assert.equal(formatCount(null), ""));
check("zero is a real value", () => assert.equal(formatCount(0), "0"));

console.log("\n2. Rates keep one decimal and separate thousands");
check("one decimal", () => assert.equal(formatRate(829.5), "829.5"));
check("thousands separator with decimal", () => assert.equal(formatRate(3451.2), "3,451.2"));
check("integer gains a decimal", () => assert.equal(formatRate(115), "115.0"));
check("null is blank", () => assert.equal(formatRate(null), ""));

console.log("\n3. Clearance keeps one decimal and is never clamped");
check("over 100 preserved", () => assert.equal(formatClearance(162.5), "162.5"));
check("normal value", () => assert.equal(formatClearance(38.3), "38.3"));
check("null is blank", () => assert.equal(formatClearance(null), ""));

console.log("\n4. Change uses a real minus sign and never shows a fake zero");
check("negative uses U+2212", () => assert.equal(formatChange(-12.3), "−12.3"));
check("positive has no plus sign", () => assert.equal(formatChange(8.3), "8.3"));
check("exact zero renders as 0.0", () => assert.equal(formatChange(0), "0.0"));
check("null is BLANK not 0.0", () => assert.equal(formatChange(null), ""));

console.log("\n5. Direction drives colour; polarity is inverted (down is good)");
check("negative is improved", () => assert.equal(changeDirection(-12.3), "improved"));
check("positive is worsened", () => assert.equal(changeDirection(8.3), "worsened"));
check("tiny positive still worsened (no dead-band)", () => assert.equal(changeDirection(0.4), "worsened"));
check("zero is neutral", () => assert.equal(changeDirection(0), "none"));
check("null is neutral", () => assert.equal(changeDirection(null), "none"));

console.log("\n6. Header names the actual prior year");
check("2025 yields 2024", () => assert.equal(changeHeaderLabel(2025), "Change from 2024"));
check("null year degrades gracefully", () => assert.equal(changeHeaderLabel(null), "Change"));

console.log("\n7. Display column order matches the reference mock");
check("change is third", () => assert.deepEqual([...SCORECARD_DISPLAY_COLUMNS],
  ["Type", "Offenses", "Change", "Rate per 100k", "Clearance Rate"]));

console.log(`\n${process.exitCode ? "FAILURES present." : `All ${passed} scorecard format checks passed.`}`);
process.exit(process.exitCode ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-scorecard-format.ts`
Expected: FAIL — `Cannot find module '../lib/scorecard-format'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/scorecard-format.ts`:

```ts
/**
 * Pure formatting helpers for the agency scorecard panel.
 *
 * Framework-free and separated from the component on purpose: the repository has
 * no React component test infrastructure, so extracting this logic is what makes
 * it testable at all.
 */

/** Column headers in reference-mock order. `Change` is relabelled per-year by changeHeaderLabel. */
export const SCORECARD_DISPLAY_COLUMNS = [
  "Type", "Offenses", "Change", "Rate per 100k", "Clearance Rate",
] as const;

const blankIfNull = (value: number | null | undefined): boolean => value == null;

export function formatCount(value: number | null): string {
  if (blankIfNull(value)) return "";
  return (value as number).toLocaleString("en-US");
}

export function formatRate(value: number | null): string {
  if (blankIfNull(value)) return "";
  return (value as number).toLocaleString("en-US", {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  });
}

export function formatClearance(value: number | null): string {
  // Never clamped. UCR clearances can exceed 100% because the FBI clears cases
  // in the current year that originated in prior years.
  if (blankIfNull(value)) return "";
  return (value as number).toFixed(1);
}

export function formatChange(value: number | null): string {
  // Blank, never "0.0", when unknown: a blank says "not known", a zero says
  // "no change", and those are different claims.
  if (blankIfNull(value)) return "";
  const magnitude = Math.abs(value as number).toFixed(1);
  return (value as number) < 0 ? `−${magnitude}` : magnitude;
}

export function changeDirection(value: number | null): "improved" | "worsened" | "none" {
  // Polarity is INVERTED from a financial table: crime going down is good.
  if (blankIfNull(value) || value === 0) return "none";
  return (value as number) < 0 ? "improved" : "worsened";
}

export function changeHeaderLabel(year: number | null): string {
  return year == null ? "Change" : `Change from ${year - 1}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-scorecard-format.ts`
Expected: PASS — `All 22 scorecard format checks passed.`

- [ ] **Step 5: Chain into npm test**

In `package.json`, inside the `test` script, insert immediately before ` && node scripts/test-daily-query-analysis.js`:

```
 && npx tsx scripts/test-scorecard-format.ts
```

- [ ] **Step 6: Verify suite and types**

Run: `npx tsc --noEmit` → Expected: exit 0
Run: `npm test` → Expected: exit 0 (on transient exit 127, rerun once, report both)

- [ ] **Step 7: Commit**

```bash
git add lib/scorecard-format.ts scripts/test-scorecard-format.ts package.json
git commit -m "Add pure formatting helpers for the scorecard panel

Extracted rather than inlined in the component because the repo has no React
component test infrastructure -- separating them is what makes the formatting
rules testable.

Encodes three rules that are easy to get wrong: change is blank rather than 0.0
when unknown (a blank says 'not known', a zero says 'no change'); clearance is
never clamped, so a real 162.5% survives; and change direction is INVERTED from
a financial table because crime going down is good."
```

---

### Task 2: Expose `population` and `agencyLabel` from the builder

**Files:**
- Modify: `lib/agency-scorecard.ts`
- Modify: `scripts/test-agency-scorecard.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AgencyScorecardResult` gains `population: number` and `agencyLabel: string`. Both already computed inside `buildAgencyScorecard` — this only surfaces them.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-agency-scorecard.ts`, before its final `console.log`:

```ts
// Boundary fields: the panel draws its header from these, so they must be on the
// result. Both are already computed internally; this asserts they are exposed.
const populated = buildAgencyScorecard(db, "Give me Tulsa, Oklahoma's crime scorecard");
assert.ok(populated);
assert.equal(populated.agencyLabel, "Tulsa, Oklahoma");
assert.equal(populated.population, 410000);
assert.equal(typeof populated.population, "number");

// Unavailable path: every value is falsy, which is exactly the shape that a
// conditional copy downstream would silently drop.
const noAgency = buildAgencyScorecard(db, "Give me Oklahoma crime scorecard");
assert.ok(noAgency);
assert.equal(noAgency.agencyLabel, "");
assert.equal(noAgency.population, 0);
assert.equal(noAgency.year, null);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-agency-scorecard.ts`
Expected: FAIL — `agencyLabel` is `undefined`

- [ ] **Step 3: Write minimal implementation**

In `lib/agency-scorecard.ts`, add to the `AgencyScorecardResult` type:

```ts
  population: number;
  agencyLabel: string;
```

Change `unavailableScorecard` to accept and pass them:

```ts
function unavailableScorecard(title: string, explanation: string, agencyLabel = ""): AgencyScorecardResult {
  return {
    title, explanation, columns: [...SCORECARD_COLUMNS], rows: [],
    year: null, sql: null, population: 0, agencyLabel,
  };
}
```

At each of the three `unavailableScorecard(...)` call sites that already know the agency (the no-complete-year and no-valid-population cases), pass `` `${agency}, ${stateName}` `` as the third argument. The ambiguous-agency call site has no agency, so it keeps the default `""`.

In the success return, add:

```ts
    population,
    agencyLabel: `${agency}, ${stateName}`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-agency-scorecard.ts`
Expected: PASS

- [ ] **Step 5: Verify suite and types**

Run: `npx tsc --noEmit` → Expected: exit 0
Run: `npm test` → Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add lib/agency-scorecard.ts scripts/test-agency-scorecard.ts
git commit -m "Expose population and agencyLabel on the scorecard result

The panel draws its header and source line from these. Both were already
computed inside buildAgencyScorecard; this only surfaces them, with no query
change.

The unavailable paths return population: 0 and agencyLabel: '' -- asserted
explicitly because that all-falsy shape is what a conditional copy downstream
would silently drop while the populated case still passed."
```

---

### Task 3: Declare the four boundary fields and emit them

**Files:**
- Modify: `lib/types.ts`
- Modify: `app/api/query/route.ts`
- Create: `scripts/test-scorecard-wiring.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `AgencyScorecardResult` from Task 2.
- Produces: `QueryResponse` and the `StreamEvent` `"result"` variant each carry `scorecard?: boolean`, `agencyLabel?: string`, `population?: number`, `year?: number | null`. The route emits all four.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-scorecard-wiring.ts`:

```ts
/**
 * Source-level wiring tests.
 *
 * The likeliest failure here is a missing branch, which no unit test of a helper
 * can see: a correct ScorecardPanel renders nothing if the response is discarded
 * upstream. WorkspaceChatV2 builds its response object field-by-field rather than
 * spreading the event, so any field not explicitly copied is dropped silently and
 * the panel renders an empty header instead of erroring.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const types = read("lib/types.ts");
const route = read("app/api/query/route.ts");

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); process.exitCode = 1; }
}

const FIELDS = ["scorecard", "agencyLabel", "population"];

console.log("\n1. QueryResponse declares every boundary field");
for (const field of FIELDS) {
  check(`QueryResponse.${field}`, () => {
    const block = types.slice(types.indexOf("export interface QueryResponse"));
    const end = block.indexOf("\n}");
    assert.ok(new RegExp(`\\b${field}\\??:`).test(block.slice(0, end)), `${field} missing`);
  });
}

console.log("\n2. The StreamEvent result variant declares every boundary field");
for (const field of FIELDS) {
  check(`StreamEvent result.${field}`, () => {
    const start = types.indexOf('type: "result"');
    assert.ok(start > 0, "result variant not found");
    const block = types.slice(start, start + 1400);
    assert.ok(new RegExp(`\\b${field}\\??:`).test(block), `${field} missing`);
  });
}

console.log("\n3. The route emits the marker and the header fields");
check("route sets scorecard: true", () => assert.match(route, /scorecard:\s*true/));
check("route emits agencyLabel", () => assert.match(route, /agencyLabel:\s*agencyScorecard\.agencyLabel/));
check("route emits population", () => assert.match(route, /population:\s*agencyScorecard\.population/));
check("route emits year", () => assert.match(route, /year:\s*agencyScorecard\.year/));

console.log(`\n${process.exitCode ? "FAILURES present." : `All ${passed} scorecard wiring checks passed.`}`);
process.exit(process.exitCode ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-scorecard-wiring.ts`
Expected: FAIL — all ten checks fail; no field is declared or emitted yet.

**This failure is the non-vacuity proof for this task.** Record the count.

- [ ] **Step 3: Write minimal implementation**

In `lib/types.ts`, add to `interface QueryResponse`:

```ts
  scorecard?: boolean;
  agencyLabel?: string;
  population?: number;
```

`QueryResponse` has no `year`; the panel takes it from the result payload, so add it too:

```ts
  year?: number | null;
```

Add the same four lines to the `StreamEvent` variant whose `type` is `"result"`.

In `app/api/query/route.ts`, in the scorecard branch's `sseEvent({ type: "result", ... })` call, add:

```ts
              scorecard: true,
              agencyLabel: agencyScorecard.agencyLabel,
              population: agencyScorecard.population,
              year: agencyScorecard.year,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-scorecard-wiring.ts`
Expected: PASS — all 10 checks.

- [ ] **Step 5: Chain into npm test**

In `package.json`, immediately after the `test-scorecard-format.ts` entry added in Task 1, insert:

```
 && npx tsx scripts/test-scorecard-wiring.ts
```

- [ ] **Step 6: Verify suite and types**

Run: `npx tsc --noEmit` → Expected: exit 0
Run: `npm test` → Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add lib/types.ts app/api/query/route.ts scripts/test-scorecard-wiring.ts package.json
git commit -m "Carry the scorecard marker and header fields to the client

Four fields cross route -> sseEvent -> JSON -> client, and each must be declared
in five places or it silently vanishes. The marker alone would render the panel
with an empty header, since agencyLabel, population and year would not follow it.

The wiring test failed all ten checks before this change, which is its
non-vacuity proof -- a wiring test that passes against unmodified source proves
nothing."
```

---

### Task 4: The `ScorecardPanel` component

**Files:**
- Create: `components/ScorecardPanel.tsx`

**Interfaces:**
- Consumes: helpers from `lib/scorecard-format.ts` (Task 1); `AgencyScorecardRow` from `lib/agency-scorecard.ts`.
- Produces: default export `ScorecardPanel` with props
  `{ agencyLabel: string; year: number | null; population: number; rows: AgencyScorecardRow[]; explanation: string }`.

- [ ] **Step 1: Write the implementation**

There is no React test infrastructure, so this task has no test cycle of its own — its logic lives in Task 1's tested helpers and its wiring is asserted in Task 5. Create `components/ScorecardPanel.tsx`:

```tsx
"use client";

import type { AgencyScorecardRow } from "@/lib/agency-scorecard";
import {
  formatCount, formatRate, formatClearance, formatChange,
  changeDirection, changeHeaderLabel,
} from "@/lib/scorecard-format";

const CREAM = "#F5F1E8";
const SLATE = "#3A4450";
const RULE = "#3A4450";
const HAIRLINE = "#E2DCCC";
// Muted, print-appropriate against cream -- not saturated UI red/green.
const IMPROVED = "#2F6B4F";
const WORSENED = "#A83A32";

interface ScorecardPanelProps {
  agencyLabel: string;
  year: number | null;
  population: number;
  rows: AgencyScorecardRow[];
  explanation: string;
}

export default function ScorecardPanel({
  agencyLabel, year, population, rows, explanation,
}: ScorecardPanelProps) {
  const heading = agencyLabel
    ? `${agencyLabel} Crime Scorecard${year != null ? ` (${year})` : ""}`
    : "Crime Scorecard";

  // Unavailable state: render the builder's explanation inside the card so an
  // unavailable scorecard looks deliberate rather than like an empty frame.
  if (rows.length === 0) {
    return (
      <div className="h-full w-full overflow-auto p-6 sm:p-8" style={{ background: CREAM, color: SLATE }}>
        <h2 className="text-xl sm:text-2xl font-bold tracking-tight">{heading}</h2>
        <p className="mt-4 max-w-prose text-sm leading-relaxed" style={{ color: SLATE }}>{explanation}</p>
        <div className="mt-8 text-[10px] uppercase tracking-wider" style={{ color: "#8A8778" }}>
          Source CrimeIndex.org
        </div>
      </div>
    );
  }

  const hasOver100 = rows.some((row) => row.clearance_rate != null && row.clearance_rate > 100);
  const numeric = "text-right tabular-nums whitespace-nowrap";

  return (
    <div
      className="h-full w-full overflow-auto p-6 sm:p-8"
      style={{ background: CREAM, color: SLATE }}
    >
      <h2 className="text-xl sm:text-2xl font-bold tracking-tight">{heading}</h2>
      {population > 0 && (
        <p className="mt-1 text-xs" style={{ color: "#8A8778" }}>
          Population {formatCount(population)}
        </p>
      )}

      <div className="mt-5 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="pb-2 pr-4 text-left font-bold">Type</th>
              <th className={`pb-2 pl-4 font-bold ${numeric}`}>Offenses</th>
              <th className={`pb-2 pl-4 font-bold ${numeric}`}>{changeHeaderLabel(year)}</th>
              <th className={`pb-2 pl-4 font-bold ${numeric}`}>Rate per 100k</th>
              <th className={`pb-2 pl-4 font-bold ${numeric}`}>Clearance Rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const direction = changeDirection(row.offense_change_pct);
              const changeColor =
                direction === "improved" ? IMPROVED : direction === "worsened" ? WORSENED : SLATE;
              return (
                <tr
                  key={row.offense}
                  style={{
                    borderTop: index === 0 ? `2px solid ${RULE}` : `1px solid ${HAIRLINE}`,
                  }}
                >
                  {/* Flat layout: totals are semibold but not indented, and get no extra rules. */}
                  <td className={`py-2.5 pr-4 ${row.section ? "font-semibold" : ""}`}>{row.offense}</td>
                  <td className={`py-2.5 pl-4 ${numeric} ${row.section ? "font-semibold" : ""}`}>
                    {formatCount(row.offenses)}
                  </td>
                  {/* Colour is redundant encoding -- the minus sign carries direction, so this
                      stays correct in greyscale and for a red-green colourblind reader. */}
                  <td className={`py-2.5 pl-4 ${numeric}`} style={{ color: changeColor }}>
                    {formatChange(row.offense_change_pct)}
                  </td>
                  <td className={`py-2.5 pl-4 ${numeric}`}>{formatRate(row.rate_per_100k)}</td>
                  <td className={`py-2.5 pl-4 ${numeric}`}>
                    {formatClearance(row.clearance_rate)}
                    {row.clearance_rate != null && row.clearance_rate > 100 ? "*" : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hasOver100 && (
        <p className="mt-4 max-w-prose text-[11px] leading-snug" style={{ color: "#8A8778" }}>
          * Clearance rates can exceed 100% because agencies may clear cases in the current year
          that originated in prior reporting years.
        </p>
      )}

      <div className="mt-6 flex items-end justify-between">
        <div className="text-[10px] uppercase tracking-wider" style={{ color: "#8A8778" }}>
          Source CrimeIndex.org
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add components/ScorecardPanel.tsx
git commit -m "Add the ScorecardPanel component

Boxed cream card matching the reference mock: five columns with change third,
one heavy rule under the header and hairlines between rows, right-aligned
tabular figures, flat layout with semibold totals and no indentation.

Clearance values over 100% are marked and explained in a footnote inside the
card rather than only in the surrounding chat text -- a number that looks
impossible needs its explanation adjacent to it.

The zero-row path renders the builder's explanation inside the card so an
unavailable scorecard looks deliberate instead of showing an empty frame.

All formatting comes from lib/scorecard-format.ts so it is covered by tests;
this file is presentation only."
```

---

### Task 5: Wire the panel into `WorkspaceChatV2`

**Files:**
- Modify: `components/WorkspaceChatV2.tsx`
- Modify: `scripts/test-scorecard-wiring.ts`

**Interfaces:**
- Consumes: `ScorecardPanel` (Task 4); the four boundary fields (Task 3).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-scorecard-wiring.ts`, before its final `console.log`:

```ts
const chat = read("components/WorkspaceChatV2.tsx");

console.log("\n4. WorkspaceChatV2 does not discard a zero-row scorecard");
check("response construction admits event.scorecard", () => {
  assert.match(chat, /event\.rows\.length > 0 \|\| event\.chartConfig \|\| event\.scorecard/);
});
check("the constructed object copies all four fields", () => {
  for (const field of ["scorecard", "agencyLabel", "population"]) {
    assert.ok(
      new RegExp(`${field}:\\s*event\\.${field}`).test(chat),
      `qr reconstruction does not copy ${field}`,
    );
  }
});
check("hasData admits response.scorecard", () => {
  assert.match(chat, /const hasData =[^;]*response\.scorecard/);
});

console.log("\n5. WorkspaceChatV2 renders one scorecard, not two views of it");
check("ScorecardPanel is imported", () => assert.match(chat, /import ScorecardPanel from "\.\/ScorecardPanel"/));
check("chart slot admits response.scorecard", () => assert.match(chat, /response\.chartConfig \|\| response\.scorecard/));
check("ScorecardPanel is rendered", () => assert.match(chat, /<ScorecardPanel/));
check("DataTable is suppressed for scorecards", () => assert.match(chat, /!response\.scorecard[^)]*&&[\s\S]{0,200}<DataTable/));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-scorecard-wiring.ts`
Expected: FAIL on all seven new checks. **Record the count — this is the non-vacuity proof.**

- [ ] **Step 3: Write minimal implementation**

In `components/WorkspaceChatV2.tsx`:

**(a)** Add the import beside the existing `DataTable` / `ChartPanel` imports:

```ts
import ScorecardPanel from "./ScorecardPanel";
```

**(b)** At the response construction (~line 229), change the condition and copy the fields:

```ts
                const qr: QueryResponse | null = event.rows.length > 0 || event.chartConfig || event.scorecard
                  ? { success: true as const, question, sql: event.sql, explanation: event.explanation, title: event.title, columns: event.columns, rows: event.rows, rowCount: event.rowCount, truncated: event.truncated, chartConfig: event.chartConfig, chartMeta: event.chartMeta, executionTimeMs: event.executionTimeMs, scorecard: event.scorecard, agencyLabel: event.agencyLabel, population: event.population, year: event.year }
                  : null;
```

Copy all four **unconditionally**. Do not guard with `if (event.year)` — on the unavailable path every value is falsy and a conditional copy would drop them all while the populated case still passed.

**(c)** At `hasData` (~line 346):

```ts
  const hasData = response && (response.chartConfig || response.rows.length > 0 || response.scorecard);
```

**(d)** At the chart-slot condition, change `response.chartConfig &&` to `(response.chartConfig || response.scorecard) &&`, and inside it render the panel in place of `ChartPanel` when the marker is set:

```tsx
                      {response.scorecard ? (
                        <ScorecardPanel
                          agencyLabel={response.agencyLabel ?? ""}
                          year={response.year ?? null}
                          population={response.population ?? 0}
                          rows={response.rows as never}
                          explanation={response.explanation}
                        />
                      ) : (
                        <ChartPanel config={response.chartConfig!} rows={response.rows} meta={response.chartMeta} />
                      )}
```

**(e)** Suppress `DataTable` and its toggle for scorecards: add `!response.scorecard &&` to the condition guarding the table block, and to the condition that renders the show/hide-table control, so an unavailable scorecard offers no empty table.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-scorecard-wiring.ts`
Expected: PASS — all 17 checks.

- [ ] **Step 5: Verify suite and types**

Run: `npx tsc --noEmit` → Expected: exit 0
Run: `npm test` → Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add components/WorkspaceChatV2.tsx scripts/test-scorecard-wiring.ts
git commit -m "Render the scorecard panel and stop discarding zero-row scorecards

Two gates dropped a scorecard before anything could render it. Response
construction built the object only when rows.length > 0 || chartConfig, so an
unavailable scorecard was discarded outright and hasData never even ran; hasData
then repeated the same test. Both now admit response.scorecard, which is what
makes the builder's unavailable copy reachable at all.

The four boundary fields are copied unconditionally. On the unavailable path
every value is falsy, so a conditional copy would have dropped all of them while
the populated case still passed.

DataTable and its toggle are suppressed for scorecards: one scorecard, not a
designed one beside a plain one, and no empty table offered when there are no
rows.

The seven wiring checks failed before this change."
```

---

### Task 6: Live verification against production data

**Files:** none — verification only.

**Interfaces:** none.

- [ ] **Step 1: Confirm what is deployed**

Run:

```bash
ssh root@178.156.243.51 "readlink /opt/nibrs/current; cd /opt/nibrs/repo && git rev-parse --short HEAD"
```

The scorecard builder is live in `20260805_231101` (`dev@93048e4`), but this plan's client changes are not. Deployment is a separate decision — do not deploy as part of this plan.

- [ ] **Step 2: Verify the builder's fields against real data locally**

Run:

```bash
npx tsx -e "
const D = require('better-sqlite3');
const { buildAgencyScorecard } = require('./lib/agency-scorecard');
const db = new D('crime_data.db', { readonly: true });
const r = buildAgencyScorecard(db, \"Tulsa, Oklahoma crime scorecard\");
console.log({ agencyLabel: r.agencyLabel, year: r.year, population: r.population });
console.log(r.rows.map(x => [x.offense, x.offenses, x.offense_change_pct, x.rate_per_100k, x.clearance_rate]));
"
```

Expected, from the reference mock's known-good values: `agencyLabel: "Tulsa, Oklahoma"`, `year: 2025`, and rows matching Violent Crime `3398 / −12.3 / 829.5 / 38.3`, Murder `26 / −33.3 / 6.3 / 88.5`, Theft `9899 / 0.4`, Motor Vehicle Theft `1649 / −16.9`.

If change values do not match, the builder is computing rate-change rather than count-change — stop and fix that before proceeding.

- [ ] **Step 3: Record the result**

Report the observed year, the population, and whether the nine change values match the mock. Do not commit anything in this task.

---

## Self-Review

**Spec coverage.** Every requirement maps to a task: helpers and formatting rules → Task 1; `population`/`agencyLabel` → Task 2; four fields across five sites → Tasks 2 and 3; the panel, palette, flat totals, >100% footnote, unavailable state → Task 4; both discard gates, chart slot, `DataTable` suppression, toggle → Task 5; live verification → Task 6. The spec's prior-year fetch, `change_pct` computation, `year: number | null`, and divide-by-zero rule are already implemented and are listed under "Already Done" rather than given tasks.

**Placeholders.** None. Every code step contains the actual content.

**Type consistency.** `offense_change_pct` is used throughout, matching the committed builder — not the spec's provisional `change_pct`. `formatCount`/`formatRate`/`formatClearance`/`formatChange`/`changeDirection`/`changeHeaderLabel` keep the same names in Tasks 1, 4 and their tests. `AgencyScorecardResult.population: number` and `agencyLabel: string` in Task 2 match their optional counterparts on the payload types in Task 3, with `??` defaults applied at the call site in Task 5.

**One deliberate deviation from the spec, recorded here:** the spec names the change field `change_pct`; the committed builder already calls it `offense_change_pct`. The plan uses the committed name. Renaming would touch working, deployed code for no benefit.
