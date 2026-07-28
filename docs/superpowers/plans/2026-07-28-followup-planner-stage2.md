# Stage 2: Shared Follow-Up Planner — Implementation Plan

> **For agentic workers (Codex):** Implement task-by-task, in order. Each task ends with a runnable verification. Steps use checkbox (`- [ ]`) syntax for tracking. Do not start until Stage 1 (commits c915e2c..1822962) is deployed and `live-replay --quick` / `--sessions` have been run against production.

**Goal:** One typed planner, consulted by every source route, that reconstructs a follow-up into a complete question, identifies the requested change, preserves everything not changed, re-resolves geography/source, and decides deterministic-builder eligibility — replacing today's per-route ad-hoc follow-up handling. Rolls out in compare-logging mode first, then authoritative per source.

**Architecture:** `lib/followup-planner.ts` wraps the Stage 1 predicate (`lib/query-bearing-followup.ts`) + the existing transform detector (`lib/followup-transform.ts`) + contract builder + client router (`autoRoute`) into one `FollowupPlan`. Routes read a mode flag (`off | compare | authoritative` per source) from env. In `compare` mode the plan is computed and logged but legacy behavior is byte-identical. In `authoritative` mode the plan gates standalone handlers, feeds the reconstructed question to geo clarification/guardrails/contract, and disables deterministic builders for query-bearing follow-ups.

**Tech Stack:** TypeScript, Next.js 16 API routes, node:assert/strict test scripts via `npx tsx` (no test framework in this repo).

## Global Constraints

- Repo `C:\Users\jeffm\crime-data-assistant`, branch `dev`. Never touch `master`.
- **Model retry behavior must remain unchanged** (refusal retries, issue-fix retries, second-failure blocks) — Jeff's spec, verbatim: "Keep model retry behavior unchanged until planner routing is stable."
- With `FOLLOWUP_PLANNER_MODE` unset or `off`, every route must behave **byte-identically** to Stage 1 (the legacy path stays; the planner code must be side-effect-free when off).
- Follow-ups never silently switch source (acceptance invariant). A source switch is always surfaced: the server returns an explicit switch response and the client resubmits visibly (Task 9).
- Baselines that must not regress: `npm test` green (40 suites, offline, ~2-4 min — do NOT pipe through `tail`, it has blown wrapper timeouts); `npx tsx scripts/test-router.ts` = 217/217; `npx tsx scripts/test-session-replay.ts` = 68/71 (3 pre-existing failures listed in its output — no new ones).
- Local DB reality (Windows dev box): `crime_data.db` (509 MB) and `hate_crime.db` and `query_log.db` are real; **`nibrs.db` and `shr.db` are 0-byte stubs** — never write a test that executes SQL against them; use `:memory:` seeding (see `scripts/test-shr-place-resolver.ts` and `scripts/test-nibrs-place-resolver.ts` for the pattern).
- Commit per task. Only stage files the task touches (the worktree has unrelated modified/untracked files). Commit messages end with the implementing agent's standard co-author line.

## Context: what exists today (verified 2026-07-28)

- **Stage 1 predicate:** `lib/query-bearing-followup.ts` — `detectQueryBearingFollowup(question, rawHistory)` → `{ kinds: FollowupChangeKind[] } | null`. Fires only when raw history has an assistant turn matching `/\bSELECT\b[\s\S]+\bFROM\b/i` AND the message requests a change (time_range | geography | offense | metric | granularity | breakdown | chart). Coverage phrasings ("how far back...") excluded.
- **Transforms:** `lib/followup-transform.ts` — `detectFollowupTransform(question, history)` returns `FollowupTransform { name, dimension?, instruction, contextQuestion? }` for: resolve_county_scope, compare_geographies, replace_rate_with_count, replace_with_dv_victim_demographics, assess_trend, add_continuous_reporting_filter, add_breakdown. `hasPriorSql` and `latestPriorUserQuestion` are private helpers in that file. **No transform exists for time-range, granularity, offense-switch, or count→rate changes.**
- **Route wiring (identical shape):** each route computes `history = normalizeHistoryForTab(body?.history, tab)`, `followupTransform = detectFollowupTransform(question, history)`, `guardrailQuestion = followupTransform?.contextQuestion ?? question`, `promptHistory = history + [{role:"user", content: followupTransform.instruction}]`. Locations: `app/api/query/route.ts` (~:814), `app/api/nibrs-query/route.ts` (~:289), `app/api/shr-query/route.ts` (~:145), `app/api/hc-query/route.ts` (~:155).
- **Stage 1 gates:** each route computes `queryBearingFollowup = detectQueryBearingFollowup(question, body?.history)` and skips `answerMetadataQuestion` + `getCountyScopeClarification` (and in /api/query also `answerHistoricalPlaceLookup`) when non-null.
- **NIBRS typed planner (the model for this work):** `lib/nibrs-query-planner.ts` — `planNibrsQuery(question, resolutionPlan, {allowDeterministic})`; the route passes `allowDeterministic: !followupTransform` and nulls the resolution plan for follow-ups (`app/api/nibrs-query/route.ts:307-309, :293`).
- **Known traps:**
  - `app/api/hc-query/route.ts:182-188` passes the RAW `question` (not `guardrailQuestion`) to `validateQueryContractSql` — a pre-existing gap fixed by Task 8.
  - The county clarifier (`lib/county-clarifier.ts:34`) reads RAW `body?.history`; transforms read NORMALIZED history. The planner takes raw history and normalizes internally.
  - Chart-only follow-ups normally never reach the server — `components/WorkspaceChatV2.tsx:261-288` handles them client-side via `applyChartOnlyCustomization`. The planner still flags them for the rare server-reaching case.
  - The SHR deterministic fatal-shooting path (`app/api/shr-query/route.ts:316-537`) fires on raw-question shooting words and would hijack a query-bearing follow-up that mentions shootings ("compare it to Dallas shootings") — gated in Task 7.
  - Two near-duplicate continuous-reporter regex sets exist (`lib/followup-transform.ts:106` and `app/api/nibrs-query/route.ts:116`) — do NOT consolidate in this plan; note only.
  - `autoRoute` (`lib/tab-suggest.ts:1057`) returns null for follow-ups (`isFollowUp` check at :1060) — the planner therefore calls it on the RECONSTRUCTED question, which is a complete question.
  - Louisville succession: `SUCCESSION_CHAINS` in `lib/shr-place-resolver.ts:79-81` (KY05602/KY05680, 2003 boundary). Campus resolution: `lib/nibrs-campus-agency.ts` + `kind: "campus"` in `lib/nibrs-place-resolver.ts`.

