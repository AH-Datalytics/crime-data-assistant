# Codex review 04: preview buttons the build can't answer (ACCEPT)

Commit 1cf831a, branch nibrs-engine/preview-buttons. Reviewed 2026-10-30.

Change: a continuation whose outcome is a not-built decline is shown as a disabled "not-built" button with the
refusal as its note; an entry's note says to ask the whole question again (the preview has no follow-up turns).

Verdict: ACCEPT, no blocking findings.

1. Only continuations already declined with notBuilt are disabled; the engine sets notBuilt only for the build-start
   coverage refusal (lib/nibrs-shadow/answer.ts), so answerable continuations stay enabled.
2. Path following is unchanged; both button kinds keep their label paths.
3. PreviewClient already disables every non-continuation kind and shows its note; no other consumer of PreviewButton
   needs updating.
4. scripts/test-nibrs-preview.ts covers the unavailable decade, the exact note, the enabled "Every year available",
   the entry guidance and the unavailable forecast alternative; it passes. Browser rendering was checked by the
   author (Memphis by month: the 10-year button disabled with its reason; "Every year available" answers 2017-01
   through 2026-09), and by Codex on code inspection only.
