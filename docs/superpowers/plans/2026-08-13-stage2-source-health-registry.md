# Stage 2A — Source Health Registry (preparatory) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-capability source-health registry and wire its verdict into the proof manifest, such that every capability across all five sources evaluates **real structural evidence against a real database** — and, because build receipts do not exist yet, no capability can yet authorize an answer.

**Architecture:** A declarative capability inventory (`lib/source-health-inventory.ts`) is the single source of truth for source × capability dependencies, and each capability **owns its database provider**, acquiring a handle and the path it was opened from in one atomic call rather than depending on a route to hand one over. One evaluator (`lib/source-health.ts`) turns a spec into the existing `SourceHealth` interface plus an **evaluation trace** recording which checks actually ran and where evaluation stopped. Capability identity comes from a `PlanDerivation` verified against the executed SQL and the claimed family; for embed reads, where no token exists by design, it comes from a plan family that `verifyEmbedOrigin()` extracts from the originating answer's proof envelope and that creation persists only for a verified, source-matched origin. `proof-finalize` maps the verdict onto `manifest.source`.

**Tech Stack:** TypeScript, better-sqlite3 (readonly), bespoke `npx tsx` suites following `scripts/test-proof-checks.ts`.

**Spec:** `docs/superpowers/specs/2026-08-11-verified-answer-only-handoff.md` — §4, §7, §8, §Stage 2 (line 319).

**Review:** `docs/superpowers/reviews/2026-08-13-stage2a-taxonomy-correction.md` (current)

## Stage 2A is preparatory, not independently complete

**Stage 2 closes only when 2A and 2B have both landed and their combined exit criteria pass.**

In 2A:

- Structure broken → `degraded(reason)`, backed by evidence.
- Structure intact, **receipt absent** → `unknown("no build receipt for …")`, never `healthy`.
- `dataVersion` is **always `null`**. Table year bounds are coverage evidence; a database path
  is a location. Neither is a build identifier.

Self-enforcing: `permitsAnswer()` (`lib/proof-contract.ts:211`) rejects empty `dataVersion`, and
`factualDeliveryBlocker()` (`:281`) returns `"source.dataVersion is not set"` before inspecting
health. Task 8 asserts it.

**Deferred to 2B, and Stage 2 cannot close without them:** real receipts (so `healthy` becomes
reachable), and hard timeout isolation (Task 6 is explicitly *not* a timeout).

## The taxonomy is derived, not written

Three rounds of hand-derivation produced three wrong inventories (20 capabilities, then 41, then
40). Each missed builders reached through a variable, a ternary, or a shared helper, and none
could see a dependency that never appears in the emitted SQL. **The inventory is no longer
authored in this plan.** It is derived by executing every builder against a real database handle
and recording what it touched: `scripts/test-operation-taxonomy.ts`, registered in `npm test`.

Derived results, current:

| Measure | Value |
|---|---|
| Sealed families today / after Task 1A | 26 / 29 |
| Operation cases | **58** |
| — factual | **57** |
| — unavailable in production (seal no capability) | **1** |
| Importable-builder cases / route-handler cases | 56 / 2 |
| **Operation-backed capabilities** | **51** |
| Registry-sweep only (`current.national`) | 1 |
| Capabilities with complete authored policy | **0** |

The one production-unavailable case is `hate_crime:metadata-agency-directory-county`, where the
artifact genuinely lacks `agency_county_crosswalk`. **A fixture that cannot reach a contract is
never recorded as `unavailable`** — that reads as a production verdict the fixture had not earned,
and it is how `deterministic-shooting` was previously dropped out of the count while appearing
accounted for. The suite now allows `unavailable` only for an explicitly listed production exit
and fails on any other non-factual case.

**Unavailable operations are not health capabilities.** The metadata unavailable exits return a
synthetic `SELECT '…' AS answer` (`lib/metadata-coverage.ts:247`), so classifying by SQL presence
mints phantom capabilities. Classification is by **tables actually read**: an operation that
reads no table seals nothing.

Two machine-readable catalogs are the source of truth. **Task 1 consumes them; it does not
retype them.**

| File | Contents |
|---|---|
| `scripts/fixtures/operation-taxonomy/operation-cases.json` | branch → `{ family, terminalKind, capability }` (derived) |
| `scripts/fixtures/operation-taxonomy/capability-registry.json` | capability → `{ artifact, prepDependencies, emittedDependencies, requiredColumns, flagKey, policy, authorizationEligible }` (derived) |
| `scripts/fixtures/operation-taxonomy/capability-policy.json` | capability → `{ coverage, integrity, availability, receiptOwner, evidence }` (**hand-authored**) |

**Observation derives structure only.** Which artifact, which tables, which columns — those are
properties of an execution. Coverage semantics, integrity rules, availability policy and receipt
ownership are not, and deriving them produced a constant (`"observed-available"` for every
capability) and a receipt string built from the first emitted table, both presented as contract.
They now come from a hand-authored file the deriver only reads, and **a capability whose policy is
absent or partly unauthored is `authorizationEligible: false` and can authorize nothing.** One of
51 is partly authored today; the rest are null and fail closed. Authoring them is Stage 2B work.

**Capability identity = artifact + (preparation ∪ emitted) tables + exact required columns.**
Required columns are part of identity because two operations over the same table can have
materially different contracts — `shr:metadata-agency-directory` and `shr:metadata-year-coverage`
both read `incidents` and are distinct capabilities.

**Required columns are settled by execution, not by matching tokens against schemas.** The
predecessor intersected every identifier in a statement with every participating table's schema,
which credited a name declared by two tables to both, harvested words out of string literals
(`'monthly agency trends'` became `agency_monthly.agency`), and turned the `END` of a `CASE`
expression into `historical_agency.end`. Attribution is now resolved through SQL scopes — aliases,
UNION arms, subqueries and CTE pass-through — and then checked both ways by renaming a column in
the artifact and asking SQLite whether the operation's real SQL still compiles: every declared
column must break it, and no undeclared column may. A probe that instead removed a value the
extractor produced and asked the extractor whether its output changed could not fail, and passed
while `historical_agency.end` sat in the registry.

**Preparation-time dependencies are real and invisible to SQL reading.** Three capabilities read
tables that never appear in their emitted SQL: `historical:agency_scorecard` reads live RTCI
`agencies` and `agency_monthly` while deciding, the NIBRS city-offense count reads `agencies`, and
`deterministic-shooting` reads `shr_agency_alias` and `shr_agency_identity` to resolve the agency
before it builds anything. An earlier draft claimed **five**, listing `agency_county_crosswalk`
as preparation-only for three county-metadata capabilities; the registry that draft shipped
contradicted it — the crosswalk is in those operations' emitted SQL, and that draft's own file
recorded only two preparation-only capabilities.

### Task 1: Inventory generated from the derived catalogs

**Files:** Create `lib/source-health-inventory.ts`, `scripts/test-source-health-inventory.ts`; modify `package.json`

**Do not author capability rows.** Generate them from
`scripts/fixtures/operation-taxonomy/capability-registry.json`, which the operation-taxonomy
regression re-derives by observation. Hand-authored rows are what produced three wrong
inventories.

- [ ] **Step 1: Confirm the catalogs are current**

Run `npx tsx scripts/test-operation-taxonomy.ts`. It must exit 0. That suite asserts the case
denominator exactly, re-derives the sealed-family set from source and compares it to a pinned
list of 26, derives the builders' role branches from source and requires a case for every one of
them under every family that selects it, requires every factual exit to name tables and to emit
SQL that executes, and settles required columns by renaming each column in the artifact and
checking whether the real SQL still compiles. If it fails, the catalogs are stale and Task 1 must
not proceed.

- [ ] **Step 2: Types**

