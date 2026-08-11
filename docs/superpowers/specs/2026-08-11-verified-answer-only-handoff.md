# Verified-answer-only system — implementation handoff

**Date:** 2026-08-11  
**Status:** Frozen implementation contract; final repository consistency review completed and corrections incorporated.  
**Scope:** Current Trends, Historical, NIBRS, SHR, and Hate Crime query paths; chart output; audit email; release gates.  
**Supersedes:** Any earlier plan that treats an LLM judge as the primary correctness control or permits a permanently unverified legacy answer path.

## 1. Purpose

Change the Crime Data Assistant from a system that prevents many known failures but can still ship plausible, unsupported answers into a verified-answer-only system. The application must provide a factual answer only when every material claim is deterministically derived from a supported semantic plan and validated against a healthy, versioned data source. When that standard cannot be met, it must retry, ask for clarification, narrow the factual scope transparently, or truthfully decline the unsupported capability. It must never guess.

This contract optimizes correctness over answer coverage. Coverage is expected to fall during migration and then recover as deterministic support expands. Coverage pressure must never create a silent escape around the contract.

## 2. Non-negotiable product contract

### 2.1 Internal standard for a delivered answer

Every delivered material claim must have all of the following:

1. A supported, typed semantic plan.
2. Deterministically generated SQL or an equivalent deterministic data operation.
3. A healthy source whose version and applicable time coverage are known.
4. Canonical geography resolution and an exact requested-versus-returned entity comparison.
5. Validated metric, offense definition, time range, grain, and missingness semantics.
6. Reconciled calculations and a machine-checkable claim binding.
7. Prose generated from validated facts rather than unconstrained factual model output.
8. Chart inputs generated from the same validated facts, with configuration and render auditing.
9. A proof manifest showing that every mandatory check ran and passed.

An arbitrary LLM-authored SQL query cannot become a confirmed answer merely because postconditions did not detect a problem. Postconditions can establish internal consistency; they cannot prove that arbitrary SQL selected the correct table, population, denominator, filters, or interpretation.

The LLM may interpret language into a candidate typed plan. Application code must validate the plan and compile its meaning. An LLM may help phrase non-material language only when factual content is constrained to validated bindings.

### 2.2 Verification status is never user-facing

Users must never be shown verification badges, confidence scores, “verified,” “unverified,” “partially verified,” “validation failed,” or equivalent internal language. Raw verification fields remain server-side and are used for retry, delivery decisions, logging, audits, tests, and deploy gates.

This presentation constraint does not permit concealed omissions or unsupported facts. Scope, source coverage, definitions, and factual data limitations remain visible.

### 2.3 Permitted delivery actions

Every request must end in exactly one terminal internal delivery action:

- `answer`: all requested material scope is supported and all proof obligations pass.
- `answer_limited_scope`: every delivered claim passes, but factual source coverage supports only a clearly stated narrower scope.
- `clarify`: the request is materially ambiguous and the user is asked a specific question.
- `decline_capability`: the product has no supported path for the request.
- `decline_data`: the named source factually lacks the required data or coverage, established by a deterministic probe.
- `decline_source_health`: a required source or summary is unavailable, stale for the requested period, incomplete, or of unknown health.

There is no permanent action for “ship an answer that could not be proven.”

`retry` is a transitional processing action, not a terminal `delivery_action`. Nothing is sent until it resolves into one of the terminal actions above. Retry attempts and reasons remain separately accounted in the proof/digest record.

### 2.4 User-facing wording rules

- Describe what the product can cover, not its confidence in itself.
- Distinguish source limitation, product capability limitation, and request ambiguity.
- Never claim a source lacks data unless a deterministic attribution probe established that fact.
- If the system cannot establish why an entity is unavailable, use truthful capability wording rather than inventing a source limitation.
- Never silently drop a requested city, agency, year, category, or measure.
- Never represent missing, unreported, unavailable, unsupported, or unhealthy data as zero.
- Never say a question is inherently unanswerable when the limitation belongs to this product.

Examples:

> Results cover the 31 requested cities listed below. Jacksonville cannot currently be included through this comparison path; I can run it separately.