---

### Task 1: Widen `FollowupTransform` and export the reconstruction helpers

**Files:**
- Modify: `lib/followup-transform.ts`
- Test: `scripts/test-followup-transform.ts` (existing — must stay green)

**Interfaces:**
- Produces: `FollowupTransform.name` union widened with `"change_time_range" | "change_granularity" | "change_offense" | "replace_count_with_rate"`; `hasPriorSql(history)` and `latestPriorUserQuestion(history)` exported. Consumed by Task 4.

- [ ] **Step 1:** In `lib/followup-transform.ts`, change the `name` union (line ~8) to:

```ts
  name: "add_breakdown" | "add_continuous_reporting_filter" | "replace_with_dv_victim_demographics" | "replace_rate_with_count" | "resolve_county_scope" | "assess_trend" | "compare_geographies" | "change_time_range" | "change_granularity" | "change_offense" | "replace_count_with_rate";
```

- [ ] **Step 2:** Add `export` to `function hasPriorSql(...)` (line ~77) and `function latestPriorUserQuestion(...)` (line ~81). No behavior change.

- [ ] **Step 3:** Run `npx tsx scripts/test-followup-transform.ts` and `npx tsc --noEmit`. Expected: both clean.

- [ ] **Step 4:** Commit: `Widen FollowupTransform for planner-synthesized transforms`

---

### Task 2: Teach the Stage 1 predicate "what about <offense>?"

**Files:**
- Modify: `lib/query-bearing-followup.ts`
- Test: `scripts/test-query-bearing-followup.ts`

**Interfaces:**
- Produces: `OFFENSE_NOUN_RE` exported; "what about carjackings?" (with prior SQL) → `kinds: ["offense"]`. Consumed by Task 4's source re-resolution (SHR→NIBRS scenario).

- [ ] **Step 1: Write the failing tests** (append to `scripts/test-query-bearing-followup.ts` before the final console.log):

```ts
// Offense-swap follow-ups via "what about ..."
assert.deepEqual(kinds("what about carjackings?", priorSqlHistory), ["offense"]);
assert.deepEqual(kinds("what about aggravated assaults", priorSqlHistory), ["offense"]);
// "what about <place>" must remain geography, not offense
assert.deepEqual(kinds("what about Dallas?", priorSqlHistory), ["geography"]);
// "what about 2020?" stays time-range only (year target)
assert.deepEqual(kinds("what about since 1995?", priorSqlHistory), ["time_range"]);
```

- [ ] **Step 2:** Run `npx tsx scripts/test-query-bearing-followup.ts` — expected FAIL on the carjackings line.

- [ ] **Step 3:** In `lib/query-bearing-followup.ts`: export `OFFENSE_NOUN_RE` (add `export` before `const OFFENSE_NOUN_RE`), and extend `refersToOffenseChange`:

```ts
function refersToOffenseChange(q: string): boolean {
  const whatAbout = q.match(/^\s*(?:what|how)\s+about\s+(.+?)\s*\??\s*$/i);
  if (whatAbout && OFFENSE_NOUN_RE.test(whatAbout[1]) &&
      resolveGeoPlaces(whatAbout[1]).mentions.length === 0) return true;
  return OFFENSE_NOUN_RE.test(q) &&
    /\binstead\b|\brather\s+than\b|\bswitch(?:\s+(?:it|this|that))?\s+to\b|\bchange\s+(?:it|this|that|the\s+offense)\s+to\b|\bnow\s+show\b|\bmake\s+it\b/i.test(q);
}
```

- [ ] **Step 4:** Run the suite — expected PASS (all assertions, including the pre-existing ones).

- [ ] **Step 5:** Commit: `Detect offense-swap follow-ups ("what about carjackings?")`

---

### Task 3: Mode flag `lib/followup-planner-mode.ts`

**Files:**
- Create: `lib/followup-planner-mode.ts`
- Test: `scripts/test-followup-planner-mode.ts` (add to `package.json` `test` chain, before the planner suite Task 4 adds)

**Interfaces:**
- Produces: `plannerModeForSource(source: SourceId): "off" | "compare" | "authoritative"`. Env contract: `FOLLOWUP_PLANNER_MODE` = `off` (default) | `compare` | `authoritative`; when `authoritative`, `FOLLOWUP_PLANNER_SOURCES` is a comma list of SourceIds that get authoritative routing — every other source gets `compare`.

- [ ] **Step 1: Failing test:**

