**REVISE.** V15 and D28 are fixed, but “every delivered descendant is checked” remains incomplete. No files were edited.

1. **P1 — Some delivered answers still escape scoring.**  
   [shadow.ts:146](C:/Users/jeffm/cda-compiler/lib/answer-eval/shadow.ts:146) traverses answers and clarifications, but stops at declines without visiting their alternatives. Scoring also skips unexpected alternatives, extra options’ descendants, and descendants when the initial action differs from the label.

   Reproduced: adding an unmeasured delivered alternative to LS-238’s decline still scores **`correct`**, with **“wrong answers: pass.”** A delivered alternative following an initial-action mismatch likewise goes unchecked.

   **Necessary fix:** traverse every actual answer independently of label/action matching. Apply available expectations; otherwise mark it unverified and make the wrong-answers gate NOT MEASURED.

2. **P1 — Required continuation text is only partly checked.**  
   [shadow.ts:138](C:/Users/jeffm/cda-compiler/lib/answer-eval/shadow.ts:138) checks agency, missing-data wording and source, but omits applicable fixed statements.

   Reproduced using **“Shoplifting victims in Memphis”**: removing **“Property crimes are counted by offense, not by victim.”** from the period continuations still scores **`correct`** with matching values.

   **Necessary fix:** check applicable required statements in delivered text, including P11. Where applicability cannot be verified, retain an unverified result.

3. **V15: ACCEPT.**  
   It is consumed at `LS-140|St. Louis city, Missouri|Every year available`. Against the canonical release, its cells matched. Changing January 2021 from **25 to 26** produced **`wrong_answer`**. Missing nested meanings and county expectations appropriately leave the unchanged case unverified.

4. **D28 and focused regressions: ACCEPT.**  
   “Shoplifting arrests in Washington in 2024” now declines without depending on refusal wording. The LS-224 note is corrected. All four targeted test scripts passed; no delivery regression was observed in the focused checks.

**Necessity check:** only the two remaining scoring gaps block acceptance. The shortest defensible correction is one unconditional answer-tree traversal, with unchecked answers conservatively marked unverified, plus applicable fixed-text checks. Preserve the accepted V15, D28 and delivery work; no broader rebuild or new capability work is needed.
