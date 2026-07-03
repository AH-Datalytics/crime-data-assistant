# Query Audit — 24 hours ending 2026-07-03 ~13:30 UTC

> **IMPLEMENTATION STATUS (2026-07-03, same day):** All items below implemented on `dev`
> except F27's population-table idea, which Jeff rejected — replaced by a front-door refusal
> (`detectShrGroupRateOverride` + `group-rate-denominator-unavailable`; FBI data only, no Census).
> F26's data fix ran directly against prod DBs (state_population now through 2026, FBI CDE API
> source; both monthly importers patched with `.bak-20260703` backups). F23's "override fired on
> non-matching SQL" mystery resolved: prod was running June 12 code at the time — the July 2
> evening deploy already narrowed that matcher; remaining FP in `nibrs-dv-victim-count-column`
> fixed. F22 was partially fixed in prod by Codex's July 2 deploy (DV-specific rewrite); the
> general `nested-aggregation-discards-measure` guardrail now covers all tables. Full test chain
> green (284+272+33+13+197 suites), tsc clean, production build clean. Awaiting commit + deploy.

Scope: 204 logged queries; 179 were internal (live-replay scoreboard runs, codex probes, cache-TTL probes) and excluded. **25 real user queries in 2 sessions**, both with genuine failures. All findings below were verified against the live DBs before being asserted (per June-9 audit method).

## Session A — NIBRS tab, Mississippi firearm violence (ids 4586–4602, July 2, 13:49–15:17)

Sophisticated user (asked for "adjust for incomplete coverage," "continuous reporters"). The continuous-reporter feature got real production use and mostly worked. Four failures:

### F22 (HIGH) — IPV trend answer was nonsense: 1 incident/year instead of ~1M (#4587)
Question: "how have intimate partner violence cases trended in the past 5 years."
The SQL wrapped an already-grouped subquery (GROUP BY data_year, dv_category with an incident_count column) in an outer `SUM(CASE WHEN dv_category='intimate_partner' THEN 1 ELSE 0 END)` — which counts *groups*, not incidents. Verified against prod nibrs.db:

| year | value shown to user | actual IPV incidents |
|------|--------------------:|---------------------:|
| 2021 | 1 | 962,937 |
| 2022 | 1 | 1,037,519 |
| 2023 | 1 | 1,108,125 |
| 2024 | 1 | 1,151,095 |
| 2025 | 1 | 1,116,497 |

Explanation confidently said "The data contains intimate partner violence incidents by year from 2021 to 2025." No guardrail fired on the shape.

**Proposed fixes:**
1. **Guardrail `nested-aggregation-discards-measure`**: outer query aggregates over a grouped subquery but the outer aggregate is `SUM(CASE ... THEN 1 ELSE 0 END)` / `COUNT(*)` while the subquery exposes a `*_count`/`COUNT(`/`SUM(` alias that is never referenced → retry message: "aggregate the inner measure column, not 1/0."
2. Prompt example for dv_category filtering: `SELECT data_year, COUNT(DISTINCT ori||':'||data_year||':'||incident_num) FROM summary_domestic_violence WHERE dv_category='intimate_partner' GROUP BY data_year` — no nesting needed.
3. Sanity contract: a "trend of X" result where every period has an identical tiny value (all rows = 1) is a red flag worth a deterministic re-check/retry.

### F23 (MED) — Valid comparison blocked, override fired on SQL that doesn't match the matcher (#4586)
Question: "have domestic violence trends followed the same patterns as other types of violent crime in the past 5 years" → `guardrail_override:nibrs-cross-summary-join` ("I can't reliably combine data from two different summary tables…").
The *logged* final SQL was a legitimate year-grain CTE join (dv_trends by year ⋈ violent_trends by year) — exactly the shape `nibrs-cross-level-join`'s own message recommends. Two issues:
1. `hasDirectSummaryTableJoin` requires literal `JOIN summary_…` and the final SQL has none — yet the override fired. Either the override decision keyed off an earlier attempt while logging the later SQL, or a second matched guardrail (`nibrs-dv-victim-count-column` also fired) escalated to override under the first guardrail's name. **Investigate the retry/override pipeline** — the block message shown did not describe the SQL that was logged.
2. Even on a direct match, **exempt CTE-shaped joins**: if every `summary_*` table appears only inside CTEs that GROUP BY year (and optionally state), and the outer join is on those keys only, the grain-multiplication risk this guardrail exists for does not apply. This block is what pushed the user into the rephrase that produced F22's garbage.

### F24 (MED) — Geo clarifier: omits the right state and ignores explicit state context (#4596)
Question: "include the jackson police department, the hinds county sheriff, and the **mississippi** capitol police" → deterministic geo:jackson clarifier replied "Jackson exists in multiple states… Choose: Jackson, AL or CA or GA or KY or LA or MI or MN or MO." **Mississippi is not in the list** and the word "mississippi" was in the question itself; the whole conversation (and prior SQL, state='MS') was about Mississippi.
Root cause of the missing option: `actionCandidates()` in `lib/geo-resolver.ts` sorts candidates (action rank, kind rank, then **alphabetical**) and `.slice(0, 8)` — Jackson's AL/CA/GA/KY/LA/MI/MN/MO fill all 8 slots before MS.
**Proposed fixes:**
1. Skip (or auto-resolve) the clarifier when a state name/abbrev appears in the question or in the active conversation SQL context.
2. Rank city-state candidates by agency population, not alphabetically, before the slice-to-8.
3. Belt-and-suspenders: if the conversation context names a state that has a matching candidate, force-include that candidate in the choice list.

