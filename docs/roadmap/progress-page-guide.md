# Automatically updated progress page

## Current format: calendar matrix (September 11)

### Original steps versus added repairs

The Phase 3 route strip explains the actual chosen path: finished P3.1 setup, added targeted answer repairs, then the P3.3 continuation decision. This is not a new authorization or a requirement to execute the old steps in numerical order. P3.2 remains a parked measurement option; P3.4 is conditional; the added repairs can contribute to P3.5 without completing it.

Within Phase 3, the matrix presents P3.1 first, added work next, and the remaining original decision steps afterward. Original IDs are preserved. Added work is labelled ADDED WORK (rather than displaying its long tracking code as another numbered phase); the full stable ID remains searchable and appears in the task's details. The Phase 3 view includes the original steps and the detailed repair milestones together, so switching views does not erase their relationship. The route strip reads P3.1's saved status and is hidden when the recorded current phase moves beyond Phase 3. No dates, completion states or task permissions are inferred from display order.

### Identifying the current work

The top strip now states the exact current task, its waiting/working state, who has the next action, and what that action is. The matching row is highlighted blue and labelled CURRENT in either applicable view. "Show in calendar" clears filters and returns to that row. A partly finished phase or task is not automatically labelled current, and none of this claims to monitor whether an agent is actually running.

For a new or changed current task, include `work` in the ordinary `focus` progress entry: `id` (an existing tracked step or milestone), `title`, `owner`, `state`, and `next`, all plain-English strings. Examples of truthful state labels: "Awaiting your approval", "Claude is implementing", "Awaiting Codex review", "Blocked by missing data". They require supporting records, not inference from a file change. The initial current pointer is P3.SAFE.NO_SOURCE, awaiting owner approval, not implementation authority. A later focus entry without `work` clears the old pointer so the page does not silently keep highlighting stale work; use `work: null` to clear explicitly. Invalid or missing task identities stop generation and preserve the last page.

This is the same owner-requested progress view and existing update mechanism, not a second task system. The source-only assessment and Codex recommendation remain in their product handoff; no acknowledgment message is needed to maintain this banner.

The owner rejected the earlier card layout. The current page is one calendar matrix: phases and tasks at left, weeks across the top, a status for each task, and an explicit no-date column. The default shows every roadmap task; the view selector switches to detailed Phase 3 repair milestones in the same matrix. Search and status filters narrow the rows, arrows move through weeks, and selecting a task opens its full plain-English note and supporting record. The grid scrolls internally on smaller screens; it does not force unreadably small text to promise every task fits every screen.

Calendar marks are dated project records, not invented work durations or completion dates. Undated tasks remain undated. An explicit `schedule` field (`YYYY-MM-DD`, or null to clear it) may be included in a normal step/milestone update only when that date is actually agreed. It is shown as a planned date, not authority to start. The update's `at` still records when the decision was saved, separately from the agreed date. Invalid calendar dates stop generation and preserve the last valid page.

`_progress/calendar.html` owns the current presentation. `_progress/template.html` retains the original seed data; its old presentation is unused. `update-progress.cjs` overlays saved updates as before and renders the calendar. The old card-specific injection was removed. No dependency, web server, account, publication or application source change was needed.

Current verification: `audit/progress-calendar-review-ssU6Pk/result.json` passes all ten phases and 39 original IDs (41 tracked tasks at this check), embedded-script syntax, matching UTC week buckets, new-detour discovery, acceptance updates, explicit schedules, invalid dates/JSON preserving the last page, safe embedded text, and the actual file watcher. These are local generation/logic checks, **not a new browser visual or interaction certification**; the earlier screenshot results below concern the superseded card layout. `test-progress-page.cjs` now delegates to `test-progress-calendar.cjs` and does not start a browser. The page still refreshes every 30 seconds, pausing while its detail window is open.

### Short Claude prompt for calendar upkeep

> Continue the existing progress-update entries as part of substantive handoffs; the new calendar reads the same records. Keep statuses truthful and use an optional schedule date only when agreed. Include new steps and detours with their purpose and stopping point. Do not create an acknowledgment or a separate reporting task.

Claude's latest repair blocked one known route to a made-up answer, while its remaining limitation stays recorded. The calendar makes that progress and the remaining professionalization work visible together, without changing the product or adding another approval process.

<!-- progress-update
{"kind":"step","phase":9,"id":"P9.7.TRACKER","title":"Keep project progress visible","status":"complete","note":"Replaced the rejected cards with one phase-and-task calendar matrix. Saved records update it automatically; unscheduled work stays undated. Local generation and updater checks pass; not a product deployment.","at":"2026-09-11T21:36:00Z"}
-->

Owner-requested on September 11, 2026. [Open the HTML page](progress.html). It is local documentation, not application code or a deployed website.

## Opening and automatic updates

Double-click **Open progress.cmd** in this folder. It refreshes the HTML, starts a hidden local watcher if needed, and opens the page in your browser. Node is already installed on this laptop; no packages or server are needed. The launcher uses a process-only PowerShell execution setting; it does not change the machine's saved policy.

The watcher reads `docs/roadmap/current.md` and top-level Markdown handoffs in `docs/superpowers/`. Saved changes regenerate `progress.html`; the browser reloads it every 30 seconds, preserving filters and scroll position where browser storage permits. A 15-second reconciliation covers missed file notifications. Nothing contacts production, a model, another laptop, or the network.

After a restart, use **Open progress.cmd** again. Opening the HTML alone still works but does not start the watcher. This is not an installed Windows service or startup task. The “Refreshed” timestamp identifies the generated snapshot, not the time a human accepted the work. The page cannot monitor chat messages or changes that have not reached this repository.

