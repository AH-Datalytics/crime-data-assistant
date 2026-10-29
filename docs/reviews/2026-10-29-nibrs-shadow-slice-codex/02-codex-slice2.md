Codex asked one question first:

> P28’s CSV says the 100,000 floor applies to the county agency’s population, while your message describes city/county residents. These differ: the fixture gives St. Louis County, MN’s agency 56,832, but the county has about 200,000 residents. Which population should determine the buttons?
> - Agency service population, as the CSV states
> - Whole city/county population

Answer given: agency service population, as P28 records ("the same 100k floor for county and city agencies").

**REVISE.** The delivery fixes are sound, and P28’s agency-service-population threshold is authorized. Two issues remain: scoring still overclaims verification, and D28 still offers choices when every choice declines.

No files were edited; the working tree remained clean.

1. **P1 — Review item 2 is only partially fixed: continuation scoring still misses failures.**  
   [shadow.ts:128](C:/Users/jeffm/cda-compiler/lib/answer-eval/shadow.ts:128), [gates.ts:86](C:/Users/jeffm/cda-compiler/lib/answer-eval/gates.ts:86)

   Direct button answers now have their values, statuses and contract problems checked. Numeric mismatches correctly become `wrong_answer`. However:

   - **Nested continuations are not checked.** LS-140 stops at “which range of years.” Removing both nested period menus entirely still scores `correct`. V15 remains keyed as `LS-140|Every year available`, although that answer now sits behind the city button; it is never consumed.
   - **Unverified button answers do not prevent “wrong answers: pass.”** That gate only counts unverified results whose initial action is `answer`. The report therefore passes this category for cases with explicitly unmeasured continuation values.
   - **Wrong continuation meaning is only `incomplete`.** Changing LS-233’s latest-year continuation to Detroit, while retaining matching numeric cells, produces a material place mismatch but still passes the zero-wrong-answer category.
   - **Continuation answer text is not checked.** Replacing LS-233’s delivered text with incorrect text still scores `correct` when cells match. `statementDiffs` runs only for direct answers.

   **Necessary correction:** include delivered descendants in verification and wrong-answer accounting. Wire V15 to its nested path. Where nested meaning or required text cannot yet be checked, report **unverified**, rather than correct. A broader evaluation-schema rebuild is unnecessary for that conservative correction.

2. **P2 — D28’s “no choice could answer” rule depends on identical refusal wording.**  
   [answer.ts:123](C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/answer.ts:123)

   Reproduced with **“Shoplifting arrests in Washington in 2024.”** The shadow asks which Washington, but:

   - Every agency choice declines because arrests are unsupported.
   - The state choice declines because state totals are unsupported.

   Since those explanations differ, the question survives the collapse check even though no choice answers it.

   **Necessary correction:** determine whether any choice can provide a useful continuation, rather than comparing explanation strings. This is a bounded policy fix; it does not require implementing arrests or state totals.

3. **The other original findings are resolved.**

   | Original item | Re-review |
   |---|---|
   | 1 — Invalid delivery | **Fixed.** Unsupported breakdowns/shares/rates decline; contract problems prevent delivery. |
   | 2 — Continuation scoring | **Partial**, as above. |
   | 3 — Place ambiguity | **Fixed under clarified P28.** The threshold now has authorization; New York offers city/state. |
   | 4 — Clarification ordering | **Fixed for the original failures.** Unrecordable requests decline first; unsupported breakdowns no longer silently answer a default year. |
   | 5 — P11 carjacking victims | **Fixed.** Converts to offenses with the fixed sentence; property classification is explicit. |
   | 6 — Unsupported evidence wording | **Fixed.** Unknown totals and conflicts use appropriately limited explanations. |
   | 7 — Future-month wording | **Fixed.** November 2026 is named accurately. |

   P28 pins preserve the selected agency through a subsequent period choice. The checked Baltimore city/county, Columbus and New York continuations retain the requested measure and period. Under your clarified agency-population rule, excluding St. Louis County, Minnesota is correct.

   `property_counted_by_offense` remains appropriately authorized without becoming universally plan-required. Delivery still uses fixed templates and places the source statement last.

4. **Independent values and reporting: accepted evidence, with the scoring limitation above.**

   I read V1–V15 from nibrs-model `main` at `d8f514500b58cce6966fae47ef0788ca125e6f89`, inspected their raw-source provenance, and reran the 41 selected cases against the pinned canonical release without writing reports.

   The run reproduced the checked-in outcomes. **Every value/status comparison actually performed against an independent fixture matched.** This does not mean every delivered answer was measured: several new candidate answers lack fixtures, and nested V15 is skipped.

   Coverage, confusion matrices, provisional labels and the separate not-built exclusion remain visible. All four targeted test scripts passed. I found no new numerical mismatch in the comparisons performed.

5. **Labels: ACCEPT all nine under the clarified agency-service-population rule.**

   | Label | Verdict |
   |---|---|
   | LS-233 | **ACCEPT** — latest complete year is named; meanings preserved. |
   | LS-140 | **ACCEPT** — city/county first, period next; scoring must inspect subsequent continuations. |
   | LS-151 | **ACCEPT** — P28 supersedes the former direct-answer label; the reader’s spelling failure remains a candidate failure. |
   | LS-223 | **ACCEPT** — Baltimore city/county, monthly period retained. |
   | LS-224 | **ACCEPT** — Missouri city/county candidates; carjacking offenses and years retained. |
   | LS-242 | **ACCEPT** — Baltimore candidates. |
   | LS-243 | **ACCEPT** — Washington state plus qualifying agency candidates. |
   | LS-244 | **ACCEPT** — Columbus, Ohio and Georgia. |
   | LS-245 | **ACCEPT** — New York city/state under P26/P28. |

   LS-224’s note should ideally say Minnesota’s **sheriff’s service population** is below 100,000, rather than the county itself. That wording correction does not block label acceptance.

**Necessity check:** fix the scoring overclaims and the all-decline clarification before accepting this revision. Preserve the accepted delivery fixes, labels and independent-value evidence. Defer reader expansion, additional capabilities and broader certification; the shortest route is conservative unverified scoring where coverage is incomplete, plus the bounded D28 correction.
