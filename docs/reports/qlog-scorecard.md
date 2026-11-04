# Query-log scorecard (DRAFT: every label is a draft)

Every logged question gets one expected outcome: answer (with its source), clarify (with what is asked) or decline (with the plain reason). Labels come from written rules (scripts/draft-qlog-labels.py), never from the engine's output; this run compares the engine with them (scripts/run-qlog-scorecard.ts). The labels, with each question as written (Jeff 2026-11-04), are scripts/fixtures/answer-eval/qlog-labels.json, keyed by a hash of the normalized question; the rules are docs/reports/qlog-label-rules.md. The log copy itself stays outside the repo.

Release test6-20261031-host; run 2026-11-04. A first question is the first row of each session in each tab; a follow-up is any later row, labeled with the row before it. Distinct questions per tab (the same words counted once; "times" in the label file says how often each was asked).

**Label status: 0 confirmed, 3453 draft.** This is a draft scorecard: a draft label can itself be wrong, so a miss here is a candidate, not a finding.

**Unverified is not correct.** An answer from the right source counts as correct only once its numbers match independent values (nibrs-model's files, or SQL against the source build); until then it is unverified.

| Source | Labels scored | Correct | Unverified | Wrong answer | Bad decline | Wrong clarify | Follow-up error | Error | Draft labels | Disputed (not scored) | Not run yet |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Historical | 895 | 227 | 182 | 1 | 267 | 81 | 137 | 0 | 895 | 194 | 0 |
| Current Trends | 877 | 283 | 99 | 0 | 252 | 99 | 144 | 0 | 877 | 235 | 0 |
| NIBRS | 1151 | 459 | 129 | 2 | 306 | 91 | 163 | 1 | 1151 | 267 | 0 |
| Homicide Reports | 465 | 192 | 27 | 0 | 165 | 19 | 62 | 0 | 465 | 205 | 0 |
| Hate Crime | 65 | 16 | 1 | 0 | 17 | 5 | 26 | 0 | 65 | 14 | 0 |
| **All** | **3453** | **1177** | **438** | **3** | **1007** | **295** | **532** | **1** | **3453** | **915** | **0** |

Hard gate, wrong answers = 0 (undisputed labels): **NOT met: 3 wrong answers**.

**Disputed: 915 labels wait on Jeff and are set aside** (not in any bucket or the gate): D5 371, D1 17, D3 76, D4 451. The questions are in docs/reports/qlog-label-rules.md.

Buckets: *correct* the outcome the label expects; *unverified* the right source, numbers not yet checked (or routed to a source this engine does not run yet); *wrong answer* an answer where a clarify or decline is expected, an answer from the wrong source, or numbers that differ; *bad decline* a decline where an answer or a clarify is expected; *wrong clarify* a clarify where an answer or decline is expected, or about another part; *follow-up error* any miss on a follow-up turn; *error* the engine failed.