> This source does not publish district-level clearance data. I can provide the supported city-level result.

> Do you mean incidents involving at least one known offender under 18, or arrests of people under 18?

For large omitted sets, show a concise count and a bounded list in the main response, with every omitted entity and reason available in expandable detail. “Never silently drop” does not require an unbounded preamble.

## 3. Resolved design decisions

These decisions are closed unless implementation evidence shows that they are impossible or unsafe:

1. “Confirmed” internally means deterministically derived, not merely LLM-authored and post-hoc checked.
2. Verification status is internal-only.
3. Correctness outranks answer rate.
4. Unsupported long-tail paths ultimately clarify, narrow, or decline; they cannot remain permanent legacy exceptions.
5. Deterministic paths are authoritative where they exist.
6. Result validation happens before delivery and does not add another live LLM call.
7. An LLM judge is optional, asynchronous, advisory, and late in the plan.
8. A model judge can discover possible defects but can never mint an answer as acceptable.
9. Provenance is uniform for delivered factual answers and describes data, not confidence.
10. Missingness and zero are distinct states across every source.
11. Unknown auditor, validator, source, or canary health is not healthy.
12. All migrations must be additive and backward-compatible until the rollback window closes.
13. The proof contract applies uniformly to Current Trends, Historical, NIBRS, SHR, and Hate Crime. A source may have source-specific definitions and probes, but no source may bypass a mandatory proof category, delivery rule, audit-health rule, or release gate.
14. No user-visible behavior changes until the owner explicitly approves enforcement. Off and shadow modes cannot change routing, SQL, retries, rows, narrative, charts, omissions, clarification, decline behavior, or provenance shown to users.
15. The existing query-review log and digest continue independently. Failure, delay, or disablement of the new proof/shadow pipeline cannot stop or rewrite existing query logging and review history.

## 4. Current repository baseline

The final reviewer must re-verify these facts before implementation. They were established from the repository and the 2026-08-11 production review:

- Deterministic paths already short-circuit before model SQL in `app/api/query/route.ts` and `app/api/nibrs-query/route.ts`; SHR and metadata paths also contain deterministic exits.
- `lib/result-disclosure.ts` already receives `{ explanation, question, sql, rows }` and performs postprocessing before terminal delivery on the JSON model paths. On the Current Trends/Historical streaming route, however, the initial factual `result` event is delivered before disclosure; disclosure runs only on a later background explanation update. Stage 1 must make proof finalization gate the first factual SSE event.
- Some deterministic early exits have separate logging/response sites and must not be skipped by the new proof hook.
- All four routes use `lib/response-cache.ts`; cache hits bypass model generation and re-run cached LLM-authored SQL/explanations. Cache-hit answers still require current proof, and cache validity must incorporate enforcement state and source data version.
- `app/api/embed/route.ts` is an additional user-facing factual/chart surface that re-executes stored SQL. It is inside this contract: newly created embeds require a valid originating proof, and embed reads require current source health plus result/chart proof. Legacy embeds without adequate proof must not be silently treated as compliant.
- Result rows are in server memory at the log/egress sites, but a bounded result digest is not persisted.
- Production `model_response` population was zero at the time of review and must be diagnosed, not assumed fixed by schema presence.
- NIBRS has a source-health precedent in `lib/nibrs-rollup-router.ts`; equivalent capability-specific health is missing for the other sources.
- `lib/reliability-disclosure.ts` explicitly documents a fail-open doctrine. The new contract intentionally supersedes that doctrine for anything material to factual correctness.
- Chart artifacts and render receipts existed in production while `chart_audit_results` remained empty. The chart audit ran only through `scripts/nightly-audit-and-digest.sh`, and the production schedule observed during review was weekly despite the script being described as nightly.
- `audit_runs` and `getAuditorHealth()` provide a useful precedent for distinguishing “ran and passed” from “did not run.”
- `audit_findings.status` existed but all reviewed findings remained open; no working adjudication lifecycle existed.
- SHR already has a useful `validated_zero` versus gap pattern that should be generalized.
- A 2026-08-11 production review reported approximately 3.8 seconds median and 12.5 seconds p95 latency, about 10.5% deterministic coverage, zero populated `model_response` rows, empty `chart_audit_results`, and a weekly-observed audit schedule. These are planning observations, not repository-backed fixtures. Stage 0 must re-measure each value from the production query log, tables, and active scheduler before using it as a baseline or acceptance threshold.

