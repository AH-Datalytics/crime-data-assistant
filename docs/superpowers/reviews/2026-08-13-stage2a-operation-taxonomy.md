# Stage 2A — deterministic operation taxonomy and health-capability registry

**Date:** 2026-08-13, corrected 2026-08-14 · **Branch:** `feature/verified-answer-only`
**Status:** Derived by instrumented observation, with the contract settled by execution.

**Supersedes** the version of this document shipped at `81fab50`, and with it three earlier
inventories (18/20, 41, and 40 capabilities) that were hand-derived from emitted SQL.

**`81fab50` is not a valid baseline.** Its review made three claims its own artifacts
contradicted, listed below under §11 rather than quietly dropped, because the pattern of
*asserting more than was measured* is the thing this correction is trying to stop.

**Regression:** `scripts/test-operation-taxonomy.ts` (registered in `npm test`)
**Catalogs:** `scripts/fixtures/operation-taxonomy/{operation-cases,capability-registry}.json` (derived)
**Policy:** `scripts/fixtures/operation-taxonomy/capability-policy.json` (**hand-authored**)

---

## 1. Method — observation for structure, execution for the contract

Static extraction produced a confidently wrong inventory three times, because each attempt missed
builders reached through a variable, a ternary, or a shared helper. Structure is therefore derived
by **executing every builder against a real SQLite handle and recording what it touched**:

1. **Preparation-time reads** — statements prepared while the builder/resolver decided and
   constructed, captured by wrapping `Database.prototype.prepare` before `lib` is imported, and
   scoped per case by `AsyncLocalStorage` so concurrent and post-await activity cannot be
   attributed to the wrong case.
2. **Emitted-SQL reads** — tables named by the SQL the builder returned.

Required columns are **not** derived by matching identifiers against schemas (§3). They are
settled by mutating the artifact and asking SQLite what still compiles.

Coverage is asserted, never inferred: each case must reach its expected plan family and its
expected capability, with preparation-only dependencies pinned separately.

## 2. Counts — denominators kept distinct

| Measure | Value |
|---|---|
| Sealed families today | 26 |
| Seal sites | 12 |
| Target families after Task 1A | 29 |
| Importable-builder cases | 56 |
| Route-handler cases | 2 |
| **Operation cases** | **58** |
| — factual | **57** |
| — unavailable **in production** | **1** |
| — unverified | **0** |
| **Operation-backed capabilities** | **51** |
| Registry-sweep only (`current.national`) | 1 |
| **Register A total** | **52** |
| Capabilities with any authored policy | 1 |
| **Capabilities eligible to authorize** | **0** |

Operation-backed by artifact: `nibrs` 27 · `crime_data` 15 · `shr` 5 · `hate_crime` 4.

Grouping key is artifact + (preparation ∪ emitted) tables + exact required columns. Provisional
receipt identity is **excluded** from the grouping key — an invented boundary must not decide
whether two operations are one capability.

### 2.1 A fixture that cannot reach a contract is `unverified`, never `unavailable`

`unavailable` is a claim about **production**. Recording a fixture's failure to reach a contract as
`unavailable` is how `deterministic-shooting` was dropped from the count at `81fab50` while
appearing accounted for: the case showed `capability: null` and nothing failed.

Exactly one case may now be `unavailable`, and it is listed explicitly with its reason
(`hate_crime:metadata-agency-directory-county`, §4). Any other non-factual case fails the suite.

## 3. Required columns are settled by execution

The predecessor intersected every identifier in a statement with every participating table's
schema. That has no notion of which table a name belongs to, and it produced:

| Defect | Example |
|---|---|
| A name declared by two tables credited to both | `population` attributed to `historical_agency_crime`, which the scorecard SQL never reads it from |
| Words inside string literals treated as columns | `SELECT 'monthly agency trends' …` produced `agency_monthly.agency`; `'state and national'` produced `historical_state_national.state` |
| SQL keywords treated as columns | `CASE … END` produced `historical_agency.end` in 3 cases |

Attribution now resolves names through SQL scopes: FROM/JOIN aliases, each arm of a UNION
separately (the builders reuse `AS s` for a *different* table in each arm), subquery nesting, and
CTE pass-through (`SELECT x.*` re-exported, then read as `x.ori9` outside).

That attribution is then checked **both ways** against execution, by renaming a column in the
artifact and asking whether the operation's real SQL still compiles:

- every **declared** column must break compilation — otherwise it is over-attributed;
- no **undeclared** column may break compilation — otherwise the contract understates its needs.

Renaming, not dropping, and renaming the column on **every** participating table that declares it.
A single-table rename is unsound on its own: `d.ori IN (SELECT ori FROM nibrs_consistent_reporters)`
still compiles with that table's `ori` renamed, because `ori` then binds to the outer `d.ori` as a
correlated reference — so a single-table probe reports a column the operation genuinely reads as
unused. The first version of this probe reported exactly that against the four continuous-reporter
cases, and those reports were wrong.

Where two participating tables declare the same name, the single-table probe is inconclusive by
construction, and the suite says so instead of pretending otherwise: attribution there rests on the
scope resolution, and only the group probe constrains it.

