# Codex reviews 02-03: increment 7 label re-checks

Reviewed 2026-10-31, read-only, no network.

**02: REVISE (two small findings).** Every other finding of review 01 was closed, and nothing new was wrong.
1. LS-378, LS-388 and LS-394 pointed to LS-280 for the age groups, but LS-280 defines none. Applied: they now point to LS-288, which lists the groups (Under 18 with infants, 18-24 through 65+, Unknown and Not recorded).
2. LS-396 did not name the pairing P65 requires. Applied: the question is now "Aggravated assault victims of offenders who were under 18, in Memphis in 2024, by victim race".

**03: ACCEPT.** Both fixes are applied exactly, and nothing else in LS-377..LS-396 changed. The labels are frozen: status reviewed, reviewed_by codex:inc7-labels-1.

**Label correction after freezing (2026-10-31), for Codex to confirm in the next review.** LS-384 and LS-388 said offender sequence 00 is excluded. That contradicts the adopted segment convention (coverage inventory, Trap C: sequence 00 is its own category, labelled as a segment count) and the reviewed LS-293 with nibrs-model's V59, which includes it. Corrected:
- LS-388: sequence 00 is its own age category, and the answer says it counts offender records, not people.
- LS-384: the exclusion claim is dropped (a sequence 00 record has no relationship segment, so it cannot be linked).
Request 10 to nibrs-model was corrected the same day.
