**Verdict: REVISE.** The tests pass and reachability counts reproduce, but several accepted plans change meaning, and two implementation defects need correction before this adapter is a dependable bridge.

1. **P1 — Average-value adaptation does not terminate.**  
   In [from-spec.ts:193](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/from-spec.ts:193), the loop iterates `measures` while the `average_value` branch appends another measure. Every appended segment measure enters that same branch and appends another. Today’s matcher produces this spec for “average value of stolen property in Texas in 2025.” Iterate a fixed set of numerator measures. Also preserve the numerator’s population in its denominator: motor-vehicle property value must divide by motor-vehicle property segments, not unrestricted `property.segments`. Leaving this unchanged makes a supported adapter input hang or exhaust memory.

2. **P1 — R1 records clipping without returning a clipped period; noncontiguous comparisons can pass outside the release.**  
   [resolve.ts:53](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/resolve.ts:53) computes a local clipped endpoint but returns the original `period`. I reproduced:
   - Requested `2025-01..2026-12`, release ending `2026-10`: no problems, returned period still ends in December.
   - Selected years `[2024, 2026]`, comparison’s later period `2026-11..2026-12`: no problems despite both months being outside the release.

   Return the effective selected months and use that selection consistently for R2 and geography resolution. Merely adding `clippedTo` leaves contradictory compilation/provenance inputs and permits unavailable comparison periods.

3. **P1 — The relaxed measure-accounting rule accepts an unrequested clearance restriction.**  
   [validate.ts:351](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/validate.ts:351) unconditionally treats `<offense>_cleared` as applying `<offense>`. I adapted “How many burglary offenses in Texas in 2025,” replaced its measure with `offenses.burglary_cleared`, and obtained **no shape, semantic, or binding errors**. That answers a subset instead of the requested total. Permit this equivalence only when the request supplies the clearance restriction. The `clearance_method` and location-name mappings themselves look reasonable.

4. **P1 — The draft layer gives DUI plans the wrong entity and time basis.**  
   [draft-layer.ts:73](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/draft-layer.ts:73) generates `arrests.dui` on the Group A `arrestee` entity; [from-spec.ts:294](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/from-spec.ts:294) assigns every plan `incident_date`. Replay **9626**, “DUI arrests by age group nationally,” passes with exactly this interpretation. DUI is Group B; the accepted language already distinguishes Group B arrests and arrest date. Correct that mapping or explicitly mark it unmapped. Otherwise reachability endorses a plan over the wrong population.

5. **P2 — `lastyear` silently changes the existing reader’s period semantics.**  
   [from-spec.ts:77](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/from-spec.ts:77) maps it to the latest complete release year. Today’s compiler uses `now.getFullYear() - 1`. Replay **9905**, convenience-store burglaries in Texas “last year,” happens to agree for the pinned October 2026 release, but diverges for a stale release or a release through December of the current year. Preserve the calendar-relative meaning using an explicit reference date, or record and obtain agreement on this semantic change. The existing plan-language mapping does not establish fidelity to today’s behavior.

6. **P2 — Reachability claims exceed what the classification establishes.**  
   [nibrs-plan-reachability.ts:34](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/scripts/nibrs-plan-reachability.ts:34) classifies generic matcher failures such as “I couldn’t use it in a supported question type” as removed table limits. Replays **9561/9565** fail on the word “state”; **10559** splits a requested month range into conflicting periods. Those are reader failures, not demonstrated table limitations.

   Replay **10617**, “vehicle burglaries with a firearm stolen per month,” is `plan_valid` but means **firearm used + some property stolen**, rather than firearm property stolen. That misunderstanding originates upstream, but contradicts “today’s reader understands it.” Keep structural validity separate from audited question fidelity, qualify the claimed **46 additional answers**, and correct the decline classifications. No matcher overhaul is necessary for this step; documented exceptions and accurate labels suffice.

7. **P2 — The draft link definitions are misleading as shared-schema input.**  
   [draft-layer.ts:31](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/draft-layer.ts:31) gives every link only `incident_num` as its join key, including links declared one-to-one that also require agency/year and entity-specific keys. Its shortest-path selection can reach offense attributes from a victim through all incident offenses instead of that victim’s offense associations. Null measure predicates are explicitly disclosed and acceptable for this stage; false join/cardinality metadata is different because validation relies on it. Correct the relationships needed by current plans, or explicitly exclude those checks from the evidence claimed.

Spot-checks that looked sound included **8750** cleared-by-arrest vehicle burglaries, **8818** prosecution-declined share of rape clearances, **8886** Texas city rankings with the population floor, **9243** the recovered “were cleared” wording, and **10499** exceptional clearances divided by all rape offenses.

Numeric age-bin boundaries match today’s groups, but keeping infant special codes separate changes today’s SQL grouping behavior. That follows the accepted plan language; document it as an intentional difference rather than exact fidelity. The README also overstates its breakdown-rate finding: the violent-crime example returns `spec_unmapped`, not an A1 refusal.

Validation performed: both requested test scripts passed. I reran reachability with filesystem writes intercepted in memory; `results.json` and `summary.md` reproduced after line-ending normalization. No files were edited.

**Necessity check:** Fix the nonterminating adapter, incorrect period/accounting acceptance, and wrong DUI mapping now; reconcile period fidelity and qualify the measurement/schema claims before accepting Step 1. Defer SQL execution, full matcher repair, complete semantic predicates, and general product certification.