## 5. Target architecture

```text
User question
  -> source/tab and candidate intent
  -> typed semantic plan
  -> plan validation + canonical resolution
  -> capability-specific source health
  -> deterministic SQL/data operation
  -> bounded result digest
  -> completeness/grain/reconciliation checks
  -> deterministic claim bindings
  -> prose and chart generation from the same bindings
  -> final postconditions
  -> delivery action
  -> response or truthful clarify/decline
```

The existing `applyResultDisclosures(...)` hook is the starting point for shared egress validation, not proof that every exit is covered. Extend the existing `scripts/test-route-egress-contract.ts` into an inventory of terminal responses and assert that factual answer exits pass through proof finalization. The inventory must include the first factual SSE event, deterministic exits, retry resolutions, response-cache hits, and shared-chart embeds.

## 6. Internal data contracts

### 6.1 Proof manifest

The proof manifest is internal and versioned. A delivered answer requires positive evidence that every applicable mandatory check ran and passed.

```json
{
  "v": 1,
  "derivation": "deterministic",
  "planFamily": "nibrs-clearance-type",
  "source": {
    "id": "nibrs",
    "dataVersion": "2025-08-10",
    "health": "passed",
    "requestedCoverage": "passed"
  },
  "checks": {
    "semanticPlan": "passed",
    "canonicalGeographies": "passed",
    "entityCompleteness": "passed",
    "metric": "passed",
    "grain": "passed",
    "timeRange": "passed",
    "missingness": "passed",
    "reconciliation": "passed",
    "claims": "passed",
    "chartData": "not_applicable"
  }
}
```

Valid check states are `passed`, `failed`, `not_applicable`, and `unknown`. `unknown` can never satisfy a mandatory obligation. `not_applicable` must be justified by the typed plan, not selected after a check fails.

### 6.2 Result digest

Persist a bounded, versioned JSON digest, approximately 2 KB typical and 8 KB hard maximum:

- Row count and truncation status.
- Up to 24 columns with name and inferred/declared type.
- Numeric min/max/null/zero counts.
- Sum only for measures the semantic plan declares additive; never infer additivity from a name alone.
- Up to 20 distinct values for declared geography/category fields, with `capped` metadata.
- Up to three representative rows selected deterministically.
- Requested and returned canonical entity sets.
- Complete internal omission array with reason codes and attribution evidence.
- Plan family, resolver contract ID, retry count, guardrail outcomes, and digest schema version.

The digest is evidence, not the answer and not by itself proof.

### 6.3 Delivery decision

Store `delivery_action` as its own indexed `query_log` column because operational and product analysis will group by it. Keep the full decision and omissions in the versioned digest/proof JSON.

### 6.4 Claim bindings

For deterministic families, generate prose and charts from structured bindings immediately rather than extracting claims from finished prose:

```json
{
  "template": "year_over_year_change",
  "bindings": {
    "place": "Washington, DC",
    "startYear": 2024,
    "startValue": 6502,
    "endYear": 2025,
    "endValue": 5171,
    "difference": -1331,
    "percentChange": -20.47
  }
}
```

The displayed sentence and chart must use the same bindings. Do not attempt a general prose parser as the primary correctness mechanism. LLM paths may be analyzed in shadow, but their prose cannot qualify for final-state delivery merely through claim extraction.

## 7. Omission attribution

When requested canonical entities are absent from results, batch or cache deterministic probes rather than issuing one uncached database query per omission. Reuse existing components such as `lib/nibrs-agency-probe.ts`, agency/year reliability data, completeness tables, consolidation aliases, and resolver evidence.

Use a closed reason set, for example:

- `not_in_source`
- `outside_source_years`
- `nonreporting_period`
- `insufficient_reporting_coverage`
- `consolidation_mapping`
- `unsupported_geography_type`
- `filtered_by_metric_definition`
- `source_unhealthy`
- `capability_path_unavailable`
- `unknown`