**What the predecessor's probe proved: nothing.** It removed a value the extractor had produced
and asked the extractor whether its output had changed. No input could make it fail, and it passed
while `historical_agency.end` sat in the registry.

## 4. Contract fields: derived structure vs. authored policy

Observation can see the artifact, the tables and the columns. It cannot see what a coverage basis
*means*, which integrity rule applies, whether unavailability is expected, or who owns the receipt.
Deriving those produced a constant — `availability: "observed-available"` for all 50 capabilities —
and a receipt string built from the first emitted table, both presented as contract. One
consequence: the Hate Crime crosswalk capability was recorded "available" although production is
**conditional**.

| Field | Source |
|---|---|
| artifact, prepDependencies, emittedDependencies, requiredColumns | derived by observation + execution |
| coverage, integrity, availability, receiptOwner | **hand-authored** in `capability-policy.json`, or `null` |

**Fail closed.** A capability whose policy is absent *or partly unauthored* is
`authorizationEligible: false` and can authorize nothing. Today **1 of 51** is partly authored and
**0** are eligible. Authoring the rest is Stage 2B work and requires decisions this harness cannot
make; the honest state is null, not a placeholder.

The one authored entry is the Hate Crime county capability, whose availability is
`conditional-on-artifact`: `agency_county_crosswalk` is absent from production `hate_crime.db`, so
`entitySql` takes the SQL-less exit and seals nothing. **Conditionally unavailable is not
unhealthy** — the builder decides at runtime. Its `coverage`, `integrity` and `receiptOwner` remain
null, so it too authorizes nothing. Both artifact states are exercised: absent for production, and
present for the other four sources.

## 5. Capability identity is builder-declared, not family-derived

Eleven families each span several capabilities, so no function from family to capability can be
truthful:

| Family | Capabilities |
|---|---|
| `deterministic-nibrs-continuous-reporters` | 4 |
| `deterministic-nibrs-countywide-demographic` | 4 |
| `metadata-year-coverage` / `-state-coverage` / `-agency-directory` / `-agency-directory-county` | 5 each (one per source) |
| `deterministic-nibrs-local-demographic-count` / `-share` | 3 each |
| `deterministic-nibrs-rollup-juvenile-arrests-race`, `-structured-local-trend`, `-local-city-offense-count` | 2 each |

`sourceId` does not disambiguate the NIBRS cases: all four contracts live on the same source. The
plan's `resolveCapability()` called `capabilityForFamily(sourceId, family)`, which would return the
wrong contract three times out of four. The builder is the only place that knows which contract it
built, so it seals that identity: `sealPlanDerivation(family, capability, sql)`, and
`verifyPlanDerivation` returns the **verified** capability. Embed provenance persists the
capability (`origin_capability`) rather than recovering a family and looking one up.

An envelope predating the field resolves to `unresolved` — withholding authority rather than
inventing an identity for an answer produced before the field existed.

## 6. Preparation-only dependencies — three, not five

Three capabilities read tables during resolution/construction that **never** appear in their
emitted SQL. No SQL-reading method can see these.

| Capability | Preparation-only tables |
|---|---|
| `historical:agency_scorecard` | `agencies`, `agency_monthly` (**live RTCI**) |
| NIBRS local city offense count | `agencies` |
| `deterministic-shooting` | `shr_agency_alias`, `shr_agency_identity` |

The scorecard line confirms its health contract spans **live RTCI and historical** inputs. The
shooting line is new, and only visible because the fixture now reaches that path (§7).

## 7. Route-handler cases stay route-driven

`deterministic-shooting` (`shr-query/route.ts:710`) and `deterministic-place-lookup`
(`query/route.ts:375`) are constructed inside their route files; no importable builder exists. They
are driven through the real handlers and assert the deterministic terminal exit was reached by
reading the guardrails written to `query_log`. **They must not be replaced with static
assertions** — a static assertion would observe neither the preparation-time reads nor the exit
actually taken.

`deterministic-shooting` required two production tables the fixture lacked. Without
`shr_agency_alias` and `shr_agency_identity`, `resolveShrAgency` returns `unsupported` for every
city (`lib/shr-place-resolver.ts:123`), the route takes its place-resolution-block exit, and the
`incidents ⋈ victims` contract is never reached. `agency_type` must be `'City'` and `alias_key`
must be uppercase, or the join silently resolves `not_in_source`.

## 8. Branch coverage is derived from the builders

The case list was handwritten and the family scan was a curated regex, so a fifth role branch under
an existing family would change neither the 26-family set nor the 12 seal sites — omitting it stayed
green. Role branches are now read out of the builder source as
`{ table, offenseColumn, countColumn, countAlias }` configs, and every branch must be exercised by a
case **for every family that selects it**.

This immediately found two unexercised branches: `deterministic-nibrs-local-demographic-share`
covered only the victim role, so the offender and arrestee share contracts were never observed. Both
are now cases.

The derivation must read **ternary** guardrails as well as literals. A literal-only scan finds no
family for the two builders that seal through a ternary, which silently produces an empty
requirement set — the check would have passed by measuring nothing.

