# Codex review 03: re-check of r3 (3fa9c1f)

Reviewed 2026-10-30, read-only, no network. Verdict: **REVISE** (two P2, two P3). Codex's necessity check: revise the planned-demand distinction and the below-agency action claim; disclose residual errors; no further rule repair, build or audit needed. Applied in r4.

1. **P2, planned demand mixed planned and built.** SHR 361 included 19 built relationship-route rows; Current Trends 290 included 35 built state/national-route rows. Strictly planned: 342 and 255.
   - r4: the doc gives the strictly planned counts, with the built-route rows named beside them.
2. **P2, below-agency actions incomplete.** `lookup/list` returned `answer` before the below-agency check, so seven rows kept answer beside a B-decline status.
   - r4: the below-agency check comes first in the action rules (18 rows decline; 16 carry the decline status, two are follow-ups).
3. **P3, r3 rule regressions and limitations:**
   - EDIT: axis wording alone made a standalone graph request a follow-up.
   - CAUSAL: an embedded causal part of a compound question is still missed (unchanged from r2).
   - COLLECTION: a ranking of individual incidents in named cities was labeled a set-of-cities gap.
   - SUBAGENCY: "Ward, AR" is read as a police ward.
   - MONTHLY: standalone "May" is not recognized (predates r3).
   - NIBRS_DETAIL: a calculation example with "value" goes to increment 9; victim-demographic rows get a built status.
   - STATECLR: applied to an exceptional-clearance share and to county rates within a state.
   - METRO: bare "New Orleans metro" now reads as the city.
   - r4: disclosed in the doc's limits, as Codex advised; no rule pass.
4. **P3, a fresh audit** (seed random.Random(2026103091), 50 distinct rows): shape 43/50, source 45/50, action 46/50, status bucket 42/50, full status 39/50.
   - r4: added to the doc's accuracy section, with bucket and full status kept apart.

**Review 02's findings:** 1, 2, 6 and 8 closed; 7 closed for the metro rows; 3 and 4 partly closed (the over-declines and the demand mix, handled above); 5 closed in the held-out table.

**Reconciliation:** no table-cell, row, source or headline discrepancy (4,533 = B 845 + P 3,177 + G 122 + C 389); every named group reproduced from CSV membership.

**Privacy:** no unredacted emails, phones, street addresses or identifying personal histories; the three redactions remain. Public-figure names in political questions remain, which expose no private user. No P1.
