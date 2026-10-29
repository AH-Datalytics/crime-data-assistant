**ACCEPT all 13 semantic labels. The must-answer list is adequate for increment 1**, with LS-279 conditional as specified. No files were edited or evaluations run; reviewed HEAD `ddd0942` and plan r2.

| Case | Verdict | Reason |
|---|---|---|
| LS-271 | ACCEPT | Simple assault **victims**, grouped by race: D18 and NIBRS detail. |
| LS-272 | ACCEPT | Aggravated assault **victims**, grouped by sex. Being a Part I crime does not make its victim breakdown a Historical total. |
| LS-273 | ACCEPT | Simple assault **victims**, grouped by ethnicity; Louisville Metro is the intended principal agency under P16. |
| LS-274 | ACCEPT | Shoplifting **offenses**, grouped by offense location type. |
| LS-275 | ACCEPT | Theft-from-motor-vehicle **offenses**; “by location” reasonably means location type here. |
| LS-276 | ACCEPT | Murder **victims**, grouped by race, in the explicitly selected NIBRS context. |
| LS-277 | ACCEPT | Victims by race over the combined 2021–2023 period; no yearly grouping was requested. |
| LS-278 | ACCEPT | “Male or female” reasonably requests separate sex counts. Keep the sex grouping, without a filter excluding unknown or unrecorded sex. |
| LS-279 | ACCEPT | Separate race breakdowns for each year, with missing periods distinguished from zero. Conditional inclusion in this compiler increment does not make the intended meaning conditional. |
| LS-280 | ACCEPT | Victims by age is the correct eventual answer; retain refusal for increment 1. |
| LS-281 | ACCEPT | Robbery **offenses** by weapon, under D18. Retain refusal; multi-value semantics belong to the later increment. |
| LS-282 | ACCEPT | Victims jointly grouped by race and sex. Retain refusal for this increment. |
| LS-283 | ACCEPT | Carjacking **offenses**, grouped by those offenses’ location types. Retain the stipulated increment-1 refusal. An incident-level interpretation must not replace this label. |

The shared category statement is consistent with [result.ts](/C:/Users/jeffm/cda-compiler/lib/nibrs-plan/result.ts:6): **unknown/not-recorded attribute categories are grouping data**, so they can have their own rows. Unavailable **numbers** remain blank; reporting statuses must not become categories, note columns, or status columns. “Never dropped” preserves category data—it does not authorize manufacturing numerical zeros.

D29 supports category-and-number tables, and D30 supports the source-last expectation. One citation nuance: P01 also routes homicide victim details to Homicide Reports. LS-276 and LS-278 remain correct because these fixtures explicitly select `tab: "nibrs"`; P02 supports that advanced-source choice. They should not be treated as evidence that automatic routing always sends homicide details to NIBRS.

The cases cover all four promised dimensions, person/property units, Part I victim detail, a combined multi-year period, a natural-language sex request, and the specified refusal boundaries. **Keep LS-278 unconditionally in the must-answer list** as you instructed; its existing “if read” note must not excuse an end-to-end refusal. LS-279 may remain conditional, with any reader limitation reported separately.

Shares are not explicit in these count labels, but plan r2 already requires them and independent denominator/status verification. Use that existing requirement when judging delivery: count-only tables cannot satisfy this increment. No extra cases or schema changes are necessary for this label check.

**Necessity check:** Accept the labels and proceed under the existing plan. Preserve the unconditional LS-278 requirement and the shares gate so refusals or count-only output cannot falsely pass. Defer new compiler semantics, broader coverage, and product certification.