## 9. Harness self-tests — load-bearing

Two harness bugs manufactured false findings before self-tests existed: `dbFor()` routed NIBRS
metadata to the RTCI database, and `record()` fell back to the NIBRS schema for `current`/
`historical`, extracting zero tables. Both are covered by assertions that run before any branch
result is trusted and exit non-zero on failure: source → handle/path (4 handles + the rollup env
var) and source → schema (a marker table unique to each of 6 sources).

Added here: the rename probe asserts it **restored** every artifact schema, so a probe that
corrupted the fixture cannot leave later cases quietly measuring a mutated database.

## 10. Product defect — county/state parser (NOT fixed in Stage 2A)

`buildNibrsCountywideDemographicQuery` needs a county geography **and** a separate `kind==="state"`
geography, because `stateCode()` (`nibrs-scope-deterministic.ts:67`) reads only the latter. Natural
phrasing collapses both into one county geography and is rejected.

| Question | Geographies | Builds |
|---|---|---|
| `…in Dallas County, Texas` | county `Dallas County` state:TX | no |
| `…in Dallas County in Texas` | county state:**AL** + state TX | yes — **inconsistent** |
| `…in Cook County in Illinois` | county state:**GA** + state IL | yes — **inconsistent** |
| `…in Maricopa County in Arizona` | county state:AZ + state AZ | yes — consistent |

Coverage is taken **only** with Maricopa/Arizona; the inconsistent paths are not counted as
coverage. Reproducer to add: assert `Dallas County, Texas` either builds with `state:TX` or is
declined — never builds an Alabama county against a Texas filter.

## 11. Claims at `81fab50` that its own artifacts contradicted

Recorded rather than silently corrected, because each was disprovable from a file that commit
shipped, and finding them required reading the artifacts instead of the intent.

| Claim | What the artifact showed |
|---|---|
| "deterministic-shooting verified" | `operation-cases.json:272` recorded `unavailable`, `capability: null` |
| "Sensitivity probes prove each declared column is load-bearing" | the probe compared the extractor against itself; `historical_agency.end` was in the registry |
| "**Five** capabilities read tables absent from their emitted SQL", listing `agency_county_crosswalk` for three county-metadata capabilities | that commit's `capability-registry.json` recorded **two** preparation-only capabilities; the crosswalk is in those operations' *emitted* SQL |

## 12. Fixtures

Synthetic rows over production-derived DDL, including **114** indexes across the six files — 110
excluding the schema-only `query_log` (several builders use `INDEXED BY`; queries fail without
them). Seeded ORIs, invented counts. **No production rows.** Built into a temp directory per run.
(The predecessor's "77" is another number that was never measured; the DDL files contain 28 for
`crime_data`, 49 `nibrs`, 18 `shr`, 8 `rollup`, 7 `hate_crime`, 4 `query_log`.)

Four production *conventions* had to be adopted, each with a comment at the seed site:

| Convention | Why |
|---|---|
| `agencies.city` UPPERCASE | `normalizeCityLiteral` uppercases before matching (`nibrs-city-aliases.ts:22`); a title-cased fixture silently resolves `not_in_source` |
| `historical_agency.agency` Title Case, state/type lowercase | the scorecard matches `ha.agency` against the resolver's candidate verbatim (`agency-scorecard.ts:148`) |
| complete offence **and** rate/clearance column sets | aggregate and agency scorecards skip any row missing one, and report unavailable |
| `shr_agency_alias.alias_key` UPPERCASE, `agency_type = 'City'` | `agencySearchKey` uppercases (`shr-agency-normalization.ts:71`) and `requestedType("city")` filters the alias join on the type |

## 13. Gate facts (traps for future maintenance)

- `continuous-reporters` rejects **any** named geography (`:105`).
- `structured-local-trend` rejects single-offense + single-city **counts** (`:966`).
- `clearance-method` requires clearance **and** arrest **and** exceptional (`:254-261`).
- `local-demographic` requires an offense; role from `demographicRole` (`:769`).
- `indexed-state-followup` needs `indexed to YYYY`/`baseline YYYY`, a rate word, 2–20 states.
- `local-recent-change` needs "violent crime" + change word + "in/over/during the past/last year".
- `place-lookup` requires **no** metric intent — "crime in Austin, TX" is rejected; "Austin, TX" works.
- `/api/query` is SSE: the deterministic exit and its `writeLog` run inside the stream's `start()`,
  so the response body must be drained or nothing executes.
- Routes need a signed `pageToken` aged >1s (`page-token.ts:32-34`), secret `AUTH_PASSWORD`.
- `dynamic-facts` needs `national_clearance_rate`, `nibrs_state_coverage` and
  `summary_state_monthly` seeded, or it throws at import.

## 14. What is still open

- **50 capabilities have no authored policy** and therefore authorize nothing. Stage 2A
  implementation must not treat an unauthored capability as usable.
- Receipt ownership is unmapped for all 51 (Stage 2B).
- The county/state parser defect (§10) is unfixed by design.
