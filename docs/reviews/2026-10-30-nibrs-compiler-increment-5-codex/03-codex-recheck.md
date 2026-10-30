# Codex review 03: re-check of review 02 (REVISE)

Commit 3b10310. Seven of nine fixed (1, 2, 3, 4 by disclosure, 7, 8, 9). New or remaining:
1. P2, state-sum.ts:150: the every-month view over years did not qualify a missing population.
2. P2, answer.ts:238: a span from this year into the future routed as this year alone.
3. P3 (deferrable), state-sum.ts:135: a zero population was explained as a missing one.
All three applied in the next commit, 1 and 2 with regressions.
