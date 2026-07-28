# Stage 1: Query-Bearing Follow-Up Bypass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop standalone-question shortcut handlers (metadata coverage, county clarifier, historical place lookup) from intercepting follow-ups that modify a prior successful query; those follow-ups must reach the normal model path with their conversation history.

**Architecture:** One new shared predicate module (`lib/query-bearing-followup.ts`) detects "query-bearing follow-ups" — prior successful SQL in history + the new message requests a change to year range, geography, offense, metric, granularity, breakdown, or chart. All four API routes consult it before their standalone shortcuts. One existing regex (`compare_geographies` in `lib/followup-transform.ts`) is widened to match "compare **it** to Dallas".

**Tech Stack:** TypeScript, Next.js 16 API routes, node:assert/strict test scripts run via `npx tsx` (repo convention — no test framework).

## Global Constraints

- Repo: `C:\Users\jeffm\crime-data-assistant`, branch `dev`. Do not touch `master`.
- Narrow behavior fix only: do NOT touch `getBlockingGeoClarification`, `historicalYearAvailability`, capability overrides, the SHR deterministic shooting path, or the response cache. (Probes on 2026-07-28 confirmed none of them misfire on the six regression phrases.)
- The predicate consumes RAW `body?.history` (unknown), not normalized history — the /api/query shortcuts run before `normalizeHistoryForTab` (app/api/query/route.ts:810).
- A genuine standalone metadata question with no prior SQL must still hit the metadata handler (acceptance invariant).
- Pre-existing baseline to preserve: `npm test` green (39 suites); `npx tsx scripts/test-session-replay.ts` = 68/71 passed (3 pre-existing failures — no new failures allowed).
- Only stage files this plan touches; the worktree has unrelated unstaged changes (scripts/cde-discrepancy-check.py, scripts/watch-rtci.log, many untracked files).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Regression phrases (must be covered by tests)

With prior-SQL history → predicate MUST fire; without history → MUST NOT:
1. "Can you change the start year to 1988?" (time_range) — currently intercepted by metadata `year_range` (lib/metadata-coverage.ts:128-131)
2. "Go back further to 1940." (time_range)
3. "Start the chart in 2000." (time_range)
4. "Make it monthly." (granularity)
5. "Show the rate instead." (metric)
6. "Compare it to Dallas." (geography)

Must NOT fire even WITH prior SQL (coverage questions, not change requests):
- "What years does the data cover?"
- "How far back does the data go?"
- "What's the earliest year available?"
- "Which states are covered?"

---

### Task 1: Predicate module `lib/query-bearing-followup.ts`

**Files:**
- Create: `lib/query-bearing-followup.ts`
- Test: `scripts/test-query-bearing-followup.ts`
- Modify: `package.json:11` (append new suite to `test` chain)

**Interfaces:**
- Produces: `detectQueryBearingFollowup(question: string, rawHistory: unknown): QueryBearingFollowup | null` where `QueryBearingFollowup = { kinds: FollowupChangeKind[] }` and `FollowupChangeKind = "time_range" | "geography" | "offense" | "metric" | "granularity" | "breakdown" | "chart"`. Tasks 3-4 import the function only and treat non-null as "bypass standalone shortcuts".

- [ ] **Step 1: Write the failing test**

