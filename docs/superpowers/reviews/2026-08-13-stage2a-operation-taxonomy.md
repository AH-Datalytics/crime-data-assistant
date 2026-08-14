# Stage 2A — deterministic operation taxonomy and health-capability registry

**Date:** 2026-08-13 · **Branch:** `feature/verified-answer-only`
**Status:** Derived by instrumented observation. Supersedes the two incorrect predecessors.

**Supersedes:**
- `docs/superpowers/reviews/2026-08-13-stage2a-family-capability-enumeration.md` — the
  **18-family / 20-capability** enumeration. Wrong: it resolved the NIBRS variable seal by
  grepping one module.
- The **41-capability** draft circulated during review. Wrong: it hand-derived dependency
  sets from emitted SQL and deleted `current.national`.
- The **20-capability** inventory in
  `docs/superpowers/plans/2026-08-13-stage2-source-health-registry.md`.

**Regression:** `scripts/test-operation-taxonomy.ts` (registered in `npm test`)
**Catalog:** `scripts/fixtures/operation-taxonomy/expected-capabilities.json`

---

## 1. Method — observation, not extraction

Three successive rounds of static extraction each produced a confidently wrong inventory,
because each missed builders reached through a variable, a ternary, or a shared helper. The
taxonomy is now derived by **executing every builder against a real SQLite handle and
recording what it touched**.

Two surfaces per branch:

1. **Preparation-time reads** — statements prepared while the builder/resolver decided and
   constructed, captured by wrapping `Database.prototype.prepare` before `lib` is imported.
2. **Emitted-SQL reads** — tables and columns named by the SQL the builder returned.

Coverage is asserted, never inferred: each case must reach its expected **plan family** and
its expected **capability** (artifact + preparation ∪ emitted table set), with
preparation-only dependencies pinned separately.

## 2. Counts — denominators kept distinct

| Measure | Value |
|---|---|
| Sealed families today | 26 |
| Target families after Task 1A | 29 |
| Importable-builder cases | 53 |
| Route-handler cases | 2 |
| **Combined eligible operation cases** | **55** |
| Verified | 55 |
| Unresolved | 0 |
| **Operation-backed capabilities** | **39** |
| **Registry-sweep only (`current.national`)** | **1** |
| **Register A total** | **40** |

Operation-backed by artifact: `nibrs` 23 · `crime_data` 12 · `shr` 2 · `hate_crime` 2.

Grouping key is artifact + (preparation ∪ emitted) tables; columns are the union observed
across branches sharing that set. Column sets alone are **not** a discriminator — they vary
by question (offense filters, breakdowns), not by capability; grouping on them yields 49,
which is question variance. Provisional receipt identity is **excluded** from the grouping
key (§6).

## 3. Register A — capability contract fields

Every capability records: **artifact**, **preparation-time dependencies**, **emitted-SQL
dependencies**, **required columns**, **coverage basis**, **integrity/preflight rules**,
**availability**, and a **provisional receipt identity**. The machine-readable contract for
all 55 cases is `scripts/fixtures/operation-taxonomy/expected-capabilities.json`; the
regression fails if any field drifts.

### 3.1 The sweep-only capability

`current.national` has **no eligible deterministic operation** and therefore cannot emerge
from an operation harness. It is registered separately because frozen spec §8:241 requires
Current Trends to "independently validate national and sample-agency tables and their
generation alignment".

| Field | Value |
|---|---|
| Artifact | `crime_data` |
| Emitted-SQL dependencies | `national_monthly` (year, month, offense, count, agency_count) |
| Preparation-time dependencies | none |
| Coverage basis | `national_monthly.year` |
| Integrity rule | generation alignment: `MAX(year*100+month)` of `national_monthly` **=** `agency_monthly` |
| Availability | always |
| Receipt identity | `rtci_national` *(provisional)* |
| Eligible operations | **none — measured, never authorizing** |

Verified in production 2026-08-13: both series at **202605**, so the rule holds on arrival.

Because `sourceHealthFor` is request-driven, registry membership alone does not evaluate it.
Stage 2A therefore requires a **digest-time registry sweep** (plan Task 11) that enumerates
every Register A capability — including those with no eligible operation — evaluates Current
national and sample-agency independently, emits a trace per entry with absent artifacts or
receipts recorded as explicit `unknown` boundaries rather than omissions, and is bounded,
read-only and failure-isolated.

### 3.2 Preparation-only dependencies

Five capabilities read tables during resolution/construction that **never appear in their
emitted SQL**. No SQL-reading method can see these.

| Capability | Preparation-only tables |
|---|---|
| `historical:agency_scorecard` | `agencies`, `agency_monthly` (**live RTCI**) |
| `nibrs:local_city_offense_count` | `agencies` |
| `current:metadata-agency-directory-county` | `agency_county_crosswalk` |
| `historical:metadata-agency-directory-county` | `agency_county_crosswalk` |
| `shr:metadata-agency-directory-county` | `agency_county_crosswalk` |

