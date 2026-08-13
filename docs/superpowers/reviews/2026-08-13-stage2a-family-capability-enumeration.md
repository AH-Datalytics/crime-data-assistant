# Stage 2A — plan family enumeration and capability reachability

**Date:** 2026-08-13
**Branch:** `feature/verified-answer-only` @ `3a2714c`
**Status:** Pre-implementation review. Requested before Task 1 code. No product code changed.
**Plan under review:** `docs/superpowers/plans/2026-08-13-stage2-source-health-registry.md`
**Method:** Repository inspection plus read-only schema inspection of the local
`crime_data.db`. Every claim cites a file:line or a schema query.

---

## 0. Verification limits, stated first

- `crime_data.db` (521 MB) is present locally and **was** inspected. Every RTCI and
  Historical table claim below is schema-verified.
- `nibrs.db` and `shr.db` are **0 bytes** locally. NIBRS, SHR, and Hate Crime table claims
  come from reading the SQL builders only, and are **not** schema-verified. Task 1 must
  confirm them against production (read-only) before the inventory is trusted.
- The per-family NIBRS extraction (§2.3) scans each family's enclosing function. SQL
  assembled in a helper called by that function would be missed, so the NIBRS dependency
  sets are a **lower bound**.

---

## 1. The plan's enumeration command undercounts by 4.5×

Task 1 Step 1 specifies:

```bash
grep -rhoE 'seal(Compiler)?PlanDerivation\(\s*"[a-z0-9-]+"' --include=*.ts app lib | ...
```

This matches only string-literal family names. It reports **4** families. The repository
actually seals **18 distinct family names across 12 call sites**; six of those sites seal a
**variable**:

```
app/api/nibrs-query/route.ts:556   sealPlanDerivation(deterministicQuery.guardrail, …)
app/api/query/route.ts:698         sealPlanDerivation(`${agencyScorecard.scope}-scorecard`, …)
app/api/query/route.ts:880         sealPlanDerivation(indexedStatePlan.guardrail, …)
app/api/query/route.ts:941         sealPlanDerivation(multiCityTrend.guardrail, …)
app/api/query/route.ts:1060        sealPlanDerivation(historicalCityChange.guardrail, …)
```

**Replacement enumeration method** (two passes, because one grep cannot resolve a variable):

```bash
# Pass 1 — every seal site, literal or not.
grep -rn "sealPlanDerivation(" --include=*.ts app lib | grep -v "^lib/plan-derivation.ts"

# Pass 2 — for each site sealing a variable, resolve the variable's producing module
# and enumerate the literals it can hold.
grep -rn 'guardrail: "' --include=*.ts lib
grep -rn "export type ScorecardScope" --include=*.ts lib
```

Pass 2 is what surfaces the six NIBRS families, the three scorecard scopes, and the two
multi-city variants. An automated regression for this is specified in §7.

### 1.1 All 12 seal sites

| # | Call site | Family value(s) | Source | Kind |
|---|-----------|-----------------|--------|------|
| 1 | `app/api/query/route.ts:698` | `agency-scorecard`, `state-scorecard`, `national-scorecard` | historical | dynamic |
| 2 | `app/api/query/route.ts:880` | `deterministic-current-indexed-state-followup` | current | dynamic |
| 3 | `app/api/query/route.ts:941` | `deterministic-current-multi-city-trend`, `deterministic-historical-multi-city-trend` | current **and** historical | dynamic |
| 4 | `app/api/query/route.ts:1060` | `deterministic-historical-local-recent-change`, `deterministic-historical-city-change-ranking` | historical | dynamic |
| 5 | `app/api/query/route.ts:1116` | `deterministic-place-lookup` | historical | literal |
| 6 | `app/api/query/route.ts:1165` | `metadata-coverage-answer` | current **and** historical | literal |
| 7 | `app/api/nibrs-query/route.ts:556` | six NIBRS families (§2.3) | nibrs | dynamic |
| 8 | `app/api/nibrs-query/route.ts:625` | `metadata-coverage-answer` | nibrs | literal |
| 9 | `app/api/shr-query/route.ts:423` | `metadata-coverage-answer` | shr | literal |
| 10 | `app/api/shr-query/route.ts:470` | `deterministic-murder` | shr | literal |
| 11 | `app/api/shr-query/route.ts:757` | `deterministic-shooting` | shr | literal |
| 12 | `app/api/hc-query/route.ts:403` | `metadata-coverage-answer` | hate_crime | literal |