```ts
// scripts/test-query-bearing-followup.ts
// Run: npx tsx scripts/test-query-bearing-followup.ts
import assert from "node:assert/strict";
import { detectQueryBearingFollowup } from "../lib/query-bearing-followup";

const priorSqlHistory = [
  { role: "user", content: "Murder rates in Minnesota vs the nation since 1985", source: "historical" },
  { role: "assistant", content: "Here are the rates.\n[SQL: SELECT year, murders FROM historical_state_national WHERE state='Minnesota']", source: "historical" },
];
const noSqlHistory = [
  { role: "user", content: "hi", source: "historical" },
  { role: "assistant", content: "Hello! Ask me about crime data.", source: "historical" },
];

function kinds(question: string, history: unknown): string[] | null {
  const r = detectQueryBearingFollowup(question, history);
  return r ? r.kinds : null;
}

// The six regressions, with prior SQL → fires with the right kind
assert.deepEqual(kinds("Can you change the start year to 1988?", priorSqlHistory), ["time_range"]);
assert.deepEqual(kinds("Go back further to 1940.", priorSqlHistory), ["time_range"]);
assert.deepEqual(kinds("Start the chart in 2000.", priorSqlHistory), ["time_range"]);
assert.deepEqual(kinds("Make it monthly.", priorSqlHistory), ["granularity"]);
assert.deepEqual(kinds("Show the rate instead.", priorSqlHistory), ["metric"]);
assert.deepEqual(kinds("Compare it to Dallas.", priorSqlHistory), ["geography"]);

// More change phrasings
assert.deepEqual(kinds("extend it through 2020", priorSqlHistory), ["time_range"]);
assert.deepEqual(kinds("show it from 1990 to 2010", priorSqlHistory), ["time_range"]);
assert.deepEqual(kinds("what about since 1995?", priorSqlHistory), ["time_range"]);
assert.deepEqual(kinds("make it annual", priorSqlHistory), ["granularity"]);
assert.deepEqual(kinds("show counts instead of rates", priorSqlHistory), ["metric"]);
assert.deepEqual(kinds("now make it per capita", priorSqlHistory), ["metric"]);
assert.deepEqual(kinds("what about Dallas?", priorSqlHistory), ["geography"]);
assert.deepEqual(kinds("compare that with Houston", priorSqlHistory), ["geography"]);
assert.deepEqual(kinds("break it down by state", priorSqlHistory), ["breakdown"]);
assert.deepEqual(kinds("make it a line chart", priorSqlHistory), ["chart"]);
assert.deepEqual(kinds("show robberies instead", priorSqlHistory), ["offense"]);

// Multiple kinds accumulate (order: time_range, geography, offense, metric, granularity, breakdown, chart)
assert.deepEqual(kinds("make it monthly and start the chart in 2000", priorSqlHistory), ["time_range", "granularity"]);

// No prior SQL → never fires (standalone questions keep the fast path)
assert.equal(kinds("Can you change the start year to 1988?", noSqlHistory), null);
assert.equal(kinds("Can you change the start year to 1988?", []), null);
assert.equal(kinds("Can you change the start year to 1988?", undefined), null);
assert.equal(kinds("Compare it to Dallas.", noSqlHistory), null);

// Genuine metadata/coverage questions → never fires even WITH prior SQL
assert.equal(kinds("What years does the data cover?", priorSqlHistory), null);
assert.equal(kinds("How far back does the data go?", priorSqlHistory), null);
assert.equal(kinds("What's the earliest year available?", priorSqlHistory), null);
assert.equal(kinds("Which states are covered?", priorSqlHistory), null);
assert.equal(kinds("Which agencies are included in this result?", priorSqlHistory), null);
assert.equal(kinds("how many cities are in the data", priorSqlHistory), null);
assert.equal(kinds("can I download this as CSV?", priorSqlHistory), null);

// Fresh full questions that merely mention a year or place → no change-request verbs → null
assert.equal(kinds("murders in Chicago in 1988", priorSqlHistory), null);
assert.equal(kinds("robbery trend in Texas", priorSqlHistory), null);

// County-scope clarifier ANSWERS must not be swallowed (they have their own transform)
assert.equal(kinds("Countywide total", priorSqlHistory), null);
assert.equal(kinds("Sheriff's office only", priorSqlHistory), null);

// Malformed history entries are ignored safely
assert.equal(kinds("Make it monthly.", [{ role: "assistant" }, null, 42, "x"]), null);

console.log("query-bearing-followup tests passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-query-bearing-followup.ts`
Expected: FAIL — `Cannot find module '../lib/query-bearing-followup'`