Each reason must carry evidence. `unknown` never permits an attributed source claim; it results in capability framing or a decline. The user-facing wording layer maps reason codes to approved factual templates.

## 8. Source health and degraded behavior

Implement a capability-specific registry with a short in-process cache, not one app-wide health bit. Every registry result is `healthy`, `degraded(reason)`, or `unknown(reason)`. Unknown is treated as degraded.

At minimum, health should consider:

- Database open/read success.
- Required tables and columns.
- Nonzero/expected row bounds where applicable.
- Builder/import receipt with start, finish, source version, schema version, input/output counts, and reconciliation status.
- Freshness relative to the exact period requested, not merely the wall clock.
- Dependencies between raw source, summaries, completeness tables, and sample/cohort tables.

Expected per-capability behavior:

- Historical: validate historical tables, reliability metadata, and applicable latest year.
- Current Trends: independently validate national and sample-agency tables and their generation alignment.
- NIBRS: extend `inspectNibrsRollupAvailability()` with build receipts and requested-period coverage.
- SHR: validate that the DB contains expected incident data and required comparison/display-status structures, not merely that the file opens.
- Hate Crime: validate enabled dataset/table consistency and applicable coverage.

If a stale source remains valid for the requested historical period, it may answer that period. A stale source cannot answer a request that depends on newer data. A data limitation may be stated only when health/coverage evidence establishes it.

### 8.1 Source parity

Implement one shared source-adapter contract covering source identity/version, requested-period health, canonical geography, metric/grain metadata, missingness semantics, omission attribution, additive measures, and build/import receipts. Each source supplies an adapter; shared proof and delivery code consumes the contract. Do not implement a NIBRS-only correctness system and later approximate it elsewhere.

Maintain a source-parity acceptance matrix with one row each for Current Trends, Historical, NIBRS, SHR, and Hate Crime and columns for:

- Typed plan/derivation eligibility.
- Source and requested-period health.
- Canonical geography and completeness.
- Metric, grain, and missingness.
- Reconciliation and claim bindings.
- Chart data/render audit.
- Omission attribution and safe exits.
- Query-log proof/delivery persistence.
- Audit-health accounting.
- Regression and deployment-gate coverage.

A capability cannot be declared complete while any mandatory matrix cell is missing, unknown, or implemented as a silent pass. Source-specific `not_applicable` states require a documented semantic reason and a test.

## 9. Implementation stages and timeline

Core foundation estimate: approximately 16–18 development days plus two to four weeks of shadow observation. Expansion of deterministic question-family coverage is additional and demand-dependent.

### 9.1 Operating modes

Implement one global mode plus narrower per-source/per-family overrides:

- `off`: the new proof system performs no request-path work and has no effect.
- `shadow`: it observes and records hypothetical proof and delivery decisions but preserves existing user-visible behavior exactly.
- `enforce`: it may change delivery behavior only for the explicitly enabled source × family.

Default every new capability to `off`. Moving to `shadow` requires successful tests and rollback readiness; moving to `enforce` requires a separate explicit owner approval after shadow evidence is presented. A global kill switch returns all capabilities to `off`. An auditor/shadow failure must disable or skip shadow work, not affect a user response. Bound and measure shadow CPU, memory, database contention, storage, and latency; automatically disable the shadow component if operational budgets are exceeded.

The existing query logger, findings, and digest remain a separate operational stream. New fields/tables are additive; shadow findings use explicit source and schema/suite versions. Existing history remains readable in off mode and after application rollback. Repairs to audit scheduling or chart auditing may change internal reviewer output, but not user responses.

### Stage 0 — freeze contract, preserve rollback, repair audit health (1–2 days)

