**ACCEPT.** (Codex re-check of `b6a1945..c8efaf1`.) No question is shortened anywhere in the preview flow, including
button paths; invalid requests return 400 before the engine or its dependencies start (seven invalid requests checked,
zero dependency initializations); the changes are limited to preview code, tests and the review record; the production
gate is intact (GET and POST 404; the page keeps the same gate). No further changes needed.