- [ ] **Step 3: Write the implementation**

```ts
// lib/query-bearing-followup.ts
import { resolveGeoPlaces } from "./geo-place-resolver";

/**
 * Detects "query-bearing follow-ups": the conversation already produced a
 * successful SQL result and the new message asks to CHANGE something about it
 * (year range, geography, offense, metric, granularity, breakdown, chart).
 *
 * Routes must bypass standalone-question shortcuts (metadata coverage, county
 * clarifier, historical place lookup) when this returns non-null, so the
 * follow-up reaches the model path with its conversation history. Without this,
 * "Can you change the start year to 1988?" matched the metadata year_range
 * intent (lib/metadata-coverage.ts) and returned coverage metadata instead of
 * modifying the prior query.
 *
 * Deliberately narrower than isFollowUp (lib/tab-suggest.ts): coverage
 * questions like "how far back does the data go?" are follow-ups but are NOT
 * change requests — those must keep the fast deterministic metadata path.
 */
export type FollowupChangeKind =
  | "time_range"
  | "geography"
  | "offense"
  | "metric"
  | "granularity"
  | "breakdown"
  | "chart";

export interface QueryBearingFollowup {
  kinds: FollowupChangeKind[];
}

const YEAR_RE = /\b(?:17|18|19|20)\d{2}\b/;

/** Same signal detectFollowupTransform uses: an assistant turn carrying SQL. */
function hasPriorSqlResult(rawHistory: unknown): boolean {
  if (!Array.isArray(rawHistory)) return false;
  return rawHistory.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const role = (entry as { role?: unknown }).role;
    const content = (entry as { content?: unknown }).content;
    return role === "assistant" && typeof content === "string" &&
      /\bSELECT\b[\s\S]+\bFROM\b/i.test(content);
  });
}

/** Coverage/metadata phrasings that must keep the deterministic metadata path. */
function asksCoverageNotChange(q: string): boolean {
  return /\bhow\s+far\s+back\b/i.test(q) ||
    /\b(?:what|which)\s+years?\b/i.test(q) ||
    /\b(?:earliest|latest)\s+(?:year|data)\b.*\b(?:available|covered|in\s+the\s+data)\b/i.test(q) ||
    /\bdata\s+(?:go(?:es)?\s+back|start|begin|available)\b/i.test(q) ||
    /\b(?:years?|states?|agenc(?:y|ies)|cit(?:y|ies))\b.*\b(?:available|covered|represented|included|in\s+the\s+data(?:base|set)?)\b/i.test(q) ||
    /\b(?:download|export|csv)\b/i.test(q);
}

function refersToTimeRangeChange(q: string): boolean {
  // "change/set/extend/... the start year / year range / period ..."
  if (/\b(?:change|set|update|move|shift|adjust|extend|expand|shorten|limit|restrict)\b/i.test(q) &&
      /\b(?:years?|dates?|range|period|time\s*frame|timeframe)\b/i.test(q)) return true;
  // "start year 1988" / "end year to 2010" (a change request when a year is named)
  if (/\b(?:start|starting|begin|beginning|end|ending)\s+(?:year|date|month)\b/i.test(q) && YEAR_RE.test(q)) return true;
  // "start the chart in 2000" / "start it at 1988" / "begin in 1990"
  if (/\b(?:start|begin)\s+(?:(?:the|this|that)\s+)?(?:chart|graph|plot|data|series|trend|it)?\s*(?:in|at|from)\s+(?:17|18|19|20)\d{2}\b/i.test(q)) return true;
  // "go back further to 1940" / "go back to 1950" / "go back earlier"
  if (/\bgo(?:ing)?\s+(?:back\s+)?(?:further|farther|earlier)\b/i.test(q)) return true;
  if (/\bgo(?:ing)?\s+back\s+to\s+(?:17|18|19|20)\d{2}\b/i.test(q)) return true;
  // bare range shifts: "since 1995", "through 2020", "from 1990 to 2010"
  if (/\b(?:since|through|until|up\s+to)\s+(?:17|18|19|20)\d{2}\b/i.test(q)) return true;
  if (/\bfrom\s+(?:17|18|19|20)\d{2}\s+(?:to|through|-|–)\s*(?:17|18|19|20)\d{2}\b/i.test(q)) return true;
  return false;
}

function refersToGeographyChange(q: string): boolean {
  if (/^\s*(?:compare|vs\.?|versus)\b/i.test(q)) return true;
  if (/\bcompare\s+(?:(?:it|this|that|them)\s+)?(?:to|with|against)\b/i.test(q)) return true;
  if (/\b(?:make|show)\s+(?:it|this|that)\s+statewide\b/i.test(q)) return true;
  const whatAbout = q.match(/^\s*(?:what|how)\s+about\s+(.+?)\s*\??\s*$/i);
  if (whatAbout && !YEAR_RE.test(whatAbout[1]) &&
      resolveGeoPlaces(whatAbout[1]).mentions.length > 0) return true;
  return false;
}

const OFFENSE_NOUN_RE = /\b(?:murders?|homicides?|rapes?|robber(?:y|ies)|assaults?|burglar(?:y|ies)|thefts?|larcen(?:y|ies)|motor\s+vehicle\s+thefts?|carjackings?|shootings?|arsons?|violent\s+crimes?|property\s+crimes?|hate\s+crimes?)\b/i;

function refersToOffenseChange(q: string): boolean {
  return OFFENSE_NOUN_RE.test(q) &&
    /\b(?:instead|rather\s+than|switch(?:\s+(?:it|this|that))?\s+to|change\s+(?:it|this|that|the\s+offense)\s+to|now\s+show|make\s+it)\b/i.test(q);
}

function refersToMetricChange(q: string): boolean {
  const mentionsMetric =
    /\b(?:rates?|counts?|numbers?|totals?|per\s*capita|per\s*100,?000|per\s*100\s*k|percentages?|shares?)\b/i.test(q);
  if (!mentionsMetric) return false;
  return /\binstead\b|\brather\s+than\b|\bswitch\b|\bchange\s+(?:it|this|that)\b|\bmake\s+(?:it|this|that)\b/i.test(q) ||
    /\bshow\s+(?:the\s+)?(?:rates?|counts?|numbers?|totals?)\b/i.test(q);
}

function refersToGranularityChange(q: string): boolean {
  const mentionsGrain =
    /\b(?:monthly|annual(?:ly)?|yearly|quarterly|weekly|by\s+month|by\s+year|per\s+month|per\s+year|rolling\s+(?:12[\s-]*month\s+)?(?:average|window|sum|total)|12[\s-]*month\s+rolling)\b/i.test(q);
  if (!mentionsGrain) return false;
  return /\bmake\s+(?:it|this|that)\b|\binstead\b|\bswitch\b|\bchange\b|\bshow\s+(?:it|this|that)\b|\buse\b/i.test(q) ||
    /^\s*(?:monthly|annual(?:ly)?|yearly|quarterly|weekly)\b/i.test(q.trim());
}

function refersToBreakdownChange(q: string): boolean {
  return /\b(?:break(?:\s+(?:it|this|that))?\s+down|split(?:\s+(?:it|this|that))?(?:\s+out)?|group(?:\s+(?:it|this|that))?)\s+by\b/i.test(q);
}

function refersToChartChange(q: string): boolean {
  if (/\by[\s-]?axis\b/i.test(q)) return true;
  return /\b(?:line|bar|pie|stacked|scatter)\s*(?:chart|graph|plot)\b/i.test(q) &&
    /\bmake\s+(?:it|this|that)\b|\bchange\b|\bswitch\b|\bshow\s+.{0,20}\bas\s+a\b|\bas\s+a\b|\buse\b/i.test(q);
}

export function detectQueryBearingFollowup(
  question: string,
  rawHistory: unknown
): QueryBearingFollowup | null {
  if (!hasPriorSqlResult(rawHistory)) return null;
  if (asksCoverageNotChange(question)) return null;

  const kinds: FollowupChangeKind[] = [];
  if (refersToTimeRangeChange(question)) kinds.push("time_range");
  if (refersToGeographyChange(question)) kinds.push("geography");
  if (refersToOffenseChange(question)) kinds.push("offense");
  if (refersToMetricChange(question)) kinds.push("metric");
  if (refersToGranularityChange(question)) kinds.push("granularity");
  if (refersToBreakdownChange(question)) kinds.push("breakdown");
  if (refersToChartChange(question)) kinds.push("chart");

  return kinds.length > 0 ? { kinds } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-query-bearing-followup.ts`
