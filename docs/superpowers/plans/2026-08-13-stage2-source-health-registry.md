# Stage 2A — Source Health Registry (preparatory) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-capability source-health registry and wire its verdict into the proof manifest, such that every capability across all five sources evaluates **real structural evidence against a real database** — and, because build receipts do not exist yet, no capability can yet authorize an answer.

**Architecture:** A declarative capability inventory (`lib/source-health-inventory.ts`) is the single source of truth for source × capability dependencies, and each capability **owns its database provider**, acquiring a handle and the path it was opened from in one atomic call rather than depending on a route to hand one over. One evaluator (`lib/source-health.ts`) turns a spec into the existing `SourceHealth` interface plus an **evaluation trace** recording which checks actually ran and where evaluation stopped. Capability identity comes from a `PlanDerivation` verified against the executed SQL and the claimed family; for embed reads, where no token exists by design, it comes from a plan family that `verifyEmbedOrigin()` extracts from the originating answer's proof envelope and that creation persists only for a verified, source-matched origin. `proof-finalize` maps the verdict onto `manifest.source`.

**Tech Stack:** TypeScript, better-sqlite3 (readonly), bespoke `npx tsx` suites following `scripts/test-proof-checks.ts`.

**Spec:** `docs/superpowers/specs/2026-08-11-verified-answer-only-handoff.md` — §4, §7, §8, §Stage 2 (line 319).

## Stage 2A is preparatory, not independently complete

**Stage 2 closes only when 2A and 2B have both landed and their combined exit criteria pass.**

In 2A:

- Structure broken → `degraded(reason)`, backed by evidence.
- Structure intact, **receipt absent** → `unknown("no build receipt for …")`, never `healthy`.
- `dataVersion` is **always `null`**. Table year bounds are coverage evidence; a database path is a location. Neither is a build identifier.

Self-enforcing: `permitsAnswer()` (`lib/proof-contract.ts:211`) rejects empty `dataVersion`, and `factualDeliveryBlocker()` (`:281`) returns `"source.dataVersion is not set"` before inspecting health. Task 8 asserts it.

**Two things are deferred to 2B and Stage 2 cannot close without them:** real receipts (so `healthy` becomes reachable), and hard timeout isolation (Task 6 is explicitly *not* a timeout).

## The failure this revision exists to prevent

An integration test can assert that a probe *ran* and still prove nothing. If the probe immediately returns `"no database handle supplied"`, the counter increments, the response is unchanged, and the suite goes green over a registry that never looked at a database. Receipts in 2B cannot repair a missing database context.

So two structural decisions run through this plan:

1. **Capabilities own their database provider.** Health does not depend on a route remembering to pass `db` — several supported exits (NIBRS metadata, Hate Crime metadata, embed reads) pass none.
2. **Every evaluation emits a trace** naming the database identity, the checks that ran, and the **boundary** where evaluation stopped. Integration fixtures assert the boundary is `missing_receipt` — i.e. structural evaluation *succeeded* — not merely that a call happened.

## Global Constraints

- **§8:** results are `healthy` / `degraded(reason)` / `unknown(reason)`; unknown is treated as degraded.
- **§8:** capability-specific registry with a short in-process cache, not one app-wide health bit.
- **§8 inputs, all required:** database open/read success; required tables **and columns**; nonzero/expected row bounds; builder/import receipt; "freshness relative to the exact period requested, not merely the wall clock"; "dependencies between raw source, summaries, completeness tables, and sample/cohort tables".
- **§4:** "embed reads require current source health plus result/chart proof. Legacy embeds without adequate proof must not be silently treated as compliant."
- **§7:** "Each reason must carry evidence. `unknown` never permits an attributed source claim."
- **Invariant 14 / §449:** off and shadow cannot change routing, SQL, retries, rows, narrative, charts. In `off`, **no source-health work runs**.
- **Invariant 15:** the existing logger and digest continue independently; a probe failure cannot alter or delay a response.
- **§13 / default-off:** every capability flag defaults to off; an **unset** flag must not enable probing.
- Schema work stays additive, nullable, deploy-order tolerant, readable by baseline release `c2b52ca`.

## File Structure

- **Create `lib/source-health-inventory.ts`** — inventory: database provider, preflight adapter, required tables/columns, row bounds, dependencies, coverage source, receipt key, Stage 2A reachability, and the **nested** source → family → capability map.
- **Create `lib/source-health.ts`** — evaluator returning `{ health, trace }`, TTL cache keyed by non-forgeable handle identity, capability resolution, flag gate, budget switch, test-only introspection.
- **Create `scripts/test-source-health-inventory.ts`** — five-source coverage, family-collision regression, non-vacuity, provider presence.
- **Create `scripts/test-source-health.ts`** — evaluator semantics and traces.
- **Create `scripts/test-source-health-wiring.ts`** — manifest mapping, gate agreement, cannot-authorize, isolation.
- **Modify `lib/proof-modes.ts`** — `envKeyForCapability()`.
- **Modify `lib/proof-finalize.ts:436-450`** — resolve, evaluate, map onto `manifest.source`.
- **Modify `lib/embed-origin.ts`** — extend `OriginVerdict` with a server-extracted `planFamily` (Task 10).
- **Modify `app/api/embed/route.ts`** — persist that evidence on create; recover it on read (Task 10).
- **Modify `scripts/migrate-shared-charts-proof.js`** — one additive nullable column.
- **Modify `scripts/test-shadow-route-equivalence.ts`** — Stage 2 axis, Historical case, boundary assertions.
- **Modify `scripts/test-shadow-equivalence.ts`** — two embed fixtures.
- **Modify `scripts/test-embed-origin.ts`** — `planFamily` regressions across every origin state.
- **Modify `package.json`** — register the three new suites.

---

### Task 1: Inventory with capability-owned database providers

**Files:** Create `lib/source-health-inventory.ts`, `scripts/test-source-health-inventory.ts`; modify `package.json`

**Interfaces:**
```typescript
export type Db = import("better-sqlite3").Database;
/**
 * A handle and the path it was actually opened from, acquired together.
 *
 * ATOMIC ON PURPOSE. A provider with separate open() and path() calls cannot promise the
 * two describe one artifact: path() reading only an environment variable is null whenever
 * the opener fell back to a candidate path, and it can change independently of an
 * already-cached handle. Since the whole point of the artifact-coherence check is to
 * compare the inspected file against the evaluated file, the pair must be produced by one
 * acquisition or the comparison is theatre.
 */
export type OpenedDatabase = { db: Db; resolvedPath: string };
/**
 * How a capability reaches its own database.
 *
 * Capability-owned, because health cannot depend on a route remembering to pass a handle:
 * the NIBRS and Hate Crime metadata exits and every embed read pass none, and a probe
 * that returns "no database handle" is indistinguishable from a healthy one to any test
 * that only counts invocations.
 */
export type DatabaseProvider = { acquire: () => OpenedDatabase | null };
/** Receives the SAME opened handle and resolved path the structural checks will use. */
export type Preflight = (opened: OpenedDatabase | null) => { ok: boolean; reason: string; inspectedPath?: string | null };
export type TableRequirement = { name: string; requiredColumns: string[]; minRows: number };
export type DependencyRule = { derived: string; upstream: string; generationColumn?: string };
export type CapabilitySpec = {
  sourceId: SourceId;
  capability: string;
  database: DatabaseProvider;
  preflight?: Preflight;
  tables: TableRequirement[];
  dependencies: DependencyRule[];
  coverage: { table: string; yearColumn: string } | null;
  receiptKey: string;
  stage2aReachable: boolean;
  unreachableReason?: string;
};
export const CAPABILITY_INVENTORY: readonly CapabilitySpec[];
export function specFor(sourceId: SourceId, capability: string): CapabilitySpec | null;
export const CAPABILITY_BY_SOURCE_AND_FAMILY: Readonly<Record<SourceId, Readonly<Record<string, string>>>>;
export function capabilityForFamily(sourceId: SourceId, planFamily: string): string | null;
```

- [ ] **Step 1: Enumerate real families and the existing database accessors**

```bash
grep -rhoE 'seal(Compiler)?PlanDerivation\(\s*"[a-z0-9-]+"' --include=*.ts app lib | grep -oE '"[a-z0-9-]+"' | sort | uniq -c | sort -rn
grep -rlE 'seal(Compiler)?PlanDerivation\(\s*"metadata-coverage-answer"' --include=*.ts app lib
grep -rn "^export function get.*Db\b" lib/*.ts
grep -rn "new Database(resolvedPath" lib/sqlite-db.ts
```

`metadata-coverage-answer` is sealed in **four** places across different sources, so a family name is not a unique key.

The third command gives you the real accessor names — note that RTCI's is **`getDb` in `lib/rtci-db.ts`**, not `getRtciDb`, and Hate Crime's is **`getHateCrimeDb`**, not `getHcDb`. The fourth confirms why the providers need no candidate lists of their own: `getManagedDb` opens `new Database(resolvedPath, …)`, so `db.name` on a managed handle already *is* the resolved path. Copying each accessor's env var and fallback candidates into the inventory would reintroduce the handle/path disagreement the atomic type exists to prevent — and would be wrong on arrival, since SHR and Hate Crime each declare **two** fallback candidates.

- [ ] **Step 2: Write the failing inventory test**

