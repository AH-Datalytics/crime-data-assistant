# Query-log scorecard (DRAFT: no label is confirmed yet)

Every logged question gets one expected outcome: answer (with its source), clarify (with what is asked) or decline (with the plain reason). Labels come from written rules (scripts/draft-qlog-labels.py), never from the engine's output; this run compares the engine with them (scripts/run-qlog-scorecard.ts). The labels, with each question as written (Jeff 2026-11-04), are scripts/fixtures/answer-eval/qlog-labels.json, keyed by a hash of the normalized question; the rules are docs/reports/qlog-label-rules.md. The log copy itself stays outside the repo.

Release test6-20261031-host; run 2026-11-04. A first question is the first row of each session in each tab; a follow-up is any later row, labeled with the row before it. Distinct questions per tab (the same words counted once; "times" in the label file says how often each was asked).

**Label status: 0 confirmed, 3177 reviewed (two labelers agree: the rules and an independent second labeler), 747 draft (a second-labeler correction, or a rule label not yet reviewed).** No label is confirmed, so this is still a draft scorecard: a miss here is a candidate, not a finding.

**Unverified is not correct.** An answer from the right source counts as correct only once its numbers match independent values (nibrs-model's files, or SQL against the source build); until then it is unverified.

| Source | Labels scored | Correct | Unverified | Wrong answer | Bad decline | Wrong clarify | Follow-up error | Error | Reviewed labels | Draft labels | Disputed (not scored) | Not run yet |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Historical | 1014 | 249 | 228 | 1 | 307 | 85 | 144 | 0 | 854 | 160 | 4 | 0 |
| Current Trends | 1022 | 316 | 187 | 0 | 265 | 112 | 142 | 0 | 799 | 223 | 5 | 0 |
| NIBRS | 1241 | 472 | 141 | 2 | 304 | 140 | 179 | 3 | 1006 | 235 | 4 | 0 |
| Homicide Reports | 580 | 196 | 82 | 0 | 173 | 38 | 91 | 0 | 454 | 126 | 3 | 0 |
| Hate Crime | 67 | 17 | 1 | 0 | 18 | 5 | 26 | 0 | 64 | 3 | 1 | 0 |
| **All** | **3924** | **1250** | **639** | **3** | **1067** | **380** | **582** | **3** | **3177** | **747** | **17** | **0** |

Hard gate, wrong answers = 0 (undisputed labels): **NOT met: 3 wrong answers**.

**Disputed: 17 labels wait on Jeff and are set aside** (not in any bucket or the gate): second labeler unclear 17. The questions are in docs/reports/qlog-label-rules.md.

Buckets: *correct* the outcome the label expects; *unverified* the right source, numbers not yet checked (or routed to a source this engine does not run yet); *wrong answer* an answer where a clarify or decline is expected, an answer from the wrong source, or numbers that differ; *bad decline* a decline where an answer or a clarify is expected; *wrong clarify* a clarify where an answer or decline is expected, or about another part; *follow-up error* any miss on a follow-up turn; *error* the engine failed.
