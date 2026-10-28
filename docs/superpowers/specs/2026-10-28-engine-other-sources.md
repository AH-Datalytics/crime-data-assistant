# The engine beyond NIBRS: SHR, Current Trends, Hate Crime and Historical (design note, r2)

**Asked by the coordinator, owner's go-ahead (2026-10-28):** a short note on how the other four sources would plug into
the new engine, so that choices made for NIBRS in the plan language (`lib/nibrs-plan/plan.ts`), the semantic layer
interface (`semantic.ts`) and the result contract (`result.ts`, `lib/answer-columns.ts`) do not box them out. **Plan
only.** Nothing here is built. SHR is already agreed as the next source.

Facts about today's code are cited from `origin/dev` at c1f5381. Facts about the plan language include step 1 (this
branch, PR #62).

**r1 → r2 (Codex REVISE, 6 items):**
- the "fits as is" claims now name their gaps: medians, thresholds, rolling rates, single-agency staffing rates;
- source coverage evidence is kept apart from result-cell statuses, and SHR's zero rule is scoped;
- the staffing contract is restated as it is implemented;
- RTCI's sample facts are corrected, and its two cohort operations kept apart;
- the time rules are completed;
- published geography values and populations are placed, and NIBRS behaviour is preserved explicitly.

## 1. What carries over, and what is NIBRS-shaped

Carries over to every source:
- a typed plan bound to the parts of a question (request accounting);
- a versioned semantic layer of entities, measures, dimensions and links;
- a compiler that invents no semantics;
- release resolution;
- the result contract: groupings and numbers only, with each cell's status as server-side evidence.

The result contract's cell statuses are VALUE, REPORTED_ZERO, UNKNOWN, NOT_REPORTED, UNKNOWN_UNEVIDENCED_ZERO and
UNAVAILABLE with a reason (`result.ts`). Each source supplies its own **reporting evidence**, which the compiler maps
into these statuses. The evidence is scoped to the measure, geography and period it actually covers.

NIBRS-shaped choices to generalise. **Every one leaves NIBRS's behaviour unchanged**: its eras, rate eligibility (the
matched eligible-agency numerator over covered population), cohorts, statuses and answer statements.