Expected: PASS — `query-bearing-followup tests passed`. Iterate on regexes until every assertion holds; do not weaken assertions.

- [ ] **Step 5: Add the suite to the npm test chain**

In `package.json`, in the `test` script, insert `npx tsx scripts/test-query-bearing-followup.ts && ` immediately before `npx tsx scripts/test-followup-transform.ts`.

- [ ] **Step 6: Commit**

```bash
git add lib/query-bearing-followup.ts scripts/test-query-bearing-followup.ts package.json
git commit -m "Add shared query-bearing follow-up predicate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Widen `compare_geographies` to match "compare it to Dallas"

**Files:**
- Modify: `lib/followup-transform.ts:124` (the `comparisonTarget` regex)
- Test: `scripts/test-followup-transform.ts`

**Interfaces:**
- Consumes: nothing new. Produces: `detectFollowupTransform` now returns `compare_geographies` for "Compare it to Dallas." — Tasks 3-4 rely on the transform firing so the model path gets the comparison instruction after the bypass.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-followup-transform.ts` (before the final console.log), reusing an existing history fixture that contains prior SQL (e.g. the Atlanta/Dallas comparison fixture — pick any fixture whose assistant turn contains `SELECT ... FROM`):

```ts
{
  const t = detectFollowupTransform("Compare it to Dallas.", monthlyHoustonHistory);
  assert.ok(t, "compare it to <place> should be detected");
  assert.equal(t!.name, "compare_geographies");
  assert.match(t!.contextQuestion!, /Dallas/);
}
{
  const t = detectFollowupTransform("compare this with Fort Worth", monthlyHoustonHistory);
  assert.ok(t, "compare this with <place> should be detected");
  assert.equal(t!.name, "compare_geographies");
}
// pronoun-less form must keep working
{
  const t = detectFollowupTransform("compare to Dallas", monthlyHoustonHistory);
  assert.equal(t!.name, "compare_geographies");
}
// non-place targets must still return null
{
  assert.equal(detectFollowupTransform("compare it to last year", monthlyHoustonHistory), null);
}
```