```typescript
export type Db = import("better-sqlite3").Database;
/** A handle and the path it was actually opened from, acquired together (see Task 1 notes). */
export type OpenedDatabase = { db: Db; resolvedPath: string };
export type DatabaseProvider = { acquire: () => OpenedDatabase | null };
export type TableRequirement = { name: string; requiredColumns: string[]; minRows: number };
export type DependencyRule = { derived: string; upstream: string; generationColumn?: string };
export type SemanticDependency = {
  table: string; requiredColumns: string[]; qualifies: string;
  keyColumn: string; yearColumn: string; versionColumn?: string;
};
export type CapabilitySpec = {
  capabilityId: string;              // the registry key; identity, not a label
  artifact: SourceId | "crime_data";
  database: DatabaseProvider;
  preflight?: Preflight;
  /** Read while RESOLVING/CONSTRUCTING; absent from the emitted SQL. */
  preparationTables: TableRequirement[];
  tables: TableRequirement[];
  dependencies: DependencyRule[];
  semanticDependencies: SemanticDependency[];
  /**
   * The env-var name that gates probing for this capability, pinned in the registry so a
   * variable in ops config can be traced back. Derived via envKeyForCapability(), never typed.
   */
  flagKey: string;
  /**
   * Hand-authored policy, copied from capability-policy.json. NOT derived: an execution cannot
   * observe what a coverage basis means, what integrity rule applies, whether unavailability is
   * expected, or who owns the receipt. Any field may be null, meaning "not yet authored".
   */
  policy: {
    coverage: { table: string; yearColumn: string } | null;
    integrity: string[] | null;
    /**
     * DISCRIMINATED, so a conditional cannot be written without its condition. A flat enum plus a
     * sibling `availabilityCondition` can represent a conditional with no condition, which puts
     * the invariant in the validator instead of the type -- and the first version of this type
     * omitted the sibling field entirely, so it could not represent what the validator required.
     */
    availability: { kind: "always" } | { kind: "conditional"; condition: string } | null;
    receiptOwner: string | null;
    evidence: string;
  } | null;
  /**
   * False unless every policy field is authored. A capability that cannot authorize must not be
   * silently treated as one that can, so this is computed from the policy, never set by hand.
   */
  authorizationEligible: boolean;
};
export const CAPABILITY_INVENTORY: readonly CapabilitySpec[];
export function specFor(capabilityId: string): CapabilitySpec | null;
```

- [ ] **Step 3: Generate and assert**

Write `lib/source-health-inventory.ts` by reading the registry at build time (or by a checked-in
generator whose output is diffed in CI). Then assert in `scripts/test-source-health-inventory.ts`:

```typescript
/**
 * The one capability with no eligible operation, so it cannot come from the operation catalog.
 * Named here once, because two assertions have to agree about it: an exact equality against the
 * registry and the assertion below that requires it to be present. A previous draft wrote the
 * equality as "inventory == registry" and then required this id in the inventory, so the two
 * could not both hold.
 */
const SWEEP_ONLY = ["crime_data::national_monthly::sweep"];

check("the inventory is exactly the derived registry plus the sweep-only capability", () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
  assert.deepStrictEqual(
    CAPABILITY_INVENTORY.map((s) => s.capabilityId).sort(),
    [...Object.keys(registry), ...SWEEP_ONLY].sort(),
    "inventory drifted from the derived registry",
  );
  for (const id of SWEEP_ONLY) {
    assert.ok(!registry[id], `${id} must NOT be in the operation registry: no operation reaches it`);
  }
});

check("required columns and preparation tables match the registry exactly", () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
  for (const spec of CAPABILITY_INVENTORY) {
    const entry = registry[spec.capabilityId];
    if (!entry) continue;                       // the sweep-only capability has no operation row
    assert.deepStrictEqual(
      Object.fromEntries(spec.tables.map((t) => [t.name, [...t.requiredColumns].sort()])),
      entry.requiredColumns,
    );
    assert.deepStrictEqual(spec.preparationTables.map((t) => t.name).sort(), [...entry.prepDependencies].sort());
  }
});

check("an unavailable operation seals no capability", () => {
  const cases = JSON.parse(fs.readFileSync(CASES_FILE, "utf8"));
  for (const [branch, c] of Object.entries(cases) as [string, { terminalKind: string; capability: string | null }][]) {
    if (c.terminalKind !== "factual") assert.strictEqual(c.capability, null, `${branch} must seal nothing`);
  }
});

check("every capability owns a provider with atomic acquisition", () => {
  for (const spec of CAPABILITY_INVENTORY) assert.strictEqual(typeof spec.database.acquire, "function");
});

check("current.national is registered although no operation reaches it", () => {
  // Frozen spec §8:241 requires independent validation of the Current national and
  // sample-agency tables. It has no eligible operation, so it cannot come from the operation
  // catalog and is added here explicitly; Task 11's sweep is what evaluates it.
  for (const id of SWEEP_ONLY) assert.ok(specFor(id), `${id} is missing from the inventory`);
});

check("no capability authorizes anything until its policy is authored", () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
  for (const spec of CAPABILITY_INVENTORY) {
    const complete = spec.policy !== null &&
      ["coverage", "integrity", "availability", "receiptOwner"].every((f) => spec.policy![f] !== null);
    assert.strictEqual(spec.authorizationEligible, complete, `${spec.capabilityId} misstates its eligibility`);
    const entry = registry[spec.capabilityId];
    if (entry) assert.deepStrictEqual(spec.policy, entry.policy, `${spec.capabilityId} policy drifted from the registry`);
  }
});
```

- [ ] **Step 4: Commit**

```bash
git add lib/source-health-inventory.ts scripts/test-source-health-inventory.ts package.json
git commit -m "Generate the capability inventory from the derived operation catalogs"
```

---

### Task 1A: Sealed metadata operation tokens

**Files:** Modify `lib/metadata-coverage.ts`, `app/api/query/route.ts`, `app/api/nibrs-query/route.ts`, `app/api/shr-query/route.ts`, `app/api/hc-query/route.ts`, `scripts/test-source-health-inventory.ts`; create `scripts/test-metadata-operations.ts`
**Read first:** `lib/metadata-coverage.ts:612-660`, `lib/plan-derivation.ts:198-205`
**Depends on Task 1:** it edits `scripts/test-source-health-inventory.ts` and lowers that file's
seal-site count, so Task 1 must have created it. Task 1A previously appeared *before* Task 1 with
Task 1 spliced into the middle of it; the two are now contiguous and in dependency order.

`metadata-coverage-answer` is one family covering three structurally different operations
over different dependency sets. On Historical it reads `historical_state_national` *or*
`historical_agency` *or* both; on Hate Crime, `hate_crime_participation` *or*
`hate_crime_incidents`. No per-source mapping can be truthful, because the ambiguity is
inside the source.

**The evidence must be produced where the SQL is built, and bound to that exact SQL.** A
route-supplied capability string would be an unverified claim about work the route did not
do; `sealPlanDerivation(family, capability, sql)` at the construction site is a token whose
fingerprint `verifyPlanDerivation` can check against what was actually executed, and whose
`capability` is the identity the builder itself declared.

| Family | Emitted for | Builder |
|--------|-------------|---------|
| `metadata-year-coverage` | `year_range` | `yearSql` (`:516-532`) |
| `metadata-agency-directory` | agency/city intents, no county scope | `entitySql` (`:450`) |
| `metadata-agency-directory-county` | agency/city intents with a county scope | `countyEntitySql` (`:391`) |
| `metadata-state-coverage` | `available_states`, `missing_states`, `state_count` | `stateSql` (`:335`) |

Each of those four families spans **five** capabilities — one per source — so the family is not
the identity. The builder declares the capability alongside the SQL it just built.

`download_help` (`:620`) and `county_membership_unavailable` (`:621`) produce **no SQL** and
must seal **nothing**. They are canned capability answers, not factual source claims, and
`UNMAPPED_FAMILIES` records why.

- [ ] **Step 1: Write the failing tests**