- Record the current production release, commit, symlink target, environment, PM2 configuration, cron/systemd schedules, database paths, and feature flags.
- Tag the baseline commit and preserve its immutable release directory.
- Back up `query_log.db` and any database that an additive migration will alter.
- Define proof, delivery, omission, and health types.
- Define global and per-source/per-family `off | shadow | enforce` configuration, defaulting to `off`, plus the global kill switch.
- Diagnose and fix the weekly-versus-nightly schedule mismatch.
- Diagnose why chart artifacts/receipts produce zero `chart_audit_results`.
- Populate and verify `model_response` logging.
- Re-measure the production latency, deterministic-path share, model-response population, chart-audit counts, and active scheduler; save the commands/window/results in a dated review artifact.
- Add explicit audit-health reporting: expected, eligible, executed, skipped, failed, and reconciled counts.

Exit: every audit can prove whether it ran; chart auditing produces results on fixtures and production-shaped artifacts; rollback manifest exists.

### Stage 1 — proof manifest, digest, postconditions, and omissions in shadow (4–6 days)

- Add `lib/result-digest.ts` and proof/postcondition modules.
- Add additive query-log migration(s) for digest/proof JSON, `delivery_action`, schema versions, and any required indexes.
- Integrate every factual terminal exit across the four route files, including deterministic early exits and retry paths.
- Make proof finalization gate the first factual SSE event in `app/api/query/route.ts`; a later background explanation cannot retroactively validate an already delivered result.
- Run cache-hit results through the same proof path, and include source data version, proof schema/enforcement version, and relevant plan identity in cache validity or invalidation.
- Bring `app/api/embed/route.ts` under the proof contract. Require valid originating proof for newly created embeds and current source-health/result/chart validation on reads; define safe behavior for legacy unproved embeds.
- Extend `lib/result-disclosure.ts` rather than creating a competing narrative-finalization layer.
- Implement v1 checks for requested/returned entities, canonical geography, metric, grain, year range, missingness, and safe numeric claims.
- Implement batched/cached omission attribution and approved response mappings.
- Run shadow-only: log hypothetical delivery actions without changing user-visible behavior.
- Prove with response fixtures/snapshots that enabling shadow does not change routing, SQL, retry decisions, rows, narrative, charts, clarification/decline behavior, or user-visible payloads.
- Prove that shadow/auditor failure leaves the existing query logger and digest operational and does not affect responses.
- Add digest-email reporting for pass/failure/unknown rates by tab and plan family.

Exit: 100% of eligible production-shaped responses have a versioned digest, proof attempt, delivery action, and accounted validator health; performance meets budget.

### Stage 2 — source health and build receipts (about 3 days)

- Add a per-capability source-health registry and cache.
- Add build/import receipts to summary builders and importers.
- Exercise healthy, degraded, stale-for-request, and unknown cases.
- Add capability-specific response behavior and kill switches.

Exit: intentionally stale or incomplete fixtures affect only the relevant capability; unknown can never produce an answer.

### Stage 3 — finding lifecycle and safe exits (2–3 days)

- Separate successful answers, legitimate empty results, correct refusals, guardrail blocks, contract failures, database failures, validator failures, and auditor failures.
- Implement status transitions for `open`, `confirmed`, `false_positive`, `fixed`, `wont_fix`, and `regression_verified`.
- Add a private authenticated review queue in the application and deep-link to it from the reviewer email.
- Require a reviewer credential distinct from the shared site-password cookie for both the queue page and adjudication endpoint, following the separate-key precedent in `app/api/query-log/route.ts`.
- Add signed, expiring, idempotent adjudication actions with an audit trail; email is notification, not the system of record.
- Create clarify, limited-scope, source-limitation, capability-limitation, and source-health response templates.
- Require every confirmed defect to link to a permanent regression case before closure as fixed.

Exit: a finding can complete the full finding-to-regression lifecycle, and the email is useful to a human rather than a score dump.

### Stage 4 — per-family enforcement and uniform provenance (2–3 days plus shadow calendar)

- Select high-volume, high-pass-rate deterministic families first.
- Generate deterministic claim bindings and charts from shared facts.
- Enable proof enforcement by tab × plan family behind kill switches.
- Show uniform source, canonical geography, definition, period, coverage, and expandable methodology/SQL for every delivered factual answer.
- Do not display internal verification state.

Exit: enforced families cannot ship when a mandatory obligation is failed or unknown; false blocks and declines are measurable by family.

### Stage 5 — correctness-gated deployments (about 2 days)