```ts
// scripts/test-followup-planner-mode.ts
import assert from "node:assert/strict";
import { plannerModeForSource } from "../lib/followup-planner-mode";

delete process.env.FOLLOWUP_PLANNER_MODE;
assert.equal(plannerModeForSource("nibrs"), "off");
process.env.FOLLOWUP_PLANNER_MODE = "compare";
assert.equal(plannerModeForSource("nibrs"), "compare");
assert.equal(plannerModeForSource("historical"), "compare");
process.env.FOLLOWUP_PLANNER_MODE = "authoritative";
process.env.FOLLOWUP_PLANNER_SOURCES = "nibrs,historical";
assert.equal(plannerModeForSource("nibrs"), "authoritative");
assert.equal(plannerModeForSource("historical"), "authoritative");
assert.equal(plannerModeForSource("shr"), "compare");
process.env.FOLLOWUP_PLANNER_MODE = "bogus";
assert.equal(plannerModeForSource("nibrs"), "off");
delete process.env.FOLLOWUP_PLANNER_MODE;
delete process.env.FOLLOWUP_PLANNER_SOURCES;
console.log("followup-planner-mode tests passed");
```

- [ ] **Step 2:** Implementation:

```ts
// lib/followup-planner-mode.ts
import type { SourceId } from "./source-contracts";

export type FollowupPlannerMode = "off" | "compare" | "authoritative";

/** Read the mode per request (env can change between deploys/PM2 restarts). */
export function plannerModeForSource(source: SourceId): FollowupPlannerMode {
  const mode = (process.env.FOLLOWUP_PLANNER_MODE ?? "off").trim().toLowerCase();
  if (mode === "compare") return "compare";
  if (mode === "authoritative") {
    const sources = (process.env.FOLLOWUP_PLANNER_SOURCES ?? "")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return sources.includes(source) ? "authoritative" : "compare";
  }
  return "off";
}
```

- [ ] **Step 3:** Run the test (PASS), add it to `package.json` `test` chain immediately before `scripts/test-query-bearing-followup.ts`, run `npx tsc --noEmit`.

- [ ] **Step 4:** Commit: `Add follow-up planner mode flag (off/compare/authoritative per source)`

---

### Task 4: The planner — `lib/followup-planner.ts`

**Files:**
- Create: `lib/followup-planner.ts`
- Test: `scripts/test-followup-planner.ts` (add to `package.json` `test` chain after the mode test)

**Interfaces:**
- Consumes: Tasks 1-2 exports; `normalizeHistoryForTab` (lib/chat-history), `buildQueryContract` (lib/query-contract — check its exact exported type name for the contract object and use that), `autoRoute`, `parseIntent` (lib/tab-suggest), `isChartTypeOnlyRequest`, `isYAxisDomainOnlyRequest` (lib/chart-customization), `SourceId` (lib/source-contracts).
- Produces (consumed by Tasks 5-9):

```ts
export interface FollowupPlan {
  kind: "not_followup" | "query_bearing";
  /** Source that should run the reconstructed question. Equals currentSource unless sourceChanged. */
  source: SourceId;
  sourceChanged: boolean;
  /** Complete question for geo clarification, place resolution, guardrails, contract. */
  reconstructedQuestion: string;
  priorQuestion: string | null;
  changeKinds: FollowupChangeKind[];
  /** Existing or planner-synthesized transform; instruction goes into promptHistory as today. */
  transform: FollowupTransform | null;
  /** Scope (geography) + metric of the reconstructed question — the spec's "scope" and "metric"
   *  fields. Built with buildQueryContract(reconstructedQuestion, source); null for passthrough. */
  contract: ReturnType<typeof buildQueryContract> | null;
  timeRange: { startYear: number | null; endYear: number | null };
  granularity: "monthly" | "annual" | "unspecified";
  chartOnly: boolean;
  /** Mirrors today's allowDeterministic: !followupTransform, extended to all query-bearing follow-ups. */
  deterministicEligible: boolean;
  /** True only when standalone handlers (metadata / place lookup / county clarifier) may run. */
  standaloneEligible: boolean;
}
export function planFollowup(question: string, rawHistory: unknown, currentSource: SourceId): FollowupPlan
```

- [ ] **Step 1: Write the failing test.** Full file — every scenario from the spec:

