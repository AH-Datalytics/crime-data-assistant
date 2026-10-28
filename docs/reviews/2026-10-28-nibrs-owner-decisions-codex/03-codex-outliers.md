**REVISE** — calculations reproduce, but the owner-facing prose needs corrections.

1. **Correct the geographic counts and description ranking** in [findings 2–3](C:/Users/jeffm/cda-owner-decisions/docs/superpowers/specs/2026-10-28-nibrs-property-value-outliers.md:37).
   - $999,999,999: **90 agencies nationally; 62 in New York**. New York’s 2020/2021 counts are **2,432 / 3,031**; 2,436 / 3,039 are national counts.
   - Its leading descriptions are **Other (2,021), Vehicle parts (593), Automobile (445)**, rather than Household goods third.
   - $999,999,998: **6 agencies nationally; 4 in New York**, with occurrences spanning **2018–2024**, not just 2020–2024.
   
   These distinctions matter to the owner’s assessment of geographic concentration.

2. **Make rule B’s prose match its implemented caps** in the [candidate-rule table](C:/Users/jeffm/cda-owner-decisions/docs/superpowers/specs/2026-10-28-nibrs-property-value-outliers.md:85). The summary says vehicles/equipment have $10M caps, but buses, trucks, farm equipment, industrial equipment and logging equipment have **$100M** caps. Use the detailed description table as the explicit definition and qualify the summary’s exceptions. Also, B’s exclusions **beyond A affect 427 agencies**; **524** is the total for B including A. Otherwise the owner could select a rule based on an inaccurate description of its reach.

3. **Separate observed patterns from assumed reporting intent** in [the findings](C:/Users/jeffm/cda-owner-decisions/docs/superpowers/specs/2026-10-28-nibrs-property-value-outliers.md:34). Calling these values “fillers” as established fact exceeds what the scan demonstrates; use “candidate sentinels” or “repeated values” and identify placeholder use as unverified. “Confined to … New York agencies” also contradicts the four non-New-York $1,111,111 records. This matters because suspected invalidity is the rationale for exclusion.

4. **Qualify the duplicate-impact claim** in [the method](C:/Users/jeffm/cda-owner-decisions/docs/superpowers/specs/2026-10-28-nibrs-property-value-outliers.md:20). The scan does not measure duplicate dollar impact, so rarity alone does not establish that duplicates “do not change these totals materially.” Cite existing dollar-impact evidence or simply state that duplicates remain and their effect was not measured. No new scan is necessary.

Verification passed: all four generated artifacts exactly match an in-memory rerun; saved aggregates reconcile across all ten years; field positions match SEG03; A/A+/C and B’s detailed cap mapping implement the stated calculations. The 25 retained stolen segments ≥$500M are correct. No files were edited or full scan rerun.

**Necessity check:** Correct these factual and rule-definition statements before the owner chooses an exclusion policy. Preserve the calculations and artifacts; defer additional scanning, duplicate analysis and production comparisons.
