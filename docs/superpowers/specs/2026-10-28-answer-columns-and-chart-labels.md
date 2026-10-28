# Answer columns: groupings and numbers only; chart labels measured, never cut (plan r4, 2026-10-28)

Status: r4, implementing phase 1. r1 (9 findings), r2 (5) and r3 (5), each ACCEPT WITH CHANGES, are recorded beside this file as
`2026-10-28-answer-columns-codex-r1.md`, `-r2.md` and `-r3.md`; each finding is answered below (marked **[rN #n]**).

## Owner rules

- "the tables and exports should only give the appropriate columns" (2026-10-27, on `shr_records` in an export).
- "We should never need status and notes" (2026-10-28).
- "Staffing is the only one that should have one text column for if it's reporting officers or employees based on
  the current rule" (2026-10-28); the rule is the older one: "Go back to the older rule" (2026-10-28).
- Constant columns in the CSV: "I'm ok with the constant columns" (2026-10-28).
- Explanation sentences are text, not table columns, and are out of scope here (2026-10-28).
- Unchanged: minimize editorializing; unknown is never shown as zero; the chart notes under the chart ("Sample of N
  agencies covering N population.", "<year> covers data from <Month> to <Month>.") stay.
- Fix both "systemically"; labels "cut at narrow widths" (item 3.1).

## Root cause

**Columns.** Builders put annotations into result rows, and each surface then decides its own columns.

Annotation producers **[r1 #1]**:

| Column | Producer | Internal consumers that read it from rows |
|---|---|---|
| `note` | `lib/current-question-compiler.ts` (`COLUMNS`, rows) | `lib/why-answers.ts` (missing reports, sample participation, missing population) |
| `note` | `lib/historical-question-compiler.ts` (series, pooled, change; staffing cells) | `why-answers.ts`; staffing explanation |
| `note` | `lib/nibrs-question-compiler.ts` (`SERIES`, `BREAKDOWN`, `SHARE`, `CHANGE`) | `typedChartConfig()` (rejects partial-period charts; compares column arrays with schema constants); `seriesTitle()` (parses partial-year notes); `why-answers.ts` |
| `shr_records`, `years_without_records`, `periods_without_records`, `population_status` | `lib/shr-count-plan.ts`, `lib/shr-question-types.ts` | pooled-year narratives (`shr-count-plan.ts` ~631, ~652); population narratives (`shr-question-types.ts` ~1535) |
| `shr_status`, `shr_coverage_caveat`, `shr_recorded_months` | `lib/shr-deterministic-murder.ts` | `app/api/shr-query/route.ts` (~684) coverage tags |
| `data_type` | legacy model-SQL examples in `lib/claude.ts` (~843-878); Historical model SQL is now blocked by request accounting, so no active answer produces it **[r1 #7]** | none active |

Column-choosing surfaces **[r1 #5]**:

| Surface | Kind |
|---|---|
| `components/DataTable.tsx` + `lib/table-display.ts` | answer |
| `components/ChartPanel.tsx`, `components/NibrsChartPanel.tsx` (NIBRS, SHR, embeds) | answer |
| `lib/chart-config.ts`, `lib/nibrs-chart-config.ts`, NIBRS `typedChartConfig()`, `lib/chart-layout.ts` (`CHART_METADATA_KEY`) | answer (chart column choice) |
| `components/ExportButtons.tsx`: CSV, image download/copy, embed-link creation; callers `NibrsChat`, `RtciChat`, `ShrChat`, `WorkspaceChat`, `WorkspaceChatV2`, `WorkspaceChat_restore` | answer |
| `app/embed/page.tsx`, `app/api/embed/route.ts` (replays stored SQL and stored chart config) | answer |
| `app/chart-audit-preview/preview-client.tsx` | diagnostic; uses the shared projection, no separate contract |
| `app/api/query-log/route.ts` POST (raw replay rows) | administrative; explicitly excluded |

**Labels.** `ChartPanel` and `NibrsChartPanel` size 13 px DM Sans ticks (Segoe UI/Arial fallback, loaded with
`display=swap`) from character counts: slanted labels at 5.5 px per character capped at 240; wrapped category labels
cut to three lines with "…" (`wrapCategoryLabel`); sideways labels capped at 170 px or 42% of the box; the Y axis at
the library default width.

## Design

### 1. The answer contract **[r1 #2]**

An answer's columns are its **groupings** (place, period, and requested categories, including substantive ones such
as `clearance_status`, `jurisdiction_label`, `agency_label`, `place_label`) and its **measures** (requested numbers,
including measures that are all blank). An **answer annotation** is a column whose only role is to describe other
cells: their coverage, status, a caveat or a note.

- `lib/answer-columns.ts` (new) holds `ANSWER_ANNOTATIONS`, an **explicit list**, not a pattern: `note`, `notes`,
  `shr_records`, `years_without_records`, `periods_without_records`, `population_status`, `shr_status`,
  `shr_coverage_caveat`, `shr_recorded_months`, `coverage_status`, `coverage_caveat`, `data_type`,
  `years_with_reports` **[r2 #1]** (Historical pooled answers; `historical-question-compiler.ts` ~295). A name not on
  the list is never dropped. Positive and negative fixtures (`clearance_status`, `*_label` groupings kept).
- The staffing exception (section "Staffing") is a one-entry allowlist; a test fails if it gains an entry.
- A known annotation that still reaches egress (model SQL, an old embed) is dropped there and tagged
  `answer-annotation-dropped:<name>` in the request's tags. A grouping, or the discriminator of a mixed measure, is
  never dropped: those are fixed at the source or by a named compatibility transform.

### 2. Move annotations out of results, keeping the facts **[r1 #1, #6]**

Each producer returns its facts as **internal evidence** beside the answer, never as columns:

- **Compilers** (`current-`, `historical-`, `nibrs-question-compiler.ts`): each compiled answer gains
  `cellEvidence: { rowKey: Record<string, unknown>; column: string; reason: string }[]`, keyed by the row's grouping
  values (not its index, so projection and sorting cannot detach it), holding the reasons that are now `note` strings
  and `years_with_reports`; and `partialPeriods: { x: string | number; label: string }[]`, the same shape the chart
  metadata already uses (`DataTable`'s `partialPeriods`). `typedChartConfig()` and `seriesTitle()` read these instead
  of `row.note`; the schema constants they compare against drop `note`. **Transport to "why" [r2 #3]:** the
  emission-paired `why-scope`/`why-turn` capture (`lib/why-turn.ts`, `InnerCapture`) gains `cellEvidence`, and
  `WhyAnswerFacts` carries it, so `why-answers.ts` reads the same facts it reads from rows today. Chart eligibility,
  titles and "why" text stay as they are.
- **SHR count plans** (`shr-count-plan.ts` **and** `shr-question-types.ts`) **[r2 #3]**: `ShrCoverageEvidence` is
  place-keyed: `{ place: string; period: string | null; reason: "no_records" | "population_missing" |
  "population_conflicting" | "zero_denominator" }[]`. **[r3 #1]** The existing complete coverage grid
  (`coverageSql`: every constituent place and period with `has_records`) is kept beside it, with constituent place
  identity, because `shrQuestionOutcome()` decides "no records at all" from the full grid, not from exceptions.
  Fixtures: one place-period set partly missing, one entirely missing. The compiler returns the evidence-query
  definition beside the answer SQL; execution returns the evidence rows beside the answer rows. Per-place narratives (`shr-count-plan.ts`
  ~618) and typed coverage (`shr-question-types.ts` ~1495) read it.
- **SHR deterministic murder**: `ShrMurderPlan` gains `coverage: { city: string; status: string; caveat: string |
  null; monthsWithRecords: number }[]` (`caveat` nullable, as the producer emits NULL today), built from the same
  TypeScript values that now become `annualCoverageValues`; the route's coverage tags read it.
- Kept as-is: requested period rows, valid zeros, the owned-count route's numeric unknown-period accounting
  (`shr-query/route.ts` ~1336), zero-denominator ratio handling, partial-year rates.
- Prompts (`claude.ts`, `nibrs-claude.ts`, the SHR and hate-crime prompts) **[r2 #2]**: "Return the groupings and
  measures the question asks for, including requested categories such as clearance_status; never an
  answer-annotation column (a note, caveat or coverage description of other cells); unknown is NULL." The staffing
  exception is stated where staffing is taught. The legacy `data_type` examples are rewritten to the staffing
  section's shape.

### 3. One projection, in this order **[r1 #4]**

**[r2 #4]** The invariant: each answer route (`query`, `nibrs-query`, `shr-query`, `hc-query`, `embed` replay)
builds **one projected answer** (`projectAnswer(result)`: annotations removed, drop tags recorded) right after the
plan runs, before chart reconciliation and before every finalization and emission; everything after reuses that
object. Each route keeps its own existing timing: the streaming `query` route still finalizes and emits first and
logs once after explanation refinement, retry or fallback (`query/route.ts` ~3610); JSON routes keep theirs. Proof
modes are unchanged.

Tests (matching what the interfaces actually hold):
- per route: the columns and row keys handed to `finalizeProof()` equal the emitted ones;
- chart serialization receives projected columns only;
- where a digest is persisted (proof on), it is computed from the projected input;
- the query log records the `answer-annotation-dropped:<name>` tags (it stores a row count, not rows; no new
  storage);
- embed replay: projection before its finalization and emission; its replay bookkeeping unchanged (no new
  query-log row, no new stored columns).

### 4. Columns per surface **[r1 #3]**

- **Table**: `tableDisplay()` keeps its current presentation (constant text grouping folded into the heading, measure
  and unit names absorbed into friendly headers, empty optional columns dropped). It keeps requested all-null
  measures, as today.
- **CSV**: the projected answer's columns in their original order, every one, including constant groupings and
  all-null measures. It does not reconstruct from the table's heading. Example: "Murders by month in Houston in
  2024" → table heading "Houston, TX", columns Month | Murders; CSV columns place, month, murders, with "Houston, TX"
  on every row.
- **Chart**: reads the projected columns; `CHART_METADATA_KEY` is deleted only after every rendering entry above uses
  the projection.
- **Old embeds** **[r1 #5]**: replay filters annotation columns, then reconciles the saved chart config (an axis or
  series naming a removed column is dropped or remapped); chart notes are preserved. A legacy staffing embed with a
  `staffing`/`data_type` pair is transformed by a named function (section "Staffing") before any drop.

### 5. Chart labels measured in the browser **[r1 #8]**

- One shared helper for both panels, `lib/chart-text.ts`: measures label widths in the browser
  (`CanvasRenderingContext2D.measureText` with the panel's computed font), re-measured after `document.fonts.ready`
  and on resize; wraps by measured width.
- Slanted labels: axis height from the measured widest label; no 240 cap. If the plot would fall below its 150 px
  floor, switch to sideways bars or wrapped labels.
- Wrapped labels: **no "…" truncation**; the axis grows to the lines needed.
- Sideways labels: the label column is the measured widest label up to 50% of the box; longer labels wrap; the box
  grows.
- Y axis: width from the widest formatted tick.
- Legends (outside the SVG) wrap within the chart box.
- Plot space and chart notes keep their reserved height.

### 6. Tests and release **[r1 #9]**

- **Contract**: `answer-columns` fixtures, positive and negative.
- **Producers**: every compiler and SHR builder returns no annotation column, and its evidence carries the same
  facts. Updated: `test-shr-count-plan.ts`, `test-shr-deterministic-murder.ts`, `test-shr-question-types.ts`,
  `test-historical-question-types.ts` (its `years_with_reports` assertion moves to the evidence; totals and
  missing-year expectations unchanged), `test-nibrs-typed-chart.ts`; their numeric and null expectations unchanged (non-staffing answers; staffing changes only in phase 2).
  SHR fixtures with two places, each missing different years, check the place-keyed evidence.
- **Behavior** (instead of a syntactic "no `response.columns`" check): representative route → render → CSV paths per
  tab; fixtures for all-null measures, `clearance_status`, an old embed whose SQL and chart config use removed
  columns, partial-year chart evidence, CSV constant groupings, retained chart notes.
- **Ordering** **[r3 #5]**: the assertions in section 3 (finalization input = emitted; chart serialization,
  persisted digest and drop tags checked separately). Implementation: `projectAnswer` is applied inside
  `finalizeProof()` to its input and inside `emitFactualPayload()` to the payload (`lib/proof-finalize.ts`), the two
  choke points every answer route already passes through; the projection is pure, so both see the same answer.
- **Labels**: Node tests for the layout arithmetic; **browser evidence before release** at 375, 768 and 1280 px on
  long-label fixtures (long agency names, 16 bars, large numbers, the owner's example if supplied): measured label
  boxes inside the chart area, no overlap, no added "…". Run in the app's browser pane and recorded; browser CI is
  optional.
- **Release**: O352 and H1-H3 lose their `note` column (and any `years_with_reports`). `scripts/fixtures/release-checks/expected-changes.json` gets
  entries with executable checkers that confirm the removed fields and that every number, period, row order and chart
  binding is otherwise unchanged. No blanket masking of rows.

## The new engine

The engine's result contract (`lib/nibrs-plan/result.ts`) adopts the same rule. The engine session has been told; it
is not a dependency of this release.

## Out of scope

- Explanation sentences (text, not columns).
- Data fixes (the rebuild's work).
- A font-metrics asset pipeline; browser CI; broad chart certification.

## Staffing, phase 2: a separate PR (owner decision 2026-10-28: "Go back to the older rule") **[r2 #5, r3 #2-4]**

Option B touches more paths than the column work (Codex r3 #2-4), so it ships as its own PR with its own Codex
review, after phase 1. Phase 1 treats staffing's `note` like every other note (internal evidence). Phases 1 and 2
are released together in one `release.sh` run, so no live staffing answer is ever without its text column.

Rules for phase 2:

- **Scope.** Only an **officers** question (count or rate) substitutes. In a year where the officer figure is
  missing or zero but total employees were reported, the figure shown is total employees. A **civilians** question
  never substitutes; an **employees** question needs none.
- **The one text column.** `reported`, values exactly "Officers" or "Employees", says which figure each row shows. It
  is staffing's classification only. Every other staffing reason (no staffing reported, no population) stays
  internal evidence (`cellEvidence`), and those years show a blank figure with `reported` blank.
- **Measure identity.** The measure is not labeled as officers alone. Column `officers_or_employees`; table and CSV
  header "Sworn officers (total employees where marked)"; chart series name "Sworn officers or total employees" with
  `reported` in the tooltip; titles say the same. Rates are labeled the same way and computed on the figure shown.
- **Changes.** A change (or percent change) between two years is computed only when both endpoints have the same
  `reported` value. Across unlike endpoints the change is blank, with the reason as internal evidence; it is never an
  officer-to-employee difference.
- **Chart.** `reported` is never a series: `answer-columns.ts` marks it as a label column, and every chart path
  (`chart-config`, `nibrs-chart-config`, `typedChartConfig`, `detectAndPivotChartData`) reads that marking before
  `CHART_METADATA_KEY` is deleted.
- **Where.** `historical-question-compiler.ts` `staffingReader()`/`staffingCells` and the change compiler (~520); its
  explanation line ("…nothing is substituted.") is replaced by one stating the substitution plainly. The legacy
  prompt examples in `claude.ts` take the same shape. A legacy staffing embed's `staffing`/`data_type` pair maps to
  `officers_or_employees`/`reported` ("Employees*" becomes "Employees") before projection.
- **Guards.** `reported` is the only allowlisted text column, and only on staffing answers. Tests: an officers series
  mixing both kinds; a civilians question (no substitution); a rate on an employee year; a change across unlike
  endpoints (blank); a change across like endpoints (computed); chart series discovery skips `reported`.
- **Rankings and lists [r3 #2]:** `compileRank()` (~422) applies the same selection before availability filtering,
  rate calculation, sorting and limiting, carries `reported`, and uses the mixed-measure wording. The rate is always
  `selected count × scale / that agency's population for that year`, never the SQL's precomputed officer rate; missing
  or nonpositive population stays blank; minimum-population rules unchanged. Fixtures: count and rate rankings where
  substitution changes the order; a missing population.
- **Multi-figure results [r3 #3]:** the mixed alias applies only to officer requests; explicit civilian or employee
  measures keep their identity, and separate requested measures stay separate. A pooled officer total is computed only
  when every contributing year shares a classification; otherwise the annual figures are shown and no combined total.
  For a change with unlike endpoints, each endpoint's figure is labeled by its own measure (endpoint-specific headers
  or one row per period) with the change blank. Fixtures: pooled mixed, unlike endpoints (table and CSV), officers
  plus civilians.
- **Charts and legacy replay [r3 #4]:** classification is kept by period **and series** through
  `detectAndPivotChartData()`, and tooltips read it. Legacy embeds with a `staffing`/`data_type` pair are reconciled
  (titles, series names, axis labels too); legacy wide comparisons without a discriminator are reconstructed from the
  source where possible, otherwise answered with a specific limitation, never labeled "Officers" by guess. Fixtures:
  two agencies with different classifications in one year; legacy embeds with and without `data_type`.
- This reverses r1 #7's "without automatically adding unrequested employee counts", by owner decision.

## Order of work

Phase 1 (this PR):

1. `answer-columns.ts`, the projection at the two choke points, with the ordering tests.
2. Evidence fields and the producer changes (compilers, SHR), with their consumers, in one step.
3. Surfaces on the projection; embed replay reconciliation; then delete `CHART_METADATA_KEY`.
4. Measured labels; browser evidence.
5. Release checkers; Codex review of the implementation; PR into dev; `release.sh`; live check at 375 px.

Phase 2 (separate PR): staffing rule B per its section, with its own Codex review. Phases 1 and 2 merge before one
release; neither is deployed alone.