- Add versioned `canary_runs`/release-run accounting with expected and executed counts, fixture manifest hash, release SHA, per-case result, and wall time.
- Split stable fixture gates from nonblocking production-data smoke checks.
- Seed fixtures from production failures and both must-flag and must-not-flag cases.
- Fail loudly on zero executed cases, invalid fixtures, missing databases, or incomplete accounting.
- Gate the symlink swap only after the gate itself has proven healthy.
- Retain a prominent, logged, reason-required emergency bypass.

Exit: a seeded regression blocks a test deployment, a zero-case suite blocks, a data-drift smoke warning does not falsely block, and rollback remains functional.

### Stage 6 — expand deterministic coverage (ongoing, product-prioritized)

- Rank capability declines and clarifications by real human demand.
- Add typed semantic plans, deterministic compilers, bindings, and regression coverage for the highest-value families.
- Measure complete-answer, limited-scope, clarification, and decline rates without weakening the proof standard.

Exit: broad enforcement can proceed at an acceptable product coverage level; unsupported traffic still exits safely.

### Stage 7 — optional advisory discovery, deferred

After the core contract operates reliably:

- Run deterministic-versus-model comparisons offline or on sampled shadow replay; compare normalized contracts/results, never SQL text.
- Consider a two-week asynchronous LLM-judge experiment for novel semantic mismatches.
- Keep all judge output advisory and human-adjudicated.
- Do not pursue supervised ML until there is a substantial set of trustworthy adjudicated labels.

## 10. Enforcement readiness and migration bounds

Proof obligations apply to every individual delivered answer. A family’s aggregate pass rate measures coverage, not correctness. A family with a lower pass rate can be safely enforced if failures become truthful clarifications/declines; a high pass rate is unsafe if known bad answers pass.

Before enforcing a check for a family:

- Every mandatory check has explicit ran/pass/fail/unknown accounting.
- The full relevant regression corpus passes.
- Source, validator, and auditor health are proven.
- Shadow review finds no known incorrect answer passing the proof system.
- Omission attribution is tested; unknown attribution cannot become a source claim.
- False-block behavior has been reviewed on representative traffic.
- The check has a scoped kill switch.
- At least two weeks of representative shadow traffic have been reviewed, unless a pre-existing invariant is already proven and blocking today.

Migration commitments:

- No query family remains in shadow longer than four weeks without a documented owner decision.
- Eight weeks is the absolute maximum; after that it is enforced, immediately remediated, or converted to a safe clarify/decline path.
- Aim to support at least 80% of current legitimate human traffic with full or accurately limited-scope answers before broad system-wide enforcement. This is a coverage goal, never permission to ship unsupported answers.
- The final state routes 100% of requests into answer, limited-scope answer, clarification, or truthful decline. There is no silent legacy escape.

Exact per-family rollout thresholds may be set after Stage 1 measurements, but they cannot override these bounds or the individual-answer proof requirement.

## 11. Performance and storage constraints

- No additional live LLM call for validation.
- Target less than 50 ms median and 100 ms p95 added validation latency.
- Bound all digests and omission probes; cache/batch coverage probes.
- Do not run deterministic and model SQL synchronously for every request.
- Browser render receipts and advisory comparison/judge work remain asynchronous.
- A retry may be slower when the initial candidate fails; correctness outranks latency on the failure path.
- Measure route-level p50/p95 before and after each enforcement flip.
- Do not persist unlimited result payloads.

## 12. Backup, rollback, and recovery

Before implementation or deployment:

1. Resolve and record the actual current production symlink target and commit; do not rely on this document’s date.
2. Preserve and tag the baseline source commit.
3. Preserve the current immutable release directory through the full observation period.
4. Save environment files, PM2 configuration, scheduler definitions, feature flags, and database path mappings.
5. Back up `query_log.db` immediately before each schema migration.
6. Keep migrations additive, nullable, deploy-order tolerant, and readable by the baseline application.
7. Put validators, source-health enforcement, and family enforcement behind scoped kill switches.

Primary rollback is application rollback through the existing atomic release symlink and PM2 reload. Restoring an old `query_log.db` is a last resort because it loses newer query/audit records. Additive schemas should permit the baseline application to run against the migrated log.