```ts
// scripts/test-followup-planner.ts
import assert from "node:assert/strict";
import { planFollowup } from "../lib/followup-planner";

function hist(userQ: string, assistantSql: string, source: string) {
  return [
    { role: "user", content: userQ, source },
    { role: "assistant", content: `Here you go.\n[SQL: ${assistantSql}]`, source },
  ];
}

// 1. Historical Minnesota vs national rates → change the start year
{
  const h = hist(
    "Compare murder rates in Minnesota to the national rate since 1985",
    "SELECT year, state, murder_rate FROM historical_state_national WHERE state IN ('Minnesota','United States') AND year >= 1985",
    "historical");
  const p = planFollowup("Can you change the start year to 1988?", h, "historical");
  assert.equal(p.kind, "query_bearing");
  assert.deepEqual(p.changeKinds, ["time_range"]);
  assert.equal(p.source, "historical");
  assert.equal(p.sourceChanged, false);
  assert.match(p.reconstructedQuestion, /Minnesota/);
  assert.match(p.reconstructedQuestion, /1988/);
  assert.equal(p.standaloneEligible, false);
  assert.equal(p.deterministicEligible, false);
  assert.ok(p.transform, "planner must synthesize a time-range transform");
  assert.equal(p.transform!.name, "change_time_range");
  assert.match(p.transform!.instruction, /preserve/i);
}

// 2. Monthly Houston murders → rolling window
{
  const h = hist(
    "monthly murders in Houston since 2021",
    "SELECT am.year, am.month, am.count FROM agency_monthly am WHERE am.agency = 'Houston' AND am.state = 'TX' AND am.offense = 'Murder' AND am.year >= 2021",
    "current");
  const p = planFollowup("make it a rolling 12-month window", h, "current");
  assert.equal(p.kind, "query_bearing");
  assert.ok(p.changeKinds.includes("granularity"));
  assert.equal(p.source, "current");
  assert.equal(p.sourceChanged, false);
  assert.match(p.reconstructedQuestion, /Houston/);
  assert.equal(p.deterministicEligible, false, "rolling-window follow-up must not hit deterministic builders");
  assert.equal(p.transform!.name, "change_granularity");
}

// 3. Houston SHR query → "compare to Dallas"
{
  const h = hist(
    "firearm homicides in Houston since 2015",
    "SELECT i.year, COUNT(*) FROM incidents i WHERE i.weapon_group = 'Firearm' AND i.year >= 2015 GROUP BY i.year",
    "shr");
  const p = planFollowup("compare to Dallas", h, "shr");
  assert.equal(p.kind, "query_bearing");
  assert.deepEqual(p.changeKinds, ["geography"]);
  assert.equal(p.transform!.name, "compare_geographies");
  assert.equal(p.source, "shr", "geography comparison must not switch source");
  assert.equal(p.sourceChanged, false);
  assert.match(p.reconstructedQuestion, /Houston/);
  assert.match(p.reconstructedQuestion, /Dallas/);
  assert.ok(p.contract, "plan must carry the contract (scope + metric) of the reconstructed question");
}

// 4. City query → statewide comparison
{
  const h = hist(
    "robberies in Baltimore since 2018",
    "SELECT year, SUM(count) FROM agency_monthly WHERE agency = 'Baltimore' GROUP BY year",
    "current");
  const p = planFollowup("how does that compare to Maryland statewide?", h, "current");
  assert.equal(p.kind, "query_bearing");
  assert.ok(p.changeKinds.includes("geography"));
  assert.equal(p.sourceChanged, false);
  assert.match(p.reconstructedQuestion, /Baltimore/);
  assert.match(p.reconstructedQuestion, /Maryland/i);
}

// 5a. County-scope clarifier answer flows through (resolve_county_scope preserved)
{
  const h = [
    { role: "user", content: "show violent crime in Cook County, IL", source: "nibrs" },
    { role: "assistant", content: "For Cook County, do you want the countywide total (all law enforcement agencies mapped to Cook County, summed) or the sheriff's office only? Choose: Countywide total or Sheriff's office only.", source: "nibrs" },
  ];
  const p = planFollowup("Countywide total", h, "nibrs");
  assert.equal(p.kind, "query_bearing");
  assert.equal(p.transform!.name, "resolve_county_scope");
  assert.match(p.reconstructedQuestion, /Cook County/);
  assert.equal(p.standaloneEligible, false);
}

// 5b. Campus follow-up keeps campus context
{
  const h = hist(
    "violent crime at Ohio State University since 2018",
    "SELECT year, SUM(victim_count) FROM summary_victim_city_monthly WHERE ori = 'OHOSU000' GROUP BY year",
    "nibrs");
  const p = planFollowup("Make it monthly.", h, "nibrs");
  assert.equal(p.kind, "query_bearing");
  assert.match(p.reconstructedQuestion, /Ohio State/);
  assert.equal(p.source, "nibrs");
  assert.equal(p.deterministicEligible, false);
}

// 6. Louisville across the 2003 succession boundary — reconstruction preserves the city+range
{
  const h = hist(
    "murders in Louisville, KY from 1995 to 2010",
    "SELECT i.year, COUNT(*) FROM incidents i WHERE i.ori IN ('KY05602','KY05680') GROUP BY i.year",
    "shr");
  const p = planFollowup("extend it through 2015", h, "shr");
  assert.equal(p.kind, "query_bearing");
  assert.deepEqual(p.changeKinds, ["time_range"]);
  assert.match(p.reconstructedQuestion, /Louisville/);
  assert.match(p.reconstructedQuestion, /2015/);
  assert.equal(p.source, "shr");
}

// 7. Chart-only follow-up: flagged, not standalone-eligible, no geography change
{
  const h = hist(
    "murder trend in Phoenix",
    "SELECT year, SUM(count) FROM agency_monthly WHERE agency = 'Phoenix' GROUP BY year",
    "current");
  const p = planFollowup("make it a pie chart", h, "current");
  assert.equal(p.kind, "query_bearing");
  assert.equal(p.chartOnly, true);
  assert.equal(p.standaloneEligible, false);
  assert.equal(p.changeKinds.includes("geography"), false);
}

// 8. Source-switching follow-up: SHR → NIBRS
{
  const h = hist(
    "firearm homicides in Houston since 2015",
    "SELECT i.year, COUNT(*) FROM incidents i WHERE i.weapon_group = 'Firearm' GROUP BY i.year",
    "shr");
  const p = planFollowup("what about carjackings?", h, "shr");
  assert.equal(p.kind, "query_bearing");
  assert.ok(p.changeKinds.includes("offense"));
  assert.equal(p.source, "nibrs", "carjacking is NIBRS-only — planner must re-route from the reconstructed question");
  assert.equal(p.sourceChanged, true);
  assert.match(p.reconstructedQuestion, /carjacking/i);
  assert.match(p.reconstructedQuestion, /Houston/);
}

// 9. Genuine standalone metadata question → passthrough
{
  const h = hist(
    "murder trend in Phoenix",
    "SELECT year, SUM(count) FROM agency_monthly WHERE agency = 'Phoenix' GROUP BY year",
    "current");
  const p = planFollowup("What years does the data cover?", h, "current");
  assert.equal(p.kind, "not_followup");
  assert.equal(p.standaloneEligible, true);
  assert.equal(p.deterministicEligible, true);
  assert.equal(p.reconstructedQuestion, "What years does the data cover?");
}

// 9b. Brand-new question with no history → passthrough
{
  const p = planFollowup("murders in Chicago in 2020", [], "current");
  assert.equal(p.kind, "not_followup");
  assert.equal(p.standaloneEligible, true);
}

// Preservation invariant: rate metric preserved when only time changes
{
  const h = hist(
    "Compare murder rates in Minnesota to the national rate since 1985",
    "SELECT year, state, murder_rate FROM historical_state_national WHERE state IN ('Minnesota','United States') AND year >= 1985",
    "historical");
  const p = planFollowup("Go back further to 1940.", h, "historical");
  assert.match(p.reconstructedQuestion, /rates?/i, "metric must be preserved from the prior question");
  assert.match(p.reconstructedQuestion, /Minnesota/);
}

console.log("followup-planner tests passed");
```