```typescript
// scripts/test-source-health-inventory.ts
import assert from "node:assert";
import {
  CAPABILITY_INVENTORY, specFor, CAPABILITY_BY_SOURCE_AND_FAMILY, capabilityForFamily,
} from "../lib/source-health-inventory";
import { SOURCE_IDS } from "../lib/proof-contract";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (error) { console.log(`  FAIL  ${name}\n        ${(error as Error).message}`); process.exitCode = 1; }
}

check("all five sources have at least one capability", () => {
  for (const sourceId of SOURCE_IDS) {
    assert.ok(CAPABILITY_INVENTORY.some((spec) => spec.sourceId === sourceId), `${sourceId} has no capability`);
  }
});

check("every capability owns a database provider with atomic acquisition", () => {
  // Without this, health depends on a route passing `db`, and the exits that pass none
  // silently evaluate nothing. `acquire` is a single call so the handle and its resolved
  // path cannot disagree.
  for (const spec of CAPABILITY_INVENTORY) {
    assert.strictEqual(typeof spec.database.acquire, "function", `${spec.sourceId}:${spec.capability} has no acquire()`);
  }
});

check("an acquired database reports the path it was actually opened from", () => {
  // Covers the env-path case AND the fallback case: whichever candidate the resolver
  // chose, resolvedPath names that file rather than echoing an environment variable that
  // may be unset.
  const previous = process.env.RTCI_DB_PATH;
  const spec = specFor("current", "national")!;
  for (const configured of [undefined, previous]) {
    if (configured === undefined) delete process.env.RTCI_DB_PATH;
    else process.env.RTCI_DB_PATH = configured;
    const opened = spec.database.acquire();
    if (opened) {
      assert.ok(opened.resolvedPath.trim() !== "", "an acquired database must name its resolved path");
      assert.ok(fs.existsSync(opened.resolvedPath), `resolvedPath ${opened.resolvedPath} must be the file that was opened`);
    }
  }
  if (previous === undefined) delete process.env.RTCI_DB_PATH; else process.env.RTCI_DB_PATH = previous;
});

check("the NIBRS rollup capability acquires the ROLLUP artifact, not the main database", () => {
  // The defect this pins: inspectNibrsRollupAvailability() evaluates
  // NIBRS_ROLLUP_DB_PATH, so a capability opened from NIBRS_DB_PATH would guarantee that
  // preflight and the structural checks describe different files -- exactly what the
  // artifact_mismatch boundary exists to catch, arranged by construction.
  const rollup = specFor("nibrs", "rollup")!;
  const summary = specFor("nibrs", "summary")!;
  const rollupPath = (process.env.NIBRS_ROLLUP_DB_PATH ?? "").trim();
  const mainPath = (process.env.NIBRS_DB_PATH ?? "").trim();
  if (rollupPath && mainPath) {
    assert.notStrictEqual(rollupPath, mainPath, "the fixture must configure two distinct artifacts for this to mean anything");
    const openedRollup = rollup.database.acquire();
    const openedMain = summary.database.acquire();
    if (openedRollup) assert.strictEqual(path.resolve(openedRollup.resolvedPath), path.resolve(rollupPath));
    if (openedMain) assert.strictEqual(path.resolve(openedMain.resolvedPath), path.resolve(mainPath));
  }
});

check("Current national and sample-agency paths are SEPARATE capabilities", () => {
  const national = specFor("current", "national");
  const sample = specFor("current", "sample_agencies");
  assert.ok(national && sample);
  assert.notDeepStrictEqual(
    national!.tables.map((t) => t.name).sort(),
    sample!.tables.map((t) => t.name).sort(),
    "the two Current capabilities must not depend on an identical table set",
  );
});

check("Historical agency and state/national paths are SEPARATE capabilities", () => {
  assert.ok(specFor("historical", "agency_crime"));
  assert.ok(specFor("historical", "state_national"));
});

check("every capability names required columns and a receipt key", () => {
  for (const spec of CAPABILITY_INVENTORY) {
    assert.ok(spec.receiptKey.trim() !== "", `${spec.sourceId}:${spec.capability} has no receiptKey`);
    for (const table of spec.tables) {
      assert.ok(table.requiredColumns.length > 0, `${spec.capability}/${table.name} names no required columns`);
      assert.ok(table.minRows >= 1, `${spec.capability}/${table.name} permits an empty table`);
    }
  }
});

check("a family shared by two sources resolves per source, not globally", () => {
  const users = SOURCE_IDS.filter((s) => capabilityForFamily(s, "metadata-coverage-answer") !== null);
  assert.ok(users.length >= 2, `expected metadata-coverage-answer under multiple sources, saw ${users.join(",") || "none"}`);
  const distinct = new Set(users.map((s) => `${s}:${capabilityForFamily(s, "metadata-coverage-answer")}`));
  assert.strictEqual(distinct.size, users.length, "each source must resolve this family to its own capability");
});

check("the family map is not vacuously empty", () => {
  const mapped = new Set<string>();
  for (const [sourceId, families] of Object.entries(CAPABILITY_BY_SOURCE_AND_FAMILY)) {
    for (const capability of Object.values(families)) mapped.add(`${sourceId}:${capability}`);
  }
  assert.ok(mapped.size > 0, "at least one capability must be reachable in Stage 2A");
  for (const spec of CAPABILITY_INVENTORY) {
    const key = `${spec.sourceId}:${spec.capability}`;
    if (spec.stage2aReachable) assert.ok(mapped.has(key), `${key} is reachable but no verified family maps to it`);
    else assert.ok((spec.unreachableReason ?? "").trim() !== "", `${key} is unreachable and must say why`);
  }
});

console.log(`\nsource health inventory tests: ${passed} passed`);
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx tsx scripts/test-source-health-inventory.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the inventory**

Column names come from `lib/claude.ts`, `lib/nibrs-claude.ts`, `lib/shr-claude.ts`, `lib/hc-claude.ts`, `lib/dynamic-facts.ts`; verify each while writing, because a wrong name yields a false `degraded`.

```typescript
// lib/source-health-inventory.ts
import path from "node:path";
import Database from "better-sqlite3";
import type { SourceId } from "./proof-contract";
import { inspectNibrsRollupAvailability } from "./nibrs-rollup-router";
import { getDb } from "./rtci-db";
import { getNibrsDb } from "./nibrs-db";
import { getShrDb } from "./shr-db";
import { getHateCrimeDb } from "./hc-db";

export type Db = import("better-sqlite3").Database;
export type OpenedDatabase = { db: Db; resolvedPath: string };
export type DatabaseProvider = { acquire: () => OpenedDatabase | null };
export type Preflight = (opened: OpenedDatabase | null) => { ok: boolean; reason: string; inspectedPath?: string | null };
export type TableRequirement = { name: string; requiredColumns: string[]; minRows: number };
export type DependencyRule = { derived: string; upstream: string; generationColumn?: string };
export type CapabilitySpec = {
  sourceId: SourceId;
  capability: string;
  database: DatabaseProvider;
  preflight?: Preflight;
  tables: TableRequirement[];
  dependencies: DependencyRule[];
  coverage: { table: string; yearColumn: string } | null;
  receiptKey: string;
  stage2aReachable: boolean;
  unreachableReason?: string;
};

/**
 * Wrap a managed accessor into an atomic provider.
 *
 * THE PATH COMES FROM THE HANDLE, not from a copied candidate list. Every managed
 * accessor already resolves its own path -- getManagedDb opens
 * `new Database(resolvedPath, ...)` (lib/sqlite-db.ts:110), so `db.name` IS that resolved
 * path. Restating each accessor's env var and fallback candidates here would reintroduce
 * exactly the disagreement the atomic return type exists to prevent, and would be wrong
 * on arrival: SHR and Hate Crime each have TWO fallback candidates.
 *
 * Never throws: a provider failure must become `unknown`, not an exception (§13).
 */
function managedProvider(open: () => Db | null): DatabaseProvider {
  return {
    acquire: () => {
      try {
        const db = open();
        if (!db || !db.name) return null;
        return { db, resolvedPath: path.resolve(db.name) };
      } catch {
        return null;
      }
    },
  };
}

/**
 * The NIBRS ROLLUP artifact, which is a different file from the main NIBRS database.
 *
 * ensureNibrsRollupAttached() ATTACHes this file as `rollup` and rewrites queries to
 * `rollup.{state|national}_{source}`; inspectNibrsRollupAvailability() is what knows its
 * path. Opening it through getNibrsDb()/NIBRS_DB_PATH would evaluate the wrong file while
 * preflight inspected the right one. This is the one provider that takes its path from the
 * inspector rather than from a handle, because the inspector is the authority on which
 * artifact the rollup mechanism will actually attach. Opened read-only with no pragmas, so
 * a non-WAL artifact does not fail to open.
 */
const NIBRS_ROLLUP: DatabaseProvider = {
  acquire: () => {
    try {
      const availability = inspectNibrsRollupAvailability();
      if (!availability.available || !availability.path) return null;
      const resolvedPath = path.resolve(availability.path);
      return { db: new Database(resolvedPath, { readonly: true }), resolvedPath };
    } catch {
      return null;
    }
  },
};

// Accessor names verified against their owning modules: RTCI is getDb in lib/rtci-db.ts
// (NOT getRtciDb), and Hate Crime is getHateCrimeDb (NOT getHcDb).
const RTCI = managedProvider(getDb);
const NIBRS_MAIN = managedProvider(getNibrsDb);
const SHR = managedProvider(getShrDb);
const HC = managedProvider(getHateCrimeDb);

