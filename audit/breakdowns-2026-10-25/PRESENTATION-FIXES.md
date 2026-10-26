# Presentation fixes for release (2026-10-25)

Worktree `C:/Users/jeffm/cda-breakdowns-20261025`, base 0b1ec41 (live). Diff: `presentation-fixes.diff`
(sha256 fd872abea35cfd12fcdb1b30c594acaec1e49e889b127b113fd14473cbcd1675). The SHR two-breakdown build is NOT in this diff.

Owner reports and what changed:

1. "half numbers" on a count chart: `lib/chart-layout.ts` niceYTicks uses a whole-number step when every value is whole.
2. "the labels don't fit": `components/ChartPanel.tsx` and `components/NibrsChartPanel.tsx`.
   - Category bars (not years, months or dates), 8 or fewer: flat labels wrapped under each bar, up to 3 lines (`wrapCategoryLabel`, `WrappedCategoryTick`).
   - Narrow screens, where a bar would be under 90 px: bars drawn sideways, full label to the left (`SideCategoryTick`), width from `ResponsiveContainer onResize`.
   - More than 8 categories: slanted as before, no 30-character cut; the axis height follows the longest label (cap 240 px).
3. "the table shouldn't give the back end measurements": `lib/table-display.ts` never states measure, unit, statistic, dimension or filter above the table; an unusual constant unit is named in the value header ("Robbery arrests"). `components/DataTable.tsx` joins the line with "; " (no middle dot).
4. Titles, owner's format "Kansas City, MO Murder, 1936 - 2025" and "Virginia Rape Exceptional Clearances By Type, 2025":
   - `lib/historical-question-compiler.ts` series title = place, measure (title case, singular for counts), years shown.
   - `lib/nibrs-question-compiler.ts` clearance breakdown title in title case with the year(s).
   - `lib/multi-city-deterministic.ts` chart title = places, measure, Rate/Count; years added from the rows in `app/api/query/route.ts` (`multiCityChartTitle`).
5. "why would we include (includes extradition denied)?": code C label is now "In custody of another jurisdiction" (FBI: "In Custody of Other Jurisdiction"), in both NIBRS label lists. Question-reading patterns for "extradition denied" are unchanged.
6. "new york city vs chicago robbery rate per year only gives chicago": Historical stores NYPD as "New York" (NY0303000). The multi-city Historical condition now uses the name without a trailing "City" only when no city agency has the full name (same rule as `resolveHistoricalAgency`). Test uses an in-memory DB with NYC and an Oklahoma City/"Oklahoma" decoy.

Tests (local): tsc clean; chart-panel-ticks, nibrs-typed-chart 36/36, round1-presentation 39/39, exceptional 11/11, historical-question-types 74/74, historical-national-rape 49/49, structural-route-placement 30/30, nibrs-question-types 28/28, shr-question-types 1267/1267, multi-city, followup-planner, baltimore-default 47/47, operation-taxonomy, period-correctness, regression-battery. Full harness: see below.

Local renders: Kansas City (real baseline data) title and table; NYC vs Chicago (real baseline data) filled column and title; Virginia chart at desktop and phone width from sample rows (local NIBRS data is a stub).

## r1 ruling: REVISE (Codex, transcribed)

PF-01 agency identity not unique (shortened name could sum two agencies); PF-02 constant filter/unit/statistic suppressed
with no replacement, titleless embed loses measure; PF-03 sideways bars drop yAxisLabel and leave reference lines on
the wrong axis; PF-04 the new release package's VR-03 expectation must be updated (old category wording and title).

## r2 changes (diff `presentation-fixes-r2.diff`, sha256 109d2d517b654c8169859f5d0b0db1ea74689c3201f3b54ff5b4133e91752497)

- PF-01: the shortened name is used only when no city agency has the full name AND exactly one city agency has the
  shortened name; otherwise the column is empty (NULL). Test: a second "New York" agency gives NULL, Chicago unaffected.
