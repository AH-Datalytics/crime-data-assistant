# P3.1a CANDIDATE review — round 1

**Date:** 2026-09-01  
**Candidate:** `c567f4aea31d0f4c5d1c0928b1a2687a8d10955b`, tree `26083c066d572898533af3c9a4ff7ee7dc770448`  
**Base:** `e2d24acd37027f436590ed8eae58bb5b30414ffb`  
**Frozen cases:** v3 SHA-256 `2535cbd934a4766a7f9ff8570f5b0e60d04b7c37430283b48e52b206c75a0b91`  
**Verdict:** **REVISE — DO NOT EXECUTE THE 63 CASES YET**  
**Scope:** exact four-file candidate review and focused local verification. No frozen case, contract builder, model, corpus, or production execution.

## 1. What passes

The candidate is genuinely observation-only at this commit:

- four-file diff, with no route modification or import;
- observer calls the exported production rule objects' exact `when` closures;
- source filtering precedes evaluation in production order;
- the full validator is never called with dummy SQL;
- declared SQL/table-dependent rules are excluded;
- undeclared reads of `ctx.sql` or `ctx.tables` throw and become `analysis_incomplete`;
- observer defaults off and returns an empty denominator and result when disabled;
- focused suite reproduces **16 passed, 0 failed**;
- `npx tsc --noEmit` completes with zero errors;
- diff check is clean.

The core predicate-reuse design is accepted. The issues below concern decision semantics and evidence execution, not a demand to replace that design.

## 2. Blocker 1 — it observes predicate firing, not the typed request decision

`ObservationRecord` contains `ruleId`, `source`, `state`, `severity`, and optional `incompleteReason`. It does **not** contain a typed action/reason pair.

The frozen positives require:

`query_log / decline_capability / query_contract_failed`

Production does not derive that pair from `severity`. After `validateSourceCapabilities` returns a finding, `query-contract-validator.ts` separately checks `BLOCK_CAPABILITY_RULES`; the route then finalizes a contract block with `OUTCOMES.query_contract_failed`. The observer currently reuses the predicate but bypasses both pieces of production decision authority.

Therefore a fired observation cannot be compared with the frozen expected decision/reason, and calling this a request-decision result would overstate what was measured.

### Required correction

Create one shared typed classification path used by both the current post-SQL validator and the observer. It must preserve the BASE validator result exactly and, for each observed rule, produce either:

- the exact typed `QueryLogOutcome` used by production; or
- explicit no-outcome/incomplete state.

Do not copy the nine IDs into a second observer-owned block list. The existing block/retry classification must become one shared authority, and the observer must use `OUTCOMES.query_contract_failed` (or an equivalently typed catalog-derived value), never a string pair re-authored locally.

Add a flags-off regression proving the refactor leaves every existing post-SQL finding, retry issue, block reason, enforced ID, and route finalization outcome unchanged from BASE.

## 3. Blocker 2 — mutation coupling covers one rule, not the frozen denominator

C3 mutates only `nibrs-shooting-category-unsupported`. It proves reuse for that one rule object. The stage-placement ruling requires the coupling property across all 21 applicability pairs.

Expand the mutation matrix so every one of the 21 exact rule/source objects is independently mutated and proves:

1. its positive frozen input fires through both post-SQL production validation and the observer before mutation;
2. mutation of the shared `when` changes both paths;
3. restoration returns both paths to the original result;
4. source filtering prevents the mutation affecting an inapplicable source;
5. the typed action/reason from §2 moves with the production block classification rather than remaining hard-coded in the observer.

Every target must be restored and its source/blob identity checked after mutation execution.

## 4. Blocker 3 — SQL-independence control does not exercise triggering boundaries

C2b loops over all 21 pairs, but gives every rule the same generic murder question and generic contract. Most selected rules do not fire on that input. A conditional SQL read reached only on a triggering branch would escape both C2 and C2b.

Before accepting SQL independence, run the throwing context and two-materially-different-SQL comparison against the **frozen positive and negative inputs for every pair**, including the independently frozen expected contract projections. Any `analysis_incomplete`, SQL-dependent result difference, or expected-contract parse disagreement is separately reported and stops the run as the contract requires.

This may be part of the case runner, but it must be implemented and frozen before the evidence run. A single generic input is not evidence for all branches.

## 5. Blocker 4 — no frozen case runner/result contract exists

The candidate contains the observer and its Tier F test, but no exact reviewed artifact that will:

- verify the candidate and frozen-v3 identities;
- load all 63 cases without changing them;
- invoke the actual `buildQueryContract` and record parser-versus-expected projection separately;
- invoke the observer and compare applicability, state, typed action, and typed reason;
- account for every case exactly once;
- classify runtime/harness/incomplete failures separately;
- write a deterministic run result and summary without treating an unrun case as passing.

Write and test that runner, then include it in the next frozen candidate identity. Mutation tests must catch skipped cases, duplicate IDs, substituted expected fields, missing parser disagreements, and collapsing `analysis_incomplete` into `did_not_fire`.

## 6. Blocker 5 — frozen v3 must never receive observed results

The execution record says the next step will execute the cases while “recording observed results into the reserved null fields.” That would alter the frozen oracle after execution.

`frozen-cases-v3.json` must remain byte-identical forever at its approved hash. Observations belong in a **separate immutable run artifact** keyed by case ID and carrying:

- frozen-v3 hash;
- candidate commit/tree;
- runner identity;
- per-case expected values copied or referenced unambiguously;
- observed contract projection;
- observed predicate state;
- observed typed outcome;
- dimension-by-dimension comparison;
- honest failure/accounting state.

The runner must verify v3 before and after and refuse if its bytes change. The reserved null fields remain null as proof that no observation was backfilled into the oracle.

## 7. Precision correction — the execution record still identifies v1 as Step 3's governing set

Step 3 currently records `frozen-cases-v1.json` as the frozen identity and describes the Ward premise without the later evidence chain. The Step 4 table correctly names v3. Amend Step 3 to preserve all three identities, label v1 and v2 superseded, identify v3 as governing, and point to the v3 final review. Do not rewrite the historical correction trail.

Also update Step 2's “deferred to step 3” contract-dependent statement: v3 now carries independently expected contract projections; actual parser observations remain pending the case run.

## 8. Required response

Amend the candidate and execution record only within the findings above. Preserve commit `c567f4a…` as superseded evidence and create a new candidate commit/tree. Do not execute any of the 63 cases, run `buildQueryContract` on them, make a model call, run the RTCI corpus, or contact production.

The response must include:

- finding-to-file map;
- exact new candidate identity and path set;
- focused test and mutation accounting;
- proof v1/v2/v3 remain byte-identical;
- explicit statement that no case execution occurred;
- any requirement that could not be incorporated.

Then stop for narrow Codex review. P3.2 remains unauthorized.