export const CAPABILITY_INVENTORY: readonly CapabilitySpec[] = [
  {
    sourceId: "current", capability: "national", database: RTCI,
    tables: [{ name: "national_monthly", requiredColumns: ["year", "month", "offense"], minRows: 1 }],
    dependencies: [], coverage: { table: "national_monthly", yearColumn: "year" },
    receiptKey: "rtci_national", stage2aReachable: true,
  },
  {
    sourceId: "current", capability: "sample_agencies", database: RTCI,
    tables: [
      { name: "sample_agencies", requiredColumns: ["ori"], minRows: 1 },
      { name: "agency_monthly", requiredColumns: ["ori", "year", "month"], minRows: 1 },
    ],
    dependencies: [{ derived: "sample_agencies", upstream: "agency_monthly" }],
    coverage: { table: "agency_monthly", yearColumn: "year" },
    receiptKey: "rtci_sample_agencies", stage2aReachable: true,
  },
  {
    sourceId: "historical", capability: "agency_crime", database: RTCI,
    tables: [
      { name: "historical_agency", requiredColumns: ["ori"], minRows: 1 },
      { name: "historical_agency_crime", requiredColumns: ["ori", "year"], minRows: 1 },
      // Required, not optional: without it every agency-year reads as usable and the
      // scorecard's caveats vanish silently.
      { name: "agency_year_reliability", requiredColumns: ["ori", "year"], minRows: 1 },
    ],
    dependencies: [{ derived: "agency_year_reliability", upstream: "historical_agency_crime" }],
    coverage: { table: "historical_agency_crime", yearColumn: "year" },
    receiptKey: "historical_agency_crime", stage2aReachable: true,
  },
  {
    sourceId: "historical", capability: "state_national", database: RTCI,
    tables: [{ name: "historical_state_national", requiredColumns: ["state", "year"], minRows: 1 }],
    dependencies: [], coverage: { table: "historical_state_national", yearColumn: "year" },
    receiptKey: "historical_state_national", stage2aReachable: true,
  },
  {
    // The MAIN NIBRS database: the pre-aggregated summary tables ordinary NIBRS answers
    // read. Distinct from the rollup artifact below, and healthy or broken independently.
    sourceId: "nibrs", capability: "summary", database: NIBRS_MAIN,
    tables: [{ name: "summary_victim_state_monthly", requiredColumns: ["state", "year", "month"], minRows: 1 }],
    dependencies: [], coverage: { table: "summary_victim_state_monthly", yearColumn: "year" },
    receiptKey: "nibrs_summary", stage2aReachable: true,
  },
  {
    sourceId: "nibrs", capability: "rollup", database: NIBRS_ROLLUP,
    /**
     * ADAPTER SEAM, NOT A REIMPLEMENTATION -- over the SAME artifact the table checks read.
     * inspectNibrsRollupAvailability() already distinguishes rollup-unconfigured,
     * rollup-empty and source-newer-than-rollup; restating those here would let the two
     * drift and would lose findings the router already makes. The provider opens the exact
     * path the inspector reports, and the evaluator still compares inspectedPath against
     * resolvedPath so a future divergence surfaces as artifact_mismatch rather than as a
     * confident verdict about the wrong file.
     */
    preflight: (opened) => {
      const availability = inspectNibrsRollupAvailability();
      return {
        ok: availability.available,
        reason: `rollup unavailable: ${availability.reason}`,
        inspectedPath: availability.path ?? opened?.resolvedPath ?? null,
      };
    },
    /**
     * Rollup tables are `{level}_{source}` inside the attached schema -- the router
     * rewrites `FROM summary_clearance_type` to `FROM rollup.state_summary_clearance_type`.
     * Evaluated here WITHOUT the `rollup.` prefix because this provider opens that file
     * directly as its main schema. One representative pair is checked rather than all
     * nine sources x two levels, because a rollup build writes them together; the receipt
     * in Stage 2B is what will attest to the whole set.
     */
    tables: [
      { name: "state_summary_clearance_type", requiredColumns: ["state", "year"], minRows: 1 },
      { name: "national_summary_clearance_type", requiredColumns: ["year"], minRows: 1 },
    ],
    dependencies: [], coverage: { table: "state_summary_clearance_type", yearColumn: "year" },
    receiptKey: "nibrs_rollup", stage2aReachable: true,
  },
  {
    sourceId: "shr", capability: "incidents", database: SHR,
    tables: [{ name: "incidents", requiredColumns: ["ori", "year", "state", "homicide_type"], minRows: 1 }],
    dependencies: [], coverage: { table: "incidents", yearColumn: "year" },
    receiptKey: "shr_incidents", stage2aReachable: true,
  },
  {
    sourceId: "hate_crime", capability: "incidents", database: HC,
    tables: [{ name: "hate_crime_incidents", requiredColumns: ["ori", "year", "state_abbr", "bias_motivation"], minRows: 1 }],
    dependencies: [], coverage: { table: "hate_crime_incidents", yearColumn: "year" },
    receiptKey: "hate_crime_incidents", stage2aReachable: true,
  },
];

export function specFor(sourceId: SourceId, capability: string): CapabilitySpec | null {
  return CAPABILITY_INVENTORY.find((s) => s.sourceId === sourceId && s.capability === capability) ?? null;
}

/**
 * sourceId -> planFamily -> capability. NESTED because a family name is not unique:
 * `metadata-coverage-answer` is sealed in four places across sources, and a flat map
 * would let one source's answer select another's capability. Replace with Step 1 output.
 */
export const CAPABILITY_BY_SOURCE_AND_FAMILY: Readonly<Record<SourceId, Readonly<Record<string, string>>>> = {
  current: { "metadata-coverage-answer": "national" },
  historical: { "metadata-coverage-answer": "state_national" },
  nibrs: { "metadata-coverage-answer": "summary" },
  shr: { "deterministic-murder": "incidents", "deterministic-shooting": "incidents" },
  hate_crime: { "metadata-coverage-answer": "incidents" },
};

export function capabilityForFamily(sourceId: SourceId, planFamily: string): string | null {
  return CAPABILITY_BY_SOURCE_AND_FAMILY[sourceId]?.[planFamily] ?? null;
}
```

- [ ] **Step 5: Run it, confirm it passes, commit**

Run: `npx tsx scripts/test-source-health-inventory.ts && npx tsc --noEmit`

```bash
git add lib/source-health-inventory.ts scripts/test-source-health-inventory.ts package.json
git commit -m "Add the source x capability inventory with capability-owned database providers"
```

---

### Task 2: Evaluator with an evaluation trace

**Files:** Create `lib/source-health.ts`, `scripts/test-source-health.ts`; modify `package.json`

**Interfaces:**
```typescript
export type HealthBoundary =
  | "no_database" | "preflight_failed" | "artifact_mismatch" | "table_missing" | "column_missing"
  | "row_bounds" | "dependency" | "missing_receipt" | "threw" | "budget_zero" | "budget_exceeded";
export type HealthTrace = {
  sourceId: SourceId; capability: string;
  /** Non-forgeable identity of the handle actually evaluated. */
  dbIdentity: string;
  dbPath: string | null;
  preflight: "skipped" | "ok" | "failed";
  tablesChecked: string[];
  dependenciesChecked: string[];
  coverage: CheckState;
  boundary: HealthBoundary;
};
/**
 * Requested period only; the database comes from the capability's own provider.
 *
 * `dbOverride` lets a test point a capability at a fixture, and is an OpenedDatabase --
 * not a bare handle -- so a fixture cannot smuggle in a handle whose path is unknown and
 * defeat the artifact-coherence check.
 */
export type HealthContext = { requestedYears: number[] | null; dbOverride?: OpenedDatabase | null };
export function evaluateCapability(spec: CapabilitySpec, context: HealthContext): { health: SourceHealth; trace: HealthTrace };
```

`dbOverride` exists so tests can point a capability at a fixture; production never sets it. The trace records the identity actually used either way, so a fixture cannot silently evaluate the production database or vice versa.

- [ ] **Step 1: Write the failing tests**

```typescript
// scripts/test-source-health.ts
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { evaluateCapability } from "../lib/source-health";
import { specFor } from "../lib/source-health-inventory";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srchealth-"));
let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (error) { console.log(`  FAIL  ${name}\n        ${(error as Error).message}`); process.exitCode = 1; }
}

function shrFixture(mutate?: (db: Database.Database) => void): Database.Database {
  const db = new Database(path.join(dir, `shr-${Math.random().toString(36).slice(2)}.db`));
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE incidents (ori TEXT, year INTEGER, state TEXT, homicide_type TEXT, victim_count INTEGER)");
  db.prepare("INSERT INTO incidents VALUES (?,?,?,?,?)").run("TX0001", 2022, "TX", "Murder", 1);
  mutate?.(db);
  return db;
}
const shr = specFor("shr", "incidents")!;
// dbOverride is an OpenedDatabase, so a fixture declares the path it stands for.
const ctx = (db: Database.Database | null, years: number[] | null = [2022]) => ({
  requestedYears: years,
  dbOverride: db ? { db, resolvedPath: db.name } : null,
});

check("an intact structure reaches the MISSING RECEIPT boundary having checked its tables", () => {
  // The assertion that stops "evaluation called, returned unknown before doing anything"
  // from counting as evidence.
  const { health, trace } = evaluateCapability(shr, ctx(shrFixture()));
  assert.strictEqual(trace.boundary, "missing_receipt");
  assert.deepStrictEqual(trace.tablesChecked, ["incidents"], "the required table must actually have been checked");
  assert.notStrictEqual(trace.dbIdentity, "no-db");
  assert.strictEqual(health.state, "unknown");
  assert.match(health.reason ?? "", /receipt/);
  assert.strictEqual(health.dataVersion, null);
});

check("no database stops at no_database, having checked nothing", () => {
  const { health, trace } = evaluateCapability(shr, ctx(null));
  assert.strictEqual(trace.boundary, "no_database");
  assert.deepStrictEqual(trace.tablesChecked, []);
  assert.strictEqual(health.state, "unknown");
});

check("a missing table stops at table_missing", () => {
  const { health, trace } = evaluateCapability(shr, ctx(shrFixture((d) => d.exec("DROP TABLE incidents"))));
  assert.strictEqual(trace.boundary, "table_missing");
  assert.strictEqual(health.state, "degraded");
  assert.match(health.reason ?? "", /incidents/);
});

check("a missing COLUMN stops at column_missing even though the table exists", () => {
  const db = shrFixture((d) => {
    d.exec("DROP TABLE incidents");
    d.exec("CREATE TABLE incidents (ori TEXT, year INTEGER)");
    d.prepare("INSERT INTO incidents VALUES (?,?)").run("TX0001", 2022);
  });
  const { health, trace } = evaluateCapability(shr, ctx(db));
  assert.strictEqual(trace.boundary, "column_missing");
  assert.strictEqual(health.state, "degraded");
  assert.match(health.reason ?? "", /homicide_type|state/);
});

check("an empty table stops at row_bounds", () => {
  const { health, trace } = evaluateCapability(shr, ctx(shrFixture((d) => d.exec("DELETE FROM incidents"))));
  assert.strictEqual(trace.boundary, "row_bounds");
  assert.strictEqual(health.state, "degraded");
});

check("coverage is recorded independently of state", () => {
  assert.strictEqual(evaluateCapability(shr, ctx(shrFixture(), [2022])).trace.coverage, "passed");
  assert.strictEqual(evaluateCapability(shr, ctx(shrFixture(), [2030])).trace.coverage, "failed");
  assert.strictEqual(evaluateCapability(shr, ctx(shrFixture(), null)).trace.coverage, "not_applicable");
});

console.log(`\nsource health tests: ${passed} passed`);
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx scripts/test-source-health.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the evaluator**

