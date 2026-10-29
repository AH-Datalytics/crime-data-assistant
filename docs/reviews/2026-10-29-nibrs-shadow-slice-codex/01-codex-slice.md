**REVISE.** Commit `6c84609` can deliver malformed answers and unsupported factual explanations, and its scoring can call unverified continuations correct. The zero-wrong-factual-answer gate is not established.

I reviewed the commit against `d801699` without editing files. Concurrent edits appeared during review; this verdict concerns **the committed version**, not those edits.

1. **P1 — Invalid results escape `checkEnvelope`.**  
   [deliver.ts:74](C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/deliver.ts:74) renders only a time key and the first statistic, although the compiler accepts attribute breakdowns and shares. Contract errors are returned as metadata rather than preventing an answer.

   Reproduced against the pinned canonical release: **“Simple assault victims in Detroit by sex in 2023”** returns rows `[[11408], [4746], [null]]` under two columns, omits sex categories and shares, says **“by year”**, and prints **“No data for undefined.”**

   **Necessary fix:** restrict the shadow to delivery-supported shapes before execution, and prevent any result with contract problems from becoming an answer. Supporting breakdown delivery can wait.

2. **P1 — Continuation scoring gives unverified answers correctness credit.**  
   [shadow.ts:77](C:/Users/jeffm/cda-compiler/lib/answer-eval/shadow.ts:77) checks continuation meaning, but not values, delivered statements or contract problems. Consequently, the gates do not include those delivered answers in their numeric or zero-wrong-answer accounting.

   With deliberately arbitrary continuation values and no independent expectations, **LS-233 and LS-236 both scored `correct`**, with “wrong answers: pass” and clarification/decline “verified correct.” The overall numeric gate remained NOT MEASURED, but those component claims are still false.

   **Necessary fix:** account for answers inside options and alternatives; missing independent values must remain unverified. Also compare entry prompts with `next_about`: currently any nonempty `entry` passes.

3. **P1 — Place resolution applies an unapproved default and misses a decided ambiguity.**  
   [places.ts:52](C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/places.ts:52) treats the proposed population threshold as executable authority. **“Shoplifting in Portland in 2024”** answers Oregon without asking. More decisively, **“Shoplifting in New York in 2024”** answers NYC, contrary to P26’s required city/state choice.

   **Necessary fix:** honor explicit ambiguity rules and avoid treating the proposed threshold as an approved D28 default. This needs a bounded resolver correction, not a nationwide geography certification.

4. **P2 — Clarification ordering violates D31 and the stated decline-first rule.**  
   In [answer.ts:137](C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/answer.ts:137), missing-period clarification applies only to `series`. **“Simple assaults in Detroit by sex”** silently selects 2025.

   Separately, the city-choice return precedes the not-recorded check. **“Shoplifting in Kansas City by ZIP code in 2024”** asks which Kansas City, although both choices necessarily decline under D02.

   **Necessary fix:** check unrecordable requests before place clarification, and check missing periods across supported reader forms before defaults.

5. **P2 — P11’s implementation does not cover carjacking victims.**  
   [answer.ts:169](C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/answer.ts:169) depends on `MEASURE_CODES[name]`. **“How many carjacking victims in Memphis in 2024?”** declines because `victims.carjacking` has no executable definition, instead of applying the property-crime offense conversion and fixed sentence.

   The predicate also equates “not entirely person-offense codes” with “property crime,” which is too broad for crimes against society.

   **Necessary fix for claimed P11 fidelity:** use the actual crime classification, including carjacking. This is a policy failure, not evidence of a wrong delivered count.

6. **P1 — Fixed templates still make unsupported factual claims.**  
   [deliver.ts:91](C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/deliver.ts:91) explains every null total as reports failing to cover every month. But the compiler also makes totals unknown when a reporting month contains no evidenced count for the selected measure. Likewise, `UNKNOWN` does not establish that the agency “reported nothing.”

   The `refuseOn` branch correctly withholds numbers, but its explanation says the month was “reported as having none” even when the conflicting status was UNKNOWN.

   **Necessary fix:** use wording supported by the evidence. A conservative “the available evidence does not establish this count” is sufficient; richer diagnostics can wait.