- PF-02: only `dimension` is always hidden; `measure` is hidden only under a displayed title (titles name it) or when
  absorbed into the header; `unit`/`statistic` only when absorbed; `filter` is stated as "Restricted to: …", `unit` as
  "Counted as: …". A breakdown's `count` column is named like `value` ("Rapes"). Tests: clearance breakdown with a
  filter, titleless embed, a share statistic.
- PF-03: sideways bars carry `yAxisLabel` on the numeric (bottom) axis; reference lines swap axes with the layout
  (a y threshold becomes a vertical line at the same value). Rendered at phone width with and without a threshold.
- PF-04: to be applied when the new release package is built (VR-03 expectation: new title format, label
  "In custody of another jurisdiction"); sealed past packages untouched.

Not changed: four-line sideways labels have no extra row height (owner-visible limit only with 8 bars on a phone).

## r2 ruling: ACCEPT (Codex, transcribed)

PF-01..PF-03 closed, no new regression; PF-04 deferred to package build; dense-phone label limit deferred.

## r3: owner decision on PF-02 (diff `presentation-fixes-r3.diff`, sha256 f86f6e1cf20323c59377cd4b144f722de765a70fb5d3c73897abd71eda9eaded)

Owner 2026-10-25, on "Restricted to" above the table: "no, I don't want anything like that"; "no extra line above the
table or graph". So:
- `lib/table-display.ts`: measure, unit, statistic, dimension and filter are never stated above the table (as in r1);
  the value or count column is still named for what is counted ("Rapes", "Robbery arrests") where it can be.
- `components/DataTable.tsx`: the r2 "Restricted to"/"Counted as" header names are removed.
- The restriction moves into the answer text: `restrictionSentence` in `lib/nibrs-question-compiler.ts`, added to the
  series and breakdown explanations ("Only female victims with weapon: handgun are counted."). Clearance breakdowns
  already say "Exceptional clearances only" in their text and title.
- Known consequence: the titleless embed and an unsupported statistic no longer state the measure/unit/statistic
  above the table (owner's call); the embed shows the explanation text? (Codex to confirm what the embed shows.)

## r3 ruling: REVISE (Codex, transcribed)

PF-02-E: embedded tables lose a constant restriction (embed shows no title or explanation; `app/api/embed/route.ts`
stores no explanation). PF-02-W: person attributes attach to the counted unit even when it is not that person (the
domestic-violence path counts incidents filtered on victim sex: "female incidents"). Path audit: no other non-null
filter emission; loss wording polish not a blocker.

## r4 (diff `presentation-fixes-r4.diff`, sha256 006c45ad8b9b1e1a4fa8625d2d58333df8d007540184b456cd9eaeee1b8df9cf)

- PF-02-W: `restrictionSentence(filters, unit, tables)` reads the filtered column from the tables used (victim_sex ->
  victim). A person attribute goes before the unit only when the unit is that person ("Only female victims are
  counted."); otherwise "Only incidents with a female victim are counted." Series pass every table used; breakdowns
  pass their table. Tests: incidents + victim_sex, offenses + offender_race, victims + victim_sex.
- PF-02-E: a table shown with no title (the embed) puts a constant restriction in the value/count column's name
  ("Rapes (female)"), never a line above the table (owner rule). Test added.
- Not changed, pre-existing: the embed's chart view has never shown a restriction (chart titles carry none; the owner
  declined adding restrictions to titles). Disclosed, not a regression of this diff.

## r4 ruling: ACCEPT (Codex, transcribed)

PF-02-E and PF-02-W closed for the reviewed reproductions; no new regression; no embed storage or schema change, no
migration; HTML-injection probes render escaped. The embed chart-view restriction gap predates this diff and is a
separate follow-up, not a release blocker. PF-04 stays for package build.

Step-bound ruling (Codex, ACCEPT-WITH-CHANGES): `codex-step-bound-ruling.md`; r3 goes into this release's capture-transfer AMENDMENT.
