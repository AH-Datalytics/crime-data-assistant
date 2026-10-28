**ACCEPT**

1. G1, G2, G5/R6 and G8 implement the approved scope. NIBRS era restrictions remain enforced by the layer/release, all current NIBRS measures remain monthly, and statement requirements and wording are unchanged.

2. Both plan-language and adapter tests pass. Fresh HEAD snapshot: **289 entries, byte-identical to `g-before.json`** after stripping `source`.

3. Reachability across **605 questions** reproduces both fixtures byte-for-byte, including the existing two invalid plans. Outputs were compared in memory; no files edited.

**Necessity check:** No changes are required. The code review and regression evidence support unchanged NIBRS behavior for this scope; broader source implementation remains deferred.
