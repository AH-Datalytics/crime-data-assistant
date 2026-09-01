# P3.1a stage-placement ruling

**Date:** 2026-09-01  
**Input:** Step 1 inventory and Step 2 structural findings recorded in `2026-09-01-p3-1a-execution-record.md`  
**Ruling:** **PROCEED — no §3.3 divergence stop is triggered**  
**Scope:** documentary judgment only. No implementation, model call, corpus run, or production contact occurred in this review.

## 1. What the measurement establishes

The BASE system does not currently make a pre-answer request decision from these nine definitions. Their sole production path is:

`validateQueryContractSql` → `validateSourceCapabilities`

after the model has produced SQL. The 21 applicability pairs are therefore reachable in production only post-SQL.

That is not a contradiction of P3.1a. It is the measured premise for the authorized observation-stage work: determine what the existing SQL-independent unsupported predicates would decide if observed before model and SQL work, without yet changing delivery behavior.

The Historical clearance observer is a useful architectural precedent for a contract-only observer. It is not proof that the new observer is correct; the candidate must earn that independently.

## 2. The claim boundary

The candidate observation stage may claim only:

> Given the question-derived contract and source/family available at this earlier point, these existing production predicate definitions would produce this decision if evaluated here.

It may not claim:

- that production currently makes that decision before SQL;
- that natural traffic exercised the current post-SQL path;
- that moving evaluation earlier is behaviorally equivalent when enabled;
- that a pre-answer result is proven correct merely because the same predicate fires post-SQL;
- that P3.1a has improved an answer.

The durable report must name the new evaluation point as **counterfactual observation** until a later, separately authorized stage uses it to affect delivery.

## 3. Implementation boundary

Do **not** call the complete `validateSourceCapabilities` API with empty, placeholder, fabricated, or sentinel SQL. That API extracts tables and evaluates all 39 rules; dummy SQL would make table-dependent rules appear missing and would change the meaning of the result.

The observation stage must instead reuse the exact rule objects/predicate functions for the nine inventory-classified definitions that are proven SQL-independent. The eligibility rule must be structural and explicit. At minimum, an observed rule must:

- have no `requiresAnyTables`;
- have no `forbidsTables`;
- have no `forbiddenSql` dependency;
- have a `when` result proven invariant to SQL input;
- retain the same rule identity, source applicability, severity, message, and question/contract predicate as the production validator.

If reaching those exact predicates requires exporting or extracting them, flags-off tests must prove the existing post-SQL production result is unchanged from BASE. Do not copy their regular expressions or logic into an observer-specific implementation.

## 4. Required controls before accepting the CANDIDATE

For every one of the 21 applicability pairs:

1. the positive and negative question/contract controls are frozen before execution;
2. the observer result is identical across at least two materially different SQL inputs, demonstrating that SQL is not an input to the selected rule's outcome;
3. the same exact rule object/predicate produces the corresponding finding through the current post-SQL validator when given a valid SQL-bearing call;
4. mutation of the underlying production predicate changes both the post-SQL path and the observer result;
5. adding any SQL/table-dependent property to an observed rule removes it from pre-answer eligibility or fails the inventory/accounting guard;
6. a rule outside the frozen nine cannot enter the observation denominator silently.

These controls measure predicate identity and stage semantics. They do not certify the substantive correctness of the rule; the independently adjudicated coverage cases own that question.

## 5. Case accounting

The measured unit is 21 applicability pairs. The case count is not automatically 42 or 63:

- every pair needs triggering and non-triggering exercise;
- every named evidence gap needs positive, false-acceptance, and false-refusal coverage where meaningful;
- one frozen case may occupy more than one slot only when the coverage map records each role explicitly;
- every omitted or not-meaningful role needs a reason;
- NIBRS and SHR gaps remain named even though corpus v0.1 is Current Trends-only;
- Historical clearance remains named as covered by a different mechanism and outside the nine-definition observation denominator.

## 6. Disposition

Proceed with the preliminary corpus-to-matrix mapping and frozen case authoring. Then implement the observation-only candidate within §3's boundaries above.

Stop before implementation if the nine definitions cannot be isolated through the same production predicates without dummy SQL or copied logic. Stop during candidate testing on any contract §3.3 trigger.

No new owner authorization is required. P3.2 remains unauthorized.
