**Verdict: REVISE.** R2 resolves the original probes and substantially improves the contract, but several answer-changing gaps remain.

Reviewed `a1fdf1d2bff35555062a803697b515cb5c8f5b33`, including `HEAD~1..HEAD`. The supplied test passes: **33 plans and 6 reader outcomes**. No files were edited.

All eight earlier probes now behave correctly:

| Probe | R2 result |
|---|---|
| Nonexistent existence entity | Rejected, S4 |
| Era-invalid existence condition | Rejected, S7 |
| `{}` input | Rejected by `parsePlan`, P0; no crash |
| Negative `last_n` | Rejected, P0 |
| Fractional limit | Rejected, P0 |
| Triple `time.month` in `within` | Rejected as duplicates, P6 |
| `no.such.path` binding | Rejected, A2 |
| Maryland + Baltimore combined | Accepted as a deduplicated union: 3 memberships → 2 agencies |

Status of the original ten requirements:

| # | Requirement | Assessment |
|---|---|---|
| 1 | Compiler-facing semantic interface | Mostly met; link lookup remains incomplete |
| 2 | Scoped existence validation | Original scope/entity defects fixed; value validation remains incomplete |
| 3 | Independent denominators | Counted-unit shares fixed; summed measures need clarification |
| 4 | Completeness, cohorts and rate fallbacks | Met at contract level |
| 5 | Named statistics and transform targets | Basic forms fixed; transform composition remains ambiguous |
| 6 | Period validation and H1 | H1 fixed; resolved validation still has gaps |
| 7 | Combined-place overlap | Met for contiguous periods |
| 8 | Runtime shape/value boundary | Substantially met; silent field stripping remains |
| 9 | Accounting by value | Not met |
| 10 | Examples, mapping and provenance | Provenance added; examples still contain material mismatches |

The following are the remaining required changes, consolidated around the existing implementation.

1. **Finish value-based accounting; it still approves contradictory plans.**  
   [validate.ts:238](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/validate.ts:238)

   Additional probes returned **no problems** for:
   - `state:Texas` bound to Maryland;
   - `sex:F` bound to `not_in: ["F"]`;
   - monthly grain bound to `time.year`;
   - an unsupported `immigration-status` concept bound to `question`.

   Conversely, the valid unit `dollars` is rejected because singularization produces `dollar`.

   **Required:** replace permissive suffix/path checks with explicit concept/value mappings. Check geography identity, filter operator and negation, grain, statistic, ranking parameters, thresholds and all supported period forms. Unknown concepts must not pass merely because their path exists. Use explicit unit mappings. Preserve support for valid mapped filters such as clearance reasons and age ranges.

   **Why necessary:** A1–A4 still allow precisely the dropped-or-swapped restrictions this safeguard must prevent. These are demonstrated failures, not optional robustness.

2. **Apply value and era checks consistently, including after resolution.**  
   [validate.ts:159](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/validate.ts:159) and [resolve.ts:55](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/resolve.ts:55)

   Plain attribute filters bypass the code checks inside `exists.where`. Both an invalid code and a code used before its `valueYears` passed my probes.

   Relative existence filters also bypass code-era validation: a `since: 2010` plan using a code introduced in 2020 passed both semantic and resolved validation. R1 rechecks dimension eras, but not code eras.

   **Required:** share one attribute-value validator across global filters, measure filters and existence conditions; run its era-sensitive checks against the resolved period. Include numeric/operator compatibility and reversed `between` bounds.

   **Why necessary:** otherwise accepted plans can manufacture zero counts from invalid codes or apply historical meanings outside their valid eras.

3. **Validate noncontiguous periods as selected periods, not their bounding range.**  
   [resolve.ts:53](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/resolve.ts:53)

   A plan selecting `[2019, 2024]` accepted a comparison whose earlier period was **2020**. R2 checks only the enclosing span. R3 and R4 likewise iterate every intervening year, including unrequested years.

   **Required:** check comparison containment against actual selected months/years. Resolve geography and calculate combined-membership provenance only for selected years.

   **Why necessary:** comparisons can use periods excluded by the plan, and geography can be considered resolved solely because it existed in an unrequested year.

4. **Reject unknown reader fields instead of silently stripping them.**  
   [plan.ts:98](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/plan.ts:98)

   Zod’s default object behavior silently removes unknown keys. An attribute filter containing `negate: true` parsed successfully, with negation removed.

   **Required:** make reader-facing objects strict, including nested filters, periods, statistics and outcomes. An unsupported field must produce a P0 problem.

   **Why necessary:** successful parsing currently changes a model’s expressed restriction without disclosure.

5. **Complete the executable semantic-definition interface.**  
   [semantic.ts:28](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/semantic.ts:28)

   `SemanticPredicate.exists` names a `link` ID, but `SemanticLayer` exposes only `path(from, to)`. The predicate supplies no target entity, and the interface offers no `link(id)` lookup.

   **Required:** expose link lookup or carry a resolvable target/path in existence predicates. Add one non-null measure predicate example that exercises this contract; the test layer currently gives every measure `predicate: null`.

   **Why necessary:** the compiler cannot resolve the advertised executable measure definitions solely through this interface. No SQL implementation is needed to close this gap.

6. **Settle derived-output targeting and aggregation semantics.**  
   [plan.ts:164](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/plan.ts:164) and [plan.ts:190](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/plan.ts:190)

   A comparison can produce `earlier`, `later`, `change` and `pct_change`, followed by a rank targeting the original statistic name. That plan passes, but does not say **which comparison output** determines rank.

   Also, share denominators are described as “counted as distinct units,” although measures may aggregate dollars or vehicle quantities. Such denominators must evaluate the measure’s aggregation over deduplicated rows, not count property segments.

   **Required:** identify comparison outputs explicitly for downstream transforms, or reject ambiguous compositions in v1. State that independent denominator evaluation preserves the measure’s aggregation. Specify transformed rate eligibility/population over the resulting period rather than leaving “transformed denominators” open to summing monthly populations.

   **Why necessary:** different reasonable compiler implementations can produce different answers from the same accepted plan. Rejecting unsupported compositions is a smaller acceptable fix than expanding the language.

7. **Correct the examples that currently claim more than they express.**  
   [examples.ts:144](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/examples.ts:144), [examples.ts:228](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/examples.ts:228), [examples.ts:293](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/examples.ts:293)

   - **S4** asks for state and agency rates but groups only by agency. Add a separate state-total plan covering the accepted D8 fallback.
   - **PAIRED_RELATIONSHIP** asks for murder victims but counts victim-offender pairs. Preserve distinct victims per paired grouping, and keep a separate explicitly worded pair-count example if useful.
   - **PROPERTY_VALUE** asks for stolen vehicles but filters only automobiles (`03`). Align its wording or its filter with the intended population.

   **Why necessary:** these examples are described as reader target outputs. Passing them currently endorses lost output scope or a changed counting unit/population.

Optional work remains deferred: stronger result-envelope discriminated types, exhaustive combinatorial testing, production semantic definitions, SQL generation and performance testing.

**Necessity check:** preserve the accepted r2 structure and fixes. The remaining work is limited to demonstrated validation failures, unresolved compiler semantics and misleading acceptance examples; each can change the next compiler’s answers. No new architecture, raw-data investigation or broad certification is needed.
