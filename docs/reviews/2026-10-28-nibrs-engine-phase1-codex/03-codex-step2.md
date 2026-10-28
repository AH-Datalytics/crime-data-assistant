**Verdict: REVISE.** The structure is a useful foundation, but it is not yet an unambiguous contract for deterministic compilation or a lossless mapping of today’s specs.

Reviewed branch HEAD `719f991f2bc1da62d8651ff4fa8b4333ca14652f`. The supplied test passes: **16 example plans valid**. Additional read-only probes exposed validation gaps below. No files were edited.

The basic forms for N1–N3, Z, D and G1–G6 are present. **Subset ratios are expressible**: `MeasureSpec.filters` allows independently filtered numerator and denominator measures. The principal problems are their denominator semantics, coverage behavior, semantic metadata and incomplete mappings.

The following changes are required before accepting this contract.

1. **Make the semantic interface sufficient to compile measures and relationships.**  
   [semantic.ts:10](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/semantic.ts:10)

   `definition: string`, `entity`, `unit` and pairwise `cardinality()` do not specify executable measure definitions, identity keys, aggregation expressions or relationship paths. `additive: boolean` cannot describe “additive across agencies, but not across overlapping offense categories,” and validation never uses it.

   **Required:** expose typed definitions or a defined compiler-facing resolver for aggregation, distinct keys, predicates, relationship paths and supported time bases. Include explicit definitions for cleared offenses, Group A/B arrests, victim-offense pairs, property dollars and vehicle quantities. Relationship groupings must preserve the victim–offender pairing; independent joins must not manufacture combinations.

   **Consequence:** the compiler must otherwise invent or hard-code semantics outside the advertised interface, including how to avoid join multiplication. A new `clearance` counting-unit enum is not inherently necessary—cleared offenses can correctly retain unit `offense`.

2. **Validate existence filters through their actual scope and target.**  
   [validate.ts:147](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/validate.ts:147)

   Incident scope bypasses the missing-relationship check. Conditions inside `where` are checked only for dimension existence—not ownership, reachability, cardinality or era.

   A probe with `entity: "nonexistent_entity"`, incident scope and a victim dimension valid only after the requested period returned **no semantic problems**.

   **Required:** validate counted entity → scope → target entity; validate every condition relative to the target, including era and value compatibility. Require the property attribution rule for every permitted incident-property traversal; reject unsupported offense-attributed property paths.

   **Consequence:** S4–S7 currently accept filters that cannot be compiled meaningfully or that select the wrong population.

3. **Define denominator grain and aggregation explicitly.**  
   [plan.ts:186](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/plan.ts:186)

   `share` defines its denominator by summing grouped cells. That fails for overlapping `each_value` groups: one victim associated with two values contributes two denominator memberships, although the requested denominator may be one distinct victim. `denominatorMeasure` has no documented evaluation semantics.

   Separate places are also implicit result dimensions, while `partition` can name only explicit groupings. The contract does not settle whether `partition: []` spans places or remains within each place.

   **Required:** define the denominator’s retained dimensions, independently evaluated measure/filters, aggregation and implicit place behavior. Support distinct-population denominators without summing overlapping cells. Validate partition uniqueness and numerator/denominator compatibility according to the requested statistic.

   P6 also uses array length to identify “every grouping”: three repetitions of `time.month` are falsely diagnosed as an all-dimensions partition. Use sets. An intentionally requested 100% share is not inherently invalid.

   **Consequence:** valid-looking plans can silently answer a different share question, especially with multiple places or relationship/weapon groupings.

4. **Separate cohort selection from evidenced completeness and define rate fallbacks.**  
   [plan.ts:211](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/plan.ts:211)

   `complete_periods` means every month is “known”; D6 requires **submission completeness evidence**, which positive crime rows do not establish. P10 also accepts `same_agencies` for rates without independently requiring completeness.

   R requests observed counts alongside unavailable rates, but its single plan-wide complete cohort does not explain how the observed count survives exclusion. S4 requires the eligible cohort’s count when its population is unavailable—a different fallback.

   **Required:** specify:
   - completeness separately from stable cohort membership;
   - eligibility over each requested elapsed period, including partial periods;
   - matched numerator/population eligibility;
   - observed versus eligible-cohort count outputs;
   - D8’s unavailable-rate reason and retained count;
   - partial-period rates without silent annualization;
   - all-resident denominator labeling for S5.

   Either remove `census_resident` from v1 rates or define when it is compatible with D8’s covered-cohort denominator.

   **Consequence:** R and S3–S5 are not presently determined exactly by the contract.