| # | Today | Generalisation |
|---|---|---|
| G1 | `version: "nibrs-plan/1"`; one implicit source | the plan names its `source` and that source's semantic version. A plan never spans two sources: a cross-source comparison is a limitation, never a join |
| G2 | `Period.years` has `min(1991)` in the schema | eras come from the layer (`validYears`) and the release, as R1 checks. SHR starts in 1976 and Historical in 1930. NIBRS keeps 1991 through its layer |
| G3 | `TimeBasis` = incident, arrest or clearance date | the layer declares the time bases. Adds `data_year` (annual records) and `report_month` (RTCI's counted month) |
| G4 | `CountingUnit` is a closed list of NIBRS entities | the units come from the layer, with the plan still repeating the unit (S2). New units: an aggregate `reported_count`, a sum of `reported_victims` (Hate Crime), and the staffing unit described under Historical |
| G5 | the time grain is implicitly monthly | a measure declares its grain (`month` or `year`). A new rule, R6, refuses a plan over an annual measure in three cases: it groups by month; its period does not cover whole years; or any **comparison endpoint** does not cover whole years. NIBRS measures are `month`, so nothing changes for them |
| G6 | answers hold groupings and numbers only (`checkEnvelope`) | one exception, limited to Historical staffing answers with the officer fallback: the **label column** `reported` (`answer-columns.ts:13-14`). It is nullable, has a closed set of values, and is never a chart series. It is not a general permission for measures to add text |
| G7 | state and national values are sums over agencies; R3 unions agencies; R4 needs agency members | a measure declares, per geography level, whether it is an `agency_sum` or a `published_value` (Historical's FBI estimates, stored rates, national clearance percentages). A published value resolves directly from its own table, outside `agencyColumn`, R3 and R4. A combination it cannot answer (a published value with the same-agencies cohort, a combined geography, or re-summing) is refused |
| G8 | `checkEnvelope` requires "These are reported NIBRS counts." for every national plan | answer statements become source-specific, and the NIBRS condition and wording stay exactly as they are |

## 2. Per source

### SHR (Homicide Reports): next

- **Grain and entities.** `incidents` has one row per homicide incident, with year, month, ORI, agency population,
  situation, weapon, circumstance and the **primary** offender's attributes. `victims` has one row per victim, joined
  by incident_id (`shr.ddl.sql`; `shr-claude.ts:54-68, 215`).
  - Entities: incident, victim, `primary_offender` (one-to-one with its incident).
  - Units: victim (the default, `shr-claude.ts:129`) and incident.
  - Offender counts are refused: SHR records one offender per incident.
- **Fits as is:**
  - counts, shares and rankings;
  - groupings by victim demographics, weapon, circumstance and relationship (the victim's relationship to the primary
    offender);
  - places as national, state or agency; months and years.
- **Needs extending (today's T1-T6 use them, `shr-question-types.ts:71-75`):**
  - a `median` and an `average` statistic over a numeric dimension (T4: victim age);
  - a threshold on an aggregate result ("places with at least N"; T2 and T5).

  It also needs G1 and G2, and a layer property refusing a rate grouped by a person dimension (`shr-claude.ts:157`).
- **Reporting evidence, scoped.** "No SHR records is UNKNOWN, never zero" (`shr-count-plan.ts:15`) is the rule. Record
  presence elsewhere is not evidence of completeness, and **a Return A murder zero is not evidence about all
  homicides** (`:15-18`).

  The Return A comparison (`shr_return_a_comparison`; `shr-annual-coverage.ts`) is annual and agency-level evidence for
  murder only. Its statuses map as follows:
  - validated_zero → REPORTED_ZERO, for an annual murder count of that agency only;
  - gap → UNKNOWN (a discrepancy, not a confirmed non-submission);
  - coverage_unknown → UNKNOWN.

  It says nothing about months. The accepted city-murder path keeps its own Return A policy
  (`shr-deterministic-murder.ts`).
- **Build.** A **lighter compiler over shr.db.** It is already rebuilt in full from the FBI master files every month
  (`scripts/ops/shr-auto-update.js`), at incident and victim grain, with identity tables.
- **Population and periods.**
  - Agency population: `AVG(i.population)` per agency-year (`shr-claude.ts:155-156`).
  - State and national population: `state_population`, which uses the CDE estimate in recent years (`:158`).
  - Annual answers stop at the cutoff year minus one unless a current year is named (`:128`). That is a source rule
    of its own: it is not `latest_calendar_year_in_release`, which differs when a release ends in December.

### Historical (UCR summary) and staffing

- **Grain and entities.** Annual values per agency (ORI, year): crime, clearances, population and staffing
  (`all_total`, `officer_total`, `civilian_total`). It has no incidents or persons.

  `historical_state_national` holds FBI-estimated state and national counts and **stored rates**. There are also
  **published national clearance percentages** (`historical-question-compiler.ts:9-16`). Those are G7
  `published_value`s, never sums.
- **Fits as is:**
  - counts by place and year;
  - agency rates over the year's population;
  - rankings of agencies;
  - comparisons between whole years (R6 checks the endpoints).
- **Needs:**
  - G3, G5, G7 and G8.
  - Staffing, G4 and G6, as implemented (c1f5381; `claude.ts:841-846, 878-888`;
    `historical-question-compiler.ts:343-359, 580-607`):
    - **The figure.** `officers_or_employees@1` is blank if `all_total` is missing or not positive
      (`historical-question-compiler.ts:195`). Otherwise it is `officer_total` when positive, falling back to
      `all_total`.
    - **The unit.** Its unit is `staff_reported`: one measure whose cell says which count it is through `reported`
      ("Officers" or "Employees"). It never claims that an employee figure counts officers. The measure's name in
      answers names both counts when employees appear.
    - **Never substituted:** civilians and employees.
    - **Totals.** A total over officer years and employee years is not computed: the individual years are returned.
    - **Comparisons.** A comparison between unlike years keeps both endpoint values. The change is blank (UNAVAILABLE,
      reason `not_comparable`), and `reported` is null on that row.
    - **Rates.** A rate is the shown figure over that year's population. A **single agency's rate is allowed**, so the
      measure is declared additive across agencies = false, which refuses only state and national sums. The S12-style
      check must refuse sums, not single-place rates.
    - **Rankings** choose the figure before rates and sorting.
  - Reporting evidence: months reported (`historical_core.py:893-896`). Zero months is missing; an all-zero year is
    NULL, so it maps to UNKNOWN. Absence is never 0.
- **Build.** A **lighter compiler over the existing tables.** They are loaded from the FBI's published annual files.
- **Conflicts.**
  - State keys: lowercase codes in `historical_agency`, full names including "United States" in
    `historical_state_national`. The layer normalises both to the plan's `state` and `national`.
  - National rape from 2017 is CIUS Table 1 (`historical_core.py:1348-1352`): a declared measure definition.

### Current Trends (RTCI)

- **Grain and entities.** Monthly reported counts per agency and offense (`agency_monthly`), from the RTCI sample's
  CSVs (`update-rtci-db.py`).
  - `sample_agencies` is a cohort, not an import allowlist (`:119`).
  - `national_monthly` sums the sample. `state_monthly` sums **all agencies** (`:451-484`).
  - The typed compiler computes national and state from `agency_monthly` restricted to the sample, never from
    `national_monthly` or `state_monthly`.
- **Fits as is:** counts by month or year, agency rates, rolling counts, comparisons of periods.
- **Needs:**
  - **Two separate cohort notions.**
    - *Sample membership*: which agencies may contribute (the sample, for national and state).
    - *Reporting eligibility*: today's ordinary multi-month total needs the **identical set of contributors** every
      month. When the set changes, the compiler shows the months and leaves a rolling total blank
      (`current-question-compiler.ts:579-613`). Taking the intersection of reporting agencies would produce a number
      instead, so it is a different rule.

    The plan therefore carries membership (`members: all | source_sample`) separately from the existing `cohort`
    (`all_reporting | same_agencies`). The compiler applies the identical-contributors rule to ordinary totals as
    evidence (UNAVAILABLE, reason `contributors_changed`). The same-agencies cohort, constrained by P10, stays the
    fixed-cohort comparison.
  - **Rolling rates.** P11 refuses a rate inside a rolling window. RTCI supports one, using months-weighted
    population (`current-question-compiler.ts:13-15`), so P11 must allow it for a measure whose layer declares that
    rule. NIBRS keeps P11.
  - **Year to date.** A period form, `year_to_date`, and a comparison, `same_period_previous_year`.
    - The latest month is the place's and offense's own latest month (`claude.ts:200`), so resolution resolves YTD per
      place and offense.
    - Resolved provenance must record a period and comparison pair **keyed by place**; `result.ts` stores one period
      today.
    - The previous year's operand lies outside January-to-latest, so the selected period is the union of both
      operands, and R2 checks each pair inside it.
  - **Rates.** A month's rate is not annualised; a year or YTD rate uses that year's population (`:13-15`). These are
    rules of the `rate` statistic declared per measure.
- **Build.** A **lighter compiler over the existing tables** (aggregate counts; no microdata).
- **Conflicts.**
  - RTCI's "murder" and "violent crime" follow the SRS hierarchy. Measure ids are qualified by source (`rtci.*`), and a
    reader never maps a word to another source's measure.
  - The model prompt's national rule (`national_monthly`, `claude.ts:148-149`) and the compiler's differ. The layer
    adopts the compiler's.
  - State rates and rankings are sent to Historical (`claude.ts:103`), and that stays a limitation.

### Hate Crime

- **Grain and entities.** A separate FBI hate crime database for 1991-2025:
  - `hate_crime_incidents` has one row per incident and offense, with bias, location and a per-offense victim count;
  - `hate_crime_participation` has total and reporting agencies per state and year.

  Units: incident (the default), offense, and `reported_victims`, a sum of `offense_victims` (`hc-claude.ts:23-29`),
  not distinct persons.
- **Fits as is:** counts and shares by bias, offense, location, state and year.
- **Needs:**
  - places resolved to ORIs (today agencies are found by name, `hc-claude.ts:~165`);
  - reporting evidence. `reporting_agencies` counts agencies with an incident (`import-hate-crime.py:461-468`), so
    there is no zero evidence, and every zero stays UNKNOWN_UNEVIDENCED_ZERO until zero reports are decoded;
  - an owner decision. NIBRS's `offenses.hate_crime@1` and this file count different things (this file also covers SRS
    agencies). They stay separate measures, and which one answers an unqualified "hate crimes" is the owner's choice.
- **Build.** A **lighter compiler over `hate_crime_incidents`**. Today the tab is model SQL apart from its capability
  exits (`app/api/hc-query/route.ts:348-420`).

## 3. Shared definitions

| Concept | Shared | Per source |
|---|---|---|
| Place | ORI identity; kinds national, state, agency, county, agency_set; labels from one authority; county via `agency_county_crosswalk` | SHR `shr_agency_identity` and year class; Historical state keys normalised; Hate Crime name lookup replaced by ORI resolution; published values bypass agency membership (G7) |
| Period | months and years; whole years for annual measures and their comparison endpoints (R6). Clipping a year in progress (`clippedTo`) is proposed in step 1, PR #62, for NIBRS. Each source adopts it explicitly, never by default | RTCI `year_to_date`, keyed by place and offense; SHR annual cutoff rule |
| Population | each source keeps its existing denominator and published-value policy, recorded in evidence; nothing is merged | NIBRS: covered population of the eligible agencies; RTCI: agency_population, months-weighted for rolling; SHR: averaged incident population, and `state_population` with CDE estimates; Historical: its population table and stored rates |
| Reporting evidence | per source, scoped to measure, geography and period, mapped into the six cell statuses; unknown is blank, never 0 | SHR: annual Return A (murder, agency); Historical: months reported; RTCI: monthly contributors; Hate Crime: none for zeros |
| Answer contract | groupings and numbers; fixed answer statements per source (G8); evidence server-side | the `reported` label column, Historical staffing only (G6) |

## 4. Suggested order

1. **SHR** (agreed). Microdata already exists, its coverage rule is D6's, and it has closed types today. Needs: G1,
   G2, median and average, thresholds, the person-rate rule.
2. **Historical and staffing.** An existing closed compiler. It brings annual grain (G3, G5), published values (G7)
   and the one label column (G6).
3. **Current Trends.** The most new plan language: membership beside cohort, the contributors rule, rolling rates and
   `year_to_date` keyed by place.
4. **Hate Crime.** No closed compiler, no zero evidence, and an owner decision.

Each source follows NIBRS's sequence: correctness set, semantic layer, compiler, shadow against today's answers, then
release through `scripts/release.sh` after shadow acceptance.

## 5. What to do now, while NIBRS is being built

Only what keeps the NIBRS compiler from hard-coding what other sources change:
- G1: a `source` field in the plan, fixed at `"nibrs"`;
- G2: era bounds from the layer;
- G5: a grain field on measures (`month` for every NIBRS measure);
- G8: answer statements keyed by source.

None of these changes a NIBRS answer. The rest is done with the source that needs it.