### F25 (MED) — Zero-result answers don't say *why*: Jackson PD excluded by inherited continuous-reporter filter (#4595)
"show me violent crimes involving use of a firearm for jackson mississippi by offender age" → 0 rows, generic "Try broadening your search."
Verified: Jackson PD (MS0250100) **has** the data — 311 firearm violent-crime offenders in 2025, 113 in 2026 — but only reports NIBRS from 2025. The follow-up context carried over `year BETWEEN 2019 AND 2025` **and** the `nibrs_consistent_reporters` 2019–2025 filter, which excludes any agency that joined in 2025.
**Proposed fixes:**
1. **NIBRS zero-result agency probe** (SHR already has one, `lib/shr-agency-probe.ts`): when an agency-scoped NIBRS query returns 0 rows, look up the agency's actual reporting span and answer "Jackson PD reports NIBRS only since 2025; here's 2025–2026 / the continuous-reporter filter excluded it" instead of "try broadening."
2. Consider dropping sticky coverage filters when the user pivots geography (new agency scope = re-evaluate whether the continuous-reporter constraint still makes sense; at minimum disclose it prominently — the disclosure was present but buried below "no results").

### Observation (known lever, no new fix) — latency
#4601 took 54s, #4591 29s, #4587 26s — all consistent-reporter/demographics shapes already identified in the July 2 latency diagnosis (pre-aggregate heavy shapes OFF-VPS). This session is real-user evidence for prioritizing it.

## Session B — SHR tab, murder by offender race/sex, per capita (ids 4702–4709, July 3, 07:44–08:08)

Casual user, persistent. Clarifying questions (#4702, #4704) were good. But the user never got a correct version of what they asked for.

### F26 (HIGH) — 2025/2026 rate queries return empty because state_population ends at 2024 (#4706–4708)
User asked "just 2026," then "2025," then "oki i know just make the table" — three consecutive `empty_result`s (the model re-ran byte-identical SQL on the last one). Verified: shr.db has **9,710** offender-known murder incidents in 2025 and 2,570 in 2026, but `MAX(year)` in `state_population` is **2024**, so the INNER JOIN `sp.year = oc.year` wipes everything. The F9 prompt note ("filter + disclose the 2025-26 gap") did not hold under follow-up pressure. Worse, the explanations claimed "Murder … counts and rates … for 2026/2025" over zero rows (F4-class contradiction).
**Proposed fixes (layered):**
1. **Data**: extend `state_population` through the current year (Census Vintage 2025 estimates, or carry-forward 2024 values flagged `estimated=1`) in shr.db and nibrs.db; fold into the monthly importers so it never regresses.
2. **Guardrail `population-year-out-of-range`**: SQL joins `state_population` (or any `*_population`) on a year beyond its max → rewrite to latest available year + force disclosure, or return counts with a "population data ends 2024" note. (Generalizes June's `shr-rate-bad-denominator` work.)
3. **Contradiction check**: explanation asserting "counts and rates for YEAR" when rows=0 should be caught by the result-disclosure anti-contradiction layer — extend it to zero-row + period claims.

### F27 (HIGH) — Group-specific rates computed with total-US denominator, presented as the requested answer (#4705, #4709)
In #4704 the model explicitly offered "Population by race AND sex" as a denominator option; the user chose it ("Population by race and sex and rate per 100000"). #4705 then divided every race×sex subgroup by **total US population** and the explanation said "Rates are calculated using U.S. Census population denominators" — materially misleading for the user's actual question ("how likely is this or that group to commit murder"). When pressed (#4709), the model invented `race_population`/`sex_population` tables that don't exist (correctly blocked, `shr-sum-population`), then punted to the Historical tab.
**Proposed fixes:**
1. **Data (recommended)**: add a small national `population_by_race_sex` table to shr.db (Census annual estimates by race × sex; a few hundred rows). This is demonstrated real user demand and makes the question genuinely answerable. Document it in the SHR prompt; fold into importer.
2. Until then, **guardrail**: question asks group-specific rates (race/sex/age per capita) AND SQL's denominator is total `state_population` → block-or-disclose: "this divides each group by the *total* population — group-specific population data is not available." Don't let the offer in a clarifying question (#4704) exceed what the DB can deliver — the prompt offered "Population by race AND sex" as if available.

### F28 (INFRA) — session_id is never logged for real UI traffic
Every real user query in the last 10+ days has `session_id IS NULL`; only scripts (live-replay, probes) populate it. The browser already holds a session id (captcha/daily-cap machinery in `lib/captcha.ts` keys on it) but it isn't passed through to `query_log`. This breaks per-session analytics in Daily Impact, and makes internal-vs-public separation depend on name-pattern heuristics.
**Proposed fix**: send the existing session id with each query request and write it in the query-log insert on all 4 routes. Cheap, high value for every future audit.

## Suggested priority order
1. **F26.1 + F26.2** — population-table year gap (blocks any recent-year rate question, both SHR and NIBRS at risk; data fix is small)
2. **F22** — nested-aggregation guardrail (silently wrong answers are the worst failure class)
3. **F24** — geo clarifier state-context + ranking (deterministic, small, embarrassing failure)
4. **F27** — race/sex population table + denominator guardrail
5. **F25** — NIBRS zero-result agency probe
6. **F28** — session_id logging
7. **F23** — cross-summary-join CTE exemption + override-pipeline investigation