```typescript
// scripts/test-metadata-operations.ts
import { answerMetadataQuestion } from "../lib/metadata-coverage";
import { verifyPlanDerivation } from "../lib/plan-derivation";
import { specFor } from "../lib/source-health-inventory";

check("each metadata operation seals its OWN family AND capability, bound to the SQL it built", () => {
  const cases = [
    { source: "historical", q: "which states have data",            family: "metadata-state-coverage" },
    { source: "historical", q: "what years are available",          family: "metadata-year-coverage" },
    { source: "historical", q: "how many agencies are included",    family: "metadata-agency-directory" },
    { source: "hate_crime", q: "which states have data",            family: "metadata-state-coverage" },
    { source: "hate_crime", q: "how many agencies are included",    family: "metadata-agency-directory" },
  ] as const;
  for (const c of cases) {
    const result = answerMetadataQuestion(c.source, c.q, fixtureDbFor(c.source))!;
    assert.ok(result?.derivation, `${c.source}/${c.q} sealed nothing`);
    assert.strictEqual(result.derivation!.planFamily, c.family);
    // The capability is declared by the builder and must name a real registry entry.
    assert.ok(result.derivation!.capability, `${c.source}/${c.q} sealed no capability`);
    assert.ok(specFor(result.derivation!.capability!), `unknown capability ${result.derivation!.capability}`);
    // Bound to the EXACT SQL: the whole point of sealing at the construction site.
    assert.ok(verifyPlanDerivation(result.derivation!, result.sql, c.family).ok);
  }
});

check("the same family on two sources seals two DIFFERENT capabilities", () => {
  // The defect this task exists to remove: metadata-state-coverage spans five capabilities,
  // one per source, so no family -> capability function can be truthful.
  const historical = answerMetadataQuestion("historical", "which states have data", fixtureDbFor("historical"))!;
  const hateCrime = answerMetadataQuestion("hate_crime", "which states have data", fixtureDbFor("hate_crime"))!;
  assert.strictEqual(historical.derivation!.planFamily, hateCrime.derivation!.planFamily);
  assert.notStrictEqual(historical.derivation!.capability, hateCrime.derivation!.capability);
});

check("the two Historical operations seal DIFFERENT capabilities", () => {
  const states = answerMetadataQuestion("historical", "which states have data", fixtureDbFor("historical"))!;
  const agencies = answerMetadataQuestion("historical", "how many agencies are included", fixtureDbFor("historical"))!;
  assert.notStrictEqual(states.derivation!.capability, agencies.derivation!.capability);
});

check("Hate Crime state coverage seals participation, not incidents", () => {
  const states = answerMetadataQuestion("hate_crime", "which states have data", fixtureDbFor("hate_crime"))!;
  const spec = specFor(states.derivation!.capability!)!;
  assert.deepStrictEqual(spec.tables.map((t) => t.name), ["hate_crime_participation"]);
});

check("a SQL-less metadata answer seals nothing", () => {
  const help = answerMetadataQuestion("current", "how do I download this table", null)!;
  assert.strictEqual(help.sql, "");
  assert.strictEqual(help.derivation, null);
});

check("no route seals a metadata family of its own", () => {
  // The family must come from the builder, never from a route's claim about it.
  for (const file of ROUTE_FILES) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /sealPlanDerivation\(\s*"metadata-/);
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx scripts/test-metadata-operations.ts`
Expected: FAIL — `MetadataCoverageResult` has no `derivation`.

- [ ] **Step 3: Emit the token from the builder**

Add `derivation: PlanDerivation | null` to `MetadataCoverageResult`, and set it in each of
the three SQL-producing branches of `answerMetadataQuestion` **at the point the SQL is in
hand** — `:625-629` for year coverage, `:631-650` for the entity branches (choosing the
county family when `county` is non-null), `:652-656` for state coverage. `result(...)`
carries it through. `downloadResult(...)` and `countyMembershipUnavailableResult(...)` set
`null`.

Each site passes **both** the family and the capability it is building for:
`sealPlanDerivation(family, capabilityId, sql)`. The capability comes from the source the
builder was called with plus the tables it just decided to read — the same two facts the
operation-taxonomy registry is keyed on — never from the family alone.

- [ ] **Step 4: Consume it in the four routes**

Replace each route's `derivation: metadata.sql ? sealPlanDerivation("metadata-coverage-answer", metadata.sql) : null`
with `derivation: metadata.derivation`, and each `planFamily: "metadata-coverage-answer"`
with `planFamily: metadata.derivation?.planFamily ?? null`. Sites:
`app/api/query/route.ts:1165`, `app/api/nibrs-query/route.ts:625`,
`app/api/shr-query/route.ts:423`, `app/api/hc-query/route.ts:403`.

Then set `EXPECTED_SEAL_SITES = 8` in `scripts/test-source-health-inventory.ts`, in this
commit, and drop `metadata-coverage-answer` from `SEALED_FAMILIES` — it is no longer sealed
anywhere. Keep its `UNMAPPED_FAMILIES` entry as the record of what replaced it.

- [ ] **Step 5: Prove no user-visible change**

Run: `npx tsx scripts/test-metadata-operations.ts && npx tsx scripts/test-shadow-route-equivalence.ts && npx tsx scripts/test-shadow-equivalence.ts && npx tsc --noEmit`

The family name reaches `query_log` and the proof envelope. It must **not** reach any user
payload — confirm the equivalence suites still see byte-identical bodies. A changed family
string in a response body is a contract violation, not a cosmetic diff.

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test` (a **127** exit is the known npx-cache flake — re-run once)

```bash
git add lib/metadata-coverage.ts app/api/query/route.ts app/api/nibrs-query/route.ts \
        app/api/shr-query/route.ts app/api/hc-query/route.ts \
        scripts/test-metadata-operations.ts scripts/test-source-health-inventory.ts package.json
git commit -m "Seal metadata operation tokens where the SQL is built, replacing one coarse family"
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
// Capability ids are structural and come from the registry verbatim. There is no short
// per-source label: two capabilities can share a table set (`shr:metadata-agency-directory` and
// `shr:metadata-year-coverage` both read `incidents`), so nothing shorter is unique.
const SHR_INCIDENTS_YEAR = "shr::incidents::incidents(year)";
const shr = specFor(SHR_INCIDENTS_YEAR)!;
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
const CURRENT_SAMPLE_AGENCIES =
  "crime_data::agency_monthly+agency_population+sample_agencies::agency_monthly(count,offense,ori,year)|agency_population(ori,population,year)|sample_agencies(ori,state)";
const sample = specFor(CURRENT_SAMPLE_AGENCIES)!;

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

const NIBRS_NATIONAL_ARRESTS =
  "nibrs::rollup.national_summary_arrestee_demographics::rollup.national_summary_arrestee_demographics(arrestee_count,ucr_arrest_offense,year)";

check("a NIBRS preflight that inspects a different artifact is degraded", () => {
  // Guards the seam: the inspector reads the configured rollup path while table checks
  // read the provider's handle. If those are different files, the verdict is incoherent.
  const nibrs = specFor(NIBRS_NATIONAL_ARRESTS)!;
  const previous = process.env.NIBRS_ROLLUP_DB_PATH;
  process.env.NIBRS_ROLLUP_DB_PATH = path.join(dir, "somewhere-else.db");
  fs.writeFileSync(process.env.NIBRS_ROLLUP_DB_PATH, "");
  const { health, trace } = evaluateCapability(nibrs, ctx(currentFixture()));
  if (previous === undefined) delete process.env.NIBRS_ROLLUP_DB_PATH; else process.env.NIBRS_ROLLUP_DB_PATH = previous;
  assert.ok(["artifact_mismatch", "preflight_failed"].includes(trace.boundary), `unexpected boundary ${trace.boundary}`);
  assert.strictEqual(health.state, "degraded");
});