- [ ] **Step 2:** Run it — expected FAIL (module missing).

- [ ] **Step 3: Implementation.**

```ts
// lib/followup-planner.ts
import { normalizeHistoryForTab } from "./chat-history";
import {
  detectFollowupTransform,
  hasPriorSql,
  latestPriorUserQuestion,
  type FollowupTransform,
} from "./followup-transform";
import {
  detectQueryBearingFollowup,
  type FollowupChangeKind,
} from "./query-bearing-followup";
import { buildQueryContract } from "./query-contract";
import { autoRoute, parseIntent } from "./tab-suggest";
import { isChartTypeOnlyRequest, isYAxisDomainOnlyRequest } from "./chart-customization";
import type { SourceId } from "./source-contracts";

export interface FollowupPlan {
  kind: "not_followup" | "query_bearing";
  source: SourceId;
  sourceChanged: boolean;
  reconstructedQuestion: string;
  priorQuestion: string | null;
  changeKinds: FollowupChangeKind[];
  transform: FollowupTransform | null;
  contract: ReturnType<typeof buildQueryContract> | null;
  timeRange: { startYear: number | null; endYear: number | null };
  granularity: "monthly" | "annual" | "unspecified";
  chartOnly: boolean;
  deterministicEligible: boolean;
  standaloneEligible: boolean;
}

function passthrough(question: string, source: SourceId): FollowupPlan {
  return {
    kind: "not_followup",
    source,
    sourceChanged: false,
    reconstructedQuestion: question,
    priorQuestion: null,
    changeKinds: [],
    transform: null,
    contract: null,
    timeRange: { startYear: null, endYear: null },
    granularity: "unspecified",
    chartOnly: false,
    deterministicEligible: true,
    standaloneEligible: true,
  };
}

/** Planner-synthesized transforms for change kinds the legacy detector misses. */
function synthesizeTransform(
  kinds: FollowupChangeKind[],
  question: string,
  priorQuestion: string,
): FollowupTransform | null {
  const reconstructed = `${priorQuestion} (${question.trim().replace(/\s+/g, " ")})`;
  const preserve =
    "Preserve the prior query's dataset, geography, offense/topic, filters, metric, and chart intent unless the user explicitly changes them. Do not ask for clarification and do not answer with coverage metadata.";
  if (kinds.includes("time_range")) {
    return {
      name: "change_time_range",
      contextQuestion: reconstructed,
      instruction: `[SYSTEM: This follow-up changes ONLY the time range of the prior question "${priorQuestion}". Apply the new range from "${question}". ${preserve}]`,
    };
  }
  if (kinds.includes("granularity")) {
    return {
      name: "change_granularity",
      contextQuestion: reconstructed,
      instruction: `[SYSTEM: This follow-up changes ONLY the time granularity/windowing of the prior question "${priorQuestion}" as requested by "${question}" (e.g. monthly vs annual, or a rolling 12-month window over monthly rows). ${preserve}]`,
    };
  }
  if (kinds.includes("offense")) {
    return {
      name: "change_offense",
      contextQuestion: reconstructed,
      instruction: `[SYSTEM: This follow-up changes ONLY the offense/topic of the prior question "${priorQuestion}" as requested by "${question}". Preserve the prior geography, time range, metric, and granularity.]`,
    };
  }
  if (kinds.includes("metric")) {
    return {
      name: "replace_count_with_rate",
      contextQuestion: reconstructed,
      instruction: `[SYSTEM: This follow-up changes ONLY the metric of the prior question "${priorQuestion}" as requested by "${question}" (e.g. counts to rates per 100,000 with the source's population denominator, or rates to raw counts). Preserve the prior geography, offense/topic, and time range.]`,
    };
  }
  if (kinds.includes("breakdown") || kinds.includes("geography") || kinds.includes("chart")) {
    // geography/breakdown normally handled by detectFollowupTransform; chart-only needs no instruction
    return null;
  }
  return null;
}

