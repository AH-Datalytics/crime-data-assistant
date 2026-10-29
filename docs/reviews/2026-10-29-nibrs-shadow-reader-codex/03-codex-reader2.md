**ACCEPT 4e457ed for this shadow reader round.** Both test suites pass, and the requested reproductions confirm the fixes. No files edited.

| Check | Result |
|---|---|
| “Sample assaults…” | Unchanged; declines without answering simple assault. |
| “Violet crime” | Unchanged; asks which crime rather than rewriting to violent crime. |
| Forecast with 2016–2026 coverage | Alternative reaches an annual answer for **2016–2025**, with distinct bindings. Verified using stubbed rows, not numerical correctness evidence. |
| “near schools” | Preserved in forecast and court alternatives; unsupported qualifier causes a decline. |
| Robbery with firearm / arrests / prosecution declined | Decline for actual slice limitations, without the incorrect P01 source explanation. |
| “Shoplifting in Memphis next year” | P24 unavailable-period decline, with latest-period alternative. |
| “Predicting shoplifting … in 2027” | P20 forecast decline and annual-trend alternative. |

The committed baseline supports the qualified claims:

- **15→19** correct development cases.
- **13→3** avoidable declines among the 25 new cases.
- **2→0** scored wrong answers, comprising **one source-routing error and one scoring artifact**, as the README explains.
- Fresh correct counts are not comparable across the baseline because independent batch-3 values were added afterward.

The saved after-report remains evidence from the earlier run; these targeted checks verify the correction commit without constituting a new full evaluation. LS-260 and the shared forecast-alternative fix remain regression evidence.

**Necessity check:** No further change is needed to accept this correction round. Defer broader language coverage and the previously recorded capability limitations; neither warrants another correction cycle here.
