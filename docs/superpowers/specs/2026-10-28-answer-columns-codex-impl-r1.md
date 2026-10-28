# Codex implementation review r1: answer columns and chart labels, phase 1 (2026-10-28)

Reviewer: Codex CLI plugin (codex-companion task), read-only. Verbatim:

**ACCEPT WITH CHANGES.** The two-choke-point simplification is sound for removing annotations while preserving internal evidence, but the implementation has these gaps:

1. **P2 — Sideways labels can still overlap.**  
   [ChartPanel.tsx:350](components/ChartPanel.tsx:350), the corresponding NibrsChartPanel calculation, and `chartBoxMinHeight` sum individual label heights. Recharts allocates **equal-height category bands**. One much taller label among short labels therefore gets insufficient space.  
   **Fix:** size the plot from `categoryCount × maximumRequiredBandHeight`, plus axis/margin reserves; use the same rule in the outer box calculation. Add one mixed-length fixture with a tall label between short neighbors.

2. **P2 — Left-margin calculation protects only the first label.**  
   [ChartPanel.tsx:380](components/ChartPanel.tsx:380) and NibrsChartPanel pass only `categoryLabels[0]`. The formula is correct for that label, but a longer second or third label can extend farther left. For example, at 375 px with 16 bars, a short first label leaves the margin at 8 px; a second label measuring 220 px remains below the sideways threshold but extends outside the chart.  
   **Fix:** solve the required margin across every slanted label using its band position, or switch sideways when the complete layout cannot fit. Verify a short-first/long-second fixture.

3. **P2 — Projection does not establish the promised proof/delivery equality.**  
   [query/route.ts:3646](app/api/query/route.ts:3646) finalizes raw `rows/columns`, while the result emits `deliveredRows/deliveredColumns`. `withholdUnverifiedChange()` can null a comparison only in the latter. The subsequent explanation finalizations also use raw data. This divergence predates this commit, but the new “same projected answer” assertion remains false: the persisted digest can describe a withheld value.  
   **Fix:** finalize the presentation result at these exits, including refinement/retry finalizations. Test an actual withheld-change case, rather than supplying identical inputs to both choke points.

4. **P2 — Logging does not use the projected answer contract.**  
   [answer-columns.ts:69](lib/answer-columns.ts:69) defines `annotationDropTags()`, but nothing calls it. Chart-log serialization also receives original columns/configuration. If emission removes a configured series, the logged chart differs from delivery and can cause an embed-origin mismatch.  
   **Fix:** carry drop tags into the existing request log and serialize the projected columns/reconciled chart configuration. Preserve existing log timing and embed bookkeeping.

The remaining review supports the approach:

- Factual JSON/SSE delivery paths—including why re-emission and embed replay—pass through `emitFactualPayload`; I found no row-bearing partial-event bypass.
- Why capture retains internal notes without directly delivering its unprojected rows. Typed chart eligibility/title generation runs before projection; chart metadata and omission attribution do not require the removed fields afterward.
- Hooks precede conditional returns; document/canvas fallback guards support SSR. Text measurement matches the explicit tick font, refreshes after fonts load, and wrapping adds no ellipsis.
- Release checkers preserve values, row order and keys; the surrounding comparison preserves chart bindings. Staffing compatibility remains phase 2.

Validation: projection **16/16**, chart-text **10/10**, egress inventory **37/37**; all four release fixtures accepted and injected notes rejected. I relied on your reported browser evidence and 256/256 harness run. No files changed.

**Necessity check:** correct the two demonstrated layout failures and the proof/logging discrepancies before acceptance. Defer producer evidence-field migration and broader chart certification; neither is needed for this decision.

