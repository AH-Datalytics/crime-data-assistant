# NIBRS replay inventory, 2026-08-29 to 2026-10-28 (exclusive), UTC

605 NIBRS requests: 358 not matched by the internal-session rule, 247 internal (correctness and presentation baselines, release checks). Extracted 2026-10-28T10:29:41Z; latest record 2026-10-27T21:36:15.493Z.

## Outcomes recorded at the time

| Outcome then | Unmatched | Internal |
|---|---|---|
| answer_deterministic | 129 | 56 |
| answer_model_sql_historical | 141 | 32 |
| decline_capability:capability_path_unavailable | 31 | 115 |
| decline_capability:query_contract_failed | 13 | 10 |
| decline_capability:model_produced_no_sql | 10 | 10 |
| decline_data:no_rows_in_source | 10 | 4 |
| decline_source_health:required_component_unavailable | 4 | 7 |
| clarify:geography_ambiguous | 4 | 4 |
| decline_capability:sql_shape_rejected | 5 | 2 |
| clarify:measure_ambiguous | 3 | 3 |
| operational | 4 | 1 |
| unrecorded | 4 | 0 |
| decline_capability:guardrail_block | 0 | 2 |
| clarify:geography_scope_ambiguous | 0 | 1 |

## Baseline answer data

| Status | Requests |
|---|---|
| not_applicable | 246 |
| captured | 200 |
| unavailable | 156 |
| captured_truncated | 3 |
| sql at the logger's 4000-character limit | 4 |

## Replay mode

| Mode | Requests |
|---|---|
| replay_chain | 295 |
| standalone | 294 |
| human_review | 16 |

## Unmatched requests by tag (heuristic) and outcome then

| Tag | Requests | Answered, deterministic | Answered, model SQL | Declined or clarified | Operational or unrecorded |
|---|---|---|---|---|---|
| monthly | 64 | 38 | 13 | 13 | 0 |
| yearly_series | 95 | 46 | 30 | 15 | 4 |
| breakdown | 72 | 21 | 31 | 16 | 4 |
| two_or_more_breakdowns | 36 | 10 | 13 | 9 | 4 |
| share | 6 | 3 | 0 | 2 | 1 |
| rate | 17 | 8 | 1 | 8 | 0 |
| ranking | 9 | 5 | 2 | 2 | 0 |
| change | 4 | 2 | 2 | 0 | 0 |
| rolling | 3 | 0 | 2 | 1 | 0 |
| clearance | 28 | 16 | 2 | 10 | 0 |
| arrests | 24 | 7 | 10 | 7 | 0 |
| offenders | 43 | 10 | 22 | 7 | 4 |
| victims | 6 | 1 | 1 | 4 | 0 |
| property | 15 | 0 | 8 | 7 | 0 |
| weapon | 25 | 4 | 7 | 9 | 5 |
| national | 24 | 7 | 9 | 7 | 1 |
| cohort | 1 | 0 | 0 | 1 | 0 |
| city_size | 4 | 1 | 1 | 2 | 0 |