export function planFollowup(
  question: string,
  rawHistory: unknown,
  currentSource: SourceId,
): FollowupPlan {
  const history = normalizeHistoryForTab(rawHistory, currentSource);
  const transform = detectFollowupTransform(question, history);
  const bearing = detectQueryBearingFollowup(question, rawHistory);
  const chartOnly =
    (isChartTypeOnlyRequest(question) || isYAxisDomainOnlyRequest(question)) &&
    hasPriorSql(history);

  if (!transform && !bearing && !chartOnly) return passthrough(question, currentSource);

  const priorQuestion = latestPriorUserQuestion(history);
  const changeKinds = bearing?.kinds ?? [];
  const effectiveTransform =
    transform ??
    (priorQuestion ? synthesizeTransform(changeKinds, question, priorQuestion) : null);
  const reconstructedQuestion =
    effectiveTransform?.contextQuestion ??
    (priorQuestion ? `${priorQuestion} (${question.trim()})` : question);

  // Re-resolve source from the COMPLETE reconstructed question. Only an
  // explicit offense/breakdown change may move the source — geography, time,
  // metric, granularity, and chart changes always keep the prior source.
  let source = currentSource;
  let sourceChanged = false;
  const mayNeedNewSource =
    changeKinds.includes("offense") || changeKinds.includes("breakdown");
  if (mayNeedNewSource) {
    const route = autoRoute(reconstructedQuestion);
    if (route && route.confidence === "high" && route.source !== currentSource) {
      source = route.source;
      sourceChanged = true;
    }
  }

  const contract = buildQueryContract(reconstructedQuestion, source);
  const intent = parseIntent(reconstructedQuestion);

  return {
    kind: "query_bearing",
    source,
    sourceChanged,
    reconstructedQuestion,
    priorQuestion,
    changeKinds,
    transform: effectiveTransform,
    contract,
    timeRange: {
      startYear: contract?.time?.startYear ?? null,
      endYear: contract?.time?.endYear ?? null,
    },
    granularity: intent.granularity,
    chartOnly,
    deterministicEligible: false,
    standaloneEligible: false,
  };
}
```

Notes for the implementer:
- Check the exact shape `buildQueryContract` returns (`lib/query-contract.ts`; `contract.time.startYear/endYear` is asserted by `scripts/test-query-contract.ts`) and the exact `parseIntent` return field (`granularity` per `QueryIntent` at `lib/tab-suggest.ts:74`). Adjust property access if names differ — do not guess; read the source.
- If scenario 8 fails because `autoRoute("firearm homicides in Houston since 2015 (what about carjackings?)")` is not high-confidence NIBRS: reconstruct offense swaps by REPLACING the offense noun instead of appending — take `priorQuestion.replace(OFFENSE_NOUN_RE, <new offense>)` (import `OFFENSE_NOUN_RE` from `./query-bearing-followup`, match the new offense from the follow-up text). Use that as `contextQuestion` for `change_offense` and re-run `autoRoute`. Verify with the test; keep whichever reconstruction makes the router confident.
- `chartOnly` requires `hasPriorSql` so a first question like "make me a pie chart of murders by state" is not misclassified.

- [ ] **Step 4:** Run `npx tsx scripts/test-followup-planner.ts` until PASS. Then `npx tsx scripts/test-query-bearing-followup.ts`, `npx tsx scripts/test-followup-transform.ts`, `npx tsc --noEmit` — all clean.

- [ ] **Step 5:** Add the suite to `package.json` `test` right after `scripts/test-followup-planner-mode.ts`. Commit: `Add shared typed follow-up planner`

---

### Task 5: Wire /api/query (Current + Historical) to the planner

**Files:**
- Modify: `app/api/query/route.ts`

**Interfaces:**
- Consumes: `planFollowup`, `plannerModeForSource`. The route's `tab` variable is the SourceId ("current" | "historical").

- [ ] **Step 1:** After the Stage 1 predicate line (`const queryBearingFollowup = detectQueryBearingFollowup(question, body?.history);` ~line 435), add:

```ts
const plannerMode = plannerModeForSource(tab);
const followupPlan = plannerMode === "off" ? null : planFollowup(question, body?.history, tab);
if (followupPlan && plannerMode === "compare") {
  console.log(`[followup-planner][compare] ${JSON.stringify({
    source: tab,
    kind: followupPlan.kind,
    changeKinds: followupPlan.changeKinds,
    plannedSource: followupPlan.source,
    sourceChanged: followupPlan.sourceChanged,
    legacyBearing: Boolean(queryBearingFollowup),
    q: question.slice(0, 160),
    reconstructed: followupPlan.reconstructedQuestion.slice(0, 200),
  })}`);
}
const planSaysQueryBearing = plannerMode === "authoritative"
  ? followupPlan!.kind === "query_bearing"
  : Boolean(queryBearingFollowup);
```

- [ ] **Step 2:** Replace the three Stage 1 gate conditions (`queryBearingFollowup` in the county clarifier ternary at ~:477, the historical place lookup at ~:671, the metadata call at ~:711) with `planSaysQueryBearing`. In compare/off mode this is the same boolean as Stage 1 — byte-identical behavior.

- [ ] **Step 3 (authoritative only): geography re-resolution + chart-only invariant.** Change the blocking geo clarification (~:513) so authoritative mode evaluates the reconstructed question and chart-only skips it entirely:

```ts
const geoClarification = (plannerMode === "authoritative" && followupPlan!.kind === "query_bearing")
  ? (followupPlan!.chartOnly ? null : getBlockingGeoClarification(followupPlan!.reconstructedQuestion))
  : getBlockingGeoClarification(question);
```

Also update the county-clarifier gate's inner `getBlockingGeoClarification(question)` call (~:477) to reuse this `geoClarification` variable instead of re-calling (move the `geoClarification` const ABOVE the county block; it is currently below — keep the emitted responses identical).

- [ ] **Step 4 (authoritative only): guardrail question + prompt instruction.** Inside the stream (~:814), where `followupTransform`/`guardrailQuestion`/`promptHistory` are computed, override when authoritative:

```ts
const followupTransform = (plannerMode === "authoritative" && followupPlan)
  ? followupPlan.transform
  : detectFollowupTransform(question, history);
const guardrailQuestion = (plannerMode === "authoritative" && followupPlan && followupPlan.kind === "query_bearing")
  ? followupPlan.reconstructedQuestion
  : (followupTransform?.contextQuestion ?? question);
