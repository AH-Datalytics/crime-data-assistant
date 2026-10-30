# Codex review 02: the increment-4 build, full review (REVISE)

Branch nibrs-engine/compiler-increment-4 at 2298249 (merged with dev at 3cf2c48). Reviewed 2026-10-30. Codex ran
test-nibrs-shadow, test-nibrs-compile and test-nibrs-transforms (all pass), then read-only probes on the offline stubs
that reproduced each finding. Nothing edited; no scored runs, builds or servers.

Verdict: REVISE. The numeric evidence (LS-317..LS-333 against V84-V99) stays valid for the cases it covers.

1. P1, places-answer.ts:36: a set of years becomes a continuous range. "Shoplifting rate in Wichita in 2019 and 2023"
   gives five rows (2019-2023). Carry the selected years through execution and delivery.
2. P1, places-answer.ts:70: rankings bypass the D6 EVIDENCE_CONFLICT refusal; a conflicted month reads as a month not
   reported and changes the ranking. Refuse conflicts in rankings too.
3. P2, answer.ts:237: after agency dedupe, dropping the geo.place grouping shifts the time grouping without its
   binding ("Tulsa Police Department and Tulsa by month in 2023" declines with A2). Remap grouping bindings too.
4. P2, reading.ts:206: "combined" is stripped whatever it modifies; "Shoplifting and carjackings combined in Detroit"
   answers two separate counts with no combined total or explanation. Keep it unless it combines places, or decline.
5. P2, shadow.ts:327: the combined-total statement check accepts any number; a headline of 999 over a table of 120
   scores correct. Compare the prose number with the table.
6. P2, shadow.ts:358: removing every "Not ranked" line still scores correct (every() on an empty list). Check the
   required exclusions, their month counts and the count-plus-five-largest rule against the evidence.
7. P2, compare.ts:149: fbiNameFor strips agency-type words, so "Wichita Sheriff Office" matches the Wichita Police
   Department. Allow only the police-name variants, never across agency types.
8. P2, places-answer.ts:161 (and the combined branch, 147): a missing population is explained as months not known.
   Tell UNAVAILABLE (no population) apart from UNKNOWN (months).

Each needs a focused offline regression.
