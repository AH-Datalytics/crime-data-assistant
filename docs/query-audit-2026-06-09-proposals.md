# Query Audit 2026-06-09 — Findings & Proposed Solutions

Source: review of all 82 production queries logged 2026-06-09 (`/opt/nibrs/shared/query_log.db`),
with suspect results re-verified against the live databases. Raw export:
`C:\Users\jeffm\nibrs-queries-2026-06-09.json`.

Priorities: **P0** = users received wrong numbers or hard errors; **P1** = misleading/inconsistent
responses; **P2** = polish.

**Scope requirement: every fix must be applied to all data sources/tabs where the failure mode can
occur** (current, historical, nibrs, shr, hate_crime) — not only the tab where it was observed today.
Per-fix applicability:

| Fix | current | historical | nibrs | shr | hate_crime |
|---|---|---|---|---|---|
| F1 agency-identity normalization + blank-type tolerance + zero-probe | n/a (ORI-keyed) | ✅ (verify `historical_agency` dupes) | ✅ (re-verify post ORI-merge) | ✅ | ✅ (`agency_name` LIKE matching is fragile) |
| F2.1 table-allowlist + retry | ✅ | ✅ | ✅ | ✅ | ✅ |
| F2.2 tab-tagged history | ✅ all tabs (shared chat plumbing) | ✅ | ✅ | ✅ | ✅ |
| F2.3 routing nudge | ✅ | ✅ | ✅ | ✅ | ✅ |
| F3 subtype relabel guard | ✅ | ✅ (same Part-I-only limit) | n/a (has subtypes) | ✅ (e.g. "gang homicide" → circumstance availability) | ✅ (bias-motivation subtypes exist — verify) |
| F4 result-grounded explanations | ✅ shared `explain.ts` path — confirm all 5 tabs route through it | ✅ | ✅ | ✅ | ✅ |
| F5 deterministic metadata coverage | ✅ | ✅ | ✅ | ✅ | ✅ |
| F6 real per-DB cutoffs + YTD month-range stamp | ✅ | ✅ (annual: state "through 2024") | ✅ | ✅ | ✅ |
| F7 canonical offense-category sets | ✅ (already UCR-shaped — assert) | ✅ | ✅ | n/a | n/a (offense_type exists — define categories if used) |
| F8 homicide-type semantics | n/a | n/a | ✅ (09A/09B/09C same ambiguity) | ✅ | n/a |
| F9 valid rate denominators | ✅ (has agency_population) | ✅ | ✅ | ✅ (add state_population) | ✅ (no population — refuse-with-alternative) |
| F10 year lower-bound contract | ✅ | ✅ | ✅ | ✅ | ✅ |
| F11 period disclosure | ✅ | ✅ | ✅ | ✅ | ✅ |
| F12 requested-vs-returned entity diff | ✅ | ✅ | ✅ | ✅ | ✅ |
| F13 officer-involved limitation | ✅ | ✅ | ✅ | ✅ (SHR *does* have justifiable/officer circumstances — answer from data instead) | ✅ |
| F14 shared "past N years" convention | ✅ | ✅ | ✅ | ✅ | ✅ |
| F15 OR/AND paren lint | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## F1 (P0) — SHR split agency identities produced a false zero (#4121)

