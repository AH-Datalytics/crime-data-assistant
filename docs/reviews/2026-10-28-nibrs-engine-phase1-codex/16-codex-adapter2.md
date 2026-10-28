**REVISE — two remaining correctness issues.**

1. **Year-list periods still return an unclipped selection.**  
   [resolve.ts:67](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/resolve.ts:67) clips only absolute periods. “Burglaries in Texas in 2024 and 2026” passes all checks against a release ending October 2026, returning `{kind:"years", years:[2024,2026]}` plus `clippedTo:"2026-10"`. The returned selection still specifies whole years. R2’s comparison fix works, but the effective-period fix remains incomplete. Represent the clipped noncontiguous selection explicitly, or refuse this case until representable; do not replace it with a continuous range.

2. **Property averages still apply the loss filter to the incident rather than the counted property.**  
   [from-spec.ts:98](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/from-spec.ts:98) translates `loss:7` into “this incident contains some stolen property.” Consequently, “average value of stolen motor vehicles in Texas in 2025” passes validation but can include recovered/damaged motor-vehicle segments from those incidents in both operands. Termination and the motor-vehicle-specific denominator are fixed; the population restriction is not. For property dollars/segments, apply `property.loss_type = 7` directly to the counted rows. Preserve incident-scoped existence filtering when counting offenses.

The other corrections are accepted for Step 1: clearance accounting rejects the original unrequested-subset example; DUI uses Group B arrests and arrest date; `lastyear` uses the request date; clearance breakdowns match today’s compiler; link keys and preferred routes address the cited defects; reachability classifications and qualifications are corrected.

Both requested tests passed. Reachability outputs reproduced with writes intercepted, after line-ending normalization. No files edited.

**Necessity check:** Only these two semantic corrections remain necessary before acceptance: they affect which months and property records a valid plan counts. Preserve the accepted fixes; defer broader reader, compiler, and shared-schema work.