```typescript
// lib/source-health.ts
import type { CheckState, SourceHealth, SourceId } from "./proof-contract";
import type { CapabilitySpec, Db } from "./source-health-inventory";

export type HealthBoundary =
  | "no_database" | "preflight_failed" | "artifact_mismatch" | "table_missing" | "column_missing"
  | "row_bounds" | "dependency" | "missing_receipt" | "threw" | "budget_zero" | "budget_exceeded";
export type HealthTrace = {
  sourceId: SourceId; capability: string; dbIdentity: string; dbPath: string | null;
  preflight: "skipped" | "ok" | "failed";
  tablesChecked: string[]; dependenciesChecked: string[];
  coverage: CheckState; boundary: HealthBoundary;
};
export type HealthContext = { requestedYears: number[] | null; dbOverride?: OpenedDatabase | null };

/** Non-forgeable identity for a handle; see the note in sourceHealthFor. */
const handleIds = new WeakMap<object, number>();
let nextHandleId = 1;
export function identityOf(db: object | null): string {
  if (!db) return "no-db";
  let id = handleIds.get(db);
  if (id === undefined) { id = nextHandleId++; handleIds.set(db, id); }
  return `h${id}`;
}

function columnsOf(db: Db, table: string): Set<string> | null {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (rows.length === 0) return null;
    return new Set(rows.map((row) => row.name));
  } catch { return null; }
}

function rowCount(db: Db, table: string): number | null {
  try { return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; }
  catch { return null; }
}

function coverageFor(spec: CapabilitySpec, db: Db, requestedYears: number[] | null): CheckState {
  if (!spec.coverage) return "unknown";
  if (!requestedYears || requestedYears.length === 0) return "not_applicable";
  try {
    const bounds = db
      .prepare(`SELECT MIN(${spec.coverage.yearColumn}) AS lo, MAX(${spec.coverage.yearColumn}) AS hi FROM ${spec.coverage.table}`)
      .get() as { lo: number | null; hi: number | null };
    if (bounds.lo === null || bounds.hi === null) return "unknown";
    return requestedYears.every((y) => y >= bounds.lo! && y <= bounds.hi!) ? "passed" : "failed";
  } catch { return "unknown"; }
}

export function evaluateCapability(spec: CapabilitySpec, context: HealthContext): { health: SourceHealth; trace: HealthTrace } {
  // The capability's OWN provider, unless a test points it at a fixture. Routes never
  // supply this, which is the point: several supported exits pass no database at all.
  // ONE acquisition yields both the handle and the path it came from, so the two cannot
  // describe different artifacts.
  const opened = context.dbOverride !== undefined ? context.dbOverride : spec.database.acquire();
  const db = opened?.db ?? null;
  const dbPath = opened?.resolvedPath ?? null;
  const trace: HealthTrace = {
    sourceId: spec.sourceId, capability: spec.capability,
    dbIdentity: identityOf(db as object | null), dbPath,
    preflight: "skipped", tablesChecked: [], dependenciesChecked: [],
    coverage: "unknown", boundary: "no_database",
  };
  const done = (state: SourceHealth["state"], reason: string | null, boundary: HealthBoundary) => {
    trace.boundary = boundary;
    return {
      health: {
        sourceId: spec.sourceId, capability: spec.capability, state, reason,
        // ALWAYS null in Stage 2A: substituting bounds or a path would fabricate
        // provenance and let permitsAnswer() authorize an unvouched answer.
        dataVersion: null,
        requestedCoverage: trace.coverage,
      },
      trace,
    };
  };

  if (spec.preflight) {
    const pre = spec.preflight(opened);
    trace.preflight = pre.ok ? "ok" : "failed";
    if (!pre.ok) return done("degraded", pre.reason, "preflight_failed");
    // Both halves of the verdict must describe ONE artifact. If the inspector looked at a
    // different file from the handle we are about to evaluate, neither half means what it
    // appears to mean.
    if (pre.inspectedPath && dbPath && path.resolve(pre.inspectedPath) !== path.resolve(dbPath)) {
      return done("degraded", `preflight inspected ${pre.inspectedPath} but tables would be read from ${dbPath}`, "artifact_mismatch");
    }
  }

  if (!db) return done("unknown", "no database handle available from the capability's provider", "no_database");

  for (const table of spec.tables) {
    const columns = columnsOf(db, table.name);
    if (columns === null) return done("degraded", `required table ${table.name} is missing`, "table_missing");
    const absent = table.requiredColumns.filter((column) => !columns.has(column));
    if (absent.length > 0) return done("degraded", `table ${table.name} is missing required column(s): ${absent.join(", ")}`, "column_missing");
    const rows = rowCount(db, table.name);
    if (rows === null) return done("degraded", `required table ${table.name} could not be read`, "table_missing");
    if (rows < table.minRows) return done("degraded", `table ${table.name} has ${rows} rows, below the required ${table.minRows}`, "row_bounds");
    trace.tablesChecked.push(table.name);
  }

  trace.coverage = coverageFor(spec, db, context.requestedYears);
  return done("unknown", `no build receipt for ${spec.receiptKey}; Stage 2B supplies it`, "missing_receipt");
}
```

Add `import path from "node:path";` at the top.

- [ ] **Step 4: Run it, confirm it passes, commit**

Run: `npx tsx scripts/test-source-health.ts && npx tsc --noEmit`

```bash
git add lib/source-health.ts scripts/test-source-health.ts package.json
git commit -m "Evaluate capability health against its own database and emit an evaluation trace"
```

---

### Task 3: Dependency, generation alignment, and the NIBRS artifact check

**Files:** Modify `lib/source-health.ts`, `scripts/test-source-health.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
const sample = specFor("current", "sample_agencies")!;

function currentFixture(mutate?: (db: Database.Database) => void): Database.Database {
  const db = new Database(path.join(dir, `cur-${Math.random().toString(36).slice(2)}.db`));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE national_monthly (year INTEGER, month INTEGER, offense TEXT, count INTEGER);
    CREATE TABLE sample_agencies (ori TEXT PRIMARY KEY);
    CREATE TABLE agency_monthly (ori TEXT, year INTEGER, month INTEGER, murders INTEGER);
  `);
  db.prepare("INSERT INTO national_monthly VALUES (?,?,?,?)").run(2022, 1, "murder", 100);
  db.prepare("INSERT INTO sample_agencies VALUES (?)").run("TX0001");
  db.prepare("INSERT INTO agency_monthly VALUES (?,?,?,?)").run("TX0001", 2022, 1, 3);
  mutate?.(db);
  return db;
}

check("a cohort referencing agencies absent upstream stops at dependency", () => {
  const db = currentFixture((d) => {
    d.exec("DELETE FROM agency_monthly");
    d.prepare("INSERT INTO agency_monthly VALUES (?,?,?,?)").run("CA9999", 2022, 1, 5);
  });
  const { health, trace } = evaluateCapability(sample, ctx(db));
  assert.strictEqual(trace.boundary, "dependency");
  assert.strictEqual(health.state, "degraded");
});

check("an aligned dependency is recorded and evaluation continues to the receipt", () => {
  const { trace } = evaluateCapability(sample, ctx(currentFixture()));
  assert.strictEqual(trace.boundary, "missing_receipt");
  assert.deepStrictEqual(trace.dependenciesChecked, ["sample_agencies->agency_monthly"]);
});

check("a NIBRS preflight that inspects a different artifact is degraded", () => {
  // Guards the seam: the inspector reads the configured rollup path while table checks
  // read the provider's handle. If those are different files, the verdict is incoherent.
  const nibrs = specFor("nibrs", "rollup")!;
  const previous = process.env.NIBRS_ROLLUP_DB_PATH;
  process.env.NIBRS_ROLLUP_DB_PATH = path.join(dir, "somewhere-else.db");
  fs.writeFileSync(process.env.NIBRS_ROLLUP_DB_PATH, "");
  const { health, trace } = evaluateCapability(nibrs, ctx(currentFixture()));
  if (previous === undefined) delete process.env.NIBRS_ROLLUP_DB_PATH; else process.env.NIBRS_ROLLUP_DB_PATH = previous;
  assert.ok(["artifact_mismatch", "preflight_failed"].includes(trace.boundary), `unexpected boundary ${trace.boundary}`);
  assert.strictEqual(health.state, "degraded");
});

check("an unconfigured rollup surfaces the inspector's own reason", () => {
  const nibrs = specFor("nibrs", "rollup")!;
  const previous = process.env.NIBRS_ROLLUP_DB_PATH;
  delete process.env.NIBRS_ROLLUP_DB_PATH;
  const { health, trace } = evaluateCapability(nibrs, ctx(currentFixture()));
  if (previous === undefined) delete process.env.NIBRS_ROLLUP_DB_PATH; else process.env.NIBRS_ROLLUP_DB_PATH = previous;
  assert.strictEqual(trace.preflight, "failed");
  assert.match(health.reason ?? "", /rollup-unconfigured/, "the inspector's finding must not be re-derived or lost");
});
```

- [ ] **Step 2: Run it and confirm the dependency cases fail**

Run: `npx tsx scripts/test-source-health.ts`
Expected: FAIL — the orphan case reaches `missing_receipt`.

- [ ] **Step 3: Implement dependency evaluation**

Insert after the table loop, before `trace.coverage`:

```typescript
  for (const rule of spec.dependencies) {
    const derivedSpec = spec.tables.find((table) => table.name === rule.derived);
    const key = derivedSpec?.requiredColumns[0];
    if (!key) return done("unknown", `dependency rule for ${rule.derived} names no shared key`, "dependency");
    try {
      const orphans = db
        .prepare(`SELECT COUNT(*) AS n FROM ${rule.derived} d WHERE NOT EXISTS (SELECT 1 FROM ${rule.upstream} u WHERE u.${key} = d.${key})`)
        .get() as { n: number };
      if (orphans.n > 0) {
        return done("degraded", `${orphans.n} row(s) in ${rule.derived} reference ${key} values absent from ${rule.upstream}`, "dependency");
      }
    } catch (error) {
      return done("unknown", `dependency ${rule.derived}->${rule.upstream} could not be checked: ${(error as Error).message}`, "dependency");
    }
    if (rule.generationColumn) {
      try {
        const g = db
          .prepare(`SELECT (SELECT MAX(${rule.generationColumn}) FROM ${rule.derived}) AS derived, (SELECT MAX(${rule.generationColumn}) FROM ${rule.upstream}) AS upstream`)
          .get() as { derived: number | null; upstream: number | null };
        if (g.derived !== null && g.upstream !== null && g.derived < g.upstream) {
          return done("degraded", `${rule.derived} generation ${g.derived} is older than ${rule.upstream} generation ${g.upstream}`, "dependency");
        }
      } catch (error) {
        return done("unknown", `generation alignment for ${rule.derived} could not be checked: ${(error as Error).message}`, "dependency");
      }
    }
    trace.dependenciesChecked.push(`${rule.derived}->${rule.upstream}`);
  }
