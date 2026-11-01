# Codex reviews: the model follow-up rewriter (shadow test)

All reviews read-only, with no network. Design and results: docs/superpowers/specs/2026-10-31-model-follow-up-rewriter.md.

| # | Subject | Verdict |
|---|---|---|
| 01 | Design check, before any model call | ACCEPT WITH CHANGES. Five changes applied before fetching: a reader-based meaning guard; no model options, and "new" only when the baseline agrees; the cache bound to the prompt and settings; measurement definitions fixed in advance; the budget reserved before each request. |
| 02 | Design check of the confirm-before-run amendment (P73) | ACCEPT WITH CHANGES. Six changes applied: proposals never execute, model presentation edits included; a proposal is scored before simulated confirmation; the people flag is part of the rewrite comparison; guard exceptions only where cached evidence supports them; a precise period default; direct, proposed and asked counted separately. |
| 03 | Full review of the branch | ACCEPT WITH CHANGES. Three P2 findings: the period default mangled a several-year period; a failed attempt's cost was not held against the budget; the results summary overstated the evidence. All three fixed. |
| 04 | Confirmation of review 03's fixes | ACCEPT. |
| 05 | Full review of the two rule fixes from the real-conversation hand check, and the measurement code | REVISE. P1: "Missouri instead" qualified the city instead of replacing it. P2: a `--with-answer` run without `--cache` could write real text into the repository. Both fixed. |
| 06 | Confirmation of review 05's fixes | P1 fix confirmed. P2 remained: `..private-cache.json` passed the outside-the-repository check. Fixed (a real parent step, or another drive) and verified directly. Closed under the agreed review limits. |
