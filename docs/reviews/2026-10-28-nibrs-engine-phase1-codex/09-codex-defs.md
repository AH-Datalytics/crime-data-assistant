**Verdict: REVISE.** Reviewed branch `nibrs-engine/phase1` at HEAD `fde64d6a355d3dc42e19bfdb72a814dd5ce683da`. No files changed.

The scope addition is sound, and several important corrections are right. However, the document is not yet an exact, complete semantic contract: some definitions contradict their builders, some cannot be represented as claimed by the accepted interface, and several tests would miss those errors.

**Verified and accepted**

- **Carjacking:** the same-incident definition is correct. The property segment does not establish that the robbery took the vehicle. Both builders use `MIN(type_weapon_1)` for the incident’s robbery weapon; retaining all robbery weapons is an intentional improvement.
- **Property-crime victims:** the correction is right. Existing cases M5 and M7 contain victims connected to 23F and 240, including individual and business victims. The limitation is in today’s summaries, not NIBRS.
- **2013 rape change:** the central correction is right. The FBI explicitly says the expansion applied to SRS; NIBRS already captured the broader offenses. It did make minor wording changes, so “no reporting-requirement change” is more precise than “no meaning change.” [FBI explanation](https://ucr.fbi.gov/nibrs/2013/resources/nibrs-rape-vs.-srs-rape).
- **Coverage arithmetic:** I recomputed all ten comparison rows from the supplied CSV/JSON files. Every figure agrees at its stated precision. Every monthly CDE percentage also matches participating population divided by its population denominator within rounding.
- The documented flash-mob SQL/text disagreement, DV relationship lists, and carjacking weapon-bucket disagreement are real.

The following changes are required.

1. **Correct the property-value rule and its grain.**  
   Spec line 85 says the current rule excludes **agency-years** averaging at least $1 million. [`build_property_summary.py:39`](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/scripts/build_property_summary.py:39) instead sets `total_value = 0` on qualifying **summary rows**, retaining `record_count`.

   State the exact summary-row key and distinguish value adjustment from exclusion. Specify how that aggregate-dependent adjustment applies to canonical property segments—or declare a deliberate difference. Add a case with one affected summary row and one unaffected row in the same agency-year.

   **Consequence:** the proposed rule changes both dollars and potentially counts while promising equality.

2. **Reconcile definitions with the accepted measure contract.**  
   Spec lines 80–97 mix measures, dimensions and categories, often assigning several units to one ID. [`semantic.ts:33`](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/semantic.ts:33) requires one entity, one unit and an executable aggregation per measure.

   In particular:
   - The mixed-unit violent-crime composite needs a defined representation; the interface has no sum-of-measures aggregation.
   - Flash mob’s six-offender threshold needs an explicit derived attribute/entity or a contract extension; `SemanticPredicate` supports existence, not cardinality thresholds.
   - `carjacking.weapon@1` cannot use incident denominators indiscriminately for victim/offender/arrestee shares. Accepted S12 requires the same counting unit.
   - Resolve `offenses.rape@1` versus `victims.rape@1`, enumerate the other C6 IDs, and version the theft-from-vehicle definition.

   **Consequence:** implementers would have to invent semantics or change the accepted contract implicitly. No architecture redesign is necessary; explicit mappings and narrowly identified extensions suffice.

3. **Separate robbery weapons from arrestee weapons.**  
   C1 and line 81 overgeneralize the demographic weapon source. [`nibrs-auto-update.py:988`](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/scripts/nibrs-auto-update.py:988) uses **`a.arrestee_weapon_1`** for carjacking arrestees, not the robbery’s `MIN(type_weapon_1)`.

   Define robbery-weapon and armed-arrestee classifications separately, including all relevant slots. Test an incident where the robbery weapon and arrestee weapon differ, plus a multiweapon case and an unrelated-offense victim.

   **Consequence:** today’s arrestee counts could be compared against a different concept and incorrectly explained as merely “additional weapons.”

4. **Complete the inventory and table-to-definition mapping.**  
   “Every category” is not yet supported. Concrete omissions include:
   - Multiple-victim incidents: [`nibrs-claude.ts:275`](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-claude.ts:275), with the builder at `nibrs-auto-update.py:1312`.
   - Explicit “all homicide types” = 09A+09B+09C: `nibrs-claude.ts:1082`.
   - Exact requested NIBRS taxonomy rollups, currently mentioned but not enumerated/versioned.
   - Clearance classifications: the current builder treats any incident with an arrestee, or `cleared_exceptionally != 'N'`, as cleared (`nibrs-auto-update.py:1055–1088`).
   - The actual age buckets, beyond age decoding, and remaining weapon categories.

   Section 4 also omits explicit rows for relationship/circumstance summaries and drug arrests. DV arrests are mapped to a victim measure without explaining the arrest linkage or unit. Replace “every path” dependencies where necessary with concrete consumers.

   **Consequence:** these existing behaviors can disappear or change without the requested shadow accounting. Unknown server builders may remain explicitly pending; recovering all of them need not precede acceptance of the scope document.

5. **Limit the rape equivalence by source era and replace the statistical test.**  
   “Female 11A = legacy SRS rape, valid in every year” is unsafe. The FBI’s 2023 specification broadened 11A and discontinued separate collection of sodomy/object penetration; its implementation transition extends into this project’s years. Female 11A after that change cannot isolate the old legacy concept. [FBI April 2024 bulletin, pp. 16 and 24](https://le.fbi.gov/file-repository/ucr-program-quarterly-24-2-april-2024.pdf).

   Add era-aware mappings or an explicit unavailable result for legacy reconstruction. SRS labels must follow the actual series metadata, not automatically “revised from 2013”: both definitions continued to be published. [FBI 2013 addendum](https://ucr.fbi.gov/crime-in-the-u.s/2013/crime-in-the-u.s.-2013/rape-addendum).

   The quoted male-share percentages are arithmetically correct, but their underlying query/results are not in the supplied evidence. They support the premise; a stable demographic share is not a semantic correctness invariant. Test fixed male/female 11A/B/C records across the boundary, including a victim connected to multiple qualifying offenses.

   **Consequence:** the current test could reject legitimate population changes while accepting an incorrect legacy classification.

6. **Make coverage eligibility precise and qualify causal claims.**  
   Lines 180–185 need an explicit monthly formula and eligible reporting statuses, including treatment of known nonreporting, unknown months, partial submissions and periods spanning years. Clarify whether eligibility is evaluated independently each month.

   The evidence proves the denominator and threshold formulas differ. It does **not** prove that overlapping jurisdictions explain all denominator excess, or that late-joining agencies explain Florida’s numerator gap. Mark those as hypotheses pending agency reconciliation.

   **Consequence:** identical inputs can produce different implementations, and an unexplained difference could be prematurely accepted. Keep the existing ten-state evidence; no new national investigation is needed now.

7. **Strengthen the test specifications where shadow equality is insufficient.**  
   Retain N2/N4 and the existing microcases, but add explicit expected outcomes for the changed semantics: second/third weapons and biases, later relationships, blank/unknown bias, overlapping rollups, age boundaries, and LEOKA links beyond slot two. The hate-crime difference description must also cover additional bias groups when the first bias already qualifies.

   Lesson 6 needs missing/unsupported versus **evidenced zero** assertions; “none returns an empty table” does not test that distinction. Preserve the accepted `REPORTED_ZERO` behavior rather than implying every absent aggregate cell is unknown.

   **Consequence:** agreement with legacy tables alone can preserve known mistakes or miss the intended improvements.

**Necessity check:** Correct these definitions, mappings and test expectations before accepting the semantic scope for implementation. Preserve the verified coverage arithmetic and existing correctness cases. Defer owner changes to flash-mob/DV membership, server-builder recovery, and nationwide shadow execution to their stated implementation stages.
