# Codex review 03: P71 (quarters), P72 (population and agencies-reporting columns), LS-420 and LS-421

Reviewed 2026-10-31, read-only, `git diff 4d5204f cbb2ffc`. Verdict: **ACCEPT**. LS-420 and LS-421 are frozen (reviewed_by codex:inc7b-labels-3); their values stay pending.

- **P71: accepted.** Monthly sums; an incomplete quarter is visibly incomplete. No zero-filling, annualizing or suppression rule is added.
- **P72: accepted.** The population actually used for the rate; agencies reporting for state and national totals only; the rate is unchanged.
- **P69's pointer to P71 and P72: accepted.**

**Build checklist for P72 (must land before these columns are delivered):**
- Extend `ResultColumn`, header binding and `checkEnvelope`'s allowed-column set to authorize the population and the agencies-reporting outputs. Today only groupings and statistics are allowed (result.ts).
- Keep numeric/null validation and cell evidence for both columns.
- Update the plan-language contract prose (docs/superpowers/specs/2026-10-28-nibrs-plan-language.md), including its blanket prohibition on exposing cohort figures.

**Build checklist for P71:** visible incompleteness is explanatory text, not a status column (D08, D29). The closed answer statements need a way to deliver it.

**Consistency:**
- **P58:** an incomplete period still gets no rate.
- **P59:** P72 shows the denominator without changing it.
- **P61:** the agencies count follows the answer's reporting cohort. The population for a rate must not be confused with the Crime Index population used for coverage shares.
- **D08 and D29:** explanations stay out of number cells. P72 does not open annotation columns in general.