Producing modules for the dynamic values: `lib/agency-scorecard.ts:49`
(`ScorecardScope = "agency" | "state" | "national"`),
`lib/current-indexed-state-deterministic.ts:153`, `lib/multi-city-deterministic.ts:199`
(`` `deterministic-${source}-multi-city-trend` ``, `source: "current" | "historical"` at
`:107`), `lib/historical-deterministic-queries.ts:77, 194, 269`, and
`lib/nibrs-deterministic-queries.ts:95, 365, 440, 552, 668, 1145`.

`metadata-coverage-answer` is sealed under **five** sources: the single site at
`app/api/query/route.ts:1165` serves both the Current and Historical tabs.

---

## 2. Real dependencies, CTEs excluded

An earlier draft of this report over-collected: a naive `FROM|JOIN` scan captures CTE names
as if they were tables. `sample_agency_year`, `county_crosswalk`, `series`, `indexed`,
`pivoted`, `city_years`, `values_by_year`, `changes`, `target_places` and others are CTEs,
not tables — confirmed by checking each name against `sqlite_master` in `crime_data.db`.
Everything below is filtered against the real schema.

### 2.1 Current tab

| Family | Real tables |
|--------|-------------|
| `deterministic-current-indexed-state-followup` | `sample_agencies`, `agency_monthly`, `agency_population` |
| `deterministic-current-multi-city-trend` | `agency_monthly`, `agency_population` |
| metadata, state and agency intents | `agencies` (filtered `national_sample = 1`) |
| metadata, year intent | `agency_monthly` |
| metadata, county intent | `agencies` + `agency_county_crosswalk` |

Verified row counts: `agencies` 719, `sample_agencies` 558, `agency_monthly` 559,551,
`agency_population` 7,192, `national_monthly` 791, `agency_county_crosswalk` 25,764.

`agencies` and `sample_agencies` are **distinct tables with distinct roles** — the first is
the RTCI roster carrying the `national_sample` flag, the second the sample cohort. The
plan's inventory treats only the second as a capability.

### 2.2 Historical tab

| Family | Real tables |
|--------|-------------|
| `agency-scorecard` | `historical_agency`, `historical_agency_crime`, `historical_agency_population`, `historical_agency_clearance` |
| `state-scorecard`, `national-scorecard` | `historical_state_national` |
| `deterministic-place-lookup` | `historical_agency`, `historical_agency_crime`, `historical_agency_clearance`, **`historical_staffing`** |
| `deterministic-historical-local-recent-change` | `historical_agency`, `historical_agency_crime`, `historical_agency_population` |
| `deterministic-historical-city-change-ranking` | same |
| `deterministic-historical-multi-city-trend` | same |
| metadata, agency/city intent | `historical_agency` |
| metadata, state intent | `historical_state_national` |
| metadata, year intent | **`historical_agency_crime` AND `historical_state_national`** |

Two tables the plan's inventory omits entirely and which are verified real:
`historical_agency_clearance` (1,151,251 rows) and `historical_staffing` (851,565 rows).
`agency_year_reliability` exists with 21,156 rows and columns
`ori, year, kind, source, columns_json, evidence_json, algorithm_version, generated_at`.

**The composite case.** `yearSql("historical")` (`lib/metadata-coverage.ts:520-524`) is a
`UNION ALL` across `historical_agency_crime` and `historical_state_national`. One family,
genuinely both dependency sets.

### 2.3 NIBRS — every family has a different dependency set

| Family | Tables (lower bound; not schema-verified) |
|--------|------------------------------------------|
| `deterministic-nibrs-juvenile-offender-incidents` | `summary_juvenile_offender_incidents` |
| `deterministic-nibrs-clearance-type-breakdown` | `summary_clearance_detail` |
| `deterministic-nibrs-clearance-method` | `summary_clearance_type` |
| `deterministic-nibrs-comparable-agency-clearance` | `summary_clearance_type`, `agencies` |
| `deterministic-nibrs-local-city-offense-count` | `nibrs_agency_completeness` |
| `deterministic-nibrs-dv-assault-share` | `summary_victim_circumstance`, `summary_victim_state_monthly` |
| metadata, all intents | `agencies` |

The plan's inventory declares `summary_victim_state_monthly` as the sole NIBRS table. **Five
of the six families never read it.** Note also that the two clearance families use the
opposite table from what their names suggest.

### 2.4 SHR and Hate Crime