The scorecard line confirms its health contract spans **live RTCI and historical** inputs, as
review claimed and as no hand-derived draft stated.

### 3.3 Conditionally unavailable, not unhealthy

`hate_crime:metadata-agency-directory-county` emits **no SQL at all**: `agency_county_crosswalk`
is absent from production `hate_crime.db`, so `entitySql:457` takes the SQL-less unavailable
exit and seals nothing. Recorded as **conditionally unavailable** — the builder decides at
runtime — never as a structurally unhealthy capability. The fixture reproduces the absent
state; the present state is exercised for the other four sources.

## 4. Product defect — county/state parser (NOT fixed in Stage 2A)

`buildNibrsCountywideDemographicQuery` needs a county geography **and** a separate
`kind==="state"` geography, because `stateCode()` (`nibrs-scope-deterministic.ts:67`) reads
only the latter. Natural phrasing collapses both into one county geography and is rejected.

| Question | Geographies | Builds |
|---|---|---|
| `…in Dallas County, Texas` | county `Dallas County` state:TX | no |
| `…in Harris County, Texas` | county `Harris County` state:TX | no |
| `…in Cook County, Illinois` | county `Cook County` state:IL | no |
| `…in Dallas County in Texas` | county state:**AL** + state TX | yes — **inconsistent** |
| `…in Cook County in Illinois` | county state:**GA** + state IL | yes — **inconsistent** |
| `…in Maricopa County in Arizona` | county state:AZ + state AZ | yes — consistent |

Coverage is taken **only** with Maricopa/Arizona. The inconsistent paths are **not** counted
as coverage. Reproducer to add: assert `Dallas County, Texas` either builds with `state:TX`
or is declined — never builds an Alabama county against a Texas filter.

## 5. Harness self-tests — load-bearing

Two harness bugs manufactured false findings before self-tests existed:

1. `dbFor()` routed NIBRS metadata to the RTCI database → false "unverified".
2. `record()` mapped `current`/`historical` to no schema and fell back to the NIBRS schema →
   those rows extracted **zero tables**, corrupting an entire derivation pass.

Both are now covered by assertions that run before any branch result is trusted, and that
exit non-zero on failure:

- **source → handle/path**: each source's opened handle resolves to its intended fixture
  (4 handles + the rollup env var).
- **source → schema**: `schemaFor(source)` contains a marker table unique to that artifact
  (6 sources).

## 6. Receipt identities are provisional

Receipt identities are placeholders until Stage 2B maps actual builder/import ownership. They
are **excluded from capability deduplication** — an invented receipt boundary must not decide
whether two operations are one capability.

## 7. Fixtures

Synthetic rows over production-derived DDL, **including 77 indexes** (several builders use
`INDEXED BY`; queries fail without them). Seeded ORIs, invented counts. **No production
rows.** `query_log` fixture is schema-only. Built into a temp directory per run.

Three production *conventions* had to be adopted, each with a comment at the seed site:

| Convention | Why |
|---|---|
| `agencies.city` UPPERCASE | `normalizeCityLiteral` uppercases before matching (`nibrs-city-aliases.ts:22`); a title-cased fixture silently resolves `not_in_source` |
| `historical_agency.agency` Title Case, state/type lowercase | the scorecard matches `ha.agency` against the resolver's candidate verbatim (`agency-scorecard.ts:148`) |
| complete offence **and** rate/clearance columns | aggregate and agency scorecards skip any row missing one, and report unavailable |

## 8. Gate facts (traps for future maintenance)

- `continuous-reporters` rejects **any** named geography (`:105`).
- `structured-local-trend` rejects single-offense + single-city **counts** (`:966`).
- `clearance-method` requires clearance **and** arrest **and** exceptional (`:254-261`).
- `local-demographic` requires an offense; role from `demographicRole` (`:769`).
- `indexed-state-followup` needs `indexed to YYYY`/`baseline YYYY`, a rate word, 2–20 states.
- `local-recent-change` needs "violent crime" + change word + "in/over/during the past/last year".
- `place-lookup` requires **no** metric intent — "crime in Austin, TX" is rejected; "Austin, TX" works.
- `/api/query` is SSE: the deterministic exit and its `writeLog` run inside the stream's
  `start()`, so the response body must be drained or nothing executes.
- Routes need a signed `pageToken` aged >1s (`page-token.ts:32-34`), secret `AUTH_PASSWORD`.

## 9. Route-handler cases stay route-driven

`deterministic-shooting` (`shr-query/route.ts:710`) and `deterministic-place-lookup`
(`query/route.ts:375`) are constructed inside their route files; no importable builder exists.
They are driven through the real handlers with instrumentation already installed, and assert
the deterministic terminal exit was reached by reading the guardrails written to `query_log`.
**They must not be replaced with static assertions** — a static assertion would observe
neither the preparation-time reads nor the exit actually taken.
