# NIBRS replay inventory (phase 1, step 3)

Every NIBRS-tab request logged from 2026-08-29 00:00 to 2026-10-28 00:00 UTC (60 days), with the outcome and answer
recorded at the time. It is the shadow-comparison test set of the restructure plan (phase 5): each item is replayed
through the new engine and through a pinned current release, and the results compared.

| File | What |
|---|---|
| `inventory.json` | 605 items, plus `provenance` and `counts` |
| `summary.md` | outcomes, baseline availability, replay modes, tags |
| `../../build-nibrs-replay-inventory.py` | builds both from read-only exports (the queries are in its header) |

## Provenance and completeness

- Exported 2026-10-28T10:29:41Z, after the window closed; the latest record is 2026-10-27T21:36:15.493Z. The export
  query and a `COUNT(*)` over the same window both gave 605. The builder refuses an export with a record outside the
  window or tab, a duplicate id, or an extraction time before the window closed.
- Input checksums are in `provenance.input_sha256`. The inputs hold raw session ids, so they are kept outside the
  repository, at `C:\Users\jeffm\nibrs-engine-private\`; the builder reproduces both output files from them byte for
  byte.
- **Release identity is unknown per request.** Release directories on the VPS go back only to 2026-10-21, and a
  release's build time is not the time it was live (there were rollbacks, for example on 2026-10-24). The retained
  releases are listed in `provenance.retained_releases` as evidence only. Shadow differences are attributed against
  the pinned baseline that phase 5 captures (below), never against these historical observations.

## Each item

- `id`, `ts_ms`, `at`: the query_log id and time, to the millisecond.
- `origin`: `internal` for test traffic (the daily digest's internal-session rule in
  `scripts/daily-query-analysis.js`, plus the `correctness-baseline-*` (132), `presentation-study-*` (109) and
  2026-10-27 release-check (6) sessions); otherwise `unmatched`. Unmatched means "not matched by that rule", not
  verified human traffic.
- `request`: endpoint and tab, request id, routing mode, reason and confidence, query contract and guidance,
  guardrails: everything the log holds about how the request was read.
- `context`: the conversation.
  - `session_chain`: the earlier turns of the same session **run** (turns more than two hours apart start a new run,
    so a baseline session repeated weeks apart is several runs), from every tab, so cross-source history is visible
    (`prior_turns_other_tabs`). The assistant's earlier answers are not logged (`assistant_history: not_logged`).
  - `first_turn`: nothing earlier in the run.
  - `no_session` (35 requests, embedded or API): no history is known. `candidate_predecessor_id` names the previous
    sessionless request within 30 minutes; it is a candidate, not a fact.
  - `replay`: `standalone`; `replay_chain` (replay the run's turns in order in one session, so the engine sees its own
    earlier answers); or `human_review` (a likely follow-up with no session: 16 items, never replayed automatically).
- `outcome_then` and `decision_then`: the decision recorded at the time.
  - `answer_deterministic`: a typed plan over the summary tables.
  - `answer_model_sql_historical`: model-written SQL, which no longer runs (`NIBRS_MODEL_SQL_NEVER_RUNS`).
  - `decline_capability:<reason>`, `decline_data:no_rows_in_source`, `decline_source_health:<reason>`,
    `clarify:<reason>`, `operational` (an error record), `unrecorded` (no decision record).
  - These are historical. Any of them may differ on today's release, and "answered then" is not a correctness label.
- `baseline`: the answer as observed then.
  - `answer_data`: the result's columns and rows, with the chart configuration, where the chart auditor captured them
    (203 items; 3 truncated by the auditor's capture limit, flagged). `answer_data_status` is `captured`,
    `captured_truncated`, `unavailable` (an answer with rows but no captured data: 156) or `not_applicable` (no rows).
  - `row_count` is a count only; `explanation` is the answer's text; `sql` is the SQL run, `sql_truncated` marks the 4
    at the logger's 4,000-character limit; `result_digest` is empty for every item in the window.
  - Missing evidence is never read as equality: an item without answer data is compared only against the pinned
    baseline below.
- `tags`: heuristic hints for switching by capability. Hints, not judgements.

## Counts

| Outcome then | Unmatched | Internal | All |
|---|---|---|---|
| Answered, deterministic | 129 | 56 | 185 |
| Answered, model SQL (no longer runs) | 141 | 32 | 173 |
| Declined (capability, data, source health) | 73 | 150 | 223 |
| Clarified | 7 | 8 | 15 |
| Operational or unrecorded | 8 | 1 | 9 |
| **Total** | **358** | **247** | **605** |

Every outcome category in the window is present. Of the unmatched requests, 270 of 358 (75%) were answered at the
time, 129 (36%) by deterministic plans. Neither is a measurement of today's release, which phase 5 makes. The
restructure plan's "about 4 in 10 declined" counts unmatched and internal traffic together; most internal declines
are baseline questions written to probe limits. Its "352 answered (179 + 173)" was counted before the six release
checks of 2026-10-27 21:34 UTC: 185 = 179 + 6.

## What phase 5 adds

1. **A pinned baseline.** Each item is replayed (sampled or queued, never doubling production load) through the
   current release pinned by commit and data versions, capturing the full result (columns and rows), the
   explanation, the chart configuration, timing and the versions. Chains replay in order in one session;
   `human_review` items are reconstructed by a person or left out with the reason recorded.
2. **The new engine**, on the same items and chains, pinned to its canonical release and semantic version.
3. **The comparison**, reported separately as correct answers, necessary clarifications, unsupported questions,
   incorrect answers and latency, with every difference explained. Expected answers for the hand-traced questions
   come from `scripts/fixtures/nibrs-correctness/`; the rest are judged item by item. The historical observations here
   are evidence for that judgement, not the baseline.

## Privacy

The repository is private. Session ids are replaced by a salted hash prefix: pseudonymous, not anonymous (the salt is
in the builder, and internal session names are guessable). IP addresses and visitor data are not exported. The 247
internal items are test traffic, not public questions.
