**Labels of the 17 fresh held-out cases LS-317..LS-333, before the build** (Codex one-pass reviews, read-only).

Review 1 (LS-317..LS-327, `1c4d5d6`): **ACCEPT all 11.** Shoplifting and carjacking are NIBRS details (P01); offenses (D18);
rates over the FBI agency population of the data year, no month weighting (P58 supersedes P15's weighting language);
LS-322 January-September 2026 with the 2025 population carried forward (P52, P59); LS-323 an answer giving no rate
(P58); rankings of Texas, Ohio and Colorado city agencies, full-year reporters (P04), ties alphabetical (P17), 20 by
default (D05), large = 250,000+ (P08), known zeros rank (P51). Coverage to add: duplicate members in a combined total;
combined totals and rates with a gap; separate and combined rates; missing and zero populations (compiler fixtures);
the include-incomplete button's result; a current-year ranking.

Review 2 (LS-328..LS-333, `befc849`): **ACCEPT LS-328..LS-332; FIX LS-333**. Its required "offers a button to include
them" pinned an undecided behavior.

Jeff then decided (P60, 2026-10-30, "That way is better"): rank only full-year reporters, name those left out with
their months, no include button, no partial list. The five ranking labels (LS-324..LS-327, LS-333) were rewritten to
P60 (`c62097f`).

Review 3 (the five P60 statements): **ACCEPT all five; LS-333's FIX resolved.**

Not cases: missing and zero populations become offline compiler fixtures in the build; the include button no longer
exists (P60). All 17 labels frozen, reviewed by `codex:inc4-labels-1`.
