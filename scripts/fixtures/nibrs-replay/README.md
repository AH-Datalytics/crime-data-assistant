# NIBRS replay inventory (phase 1, step 3)

Every NIBRS-tab request in the 60 days 2026-08-29 to 2026-10-27 (UTC), with today's outcome. It is the
shadow-comparison test set of the restructure plan (phase 5): each item is replayed through the new engine and the
result compared with today's.

| File | What |
|---|---|
| `inventory.json` | 605 items: question, conversation link, today's outcome and answer, heuristic tags |
| `summary.md` | counts by outcome, follow-ups, and tags |
| `../../build-nibrs-replay-inventory.py` | builds both from a read-only query_log export (the command is in its header) |

## Each item

- `id`, `at`: query_log id and UTC time.
- `origin`: `public`, or `internal` for test traffic: the daily digest's internal-session rule
  (`scripts/daily-query-analysis.js`) plus the named sessions `correctness-baseline-*` (132), `presentation-study-*`
  (109) and the 2026-10-27 release checks (6). Internal items stay in the inventory: the correctness baselines are
  gold questions. Shadow results are reported for public and internal separately.
- `session`, `turn`, `previous_question_id`, `follow_up_likely`: the conversation, so a follow-up ("now show me
  2024") is replayed after the question it follows. Session ids are a salted hash prefix. Requests without a session
  id (35, embedded or API) are linked to the previous such request within 30 minutes. `follow_up_likely` is a
  heuristic (a leading "now", "just", "disaggregate"..., or four words or fewer).
- `outcome`: today's outcome category, from the decision record:
  - `answer_deterministic`: a typed plan over the summary tables;
  - `answer_model_sql_historical`: model-written SQL. **It no longer runs** (`NIBRS_MODEL_SQL_NEVER_RUNS`), so these
    173 (141 public) are historical evidence: replayed today they would be declined or answered differently;
  - `decline_capability:<reason>`, `decline_data:no_rows_in_source`, `decline_source_health:<reason>`;
  - `clarify:<reason>`;
  - `operational` (an error record) and `unrecorded` (no decision record).
- `today`: the decision fields, rows, timing, error, result digest, SQL and response, the baseline the new engine's
  answer is compared with.
- `tags`: heuristic hints for switching by capability (monthly, breakdown, two or more breakdowns, share, rate,
  ranking, change, rolling, clearance, arrests, offenders, victims, property, weapon, national, cohort, city size,
  explain). Hints, not judgements.

## Counts

| | Public | Internal | All |
|---|---|---|---|
| Answered, deterministic | 129 | 56 | 185 |
| Answered, model SQL (historical) | 141 | 32 | 173 |
| Declined (capability, data, source health) | 73 | 150 | 223 |
| Clarified | 7 | 8 | 15 |
| Operational or unrecorded | 8 | 1 | 9 |
| **Total** | **358** | **247** | **605** |

Every outcome category in the window is present. Public traffic is 75% answered (270 of 358) when the historical
model-SQL answers are counted, and 36% (129 of 358) on what runs today. The plan's "about 4 in 10 declined" counts
public and internal traffic together; most internal declines are baseline questions written to probe limits.

The restructure plan quoted 352 answered (179 + 173). The difference is the six release checks of 2026-10-27
21:34 UTC, logged after that count was taken: 185 = 179 + 6.

## What phase 5 adds

For each item, the new engine's outcome (answer, clarification, limitation, decline) and answer, compared with
`today`, and classified as the plan requires: correct answer, necessary clarification, unsupported question,
incorrect answer, and latency, with every difference explained. Expected results for the hand-traced questions
come from `scripts/fixtures/nibrs-correctness/`; the rest are judged item by item.

## Privacy

The questions are what the public typed on nibrsai.com; the repository is private. Session ids are hashed, IP
addresses and visitor data are not exported.
