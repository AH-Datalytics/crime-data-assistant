**Verdict: REVISE.** The separation of table values from server-side evidence is right, but the claimed enforcement has gaps and the specifications still conflict.

1. **The column-name guard both accepts annotations and rejects legitimate groupings.** In [result.ts:83](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/result.ts:83), reproduced:
   - Accepted: `Availability` grouping containing `"UNAVAILABLE"`.
   - Accepted: `dataNote` grouping containing `"No eligible agencies"`.
   - Accepted: numeric header `"Murder victims (data incomplete)"`.
   - Rejected: legitimate `"Exceptional clearance reason"` grouping containing `"Prosecution declined"`.

   Tie columns to the plan’s actual groupings/statistics and distinguish annotations by purpose, rather than forbidden words. Otherwise implementation can expose evidence while refusing valid breakdowns.

2. **The full result contract is not enforced.** [result.ts:77](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/result.ts:77) permits arbitrary `answerStatements: string[]`; the checker never examines statements or evidence. Consequently, an unavailability explanation can enter answer text, and a zero paired with `UNKNOWN` evidence cannot be rejected. Duplicate column names also pass, making name-keyed evidence ambiguous.

   Constrain statements to the two authorized meanings and specify an envelope-level check for unique cell identities, evidence completeness, and status/value consistency. The table checker can remain a structural check, but should not claim that an empty result proves the entire owner rule.

3. **Remaining normative text still directs status presentation.** The [semantic definitions:269](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/docs/superpowers/specs/2026-10-28-nibrs-semantic-v1-definitions.md:269) explicitly say the answer communicates uncertainty “through the UNKNOWN status.” The [plan-language spec:203](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/docs/superpowers/specs/2026-10-28-nibrs-plan-language.md:203) still leaves unknown-cell wording undecided. Reconcile these with blank numeric cells and server-side evidence; likewise clarify the remaining “rate, or the reason” example comments. Otherwise a compiler implementer receives contradictory requirements.

The rate changes themselves correctly specify NULL for unavailable numbers and keep cohort figures/reasons internal. The two prescribed answer statements are compatible as explanatory text; unrestricted strings are the gap. Legitimate category labels—including an unknown demographic category—are not unknown numeric values and should remain allowed.

**Validation:** The requested test command passed: 35 plans and 6 reader outcomes. Additional in-memory probes confirmed the guard failures above. No files were edited.

**App consistency:** The remote branch was unavailable locally. Its local branch/worktree contains the comparison plan, but no `lib/answer-columns.ts` implementation. That plan explicitly preserves substantive `clearance_status` and `*_label` groupings, contradicting this commit’s regex. Claims that the app already enforces the contract should therefore be qualified.

**Necessity check:** Resolve the guard’s semantic distinction, the unchecked envelope invariants, and contradictory presentation instructions before accepting this design. Full compiler implementation, UI/export certification, and broader robustness work can wait.
