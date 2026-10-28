# The engine beyond NIBRS: SHR, Current Trends, Hate Crime and Historical (design note)

**Asked by the coordinator, owner's go-ahead (2026-10-28):** a short note on how the other four sources would plug into
the new engine, so that choices made for NIBRS in the plan language (`lib/nibrs-plan/plan.ts`), the semantic layer
interface (`semantic.ts`) and the result contract (`result.ts`, `lib/answer-columns.ts`) do not box them out. **Plan
only.** Nothing here is built. SHR is already agreed as the next source.

Facts about today's code are cited from `origin/dev` at c1f5381.

## 1. What is already source-neutral, and what is NIBRS-shaped

Most of the design carries over unchanged. Each of the following holds for any source:
- a typed plan bound to the parts of a question (request accounting);
- a versioned semantic layer of entities, measures, dimensions and links;
- a compiler that invents no semantics;
- release resolution;
- the four cell statuses: REPORTED_CRIMES, REPORTED_ZERO, NOT_REPORTED, UNKNOWN;
- answers that hold groupings and numbers only.

Seven choices are NIBRS-shaped today. Each is cheap to generalise now and expensive later:

| # | Today | Generalisation |
|---|---|---|
| G1 | `version: "nibrs-plan/1"`; one implicit source | the plan names its `source` and that source's semantic version. A plan never spans two sources (v1): a cross-source comparison is a limitation, never a join |
| G2 | `Period.years` has `min(1991)` in the schema | eras come from the layer (`validYears`) and the release, as R1 already checks. SHR starts in 1976 and Historical in 1930 |
| G3 | `TimeBasis` = incident, arrest or clearance date | the layer declares the time bases. Adds `data_year` (annual records: Historical, staffing) and `report_month` (RTCI's counted month) |
| G4 | `CountingUnit` is a closed list of NIBRS entities | the units come from the layer, with the plan still repeating the unit (S2). New units: an aggregate `reported_count`, a published `estimate`, `officer` and `employee`, and `reported_victims` (a sum) |
| G5 | the time grain is implicitly monthly | a measure declares its grain (`month` or `year`). A plan that groups by month, or whose period does not cover whole years, over an annual measure is refused with a new rule (R6) |
| G6 | answers hold groupings and numbers only (`checkEnvelope`) | one exception, declared by a measure: a **label column** with a closed set of values, never a series. Today that is only staffing's `reported` (`answer-columns.ts:13-14`, `STAFFING_LABEL_COLUMN`) |
| G7 | state and national values are always sums over agencies | a measure declares, per geography level, whether it is an `agency_sum` or a `published_estimate` (Historical's FBI estimates). An estimate never takes the same-agencies cohort and is never re-summed |

## 2. Per source

### SHR (Homicide Reports): next

- **Grain and entities.** `incidents` has one row per homicide incident, with its year, month, ORI, agency population,
  situation, weapon, circumstance and the **primary** offender's age, sex and race. `victims` has one row per victim,
  joined by incident_id (`shr.ddl.sql`; `shr-claude.ts:54-68, 215`).
  - Entities: incident, victim, and `primary_offender` (one-to-one with its incident).
  - Units: victim (the default, `shr-claude.ts:129`) and incident.
  - Offender counts are refused: SHR records one offender per incident.
- **Fits as is:**
  - counts, shares and rankings;
  - groupings by victim demographics, weapon, circumstance and relationship (the victim's relationship to the primary
    offender);
  - places as national, state or agency; monthly and annual periods.

  Today's six SHR types T1-T6 (`shr-question-types.ts:11-12`) are all expressible.
- **Needs:**
  - G1 and G2 (data from 1976).
  - A rule the layer must carry: no rate grouped by a person dimension (`shr-claude.ts:157`). It is the same refusal as
    NIBRS's rate by race, stated as a layer property, not a prompt sentence.
  - Coverage. SHR has no submission evidence of its own. Its year statuses come from the comparison with Return A
    (`shr_return_a_comparison`; `shr-annual-coverage.ts:1-9`), and they map onto the four statuses:
    - count → REPORTED_CRIMES;
    - validated_zero → REPORTED_ZERO;
    - gap → NOT_REPORTED;
    - coverage_unknown → UNKNOWN.

    "No SHR records is unknown, never zero" (`shr-count-plan.ts:15`) is D6 exactly.
- **Build.** A **lighter compiler over shr.db.** shr.db is already rebuilt in full from the FBI master files every month
  (`scripts/ops/shr-auto-update.js`), at incident and victim grain, with identity tables (`shr_agency_identity`,
  `shr_agency_year_class`). A canonical rebuild adds little until the shadow finds a fault in the import.
- **Shared definitions and conflicts:**
  - Agency population is `AVG(i.population)` per agency-year (`shr-claude.ts:155-156`). State and national population
    come from `state_population`, using the CDE estimate in recent years (`:158`).
  - City or county membership comes from `shr_agency_year_class` (the only authority).
  - An annual answer stops at the cutoff year minus one (`shr-claude.ts:128`). The release's last complete year
    expresses that rule (`latest_calendar_year_in_release`).

### Historical (UCR summary) and staffing

- **Grain and entities.** Annual aggregates per agency (ORI, year):
  - crime (`historical_agency_crime`);
  - clearances;
  - population;
  - staffing (`all_total`, `officer_total`, `civilian_total`).

  There are FBI-estimated state and national figures in `historical_state_national`. There are no incidents and no
  persons. The entities are agency-year rows, and every measure is a sum.
- **Fits as is:**
  - counts by place and year;
  - rates over the year's population;
  - rankings of agencies;
  - period comparisons between whole years.

  Today's H1-H6 (`historical-question-types.ts:6-8`) are expressible.
- **Needs:**
  - G3 and G5: annual grain and `data_year`. A month in a Historical plan is refused (R6).
  - G7: state and national crime come from the estimates (`historical-question-compiler.ts:5-13`). Summing
    `historical_agency_crime` by state is refused today in guardrails (`guardrails.ts:1345`) and becomes a layer
    property.
  - Staffing becomes the label column (G6). `officers@1` is `officer_total` when greater than 0, else `all_total`, and
    `reported` carries "Officers" or "Employees" (c1f5381; `claude.ts:841-846`). Its layer entry declares:
    - not additive across agencies: "never summed by state or nationally" (`claude.ts:850`), so a state or national
      staffing plan is refused;
    - additive across years only within one label: a total over officer years and employee years is refused;
    - a change between unlike years is a blank cell. Its evidence status is a new reason, `not_comparable`, and the
      label reads "Officers to Employees";
    - rankings choose the figure before rates and sorting, which is the compiler's existing order.
  - Coverage. Months reported (`historical_core.py:893-896`: zero months is missing, an all-zero year is NULL) maps to
    the four statuses. "Absence is never 0" is already the compiler's rule.
- **Build.** A **lighter compiler over the existing tables.** The source is the FBI's published annual files, and
  `import_historical.py` already loads them at the finest grain they have.
- **Conflicts:**
  - State keys: `historical_agency.state` is a lowercase code, while `historical_state_national` uses full names
    including "United States". The layer normalises both to the plan's `state` code and `national`.
  - National rape uses CIUS figures from 2017 (`historical_core.py:1348-1352`): a declared measure definition, not a
    special case in the compiler.

### Current Trends (RTCI)

- **Grain and entities.** Monthly reported counts per agency and offense (`agency_monthly`), from the RTCI sample's
  CSVs (`update-rtci-db.py`). There are no incidents. `sample_agencies` is "an aggregation cohort, not an import
  allowlist" (`:119`), and `national_monthly` and `state_monthly` are sums over it.
- **Fits as is:**
  - counts by month or year; agency rates;
  - rolling windows (the `rolling` transform: months 2-120);
  - comparisons of periods.

  Today's C1-C6 (`current-question-types.ts:6-9`) are expressible apart from YTD.
- **Needs:**
  - **A sample cohort.** National and state values are sums over the RTCI sample, not over every reporting agency. A
    third `cohort` value, `source_sample` (the agencies of the source's declared sample in that release), sits beside
    `all_reporting` and `same_agencies`.

    Today's compiler shows a multi-month total only when the same sample agencies reported every month
    (`current-question-compiler.ts:9-12`). That is `source_sample` combined with the S3 rule of `same_agencies`, so the
    cohort should be able to combine the two: sample members that reported in every compared period.
  - **Year to date.** A period form, `year_to_date` (January through the release's latest month), and a comparison
    transform, `same_period_previous_year`. "YTD comparisons use the agency's latest month" (`claude.ts:200`) makes the
    period depend on the agency. Resolution therefore resolves YTD per place, and R2 checks each compared pair.
  - **Rates.** A month's rate is not annualised; a year or YTD rate uses that year's population; a rolling rate uses
    months-weighted population (`current-question-compiler.ts:13-15`). These are rules of the `rate` statistic that the
    layer declares per measure. Population rules must not be hard-coded in the compiler.
  - **One rule, not two.** The model prompt says national = `national_monthly` and never aggregate `agency_monthly`
    (`claude.ts:148-149`). The compiler sums the sample from `agency_monthly` instead (`current-question-compiler.ts`).
    The layer must pick one: the compiler's rule, since `national_monthly` is itself that sum.
- **Build.** A **lighter compiler over the existing tables.** The source is aggregate counts, so no microdata exists to
  rebuild.
- **Conflicts:**
  - Offense names: RTCI's "murder" or "violent crime" follows the SRS hierarchy and is not NIBRS's
    `victims.murder@1`. Measure ids are qualified by source (`rtci.murder@1`), and a reader never maps a word to
    another source's measure.
  - State rates and state rankings are sent to Historical today (`claude.ts:103`). That becomes a limitation with the
    redirect, unchanged.

### Hate Crime

- **Grain and entities.** A separate FBI hate crime master-file database for 1991-2025 (`data/hate-crime/README.md`):
  - `hate_crime_incidents` has one row per incident and offense (multi-offense incidents are exploded), with bias,
    location and a per-offense victim count;
  - `hate_crime_participation` has, per state and year, total and reporting agencies.

  Entities: incident and incident_offense. Units: incident (the default), offense, and victims as `reported_victims`,
  a **sum** of `offense_victims` (`hc-claude.ts:23-29`). It is not a count of distinct persons, and the label says so
  through its unit.
- **Fits as is:** counts and shares by bias, offense, location, state and year.
- **Needs:**
  - **Places by ORI.** Today agencies are found by name (`agency_name LIKE '%HOUSTON%'`, `hc-claude.ts:~165`). The
    engine resolves places to ORIs, as it does for the other sources.
  - **Coverage.** `reporting_agencies` counts agencies that had an incident (`import-hate-crime.py:461-468`), so the file
    has no evidence for a zero. A zero for an agency or state stays UNKNOWN until the zero-report records are decoded,
    which is the same position as D6's filtered zeros.
  - **A definition decision.** NIBRS has its own hate crime measure (`offenses.hate_crime@1`, every bias except
    88/99/blank). The hate crime file also covers SRS agencies, so the two count different things. They stay separate
    measures under their own sources, and which one answers an unqualified "hate crimes" is a reader decision for the
    owner.
- **Build.** A **lighter compiler over `hate_crime_incidents`**. There is no closed compiler today; the tab is model SQL
  apart from its capability exits (`app/api/hc-query/route.ts:348-420`).

## 3. Shared definitions

| Concept | Shared rule | Per source |
|---|---|---|
| Place | ORI identity, place kinds national, state, agency, county and agency_set; labels from one authority; county through `agency_county_crosswalk` | SHR: `shr_agency_identity` and the year-scoped class; Historical: state keys normalised; Hate Crime: name lookup replaced by ORI resolution |
| Period | calendar months and years; whole-year periods for annual measures (G5); a year in progress clipped and recorded (`clippedTo`) | RTCI: `year_to_date`, `same_period_previous_year`; SHR: the last complete year for annual answers |
| Population | one agency-year population per source release, with its provenance recorded in evidence; state and national from Census | known differences to declare in each shadow: RTCI agency_population (sample ORIs only), SHR incident-row population averaged, Historical's own population table, NIBRS `geo_population`. They are not merged; each source uses its own, named in the measure |
| Coverage | the four statuses; unknown is blank, never 0; a filtered zero needs evidence | SHR: Return A comparison; Historical: months reported; RTCI: the sample and its monthly reporting; Hate Crime: no zero evidence yet |
| Answer contract | groupings and numbers; fixed answer statements; evidence server-side | the label-column exception (G6), staffing only |

## 4. Suggested order

1. **SHR** (agreed). It has incident and victim microdata already, the closest fit to NIBRS, closed types today, and
   coverage statuses that map one to one. It needs G1, G2 and the person-rate rule.
2. **Historical and staffing.** An existing closed compiler; annual grain (G3, G5); estimates (G7); and the label
   column (G6), which tests the one exception to the result contract.
3. **Current Trends.** It needs the most new plan language (`source_sample`, `year_to_date`,
   `same_period_previous_year`, per-measure rate rules), and it should come once the cohort machinery is proven on
   NIBRS's `same_agencies`.
4. **Hate Crime.** No closed compiler, no zero evidence, and an owner decision on "hate crimes" across sources.

Each source follows NIBRS's sequence: correctness set, semantic layer, compiler, shadow against today's answers, then
release through `scripts/release.sh` after shadow acceptance.

## 5. What to do now, while NIBRS is being built

Only the cheap parts of section 1, so the NIBRS compiler does not hard-code what other sources will change:
- G1: carry `source` in the plan (fixed at `"nibrs"` for now);
- G2: era bounds from the layer, not the schema;
- G5: a grain field on measures (`month` for every NIBRS measure).

G3, G4, G6 and G7 change types other sources need first; they are done with SHR and Historical. None of this changes a
NIBRS answer.
