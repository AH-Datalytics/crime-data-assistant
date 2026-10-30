**REVISE** (Codex one-pass review of the local private preview, `44bd8c7..b6a1945`, read-only). One required fix:

1. The route silently cut questions to 500 characters, so an answer could be to a shorter question than the one shown.
   Applied: `parseRequest` refuses a question over 500 characters with a 400 before the engine runs (and refuses an
   empty question or a malformed or oversized button path). Tested offline, and on the dev server (501 characters:
   400; a normal question: 200 with the answer).

Codex's other findings, passing:
- Production isolation: one gate for page and API; `force-dynamic` keeps both out of static generation; nothing reads the
  build or runs Python at import or build time.
- New files only: six added files, no shared component, middleware, config or existing route changed.
- Adapter and buttons: headers and cells copied, nulls kept, no status or notes columns; `follow` walks the shadow's own
  continuations by exact label (P22).

Noted, not blocking:
- Existing middleware may answer 401 or redirect before the 404 when auth is configured; this does not expose the preview.
- "Owner-only" is operational: keep the dev server private.
- The page inherits the root layout's analytics script.
- Raw engine errors can show local paths; there are no timeouts (deferred for local scope); the build path is operator-set.
