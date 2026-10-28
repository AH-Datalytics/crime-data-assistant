# NIBRS replay inventory, 2026-08-29 to 2026-10-27 (UTC)

605 NIBRS requests: 358 public, 247 internal (correctness and presentation baselines, release checks).

## Public requests by today's outcome

| Outcome | Requests | Follow-ups among them |
|---|---|---|
| answer_model_sql_historical | 141 | 60 |
| answer_deterministic | 129 | 4 |
| decline_capability:capability_path_unavailable | 31 | 3 |
| decline_capability:query_contract_failed | 13 | 4 |
| decline_capability:model_produced_no_sql | 10 | 4 |
| decline_data:no_rows_in_source | 10 | 4 |
| decline_capability:sql_shape_rejected | 5 | 1 |
| unrecorded | 4 | 0 |
| operational | 4 | 0 |
| clarify:geography_ambiguous | 4 | 3 |
| decline_source_health:required_component_unavailable | 4 | 0 |
| clarify:measure_ambiguous | 3 | 2 |

## Internal requests by today's outcome

Kept in the inventory: the correctness baselines are gold questions. They are reported apart from public traffic.

| Outcome | Requests |
|---|---|
| decline_capability:capability_path_unavailable | 115 |
| answer_deterministic | 56 |
| answer_model_sql_historical | 32 |
| decline_capability:query_contract_failed | 10 |
| decline_capability:model_produced_no_sql | 10 |
| decline_source_health:required_component_unavailable | 7 |
| decline_data:no_rows_in_source | 4 |
| clarify:geography_ambiguous | 4 |
| clarify:measure_ambiguous | 3 |
| decline_capability:sql_shape_rejected | 2 |
| decline_capability:guardrail_block | 2 |
| operational | 1 |
| clarify:geography_scope_ambiguous | 1 |

## Public requests by tag (heuristic) and outcome

| Tag | Requests | Answered today (deterministic) | Answered historically by model SQL | Declined or clarified |
|---|---|---|---|---|
| monthly | 64 | 38 | 13 | 13 |
| yearly_series | 95 | 46 | 30 | 19 |
| breakdown | 72 | 21 | 31 | 20 |
| two_or_more_breakdowns | 36 | 10 | 13 | 13 |
| share | 6 | 3 | 0 | 3 |
| rate | 17 | 8 | 1 | 8 |
| ranking | 9 | 5 | 2 | 2 |
| change | 4 | 2 | 2 | 0 |
| rolling | 3 | 0 | 2 | 1 |
| clearance | 28 | 16 | 2 | 10 |
| arrests | 24 | 7 | 10 | 7 |
| offenders | 43 | 10 | 22 | 11 |
| victims | 6 | 1 | 1 | 4 |
| property | 15 | 0 | 8 | 7 |
| weapon | 25 | 4 | 7 | 14 |
| national | 24 | 7 | 9 | 8 |
| cohort | 1 | 0 | 0 | 1 |
| city_size | 4 | 1 | 1 | 2 |
