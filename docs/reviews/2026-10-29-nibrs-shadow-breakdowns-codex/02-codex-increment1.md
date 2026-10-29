**REVISE.** There is a confirmed reader error and scoring gaps. Increment acceptance must also wait for V41–V49.

Reviewed `acbecc4` against `nibrs-engine/shadow-reader`, the recorded results, and the applicable plan/label review. Both existing shadow tests passed. Additional in-memory probes below used synthetic rows, not independent numerical evidence. No files were edited.

1. **Constrain the sex phrase rewrite to preserve who is being described.**  
   [reading.ts:35](/C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/reading.ts:35)

   Confirmed:
   > “Simple assaults committed by men and women in Detroit in 2023”

   becomes “committed by by sex” and returns an **answer grouped by victim sex**. The request concerns perpetrators. This can deliver numbers for the wrong population.

   Narrow the rewrite or preserve the subject and refuse unsupported readings. Preserve LS-278’s accepted victim-sex interpretation. This is an answer-correctness blocker, not optional language coverage.

2. **Complete the breakdown scorer before using it for acceptance.**  
   [shadow.ts:60](/C:/Users/jeffm/cda-compiler/lib/answer-eval/shadow.ts:60), [shadow.ts:132](/C:/Users/jeffm/cda-compiler/lib/answer-eval/shadow.ts:132)

   Three concrete failures:

   - **Period shares:** `sliceValues` assigns `share: null` to every category row containing `year` or `month`. It never obtains that period’s independent denominator. This cannot correctly verify LS-279’s numerical shares. Use the independent total for the same period; unavailable evidence must remain unverified, not become an expected blank.
   - **Missing shares:** I removed the share from both the plan and delivered table, regenerated a valid count-only delivery, and supplied expected shares. The scorer returned **`correct`**. Require the promised share output for this increment and compare its status as well as its percentage.
   - **Duplicate category keys:** I inserted a second `Male` row containing `999` and `99%`, before the correct row. The scorer returned **`correct`** because `new Map(...)` silently overwrites duplicate keys. Reject duplicate grouping keys before comparing values.

   The category-statement check only establishes that existing rows have nonempty category names; it does not establish “never dropped.” Complete independent row-key comparison can supply that evidence without a separate checking system.

   The comparator’s standard-share exception is reasonable **only alongside these completed checks**. As implemented, removing the “unverified” designation does not establish that the required share was delivered or verified.

3. **Make the category blank sentence no stronger than the evidence.**  
   [deliver.ts:150](/C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/deliver.ts:150)

   The sentence says a month “had none recorded without a zero report, or was not reported.” But `UNKNOWN` can mean reporting evidence is unavailable; it does not establish nonreporting.

   Use wording such as:
   > “No total is established for …: reporting evidence is incomplete, or a month has no recorded cases without evidence establishing zero. Shown blank, not zero.”

   Keep the affected categories/periods named. This is a small text correction required because this increment changes what answers assert.

4. **Wait for V41–V49 before accepting the increment.**

   The report establishes nine answers and four retained boundary refusals—not nine correct numerical answers. **Zero measured wrong answers with these values NOT MEASURED is not a passing gate.**

   After the consolidated corrections, compare the delivered category counts, statuses and shares against V41–V49. Retain LS-273, LS-278 and LS-279 as regression evidence, as already agreed. Reuse accepted N1/N2 evidence; no compiler recertification is requested.

Other inspected behavior:

- Sorting happens **before** table rows and evidence indexes are constructed; I found no index misalignment.
- Null/empty category values become `Not recorded`; known unknown codes retain their named categories. Unrecognized codes remain visible as `Code …`.
- Fraction-to-percentage conversion and one-decimal rounding are appropriate. The shape guard restricts shares to the counted measure within exactly its time groupings.
- Bins, multi-value groupings and unsupported dimensions remain refused. Carjacking-by-location still declines after D18 conversion.
- “By location and month” rewrites correctly, but the downstream reader declines monthly breakdowns. That is safe and outside the agreed nine-case must-answer requirement; the commit’s claim of monthly delivery is broader than demonstrated behavior.
- Stripping `Metro` resolves Louisville’s scorer mismatch. It is a lossy name normalization that could equate distinct same-state names differing only by that word, but I found no demonstrated false agency match in this increment. A general identity redesign is not a blocker.
- Disabling the DuckDB progress bar is appropriate.

**Necessity check:** Fix the demonstrated subject-changing rewrite, the scorer failures, and the unsupported blank-text assertion; then wait for independent values. These directly affect answer correctness and whether acceptance is truthful. Defer broader phrase coverage, monthly-reader expansion, agency-identity redesign, and compiler recertification.
