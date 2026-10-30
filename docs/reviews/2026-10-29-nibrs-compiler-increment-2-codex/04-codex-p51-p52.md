**REVISE** (Codex full review of `be69b47..af25816`: P51 filtered zeros, P52 upload month). Compiler status logic
passed: generated SQL executed in memory at month, year and total grain, with and without categories (empty
reported-crimes months 0 VALUE; all-reported-zero years 0 REPORTED_ZERO; mixed 0 VALUE; UNKNOWN blank; conflicts
EVIDENCE_CONFLICT; zero-denominator shares blank UNAVAILABLE). Delivery, merging, "Together: 0", P52 boundary (October
declines naming September; year to date ends in September) and the text templates passed. No compiler production of
UNKNOWN_UNEVIDENCED_ZERO remains.

Required (both in the evaluator), applied in the next commit:
1. `sliceValues()` turned a known 0 denominator into "no denominator": the share is now an expected blank (null) when
   the denominator is a known 0; absent or unknown denominator evidence stays unverified. Tested.
2. The missing-month statement check treated a share UNAVAILABLE for a 0 denominator as missing reporting evidence; it
   now looks only at statuses that mean missing evidence. Tested.

Evidence after the review: nibrs-model `8b656bf` (V1-V68, N1, Z under P51/P52): harness 0 wrong answers in every group,
every scored value matching; compile gate every check passed, N1 1,470 rows equal.