(Adjust the fixture variable name to whatever the file actually declares for a prior-SQL history — read the file first; do not invent a fixture.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-followup-transform.ts`
Expected: FAIL on "compare it to <place> should be detected"

- [ ] **Step 3: Implement**

In `lib/followup-transform.ts:124`, change:

```ts
const comparisonTarget = question.match(/^\s*(?:compare\s+(?:to|with|against)|what about)\s+(.+?)\s*\??\s*$/i);
```

to:

```ts
const comparisonTarget = question.match(/^\s*(?:compare\s+(?:(?:it|this|that|them)\s+)?(?:to|with|against)|what about)\s+(.+?)\s*\??\s*$/i);
```

The `targetResolvesAsPlace` guard on the next line already rejects non-place targets like "last year".

- [ ] **Step 4: Run tests to verify pass**

Run: `npx tsx scripts/test-followup-transform.ts`
Expected: PASS (all existing assertions plus the new ones)

- [ ] **Step 5: Commit**

```bash
git add lib/followup-transform.ts scripts/test-followup-transform.ts
git commit -m "Match 'compare it to <place>' in the geography comparison follow-up

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Gate the /api/query (Current + Historical) shortcuts

**Files:**
- Modify: `app/api/query/route.ts` — import; county clarifier call (:473-475), historical place lookup skip (:277-280 helper or :667 call), metadata call (:707)

**Interfaces:**
- Consumes: `detectQueryBearingFollowup` from Task 1.
- Produces: no new exports; behavior change only.

- [ ] **Step 1: Add import and compute the predicate once**

Add to the imports at the top of `app/api/query/route.ts`:

```ts
import { detectQueryBearingFollowup } from "@/lib/query-bearing-followup";
```

(Match the file's existing import style — check whether it uses `@/lib/...` or relative `../../../lib/...` paths and copy that.)

Immediately after `const tab = body?.mode === "historical" ? "historical" : "current";` (line 432), add:

```ts
// Query-bearing follow-ups (prior SQL + a change request) must reach the
// model path with history — never the standalone metadata/county/place shortcuts.
const queryBearingFollowup = detectQueryBearingFollowup(question, body?.history);
```

- [ ] **Step 2: Gate the county clarifier (line 473-475)**

```ts
const countyScope = getBlockingGeoClarification(question) || queryBearingFollowup
  ? null
  : getCountyScopeClarification(question, body?.history);
```

CAREFUL with precedence: write it as

```ts
const countyScope = (getBlockingGeoClarification(question) || queryBearingFollowup)
  ? null
  : getCountyScopeClarification(question, body?.history);
```

- [ ] **Step 3: Gate the historical place lookup (line 667)**

```ts
const historicalPlace = tab === "historical" && !queryBearingFollowup && !shouldSkipHistoricalPlaceLookup(question, body?.history)
  ? answerHistoricalPlaceLookup(question, getDb())
  : null;
```

- [ ] **Step 4: Gate the metadata handler (line 707)**

```ts
const metadata = queryBearingFollowup ? null : answerMetadataQuestion(tab, question, getDb());
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors (run it before editing to capture the pre-existing baseline, if any).

- [ ] **Step 6: Commit**

```bash
git add app/api/query/route.ts
git commit -m "Bypass standalone shortcuts for query-bearing follow-ups in /api/query

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Gate the NIBRS, SHR, and Hate Crime route shortcuts

**Files:**
- Modify: `app/api/nibrs-query/route.ts` — county clarifier (:265), metadata (:397)
- Modify: `app/api/shr-query/route.ts` — county clarifier (:259), metadata (:279)
- Modify: `app/api/hc-query/route.ts` — county clarifier (:252), metadata (:272)

**Interfaces:**
- Consumes: `detectQueryBearingFollowup` from Task 1. Same gating idiom as Task 3.

- [ ] **Step 1: nibrs-query/route.ts**

Add the import (match existing style). After the capability override block (i.e. right before the `getBlockingGeoClarification` call at :245), add:

```ts
const queryBearingFollowup = detectQueryBearingFollowup(question, body?.history);
```

Gate county clarifier (:265):

```ts
const countyScope = queryBearingFollowup ? null : getCountyScopeClarification(question, body?.history);
```

Gate metadata (:397):

```ts
const metadata = queryBearingFollowup ? null : answerMetadataQuestion("nibrs", question, getNibrsDb());
```

Do NOT touch `planNibrsQuery`/`allowDeterministic` — it is already follow-up-aware via `detectFollowupTransform`.

- [ ] **Step 2: shr-query/route.ts**

Same three edits (import; predicate const after the history/`followupTransform` block around :160; county gate at :259; metadata gate at :279 with `answerMetadataQuestion("shr", ...)`). Leave the nonfatal refusal and deterministic shooting path untouched.

- [ ] **Step 3: hc-query/route.ts**

Same three edits (import; predicate const after :155; county gate at :252; metadata gate at :272 with `answerMetadataQuestion("hate_crime", ...)`).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/nibrs-query/route.ts app/api/shr-query/route.ts app/api/hc-query/route.ts
git commit -m "Bypass standalone shortcuts for query-bearing follow-ups in NIBRS/SHR/HC routes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Router golden-suite coverage for the regression phrases

**Files:**
- Modify: `scripts/test-router.ts` (Section 6, follow-up detection, starts ~line 345)

- [ ] **Step 1: Read section 6 and add any of the six regression phrases not already present** as `test({ question: "...", expectedPrimary: "current", expectFollowUp: true, note: "query-bearing follow-up — must never be answered as standalone metadata" })`. (`expectedPrimary` is ignored when `expectFollowUp: true` — the runner returns early — but the field is required by the TestCase shape; follow the section's existing convention.)

- [ ] **Step 2: Run**

Run: `npx tsx scripts/test-router.ts`
Expected: PASS with a count ≥ 211.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-router.ts
git commit -m "Cover query-bearing follow-up regression phrases in router golden suite

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Full-suite verification + end-to-end check

- [ ] **Step 1: Full offline gate**

Run: `npm test` (from repo root; takes ~2-4 min; do not pipe through `tail` — it has blown wrapper timeouts).
Expected: exit 0, all 39+1 suites green.

- [ ] **Step 2: Multi-turn session replay (offline router-level)**

Run: `npx tsx scripts/test-session-replay.ts`
Expected: **68/71 or better** — the same 3 pre-existing failures at most, no new ones. Record the pass count.

- [ ] **Step 3: End-to-end reproduction of the Minnesota bug (live local, historical tab works locally)**

Requires `ANTHROPIC_API_KEY` available to the dev server (check `.env.local`). If no key is available locally, mark this step SKIPPED and note it in the final report — the deterministic interception fix is still fully covered by Steps 1-2 plus the probe below.

```bash
npm run dev &   # port 3000
# after it's up:
npx tsx scripts/_probe-e2e-stage1.ts
```

Write `scripts/_probe-e2e-stage1.ts` (temporary, delete after): POST to `http://localhost:3000/api/query` with `{ question: "Can you change the start year to 1988?", mode: "historical", history: [user Minnesota question, assistant with "[SQL: SELECT ...]"], pageToken: <fetch from /api/page-token> }` and assert the SSE response is NOT the "Historical Coverage" metadata result (its explanation starts with "Historical Library year coverage:"). Before the fix this returned coverage metadata; after, it must go to the model path.

- [ ] **Step 4: Delete temporary probe scripts**

```bash
rm -f scripts/_probe-followup.ts scripts/_probe-e2e-stage1.ts
```

- [ ] **Step 5: Final report**

Report: suites run + results, session-replay count vs 68/71 baseline, e2e result (or SKIPPED + why). Do NOT push or deploy — Jeff decides that separately (feedback_never_deploy_main_without_checking).

---

## Self-Review (done at planning time)

- **Spec coverage:** shared predicate (Task 1); bypass before metadata/place/county handlers in all routes (Tasks 3-4); the six regressions + genuine-metadata negative (Task 1 tests, Task 5 router coverage, Task 6 e2e); "source, geography, offense, metric, and existing comparison branches survive" = `npm test` (router 211, followup-transform, contract corpus 86, layer-3) in Task 6. Comparison-branch gap found during probing ("compare it to") fixed in Task 2.
- **Deliberately out of Stage 1 scope** (documented in Global Constraints): geo clarifier, year availability, capability overrides, SHR shooting path — probes show none intercept the regression phrases; touching them belongs to Stage 2's planner.
- **Type consistency:** single exported function + one interface, consumed identically in 4 routes.