```

- [ ] **Step 4: Run it, confirm it passes, commit**

Run: `npx tsx scripts/test-source-health.ts && npx tsc --noEmit`

```bash
git add lib/source-health.ts scripts/test-source-health.ts
git commit -m "Evaluate dependencies, generation alignment, and NIBRS artifact coherence"
```

---

### Task 4: Capability resolution from verified plan evidence

**Files:** Modify `lib/source-health.ts`, `scripts/test-source-health.ts`
**Read first:** `lib/plan-derivation.ts:61-70`, `:235-270`

`verifyPlanDerivation(derivation, executedSql, expectedFamily)` takes **three** arguments; the third is documented "VERIFIED, NOT TRUSTED", and passing it is what stops a token sealed for family A authorizing an answer recorded under family B. Every call passes all three.

```typescript
export function resolveCapability(
  sourceId: SourceId,
  derivation: PlanDerivation | null,
  executedSql: string | null,
  claimedFamily: string | null,
): { capability: string } | { unresolved: string };
```

- [ ] **Step 1: Write the failing tests**

```typescript
import { resolveCapability } from "../lib/source-health";
import { sealPlanDerivation } from "../lib/plan-derivation";

const SQL = "SELECT year, SUM(victim_count) AS victims FROM incidents GROUP BY year";

check("capability comes from a derivation verified against SQL and family", () => {
  const sealed = sealPlanDerivation("deterministic-murder", SQL);
  const resolved = resolveCapability("shr", sealed, SQL, "deterministic-murder");
  assert.ok("capability" in resolved, JSON.stringify(resolved));
  assert.strictEqual((resolved as { capability: string }).capability, "incidents");
});

check("no derivation resolves to nothing", () => {
  assert.ok("unresolved" in resolveCapability("shr", null, SQL, "deterministic-murder"));
});

check("SQL that does not match the sealed fingerprint is rejected", () => {
  const sealed = sealPlanDerivation("deterministic-murder", SQL);
  assert.ok("unresolved" in resolveCapability("shr", sealed, "SELECT 1", "deterministic-murder"));
});

check("a family claim disagreeing with the token is rejected", () => {
  const sealed = sealPlanDerivation("deterministic-murder", SQL);
  assert.ok("unresolved" in resolveCapability("shr", sealed, SQL, "deterministic-shooting"));
});

check("a family belonging to another source cannot select this source's capability", () => {
  const sealed = sealPlanDerivation("deterministic-murder", SQL);
  assert.ok("unresolved" in resolveCapability("current", sealed, SQL, "deterministic-murder"));
});

check("an unmapped family resolves to nothing rather than a default", () => {
  const sealed = sealPlanDerivation("family-nobody-mapped", SQL);
  assert.ok("unresolved" in resolveCapability("shr", sealed, SQL, "family-nobody-mapped"));
});
```

- [ ] **Step 2: Run it, confirm it fails, implement**

```typescript
import { verifyPlanDerivation, type PlanDerivation } from "./plan-derivation";
import { capabilityForFamily } from "./source-health-inventory";

export function resolveCapability(
  sourceId: SourceId,
  derivation: PlanDerivation | null,
  executedSql: string | null,
  claimedFamily: string | null,
): { capability: string } | { unresolved: string } {
  if (!derivation) return { unresolved: "no verified plan derivation was sealed for this answer" };
  const verified = verifyPlanDerivation(derivation, executedSql, claimedFamily);
  if (!verified.ok) return { unresolved: `plan derivation not verified: ${verified.reason}` };
  const capability = capabilityForFamily(sourceId, derivation.planFamily);
  if (!capability) return { unresolved: `plan family '${derivation.planFamily}' maps to no capability for ${sourceId}` };
  return { capability };
}
```

- [ ] **Step 3: Run it, confirm it passes, commit**

```bash
git add lib/source-health.ts scripts/test-source-health.ts
git commit -m "Resolve capability identity only from a fully verified plan derivation"
```

---

### Task 5: Flag gate, handle-identity cache, and trace exposure

**Files:** Modify `lib/source-health.ts`, `lib/proof-modes.ts`, `scripts/test-source-health.ts`

```typescript
export function sourceHealthFor(
  sourceId: SourceId, derivation: PlanDerivation | null, executedSql: string | null,
  claimedFamily: string | null, context: HealthContext, env?: NodeJS.ProcessEnv,
): SourceHealth;
export function __resetSourceHealthCacheForTests(): void;
/** Full traces, in order. Test-only. */
export function __healthTracesForTests(): HealthTrace[];
```

- [ ] **Step 1: Write the failing tests**

```typescript
import { sourceHealthFor, __resetSourceHealthCacheForTests, __healthTracesForTests } from "../lib/source-health";

const shrSealed = sealPlanDerivation("deterministic-murder", SQL);
const enabled = { PROOF_MODE: "shadow", PROOF_CAPABILITY_SHR_INCIDENTS: "on" };
const call = (c: ReturnType<typeof ctx>, env: NodeJS.ProcessEnv) =>
  sourceHealthFor("shr", shrSealed, SQL, "deterministic-murder", c, env);

check("an UNSET capability flag does not enable probing", () => {
  __resetSourceHealthCacheForTests();
  const health = call(ctx(shrFixture()), { PROOF_MODE: "shadow" });
  assert.strictEqual(health.state, "unknown");
  assert.match(health.reason ?? "", /not enabled/);
  assert.deepStrictEqual(__healthTracesForTests(), []);
});

check("an enabled capability evaluates and reaches the receipt boundary", () => {
  __resetSourceHealthCacheForTests();
  call(ctx(shrFixture()), enabled);
  const traces = __healthTracesForTests();
  assert.strictEqual(traces.length, 1);
  assert.strictEqual(traces[0].capability, "incidents");
  assert.strictEqual(traces[0].boundary, "missing_receipt");
  assert.deepStrictEqual(traces[0].tablesChecked, ["incidents"]);
});

check("an explicitly disabled capability is not probed", () => {
  __resetSourceHealthCacheForTests();
  call(ctx(shrFixture()), { PROOF_MODE: "shadow", PROOF_CAPABILITY_SHR_INCIDENTS: "off" });
  assert.deepStrictEqual(__healthTracesForTests(), []);
});

check("with proof OFF no source-health work runs at all", () => {
  __resetSourceHealthCacheForTests();
  const health = call(ctx(shrFixture()), { PROOF_CAPABILITY_SHR_INCIDENTS: "on" });
  assert.strictEqual(health.state, "unknown");
  assert.deepStrictEqual(__healthTracesForTests(), []);
});

check("a verdict for one database is never replayed for another", () => {
  __resetSourceHealthCacheForTests();
  const good = shrFixture();
  const broken = shrFixture((d) => d.exec("DELETE FROM incidents"));
  assert.match(call(ctx(good), enabled).reason ?? "", /receipt/);
  assert.strictEqual(call(ctx(broken), enabled).state, "degraded");
  const traces = __healthTracesForTests();
  assert.strictEqual(traces.length, 2);
  assert.notStrictEqual(traces[0].dbIdentity, traces[1].dbIdentity, "identity must distinguish the handles");
});

check("the same handle and period is served from cache", () => {
  __resetSourceHealthCacheForTests();
  const db = shrFixture();
  call(ctx(db), enabled);
  call(ctx(db), enabled);
  assert.strictEqual(__healthTracesForTests().length, 1);
});

check("a different requested period re-probes the same handle", () => {
  __resetSourceHealthCacheForTests();
  const db = shrFixture();
  call(ctx(db, [2022]), enabled);
  call(ctx(db, [2019]), enabled);
  assert.strictEqual(__healthTracesForTests().length, 2);
});
```

- [ ] **Step 2: Add `envKeyForCapability` to `lib/proof-modes.ts`**

```typescript
/**
 * Kill switch for one capability of one source, mirroring envKeyForFamily.
 *
 * Read as default-OFF: only an explicit enabling value turns probing on, because §13
 * requires every new capability to default to off and an unset variable is not a
 * decision anyone made.
 */
export function envKeyForCapability(sourceId: SourceId, capability: string): string {
  return `PROOF_CAPABILITY_${sourceId.toUpperCase()}_${capability.toUpperCase()}`;
}
```

- [ ] **Step 3: Implement the gate, cache, and trace log**

```typescript
import { envKeyForCapability, isObserving, resolveMode } from "./proof-modes";
import { specFor } from "./source-health-inventory";

export const HEALTH_CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; health: SourceHealth }>();
const traces: HealthTrace[] = [];

function unresolvedVerdict(sourceId: SourceId, capability: string, reason: string): SourceHealth {
  return { sourceId, capability, state: "unknown", reason, dataVersion: null, requestedCoverage: "unknown" };
}