## How new work and accepted progress appear

- **Every new or changed handoff appears automatically** in the page's activity section (most recent 15), even without a progress entry. This is explicitly a record change, not a completion claim.
- A brief `progress-update` entry in the governing handoff updates a phase, step, milestone, next action, or scored capture. New step/detour IDs are added automatically. No HTML changes are needed for normal progress.
- Codex/Claude maintain those entries as part of their existing handoff, not a separate approval exchange. The project instructions require running the generator after those updates even if the watcher is not running.
- Missing or invalid entries must not silently turn into accepted work. Invalid structured entries fail regeneration and preserve the last valid HTML; the watcher error log records the problem.

There is no reliable way for a static page to independently decide that engineering work has passed review. Acceptance remains an explicit project decision. The automation handles discovery, rendering and refresh, not making that decision.

## One short entry in an ordinary handoff

Examples below are instructional, inside a code block; they are not live events. Use a real dated timestamp and the status actually established by the linked record. Keep existing entries; append later corrections with a later timestamp.

```text
<!-- progress-update
{"kind":"milestone","id":"AGENCY","status":"local","note":"Accepted against the bounded local checks; not deployed.","at":"2026-09-11T18:00:00Z"}
-->

<!-- progress-update
{"kind":"detour","phase":3,"id":"P3.D1","title":"A newly necessary detour","status":"review","note":"Why it is necessary, what it blocks, and its finite stop.","at":"2026-09-12T12:00:00Z"}
-->

<!-- progress-update
{"kind":"focus","phase":3,"latest":"Most recent accepted outcome.","next":"Next bounded action and its authority limit.","at":"2026-09-12T12:01:00Z"}
-->
```

Kinds: `phase` (existing parent phase), `step`, `detour`, `milestone`, `focus`, `measurement`. A new step/detour needs `phase`, stable `id`, `title`, `status`. A milestone needs `id`; phases use `phase`. Sources link automatically to the record containing the entry. `focus` may set `phase`, `focus`, `note`, `latest`, `next`. A `measurement` carries `title`, `pass`, `fail`, `inconclusive`, and `at`; it appends history and must account for all 120 frozen cases. Do not duplicate the same measurement in multiple handoffs.

Statuses: `planned`, `active`, `review`, `partial`, `local`, `measured`, `complete`, `conditional`, `deferred`, `closed`, `unverified`, `blocked`. `local` means accepted locally, `measured` means measured evidence, and `complete` means accepted completion of that named scope. None independently means deployed. Claude's unreviewed implementation should use `review`, not self-assign acceptance. Codex or an explicit owner acceptance supplies the acceptance update. Read the prose authority and preserve any limits.

The initial snapshot in `_progress/template.html` preserves all 39 original P-numbered steps, ten phases, and fourteen correctness milestones. Explicit future entries overlay it. The immutable starting record fingerprints in `_progress/observed-files.json` drive automatic change discovery; don't reset them just to hide activity. The template's seed phase labels and measured history come from the cited records, not from filenames or check counts. No overall project completion percentage is manufactured.

`current.md` remains the current direction/authority; this generated view does not replace it. Complex changes to phase structure, release approval text or acceptance policy still need the corresponding ordinary documentation/template change. Source records can be opened through relative links when the HTML stays in this folder; a standalone copy shows the snapshot but cannot receive updates or include those linked documents.

## Commands and checks

```text
node docs/roadmap/update-progress.cjs
node docs/roadmap/update-progress.cjs --watch
node docs/roadmap/test-progress-page.cjs
```

The test uses the already-installed Playwright browser. It verifies all original IDs/links, desktop/mobile layout and filters, automatic addition of a new record and a detour, overlay of an accepted status, invalid-input refusal, actual watcher behavior, and no HTTP(S) requests. All mutation fixtures live in a fresh temporary directory, not the project handoffs. Generated screenshots/results go under `audit/progress-page-review-*`.

The watcher PID and output/error logs are in `_progress/`. It only reads Markdown and writes the generated page and its own local tracking files. To stop it, terminate the specific watcher process named in `watcher.json`; do not stop other Node processes. No automatic deletion or source acquisition is performed.

## Initial completion record - September 11, 2026

The generator and browser tests passed. Evidence: `audit/progress-page-review-8cHUW4/result.json`, with desktop/mobile screenshots alongside it. The check exercised the real file watcher and the browser's timed reload; it did not merely call the generator after each simulated change. It also verified new detour discovery, an accepted-status overlay, literal-text safety, refusal of malformed update entries with the last valid page preserved, and zero HTTP(S) requests or browser script errors. Test-only changed handoffs stayed in a fresh temporary directory.

The real main-laptop watcher was started at `2026-09-11T21:12:44Z`, PID `18772`, and its output/error logs were checked. This is a launch receipt, not a promise that the process survives restart. The launcher restarts it when needed. No application source, test chain, database, capture, model, production site or deployment was changed. Phase 0 closure is explicitly unconfirmed rather than guessed; the accepted phase and step records remain linked.

### Short Claude prompt for future updates

> Keep the automatic progress page current as part of normal handoffs: follow docs/roadmap/progress-page-guide.md, append a truthful progress-update for new work or changed status, and run node docs/roadmap/update-progress.cjs. New detours need a stable ID, purpose and stop. Do not mark your own unreviewed work accepted, predict scores, or infer authority from the page. No separate acknowledgment is needed.

Claude's latest accepted work completed the bounded named-agency correction while other roadmap obligations remain. The page now follows saved project records and explicit progress decisions automatically, keeping professionalization visible without another manual reporting cycle.
