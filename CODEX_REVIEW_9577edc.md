# Codex Review: 9577edc July 3 Query-Audit Fixes

Reviewed commit `9577edc` on `dev`, deployed as release `20260703_191352`. Review only; no code changes made.

I read `docs/query-audit-2026-07-03-proposals.md`, inspected the changed code, ran targeted local matcher probes, and checked the VPS data/process state. Production `shr.db` and `nibrs.db` both have CDE-sourced `state_population` rows for 2025 and 2026. `/opt/nibrs/repo/scripts/nibrs-auto-update.py` and `/opt/nibrs/scripts/nibrs-auto-update.py` match by SHA-256, and `/opt/nibrs/scripts/shr-auto-update.js` calls the CDE extension script after rebuilding derived SHR tables.

## Findings

1. `lib/capability-overrides.ts:8`, `lib/guardrails.ts:2476` - should-fix - Group-rate refusal misses common per-capita phrasings.

   Confirmed misses:
   - `murders per 10,000 Black residents`
   - `murder risk by race`
   - `relative to population by ethnicity`

   `detectShrGroupRateOverride()` only treats `rate`, `per capita`, `per 100k`, and `per 100,000` as rate intent. The SQL guardrail is broader in some places, but it still misses these when the generated SQL already joins `state_population` and divides demographic subgroups by total population. That is the exact wrong-answer class F27 was meant to close.

   Proposed fix: centralize the rate-intent regex and include `per 1,000`, `per 10,000`, `per million`, `risk`, `likelihood`, `relative to population`, and typo-tolerant variants for `per capita`. Use the same helper in the SHR front-door override and `group-rate-denominator-unavailable`, then add tests for the examples above.

2. `lib/capability-overrides.ts:23` - nit - SHR front-door matcher can give the wrong refusal reason for non-SHR concepts.

   Confirmed example:
   - `arrest rate by race for robbery in Chicago` on the SHR route triggers `demographic-homicide-rate-denominator-unavailable`.

   SHR cannot answer robbery arrest rates anyway, so this is not a silent wrong answer. But the response would say this is a homicide demographic-rate denominator problem instead of first saying SHR only covers homicide. The broader `shr-non-homicide-topic` guardrail also catches the SQL path, but the front-door override wins before SQL generation.

   Proposed fix: in `detectShrGroupRateOverride()`, bail when the question clearly asks for non-homicide/non-SHR concepts such as arrests, robbery, burglary, assault, drugs, staffing, or clearance. Let the existing SHR scope/capability overrides produce the more accurate refusal.

3. `lib/nibrs-agency-probe.ts:37`, `lib/nibrs-agency-probe.ts:65` - should-fix - NIBRS agency probe loses city/state pairing on multi-place SQL.

   `extractNibrsAgencyScope()` stores one global `state` from the first `state = 'XX'` match, then stores all city filters separately. For a zero-result comparison query shaped like:

   ```sql
   WHERE (a.city = 'KANSAS CITY' AND a.state = 'MO')
      OR (a.city = 'KANSAS CITY' AND a.state = 'KS')
   ```

   the probe can collapse that into `(city = ? OR city = ?) AND state = 'MO'`, silently dropping the Kansas side. The resulting reporting-span caveat would describe only one side of the requested comparison.

   I did not find this creating a prod failure today, and the fallback query is not a pathological 118GB-table path: prod `agencies` has about 308k rows; a broad `city LIKE '%CAPITOL%'` scan took about 1.5s. The accuracy issue is the state pairing.

   Proposed fix: parse city/state predicates as paired scopes, or disable the probe when multiple distinct states/city filters appear and no safe paired extraction is available. Add a KCMO/KCK zero-result probe fixture.

