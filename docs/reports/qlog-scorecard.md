# Query-log scorecard (DRAFT: no label is confirmed yet)

Every logged question gets one expected outcome: answer (with its source), clarify (with what is asked) or decline (with the plain reason). Labels come from written rules (scripts/draft-qlog-labels.py), never from the engine's output; this run compares the engine with them (scripts/run-qlog-scorecard.ts). The labels, with each question as written (Jeff 2026-11-04), are scripts/fixtures/answer-eval/qlog-labels.json, keyed by a hash of the normalized question; the rules are docs/reports/qlog-label-rules.md. The log copy itself stays outside the repo.

Release test6-20261031-host; run 2026-11-06. A first question is the first row of each session in each tab; a follow-up is any later row, labeled with the row before it. Distinct questions per tab (the same words counted once; "times" in the label file says how often each was asked).

**Label status: 0 confirmed, 3179 reviewed (two labelers agree: the rules and an independent second labeler), 745 draft (a second-labeler correction, or a rule label not yet reviewed).** No label is confirmed, so this is still a draft scorecard: a miss here is a candidate, not a finding.

**Unverified is not correct.** An answer from the right source counts as correct only once its numbers match independent values (nibrs-model's files, or SQL against the source build); until then it is unverified.

| Source | Labels scored | Correct | Unverified | Wrong answer | Bad decline | Wrong clarify | Follow-up error | Error | Reviewed labels | Draft labels | Disputed (not scored) | Not run yet |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Historical | 1014 | 535 | 7 | 0 | 253 | 93 | 126 | 0 | 854 | 160 | 4 | 0 |
| Current Trends | 1022 | 572 | 4 | 0 | 214 | 122 | 110 | 0 | 800 | 222 | 5 | 0 |
| NIBRS | 1241 | 657 | 6 | 0 | 268 | 146 | 164 | 0 | 1007 | 234 | 4 | 0 |
| Homicide Reports | 580 | 315 | 15 | 0 | 144 | 40 | 66 | 0 | 454 | 126 | 3 | 0 |
| Hate Crime | 67 | 18 | 0 | 0 | 17 | 6 | 26 | 0 | 64 | 3 | 1 | 0 |
| **All** | **3924** | **2097** | **32** | **0** | **896** | **407** | **492** | **0** | **3179** | **745** | **17** | **0** |

Hard gate, wrong answers = 0 (undisputed labels): **met**.

**Disputed: 17 labels wait on Jeff and are set aside** (not in any bucket or the gate): second labeler unclear 17. The questions are in docs/reports/qlog-label-rules.md.

Buckets: *correct* the outcome the label expects; *unverified* the right source, numbers not yet checked against independent values (or routed to a source this engine does not run yet); a right-source answer whose every number matched independent values (qlog-verified.json) is *correct*; *wrong answer* an answer where a clarify or decline is expected, or an answer from the wrong source (numbers found to differ from independent values are reported as each verification batch finds them; a verified answer whose numbers change goes back to *unverified*); *bad decline* a decline where an answer or a clarify is expected; *wrong clarify* a clarify where an answer or decline is expected, or about another part; *follow-up error* any miss on a follow-up turn; *error* the engine failed.
