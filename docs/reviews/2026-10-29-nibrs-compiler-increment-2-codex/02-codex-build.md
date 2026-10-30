**Verdict: REVISE.** (Codex full review of the build, `0d871ea..021feab`, read-only.) Summary of the required fixes and
how each was applied in `b72bb1c`:

| # | Finding (Codex) | Applied |
|---|---|---|
| 1 | P1 counting: `key_occurrence` used as an incident-wide join key; the canonical build numbers lines within one segment family (nibrs-model BUILD-RULES T1). Fixture: two offender lines sharing sequence `##` (occurrences 1, 2; M, F) under one robbery: offenders counted 1 (should be 2); robbery by offender sex M only. Same assumption in the victim weapon filter. | `sameIncident` is the incident's keys only; `key_occurrence` joins only a parent to its own children (offense -> weapons; victim -> connected offenses, relationships). The victim weapon filter takes any segment of the connecting code in the incident. The compile gate's synthetic build now holds Codex's fixture (offenders sharing a sequence: 2; robbery by offender sex: M 1, F 1; victim whose line occurrence differs from its offense's: counted). |
| 2 | P1 meaning: P49 rewrite deleted every victim-sex filter ("Female simple assault victims by men and women"). | Only the sex filters bound to parts inside the "by men and women" words are removed; a filter those words share with another part declines ("victims restricted by sex beside the offenders' sexes"). BY_SEXES requires one male and one female word. |
| 3 | P1 meaning: D19 applied only when drug crimes were the sole measure ("Drug crimes and shoplifting"). | Drug crimes beside other crimes are declined. |
| 4 | P1 meaning: composites absorbed a separately asked crime ("Gun crimes and murders"). | A composite requires exactly its own measure parts; otherwise declined. |
| 5 | P2: weapon selections other than firearm/knife vanished from the answer's words ("Robberies with a handgun"). | `filterWords` names every weapon and relationship code ("with a weapon recorded as Handgun"); any such restriction it cannot name is declined before running. |
| 6 | P1 measurement: committed adapter could not read the new category fields; overlapping categories must not be summed into a denominator. | Committed in `92d3a41` (fields from the file's `category`, code aliases, no summing for multi-valued fields), tested. |
| 7 | P1 measurement: the combined-total check accepted 210 for 21 (substring). | The "Together:" sentence is parsed: exact number equal to the sum of the table's counts, under the total's own name. Tested with a 2520-for-252 mutation. |

Optional, also applied: "people were charged for" now drops in the arrests alternative (COURT_TEXT gains people, for).
Deferred as Codex advised: two-way breakdowns (LS-282, LS-294), older reader declines (LS-266, LS-268, LS-269).

Codex's other conclusions (no change needed): multi-valued counting by distinct unit per category with a distinct-unit
denominator; segment identity kept in DISTINCT offense units; age codes per LS-288; offender 00; arrests by arrest
date, all years, arrest-month status; D6 per measure, combined totals withheld when a part is unknown, EVIDENCE_CONFLICT
refusing the whole answer; period merging checked; mixed time bases refused; template-only text.

After the fixes, with nibrs-model batch 5 (V50-V68, `684c274`) on its main branch: harness 0 wrong answers in every
group; every must-answer increment-2 case (LS-284..LS-293, LS-295..LS-299) and the LS-300 alternative match the
independent values; LS-301 and LS-302 decline correctly; LS-294 (two-way, conditional) declines.