4. `lib/guardrails.ts:2801` - should-fix - `nested-aggregation-discards-measure` depends on fragile ordering and raw text occurrence counts.

   The current two-pass runner means the DV-specific rewrite at `lib/guardrails.ts:2779` does run before the generic matcher today, so this is not currently broken. The problem is durability: the contract is only a comment saying the generic matcher "must stay LAST," and the alias-occurrence check counts raw text anywhere in SQL.

   Concrete fragility:
   - An inner aggregate alias appearing in a string literal, SQL comment, or irrelevant `ORDER BY` can increase the occurrence count and suppress the guardrail even though the outer query still counts groups.

   Proposed fix: either add a unit test that asserts `nibrs-dv-subquery-incident-count` precedes `nested-aggregation-discards-measure`, or split guardrails into explicit phases (`rewriteBeforeGeneric`, `genericSemanticChecks`). For the alias heuristic, strip SQL comments/string literals before occurrence counting, or parse SELECT expressions enough to count only identifier references outside the alias definition.

5. `lib/shr-claude.ts:150`, `scripts/extend-state-population-cde.ts:95` - should-fix - Current-year population guidance is now stale/incomplete.

   The data/process change is safe with respect to clobbering historical rows: `extend-state-population-cde.ts` computes missing years from `source NOT LIKE 'FBI CDE API%'` and its upsert only updates rows whose existing source is CDE-sourced. That means year-specific historical rows should not be overwritten.

   But the SHR prompt still says to filter/disclose when the requested period extends beyond the latest population year. Now the table has 2025 and 2026 rows from `FBI CDE API populations.population`, and the same figure is used for both years until the FBI updates it. Live probe `4791` correctly returned a 2025 national rate, but the explanation only discussed incomplete SHR reporting, not that the denominator is a CDE current estimate carried into 2026.

   Proposed fix: update the SHR/NIBRS prompt guidance and result disclosure to say recent-year state/national rates use `state_population.source`; if source is CDE, disclose that the denominator is the FBI CDE population figure and may be flat across in-progress years.

6. `lib/captcha.ts:27`, `components/WorkspaceChatV2.tsx:184` - should-fix - Session IDs are now sent, but CAPTCHA/daily caps remain per worker.

   The client fix is correct: `WorkspaceChatV2` now sends the same `cda-session` key that `Tracker` creates. That should restore query-log session IDs for real UI traffic.

   The throttling store is still an in-memory `Map` in each Node worker. With PM2 workers, query counts are split by worker. In practice, the CAPTCHA threshold is no longer exactly query 11 and the daily cap is not exactly 75; it is roughly per-worker and depends on load balancing. This is especially relevant because the fix changes behavior from "no session tracking possible" to "tracking re-engaged."

   Proposed fix: move `checkSessionLimit()`/`grantCaptchaCredit()` state into shared SQLite or another shared store keyed by `sessionId + date`. If that is too much for now, update comments/admin expectations so the threshold is not treated as exact under multi-worker PM2.

## Verified / No Finding

- `resolveCityByStateContext()` correctly resolves `include the jackson police department, the hinds county sheriff, and the mississippi capitol police` without prompting, and also handles `compare jackson and gulfport mississippi`. Special action-list ranking for KC/LA/NY/Washington/Baltimore is still protected because explicit `ACTION_OVERRIDES` rank before population.
- NIBRS cached responses still flow through validation, execution, result disclosure, and the final zero-result probe.
- NIBRS campus zero-result rescue happens before the final agency probe. If rescue succeeds, rows are returned; if it does not, the final zero-result path can still append a probe caveat.
- Production `state_population` row counts and samples match the stated operational change: 3,460 historical rows plus 104 CDE rows in both SHR and NIBRS DBs, with no `(state, year)` duplicates.

## Verdict

Safe to leave deployed. I do not see a rollback-level blocker. I would patch before calling this closed, mainly for finding 1 because it can still allow the same demographic-rate wrong-denominator class through with slightly different wording. Findings 3, 5, and 6 are also worth fixing narrowly. Finding 4 is a durability improvement so this guardrail does not become order-sensitive debt.
