# Brief for relabeling, round 2

Round 1 drafted 218 labels (`scripts/fixtures/answer-eval/cases.json`). Two things have happened since:
- **Codex reviewed every label once.** Its verdicts are in `scripts/fixtures/answer-eval/codex-label-review-1.json`:
  `accept`, `change` (an issue plus a precise fix), `unresolved` (why), and `cross_case` consistency findings.
- **Jeff decided every policy row.** `docs/policy/nibrsai-answer-policy.csv` now has no open rows. Every row is
  binding, including the P rows. Its "status" column quotes Jeff where he chose differently from the proposal.

Your job: rewrite your batch's labels so each one satisfies **both** Codex's fix **and** Jeff's final decisions.
Where they conflict, Jeff's decision wins; say so in `notes`.

## Read first

- `scripts/fixtures/answer-eval/drafts/BRIEF.md`: round 1's brief, including the "Never read" list, which still
  applies.
- `docs/superpowers/specs/2026-10-28-answer-eval-labeled-set.md` and `lib/answer-eval/case.ts`: the rules and
  schema.
- The policy CSV, in full.
- For gold cases: the gold set's expectations.

## Jeff's decisions that change round-1 labels most (all are in the CSV)

1. **Source (P01, P02, P14, D30).**
   - The app picks the source by what the question needs; a source named in words is honored.
   - Completed years of the standard (Part I) crimes, clearance and staffing come from Historical (FBI annual;
     estimates for states and the nation).
   - This year or recent months come from Current Trends. Homicide victim or offender details come from Homicide
     Reports. Hate crimes come from the Hate Crime file.
   - Details only NIBRS records come from NIBRS. So does an agency missing from Historical, or months no other
     source holds; those answers are labelled as reporting agencies.
   - The tab a case was asked on does NOT decide the source unless it is the advanced-option tab the user chose.
     Treat gold and replay cases' `tab` as that advanced choice only where the gold expectations require it;
     otherwise route by P01.
   - Never splice two sources in one series (P14).
   - The answer ends with its source statement (D30). Add "names its source at the end" to `statements`.
2. **Ask, never assume (D31, P05, P06, P12).** A question missing its year, place or crime gets a clarify. Use the
   buttons in those rows, most likely first. Bare "crime" is D09.
3. **P03 (reversed).** A NIBRS-only trend counts all reporting agencies (cohort all_reporting), with a prominent
   statement offering consistent reporters.
4. **P04.** Completed-year rankings leave out agencies with fewer than 12 months: say how many, and offer a button
   to include them. Current-year rankings use agencies with every month so far. This overrides the gold
   no-unrequested-filter expectation for completeness only. Note the override.
5. **P11.** "Victims" of a property crime: answer with offenses, plus the statement "Property crimes are counted by
   offense, not by victim."
6. **P13.** "Safest" or "most dangerous": decline with the note; alternative null.
7. **P18.** A state clearance rate: decline; alternative null.
8. **P25.** A county with its own county police department (Montgomery County MD, Fairfax County VA and similar)
   means that department. Elsewhere, the sheriff's agency (D10).
9. **P08.** "Large" or "big" city: 250,000 residents or more.
10. **P09.** "Assault" alone means aggravated assault, stated. **P10.** "Homicide" means murder and non-negligent
    manslaughter.

## Codex's cross-case findings to apply consistently

- **Units (D18).**
  - Crimes against persons count victims; property crimes count offenses; violent crime uses the FBI composite.
  - Whatever the source stores, the unit is the semantic unit.
  - Carjacking is a robbery-based measure: offense.
- **Grouping vs counting.** "Crimes by offender age" counts crimes grouped by the linked offenders' attribute; it
  does not count offenders. Say how a crime with several offenders is attributed.
- **Clearance.**
  - A percentage: cleared offenses over the matching reported offenses.
  - Use unit "offense", statistic "share", and filters naming "cleared".
  - Never "percent cleared" as a unit; never a per-capita rate.
- **D11.** A rape series crossing 2013 carries the definition-change statement.
- **Clarify/button pairs.** Each option's meaning is exactly the original question with that choice. The button
  case (`button`) expects the answer that option leads to.
- **Coverage-dependent actions.**
  - When the right action depends on whether a specific agency has data for a specific period, and no
    deployment-aligned evidence is in the repo, the label is `unresolved`, with that reason.
  - Source-wide maximum years, local copies and draft claims are not evidence.
  - Do not guess.
- **Policy rows.** List every row the label relies on in `policy_add`, including D30 and D31.

## Output

Write ONE file, `scripts/fixtures/answer-eval/drafts2/<batch>.json`, keyed by case id, with the same fields as
round 1 (`status`, `expected`, `policy_add`, `notes`) plus:
- `codex`: what Codex said for this case: `accept`, `change` or `unresolved`;
- `applied`: `"codex fix"`, `"codex fix + decisions"`, `"decisions only"` or `"unchanged"`;
- `superseded`: the decision ids that overrode a Codex fix or a gold expectation, or `[]`.

Every non-null `expected` must parse with the `Expected` schema. Edit no other file. Report counts by action,
status and `applied`, and the cases you are least sure of, in under 250 words.