Before user-visible enforcement, rehearse:

1. Deploy the shadow release.
2. Verify all query surfaces and PM2 workers.
3. Roll back to the preserved baseline release.
4. Verify all query surfaces and workers again.
5. Return to the shadow release.
6. Record commands, timestamps, release IDs, and results in the rollback manifest.

Do not remove the baseline release or compatibility switches until enforcement has passed its observation period and the user explicitly approves cleanup.

## 13. Required tests and definition of done

### Contract tests

- Every factual response exit passes through proof finalization.
- The first factual Current/Historical SSE event cannot precede proof finalization.
- Cache hits cannot bypass proof, and enforcement/source-version changes invalidate incompatible cache entries.
- Shared-chart creation/read paths cannot bypass originating proof, current source health, or result/chart validation; legacy unproved embeds use the documented safe behavior.
- Missing, failed, skipped, or unknown mandatory checks cannot produce `answer` or `answer_limited_scope`.
- User-visible responses contain none of the prohibited verification/confidence vocabulary.
- Internal verification fields are not used by the UI for display.
- `off` and `shadow` preserve user-visible payloads and existing routing/query behavior; only internal additive audit state may differ.
- A shadow timeout, exception, storage limit, or unavailable audit database cannot alter or delay the user response beyond the stated budget and cannot interrupt existing query logging.
- No source/family enters `enforce` without an explicit configuration change and recorded owner approval.

### Digest and omission tests

- Digest caps, deterministic sampling, truncation flags, schema versions, and type handling.
- No generic sum for undeclared/non-additive measures.
- Exact requested/returned canonical-entity comparison.
- Batched attribution for missing agency, outside-year, nonreporting, consolidation, unsupported type, unhealthy source, and unknown.
- Unknown attribution uses capability language and never invents a source limitation.
- Full omission detail remains available when the main response is capped.

### Correctness tests

- Multi-city completeness, including the historical 31-of-32 failure.
- Canonical alias and consolidation cases: New York City, St. Louis, Jacksonville, and Washington, DC.
- Missingness versus validated zero.
- Metric/grain confusion: incident, victim, offender, arrest, agency, city, state, and national.
- Derived calculations: percentage change, rate, difference, ranking, category reconciliation, and “not cleared.”
- Narrative and chart values originate from the same bindings.
- Source freshness is evaluated against the requested period.
- Legitimate empty, source limitation, capability limitation, and ambiguity produce distinct delivery actions and truthful wording.

### Audit and release tests

- Expected = executed + skipped + failed accounting, with every skipped/failed item represented.
- Zero-case and missing-fixture runs fail health.
- Chart artifacts + receipts produce chart results.
- A confirmed finding can become a regression and close only after verification.
- Fixture gates block a seeded regression.
- Production-data drift produces a smoke warning rather than an invalid fixture failure.
- Baseline rollback works against the additive schema.
- The source-parity matrix has no missing or silent-pass mandatory cells for a capability declared complete.
- Reviewer links require authentication/signature as designed, expire safely, are idempotent, and record who changed each finding and when.
- An ordinary session authenticated only with the shared site password cannot read the reviewer queue, retrieve proof/verification state, or call an adjudication endpoint.

### Completion criteria

- Full `npm test` and `npx tsc --noEmit` pass.
- Targeted production-shaped fixture tests pass for every source.
- Shadow coverage and false-block reports are human-readable.
- Added live latency remains within budget.
- Rollback rehearsal succeeds.
- No user-facing factual answer can bypass the proof contract in enforced families.
- At final migration completion, no legacy unproved answer path remains enabled.

## 14. Human audit email requirements

### 14.1 Review venue and cadence

The system of record remains the production audit/query-log database on the VPS. Human review takes place on a private reviewer page within the application, not in raw SQLite, terminal output, or email alone. The page reads the evidence and finding lifecycle from the server and writes adjudications back through a narrow endpoint. Both page and endpoint require a reviewer credential distinct from the shared site-password cookie, following the existing `/api/query-log` separate-key precedent. It is an internal operational surface and must never expose verification state to ordinary users.