```

Leave `promptHistory` assembly as is (it already appends `followupTransform.instruction` when present — planner-synthesized transforms ride the same rail). Leave every retry/refusal path untouched.

- [ ] **Step 5 (authoritative only): source switch.** Immediately after the plan is computed (Step 1 location), add:

```ts
if (plannerMode === "authoritative" && followupPlan!.sourceChanged) {
  const ms = Date.now() - totalStart;
  const explanation = `This follow-up is a better fit for the ${followupPlan!.source} source. Rerunning it there as: "${followupPlan!.reconstructedQuestion}"`;
  writeLog(question, null, 0, null, ms, explanation, tab, ["planner-source-switch"], "deterministic", sessionId);
  // SSE result with a sourceSwitch payload the client resubmits (Task 9)
  ...emit an SSE "result" event exactly like the capabilityOverride block above it, but with
     explanation, title: "Source switch", and an extra field:
     sourceSwitch: { source: followupPlan!.source, question: followupPlan!.reconstructedQuestion }
  return; // same Response shape as the other early returns
}
```

Copy the exact ReadableStream/Response boilerplate from the `capabilityOverride` block (~:440-471); add `sourceSwitch` to the event object (extend `StreamEvent`'s result variant in `lib/types.ts` with `sourceSwitch?: { source: string; question: string }`).

- [ ] **Step 6:** `npx tsc --noEmit`; `npm test`. With `FOLLOWUP_PLANNER_MODE` unset, behavior must be identical — the suites prove the libs; the route diff must show every new branch is behind `plannerMode`.

- [ ] **Step 7:** Commit: `Wire /api/query to the follow-up planner (compare + authoritative modes)`

---

### Task 6: Wire /api/nibrs-query to the planner

**Files:**
- Modify: `app/api/nibrs-query/route.ts`

- [ ] **Step 1:** Same Step-1 block as Task 5 (source `"nibrs"`), placed right after the Stage 1 predicate (~:246). Same `planSaysQueryBearing` const; replace the Stage 1 gates (county ~:267, metadata ~:399).

- [ ] **Step 2 (authoritative):** geo clarification (~:245) — same reconstructed-question/chart-only logic as Task 5 Step 3.

- [ ] **Step 3 (authoritative):** at the follow-up wiring (~:286-309):

```ts
const followupTransform = (plannerMode === "authoritative" && followupPlan)
  ? followupPlan.transform
  : detectFollowupTransform(question, history);
const guardrailQuestion = (plannerMode === "authoritative" && followupPlan && followupPlan.kind === "query_bearing")
  ? followupPlan.reconstructedQuestion
  : (followupTransform?.contextQuestion ?? question);
```

and the planner consultation before deterministic builders:

```ts
const allowDeterministic = (plannerMode === "authoritative" && followupPlan)
  ? followupPlan.deterministicEligible
  : !followupTransform;
