**REVISE.** (Codex full review of the build, `039c772..73c6d9d`, read-only.) Two runtime defects and three scoring defects,
each reproduced. How each was applied:

| # | Finding (Codex) | Applied |
|---|---|---|
| 1 | P1: a comparison wholly after the release recursed forever ("Did shoplifting go up in Detroit in 2028?", "Change in shoplifting in Detroit from 2027 to 2028"); a forecast's trend alternative kept the comparison | A period or grain chosen by a button clears the reading's comparison and last-12 flags (`filled`). Both inputs decline outside coverage; the forecast's alternative is the last 10 years. Tested. |
| 2 | P1: the reader's own change form bypassed P01 ("Did burglaries increase in Detroit from 2022 to 2023?" answered from NIBRS) | The P01 guard covers the change form too. Tested. |
| 3 | P1 scoring: comparison periods credited without checking both ("same-months" from the earlier period alone; baselines dropped from untracked) | "same-months" only when both periods are the same months of a year. A change label implies its two periods (its period's first and last years, or the months it names), and the comparison is checked against them: a different baseline is material, unnamed months unverified. The runner test now asserts that check instead of "baselines are not in the label". Tested with Codex's mutation (earlier Jan-Mar against Jan-Jun). |
| 4 | P2 scoring: comparison prose not reconciled with the table ("999 in 2022 and 1 in 2024: a catastrophic increase" passed) | `comparisonProse`: every text line is a template, with the change line rebuilt from the cells, and the zero-base and no-change forms. Tested with Codex's mutation. |
| 5 | P2 scoring: missing-window checks passed when the missing windows were left out | The checks require every displayed month in order. Tested with Codex's mutation. |

Codex's other conclusions (no change needed): filters and the arrest-date basis kept in the monthly query; composites it
cannot compare refused; clipped comparisons matched; unknown rolling inputs never zero; separate years stay separate;
future selected years refused; the transforms' tests cover VALUE 0, unknown and conflict, zero base and rounding.

After the fixes: all offline suites pass, and the harness shows 0 wrong answers. The increment-3 values (V69-V82) are
still NOT MEASURED.