During the two-to-four-week shadow period:

- Run automated proof/postcondition analysis on every eligible human query across all sources.
- Send a concise daily email with audit health, source/family coverage, would-answer/would-narrow/would-clarify/would-decline counts, new high-value discrepancies, and a link to the private queue.
- The private queue supports filtering by source, plan family, validator, hypothetical delivery action, and date; it shows every affected query, not only the email sample.
- The reviewer adjudicates suspected wrong passes, false blocks, omission reasons, and response wording. These decisions become the evidence for enforcement readiness.
- A weekly rollup records trends, unresolved issues, source-parity gaps, and the explicit decision for any family approaching its shadow deadline.

After enforcement:

- The same private queue remains the review location for validator failures, safe declines, user-reported problems, random samples of delivered answers, chart discrepancies, auditor-health failures, and regression candidates.
- Send a concise weekly review email by default, with immediate notification for systemic source-health failures, auditor outages, release-gate failures, or a suspected incorrect delivered answer.
- Keep a small stratified random sample of delivered answers under human review so the system continues testing for failures that validators do not know how to name.
- Closing a confirmed issue requires a linked regression and the finding lifecycle; email replies alone do not close findings.

Deployment correctness review is separate: it occurs in the release pipeline against fixtures and production-shaped smoke checks before symlink swap, with results stored in versioned run records and linked from the private reviewer page.

The reviewer email must preserve the complete evidence chain without becoming a score dump:

- User question and selected source.
- Internal plan family and canonical geography.
- SQL or deterministic operation.
- Bounded result digest.
- Claim bindings and rendered response.
- Chart configuration/render status when applicable.
- Exact suspected discrepancy or delivery reason.
- Audit health and coverage for the period.
- Confirm / Not a problem actions.

Cluster repeated questions/findings. Present a small actionable set plus a representative sample of successful traffic. Never describe missing audit coverage as clean.

## 15. Ownership and concurrency

- Claude is the primary implementer for Stages 0–5, one stage at a time.
- Codex is the independent reviewer and release verifier after each stage; Codex does not edit Claude's active files during implementation review.
- Jeff approves every user-visible enforcement change, production deployment decision where requested, acceptable coverage threshold, and eventual legacy-path cleanup.
- Assign one owner per stage and one owner per file group before any later concurrent work.
- Do not have two agents edit the same route or shared proof module simultaneously.
- Freeze schema/type names before route integration begins.
- Keep unrelated dirty worktree files untouched.
- Every implementation handoff must list owned files, migrations, test commands, commit hashes, deploy state, and known open risks.
- No stage is deployed merely because its code is complete; its stage exit and rollback prerequisites must also be satisfied.

Stage workflow: Claude implements and reports a commit plus evidence; Codex independently reviews the diff and reruns relevant checks; Claude corrects confirmed issues; Codex signs off; only then may the stage be considered for an off/shadow deployment. Neither agent may enable enforcement without Jeff's explicit approval.

## 16. Explicitly deferred work

- Live deterministic-versus-model racing.
- An LLM call in the live validation path.
- A production-blocking LLM judge.
- Supervised machine learning from existing detector outputs or the overloaded `error` column.
- A general prose-to-claim parser as the foundation of correctness.
- Destructive schema cleanup or removal of rollback compatibility.

## 17. Final consistency review requested from Claude

Review this handoff against the current repository and production evidence. Do not change code and do not redesign the system unless concrete evidence shows the contract cannot be implemented safely. Report only:

1. Contradictions within this document or with the current architecture.
2. Missing implementation dependencies or response exits.
3. Unsafe assumptions, especially around source health, omission attribution, proof coverage, scheduling, latency, migrations, and rollback.
4. Missing tests or rollback steps required before coding.
5. Any statement presented as fact that the repository or production data does not support.

For every issue, cite the relevant file/function/table and propose the smallest correction to this handoff. End with one of:

- `READY TO FREEZE` — no material plan defect remains.
- `READY AFTER DOCUMENT CORRECTIONS` — list the exact corrections.
- `NOT READY` — identify the concrete blocker.

Do not reopen resolved product decisions merely because a different tradeoff is possible.
