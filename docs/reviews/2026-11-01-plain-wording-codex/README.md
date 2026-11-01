# Codex reviews: preview blockers and plain wording (P74)

All reviews read-only, with no network. Design: docs/superpowers/specs/2026-11-01-plain-wording.md.

| # | Subject | Verdict |
|---|---|---|
| 01 | Design check | ACCEPT WITH CHANGES. Four changes, applied before building: cover every path where text can escape, with a plain fallback and a test failure for unknown reader text; a full contract for the alternative question (exact spans removed, decided by the reader alone, shown whole, run only when chosen); a targeted banned list with examples that exempts the user's own words; tests over the rendered output. |
| 02 | Full review | REVISE. Two P1s: reader refusals lost their reasons (the reasons are in the matcher's explanation, not on the parts), so Jeff's own clearance example read "didn't understand"; and the property statement was narrowed to stolen or damaged property. Two P2s: the preview couldn't select a question button; one sentence still said "applies". All four fixed; the walk now includes the review's inputs. |
| 03 | Confirmation | ACCEPT. |
