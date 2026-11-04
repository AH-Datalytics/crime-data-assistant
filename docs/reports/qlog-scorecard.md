# Query-log scorecard (DRAFT: every label is a draft)

Every logged question gets one expected outcome: answer (with its source), clarify (with what is asked) or decline (with the plain reason). Labels come from written rules (scripts/draft-qlog-labels.py), never from the engine's output; this run compares the engine with them (scripts/run-qlog-scorecard.ts). The labels, with each question as written (Jeff 2026-11-04), are scripts/fixtures/answer-eval/qlog-labels.json, keyed by a hash of the normalized question; the rules are docs/reports/qlog-label-rules.md. The log copy itself stays outside the repo.

Release test6-20261031-host; run 2026-11-04. A first question is the first row of each session in each tab; a follow-up is any later row, labeled with the row before it. Distinct questions per tab (the same words counted once; "times" in the label file says how often each was asked).

**Label status: 0 confirmed, 3943 draft.** This is a draft scorecard: a draft label can itself be wrong, so a miss here is a candidate, not a finding.

**Unverified is not correct.** An answer from the right source counts as correct only once its numbers match independent values (nibrs-model's files, or SQL against the source build); until then it is unverified.

| Source | Labels scored | Correct | Unverified | Wrong answer | Bad decline | Wrong clarify | Follow-up error | Error | Draft labels | Disputed (not scored) | Not run yet |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Historical | 1020 | 227 | 228 | 1 | 319 | 90 | 155 | 0 | 1020 | 0 | 0 |
| Current Trends | 1027 | 283 | 181 | 0 | 283 | 125 | 155 | 0 | 1027 | 0 | 0 |
| NIBRS | 1245 | 459 | 142 | 2 | 336 | 127 | 178 | 1 | 1245 | 0 | 0 |
| Homicide Reports | 583 | 192 | 73 | 0 | 198 | 25 | 95 | 0 | 583 | 0 | 0 |
| Hate Crime | 68 | 16 | 1 | 0 | 18 | 6 | 27 | 0 | 68 | 0 | 0 |
| **All** | **3943** | **1177** | **625** | **3** | **1154** | **373** | **610** | **1** | **3943** | **0** | **0** |

Hard gate, wrong answers = 0 (undisputed labels): **NOT met: 3 wrong answers**.

**Disputed: 0 labels wait on Jeff and are set aside** (not in any bucket or the gate): . The questions are in docs/reports/qlog-label-rules.md.

Buckets: *correct* the outcome the label expects; *unverified* the right source, numbers not yet checked (or routed to a source this engine does not run yet); *wrong answer* an answer where a clarify or decline is expected, an answer from the wrong source, or numbers that differ; *bad decline* a decline where an answer or a clarify is expected; *wrong clarify* a clarify where an answer or decline is expected, or about another part; *follow-up error* any miss on a follow-up turn; *error* the engine failed.
