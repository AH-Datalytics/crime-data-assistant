# P3.1a Step 2 coverage ruling

**Date:** 2026-09-01  
**Input:** Step 2 findings in `2026-09-01-p3-1a-execution-record.md`  
**Ruling:** **CORRECT THE LABEL, THEN PROCEED**  
**Stop condition:** not triggered; the case set has not yet been frozen or exercised.

## 1. The source-filter correction is valid

Production applies the source filter before `rule.when`. The first mapper omitted that filter and therefore reported SHR rules firing on RTCI/Current Trends questions that production would never present to those rules.

Correcting the mapper to follow production order is necessary. Preserving the first result as a rejected diagnostic is also correct; it demonstrates why source applicability is part of the accountable unit.

The explicit mapping `rtci` → `current` is appropriate if it is verified against the frozen corpus metadata and the application's source vocabulary and retained as a named mapping rather than inferred silently.

## 2. “Zero observed firings” is not “zero certification coverage”

Calling the production `rule.when()` functions answers:

> Which existing predicates fired on these frozen questions under this source mapping?

It does **not** independently answer:

> Which frozen questions semantically should or should not exercise each rule?

Those differ precisely when a predicate has a false negative or false positive. Using predicate output to establish expected coverage would make the implementation its own oracle and could hide the defect the certification cases are intended to detect.

Therefore revise Step 2's wording and map into two columns:

1. **independently expected applicability/role** — derived from the case's adjudicated meaning and the rule's stated contract, without executing `rule.when`;
2. **observed BASE predicate result** — the source-filtered diagnostic already measured.

The current result may be reported as **0 of 21 pairs observed firing in corpus v0.1**. It may be reported as **0 independently covered pairs** only after an independent case-by-pair adjudication reaches that result.

## 3. Rules for the preliminary map

- Do not use `rule.when`, the future observer, or another implementation of the predicate to populate expected applicability.
- A corpus case may cover a slot only when its frozen question, expected disposition, independent evidence, and applicability support that role.
- A semantic match whose BASE predicate does not fire is a candidate false negative, not an uncovered non-event.
- A BASE firing without independent expected applicability is a candidate false acceptance, not positive coverage.
- Contract-dependent rules require independently specified expected contract features. Running `buildQueryContract` may later measure the actual contract, but its output cannot author its own expected value.
- Preserve all unmatched cells as named gaps. Do not force corpus v0.1 to contribute coverage merely because it is already available.

## 4. Observer design finding

Selecting the exported production rule objects and invoking their existing `when` closures is consistent with the no-copy requirement, subject to the stage-placement ruling's controls:

- eligibility must exclude SQL/table-dependent rules structurally;
- SQL-independence must be proved by controls, not inferred only from absent metadata;
- source filtering must occur in the same order as production;
- exact rule identity and applicability must remain accountable;
- the full validator must never be invoked with dummy SQL.

Five contract-dependent definitions may wait until the frozen cases supply independently expected contract features. They are **pending adjudication**, not absent and not covered.

## 5. Case count

The 21-pair matrix and 42-to-63 range remain useful planning bounds, not an acceptance tally. The final number follows from independently adjudicated roles and explicitly recorded dual-purpose cases. No slot disappears merely because corpus v0.1 contributes nothing to it.

## 6. Disposition

Correct the execution record and preliminary map as above, then author and freeze the minimum case set. No owner decision is required. Do not execute the candidate stage before the independent expectations, applicability map, and hashes are frozen.

P3.2 remains unauthorized.