| Family | Tables (not schema-verified) |
|--------|------------------------------|
| `deterministic-murder` | `incidents`, `victims` |
| `deterministic-shooting` | `incidents` (`app/api/shr-query/route.ts:710`) |
| metadata, all intents | `incidents` |
| hate crime metadata, agency intent | `hate_crime_incidents` |
| hate crime metadata, state and year intents | `hate_crime_participation` |

`victims` is read by the SHR murder path and is absent from the plan's inventory.
`hate_crime_participation` is the sole table for two of three Hate Crime metadata intents
and is likewise absent.

---

## 3. The two genuinely unreachable capabilities

### 3.1 `current:national` — no deterministic path

No sealed family reads `national_monthly`. Verified by counting occurrences in every module
that produces a sealed family:

```
current-indexed-state-deterministic.ts 0   historical-scorecard.ts        0
multi-city-deterministic.ts            0   metadata-coverage.ts           0
historical-deterministic-queries.ts    0   nibrs-deterministic-queries.ts 0
shr-deterministic-murder.ts            0   shr-deterministic-shooting.ts  0
```

`national_monthly` appears only in `lib/claude.ts` (the model's system prompt),
`lib/guardrails.ts`, `lib/query-context.ts`, `lib/completeness-intent.ts`,
`lib/scaffold-helpers.ts`, and `app/api/query/route.ts:160-163` — the last a guardrail that
inspects *model-authored* SQL.

**Classification: no deterministic path.** RTCI national answers are model-authored, and
model paths seal no token by design. The capability and its table are real; Stage 2A's
evidence rule cannot reach them.

### 3.2 `nibrs:rollup` — no deterministic path, and the wrong key

`routeNibrsRollupSql()`, which rewrites `FROM summary_clearance_type` into
`FROM rollup.state_summary_clearance_type` (`lib/nibrs-rollup-router.ts:180`), is called at
`app/api/nibrs-query/route.ts:1100` and `:1154` only. Both are on the model-SQL path. The
deterministic exit at `:526` executes `deterministicQuery.sql` unrewritten, so every
deterministic NIBRS family reads the main database.

Second, deeper problem: even with a deterministic path, `capabilityForFamily(sourceId,
planFamily)` could not select this capability. Rollup routing is decided by the **executed
SQL** — it routes only when the SQL names exactly one of the nine `ROLLUP_SOURCES`
(`:23-29`) and is not agency-scoped (`:174-176`). The same family routes to the rollup at
state/national scope and to the main database at agency scope.

**Classification: no deterministic path, plus family-keying is the wrong key.**

Both capabilities must carry `stage2aReachable: false` with these reasons recorded. Stage 2
cannot close until later work supplies trustworthy operation evidence for them.

---

## 4. `metadata-coverage-answer` is too coarse — the operation-token correction

One family currently covers three structurally different operations, selected inside
`answerMetadataQuestion` (`lib/metadata-coverage.ts:612-660`):

| Branch | Line | SQL builder | Dependency set |
|--------|------|-------------|----------------|
| `year_range` | `:625-629` | `yearSql` | year-coverage; **composite on Historical** |
| entity intents | `:631-650` | `entitySql` / `countyEntitySql` | agency directory; county variant adds the crosswalk |
| state intents | `:652-656` | `stateSql` | state coverage |

Two further branches (`download_help` `:620`, `county_membership_unavailable` `:621`) return
canned answers with **no SQL**. They are not factual source claims and must stay unresolved.

**Correction adopted (option B).** `lib/metadata-coverage.ts` seals its own derivation at
the point each SQL string is constructed, binding family to that exact SQL, and returns it
on `MetadataCoverageResult`. The four routes consume `metadata.derivation` instead of
sealing a generic family of their own. Nothing about the operation is supplied by the route,
so no unverified route-supplied capability string exists.

Four operation families replace the single coarse one:

| Family | Emitted for |
|--------|-------------|
| `metadata-year-coverage` | `year_range` |
| `metadata-agency-directory` | agency/city intents, no county scope |
| `metadata-agency-directory-county` | agency/city intents with a county scope |
| `metadata-state-coverage` | `available_states`, `missing_states`, `state_count` |

This distinguishes all three cases required: Historical agency versus state/national
metadata, Hate Crime participation versus incident/agency metadata, and the year-coverage
query that spans two dependency sets — which resolves to a **composite** capability rather
than an arbitrary choice.

---

## 5. Corrected capability inventory

Capabilities are keyed by **distinct dependency set**, which is the honest unit: declaring a
table the answer never reads produces a verdict about the wrong artifact, and omitting one
it does read leaves a real dependency unchecked. This yields **20 capabilities**, not the
plan's 9. The count is stated plainly so it can be challenged.

### RTCI database (`crime_data.db`) — all schema-verified

| Capability | Tables | Reachable via |
|-----------|--------|---------------|
| `current:national` | `national_monthly` | **unreachable** (§3.1) |
| `current:sample_agencies` | `sample_agencies`, `agency_monthly`, `agency_population` | indexed-state-followup, current multi-city-trend, `metadata-year-coverage` |
| `current:agency_roster` | `agencies` | `metadata-agency-directory`, `metadata-state-coverage` |
| `current:agency_directory_county` | `agencies`, `agency_county_crosswalk` | `metadata-agency-directory-county` |
| `historical:agency_crime` | `historical_agency`, `historical_agency_crime`, `historical_agency_population`, `historical_agency_clearance`; **semantic:** `agency_year_reliability` | agency-scorecard, local-recent-change, city-change-ranking, historical multi-city-trend |
| `historical:place_profile` | above **plus** `historical_staffing` | `deterministic-place-lookup` |
| `historical:agency_directory` | `historical_agency` | `metadata-agency-directory` |
| `historical:state_national` | `historical_state_national` | state-scorecard, national-scorecard, `metadata-state-coverage` |
| `historical:coverage_span` | `historical_agency_crime` **and** `historical_state_national` (composite) | `metadata-year-coverage` |

### NIBRS (`nibrs.db`) — not schema-verified locally

| Capability | Tables | Reachable via |
|-----------|--------|---------------|
| `nibrs:juvenile_offender` | `summary_juvenile_offender_incidents` | juvenile-offender-incidents |
| `nibrs:clearance_detail` | `summary_clearance_detail` | clearance-type-breakdown |
| `nibrs:clearance_type` | `summary_clearance_type` | clearance-method |
| `nibrs:comparable_agency_clearance` | `summary_clearance_type`, `agencies` (composite) | comparable-agency-clearance |
| `nibrs:city_completeness` | `nibrs_agency_completeness` | local-city-offense-count |
| `nibrs:victim_circumstance` | `summary_victim_circumstance`, `summary_victim_state_monthly` (composite) | dv-assault-share |
| `nibrs:agency_roster` | `agencies` | all metadata operations |
| `nibrs:rollup` | `state_summary_clearance_type`, `national_summary_clearance_type` | **unreachable** (§3.2) |

### SHR and Hate Crime — not schema-verified locally

| Capability | Tables | Reachable via |
|-----------|--------|---------------|
| `shr:incidents` | `incidents`, `victims` | deterministic-murder, deterministic-shooting, all metadata operations |
| `hate_crime:incidents` | `hate_crime_incidents` | `metadata-agency-directory` |
| `hate_crime:participation` | `hate_crime_participation` | `metadata-state-coverage`, `metadata-year-coverage` |

---

## 6. `agency_year_reliability` as a semantic dependency

Retained as a dependency of `historical:agency_crime` and `historical:place_profile`, and
labelled explicitly as **semantic/reliability** rather than structural. No family's SQL
reads it, and that is the point: it is the table that establishes whether an agency-year
result can be trusted at all. Without it every agency-year reads as usable and the
scorecard's caveats vanish silently.

A health dependency need not appear in the final SQL when it determines whether the result
is trustworthy. But "the table is nonempty" is not evidence of that, so the check is an
**alignment** check, not a row-count check:

- Every `(ori, year)` in the reliability table resolves to an `ori` present in
  `historical_agency_crime`.
- The reliability table's year span is not strictly narrower than the crime table's year
  span — a reliability build that stopped short leaves recent years silently unqualified.
- `algorithm_version` is present and single-valued across the rows examined; a mixed-version
  table is a half-finished rebuild.

These use the real columns confirmed in §2.2. Structural table/column/row checks still apply
in addition; the alignment check is what makes the dependency meaningful.

---

## 7. Consequences for the plan's tests

### Task 9 — all four existing route cases would fail, correctly

Every case in `scripts/test-shadow-route-equivalence.ts` (`:299`, `:313`, `:327`, `:341`)
drives the **model-SQL** path: each supplies `coldCalls: ["translate", "explain"]` and a
stubbed `reply` containing SQL. No model path seals a derivation, so `resolveCapability`
returns unresolved, no trace is recorded, and the plan's own assertion
`assert.ok(traces.length > 0, …)` fails on all of them.

The plan's instruction — *fix the fixture, not the assertion* — is correct and achievable.
Every source has at least one reachable family, so **no route case may be skipped**:

| Route case | Deterministic family to drive | Fixture tables to add |
|-----------|-------------------------------|-----------------------|
| current | `deterministic-current-multi-city-trend` | none — `agency_monthly`, `agency_population` present |
| historical (new) | `state-scorecard` **or** `deterministic-place-lookup` | `historical_state_national`, or `historical_agency` + `historical_agency_crime` + `historical_agency_clearance` + `historical_staffing` + `agency_year_reliability` |
| nibrs | `deterministic-nibrs-clearance-method` | `summary_clearance_type` |
| shr | `deterministic-murder` | `victims` alongside `incidents` |
| hate_crime | `metadata-state-coverage` | `hate_crime_participation` |

Skips are permitted **only** for `current:national` and `nibrs:rollup`, and each skip
message must name its §3 reason.

### Task 8 — an incorrect mapping in the plan's own test

Plan lines 1276-1279 enable `PROOF_CAPABILITY_CURRENT_NATIONAL` and seal
`metadata-coverage-answer` against `SELECT year, count FROM national_monthly`. Under the
corrected inventory, Current metadata resolves to `current:agency_roster`, and
`current:national` is unreachable. The isolation test must use `current:sample_agencies`
driven by a real Current family.

### New inventory regression

Add a test asserting that **every sealed family or operation is either mapped to a
capability or explicitly classified as unmapped with a written reason** — silent omission
fails. The enumeration it checks against must be produced by the two-pass method in §1,
including variable-valued seal sites, so that adding a seventh NIBRS family with a new
guardrail string fails the suite until it is classified.

---

## 8. Adjacent finding — SHR seals pre-validation SQL

Not part of Stage 2A, recorded because it bounds Stage 2A reachability.

Both SHR deterministic exits seal the **planner's** SQL but execute the **contract
validator's** output:

```
app/api/shr-query/route.ts:456   const contract = runContractValidation(murderPlan.sql);
                          :470   derivation: sealPlanDerivation("deterministic-murder", murderPlan.sql), sql: contract.sql
                          :711   const shootingContract = runContractValidation(plannedShootingSql);
                          :714   const sql = shootingContract.sql;
                          :757   derivation: sealPlanDerivation("deterministic-shooting", plannedShootingSql), sql
```

`validateQueryContractSql` can rewrite in two places
(`lib/query-contract-validator.ts:396`, `:404`). When either fires, the fingerprint no
longer matches, `verifyPlanDerivation` fails, `finalizeProof` records the answer as
`model_authored` (`lib/proof-finalize.ts:390-393`), and Stage 2A resolves no capability.

Practical exposure is narrow but real. The state-alias rewrite is a no-op for SHR —
`STATE_CODE_ALIASES` covers only Nebraska and Guam, and maps both to themselves for the
`shr` source (`lib/query-contract.ts:55-58`). The **city jurisdiction-suffix** rewrite
(`:404`) has no such exemption and fires for city-scoped questions.

No change proposed here; Stage 1 is closed and Codex-approved. The mitigation inside Stage
2A is that the Task 9 SHR fixture must assert the derivation actually verified, so that if
this ever fires the suite reports the real cause instead of an unexplained unresolved
capability. Worth raising with Codex separately.

---

## 9. Decisions taken

Approved by Jeff on 2026-08-13, before any implementation:

1. `current:national` and `nibrs:rollup` marked unreachable with the §3 reasons. No
   manufactured mappings. Stage 2 cannot close until later work supplies trustworthy
   operation evidence for them.
2. Every capability's declared dependencies corrected to the real deterministic operations,
   splitting or combining capabilities as the evidence requires rather than preserving the
   nine-capability shape.
3. Metadata evidence emitted as sealed operation tokens from `lib/metadata-coverage.ts`,
   bound to the exact SQL, per §4.
4. `agency_year_reliability` retained as an explicitly labelled semantic/reliability
   dependency with the alignment checks in §6.
5. The undercounting grep replaced with the two-pass method in §1.
6. Task 9 driven by reachable deterministic fixtures per §7; skips limited to the two
   unreachable capabilities, each naming its reason.
7. An inventory regression added so that no sealed family or operation can be silently
   omitted.