5. **Give derived statistics stable identities and transforms explicit targets.**  
   [plan.ts:193](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/plan.ts:193) and [validate.ts:97](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/validate.ts:97)

   `top_n.by` resolves measure names and ratio aliases, but rates and shares have no aliases. A plan displaying both count and rate cannot explicitly rank by the rate. Rolling and comparison transforms do not identify their target statistics; summing monthly rates or averaging percentages can produce wrong results.

   **Required:** identify statistic outputs uniquely, target transforms explicitly, define aggregation/recomputation rules, and validate alias collisions and transform ordering. Add an unbounded ordering form for today’s `RankSpec.rank.n === null`; `top_n` alone cannot preserve it without inventing a limit.

   **Consequence:** N6 rankings and combinations of multiple measures, rates, rolling windows and comparisons remain ambiguous or lossy.

6. **Close period-validation gaps and preserve H1’s actual default.**  
   [plan.ts:86](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/plan.ts:86), [validate.ts:167](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/validate.ts:167), [examples.ts:64](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/examples.ts:64)

   Negative last-N counts pass. Relative periods bypass full era checks; `since` checks only its starting year. Comparison periods need not lie within the enclosing period, and relative comparisons never receive resolved overlap checks.

   H1 uses `latest_complete_year`, whereas the accepted fixture explicitly says its 2025 default is a **calendar reading rule, not evidenced completeness**.

   **Required:** require positive integer counts; define a mandatory release-resolved validation stage before compilation; check full periods, comparison containment/order and era validity there. Define H1’s calendar default distinctly or explicitly declare its change. Document an exact mapping for noncontiguous `NPeriod.years`, rather than expanding it silently into a range.

   **Consequence:** invalid historical requests can pass, and the frozen default can change meaning.

7. **Enforce combined-place semantics after geography resolution.**  
   [validate.ts:58](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/validate.ts:58)

   P3 rejects national combinations but accepts Maryland plus Baltimore, duplicate agencies and intersecting agency sets. The type comment promises nonoverlap without enforcing it.

   **Required:** define combined totals as either a deduplicated union of resolved memberships or an explicitly checked disjoint combination. Validate membership overlap after resolution, and keep D8 population overlap handling separate from count deduplication.

   **Consequence:** currently accepted combinations can count the same records twice.

8. **Provide a real runtime shape/value boundary, including age bins.**  
   [validate.ts:46](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/validate.ts:46)

   `validatePlanShape` assumes a correctly shaped TypeScript object; `{}` throws. Fractional top-N values pass. Agency predicates are unchecked. Bins are checked only for an empty array—not numeric applicability, reversed/overlapping ranges or boundary interpretation.

   **Required:** validate reader JSON before these checks, including discriminants, required fields, finite integers, predicate/operator combinations and bin rules. Define numeric decoding for age codes/ranges and special unknown values before binning; `numeric?: boolean` is insufficient to establish that behavior.

   `YearMonth = \`${number}-${number}\`` accepts malformed months at compile time. Runtime validation remains essential; a branded validated string and discriminated relative-period/filter types would reduce invalid construction.

   **Consequence:** malformed plans can crash validation, while accepted age-bin plans can classify unknown codes as ages or double-count boundaries.

9. **Preserve request accounting by value, not merely by span.**  
   [validate.ts:160](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/validate.ts:160)

   A binding to `no.such.path` passes A1. Matching spans alone does not verify that the correct concept/value was applied. `PartRef` also drops clause and inherited-context identity from today’s ledger.

   **Required:** retain authoritative ledger identity, validate binding targets and require concept/value-compatible application evidence. Preserve clause handling and inherited parts; a binding must not turn an unsupported condition into “applied.”

   **Consequence:** the advertised “nothing is dropped” safeguard can approve an unfiltered answer to a filtered question.

10. **Complete the examples, mapping and mandatory provenance contract.**  
   [plan-language spec:72](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/docs/superpowers/specs/2026-10-28-nibrs-plan-language.md:72) and [test script](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/scripts/test-nibrs-plan-language.ts)

   **Required:** add focused contract examples for S1–S5, G1–G6 and the uncovered typed forms: subset/clearance shares, clearance breakdowns, Group B arrests, date bases, property total/average value, noncontiguous years and ranked rates. Correct the mapping’s reference to a `partition` on `ratio`, which has no such field. Average property value can use a ratio, but its exact denominator must be specified.

   Define required downstream provenance now: release/semantic versions, resolved interpretation, compiled query, denominator/cohort, transformations/truncation, national reported-count labeling and unavailable-rate reasons. These may belong in a compiler/result envelope rather than model-filled fields.

   **Consequence:** the present passing tests establish selected examples and selected rejection branches, not the claimed complete mapping or answer contract.

Optional improvements are stronger compile-time nonempty-array/path types and more ergonomic builders. They are not substitutes for runtime checks and need not block acceptance once the concrete failures above are fixed.

**Necessity check:** revise the contract and add targeted regression examples now because these gaps change answers or force compiler guesses. Defer SQL implementation, live-data execution, performance testing, presentation polish and broad product certification. No new raw-data investigation is needed for this review.
