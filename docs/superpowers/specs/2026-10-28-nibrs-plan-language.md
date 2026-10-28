# NIBRS structured plan language, v1 (r4)

Phase 3 contract of `2026-10-27-nibrs-engine-restructure.md` (design point 3).

| File | What |
|---|---|
| `lib/nibrs-plan/plan.ts` | the plan as zod schemas (the runtime boundary for reader JSON) with inferred types; `parsePlan`, `ReaderOutcome` |
| `lib/nibrs-plan/validate.ts` | structural (P), semantic (S) and request-accounting (A) validation |
| `lib/nibrs-plan/resolve.ts` | release resolution of relative periods and agency sets, and the R rules |
| `lib/nibrs-plan/semantic.ts` | what NIBRSAI needs from the shared semantic layer, compiler-facing |
| `lib/nibrs-plan/result.ts` | the result envelope and provenance the compiler fills |
| `lib/nibrs-plan/examples.ts` | 35 plans and 6 reader outcomes: every correctness case and every typed form today |
| `scripts/test-nibrs-plan-language.ts` | every example valid; every rule refuses its case |

**r3 → r4 (Codex REVISE, 3 changes):** accounting requires a condition that means the part exactly (a named family
maps to its exact codes), the rate multiplier, and the place's identity from the app's geography resolver (never the
plan's label); the one-data-year rule applies per rate statistic, and relative periods are decided after resolution
(R5); a statistic compared twice is refused.

**r2 → r3 (Codex REVISE, 7 changes):** request accounting by explicit per-concept value rules (a concept with no
rule cannot be bound); one attribute validator for every condition, rerun on resolved years; noncontiguous years
checked as selected; strict schemas (unknown fields refused); `link()` lookup and a layer self-check; rank after a
comparison names its output, rolling and comparison not combined, rates one data year per cell; S4, paired
relationship and property-value examples corrected.

**r1 → r2 (Codex REVISE, 10 changes):** a compiler-facing semantic interface; existence filters validated along
their whole path; shares with an explicit, independently evaluated denominator; rate eligibility fixed to evidenced
completeness and separated from cohort membership; named statistics as transform targets; release-resolved period
checks and an exact H1 default; combined places as a deduplicated union; a zod runtime boundary with bin rules;
request accounting checked by path and value; examples for every case and form, and a provenance envelope.

## How a question becomes an answer

1. The reader (model plus request ledger) returns a `ReaderOutcome`: a **plan**, a **clarification** (asked only when
   the readings give different answers; every option is a complete plan), or a **limitation** (a concept NIBRS
   does not record, data outside the release, a capability not yet switched on for an era, an unresolved place, or
   a request for causes). It never writes SQL.
2. `parsePlan` checks the JSON against the schema (P0). Malformed input is refused, never thrown.
3. `validatePlanShape` (P1-P13), `validatePlanSemantics` against a pinned semantic version (S1-S12), and
   `validateBindings` against the request ledger (A1-A4).
4. `validateResolved` resolves relative periods and agency sets against the pinned release (R1-R4).
5. The compiler turns the plan into DuckDB SQL deterministically, runs it on a worker pinned to the release, and
   returns a `ResultEnvelope` with provenance. Any problem at any step stops before compilation.

## The plan

| Field | Says | Notes |
|---|---|---|
| `geography` | places; `separate` (a row per place; two or more need the `geo.place` grouping) or `combined` (one total over the deduplicated union of the places' agencies) | nation (a sum of reported counts, never an agency), state, agency by ORI, county, `agency_set` by population, type or population group |
| `period` | `absolute` months, `years` (noncontiguous whole years), `since`, `last_n` years or months, `latest_calendar_year_in_release` (H1's rule), `latest_month_in_release` | relative forms resolve against the release (R) |
| `timeBasis` | incident, arrest or clearance date | each measure declares the bases it has (S2) |
| `measures` | id, counting unit, name, optional own filters | units: victim, victim-offense pair, victim-offender pair, offense, incident, offender, arrestee, arrest, Group B arrest, property segment, dollars, vehicles |
| `filters` | attribute filters; **scoped existence filters** | `exists` over `entity` from `scope` (the unit itself or an entity it belongs to); every condition belongs to `entity`; property needs `attribution: "incident_level_only"` |
| `groupings` | any number | `bins` for numerically decoded dimensions, special codes kept apart; `multiValue: "each_value"` for one-to-many dimensions; unknown always visible |
| `statistics` | `count`, `share`, `rate`, `ratio`, each named | see below |
| `transforms` | `rolling`, `period_comparison`, `rank`, in that order, each naming its statistics | counts are summed; shares, rates and ratios are always recomputed from transformed parts |
| `coverage` | `all_reporting` or `same_agencies`; unknown months shown; filtered zeros need evidence | the last two are fixed |
| `defaults`, `bindings` | every default applied; every part of the question with the path that applies it | provenance and request accounting |

### Statistics

- **share** of `measure` in each cell over a denominator evaluated independently at the grain of `within` (a subset
  of the groupings; `[]` is the whole result, still within each place when places are separate and `geo.place` is
  in `within`). The denominator is `denominator` if named (same unit, S12), else `measure` with its own filters,
  evaluated with that measure's own aggregation over deduplicated rows: a count-distinct measure counts each unit
  once (a victim in two weapon cells counts once), a sum measure (dollars, vehicles) sums each row once. Never a sum
  of the cells shown.
- **rate** per `per` of covered population. Eligibility is fixed: for each output cell an agency enters only if every
  month of that cell's period is evidenced complete (REPORTED_ZERO, or a submission evidenced complete), and
  numerator and population use the same agencies. An unavailable rate is a blank number; the observed count, the
  eligible count, the covered population and the reason (no eligible agency; covered population cannot be
  established, D8) are server-side evidence, never columns. The population is the covered population of the cell's data year, so each cell's period lies
  in one data year (P14); a rate is not rolled (P11) and a compared rate uses one-year periods (P13). Periods are never annualized; partial periods are labelled. A filtered numerator over all
  residents is labelled "per N residents (all residents)".
- **ratio** of two measures evaluated independently at the full grain (clearance rate, a subset share such as
  "rapes cleared because prosecution was declined over rapes", average property value). A zero or unknown
  denominator gives a null cell with a reason.

### Transforms

- **rolling** over `time.month`; a window is reported only when every month in it is known.
- **period_comparison** of two absolute periods inside the plan's period, earlier ending before later starts.
- **rank** by a named statistic (after a comparison, one of its outputs: `count.change`, `count.pct_change` ...) within each combination of `per`; `limit` keeps the first n (ties at the cut kept) or,
  when null, orders every row (today's ranking without a number).

## Validation

| Rule | Refuses |
|---|---|
| P0 | reader JSON that does not match the strict schema: unknown fields (refused, never stripped), missing fields, wrong discriminants, non-integer or negative counts and limits, malformed months, mismatched agency predicates |
| P1 | another plan version |
| P2 | one name used twice across measures and statistics |
| P3 | a place listed twice; `combined` over one place or with the nation; two or more separate places without `geo.place`, or `geo.place` without them |
| P4 | an absolute period ending before it starts; years not distinct and ascending |
| P5 | a dimension grouped twice; bins reversed, overlapping or with repeated labels |
| P6 | a statistic naming an unknown measure; a share `within` a non-grouping or naming one twice (a share within every grouping, 100% by request, is allowed) |
| P7 | `in`/`not_in` without values, `between` without two, `is_known`/`is_unknown` with values |
| P9 | an existence filter over property without `attribution: "incident_level_only"` |
| P10 | a same-agencies cohort with nothing to compare (no comparison and no time grouping) |
| P11 | transforms out of order or naming unknown statistics; a rolling window without `time.month`, combined with a comparison, or over a rate |
| P12 | a rank by an unknown statistic, by a compared statistic without naming the output (or naming an output that does not exist), `per` a non-grouping, with nothing left to rank, or two ranks |
| P13 | comparison periods reversed, overlapping, or outside an absolute plan period; a compared rate with a period spanning two data years; a statistic compared twice (its outputs would collide) |
| P14 | a rate, not evaluated through a comparison, over an absolute or year-list period spanning several data years without a time.year or time.month grouping |
| S1 | a plan read against another semantic version |
| S2 | an unknown measure; a unit different from the measure's; a time basis the measure lacks |
| S3 | an unknown dimension |
| S4 | a dimension, scope or existence target not related to the counted entity; a condition that does not belong to its target |
| S5 | an attribute filter on a one-to-many relation (an existence filter is required) |
| S6 | a one-to-many grouping without `multiValue`, or `multiValue` on a one-to-one grouping |
| S7 | a measure, dimension or code outside its era |
| S8 | an existence scope with many rows per counted unit; dimensions reached through two different one-to-many links (a cross product) |
| S9 | property reached other than from an incident scope |
| S10 | bins on a dimension the layer does not decode as a number |
| S11 | a code that is not one of the dimension's codes |
| S12 | a share whose denominator counts another unit; a rate on a measure that does not add across agencies |
| A1 | a part of the question (clause 0 or inherited from an earlier turn) left unbound |
| A2 | a binding to a path the plan does not have |
| A3 | a concept no plan can apply (it must be a limitation instead), or a binding to a path of the wrong kind |
| A4 | a binding whose plan value does not carry the part's value, by an explicit rule per concept: another measure or unit, another state or agency, a clipped or different period, a negated or different filter value, another grain, breakdown, statistic, rank or threshold; a broader filter than the part (exact equivalence; named families map to exact code sets); a rate not per 100,000; an agency whose ORI the app's geography resolver does not give for the part (the plan's label never decides) |
| R1 | a resolved period outside the release, or outside a measure's, dimension's or code's era (every condition rechecked on the resolved years) |
| R2 | comparison periods outside the selected period (for noncontiguous years, outside the selected years), or out of order |
| R3 | (not a refusal) a combined geography is counted as the deduplicated union of its agencies, recorded in provenance |
| R4 | a place that matches no agency in the release in the selected years |
| R5 | a rate with no time grouping and no comparison whose resolved period spans several data years |

## Result columns (owner, 2026-10-28)

"We should never need status and notes"; "the tables and exports should only give the appropriate columns."
- A user-facing table, and every export of it, has the plan's groupings (place, period, category) and the plan's
  numbers as its columns, nothing else: no status, note, caveat, label or flag column.
- An unknown number is blank (null): never zero, never a label. A D6 unknown month, an unevidenced zero and an
  unavailable rate are all blank numbers. A category value is data, including an "Unknown" category and substantive
  categories such as a clearance type.
- Enforced by purpose, not by words (`checkEnvelope` in `lib/nibrs-plan/result.ts`):
  - every column is bound to exactly one grouping or one number output of the plan, and each of them has exactly one
    column. The number outputs are the statistics after transforms: a compared statistic becomes one output per
    requested comparison output (`victims.earlier`, `victims.later`, `victims.change`, `victims.pct_change`;
    `finalStatistics`);
  - each header is the compiler's template for its binding (the semantic layer's dimension label; the statistic's
    description from its measure, unit, period and, for a rate, the population wording such as "per 100,000
    residents (all residents)"), so no header carries an annotation;
  - each number cell has exactly one server-side evidence record whose status agrees with it: blank exactly when the
    status is UNKNOWN, NOT_REPORTED, UNKNOWN_UNEVIDENCED_ZERO or UNAVAILABLE; REPORTED_ZERO only with 0;
  - answer text is limited to two statements with fixed wording, each exactly where it applies: property not
    attributed to one offense (an incident-scoped property filter) and "reported NIBRS counts" (a national answer).
- Status, reasons, a share's parts, a rate's cohort figures and coverage stay server-side (`ResultEnvelope.evidence`
  and the provenance below). They are never columns, never answer text and never exported to users.
- The current app is being given the same contract (plan `docs/superpowers/specs/2026-10-28-answer-columns-and-chart-
  labels.md`, branch `fix/answer-columns-only-data`; implementation pending). Its guard tests will cover the engine's
  tables once it produces them.

## Provenance (`ResultEnvelope`, filled by the compiler)

- the plan and its digest; plan-language, semantic, canonical release (and manifest checksum), serving artifact and
  compiler versions;
- the resolved interpretation: the absolute period, comparison periods, places with their agency counts, the
  deduplication of a combined geography, every default, and "reported NIBRS counts" for national answers;
- the compiled SQL, its hash and any accelerator used;
- each statistic's denominator rule and cohort, with agency counts;
- transformations, and any truncation (rank limits, withheld cells) with counts;
- answer statements: only the two above, with fixed wording;
- server-side evidence for every number cell: its status (VALUE, REPORTED_ZERO, UNKNOWN, NOT_REPORTED,
  UNKNOWN_UNEVIDENCED_ZERO or UNAVAILABLE), the reason a number is blank, a share's parts, a rate's cohort figures;
- the cache key, built from every version above.

## What the semantic layer must give NIBRSAI (`semantic.ts`)

To be agreed with the "NIBRS model" session, which owns the shared layer. The compiler must not invent semantics:
- **entities:** canonical table, identity key, the parent they belong to one-to-one, their date columns by time
  basis, their agency column;
- **measures:** counted entity, unit, aggregation (count distinct keys, or sum a column over distinct rows), a typed
  predicate (dimension conditions, existence over links, all/any), additivity across agencies, months and categories,
  time bases, valid years;
- **dimensions:** entity, column, codes and labels, unknown codes, numeric decoding with special codes (age 00, NN,
  NB, BB), per-code era validity, valid years;
- **links:** endpoints, cardinality, join keys, and for pair entities (victim-offender) the far-end dimensions read
  through the pair row, so relationship × offender age never becomes a cross product;
- `link(id)` to resolve the links named in predicates, and `measures()` so `checkLayer` can verify every predicate
  when a version is loaded;
- a version string carried into every plan, answer and cache key.

The compiler counts distinct entity keys, so reaching a dimension can never multiply a count.

## From today's typed specs (lib/nibrs-question-types.ts)

| Today | Plan | Example |
|---|---|---|
| `SeriesSpec`, one place, one or more measures | `measures` (unit explicit), `filters`, a time grouping per `grain` | `N3`, `MULTI_MEASURE` |
| `SeriesSpec`, named places | `geography.places`, separate, with `geo.place` | `NAMED_PLACES` |
| `SeriesSpec` period forms | `year`/`range`/`month`/`monthrange` → `absolute`; `years` (noncontiguous) → `years`; `since` → `since`; `last` → `last_n`; `lastyear`/`latest` → `latest_calendar_year_in_release`/`latest_month_in_release`, declared in `defaults` | `SEPARATE_YEARS`, `H1` |
| `SeriesSpec` grain `rolling`, `combine` | `rolling` transform; `combine` → no time grouping over the period | `ROLLING` |
| `statistic: rate` | `rate` (fixed evidenced-complete eligibility) | `R`, `S4_AGENCIES`, `S4_STATE` |
| `statistic: total_value` / `average_value` | `count` of a dollars measure / `ratio` of dollars over property segments | `PROPERTY_VALUE` |
| `statistic: clearance_rate` (N5 series) | `ratio` of a cleared-offense measure over offenses (both unit offense) | `CLEARANCE_RATE` |
| `BreakdownSpec` (N3, N5 breakdowns) | `groupings: [dim]` (+ `time.year` when `byYear`), `count` and a `share` within `[]` or `["time.year"]`; age with bins | `AGE_BREAKDOWN`, `CLEARANCE_BREAKDOWN` |
| `ShareSpec`, denominator units | `ratio`: the subset measure (population filters plus subset filters) over the population measure | `SUBSET_SHARE` |
| `ShareSpec`, denominator clearances | `ratio` over the cleared measure | `CLEARANCE_SHARE` |
| `ShareSpec`, `byState` | the same ratio with a `geo.state` grouping | (form of `CLEARANCE_SHARE`) |
| `RankSpec` (N6) | `geo.state` or `geo.agency` grouping (agencies via `agency_set` with the population minimum); `rank` by the named statistic, `limit` n or null | `RANKED_RATES`, `TOP_N_PER_MONTH` |
| `ChangeSpec` (N7) | a period spanning both years; `period_comparison`; cohort all reporting or same agencies | `SAME_AGENCIES_CHANGE`, `S3` |
| `decline` / `clarify` | `limitation` with a reason / `clarify` with complete plans | `G1`-`G6` |

Today's limits that the plan drops: filters only where a summary table holds them, one breakdown per answer, no
monthly breakdowns, shares over one period only, at most ten places, rankings by full years and fixed units only,
change for one place and measure only, and declines because no table holds a combination. Group B arrests
(`GROUP_B_ARRESTS`, arrest date), victim-offender pairs (`PAIRED_RELATIONSHIP` counting victims, `PAIR_COUNT` counting pairs), one-to-many groupings
(`MULTI_VALUE_GROUPING`) and combined places (`COMBINED_PLACES`) are new.

## Not decided here

- The compiler itself (SQL generation, accelerators, workers): phase 3 implementation.
- The clarification threshold ("does this ambiguity change the answer"): the reader spec.
- The shared semantic layer's own YAML schema: owned by the "NIBRS model" session; `semantic.ts` is the adapter target.
