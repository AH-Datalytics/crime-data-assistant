# Codex implementation review r3: answer columns and chart labels, phase 1 (2026-10-28)

Reviewer: Codex CLI plugin (codex-companion task), read-only. Verbatim:

**ACCEPT.**

Commit `7d902e5` resolves the remaining finding. All three mixed-why routes now derive drop tags from the unprojected captured payload before logging. Finalization stays projected, and emission still removes annotations.

No regressions found in the scoped diff. Independently reran:

- Answer-column checks: **19/19**
- Why-turn checks: **98/98**

Earlier accepted findings remain closed. No files changed.

**Necessity check:** no further changes are needed for phase 1 acceptance. Defer optional cleanup and broader testing.

