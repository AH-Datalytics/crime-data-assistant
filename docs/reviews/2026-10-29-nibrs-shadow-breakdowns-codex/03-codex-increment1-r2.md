**ACCEPT (fixes).** The requested reproductions now behave correctly:

| Reproduction | Result |
|---|---|
| “Simple assaults committed by men and women in Detroit in 2023” | Declined; no victim-sex substitution |
| Duplicate `Male` row containing wrong numbers | `wrong_answer` |
| Valid count-only delivery with its share removed | `wrong_answer` |
| LS-279-shaped yearly shares | Uses each year’s complete independent category sum; incorrect percentage is `wrong_answer` |
| Year without an established denominator | `unverified`, values `not measured` |
| Blank-category sentence | Names incomplete evidence without asserting nonreporting |

Both regression scripts passed. HEAD only adds the review record after `8220283`; the reviewed code and tests are unchanged. No files were edited.

**Increment acceptance still requires V41–V49.** Once they arrive:

1. Compare all nine must-answer deliveries against independent category counts, row coverage, count/share statuses, and percentages using the correct period denominator.
2. Resolve any remaining unverified shares. The loader currently derives yearly totals by summing categories **only when every category count is known**; otherwise, an independently established yearly denominator is still needed.
3. Confirm the four boundary refusals and unchanged development behavior.

One remaining verification limitation: the scorer compares **count statuses and share values**, but not independent **share statuses**. Check those explicitly against the arriving evidence; a documented direct comparison suffices without another scorer build.

Keep LS-273, LS-278 and LS-279 as regression evidence and reuse accepted N1/N2 evidence. The increment remains unaccepted while numerical verification is incomplete.

**Necessity check:** No further changes are required for these reproduced fixes. What remains is independent numerical/status verification, including any missing yearly denominators. Defer broader reader coverage and compiler recertification.
