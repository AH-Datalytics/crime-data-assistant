**REVISE.** The wrapper is thin and isolated, but I reproduced a wrong-answer path and found policy and alternative-construction defects. Both supplied test suites pass. No files were edited.

1. **Spelling correction can change real words into a different crime request.**  
   [reading.ts:54](C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/reading.ts:54)

   Reproduced: **“Sample assaults in Memphis in 2023” → “Simple assaults…” → an answer counting simple-assault victims.** “Violet crime” also becomes “Violent crime,” although the P01 guard currently prevents a number.

   An unread word is not necessarily misspelled, and a unique nearest vocabulary word does not establish intent. Disclosure does not make the changed meaning correct. Restrict automatic correction to defensible spelling repairs; leave uncertain words unresolved or clarify. This is necessary before accepting the reader’s correctness.

2. **The forecast alternative has a hidden binding failure; alternative construction also drops unrelated constraints.**  
   [answer.ts:70](C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/answer.ts:70), [answer.ts:95](C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/answer.ts:95)

   Using an in-memory dependency fixture covering **2016–2026**, “Will shoplifting rise in Memphis next year?” still produces an alternative that declines:

   > `A4 period: "by year": grouping at period is not by year`

   Both inserted parts receive the same synthetic span. Binding identity uses that span, so the period binding collides with the grain binding. The existing test stops earlier at missing 2016 and therefore misses this defect. Give inserted parts distinct identities and verify the alternative reaches a valid annual plan when coverage exists; no additional data build is needed.

   Separately, both alternative builders remove **all unread fragments**, and the arrests alternative removes **all not-recorded parts**. That can erase qualifiers such as “near schools” or unrelated unsupported geography. Remove only the forecast/court wording being replaced; preserve other constraints or explicitly decline the narrower alternative. Current execution limitations mask this risk rather than resolve it.

3. **The P01 guard tests the crime name without checking what is being measured.**  
   [answer.ts:173](C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/answer.ts:173)

   Reproduced incorrect source explanations for:

   - “Robberies with a firearm in Memphis in 2023”
   - “Robbery arrests in Memphis in 2023”
   - Robberies cleared because prosecution was declined

   These are NIBRS details, not ordinary Part I totals belonging to Historical/Current Trends. The measure list itself covers the expected Part I families; its unconditional application is the problem. Restrict the guard to the applicable counts. Unsupported details may still decline, but must give the actual capability limitation.

4. **Forecast detection confuses a future period with a forecast and misses ordinary predictive wording.**  
   [reading.ts:32](C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/reading.ts:32)

   “Shoplifting in Memphis next year” receives P20 solely because it says “next year,” while the equivalent explicit future-year count is treated as an unavailable period. Conversely, **“Predicting shoplifting in Memphis in 2027”** misses forecast detection and declines as unread text without the alternative.

   Separate predictive intent from future-period selection and cover ordinary inflections. The test currently endorsing bare “next year” as sufficient should change with that correction. Broad flags also inspect the whole question rather than the accounted clause; keep their scope consistent with the ledger.

5. **Qualify the before/after claims against the evidence actually retained.**

   The stored reports support:

   - Development **15→19 correct**, with no outcome-category regressions among the existing cases.
   - The new 25: **14 correct, 6 unverified, 3 avoidable declines, 2 wrong actions**.
   - All five boundary cases decline; this prevents wrong numbers but does **not** constitute passing their expected behavior.
   - Labels unchanged after freezing; `nibrs-model/main` currently resolves to `7327dce`.

   However, the reports at both `origin/dev` and `2f3cb1c` already show **zero wrong answers**. They do not substantiate **2→0**, nor retain the new cases’ claimed **13→3** decline baseline. Identify the separate baseline used or omit those comparisons. The two earlier `incomplete` cases are not two wrong answers.

   LS-260’s disclosed inspection is correctly described as regression evidence. Because its fix changes shared forecast-alternative logic, the final forecast-family results should not be presented as wholly untouched held-out evidence.

The remaining architecture and policy observations do not require another build:

- **Thinness:** `reading.ts` delegates accounting and matching rather than copying them. Rewrites are attached to the ledger and survive its cloning. The ledger’s question is rewritten text; the original is retained by `ReadQuestion`, but not separately passed through `shadowAnswer`.
- **Isolation:** the three production reader files are unchanged, and `app/` has no shadow imports.
- **D06:** ordinary YTD answers clip coverage and name months. Comparison probes conservatively decline; I found no unequal-period number from them. LS-268 remains an acknowledged failure.
- **D01/D28:** court declines are appropriate for the tested court outcomes; unavailable alternatives and clarification failures remain limitations, not passes.
- **Phrase variants and place stop-gap:** the reviewed rewrites preserve the specified vehicle-theft distinctions. The two ORI-keyed place aliases are a reasonable temporary measure; a crosswalk project is unnecessary for this review.

**Necessity check:** Fix the demonstrated wrong-reading path, alternative construction, and incorrect policy classifications before calling this reader promotable; correct or qualify the unsupported result claims now. Defer broader language coverage, crosswalk work, additional data builds, and already-recorded conservative boundary failures. Preserve the accepted labels and successful evidence.
