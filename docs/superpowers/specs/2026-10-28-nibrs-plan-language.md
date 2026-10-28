# NIBRS structured plan language, v1

Phase 3 contract of `2026-10-27-nibrs-engine-restructure.md` (design point 3). Types: `lib/nibrs-plan/plan.ts`.
Validation: `lib/nibrs-plan/validate.ts`. Semantic-layer interface NIBRSAI needs: `lib/nibrs-plan/semantic.ts`.
Example plans for the correctness cases and every required form: `lib/nibrs-plan/examples.ts`.
Test: `npx tsx scripts/test-nibrs-plan-language.ts`.

## What a plan is

- The question reader (the model plus request accounting) produces a **plan**, a **clarification** or a
  **limitation** (`ReaderOutcome`). It never produces SQL.
- A plan names semantic-layer objects by id: measures (`victims.murder`), dimensions (`victim.race`), entities
  (`property`). It knows no tables.
- A plan is validated structurally (P rules), against a pinned semantic-layer version (S rules), and against the
  request ledger (A1). A plan with any problem is not compiled.
- Compilation to DuckDB over a pinned canonical release is deterministic: the same plan, semantic version and
  release give the same query and the same answer.

## The parts of a plan

| Field | Says | Required forms it carries |
|---|---|---|
| `geography` | places, and whether they are separate rows or one combined total | nation (a sum of reported counts, never an agency), state, agency by ORI, county, an agency set by attributes ("cities of 250,000 or more"), several places side by side |
| `period`, `timeBasis` | months, absolute or relative to the release; which date places a unit | month ranges across years (N3), `since`, latest complete year (H1's default, recorded in `defaults`), incident, arrest or clearance date |
| `measures` | one or more measures, each with its counting unit | several measures as separate columns, never added across units |
| `filters` | attribute filters, and **scoped existence filters** | "incidents containing a stolen firearm" (N2): `exists` at incident scope over property, which must declare `attribution: "incident_level_only"` |
| `groupings` | any number, in display order | month × race × sex (N1); 1:n dimensions (weapons, relationships) only with `multiValue: "each_value"`; unknown codes always visible |
| `statistics` | count, share, rate, ratio | **denominator partitions**: `share` with `partition: ["time.month"]` is each month's own denominator (N1); `[]` is the whole result (D); rates over covered population (D8) |
| `transforms` | period comparison, rolling window, top-N | **period comparisons**; **rolling windows** reported only when every month in the window is known; **top-N within each period** (`per: ["time.month"]`), ties at the cut kept |
| `coverage` | cohort | **all reporting**, **same agencies** (participation change removed), **complete periods** (required for rates). Unknown months are never 0, and a filtered zero needs evidence: both fixed, not options |
| `defaults` | every default applied | provenance shows the resolved interpretation |
| `bindings` | every part of the question → the plan path that applies it | request accounting: nothing is dropped (A1) |

Not in the plan, on purpose: SQL, table names, accelerator choice (the compiler picks an accelerator only when it
covers the plan, with an exact fallback), presentation wording.

## Validation

**Structural (no semantic layer):**

| Rule | Refuses |
|---|---|
| P1 | wrong plan version; no pinned semantic version |
| P2 | no measure; duplicate measure names |
| P3 | no place; the nation twice; "combined" over one place or with the nation |
| P4 | malformed months; a period ending before it starts; relative anchors with the wrong arguments |
| P5 | a dimension grouped twice; empty bins |
| P6 | a statistic naming an unknown measure; a share partitioned on a non-grouping; a share partitioned on every grouping (always 100%) |
| P7 | `in`/`between` without values |
| P8 | an existence filter with no condition |
| P9 | an incident-scoped property filter that does not declare property is not attributed to an offense |
| P10 | a rate over the all-reporting cohort (rates need complete agency-periods, D6/D8) |
| P11 | a rolling window without a month grouping, or shorter than two months |
| P12 | top-N with n < 1, an unknown measure, a `per` that is not a grouping, or nothing left to rank |
| P13 | a period comparison whose periods overlap or run backwards, or with no output |
| P14 | any attempt to count unknown months as zero or accept filtered zeros without evidence |

**Against the semantic layer:**

| Rule | Refuses |
|---|---|
| S1 | a plan read against another semantic version |
| S2 | an unknown measure; a counting unit that differs from the measure's (murders by offense are not murder victims) |
| S3 | an unknown dimension |
| S4 | a dimension or entity not related to the measure's entity |
| S5 | an attribute filter on a 1:n relation: an existence filter is required |
| S6 | a grouping on a 1:n relation without `multiValue: "each_value"` |
| S7 | a measure or dimension outside the eras it is valid for |

**Request accounting:** A1 refuses a plan that leaves any meaningful part of the question unbound.

## From today's typed specs (lib/nibrs-question-types.ts) to plans

Every N1-N7 spec maps onto a plan without loss. The limits in the right-hand column are today's, and the plan drops
them.

| Today | Plan | Today's limit the plan removes |
|---|---|---|
| `SeriesSpec` (N1 one place, N2 named places, N5 clearance rate): `measures, unit, statistic, filters, places, period, grain` | `measures` (one per measure, unit explicit), `filters`, `geography.places` (separate), `period`, grouping `time.year` or `time.month`; `statistic: rate` → `rate` with the complete-periods cohort; `clearance_rate` → `ratio` of `offenses_cleared` over `offenses`; `rolling` grain → `rolling` transform; `combine` → `geography.combine` or no time grouping | filters only "the chosen table holds together"; at most 10 places; rates declined monthly (a monthly rate becomes valid over evidenced-complete months) |
| `BreakdownSpec` (N3): `measure, unit, filters, dim, place, period, byYear` | one measure, `groupings: [dim]` (+ `time.year` when `byYear`), statistics count and `share` with `partition: []` (or `["time.year"]` with `byYear`) | one breakdown per answer; no monthly breakdowns; the dimension must be in a yearly table |
| `ShareSpec`: `population, subset, denominator: units or clearances, byState` | `measures` = the population measure (filters = `population`); `statistics: ratio` of the subset measure (population filters + `subset` filters) over the population measure; `denominator: clearances` → the population measure is clearances; `byState` → grouping `geo.state` with `partition: ["geo.state"]` | one period as a whole; no time grouping; clearance shares only on clearance-table fields |
| `RankSpec` (N6): `entity, measure, statistic, scope, period, rank, min` | `geography` = an `agency_set` (with `min` as `agency.population` predicate) or states within the nation; grouping `geo.state` or `geo.agency`; `top_n` with `per: []`; statistic count, rate or ratio | full years only; a fixed unit per offense; no filters; no ranking within each month |
| `ChangeSpec` (N7): `measure, unit, statistic, place, earlier, later` | `period` spanning both years; `period_comparison` transform with outputs earlier, later, change, pct_change; `coverage.cohort` all reporting or same agencies | one place, one measure, no filters; no same-agencies cohort |
| `NibrsTypeDecision` `decline` / `clarify` | `ReaderOutcome` `limitation` (with a reason) / `clarify` (each option a complete plan) | a decline because no table holds the combination disappears: only `not_recorded_in_nibrs`, `outside_release_coverage`, `unsupported_capability` (not yet switched for an era), `unresolved_place` and `explanation_requested` remain |

Request accounting is kept: the ledger's parts (`measure`, `unit`, `place`, `period`, `grain`, `rolling`,
`combine`, `breakdown`, `share`, `clearance`, `statistic`, `rank`, `threshold`, `entity`, `list`, `change`,
`filter`, `clearance-reason`) each bind to a plan path. The `peer`, `cohort`, `coverage-lookup` and `completeness`
concepts that today decline bind to `coverage` and `geography.places`.

## The correctness cases as plans

`lib/nibrs-plan/examples.ts`: N1, N2, N3, H1-H3, Z, D (three partitions), R, plus a multi-measure plan, top-N
per month over cities of 250,000 or more, a rolling 12-month national series, a same-agencies change and a 1:n
weapon grouping. The test checks that all are valid, and that each rule above refuses the plan it exists to refuse.

## What the semantic layer must give NIBRSAI

`lib/nibrs-plan/semantic.ts`, to be agreed with the "NIBRS model" session, which owns the shared layer:
- per measure: the counted entity, the counting unit, its definition, whether it adds across agencies and months,
  and the data years it is valid for;
- per dimension: the entity it belongs to, its codes and labels (original NIBRS codes kept), its unknown codes,
  whether it is numeric, and its valid years;
- the cardinality between any two related entities (one or many), from the canonical link tables;
- a version string, carried into every plan, answer and cache key.

## Not decided here

- How the compiler resolves `relative` periods and `agency_set` predicates against a release: compiler spec (phase 3).
- How unknown and evidenced-zero cells are worded in the answer: presentation, under the owner's no-editorializing rule.
- Clarification thresholds ("does this ambiguity change the answer"): reader spec.