const deterministicResolution = allowDeterministic ? resolutionPlan : null;
const nibrsPlan = planNibrsQuery(question, deterministicResolution, { allowDeterministic });
```

(Preserves today's semantics when off/compare: `allowDeterministic === !followupTransform`.) `resolveNibrsPlaces` already receives `guardrailQuestion` — with the planner authoritative it therefore resolves the reconstructed question, which is requirement 4 of the spec. Countywide/campus/explicit-ORI semantics live inside the resolver and stay intact.

- [ ] **Step 4 (authoritative):** source switch — same as Task 5 Step 5 but as a `jsonResp` (this route returns JSON, not SSE): return a `QueryResponse` with `success: true`, `sql: null`, the explanation, and `sourceSwitch: { source, question }` (extend the response type where `QueryResponse` is defined — follow how `chartMeta` is typed).

- [ ] **Step 5:** `npx tsc --noEmit`; `npx tsx scripts/test-nibrs-query-planner.ts`; `npm test`. Commit: `Wire /api/nibrs-query to the follow-up planner`

---

### Task 7: Wire /api/shr-query to the planner

**Files:**
- Modify: `app/api/shr-query/route.ts`

- [ ] **Step 1:** Same planner block (source `"shr"`), after the Stage 1 predicate (~:145). Replace Stage 1 gates (county ~:261, metadata ~:281). Same authoritative `followupTransform`/`guardrailQuestion` override at ~:146 — note this route ALREADY derives `followupCities`/`followupShrPlaces` from `guardrailQuestion`, so the SHR resolver (alias tables, dominance rule, Louisville succession chains) automatically runs on the reconstructed question once `guardrailQuestion` comes from the plan.

- [ ] **Step 2 (authoritative): protect the deterministic shooting path from hijacking follow-ups.** At ~:318:

```ts
if (asksShooting && !wantsNonfatal && !(plannerMode === "authoritative" && followupPlan!.kind === "query_bearing")) {
```

and the nonfatal refusal at ~:306 gets the same guard. A query-bearing follow-up that mentions shootings ("compare it to Dallas shootings") must flow to the model path with the compare transform, not the deterministic builder.

- [ ] **Step 3 (authoritative):** geo clarification (~:239) reconstructed-question/chart-only logic; source switch jsonResp as in Task 6.

- [ ] **Step 4:** `npx tsc --noEmit`; `npx tsx scripts/test-shr-deterministic-shooting.ts`; `npm test`. Commit: `Wire /api/shr-query to the follow-up planner`

---

### Task 8: Wire /api/hc-query to the planner (and fix its contract question)

**Files:**
- Modify: `app/api/hc-query/route.ts`

- [ ] **Step 1:** Same planner block (source `"hate_crime"`, after ~:156), Stage 1 gate replacement (county ~:254, metadata ~:274), authoritative `followupTransform`/`guardrailQuestion` override, geo clarification logic, source-switch jsonResp.

- [ ] **Step 2: Fix the pre-existing gap:** `runContractValidation` (~:182-188) passes raw `question`; introduce `guardrailQuestion` (authoritative: plan's reconstructed question; otherwise `followupTransform?.contextQuestion ?? question`) and pass it as `question:` to `validateQueryContractSql`, matching what nibrs (:589), shr (:189), and query (:815) already do.

- [ ] **Step 3:** `npx tsc --noEmit`; `npm test`. Commit: `Wire /api/hc-query to the follow-up planner and validate contracts against the reconstructed question`

---

### Task 9: Client — visible resubmit on `sourceSwitch`

**Files:**
- Modify: `components/WorkspaceChatV2.tsx`

- [ ] **Step 1:** Where the component consumes a query response (both the JSON routes and the SSE `result` event — find where `explanation`/`chartConfig` are read off the response), detect `response.sourceSwitch`. When present: append the assistant notice to the conversation as usual, then call the existing submit path once with `submitQuestion(sourceSwitch.question, sourceSwitch.source as TabId, "Follow-up moved to a better source", null, "rerun")` — reuse the exact `submitQuestion` signature used at the follow-up branch (~:293-310). Guard against loops: only resubmit if the triggering request was not itself a `"rerun"`.

- [ ] **Step 2:** `npx tsc --noEmit`. Manual check happens in Task 11 (this is the only client change; keep it minimal — no new UI).

- [ ] **Step 3:** Commit: `Auto-resubmit follow-ups when the planner switches source`

---

### Task 10: Offline parity evaluation script

**Files:**
- Create: `scripts/eval-followup-planner-parity.ts` (NOT added to `npm test` — it's an analysis tool)

- [ ] **Step 1:** Build the script:
- Input A: the `SESSIONS` fixtures duplicated from `scripts/test-session-replay.ts` (import if exportable; otherwise copy the array and note the source).
- Input B: multi-turn sessions reconstructed from local `query_log.db` (open readonly via `better-sqlite3`, path `process.env.QUERY_LOG_DB_PATH || "query_log.db"`): group rows by `session_id`, order by timestamp, rebuild `history` cumulatively as the client would (`{role:"user",content:question},{role:"assistant",content: response + "\n[SQL: " + sql + "]"}`, tag with the row's tab).
- For every turn with non-empty history: compute (1) legacy decision — `detectQueryBearingFollowup` result plus which standalone handler WOULD fire (`answerMetadataQuestion` with the real db for current/historical/hate_crime and `null` db for nibrs/shr locally — a null db still exercises intent detection for download/county intents; log "db-limited" for year/state intents on stub DBs), `getCountyScopeClarification`, and (2) `planFollowup` output.
- Emit a markdown report to `docs/followup-planner-parity-<YYYY-MM-DD>.md`: agreement counts (plan query_bearing vs legacy bearing; standalone-would-fire vs plan standaloneEligible; plannedSource vs actual tab), and a mismatch table (session, question, both verdicts).

- [ ] **Step 2:** Run it, commit the script (NOT the generated report): `Add offline planner parity evaluation`

---

### Task 11: Verification gate

- [ ] **Step 1:** `npm test` — exit 0 (now 43 suites: +planner-mode, +planner; query-bearing already in).
- [ ] **Step 2:** `npx tsx scripts/test-router.ts` = 217/217; `npx tsx scripts/test-session-replay.ts` = 68/71 (same 3 failures, no new).
- [ ] **Step 3:** `npx tsx scripts/eval-followup-planner-parity.ts` — review the mismatch table; every mismatch must be explainable (planner catching something legacy missed is GOOD — list them; planner missing something legacy caught is a bug — fix before proceeding).
- [ ] **Step 4:** Compare-mode smoke on the local dev server (historical works locally): `FOLLOWUP_PLANNER_MODE=compare npm run dev` (or set in `.env.local`), replay the Minnesota two-turn exchange against `/api/query`, confirm the `[followup-planner][compare]` log line appears and the response is unchanged from Stage 1.
- [ ] **Step 5:** Report results. Do NOT flip any env flag in production and do NOT deploy — Jeff decides.

---

## Rollout (after this plan is implemented and reviewed)

1. Deploy with `FOLLOWUP_PLANNER_MODE=compare` (add to `/opt/nibrs/shared/.env` or `ecosystem.config.js` env). Collect ≥1 week of `[followup-planner][compare]` lines (`pm2 logs nibrs`) + rerun the parity script against production `query_log.db`.
2. Review mismatches with Jeff. Fix planner bugs; re-verify.
3. `FOLLOWUP_PLANNER_MODE=authoritative`, `FOLLOWUP_PLANNER_SOURCES=nibrs,historical,current` → run `live-replay --quick` and `--sessions` against prod; watch the nightly scoreboard for 2-3 days.
4. Add `shr,hate_crime` to `FOLLOWUP_PLANNER_SOURCES`. Same watch.
5. Only then consider follow-on cleanups (consolidating the duplicate continuous-reporter regexes, retiring the Stage 1 route-level predicate in favor of plan-only gating).

## Acceptance invariants (from Jeff's spec — recheck each at Task 11)

- A query-bearing follow-up is never answered as standalone metadata. (Tasks 5-8 gates; planner test 1)
- A follow-up never silently switches source. (Task 5 Step 5 / Task 9 — switch is always an explicit response + visible resubmit)
- Prior geography and offense are preserved unless explicitly changed. (synthesizeTransform instructions; planner tests 1, 2, 6, preservation test)
- Requested time ranges are preserved or intentionally replaced. (change_time_range; tests 1, 6)
- Mixed city/state comparisons constrain only the city branch. (contract validator behavior on the reconstructed question — covered by existing `scripts/test-query-contract.ts` city/state cases; planner test 4 asserts reconstruction)
- Countywide, campus, explicit-ORI, and succession cases retain source-specific semantics. (resolvers run on the reconstructed question — Tasks 6-7; planner tests 5a/5b/6)
- Chart-only follow-ups do not re-run blocking geography logic. (Task 5 Step 3 / Tasks 6-8; planner test 7)
- Standalone metadata questions continue to use the fast deterministic path. (planner test 9; e2e control from Stage 1 still passes)