**Finding:** "Gun homicides in St. Louis County 2026 YTD" returned **0**. SHR `incidents` stores the
county under two identities: `ST. LOUIS COUNTY POL DEP` (598 rows, **blank** `agency_type`, includes
all 2026 rows) and `St. Louis County` (25 rows, `agency_type='County'`). The generated SQL filtered
`agency_type = 'County'`, matching neither for 2026. The explanation also hallucinated
"St. Louis County Sheriff's Office" (it's the County PD).

**Proposed fix (3 parts):**
1. **Data normalization (root cause):** add a normalization pass to the SHR import pipeline keyed on
   ORI: canonical agency name (title-case, expand `POL DEP` → `Police Department`), and backfill
   `agency_type` from the NIBRS `agencies` crosswalk where blank. One-time backfill script against
   `shr.db` + permanent step in the monthly import. Same class of fix as the 2026-05-12 ORI merge done
   for the NIBRS DB.
2. **Guardrail `shr-agency-match-fragile`:** when SQL filters `agency_type = '...'` on `incidents`,
   rewrite to `(agency_type = 'X' OR agency_type IS NULL OR agency_type = '')` (the model already does
   this ad hoc sometimes — make it deterministic) — or drop the predicate entirely once (1) lands.
3. **Zero-result agency probe:** when an agency-filtered query returns 0 (or a single 0-count row),
   run a cheap probe (`SELECT COUNT(*) FROM incidents WHERE agency LIKE '%<name>%'` without the other
   filters) and, if the probe finds rows, append a deterministic caveat: "Note: the agency filter may
   not have matched — records exist under similar names." Extend `lib/all-null-detection.ts`, which
   already implements the adjacent pattern.

---

## F2 (P0) — Wrong tab + cross-tab schema contamination (#4095)

**Finding:** "show crime in Pennsylvania" on the NIBRS tab (a) should have been answered by
Historical or Current — generic state-level Part-I trend is their core competency — and (b) the model
generated SQL against `agency_monthly` (a Current Trends table; the user had just asked the same
question on the Current tab), causing a raw `no such table` error with an empty response. No
guardrail or retry fired.

**Proposed fix (3 parts):**
1. **Table-allowlist guardrail (catches the whole failure class):** post-generation, parse
   identifiers after `FROM`/`JOIN` and validate against the active tab's table list (already
   enumerable from `lib/claude-schema.ts` / `lib/dynamic-facts.ts`). On unknown table → one retry with
   a corrective system note ("`agency_monthly` does not exist in this database; available tables:
   …"). On second failure → friendly redirect message, never a raw DB error.
2. **Tab-aware history:** conversation history crossing tabs is what planted `agency_monthly` in the
   NIBRS context. Tag each history exchange with its tab and either exclude other-tab exchanges from
   the prompt or wrap them: "(asked on a different dataset — its tables do not exist here)".
3. **Routing nudge:** `lib/tab-suggest.ts` (capability router, no AI) should score generic
   "crime in {state}" intents as historical-primary / current-secondary. When the active tab's score
   is far below the best tab's, show the existing tab-suggestion affordance before/alongside the
   answer so the user lands on Historical instead of NIBRS.

---

## F3 (P1) — Offense subtype silently relabeled (#4086)

**Finding:** "larceny from auto" in Edmond, OK on Current Trends ran `offense = 'Theft'` (all
larceny) and the response called it "Larceny from auto counts". Current Trends has no theft subtypes.
(The NIBRS tab handled the same question correctly with code 23F.)

**Proposed fix:** prompt rule + guardrail `current-offense-subtype`: when the question contains a
subtype phrase (larceny from auto / theft from vehicle / shoplifting / pickpocketing / purse
snatching…) and the tab is current/historical, the answer must state that only the parent Part-I
category exists, label results as total theft, and link the NIBRS tab. Deterministic check: subtype
keyword in question + `offense = 'Theft'` in SQL → force the caveat into the explanation (don't trust
the model to remember).

---

## F4 (P1) — Explanation contradicts the result (#4056, #4105, #4121-name)

**Finding:** three explanation-stage failures: (a) #4056 described the *missing* states (AK/DE/ME/WV)
as "data contains crime metrics for agencies in…" — inverted meaning; (b) #4105 said "at the national
level" for a query returning 1,275 state-grouped rows, and never answered the actual question ("can I
download this?"); (c) #4121 invented "Sheriff's Office".

**Proposed fix:** ground `lib/explain.ts` harder in result facts it already partially extracts:
1. Pass the **grouping dimension** explicitly ("rows are grouped by `state` — 51 distinct values") and
   forbid scope words (`national`, `statewide`, `citywide`) that contradict it (post-check: if
   explanation says "national" but a state/city column has >1 distinct value, regenerate or strip).
2. Pass **query semantics** for set operations: if SQL contains `EXCEPT`/`NOT IN` over a roster, tell
   the explainer "these rows are the items NOT present in the data". (The deterministic
   `lib/metadata-coverage.ts` path now answers the states question correctly — keep broadening its
   trigger patterns so the LLM path is bypassed entirely; see F5.)
3. Tell the explainer the UI has a **Download CSV** button so "can I download…" questions get a
   direct yes + pointer.
4. Never emit proper-noun agency descriptors (e.g. "Sheriff's Office") unless the string appears in
   result rows or the question — extend the existing "Entities in results" rule to cover agency-type
   descriptors.

---

## F5 (P1) — False refusals (#4052, #4055)

**Finding:** (a) "split it out by state" after a national rolling-12-month murder chart was refused
with a bogus rationale; `state_monthly` exists and
`SUM(count) OVER (PARTITION BY state ORDER BY year, month ROWS 11 PRECEDING)` answers it directly.
(b) "what states are not represented?" was refused, then answered correctly when the user pushed back.

**Proposed fix:** (a) add a few-shot example to the Current Trends prompt showing per-state rolling
windows via `PARTITION BY state` on `state_monthly`. (b) the deterministic `metadata-coverage` path
already handles missing-states (fired in 3 ms at 14:23) — broaden trigger regexes (e.g. "which states
are(n't)? (in|covered|included)") and confirm it intercepts on **all tabs** before the LLM. Add both
of these queries to the eval set so refusal regressions are caught.

---

## F6 (P0) — Stale "year-to-date" cutoffs (#4117, #4119–#4121)

**Finding:** all YTD queries filtered `month <= 4`. Root cause: `computeDataCutoff()` in
`lib/dynamic-facts.ts` returns *calendar month − 2* (June → April) instead of the actual DB cutoff.
Reality on 2026-06-09: Current Trends has 2026 data **through March**; SHR has **through May**. So
Current YTD answers implied more coverage than exists, and SHR YTD answers silently dropped May.

**Proposed fix:**
1. Replace the calendar heuristic with **actual per-DB cutoffs** computed at startup:
   `SELECT MAX(month) FROM agency_monthly WHERE year = (SELECT MAX(year) …)` for RTCI; same shape for
   SHR `incidents` and the NIBRS summary tables. Inject "data complete through {Month Year}" into each
   tab's prompt. (`dynamic-facts` is cached at module load and the deploy restarts pm2, so freshness
   tracks imports.)
2. **Deterministic month-range stamp:** when the question matches YTD/"so far"/"this year", append the
   actual returned range to the explanation from result rows ("January–March 2026") in post-processing
   — never bare "year-to-date".

---

## F7 (P1) — "Violent/property crime" definitions undisclosed & inconsistent (#4081/#4082, #4126)

**Finding:** NIBRS "violent crime" used crimes-against-persons (includes simple assault, intimidation,
justifiable homicide; **excludes robbery**); NIBRS "property crime" included robbery, fraud,
vandalism, bribery. Both diverge from the UCR index definitions implied by the other tabs, and the
explanations never said what was included — the same user got incomparable numbers across tabs.

**Proposed fix:** define canonical code sets in `lib/nibrs-codes.ts`:
`VIOLENT_UCR = ['09A','11A','11B','11C','120','13A']`, `PROPERTY_UCR = ['200','220','23A'–'23H','240','510'?]`
(decide exact membership once, document it). Prompt rule: bare "violent crime"/"property crime" → use
the UCR-aligned set; NIBRS taxonomy ("crimes against persons/property") only when the user asks for it,
and always enumerate included offenses in the explanation. Guardrail `nibrs-offense-category-drift`:
question says "violent" + SQL code list contains 13B/13C or omits 120 → auto-rewrite to canonical set
and note the change (same pattern for property + fraud/vandalism codes).

---

## F8 (P1) — SHR homicide-type guardrail fires inconsistently (#4107/#4108 vs #4110)

**Finding:** three phrasings of "how many homicides in PA in 2023": two counted **all** homicide types
(murder + negligent manslaughter + justifiable), one was guardrail-corrected to Murder only. Same
question family, different denominators, no disclosure.

**Proposed fix:** broaden `shr-homicide-type-missing` to fire on any `incidents` count where the
question says homicide/murder and SQL lacks a `homicide_type` predicate — regardless of
"victims"/"offenses"/"reported" phrasing. Pick the canonical semantics once (suggest: Murder, matching
RTCI convention) and have every SHR explanation state which types are included.

---

## F9 (P1) — Statistically invalid SHR rate (#4114)

**Finding:** "firearm homicide rate in PA" used `COUNT(*) / AVG(i.population)` — the average of
per-agency populations across incident rows. Caveated, but the number is meaningless.

**Proposed fix:** add a small `state_population(state, year, population)` reference table to `shr.db`
(Census annual estimates 1976–present; a few thousand rows) + a prompt example for rate questions.
Guardrail `shr-rate-bad-denominator`: rate expression using `incidents.population` → rewrite to join
`state_population`; if geography is sub-state (agency-level), refuse-with-alternative (counts +
pointer) instead of emitting a fake rate.

---

## F10 (P2) — Missing lower-bound year filter (#4069)

**Finding:** "auto thefts in Chicago from 2019 to present" had no `year >= 2019`; returned 2017+
but the response said "from 2019".

**Proposed fix:** extend the existing query-contract check (`contract-year-range-missing`, currently
current/historical) to also assert the **lower bound**: when the question names a start year and the
SQL has no matching `>=`/`BETWEEN`, inject the predicate (auto-fix). Enable for all tabs.

---

## F11 (P2) — Silent time filters (#4092)

**Finding:** "DUI arrests by age group nationally" silently added `year >= 2022`; the response never
mentioned a period.

**Proposed fix:** deterministic post-processing in `explain.ts`: extract the year predicate from the
SQL (or min/max year from result rows for non-year-grouped results) and append "Period: 2022–2026"
when the explanation lacks a year mention. No model involvement.

---

## F12 (P1) — Partial entity coverage not disclosed (#4126)

**Finding:** user asked for 6 Texas cities; NIBRS returned 3 (Jersey Village, West University Place,
Memorial Villages absent) and the explanation listed only the 3 present without saying anything was
missing.

**Proposed fix:** the guardrail layer already extracts requested entity lists
(`lib/query-context.ts`). After execution, diff requested entities vs. distinct entities in result
rows; if any are missing, append a deterministic note: "No data found for: X, Y, Z — these agencies
may not report to this program." Generalize to states and agencies; reuse the F1 probe machinery.

---

## F13 (P2) — "Police-involved DV" misread as all DV (#4065)

**Finding:** "police involved domestic violence incidents in Chicago 2024" was answered with **all**
DV incidents, and the explanation parroted "police-involved domestic violence incidents" back.

**Proposed fix:** NIBRS prompt note: NIBRS has no officer-as-offender flag; "police-/officer-involved"
questions must get a limitation statement, with overall DV offered as the fallback (clearly labeled).
Trigger-phrase guardrail forces the caveat into the explanation.

---

## F14 (P2) — "Past N years" resolved differently per tab (#4077 vs #4078)

**Finding:** "past 5 years" → 2021–2025 on Current, 2022–2026 on NIBRS, back-to-back.

**Proposed fix:** one shared convention sentence in all four prompts (suggest: last N complete
calendar years, plus current partial year only if the user says "including this year"), sourced from a
single shared prompt snippet so it can't drift.

---

## F15 (P2, latent) — OR/AND precedence in generated WHERE clauses (#4083)

**Finding:** `WHERE (A) OR (B) AND offense IN (…)` — precedence bug. Verified **harmless today**
(`agency_monthly` only contains the 7 Part-I offenses), but the pattern will silently corrupt results
on tables where the trailing predicate matters.

**Proposed fix:** cheap lint in `lib/sql-guardrails.ts`: top-level `OR` adjacent to `AND` without
enclosing parentheses → wrap the OR-group (auto-fix) and log the guardrail. Low effort, prevents a
nasty future class.

---

## Suggested sequencing

| Wave | Items | Rationale |
|---|---|---|
| 1 | F6, F2.1, F1.2+F1.3, F4 | Deterministic, small, kill today's P0s (wrong numbers, raw errors, inverted explanations) |
| 2 | F1.1, F7, F8, F9, F12 | Data/definition work — needs one decision each, then mechanical |
| 3 | F2.2, F2.3, F3, F5, F10, F11, F13, F14, F15 | Prompt + lint polish |

All new guardrails should land with cases in the eval set (`scripts/eval-nibrs-canary.ts` /
`scripts/test-router.ts`) using today's failing queries verbatim.

---

## Implementation status (updated 2026-06-10)

Codex implemented Wave 1 on 2026-06-10 — see `docs/query-audit-2026-06-10-codex-fixes.md` for
files, rationale, and verification commands. Status by finding:

| Finding | Status | Notes |
|---|---|---|
| F6 real per-DB cutoffs | ✅ Done | Went further than proposed: the Current/NIBRS/SHR prompts each had their own inline "calendar − 2 months" cutoff, all replaced. Calendar heuristic kept only as fallback when DB probing fails. |
| F2.1 table allowlist + retry | ✅ Done | New `lib/table-allowlist.ts`, wired into all 4 query routes; handles CTE names; retry-once then friendly tab-specific failure. Test: `scripts/test-table-allowlist.ts`. |
| F11 + F6.2 period disclosure / YTD month-range stamp | ✅ Done | New `lib/result-disclosure.ts` applied at the **route** level (not `explain.ts`) because SHR/Hate Crime mostly return pre-query explanations. Test: `scripts/test-result-disclosure.ts`. |
| F1 SHR agency normalization | ⏳ Open | Codex pushback accepted: must be ORI/canonical-name based; blanket `agency_type OR blank` rewrite rejected because county semantics differ from city matching. |
| F2.2 tab-tagged history | ⏳ Open | Needs `WorkspaceChatV2` history entries + API history mapping to carry source metadata. |
| F7 canonical violent/property sets | ⏳ Open | Must replace prompt literals AND guardrail literals, not just add constants. |
| F9 SHR state-population rates | ⏳ Open | Needs reference table + prompt/guardrail refusal-path updates. |
| F15 OR/AND precedence lint | ✅ Done (Wave 2) | Shared guardrail in `lib/guardrails.ts`; regression cases in `scripts/test-new-guardrails.ts`. |
| F10 lower-bound year contract | ✅ Done (Wave 2) | `lib/guardrails.ts`. |
| F8 SHR homicide_type enforcement | ✅ Done (Wave 2) | Tightened to fire regardless of victims/offenses/reported phrasing. |
| F3 theft-subtype relabel guard | ✅ Done (Wave 2) | Current/Historical guard + deterministic final caveat in `lib/result-disclosure.ts`. |
| F2.2 tab-tagged history | ✅ Done (Wave 3) | `lib/chat-history.ts` + `WorkspaceChatV2` + all 4 routes filter history to the active source. |
| F16 anaphoric follow-ups | ✅ Done (Wave 3) | `isFollowUp()` now detects "show this from 2019…" / "can you show me the rate". Router golden cases added. |
| F13 officer-involved limitation | ✅ Done (Wave 3) | Hard override in `lib/guardrails.ts`; killed-by-police justifiable homicide stays answerable. |
| F14 "past N years" convention | ✅ Done (Wave 3) | `lib/time-conventions.ts`, wired into prompts, router, NIBRS retry, guardrails. **Caused a router regression** (see note below) — fixed same day. |
| F12 requested-vs-returned entities | ✅ Done (Wave 2) | `lib/result-disclosure.ts` appends "No data found for: …". |
| F7 canonical violent/property sets | ✅ Done (Wave 2) | `lib/nibrs-codes.ts`: violent = 09A,11A,11B,11C,120,13A; property = 200,220,23A–H,240. Prompt + guardrail + disclosure. |
| F8 NIBRS homicide codes | ✅ Done (Wave 2) | Bare "murder/homicide" → 09A only; 09B/09C require explicit ask. |
| F1 zero-result probe (mitigation) | ✅ Done (Wave 2) | `lib/shr-agency-probe.ts` — relaxed-token probe + caveat on zero results. |
| F1 agency normalization (full) | ✅ Done (Wave 6) | `lib/shr-agency-normalization.ts` + `scripts/normalize-shr-agencies.ts` build `shr_agency_identity`/`shr_agency_alias` (14,323 / 16,081 rows) and backfill safe blank `agency_type` (2,648 rows); `lib/shr-claude.ts` resolves agencies by ORI through aliases. **Verified end-to-end:** St. Louis County now resolves through 2026 (type backfilled: 30/29/1 incidents 2024–26). Original #4121 nuance: the county's lone 2026 incident is firearm *Manslaughter*, so "gun homicides = 0" is now a **correct** zero, with probe/disclosure caveats explaining coverage. Minor: ORI MO09568 is a 12-incident 1976-only duplicate of MO09500 — both 1976; possible small double-count for that year only. **⚠ DEPLOY ORDER:** the table allowlist validates against live `sqlite_master`, so `scripts/normalize-shr-agencies.ts` must run against `/opt/nibrs/shr.db` BEFORE (or atomically with) deploying the new SHR prompt — otherwise all SHR agency queries fail allowlist validation. Script is light (aggregation over ~900K incidents + 16K inserts), safe to run on the VPS. Also fold into the monthly SHR importer (`/opt/nibrs/scripts/shr-auto-update.js` if still in use). |
| F9 invalid-rate guardrail (mitigation) | ✅ Done (Wave 2) | `shr-rate-bad-denominator` rejects AVG(population) aggregates, redirects to Historical. |
| F9 state_population table (full) | ✅ Done (Wave 7) | `lib/state-population.ts` + `scripts/build-shr-state-population.ts` materialize `state_population(state, state_name, year, population, source)` in shr.db from `historical_state_national` (3,460 rows, 52 entities, 1958–2024; PA 2024 = 13,078,751; US 2024 = 340,110,988). Prompt: state/national rates join `state_population`; single-agency rates keep AVG(i.population) (valid there); guardrail still hard-stops bad aggregates. **Verified end-to-end:** PA firearm murder rates 2022–24 = 6.15/5.29/3.85 per 100k (2024 dip reflects incomplete SHR reporting — standard caveat applies). Coverage gap (SHR has 2025–26 incidents, population ends 2024) is handled by prompt instruction: filter rates to years with a denominator and disclose. **Production prerequisite:** run `scripts/build-shr-state-population.ts` against `/opt/nibrs/shr.db` alongside the normalization script, before deploy. |
| F5 deterministic metadata + follow-up transforms | ✅ Done (Wave 4) | `lib/metadata-coverage.ts` (download/CSV questions, agency/city counts, coverage lists, missing-state phrasings) + `lib/followup-transform.ts` ("split it out by state/city/agency" preserves prior intent, adds PARTITION BY for windows, bypasses standalone cache — fixes #4052's false refusal). Live replay of logged refusals still open as an eval job. |
| F4 explanation contradiction checks | ✅ Done (Wave 4) | `lib/result-disclosure.ts` post-processes three row-aware contradictions: national-vs-grouped scope, ungrounded agency descriptors (invented "Sheriff's Office"), and anti-set SQL (EXCEPT/NOT IN/NOT EXISTS) where rows mean "missing" not "represented" (#4056's inversion). Lives at result-disclosure time because explanations are generated before rows are known and SHR/HC don't route through `explain.ts`. |
| F2.3 manual-source routing nudge | ✅ Done (Wave 5) | `manualSourceNudge()` in `lib/tab-suggest.ts` + one-click rerun in WorkspaceChatV2. Router suite 190/190. **Calibration note:** fires only on high-confidence routes — verified it nudges #4093 (DUI→NIBRS) and #4073 (justifiable→SHR) but NOT #4095 ("show crime in Pennsylvania" on NIBRS routes historical at *medium* confidence). Deliberate conservatism: medium-confidence nudges would nag on every legitimate cross-tab comparison, and #4095's actual harm (raw DB error) is already fixed by the table allowlist. Revisit only if generic state-crime questions on NIBRS keep showing up in audits. |

> **Regression note (2026-06-10):** F14's complete-calendar-years convention changed the router's
> `detectTimeRange` so "past N years" no longer ended at the current year, which silently removed
> the recency boost that routes such questions to Current Trends — caught by the router golden test
> ("crime trends for Fairfax County… past three years": got historical, expected current; 184/185).
> Fixed in `lib/tab-suggest.ts` `scoreDataset`: recency now accepts ranges ending at `currentYear - 1`.
> Lesson: a semantics change to a shared parser (time conventions) can alter *routing* behavior, not
> just SQL generation — golden router tests are what caught it; keep them in `npm test`.

### F16 (P1, new — found 2026-06-10 while calibrating the Daily Impact metric)

`isFollowUp()` in `lib/tab-suggest.ts` misses anaphoric follow-ups: "show this from 2019 to
present" (#4066), "show this with Los Angeles, Houston and New York" (#4068), "can you show me the
rate" (#4082) all return false. This is not just dashboard noise — the production auto-router
(WorkspaceChatV2 auto mode) uses `isFollowUp()` to decide whether to re-route, so these would be
mis-routed to a different tab mid-conversation, losing context. Proposed fix: extend `isFollowUp()`
with anaphora detection (short question + `\b(this|these|those|it)\b`, or definite-article reference
with no named entity/offense). The interim patterns added to the Daily Impact metric in
`app/api/query-log/route.ts` should migrate into `isFollowUp()` itself so router and metric agree.

**Next-audit checklist:** verify no `month <= 4`-style stale cutoffs in new queries; verify zero raw
`no such table` errors; verify explanations state periods; re-test the F1 St. Louis County question
(still expected to fail until F1 lands).

## F5 live refusal replay (2026-06-10, local dev server, live model path)

Replay cases added permanently to `scripts/live-replay.ts` (`F5-01`–`F5-04`, session `MS04`; run via
`--rerun F5-01,F5-02,F5-03,F5-04` / `--sessions --rerun MS04`). Results — **6/6 pass**:

| Case | Log # | Tab | Expected | Actual | Result |
|---|---|---|---|---|---|
| F5-01 | #4053 | current | state coverage list | 47 rows, 864ms | ✅ |
| F5-02 | #4055 | current | missing-states answer (was false refusal) | 4 rows, **78ms deterministic** | ✅ |
| F5-03 | — | current | broader phrasing "aren't in the data" | 4 rows, 28ms deterministic | ✅ |
| F5-04 | #4105 | historical | answers the download question | 1 row, 55ms deterministic | ✅ |
| MS04-1 | #4051 | current | national rolling 12-mo murders | 99 rows via `national_monthly` | ✅ |
| MS04-2 | #4052 | current | per-state split (was false refusal) | 4,455 rows; `PARTITION BY state` with full lead-in CTE; explanation states "2018 through March 2026" | ✅ |

Notes: sub-100ms latencies on F5-02/03/04 confirm the deterministic `metadata-coverage` path is
intercepting before Claude. MS04-2's answer also exercises F6 (real cutoff in explanation) and the
followup-transform's window-function instruction correctly preserved the rolling-12 lead-in. Router
regression re-verified same run: 185/185 including the Fairfax County "past three years" case.
