**REVISE** (Codex review of the batch-6 value loading, `69a8e66..11e1ca0`), one fix:

1. The comparison value check read only row 0, so an extra wrong row with valid-looking evidence scored correct.
   Applied: a change must be exactly one row; an extra row is material. Regression test added.

Codex also found:
- V1-V68 loader output is identical before and after (all 68 files compared).
- The V69-V82 groupings follow the intended loader branches. Zero base maps to UNAVAILABLE (V76) and unknown to UNKNOWN
  (V77, V78).
- Spot-checks V70 (-357, -3.6%), V76 (0 to 6, percent unavailable) and V80 (11) match the recorded answers.