check("an unconfigured rollup surfaces the inspector's own reason", () => {
  const nibrs = specFor(NIBRS_NATIONAL_ARRESTS)!;
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

- [ ] **Step 4: Add the semantic dependency alignment check**

Add `semanticChecked: string[]` to `HealthTrace`, and a `semantic_dependency` boundary.

**A row count is not evidence here.** `agency_year_reliability` is nonempty in every
database that has ever been built; what matters is whether it *covers* the agency-crime data
it qualifies. Three alignment checks, using the real columns
(`ori, year, kind, source, columns_json, evidence_json, algorithm_version, generated_at`):

```typescript
  for (const dep of spec.semanticDependencies) {
    const columns = columnsOf(db, dep.table);
    if (columns === null) return done("degraded", `semantic dependency ${dep.table} is missing`, "semantic_dependency");
    const absent = dep.requiredColumns.filter((column) => !columns.has(column));
    if (absent.length > 0) {
      return done("degraded", `${dep.table} is missing required column(s): ${absent.join(", ")}`, "semantic_dependency");
    }
    try {
      // 1. Every qualifying row resolves to something it can qualify. Orphans mean the
      //    reliability build ran against a different agency set.
      const orphans = db.prepare(
        `SELECT COUNT(*) AS n FROM ${dep.table} d
          WHERE NOT EXISTS (SELECT 1 FROM ${dep.qualifies} q WHERE q.${dep.keyColumn} = d.${dep.keyColumn})`,
      ).get() as { n: number };
      if (orphans.n > 0) {
        return done("degraded", `${orphans.n} row(s) in ${dep.table} qualify ${dep.keyColumn} values absent from ${dep.qualifies}`, "semantic_dependency");
      }

      // 2. Its year span is not strictly narrower. A reliability build that stopped short
      //    leaves the most recent years silently unqualified -- every agency-year in the
      //    gap reads as usable, which is the failure this dependency exists to prevent.
      const span = db.prepare(
        `SELECT (SELECT MAX(${dep.yearColumn}) FROM ${dep.table}) AS depMax,
                (SELECT MAX(${dep.yearColumn}) FROM ${dep.qualifies}) AS qualMax`,
      ).get() as { depMax: number | null; qualMax: number | null };
      if (span.depMax === null || span.qualMax === null) {
        return done("unknown", `${dep.table} or ${dep.qualifies} has no year bound to compare`, "semantic_dependency");
      }
      if (span.depMax < span.qualMax) {
        return done("degraded", `${dep.table} covers through ${span.depMax} but ${dep.qualifies} extends to ${span.qualMax}; those years are unqualified`, "semantic_dependency");
      }

      // 3. One algorithm version. A mixed-version table is a half-finished rebuild, and
      //    rows from two algorithms are not comparable evidence.
      if (dep.versionColumn) {
        const versions = db.prepare(
          `SELECT COUNT(DISTINCT ${dep.versionColumn}) AS n FROM ${dep.table} WHERE ${dep.versionColumn} IS NOT NULL`,
        ).get() as { n: number };
        if (versions.n === 0) return done("degraded", `${dep.table} records no ${dep.versionColumn}`, "semantic_dependency");
        if (versions.n > 1) return done("degraded", `${dep.table} mixes ${versions.n} ${dep.versionColumn} values; a rebuild is incomplete`, "semantic_dependency");
      }
    } catch (error) {
      return done("unknown", `semantic dependency ${dep.table} could not be checked: ${(error as Error).message}`, "semantic_dependency");
    }
    trace.semanticChecked.push(`${dep.table}~${dep.qualifies}`);
  }
```

Tests, added to `scripts/test-source-health.ts`:

```typescript
const HISTORICAL_AGENCY_CRIME =
  "crime_data::historical_agency+historical_agency_crime::historical_agency(agency,ori,state,type)|historical_agency_crime(ori,violent,year)";
const agencyCrime = specFor(HISTORICAL_AGENCY_CRIME)!;

check("reliability data that stops short of the crime data is degraded, not healthy", () => {
  // The case a nonempty-table check passes and this one catches.
  const db = historicalFixture((d) => {
    d.prepare("INSERT INTO historical_agency_crime VALUES (?,?)").run("TX0001", 2024);
  }); // reliability rows only through 2022
  const { health, trace } = evaluateCapability(agencyCrime, ctx(db));
  assert.strictEqual(trace.boundary, "semantic_dependency");
  assert.strictEqual(health.state, "degraded");
  assert.match(health.reason ?? "", /unqualified|extends to/);
});

check("a mixed algorithm_version is degraded", () => {
  const db = historicalFixture((d) => {
    d.prepare("INSERT INTO agency_year_reliability VALUES (?,?,?)").run("TX0001", 2022, "v2");
  });
  assert.strictEqual(evaluateCapability(agencyCrime, ctx(db)).trace.boundary, "semantic_dependency");
});

check("an aligned reliability table is recorded and evaluation reaches the receipt", () => {
  const { trace } = evaluateCapability(agencyCrime, ctx(historicalFixture()));
  assert.strictEqual(trace.boundary, "missing_receipt");
  assert.deepStrictEqual(trace.semanticChecked, ["agency_year_reliability~historical_agency_crime"]);
});

check("a nonempty but misaligned table would pass a row check and fail this one", () => {
  // Names the distinction explicitly so a later simplification to COUNT(*) > 0 fails here.
  const db = historicalFixture((d) => {
    d.exec("DELETE FROM agency_year_reliability");
    d.prepare("INSERT INTO agency_year_reliability VALUES (?,?,?)").run("ZZ9999", 2022, "v1");
  });
  const { trace } = evaluateCapability(agencyCrime, ctx(db));
  assert.strictEqual(trace.boundary, "semantic_dependency");
});
```

- [ ] **Step 5: Run it, confirm it passes, commit**

Run: `npx tsx scripts/test-source-health.ts && npx tsc --noEmit`

```bash
git add lib/source-health.ts scripts/test-source-health.ts
git commit -m "Evaluate dependencies, semantic reliability alignment, and NIBRS artifact coherence"
```

---

### Task 4: Capability resolution from verified plan evidence

**Files:** Modify `lib/source-health.ts`, `scripts/test-source-health.ts`
**Read first:** `lib/plan-derivation.ts:61-70`, `:235-270`

`verifyPlanDerivation(derivation, executedSql, expectedFamily)` takes **three** arguments; the third is documented "VERIFIED, NOT TRUSTED", and passing it is what stops a token sealed for family A authorizing an answer recorded under family B. Every call passes all three.

**The capability comes off the verified token, not out of a family lookup.** An earlier draft of
this task called `capabilityForFamily(sourceId, family)`. The derived registry disproves that
mapping: eleven families each span several capabilities —
`deterministic-nibrs-continuous-reporters` and `deterministic-nibrs-countywide-demographic` span
**four** apiece (victim, offender, arrestee and victim-city contracts over four different summary
tables), and each of the four metadata families spans **five**, one per source. A function from
family to capability must therefore either return the wrong contract or refuse to answer, and
`sourceId` does not disambiguate the NIBRS cases because all four live on the same source. The
builder is the only place that knows which contract it built, so it seals that identity into the
token and `verifyPlanDerivation` hands back the verified value. `capabilityForFamily()` is not
part of this design and must not be introduced.

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
const MURDER = "shr::incidents::incidents(homicide_type,victim_count,year)";   // a real registry key

check("capability comes from a derivation verified against SQL and family", () => {
  const sealed = sealPlanDerivation("deterministic-murder", MURDER, SQL);
  const resolved = resolveCapability("shr", sealed, SQL, "deterministic-murder");
  assert.ok("capability" in resolved, JSON.stringify(resolved));
  assert.strictEqual((resolved as { capability: string }).capability, MURDER);
});

check("no derivation resolves to nothing", () => {
  assert.ok("unresolved" in resolveCapability("shr", null, SQL, "deterministic-murder"));
});

check("SQL that does not match the sealed fingerprint is rejected", () => {
  const sealed = sealPlanDerivation("deterministic-murder", MURDER, SQL);
  assert.ok("unresolved" in resolveCapability("shr", sealed, "SELECT 1", "deterministic-murder"));
});

check("a family claim disagreeing with the token is rejected", () => {
  const sealed = sealPlanDerivation("deterministic-murder", MURDER, SQL);
  assert.ok("unresolved" in resolveCapability("shr", sealed, SQL, "deterministic-shooting"));
});

check("a token whose capability belongs to another artifact is rejected", () => {
  // The source claim is checked against the capability's OWN artifact, not against a family map.
  const sealed = sealPlanDerivation("deterministic-murder", MURDER, SQL);
  assert.ok("unresolved" in resolveCapability("current", sealed, SQL, "deterministic-murder"));
});

check("a token naming no capability resolves to nothing rather than a default", () => {
  const sealed = sealPlanDerivation("family-nobody-mapped", null, SQL);
  assert.ok("unresolved" in resolveCapability("shr", sealed, SQL, "family-nobody-mapped"));
});

check("a token naming a capability that is not in the registry is rejected", () => {
  const sealed = sealPlanDerivation("deterministic-murder", "shr::invented::nothing(x)", SQL);
  assert.ok("unresolved" in resolveCapability("shr", sealed, SQL, "deterministic-murder"));
});

check("two role branches of ONE family resolve to their own contracts", () => {
  // deterministic-nibrs-continuous-reporters spans four capabilities. This is the case a
  // family -> capability lookup answers wrongly, whichever of the four it returns.
  const victims = "nibrs::nibrs_consistent_reporters+summary_victim_demographics::…";
  const offenders = "nibrs::nibrs_consistent_reporters+summary_offender_demographics::…";
  const family = "deterministic-nibrs-continuous-reporters";
  for (const capability of [victims, offenders]) {
    const sealed = sealPlanDerivation(family, capability, SQL);
    const resolved = resolveCapability("nibrs", sealed, SQL, family);
    assert.strictEqual((resolved as { capability: string }).capability, capability);
  }
});
```

- [ ] **Step 2: Run it, confirm it fails, implement**

Add `capability: string | null` to `PlanDerivation` (bumping `PLAN_DERIVATION_VERSION`, and
reading an older envelope as `capability: null` rather than guessing one), take it as
`sealPlanDerivation`'s second argument, and have `verifyPlanDerivation` return it on success so
the caller reads a **verified** value rather than the raw token.

```typescript
import { verifyPlanDerivation, type PlanDerivation } from "./plan-derivation";
import { specFor } from "./source-health-inventory";

export function resolveCapability(
  sourceId: SourceId,
  derivation: PlanDerivation | null,
  executedSql: string | null,
  claimedFamily: string | null,
): { capability: string } | { unresolved: string } {
  if (!derivation) return { unresolved: "no verified plan derivation was sealed for this answer" };
  const verified = verifyPlanDerivation(derivation, executedSql, claimedFamily);
  if (!verified.ok) return { unresolved: `plan derivation not verified: ${verified.reason}` };
  // The builder's own declaration, verified with the rest of the token. No family lookup: one
  // family can span four contracts, so a family could only ever name one of them.
  if (!verified.capability) return { unresolved: `plan family '${derivation.planFamily}' sealed no capability` };
  const spec = specFor(verified.capability);
  if (!spec) return { unresolved: `sealed capability '${verified.capability}' is not in the registry` };
  // The claimed source must match the capability's OWN artifact.
  if (spec.artifact !== artifactOf(sourceId)) {
    return { unresolved: `capability '${verified.capability}' belongs to ${spec.artifact}, not ${sourceId}` };
  }
  return { capability: verified.capability };
}
```

A pre-existing envelope with no `capability` therefore resolves to `unresolved`, which is the
fail-closed direction: it withholds authority instead of inventing an identity for an answer
produced before the field existed.

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
  // The request carries NO sourceId: the first argument is authoritative, and a second copy riding
  // on the request let a disagreeing call poison the cache with a verdict attributed to the wrong
  // source. HealthRequest = Omit<HealthContext, "sourceId">.
  claimedFamily: string | null, request: HealthRequest, env?: ModeEnv,
): SourceHealth;
export function __resetSourceHealthCacheForTests(): void;
/** Full traces, in order. Test-only. */
export function __healthTracesForTests(): HealthTrace[];
```

- [ ] **Step 1: Write the failing tests**

```typescript
import { sourceHealthFor, __resetSourceHealthCacheForTests, __healthTracesForTests } from "../lib/source-health";

const shrSealed = sealPlanDerivation("deterministic-murder", SHR_INCIDENTS_YEAR, SQL);
// Derived, never typed. A literal flag name is a second copy of the identity, and the copy is
// what went stale: the whole PROOF_CAPABILITY_<SOURCE>_<LABEL> family named capabilities that no
// longer exist and could not select the generated ones.
const SHR_FLAG = envKeyForCapability("shr", SHR_INCIDENTS_YEAR);
const enabled = { PROOF_MODE: "shadow", [SHR_FLAG]: "on" };
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
  assert.strictEqual(traces[0].capability, SHR_INCIDENTS_YEAR);
  assert.strictEqual(traces[0].boundary, "missing_receipt");
  assert.deepStrictEqual(traces[0].tablesChecked, ["incidents"]);
});

check("an explicitly disabled capability is not probed", () => {
  __resetSourceHealthCacheForTests();
  call(ctx(shrFixture()), { PROOF_MODE: "shadow", [SHR_FLAG]: "off" });
  assert.deepStrictEqual(__healthTracesForTests(), []);
});

check("with proof OFF no source-health work runs at all", () => {
  __resetSourceHealthCacheForTests();
  const health = call(ctx(shrFixture()), { [SHR_FLAG]: "on" });
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
 * Kill switch for one capability, mirroring envKeyForFamily.
 *
 * Read as default-OFF: only an explicit enabling value turns probing on, because §13
 * requires every new capability to default to off and an unset variable is not a
 * decision anyone made.
 *
 * The name goes through a DIGEST of the capability id, not through the id itself. A
 * structural id contains `::`, `+`, `(`, `)` and `,`, so it cannot be uppercased into an
 * environment-variable name. A short readable label was the obvious alternative and does
 * not work either: two capabilities can share a table set, so nothing shorter than the id
 * (tables AND columns) is unique, and hand-maintaining a label map is exactly what produced
 * three wrong inventories. A content digest is stable, unique, and derivable by anyone
 * holding the id.
 *
 * Consequence, deliberate: changing a capability's contract changes its flag, so probing
 * must be re-enabled explicitly for the new contract rather than inherited by a name that
 * silently now means something else. Each capability's `flagKey` is pinned in
 * capability-registry.json so a variable in ops config can be traced back to its capability.
 */
export function envKeyForCapability(artifact: string, capabilityId: string): string {
  const digest = createHash("sha256").update(capabilityId).digest("hex").slice(0, 8).toUpperCase();
  return `PROOF_CAPABILITY_${artifact.toUpperCase()}_${digest}`;
}
```

**This changes the environment-variable names in `ecosystem.config.js`.** No capability flag is set
in production today, so nothing breaks, but the naming scheme is an operational decision and needs
Jeff's confirmation before Task 5 is implemented.

- [ ] **Step 3: Implement the gate, cache, and trace log**

```typescript
// envKeyForCapability is deliberately NOT imported here: the request path reads spec.flagKey.
import { isObserving, resolveMode } from "./proof-modes";
import { specFor } from "./source-health-inventory";

export const HEALTH_CACHE_TTL_MS = 30_000;
// Both retention structures are BOUNDED (cache: TTL purge + oldest-entry eviction at
// HEALTH_CACHE_MAX_ENTRIES; traces: a ring of HEALTH_TRACE_LIMIT dropping the oldest).
// TTL alone is freshness, not eviction -- an expired entry still occupies memory forever.
export const HEALTH_CACHE_MAX_ENTRIES = 256;
export const HEALTH_TRACE_LIMIT = 500;
const cache = new Map<string, { at: number; health: SourceHealth }>();
const traces: HealthTrace[] = [];
let healthNow: () => number = Date.now;

function unresolvedVerdict(sourceId: SourceId, capability: string, reason: string): SourceHealth {
  return { sourceId, capability, state: "unknown", reason, dataVersion: null, requestedCoverage: "unknown" };
}

/**
 * EVERY trace write and cache write goes through these two. They are part of the snippet, not a
 * comment about it: a version of this block that described the bounds in prose while its executable
 * lines called `traces.push` and `cache.set` directly would restore unbounded retention in whatever
 * task copied it.
 */
function pushTrace(trace: HealthTrace): void {
  traces.push(trace);
  while (traces.length > HEALTH_TRACE_LIMIT) traces.shift();   // drop the OLDEST, never the newest
}

function storeVerdict(key: string, health: SourceHealth): void {
  const now = healthNow();
  if (cache.size >= HEALTH_CACHE_MAX_ENTRIES) {
    for (const [candidate, entry] of cache) {
      if (now - entry.at >= HEALTH_CACHE_TTL_MS) cache.delete(candidate);
    }
    while (cache.size >= HEALTH_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;   // Map preserves insertion order
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  cache.set(key, { at: now, health });
}

export function sourceHealthFor(
  sourceId: SourceId, derivation: PlanDerivation | null, executedSql: string | null,
  claimedFamily: string | null, request: HealthRequest, env: ModeEnv = process.env,
): SourceHealth {
  // Global mode first: off does no request-path work, and a capability flag cannot
  // override it (invariant 14).
  if (!isObserving(resolveMode(sourceId, null, env).mode)) {
    return unresolvedVerdict(sourceId, "unresolved", "proof system is off for this source");
  }
  const resolved = resolveCapability(sourceId, derivation, executedSql, claimedFamily);
  if ("unresolved" in resolved) return unresolvedVerdict(sourceId, "unresolved", resolved.unresolved);
  const capability = resolved.capability;

  // Mode recheck with the VERIFIED family, so the per-family OFF override wins. The broad gate
  // above passes null on purpose -- consulting a family an unverified token merely claims would be
  // input-driven configuration -- but null permanently excluded the narrower override.
  if (!isObserving(resolveMode(sourceId, claimedFamily, env).mode)) {
    return unresolvedVerdict(sourceId, capability, `proof mode is off for plan family '${claimedFamily}'`);
  }

  // The spec comes first now: the flag name is PINNED on it, and resolveCapability has already
  // rejected a capability whose artifact does not match sourceId.
  const spec = specFor(capability);
  if (!spec) return unresolvedVerdict(sourceId, capability, `no inventory entry for ${capability}`);

  // Read the pin; do NOT re-derive it here. Generation owns envKeyForCapability() and the
  // uniqueness check over its output. A second implementation on the request path is a drift the
  // registry pin cannot prevent -- the runtime would simply ignore it.
  const flagKey = spec.flagKey;
  const flag = (env[flagKey] ?? "").trim().toLowerCase();
  if (flag !== "on" && flag !== "shadow" && flag !== "enforce") {
    return unresolvedVerdict(sourceId, capability, `capability not enabled (${flagKey} is '${flag || "unset"}')`);
  }

  /**
   * Cache key includes NON-FORGEABLE handle identity. A caller-supplied identity string
   * would only prove two LABELS differ; reusing one label across handles would inherit
   * another database's verdict. The identity comes from a WeakMap on the handle itself.
   */
  // ACQUISITION IS INSIDE THE CONTAINMENT BLOCK. A version of this that acquired the handle for the
  // cache key first would let a throwing provider -- the case invariant 15 exists for -- propagate
  // to the route, and would leave the enabled capability's failed attempt untraced.
  let probeOpened: OpenedDatabase | null = null;
  try {
    probeOpened = request.dbOverride !== undefined ? request.dbOverride : spec.database.acquire();
  } catch (error) {
    pushTrace({
      sourceId, capability, dbIdentity: "no-db", dbPath: null,
      preflight: "skipped", tablesChecked: [], dependenciesChecked: [], semanticChecked: [],
      coverage: "unknown", boundary: "threw",
    });
    return unresolvedVerdict(sourceId, capability, `database acquisition threw: ${(error as Error).message}`);
  }

  const period = [...(request.requestedYears ?? [])].sort((a, b) => a - b).join(",");
  const key = `${sourceId}:${capability}:${identityOf(probeOpened?.db ?? null)}:${period}`;
  const hit = cache.get(key);
  if (hit && healthNow() - hit.at < HEALTH_CACHE_TTL_MS) return hit.health;

  const budget = budgetMs(env);
  if (budget === 0) {
    const skipped = unresolvedVerdict(sourceId, capability, "source-health budget is 0ms; no probe ran");
    storeVerdict(key, skipped);
    return skipped;
  }

  const startedAt = healthNow();
  let health: SourceHealth;
  try {
    const evaluated = evaluateCapability(spec, { ...request, sourceId, dbOverride: probeOpened });
    health = evaluated.health;
    pushTrace(evaluated.trace);
  } catch (error) {
    // A probe must never take down a response (§13, invariant 15).
    health = unresolvedVerdict(sourceId, capability, `probe threw: ${(error as Error).message}`);
    pushTrace({
      sourceId, capability, dbIdentity: identityOf(probeOpened?.db ?? null),
      dbPath: probeOpened?.resolvedPath ?? null,
      preflight: "skipped", tablesChecked: [], dependenciesChecked: [], semanticChecked: [],
      coverage: "unknown", boundary: "threw",
    });
  }
  const elapsed = healthNow() - startedAt;
  if (elapsed > budget) {
    health = unresolvedVerdict(sourceId, capability, `probe exceeded its ${budget}ms budget (${elapsed}ms); verdict not treated as health`);
  }
  storeVerdict(key, health);
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

**Persist the resolved capability on the manifest** as `manifest.capability`, set from the
`resolveCapability` result and left `null` when unresolved. It is already computed here to
evaluate health; recording it is what lets an embed read recover the originating contract
(Task 10) instead of trying to rediscover it from the family, which cannot identify it.

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
    manifest.planFamily = "deterministic-current-multi-city-trend";
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
  const env = { PROOF_MODE: "shadow", [SHR_FLAG]: "on" };
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
  /**
   * Corrected from an earlier draft, which enabled the `current.national` flag and sealed
   * `metadata-coverage-answer` over `national_monthly`. Both halves were wrong:
   * `current.national` has no eligible operation and is swept by Task 11; Current metadata
   * resolves to the agency-roster capability, not to the national one. The test would have
   * "passed" over a capability that never evaluated.
   */
  __resetSourceHealthCacheForTests();
  const env = {
    PROOF_MODE: "shadow",
    [SHR_FLAG]: "on",
    [envKeyForCapability("crime_data", CURRENT_SAMPLE_AGENCIES)]: "on",
  };
  const brokenShr = sourceHealthFor("shr", shrSealed, SQL, "deterministic-murder",
    ctx(shrFixture((d) => d.exec("DELETE FROM incidents"))), env);
  const currentSql = "SELECT year, month, murders FROM agency_monthly WHERE ori = 'TX0001'";
  const currentSealed = sealPlanDerivation("deterministic-current-multi-city-trend", CURRENT_SAMPLE_AGENCIES, currentSql);
  const currentHealth = sourceHealthFor("current", currentSealed, currentSql,
    "deterministic-current-multi-city-trend", ctx(currentFixture()), env);
  assert.strictEqual(brokenShr.state, "degraded");
  assert.notStrictEqual(currentHealth.state, "degraded");
  // And both actually evaluated, so this is isolation rather than two no-ops.
  const boundaries = __healthTracesForTests().map((t) => `${t.sourceId}:${t.boundary}`);
  assert.ok(boundaries.includes("shr:row_bounds"), `expected shr to fail on rows, saw ${boundaries.join(",")}`);
  assert.ok(boundaries.includes("current:missing_receipt"), `expected current to reach the receipt, saw ${boundaries.join(",")}`);
});

check("a capability flag cannot manufacture a verdict for an unmapped capability", () => {
  // A flag is not a path. Enabling a capability no verified operation selects must not
  // produce a verdict; resolution still fails and the answer stays unknown.
  __resetSourceHealthCacheForTests();
  // The sweep-only capability: registered, flag-enabled, and still unreachable from an operation.
  const env = { PROOF_MODE: "shadow", [envKeyForCapability("crime_data", SWEEP_ONLY[0])]: "on" };
  const sql = "SELECT year, count FROM national_monthly";
  const sealed = sealPlanDerivation("deterministic-current-multi-city-trend", SWEEP_ONLY[0], sql);
  const health = sourceHealthFor("current", sealed, sql, "deterministic-current-multi-city-trend",
    ctx(currentFixture()), env);
  assert.notStrictEqual(health.capability, "national_monthly");
  assert.strictEqual(health.state, "unknown");
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

Three gaps this closes: the suite's four handler cases exercise only **four** source
identities, because the Current/Historical handler is driven with a Current question;
enabling flags proves nothing unless a capability was evaluated **and reached the receipt
boundary**; and — the one the enumeration found — **all four existing cases drive the
model-SQL path and seal no derivation at all**, so every one of them evaluates zero
capabilities as written.

**Every existing case must be re-pointed at a deterministic family.** Each supplies
`coldCalls: ["translate", "explain"]` and a stubbed `reply` containing SQL, which is the
model path; `resolveCapability` returns unresolved there by design. The fixtures change, the
assertions do not.

| Route case | Family to drive | Fixture tables to add |
|-----------|-----------------|----------------------|
| `app/api/query` (current) | `deterministic-current-multi-city-trend` | none — `agency_monthly`, `agency_population` already present |
| `app/api/query` (historical, new) | `state-scorecard` | `historical_state_national` |
| `app/api/nibrs-query` | `deterministic-nibrs-clearance-method` | `summary_clearance_type` |
| `app/api/shr-query` | `deterministic-murder` | `victims` alongside `incidents` |
| `app/api/hc-query` | `metadata-state-coverage` (Task 1A) | `hate_crime_participation` |

A deterministic case does not consume the stubbed model reply, so `coldCalls` for these
becomes `[]`. Keep one model-path case per route as a separate axis if the existing
equivalence coverage is wanted — but it cannot satisfy the Stage 2 axis.

**SHR needs one extra assertion.** Both SHR deterministic exits seal the planner's SQL and
execute the contract validator's output (`app/api/shr-query/route.ts:456`/`:470`,
`:711`/`:714`/`:757`), and `validateQueryContractSql` can rewrite
(`lib/query-contract-validator.ts:396`, `:404`). If a rewrite fires, the fingerprint stops
matching and the capability silently fails to resolve. Assert the derivation verified, so
the suite reports that cause rather than an unexplained empty trace:

```typescript
assert.ok(
  verifyPlanDerivation(sealedFromExit, executedSql, family).ok,
  "SHR sealed the planner SQL but executed the contract validator's rewrite; " +
  "the capability cannot resolve until they agree",
);
```

**No route case may be skipped.** Every source has at least one reachable deterministic
operation; the derived catalog names one per route. A case that cannot be driven is a fixture
defect, not an unreachable capability.

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
  // The reachable capabilities only. `current.national` is the single exception: no operation
  // reaches it, so enabling a flag for it would suggest coverage that does not exist. Task 11's
  // sweep is what evaluates it instead.
  //
  // The NIBRS rollup capabilities are NOT in that category and must be enabled here. An earlier
  // draft excluded them as unreachable alongside current.national; the derived catalog shows
  // otherwise — `deterministic-nibrs-rollup-juvenile-arrests-race` and
  // `deterministic-nibrs-rollup-national-arrests` are sealed families with observed contracts
  // over the `rollup.` tables, three capabilities between them.
  //
  // Flag names are generated from the inventory, not typed here: hand-listing them is how this
  // block came to disagree with the catalog in the first place.
  const CAPS: Record<string, string> = Object.fromEntries(
    CAPABILITY_INVENTORY
      .filter((spec) => !SWEEP_ONLY.includes(spec.capabilityId))
      .map((spec) => [envKeyForCapability(spec.artifact, spec.capabilityId), "on"]),
  );
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

A failure means the fixture question does not reach a deterministic typed-plan path, so no
derivation is sealed. Steer the question onto a family present in
`CAPABILITY_BY_SOURCE_AND_FAMILY` — the table above names one per route — or point the
capability's provider at the fixture database via the suite's env variables.

**No capability is architecturally unreachable, so there is no skip list.** Every source has at
least one reachable deterministic operation, and `nibrs:rollup` is reached through the
arrestee-demographics tables. `current.national` is the single capability with no eligible
operation; it is evaluated by the Task 11 sweep, not by a route case. If a route case resists,
the fixture is wrong. **Do not weaken the assertion.**

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

So the evidence has to be produced where the verification happens: extend `OriginVerdict` with the originating `planFamily` **and `capability`**, both extracted server-side from the verified proof envelope on the matching `query_log` row. Both must be `null` for absent, unbound, malformed, unproved, incompatible-version, and source-mismatched records. Only then may POST persist them, and only when `originIsVerified(origin)` holds and the capability's own artifact matches the chart's tab.

**The capability is what gets recovered, not the family.** Recovering a family and then looking up "the" capability for it cannot work: `deterministic-nibrs-continuous-reporters` alone spans four capabilities over four different summary tables, so the lookup would name the wrong contract three times out of four, and each metadata family spans five, one per source.

Nothing about either field comes from the embed client, at creation or on read. It still cannot make a read `healthy` in 2A, because the receipt is absent.

- [ ] **Step 1: Add the additive columns**

In `scripts/migrate-shared-charts-proof.js`, add to the column list alongside `origin_request_id` / `origin_state`:

```javascript
  { name: "origin_plan_family", type: "TEXT" },
  { name: "origin_capability", type: "TEXT" },
```

Nullable and additive, so the baseline release `c2b52ca` still reads the table.

- [ ] **Step 2: Extend `OriginVerdict` with a server-extracted plan family and capability**

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
  /**
   * The ORIGINATING answer's verified capability, read from the same envelope.
   *
   * This, not the family, is what an embed read needs: one family can span four capabilities,
   * so recovering a family and then looking up "the" capability for it would pick the wrong
   * contract three times out of four. Persisted by the finalization (Task 7) and never
   * supplied by a client. Null unless the verdict is `verified` and the envelope carried it.
   */
  capability: string | null;
}
```

Every existing `return` in `verifyEmbedOrigin()` gains `planFamily: null, capability: null`; only
the verified branch may set them, and only from the envelope:

```typescript
/**
 * Plan family and capability from a stored proof envelope, or nulls.
 *
 * Validated, not trusted: the envelope must parse, must carry the current manifest
 * version, and must name a non-empty value. An envelope written by a newer schema is
 * NOT read with today's semantics -- the same rule the digest reporter applies. Each field
 * is recovered independently: an envelope predating `manifest.capability` yields a family
 * but no capability, and that must leave the read unresolved rather than let the family
 * stand in for one.
 */
function originEvidenceFromEnvelope(json: string | null | undefined): { planFamily: string | null; capability: string | null } {
  const none = { planFamily: null, capability: null };
  if (!json) return none;
  let envelope: unknown;
  try { envelope = JSON.parse(json); } catch { return none; }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return none;
  const manifest = (envelope as { manifest?: unknown }).manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return none;
  const record = manifest as { v?: unknown; planFamily?: unknown; capability?: unknown };
  if (record.v !== PROOF_MANIFEST_VERSION) return none;
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
  return { planFamily: text(record.planFamily), capability: text(record.capability) };
}
```

Select `proof_manifest` alongside the columns the verifier already reads, and spread
`originEvidenceFromEnvelope(row.proof_manifest)` onto the verified branch only.

**This depends on Task 7 recording `manifest.capability`.** Task 7 already threads the resolved
capability into the finalization to evaluate health; it must also persist it on the manifest, or
there is nothing here to recover.

- [ ] **Step 3: Write the failing `lib/embed-origin.ts` regressions**

In `scripts/test-embed-origin.ts`:

```typescript
check("a verified origin carries the originating plan family AND capability", () => {
  // Row written with a v1 envelope naming a real family and a real registry capability.
  const verdict = verifyEmbedOrigin(db, candidate);
  assert.strictEqual(verdict.state, "verified");
  assert.strictEqual(verdict.planFamily, "deterministic-murder");
  assert.strictEqual(verdict.capability, "shr::incidents::incidents(homicide_type,victim_count,year)");
});

check("both fields are null for every non-verified state", () => {
  // absent (no request id), unbound (no db), and bound_unproven must all report null:
  // this is evidence about a PROVEN answer, and attaching it to an unproven record
  // would let the embed read name a capability it never earned.
  for (const verdict of [verifyEmbedOrigin(db, { ...candidate, requestId: null }), verifyEmbedOrigin(null, candidate)]) {
    assert.strictEqual(verdict.planFamily, null);
    assert.strictEqual(verdict.capability, null);
  }
  // plus the existing bound_unproven fixture
});

check("a malformed, unversioned, or newer-schema envelope yields nulls", () => {
  for (const envelope of ["{not json", "{}", JSON.stringify({ manifest: { v: 2, planFamily: "x", capability: "y" } }), JSON.stringify({ manifest: { v: 1 } })]) {
    // Rewrite the row's proof_manifest to `envelope`, re-verify, and assert both are null.
  }
});

check("an envelope predating manifest.capability yields a family but NO capability", () => {
  // The pre-existing-envelope case. It must NOT fall back to a family lookup: the read stays
  // unresolved, which withholds authority instead of guessing which of four contracts it was.
  const envelope = JSON.stringify({ manifest: { v: PROOF_MANIFEST_VERSION, planFamily: "deterministic-murder" } });
  // Rewrite the row's proof_manifest to `envelope`, re-verify:
  //   verdict.planFamily === "deterministic-murder"; verdict.capability === null.
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
Expected: FAIL — `OriginVerdict` has neither `planFamily` nor `capability`, so nothing can be
persisted or recovered.

- [ ] **Step 6: Persist and recover the evidence**

At creation, POST already computes `origin = verifyEmbedOrigin(...)`. Store `origin.planFamily`
into `origin_plan_family` and `origin.capability` into `origin_capability` **only when all three
hold**:

```typescript
    const spec = origin.capability ? specFor(origin.capability) : null;
    const sourceMatches = spec !== null && spec.artifact === artifactOf(sourceForTab(body.tab));
    const originFamily = originIsVerified(origin) && sourceMatches ? origin.planFamily : null;
    const originCapability = originIsVerified(origin) && sourceMatches ? origin.capability : null;
```

The source check matters as much as the verified state, and it is made against the **capability's
own artifact** rather than against a family map: a capability belonging to another source is a
mismatch, and persisting it would let a read evaluate the wrong artifact's health. On read,
recover `origin_capability` and use it only when the stored `origin_state` is `verified`;
otherwise pass null so the read stays unresolved and fails closed. `origin_plan_family` is
retained for the digest and for debugging, and is never used to select a capability.

Because the read still has no sealed derivation, `resolveCapability` must accept this path explicitly rather than by loosening its rules. Add a narrow second entry point used only here:

```typescript
/**
 * Capability for a replayed embed read.
 *
 * Separate from resolveCapability ON PURPOSE: that function's contract is "a verified
 * token or nothing", and widening it would let any caller skip verification. This path
 * trusts SERVER-PERSISTED evidence instead -- a capability that verifyEmbedOrigin()
 * extracted from the originating answer's proof envelope and that POST stored only for a
 * verified, source-matched origin -- and only when the stored origin verdict is
 * `verified`. It can still never produce `healthy` in Stage 2A.
 */
export function resolveCapabilityFromPersistedOrigin(
  sourceId: SourceId, originState: string | null, originCapability: string | null,
): { capability: string } | { unresolved: string } {
  if (originState !== "verified") return { unresolved: `origin state '${originState ?? "absent"}' is not a verified origin` };
  if (!originCapability) return { unresolved: "origin evidence records no capability" };
  const spec = specFor(originCapability);
  if (!spec) return { unresolved: `origin capability '${originCapability}' is not in the registry` };
  if (spec.artifact !== artifactOf(sourceId)) {
    return { unresolved: `origin capability '${originCapability}' belongs to ${spec.artifact}, not ${sourceId}` };
  }
  return { capability: originCapability };
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

### Task 11: Digest-time registry sweep

**Files:** Create `lib/source-health-sweep.ts`, `scripts/test-source-health-sweep.ts`; modify `package.json`

`sourceHealthFor` is **request-driven**. `current.national` has no eligible deterministic
operation, so nothing ever calls it and registry membership alone evaluates nothing. Frozen
spec §8:241 requires Current Trends to "independently validate national and sample-agency
tables and their generation alignment", so Stage 2A must actually run those probes.

- [ ] **Step 1: Sweep contract**

```typescript
export type SweepEntry = { capability: string; health: SourceHealth; trace: HealthTrace };
export function sweepRegistry(env?: NodeJS.ProcessEnv): SweepEntry[];
```

Requirements, each asserted:

- Runs **outside** request paths, and only when source-health observation is enabled.
- Enumerates **every** Register A capability, including those with no eligible operation.
- Evaluates `current.national` and `current.sample_agencies` **independently** — separate
  providers, separate verdicts, no shared short-circuit.
- Emits a trace for **every** entry. An absent artifact or receipt becomes an explicit
  `unknown` boundary, never an omission from the output.
- Bounded, read-only, and failure-isolated: one capability throwing cannot abort the sweep or
  the digest (invariant 15).

- [ ] **Step 2: Tests**

```typescript
check("every registered capability is visited exactly once", () => {
  const entries = sweepRegistry(enabledEnv);
  const seen = entries.map((e) => e.capability).sort();
  assert.deepStrictEqual(seen, [...CAPABILITY_IDS].sort());
  assert.strictEqual(new Set(seen).size, seen.length, "a capability was visited twice");
});

check("both Current capabilities are reported independently", () => {
  const entries = sweepRegistry(enabledEnv);
  assert.ok(entries.find((e) => e.capability === "current.national"));
  assert.ok(entries.find((e) => e.capability === "current.sample_agency_series"));
});

check("current.national carries the generation-alignment rule", () => {
  // national_monthly MAX(year*100+month) must equal agency_monthly's; a lagging national
  // series means one build ran without the other.
});

check("a throwing capability does not abort the sweep", () => {
  // View over a dropped table: PRAGMA succeeds, COUNT(*) throws. Every other entry must
  // still be present, and the thrower's boundary must be "threw".
});

check("with observation off the sweep performs no health work", () => {
  assert.deepStrictEqual(sweepRegistry({}), []);
});
```

- [ ] **Step 3: Commit**

```bash
git add lib/source-health-sweep.ts scripts/test-source-health-sweep.ts package.json
git commit -m "Sweep every registered capability at digest time, including the unoperated ones"
```

---

## Performance workstream

An explicit workstream, not an end-of-stage adjustment.

1. **Pre-implementation baseline** captured before any Stage 2A code lands.
2. **Same-build off-versus-shadow comparison** — one build, mode the only variable.
3. **Cold and warm cases across all five sources.**
4. **Source-health evaluation and cache instrumentation** — evaluations, hits, misses,
   evictions, per-capability timings.
5. **Zero health work in `off`** — asserted by instrumentation counters reading **zero**, not
   inferred from absence of symptoms.
6. **Identical response bytes and identical model-call sequences** between modes.
7. **p50/p95 thresholds** against the spec §11 budget (<50 ms median, 100 ms p95 added
   latency). **p99 is reported but observational** — it is not a frozen threshold unless a p99
   budget is separately approved.
8. **Repeat after Stage 2B** hard isolation and receipts land.
9. **Production shadow observation window** before any activation.

---


---

## Stage 2 completion criteria

**Stage 2A delivers:** the capability inventory **generated from the derived catalogs** (56
operation cases — 54 factual, 2 unavailable — yielding **50 operation-backed capabilities**, plus
`current.national` as sweep-only); sealed metadata operation tokens replacing one coarse family;
the structural evaluator with preflight adapter, artifact-coherence check, required columns, row
bounds, dependencies, generation alignment and semantic reliability alignment; evaluation traces;
capability resolution from verified tokens and, for embeds, from server-persisted origin
evidence; the default-off flag gate; the budget switch; manifest wiring; the digest-time registry
sweep (Task 11); and `unknown` verdicts wherever receipts are absent.

**Stage 2B delivers:** real build/import receipts; genuine `dataVersion` so `healthy` becomes
reachable; and hard timeout isolation.

**Stage 2 closes only when both have landed and these combined fixtures pass:**

1. Every capability produces an evidence-backed verdict — a trace showing a real database and
   real checks, not an invocation.
2. `unknown`, or a missing receipt, can never authorize an answer.
3. Stale data answers only the periods it covers.
4. Breaking one capability does not degrade unrelated capabilities.
5. Source health reaches `manifest.source` **and** the delivery gate, with `permitsAnswer()` and
   `factualDeliveryBlocker()` in agreement.
6. `off` performs no request-path source-health work.
7. Shadow remains user-invisible at the route level **and** on embed reads.
8. A probe cannot delay a response: hard timeout isolation exists.
9. The operation-taxonomy regression is green, including its sensitivity probes.

Asserted by this plan: 1 (Tasks 1, 9, 10), 4 (Task 8), 5 (Task 7), 6 (Task 5), 7 (Tasks 9, 10),
9 (`scripts/test-operation-taxonomy.ts`). Partial: 3 — coverage is computed and traced, but
"answers only periods it covers" is enforceable only once a healthy verdict exists. Vacuous in
2A and therefore re-asserted in 2B: 2. Not addressed in 2A: 8.

## Known product defect, NOT fixed in Stage 2A

`buildNibrsCountywideDemographicQuery` requires a county geography **and** a separate
`kind==="state"` geography, because `stateCode()` (`lib/nibrs-scope-deterministic.ts:67`) reads
only the latter. `"Dallas County, Texas"` is rejected; `"Dallas County in Texas"` resolves the
county to **Alabama** and filters on Texas. Coverage is taken only with `Maricopa County in
Arizona`, which is internally consistent. A reproducer belongs in the NIBRS suite: assert that
`"Dallas County, Texas"` either builds with `state:TX` or declines — never builds an Alabama
county against a Texas filter.

## Verification status of the dependency data

RTCI, Historical, NIBRS, SHR, Hate Crime and the rollup artifact were inspected read-only in
production; the fixtures replay production DDL including indexes, with synthetic rows only.
Three production conventions are load-bearing and commented at the seed sites: uppercase
`agencies.city`, Title-Case `historical_agency.agency`, and complete offence-plus-rate column
sets. Hate Crime is exercised in **both** crosswalk states, because production lacks the
crosswalk and only the absent branch would otherwise be observed.
