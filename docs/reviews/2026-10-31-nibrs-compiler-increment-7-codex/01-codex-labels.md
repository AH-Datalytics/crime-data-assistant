# Codex review 01: increment 7 labels (LS-377..LS-392, drafted)

Reviewed 2026-10-31, read-only, no network. Verdict: **REVISE** (13 cases REVISE, 3 ACCEPT, 4 cases to add). Applied before the labels were frozen.

General: every MUST ANSWER case had a generic value reference, so none discriminated numerically. Each now states, in `expected.values.source`, the contrast its expected values must show: the request to nibrs-model and the value build verify these.

| Case | Codex | Applied |
|---|---|---|
| LS-377 offender race (aggravated assault) | REVISE: discriminate against offender counts, victim race and the pair-linked reading; dedupe within a race; unknown and not-recorded | value contract; the LS-292 unknown/not-recorded statement |
| LS-378 offender age (robbery) | REVISE: age bins in the value contract; unknown vs not recorded; contrast with offender counts | value contract (LS-280's bins); statement |
| LS-379 by juveniles | REVISE: differ from LS-380 and from pair-only filtering; several juvenile offenders don't multiply victims | value contract |
| LS-380 against juveniles | REVISE: mixed-age victims in one incident; contrast with LS-379 | value contract |
| LS-381 female victims with a firearm | REVISE: negative control, female victim and firearm offense in one incident but not linked | value contract |
| LS-382 murder victims by offender race | REVISE: name NIBRS in the question (P01); category differences from LS-383; unknown/not-recorded | "According to NIBRS," and P01; statement; value contract |
| LS-383 pair-linked | REVISE: name NIBRS (P01); keep "no relationship reported" apart from linked-but-unknown race | question, P01; statement; value contract |
| LS-384 offenders where the victim was a stranger | REVISE: stranger to an aggravated-assault victim, counted once; contrast with every offender of a qualifying incident; sequence 00 belongs in the value contract, not prose | filter and statements; value contract |
| LS-385 arrests by arrestee race | REVISE: standalone Group B scope as a statement; C/N counted, M excluded in the value contract | statements; value contract |
| LS-386 juvenile robbery arrests | REVISE: P46 statement; P68 in the value contract; unknown ages excluded; contrast with offender age and incident date | statements; value contract |
| LS-387 offender ethnicity | REVISE: unknown and not recorded separately; contrast with victim ethnicity and offender counts | statement; value contract |
| LS-388 robbery offenders by age | REVISE: bins and sequence 00 in the value contract | statements; value contract |
| LS-389 young adults | REVISE: name NIBRS so both continuations keep source nibrs | "According to NIBRS," and P01 |
| LS-390 attackers | ACCEPT | – |
| LS-391 charged | ACCEPT (optional first cut: LS-300 already covers charging) | kept |
| LS-392 state offender breakdown | ACCEPT | – |

Added (missing structural coverage):
- LS-393: arrestee ethnicity delivered.
- LS-394: arrestee age as a grouping (LS-386 tests a filter).
- LS-395: two person filters on one victim (female and under 18), with a mixed-victim negative control.
- LS-396: a victim breakdown filtered by a paired offender attribute (offender under 18, pair-linked), contrasted with incident-wide filtering.

Deferred by Codex: more P45 agent-noun and P48 wording variants.
