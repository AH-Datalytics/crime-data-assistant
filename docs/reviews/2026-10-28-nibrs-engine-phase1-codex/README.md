# Codex reviews: NIBRS engine restructure, phase 1 (2026-10-27/28)

Each file is Codex's verdict text as returned (progress lines removed), read-only reviews through the Codex plugin.
Branch `nibrs-engine/phase1`.

| # | Step | Reviewed | Verdict | Applied in |
|---|---|---|---|---|
| 01 | Correctness set | 5cc8425 | ACCEPT WITH CHANGES (5) | afff57c |
| 02 | Correctness set, re-review | afff57c | **ACCEPT** | wording notes in the next commit |
| 03 | Plan language r1 | 719f991 | REVISE (10) | a1fdf1d (r2) |
| 04 | Plan language r2 | a1fdf1d | REVISE (7) | a3dc006 (r3) |
| 05 | Plan language r3 | a3dc006 | REVISE (3) | 305cb73 (r4) |
| 06 | Plan language r4 | 305cb73 | **ACCEPT** | |
| 07 | Replay inventory r1 | d3c9e4a | REVISE (5) | fb6723d (r2) |
| 08 | Replay inventory r2 | c98de70 | **ACCEPT** | |
| 09 | Semantic v1 definitions and lessons 6-8, r1 | fde64d6 | REVISE (7) | c98de70 (r2) |
| 10 | Semantic v1 definitions, r2 | c98de70 | ACCEPT WITH CHANGES (6) | e0c91ef (r3) |
| 11 | Semantic v1 definitions, r3 | e0c91ef | **ACCEPT WITH CHANGES** (1: T11 expected category) | applied in the commit that records this table; no further review required by Codex |
| 12 | Result-column rule (owner 2026-10-28), r1 | 7772e93 | REVISE (3) | 9eb003d (r2) |
| 13 | Result-column rule, r2 | 9eb003d | REVISE (1: comparison outputs) | efb313a (r3) |
| 14 | Result-column rule, r3 | efb313a | **ACCEPT** | |
| 15 | Engine step 1: adapter, draft layer, reachability, r1 | 65420ca | REVISE (7) | e79f564 (r2) |
| 16 | Engine step 1, r2 | e79f564 | REVISE (2: year-list clipping, property loss filter) | ca6dd18 (r3) |
| 17 | Engine step 1, r3 | ca6dd18 | **ACCEPT** | |
| 18 | Design note: other sources in the engine, r1 | 6023308 | REVISE (6) | d276b8f (r2) |
| 19 | Design note, r2 | d276b8f | REVISE (1: staffing's all_total prerequisite) | ec8365a (r3) |
| 20 | Design note, r3 | ec8365a | **ACCEPT** | |
| 21 | Plan language G1, G2, G5 (R6), G8: no NIBRS answer changes (289 snapshots identical) | 965ae7f | **ACCEPT** | |
| 22 | Design note: the owner's decisions (Historical scope, hate crimes source, RTCI state samples) | 5c83ff7 | **ACCEPT** | |