7. **P2 — Future-month refusals misstate coverage.**  
   [answer.ts:183](C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/answer.ts:183) describes an unavailable period using only its year. **“Shoplifting in Memphis in November 2026”** produces **“2026 is not in the data; the latest month available is October 2026.”**

   **Necessary fix:** name the requested month/range accurately. Current-year clipping is disclosed in the delivered text; that does not repair this false refusal explanation.

8. **Labels — one required change; retain the other expected outcomes.**  
   I checked all 23 against their cited policies. These verdicts concern labels, not whether the candidate passes them.

   | Case | Verdict | Policy basis / change |
   |---|---|---|
   | LS-219 | ACCEPT | Shoplifting offenses; principal agency; source last |
   | LS-220 | ACCEPT | Same meaning, paraphrase |
   | LS-221 | ACCEPT | Explicit Tennessee |
   | LS-222 | ACCEPT | P11 offense conversion and fixed sentence |
   | LS-223 | ACCEPT | Monthly series; missing periods disclosed |
   | LS-224 | ACCEPT | Carjacking offenses; yearly series |
   | LS-225 | ACCEPT | Carjacking offenses; monthly series |
   | LS-226 | ACCEPT | Explicit simple assault, counted by victim |
   | LS-227 | ACCEPT | Explicit victims and monthly grouping |
   | LS-228 | ACCEPT | Theft-from-vehicle offenses; Columbus, Ohio |
   | LS-229 | ACCEPT | D19 requires both drug categories |
   | LS-230 | ACCEPT | D06 year-to-date, months named |
   | LS-231 | ACCEPT | Material Kansas City ambiguity; preserve measure/year |
   | LS-232 | ACCEPT | P12 missing-place choices |
   | LS-233 | **FIX** | P06 requires the latest complete year **named**. Require “2025” for this release, while retaining the relative meaning. The scorer must accept that compliant label. |
   | LS-234 | ACCEPT | P06 trend choices; monthly grouping retained |
   | LS-235 | ACCEPT | D09 choices; Historical for completed-year standard counts |
   | LS-236 | ACCEPT | P24 decline, latest coverage and same-question alternative |
   | LS-237 | ACCEPT* | Keep full-data expectation separate from build limitation |
   | LS-238 | ACCEPT | D02 decline and stop |
   | LS-239 | ACCEPT | Court-outcome decline; arrests alternative consistent with existing LS-201 |
   | LS-240 | ACCEPT | P20 forecast decline and recent-trend alternative |
   | LS-241 | ACCEPT | Explicit arrests remain arrests |

   *LS-237’s asserted Memphis 2012 availability is not established by this 2017–2026 build. Acceptance does not certify that availability or its values.*

The authorized, question-dependent `property_counted_by_offense` addition to `result.ts` is sound: it should not become universally plan-required. Answer text is built from fixed templates, and the source comes last. Unknown counts remain null in the compiler paths inspected, and `refuseOn` is enforced before delivery.

Reporting does expose execution coverage, label eligibility, confusion matrices, provisional cases and the separate not-built refusal. The checked-in report shows 37 executed cases, one excluded as not built, 14 reviewed results and 22 provisional results. Its recorded reader/capability failures should remain failures—not be relabeled to match the candidate. The carjacking equality check supports that specific equivalence; it does not independently verify every delivered answer.

The shadow, compiler, case-schema and evaluation-runner tests passed. The canonical breakdown reproduction demonstrates a gap those tests miss. Independent numeric correctness remains **NOT MEASURED**.

**Necessity check:** correct unsafe delivery, unsupported factual wording, ambiguity handling and scoring overclaims before accepting this slice under the hard gate; correct the bounded policy defects and LS-233 for policy acceptance. Defer broader compiler coverage, reader expansion and product certification. Existing honest refusals can remain recorded evaluation failures; they do not justify another general rebuild.

Codex session ID: 01a187dd-8c1e-7750-8504-c919751044a4
Resume in Codex: codex resume 01a187dd-8c1e-7750-8504-c919751044a4
(node:83580) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
