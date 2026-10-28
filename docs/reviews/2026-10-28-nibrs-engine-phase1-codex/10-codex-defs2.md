**ACCEPT WITH CHANGES.** Reviewed `c98de709` against `fde64d6`; no files changed.

The requested test command passes: **35 plans and 6 reader outcomes valid; every existing refusal case passes.** The new evidence supports the quoted rape counts and male-share figures.

Of the seven previous requirements: **1, 5 and 6 are resolved; 2, 3, 4 and 7 still have the following answer-changing gaps.**

1. **Versioned measure IDs fail request accounting.**  
   The spec requires IDs such as `victims.murder@1`, but `valueApplied()` compares the last dot-separated token directly with `"murder"`. A read-only probe returned **A4** for that valid binding. Qualified IDs such as `violent_crime.ucr@1` also need an explicit concept mapping.  
   **Required:** make binding resolution understand the specified IDs and test actual versioned examples. Otherwise valid questions are refused. See [`validate.ts`](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/validate.ts:319).

2. **The composite-share restriction is stated but not enforced.**  
   Spec lines 81–83 require the same composite as denominator. S12 checks only unit equality, so two different composites both labelled `fbi_standard` pass. I reproduced this with violent crime divided by a robbery-only composite: validation returned **no problems**.  
   **Required:** enforce composite identity for shares, preserving allowed numerator filters, and add that refusal test. Otherwise an incompatible denominator is accepted as a share. See [`validate.ts:270`](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/validate.ts:270).

3. **Numeric predicate validation accepts invalid bounds.**  
   `checkLayer()` accepts `between: [6, 5]`; the probe returned **no problems**. It checks the dimension but not operand count, finite values or bound ordering.  
   **Required:** validate those conditions and add focused tests. A reversed range can silently match nothing and become a false zero/unknown result rather than a rejected definition. See [`semantic.ts:127`](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/semantic.ts:127).

4. **The general Group A arrest shadow comparison still changes weapon concepts without declaring it.**  
   The carjacking separation is fixed. However, section 4 maps `summary_arrestee_demographics` to **armed-with** and lists only second weapons and missing offense joins as differences. Today’s Group A builder uses the **arrest offense’s weapon**, not the arrestee’s weapon (`nibrs-auto-update.py:822, 849–868`).  
   **Required:** declare this concept change—or preserve separate measures—and test an arrest whose offense involves a firearm but whose arrestee is unarmed. That changes the firearm-arrest count even with only one weapon slot.

5. **Carjacking clearance is mapped to all cleared offenses in qualifying incidents.**  
   Section 4 maps `summary_carjacking_clearance` to `offenses.cleared@1` “on carjacking incidents.” In a cleared incident containing robbery plus another offense, that can count **two**, while the carjacking denominator is **one incident**.  
   **Required:** specify cleared carjacking incidents, or restrict the cleared-offense measure to **120**, and test a qualifying multi-offense incident. Builder recovery can remain pending; the new measure’s grain cannot.

6. **Blank/unknown hate-crime bias remains unspecified.**  
   The definition at line 114 still qualifies any bias other than 88/99. A blank value therefore qualifies literally, although the inventory acknowledges that today’s location table excludes blanks. T7 covers multiple biases but not this previously requested boundary.  
   **Required:** define qualification using known substantive bias codes, specify blank/null handling, and test blank-only versus blank-plus-valid-bias offenses. Otherwise missing bias information can count as hate crime.

The revised property-value difference, robbery-versus-arrestee weapon distinction for carjacking, rape-era limitation, monthly coverage formula, and evidenced-zero handling are accepted. No additional coverage investigation or male-share stability test is needed.

**Necessity check:** The six changes above prevent valid-answer refusals, incompatible percentages or incorrect counts. Defer broader validator hardening, server-builder recovery and nationwide shadow execution; preserve the accepted evidence and scope.
