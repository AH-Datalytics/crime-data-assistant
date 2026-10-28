# Codex implementation review r2: answer columns and chart labels, phase 1 (2026-10-28)

Reviewer: Codex CLI plugin (codex-companion task), read-only. Verbatim:

**ACCEPT WITH CHANGES — one remaining part of r1 finding 4.**

1. **P2 — Mixed why turns lose annotation-drop tags.**  
   At [query/route.ts:723](app/api/query/route.ts:723), and the equivalent NIBRS/SHR branches, the outer finalization receives `cap.input`, which was already projected. Its WeakMap entry therefore contains no drops, even though the outer emission removes annotations from `cap.payload`.

   Direct reproduction confirmed:
   - Inner tags: `answer-annotation-dropped:note`
   - Outer tags at logging: empty
   - Delivered columns: correctly exclude `note`

   **Exact fix:** in the three mixed-why branches, derive drop tags from the captured payload using `projectAnswer()` and append them to the outer log’s tags before logging. Keep the projected finalization input unchanged. Add one capture → outer-finalization → log regression check.

   **Consequence if unchanged:** these delivered answers silently omit the required removal audit tags. User-facing data remains correct.

The other findings are resolved:

- Equal category bands now use the tallest wrapped label.
- Slanted margins account for every label’s position.
- All four withholding-related finalizations use delivered rows/columns; the AST guard covers them.
- Chart-log serialization filters annotations and reconciles bindings.
- `useBoxWidth` measures before browser paint, observes resizing and disconnects on cleanup. Its server guard and hook ordering are sound for the reviewed paths.
- Ordinary concurrent requests cannot interleave inside synchronous `finalizeProof()`. Twenty interleaved request tasks retained correct tags. The WeakMap keys are distinct finalization objects and do not retain them indefinitely. Making `pendingDrops` local would be optional cleanup, not a blocker.

Validation passed: **18 projection, 12 chart-text, 196 period-correctness and 13 chart-log checks**. I reused your browser and full-harness evidence. No files changed.

**Necessity check:** only the mixed-why logging fix remains necessary to complete the agreed logging requirement. Preserve the accepted layout/proof work; defer state cleanup and broader testing.