export function sourceHealthFor(
  sourceId: SourceId, derivation: PlanDerivation | null, executedSql: string | null,
  claimedFamily: string | null, context: HealthContext, env: NodeJS.ProcessEnv = process.env,
): SourceHealth {
  // Global mode first: off does no request-path work, and a capability flag cannot
  // override it (invariant 14).
  if (!isObserving(resolveMode(sourceId, null, env).mode)) {
    return unresolvedVerdict(sourceId, "unresolved", "proof system is off for this source");
  }
  const resolved = resolveCapability(sourceId, derivation, executedSql, claimedFamily);
  if ("unresolved" in resolved) return unresolvedVerdict(sourceId, "unresolved", resolved.unresolved);
  const capability = resolved.capability;

  const flagKey = envKeyForCapability(sourceId, capability);
  const flag = (env[flagKey] ?? "").trim().toLowerCase();
  if (flag !== "on" && flag !== "shadow" && flag !== "enforce") {
    return unresolvedVerdict(sourceId, capability, `capability not enabled (${flagKey} is '${flag || "unset"}')`);
  }
  const spec = specFor(sourceId, capability);
  if (!spec) return unresolvedVerdict(sourceId, capability, `no inventory entry for ${sourceId}:${capability}`);

  /**
   * Cache key includes NON-FORGEABLE handle identity. A caller-supplied identity string
   * would only prove two LABELS differ; reusing one label across handles would inherit
   * another database's verdict. The identity comes from a WeakMap on the handle itself.
   */
  const probeOpened = context.dbOverride !== undefined ? context.dbOverride : spec.database.acquire();
  const period = [...(context.requestedYears ?? [])].sort((a, b) => a - b).join(",");
  const key = `${sourceId}:${capability}:${identityOf((probeOpened?.db ?? null) as object | null)}:${period}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < HEALTH_CACHE_TTL_MS) return hit.health;

  const budget = budgetMs(env);
  if (budget === 0) {
    const skipped = unresolvedVerdict(sourceId, capability, "source-health budget is 0ms; no probe ran");
    cache.set(key, { at: Date.now(), health: skipped });
    return skipped;
  }

  const startedAt = Date.now();
  let health: SourceHealth;
  try {
    const evaluated = evaluateCapability(spec, { ...context, dbOverride: probeOpened });
    health = evaluated.health;
    traces.push(evaluated.trace);
  } catch (error) {
    // A probe must never take down a response (§13, invariant 15).
    health = unresolvedVerdict(sourceId, capability, `probe threw: ${(error as Error).message}`);
    traces.push({
      sourceId, capability, dbIdentity: identityOf((probeOpened?.db ?? null) as object | null),
      dbPath: probeOpened?.resolvedPath ?? null,
      preflight: "skipped", tablesChecked: [], dependenciesChecked: [], coverage: "unknown", boundary: "threw",
    });
  }
  const elapsed = Date.now() - startedAt;
  if (elapsed > budget) {
    health = unresolvedVerdict(sourceId, capability, `probe exceeded its ${budget}ms budget (${elapsed}ms); verdict not treated as health`);
  }
  cache.set(key, { at: Date.now(), health });
  return health;
}

export function __resetSourceHealthCacheForTests(): void { cache.clear(); traces.length = 0; }
export function __healthTracesForTests(): HealthTrace[] { return [...traces]; }
```

- [ ] **Step 4: Run it, confirm it passes, commit**

Run: `npx tsx scripts/test-source-health.ts && npx tsc --noEmit`

```bash
git add lib/source-health.ts lib/proof-modes.ts scripts/test-source-health.ts
git commit -m "Gate probing default-off and key the cache by non-forgeable handle identity"
```

---

### Task 6: Budget switch — explicitly NOT a timeout

**Files:** Modify `lib/source-health.ts`, `scripts/test-source-health.ts`

**This does not satisfy §13's timeout requirement and must not be described as doing so.** better-sqlite3 is synchronous: by the time elapsed time is known, the caller has already paid it. This adds (a) an operator switch that performs no health work and (b) a refusal to present a slow verdict as health. **Hard isolation — interruptible worker, or background refresh where a cache miss synchronously returns `unknown` — is Stage 2B, and Stage 2 cannot close without it** (completion criterion 8).

- [ ] **Step 1: Write the failing test**

```typescript
check("a zero budget performs no health work at all", () => {
  __resetSourceHealthCacheForTests();
  const health = call(ctx(shrFixture()), { ...enabled, PROOF_HEALTH_BUDGET_MS: "0" });
  assert.strictEqual(health.state, "unknown");
  assert.match(health.reason ?? "", /budget/);
  assert.deepStrictEqual(__healthTracesForTests(), [], "a zero budget must not evaluate");
});
```

- [ ] **Step 2: Run it, confirm it fails, implement**

```typescript
const DEFAULT_HEALTH_BUDGET_MS = 250;
function budgetMs(env: NodeJS.ProcessEnv): number {
  const raw = (env.PROOF_HEALTH_BUDGET_MS ?? "").trim();
  if (raw === "") return DEFAULT_HEALTH_BUDGET_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_HEALTH_BUDGET_MS;
}
```

- [ ] **Step 3: Run it, confirm it passes, commit**

```bash
git add lib/source-health.ts scripts/test-source-health.ts
git commit -m "Add a source-health budget switch and record overruns as unknown (not a timeout)"
```

---

### Task 7: Map the verdict onto the proof manifest

**Files:** Modify `lib/proof-finalize.ts:436-450`; create `scripts/test-source-health-wiring.ts`; modify `package.json`
**Read first:** `lib/proof-contract.ts:184-215`, `:281-303`; `lib/omission-attribution.ts:55-70`, `:224-230`

Because capabilities own their providers, the route does **not** need to pass a database. It passes only the request period and the evidence.

- [ ] **Step 1: Write the failing mapping test**

```typescript
// scripts/test-source-health-wiring.ts
import assert from "node:assert";
import { healthToCheckState } from "../lib/proof-finalize";

check("the three states map onto the manifest's CheckState", () => {
  assert.strictEqual(healthToCheckState("healthy"), "passed");
  assert.strictEqual(healthToCheckState("degraded"), "failed");
  assert.strictEqual(healthToCheckState("unknown"), "unknown");
});
```

- [ ] **Step 2: Run it, confirm it fails, implement the mapping and wiring**

```typescript
/**
 * The manifest records health as a CheckState; the registry speaks in health states.
 * `degraded` maps to `failed` because it is an established negative finding; `unknown`
 * maps to itself because §8 treats it as degraded at the GATE without rewriting evidence.
 */
export function healthToCheckState(state: SourceHealthState): CheckState {
  if (state === "healthy") return "passed";
  if (state === "degraded") return "failed";
  return "unknown";
}
```

```typescript
    const health = sourceHealthFor(
      input.sourceId,
      input.planDerivation ?? null,
      input.sql,
      manifest.planFamily,
      { requestedYears: requestedYearsFromContract(contract) },
      env,
    );
    manifest.source.dataVersion = health.dataVersion;
    manifest.source.health = healthToCheckState(health.state);
    manifest.source.requestedCoverage = health.requestedCoverage;

    const attribution = attributeOmissions(omittedCandidates, {
      sourceId: input.sourceId,
      db: input.db ?? null,
      sourceYearRange: input.sourceYearRange ?? null,
      // RAW state, deliberately. Only `degraded` yields source_unhealthy; coercing
      // `unknown` to `degraded` here would stamp a failure nobody checked for onto every
      // omission and mask the probe evidence.
      sourceHealth: health.state,
    });
```

- [ ] **Step 3: Add the gate-agreement test**

```typescript
import { permitsAnswer, factualDeliveryBlocker, createProofManifest, PROOF_CHECKS } from "../lib/proof-contract";

check("permitsAnswer and factualDeliveryBlocker agree on every health verdict", () => {
  const cases = [
    { state: "healthy", coverage: "passed", dataVersion: "receipt-1" },
    { state: "healthy", coverage: "failed", dataVersion: "receipt-1" },
    { state: "healthy", coverage: "passed", dataVersion: null },      // the Stage 2A shape
    { state: "degraded", coverage: "passed", dataVersion: "receipt-1" },
    { state: "unknown", coverage: "passed", dataVersion: null },
  ] as const;
  for (const c of cases) {
    const health = {
      sourceId: "current" as const, capability: "national",
      state: c.state, reason: null, dataVersion: c.dataVersion, requestedCoverage: c.coverage,
    };
    const manifest = createProofManifest("current", "deterministic");
    manifest.planFamily = "metadata-coverage-answer";
    for (const check of PROOF_CHECKS) manifest.checks[check] = "passed";
    manifest.source.dataVersion = health.dataVersion;
    manifest.source.health = healthToCheckState(health.state);
    manifest.source.requestedCoverage = health.requestedCoverage;
    assert.strictEqual(
      permitsAnswer(health),
      factualDeliveryBlocker(manifest) === null,
      `disagreement for ${JSON.stringify(c)}: gate said ${factualDeliveryBlocker(manifest)}`,
    );
  }
});
```

- [ ] **Step 4: Run it and commit**

Run: `npx tsx scripts/test-source-health-wiring.ts && npx tsx scripts/test-proof-finalize.ts && npx tsc --noEmit`

If `test-proof-finalize.ts` fails on an assertion that health is `"unknown"`, that encoded the Stage 1 placeholder — update it and say so in the commit message.

```bash
git add lib/proof-finalize.ts scripts/test-source-health-wiring.ts scripts/test-proof-finalize.ts package.json
git commit -m "Map the source-health verdict onto the proof manifest and the delivery gate"
```

---

### Task 8: Stage 2A cannot authorize an answer; capabilities are isolated

**Files:** Modify `scripts/test-source-health-wiring.ts`

- [ ] **Step 1: Write the tests**

```typescript
check("no Stage 2A verdict can authorize a factual answer", () => {
  const env = { PROOF_MODE: "shadow", PROOF_CAPABILITY_SHR_INCIDENTS: "on" };
  const health = sourceHealthFor("shr", shrSealed, SQL, "deterministic-murder", ctx(shrFixture()), env);
  assert.strictEqual(health.dataVersion, null);
  assert.strictEqual(permitsAnswer(health), false);
  const manifest = createProofManifest("shr", "deterministic");
  manifest.planFamily = "deterministic-murder";
  for (const check of PROOF_CHECKS) manifest.checks[check] = "passed";
  manifest.source.dataVersion = health.dataVersion;
  manifest.source.health = healthToCheckState(health.state);
  manifest.source.requestedCoverage = health.requestedCoverage;
  assert.match(factualDeliveryBlocker(manifest) ?? "", /dataVersion/);
});

check("breaking one capability leaves unrelated capabilities alone", () => {
  __resetSourceHealthCacheForTests();
  const env = { PROOF_MODE: "shadow", PROOF_CAPABILITY_SHR_INCIDENTS: "on", PROOF_CAPABILITY_CURRENT_NATIONAL: "on" };
  const brokenShr = sourceHealthFor("shr", shrSealed, SQL, "deterministic-murder",
    ctx(shrFixture((d) => d.exec("DELETE FROM incidents"))), env);
  const nationalSql = "SELECT year, count FROM national_monthly";
  const nationalSealed = sealPlanDerivation("metadata-coverage-answer", nationalSql);
  const currentHealth = sourceHealthFor("current", nationalSealed, nationalSql, "metadata-coverage-answer",
    ctx(currentFixture()), env);
  assert.strictEqual(brokenShr.state, "degraded");
  assert.notStrictEqual(currentHealth.state, "degraded");
  // And both actually evaluated, so this is isolation rather than two no-ops.
  const boundaries = __healthTracesForTests().map((t) => `${t.sourceId}:${t.boundary}`);
  assert.ok(boundaries.includes("shr:row_bounds"), `expected shr to fail on rows, saw ${boundaries.join(",")}`);
  assert.ok(boundaries.includes("current:missing_receipt"), `expected current to reach the receipt, saw ${boundaries.join(",")}`);
});
```

- [ ] **Step 2: Run it and commit**

```bash
git add scripts/test-source-health-wiring.ts
git commit -m "Pin that Stage 2A cannot authorize an answer, and that capabilities are isolated"
```

---

### Task 9: Route-level invariants across all five source identities

**Files:** Modify `scripts/test-shadow-route-equivalence.ts`

Two gaps this closes: the suite's four handler cases exercise only **four** source identities, because the Current/Historical handler is driven with a Current question; and enabling flags proves nothing unless a capability was evaluated **and reached the receipt boundary**.

- [ ] **Step 1: Add a Historical route case**

The `/api/query` handler selects Historical via `mode: "historical"` in the request body. Add a fifth `RouteCase` with `expectedSource: "historical"`, a historical question, `mode: "historical"` threaded into the request body, SQL over `historical_state_national`, and matching fixture tables added to the RTCI fixture database:

```typescript
{
  label: "app/api/query (historical)",
  importPath: "../app/api/query/route",
  expectedSource: "historical",
  mode: "historical",
  question: "how many murders in Texas each year from 2019 to 2022 statewide",
  coldCalls: ["translate", "explain"],
  reply: {
    sql: "SELECT year, murders FROM historical_state_national WHERE state = 'Texas' AND year BETWEEN 2019 AND 2022 ORDER BY year",
    explanation: "Murders in Texas by year.",
    title: "Murders in Texas",
    chartHint: "line", xAxis: "year", yAxis: "murders",
  },
},
```

Extend the fixture builder with `historical_agency`, `historical_agency_crime`, `historical_state_national`, and `agency_year_reliability`, populated for 2019–2022, and thread `mode` through the request body in `ask()`.

- [ ] **Step 2: Add the Stage 2 axis with boundary assertions**

```typescript
import { __resetSourceHealthCacheForTests, __healthTracesForTests } from "../lib/source-health";

console.log(`\n${route.label} -- Stage 2 source health enabled`);
{
  const question = `${route.question} stage2-case`;
  const CAPS: Record<string, string> = {
    PROOF_CAPABILITY_CURRENT_NATIONAL: "on",
    PROOF_CAPABILITY_CURRENT_SAMPLE_AGENCIES: "on",
    PROOF_CAPABILITY_HISTORICAL_AGENCY_CRIME: "on",
    PROOF_CAPABILITY_HISTORICAL_STATE_NATIONAL: "on",
    PROOF_CAPABILITY_NIBRS_SUMMARY: "on",
    PROOF_CAPABILITY_NIBRS_ROLLUP: "on",
    PROOF_CAPABILITY_SHR_INCIDENTS: "on",
    PROOF_CAPABILITY_HATE_CRIME_INCIDENTS: "on",
  };
  const withCaps = async (mode: string | undefined, q: string) => {
    const saved = Object.fromEntries(Object.keys(CAPS).map((k) => [k, process.env[k]]));
    Object.assign(process.env, CAPS);
    try { return await underMode(mode, q); }
    finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };

  __resetResponseCacheForTests();
  const off = await underMode(undefined, question);
  __resetResponseCacheForTests();
  __resetSourceHealthCacheForTests();
  const stage2 = await withCaps("shadow", question);
  const traces = __healthTracesForTests();

  await check(`${route.label}: structural health was actually evaluated`, () => {
    // The four assertions that stop "evaluation called, returned unknown before doing
    // anything" from counting as evidence.
    assert.ok(traces.length > 0, "no capability was evaluated; the equivalence check below would be vacuous");
    const mine = traces.filter((t) => t.sourceId === route.expectedSource);
    assert.ok(mine.length > 0, `expected a ${route.expectedSource} capability, saw ${traces.map((t) => t.sourceId).join(",")}`);
    const trace = mine[0];
    assert.notStrictEqual(trace.dbIdentity, "no-db", "the capability must have reached a real database");
    assert.ok(trace.tablesChecked.length > 0, `no table was checked; boundary was ${trace.boundary}`);
    assert.strictEqual(
      trace.boundary, "missing_receipt",
      `structural evaluation must SUCCEED and stop only at the missing receipt; stopped at ${trace.boundary}`,
    );
  });

  await check(`${route.label}: enabling source health changes nothing a caller sees`, () => {
    assert.strictEqual(stage2.status, off.status);
    assert.strictEqual(stage2.contentType, off.contentType);
    assert.strictEqual(stage2.body, off.body, "the response must stay byte-for-byte identical");
    assert.deepStrictEqual(stage2.calls, off.calls, "the model-call sequence must not change");
  });
}
```

- [ ] **Step 3: Run it. If no capability is evaluated, fix the FIXTURE, not the assertion**

Run: `npx tsx scripts/test-shadow-route-equivalence.ts`

A failure means the fixture question does not reach a deterministic typed-plan path, so no derivation is sealed. Steer the question onto a family present in `CAPABILITY_BY_SOURCE_AND_FAMILY`, or point the capability's provider at the fixture database via the suite's env variables. If a route genuinely has no such path yet, mark the capability `stage2aReachable: false` with a reason and skip that route's Stage 2 axis, naming the reason in the skip message. **Do not weaken the assertion.**

- [ ] **Step 4: Confirm the comparison is still live**

Make the stub's reply mode-dependent (append a word to `title` under shadow) and confirm the equivalence checks FAIL; then revert. Perturbing the question is not a valid probe — the Current/Historical SSE payload does not echo it.

- [ ] **Step 5: Add the probe-failure isolation test**

```typescript
await check(`${route.label}: a throwing probe changes neither the response nor the log`, () => {
  // Invariant 15. A VIEW over a dropped table makes PRAGMA table_info succeed while
  // SELECT COUNT(*) throws: CREATE TABLE gone(...); CREATE VIEW incidents AS SELECT *
  // FROM gone; DROP TABLE gone;
});
```

Implement that fixture, assert the body equals the `off` body, assert a `query_log` row was still written, and assert the trace boundary is `threw`.

- [ ] **Step 6: Run everything and commit**

Run: `npx tsc --noEmit && npm test`
Expected: exit 0. A **127** exit is the known npx-cache flake — re-run once.

```bash
git add scripts/test-shadow-route-equivalence.ts
git commit -m "Prove Stage 2 evaluates real structure across all five sources without changing responses"
```

---

### Task 10: Embed reads — both halves of §4

**Files:** Modify `lib/embed-origin.ts`, `app/api/embed/route.ts`, `scripts/migrate-shared-charts-proof.js`, `scripts/test-embed-origin.ts`, `scripts/test-shadow-equivalence.ts`

§4 requires embed reads to apply **current** source health. Three facts make this its own task.

First, `app/api/embed/route.ts:248` passes no database — fixed by capability-owned providers.

Second, the same call deliberately passes **no derivation**: "this read has no token of its own, so derivation stays absent rather than inheriting a claim from a different request." So `resolveCapability` can never resolve from a token here. Treating that as permanent would make *every* embed read `unresolved`, and §4's "legacy embeds must not be silently treated as compliant" would be satisfied only by never being compliant — an outage, not the contract.

Third — and this is where an earlier draft of this plan was simply wrong — **POST does not hold the originating finalization.** It holds an `OriginVerdict` from `verifyEmbedOrigin()`, which today is `{ state, reason, deliveryAction, proofMode }` (`lib/embed-origin.ts:77-85`). There is no plan family in it, so there is currently no trusted source for one. `embedPlanFamily()` (`:343`) returns a family describing the *read* (`embed-verified-origin`, `embed-legacy-unproved`), not the originating answer's family, and must not be confused for it.

So the evidence has to be produced where the verification happens: extend `OriginVerdict` with `planFamily`, extracted server-side from the verified proof envelope on the matching `query_log` row. The family must be `null` for absent, unbound, malformed, unproved, incompatible-version, and source-mismatched records. Only then may POST persist it, and only when `originIsVerified(origin)` holds and the family maps to the same source as the chart's tab.

Nothing about the family comes from the embed client, at creation or on read. It still cannot make a read `healthy` in 2A, because the receipt is absent.

- [ ] **Step 1: Add the additive column**

In `scripts/migrate-shared-charts-proof.js`, add to the column list alongside `origin_request_id` / `origin_state`:

```javascript
  { name: "origin_plan_family", type: "TEXT" },
```

Nullable and additive, so the baseline release `c2b52ca` still reads the table.

- [ ] **Step 2: Extend `OriginVerdict` with a server-extracted plan family**

Add the field to the interface at `lib/embed-origin.ts:77`:

```typescript
export interface OriginVerdict {
  state: OriginState;
  reason: string;
  deliveryAction: string | null;
  proofMode: string | null;
  /**
   * The ORIGINATING answer's typed plan family, read from the verified proof envelope on
   * the matching query_log row.
   *
   * Null unless this verdict is `verified` AND the envelope actually carried a usable
   * family. Distinct from embedPlanFamily(), which names the READ (`embed-verified-origin`)
   * and says nothing about what the original answer queried. Never supplied by a client.
   */
  planFamily: string | null;
}
```

Every existing `return` in `verifyEmbedOrigin()` gains `planFamily: null`; only the verified branch may set it, and only from the envelope:

```typescript
/**
 * Plan family from a stored proof envelope, or null.
 *
 * Validated, not trusted: the envelope must parse, must carry the current manifest
 * version, and must name a non-empty family. An envelope written by a newer schema is
 * NOT read with today's semantics -- the same rule the digest reporter applies.
 */
function planFamilyFromEnvelope(json: string | null | undefined): string | null {
  if (!json) return null;
  let envelope: unknown;
  try { envelope = JSON.parse(json); } catch { return null; }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const manifest = (envelope as { manifest?: unknown }).manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  const record = manifest as { v?: unknown; planFamily?: unknown };
  if (record.v !== PROOF_MANIFEST_VERSION) return null;
  const family = typeof record.planFamily === "string" ? record.planFamily.trim() : "";
  return family === "" ? null : family;
}
```

Select `proof_manifest` alongside the columns the verifier already reads, and set
`planFamily: planFamilyFromEnvelope(row.proof_manifest)` on the verified branch only.

- [ ] **Step 3: Write the failing `lib/embed-origin.ts` regressions**

In `scripts/test-embed-origin.ts`:

```typescript
check("a verified origin carries the originating plan family", () => {
  // Row written with a v1 envelope naming a real family.
  const verdict = verifyEmbedOrigin(db, candidate);
  assert.strictEqual(verdict.state, "verified");
  assert.strictEqual(verdict.planFamily, "deterministic-murder");
});

check("planFamily is null for every non-verified state", () => {
  // absent (no request id), unbound (no db), and bound_unproven must all report null:
  // a family is evidence about a PROVEN answer, and attaching one to an unproven record
  // would let the embed read name a capability it never earned.
  assert.strictEqual(verifyEmbedOrigin(db, { ...candidate, requestId: null }).planFamily, null);
  assert.strictEqual(verifyEmbedOrigin(null, candidate).planFamily, null);
  // plus the existing bound_unproven fixture
});

check("a malformed, unversioned, or newer-schema envelope yields null", () => {
  for (const envelope of ["{not json", "{}", JSON.stringify({ manifest: { v: 2, planFamily: "x" } }), JSON.stringify({ manifest: { v: 1 } })]) {
    // Rewrite the row's proof_manifest to `envelope`, re-verify, and assert null.
  }
});

check("embedPlanFamily still describes the READ, not the origin", () => {
  // Guards against the two being conflated later.
  assert.strictEqual(embedPlanFamily({ state: "verified" } as never), "embed-verified-origin");
});
```

- [ ] **Step 4: Write the failing embed-read tests — both halves**

In `scripts/test-shadow-equivalence.ts`:

```typescript
import { __resetSourceHealthCacheForTests, __healthTracesForTests } from "../lib/source-health";

await check("a legacy embed with no origin evidence is unresolved and not compliant", () => {
  // Half one of §4. A chart created before this work has a NULL origin.
  __resetSourceHealthCacheForTests();
  // Insert a row directly with origin_state NULL and origin_plan_family NULL, read it
  // with capabilities enabled, then assert:
  //   - the recorded manifest has source.health "unknown", NOT "passed";
  //   - factualDeliveryBlocker on that manifest is non-null;
  //   - no capability was evaluated (nothing to resolve).
});

await check("a proved embed resolves its capability and evaluates CURRENT source health", () => {
  // Half two, the half a legacy-only test cannot reach. Create through POST so the origin
  // evidence is written from a verified finalization, then read with capabilities enabled:
  //   - a trace exists for the chart's source;
  //   - trace.dbIdentity is not "no-db" and trace.tablesChecked is non-empty;
  //   - trace.boundary is "missing_receipt" -- current structure was evaluated;
  //   - the manifest still records health "unknown" because the receipt is absent;
  //   - the response is byte-identical to the off-mode read.
});
```

- [ ] **Step 5: Run them and confirm they fail**

Run: `npx tsx scripts/test-embed-origin.ts && npx tsx scripts/test-shadow-equivalence.ts`
Expected: FAIL — `OriginVerdict` has no `planFamily`, so nothing can be persisted or recovered.

- [ ] **Step 6: Persist and recover the evidence**

At creation, POST already computes `origin = verifyEmbedOrigin(...)`. Store
`origin.planFamily` into `origin_plan_family` **only when both hold**:

```typescript
    const originFamily =
      originIsVerified(origin) &&
      origin.planFamily &&
      capabilityForFamily(sourceForTab(body.tab), origin.planFamily) !== null
        ? origin.planFamily
        : null;
```

The second condition matters as much as the first: a family that maps to no capability for
*this chart's source* is a source mismatch, and persisting it would let a read select
another source's capability. On read, recover the column and pass it as the claimed family
only when the stored `origin_state` is `verified`; otherwise pass null so the read stays
unresolved and fails closed.

Because the read still has no sealed derivation, `resolveCapability` must accept this path explicitly rather than by loosening its rules. Add a narrow second entry point used only here:

```typescript
/**
 * Capability for a replayed embed read.
 *
 * Separate from resolveCapability ON PURPOSE: that function's contract is "a verified
 * token or nothing", and widening it would let any caller skip verification. This path
 * trusts SERVER-PERSISTED evidence instead -- a plan family that verifyEmbedOrigin()
 * extracted from the originating answer's proof envelope and that POST stored only for a
 * verified, source-matched origin -- and only when the stored origin verdict is
 * `verified`. It can still never produce `healthy` in Stage 2A.
 */
export function resolveCapabilityFromPersistedOrigin(
  sourceId: SourceId, originState: string | null, originPlanFamily: string | null,
): { capability: string } | { unresolved: string } {
  if (originState !== "verified") return { unresolved: `origin state '${originState ?? "absent"}' is not a verified origin` };
  if (!originPlanFamily) return { unresolved: "origin evidence records no plan family" };
  const capability = capabilityForFamily(sourceId, originPlanFamily);
  if (!capability) return { unresolved: `origin family '${originPlanFamily}' maps to no capability for ${sourceId}` };
  return { capability };
}
```

Thread it through a `sourceHealthForPersistedOrigin(...)` wrapper that shares the flag gate, cache, budget and trace logging with `sourceHealthFor`, so the embed path cannot drift from the query path.

- [ ] **Step 7: Run everything, confirming the legacy case still fails closed**

Run: `npx tsx scripts/test-shadow-equivalence.ts && npx tsx scripts/test-embed-origin.ts && npx tsx scripts/test-embed-proof.ts && npx tsc --noEmit`

- [ ] **Step 8: Run the whole suite and commit**

Run: `npm test`

```bash
git add lib/embed-origin.ts app/api/embed/route.ts scripts/migrate-shared-charts-proof.js         lib/source-health.ts scripts/test-embed-origin.ts scripts/test-shadow-equivalence.ts
git commit -m "Carry the originating plan family in OriginVerdict and apply source health on embed reads"
```

---

## Stage 2 completion criteria

**Stage 2A (this plan) delivers:** the five-source capability inventory with per-source family keying and capability-owned database providers; the structural evaluator with preflight adapter, artifact-coherence check, required columns, row bounds, dependencies and generation alignment; evaluation traces; capability resolution from verified tokens and, for embeds, from additive server-persisted origin evidence; the default-off flag gate; the budget switch; manifest wiring; and `unknown` verdicts wherever receipts are absent.

**Stage 2B delivers:** real build/import receipts in the summary builders and importers (start, finish, source version, schema version, input/output counts, reconciliation status); genuine `dataVersion` values so `healthy` becomes reachable; **and hard timeout isolation**.

**Stage 2 closes only when both have landed and these combined fixtures pass:**

1. Every relevant capability across all five sources produces an evidence-backed verdict — with a trace showing a real database and real checks, not merely an invocation.
2. `unknown`, or a missing receipt, can never authorize an answer.
3. Stale data answers only the periods it actually covers.
4. Breaking one capability does not degrade unrelated capabilities.
5. Source health reaches `manifest.source` **and** the delivery gate, with `permitsAnswer()` and `factualDeliveryBlocker()` in agreement.
6. `off` performs no request-path source-health work.
7. Shadow remains user-invisible at the route level **and on embed reads**.
8. **A probe cannot delay a response**: hard timeout isolation exists, not an after-the-fact latency observation.

Asserted by this plan: 1 (Tasks 1, 9, 10 — trace boundary `missing_receipt`), 4 (Task 8), 5 (Task 7), 6 (Task 5), 7 (Tasks 9, 10). Partial: 3 — coverage is computed and traced (Task 2), but "answers only periods it covers" is enforceable only once a healthy verdict exists, i.e. after 2B. Vacuous in 2A and therefore **must be re-asserted in 2B**: 2, because nothing can be healthy yet, so 2B must prove it again against a real receipt that is then withdrawn. Not addressed in 2A: 8.

## Self-Review

**Spec coverage.** §8 inputs: database open/read → capability-owned providers (Task 1) plus the `no_database` boundary (Task 2); required tables *and* columns → Task 2, with the Task 1 test rejecting any spec naming no columns; row bounds → `minRows`, empty-permitting specs rejected; builder/import receipt → `receiptKey` and the `missing_receipt` boundary, implemented in 2B; freshness for the exact requested period → `coverageFor` plus the normalized period in the cache key; dependencies between raw source, summaries, completeness and cohort tables → Task 3. §8 per-source: Current national and sample-agency independent → separate entries, asserted distinct; Historical tables + reliability metadata + latest year → `historical:agency_crime` including `agency_year_reliability`, and exercised at the route level by the new Historical case (Task 9); NIBRS extended with receipts and requested-period coverage → two capabilities over two artifacts (`nibrs:summary` on the main database, `nibrs:rollup` on the rollup file opened at the exact path `inspectNibrsRollupAvailability()` reports), with the preflight adapter reusing that inspector and the artifact-coherence check confirming both halves describe one file; SHR expected incident data and required structures → `shr:incidents`. §4 embed reads apply current source health → Task 10, both halves. §Stage 2 bullets: registry + cache → Tasks 2, 5; probes → Tasks 1–3; response behavior + kill switches → Tasks 5, 7; healthy/degraded/stale/unknown exercised → Tasks 2, 3, 8, with `healthy` deferred to 2B and stated.

**Deliberate gaps, all named:** no `healthy` verdict reachable in 2A; `dataVersion` always `null`; hard timeout isolation deferred to 2B as criterion 8.

**Placeholder scan.** `CAPABILITY_BY_SOURCE_AND_FAMILY` ships concrete rows to be replaced by the Task 1 Step 1 enumeration, and the non-vacuity test fails if a reachable capability ends up unmapped. Task 9 Step 5 and Task 10 Step 2 state their mechanisms (a view over a dropped table; direct row insertion versus creation through POST) rather than "add error handling".

**Type consistency.** `DatabaseProvider` is a single `acquire(): OpenedDatabase | null` everywhere; there is no separate `path()` that could disagree with the handle. `Preflight` takes that same `OpenedDatabase`. `HealthContext` is `{ requestedYears, dbOverride?: OpenedDatabase | null }` from Task 2 onward — no caller-supplied identity, and no required database, because capabilities own their providers. `evaluateCapability` returns `{ health, trace }` in Tasks 2, 3, 5. `sourceHealthFor(sourceId, derivation, executedSql, claimedFamily, context, env?)` keeps that shape in Tasks 5–9, and every call passes all of `derivation`, `executedSql`, `claimedFamily`. `resolveCapability` takes four arguments everywhere; `verifyPlanDerivation` is always called with three. `resolveCapabilityFromPersistedOrigin` is a distinct three-argument function used only by the embed path, fed by `OriginVerdict.planFamily` rather than by any client input. `healthToCheckState` is defined in Task 7 and used in Tasks 7, 8. Every verdict is `SourceHealth` from `lib/proof-contract.ts:184`; `requestedCoverage` and `HealthTrace.coverage` only hold `CheckState` values.
