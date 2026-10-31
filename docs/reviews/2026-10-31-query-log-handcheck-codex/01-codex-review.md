# Codex review 01: the hand check (draft before commit)

Reviewed 2026-10-31, read-only, no network. Verdict: **REVISE** (six P2). The mechanical checks passed: 222 unique rows (122 gaps, 100 planned), the sample matches `random.Random(20261031).sample` in file order, copied fields match the classification CSV, and the Wilson arithmetic is right for the labels then in place. Applied before the first commit.

1. **P2, some "correct" planned verdicts contradict policy or source limits.**
   - P4: rates for generational cohorts are group rates (D03).
   - P96: SHR offender counts are refused (one offender per incident).
   - P51: "pushed out a window" was not shown to be an SHR field.
   - Applied: P4 and P96 are now misplaced (declines, with the alternative offered). P51 stays SHR, with evidence: SHR weapon code 55 is "Pushed or Thrown Out Window" (`lib/nibrs-codes.ts`).
2. **P2, some confirmed hidden gaps are unsupported.**
   - P72: sets of agencies are planned with Historical.
   - P81: SHR is monthly from 1976.
   - P97: the verdict itself was uncertain.
   - Applied:
     - P72 stays a gap, with the specific omission named: selecting agencies by type (tribal) is in no plan.
     - P81 is now misplaced (planned SHR).
     - P97 is marked provisional, with a sensitivity count (8 instead of 9). There is no local evidence of a Historical robbery weapon split.
3. **P2, G36 assumed "the old 11A definition" means Historical's legacy rape series.** Applied: clarify which definition (NIBRS 11A only, or Historical's legacy series), the place and the period.
4. **P2, G38 and G111 dropped a definitional part.** Applied: a compound question stays a gap if any part is one; the reason notes the follow-up. Both are gaps again.
5. **P2, the interpretation overstated the sample.**
   - "10% more" was ambiguous.
   - The total of labeled plus hidden gaps applies to the planned stratum only.
   - The 25% misplacement rate is not a per-source margin.
   - The category ranking was wrong.
   - Applied: all four restated.
6. **P2, possible personal first names in the CSV** (a greeting, and "Joe's" before "crime in Crofton"). Applied: replaced with `[name]` in the hand-check output. No emails, phones or street addresses were found.

Result after the fixes: 100 confirmed gaps (22 moved). The planned sample has 9 gaps (one provisional) and 18 other misplaced rows, so 27 misplaced in all.
