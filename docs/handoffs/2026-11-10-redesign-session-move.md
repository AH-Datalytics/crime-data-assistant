# Redesign session handoff: move to the MSI runner (2026-11-10)

Written by the "redesign" side session (coordinator: NIBRSAI, session `local_47332826-46e7-4060-9c72-d313e06feb8b`).
Messages to the coordinator go through `mcp__ccd_session_mgmt__send_message` (parameter `session_id`).

## Rules that still apply (do not relax)

- **No live site changes.** Nothing on nibrsai.com (`/opt/nibrs`, the `nibrs` PM2 process, nginx routes) changes without the coordinator's say-so.
- **No VPS runs without asking the coordinator first.** That includes test runs in `/tmp` on the VPS. `test-release.sh` needs Linux `flock`: run it in a local Docker container instead (`node:20-bookworm`, repo mounted read-only, `cp -r` the `scripts` folder to a scratch path).
- **No redeploys or restarts of /redesign between 10 PM and 1 AM CT** (04:00 to 07:00 UTC), the Savant switch window.
- **PM2 only by name** (`pm2 restart nibrs-redesign`). Never `pm2 update`, `pm2 kill`, `pm2 restart all`; never touch the live `nibrs` process.
- **Locks:** check `/opt/nibrs/maintenance.lock` and `/opt/nibrs/release.lock` read-only with `fuser` (no output = free). Never `flock`. The files always exist; existence means nothing.
- Never print or log the Gemini key (`/opt/nibrs-beta/shared/.env`); the daily Gemini cap stays at the $2 default.
- Don't merge into `dev`. PRs go to `dev` (never master). `.claude/launch.json` stays uncommitted. No `git checkout` / `reset --hard` / `clean` without asking. Commit only when asked (the standing merge rule below covers merge commits to `nibrsai-redesign`); never amend.
- The engine code (`lib/nibrs-shadow`, `lib/nibrs-plan`, `lib/answer-contract`) is not changed here: report problems to the coordinator.

## Standing rule for /redesign

After each engine merge to `dev` that the coordinator announces ("Engine merge: #NNN is in dev as <sha>"):

1. Merge that SHA into `nibrsai-redesign` (`git merge --no-ff <sha>`, resolve conflicts by editing), push.
2. `tsc --noEmit`, then `test-nibrs-shadow`, `-shadow-reading`, `-follow-up`, `-current`, `-historical` (plus any the merge adds).
3. Wait for the coordinator's "yes" if they said to deploy only after dev's post-merge checks pass.
4. Deploy: `fuser` the locks; on the VPS `git archive <sha>` from `/opt/nibrs/repo` into `/opt/nibrs-beta/releases/<UTC timestamp>`; `nice -n 19 npm ci`; `NEXT_PUBLIC_BASE_PATH=/redesign NODE_OPTIONS=--max-old-space-size=2048 nice -n 19 npm run build`; `fuser` again; `ln -sfn` to `/opt/nibrs-beta/current`; `pm2 restart nibrs-redesign --update-env; pm2 save`; curl `http://127.0.0.1:3011/redesign/assistant` for 200. (`scripts/deploy-redesign.sh` encodes this and the keep-3 prune; it has not been used for a real deploy yet.)
5. Live checks: `https://nibrsai.com/` 200; `nibrs` PIDs 76939/76940/76965/76966 with restart count 78 and `cors-proxy` 1957018 unchanged; `/root/.pm2/logs/nibrs-redesign-error-5.log` empty; the page has no "local preview" text.
6. Spot-check public questions the coordinator names (public URL `https://nibrsai.com/redesign/api/assistant-query`, POST `{"question": ...}`), plus an ordinary one ("Murder rate in Memphis and Tennessee in 2023": Memphis 57, Tennessee 10). Report the release id.

## State now

- `/redesign` is live at `https://nibrsai.com/redesign` (PM2 `nibrs-redesign`, port 3011, nginx location set in the `nibrsai` site, no auth). Current release: **`20261110_032810`** (merge `afee451`, dev `6ea26bc`, #139). Kept releases: `20261109_142206`, `20261109_002656`, `20261110_032810` (the prune script keeps the 3 newest plus current and the one before it).
- Branch `nibrsai-redesign`: head `afee451718181b548e7f4d16f4d30c70f491f2f0` plus this handoff commit; clean apart from the uncommitted `.claude/launch.json`. Worktree: `.claude/worktrees/nibrsai-redesign-88b882`.
- The local dev demo (port 3210) was stopped; nothing runs locally from this session.

## #143: guard against an empty or unreadable pin file

- PR https://github.com/AH-Datalytics/crime-data-assistant/pull/143, base `dev`, branch `prune-empty-pinned-guard`, worktree `.claude/worktrees/pin-guard-7c2e`.
- **Head SHA: `13f7f3f0134269b66e8e0e152079fa50c2a10f05`.** Not merged; merging is Jeff's call.
- **Codex state: ACCEPT on 13f7f3f** ("No actionable findings"). History: three earlier passes each found a real bug (prune_releases' own pin read; a blanket `|| true` that turned an unreadable pin file into an empty list; release.sh losing the read status, then cleanup() overwriting `.pinned` after a read error); all fixed in the PR.
- **Retry-through-the-CLI instruction:** the codex plugin wrapper (`codex:codex-rescue`) fails with "Codex CLI is not installed or is missing required runtime support" although `codex --version` (0.157.1) works and `codex login status` says logged in. Run reviews directly instead: `codex exec --sandbox read-only --skip-git-repo-check -C <worktree> - < prompt.txt` (prompt tells it to run `git diff origin/dev...HEAD`, read-only). If a new commit lands on the PR, re-run it on the new head.
- Tests: `scripts/test-stage0-operational-guards.ts` passes; `scripts/test-release.sh` 85 passed, 0 failed in a local Docker container (not on the VPS). With the old scripts scenarios 19b and 19c fail.
- **CI at 13f7f3f** (last read 2026-11-10 14:01 UTC): canonical harness (windows gate) pass; windows suites (change detection) pass; windows suites (powershell 5.1) skipping; **canonical harness (linux, LF) pending; linux release build (x64) pending.** Re-check with `gh pr checks 143 --repo AH-Datalytics/crime-data-assistant`.
- The retry wakeup I had scheduled was cancelled; no wakeups are pending.

## /opt/nibrs prune results (done 2026-11-10 07:07-07:09 UTC)

- Removed 26 releases: `20261021_180158` through `20261027_115715` (the old pinned rollback targets). Kept 5: `20261027_130033`, `20261027_133041`, `20261027_213428`, `20261028_130620`, `20261028_201507` (current).
- `df -h /`: 107G used / 42G free (72%) before; 84G / 65G (57%) after.
- `.pinned`: backup `/opt/nibrs/releases/.pinned.bak-20261110_070716` (byte-identical to the original, 53 lines: 26 live directories and 27 stale names). All 53 removed; the file was renamed to `/opt/nibrs/releases/.pinned.removed-20261110`, so `.pinned` does not exist now (an empty file would have tripped `deploy-zero-downtime.sh`; that is what #143 fixes). 52 old `.pinned.pre-<timestamp>` snapshot files remain, untouched.
- `nibrsai.com` 200, `nibrs` PIDs and restart counts unchanged, `nibrs-redesign` not restarted.
- The prune script is `scripts/prune-redesign-releases.sh` (env `PRUNE_BASE`, `PRUNE_KEEP`, `PRUNE_DRY_RUN=1`; honours `.pinned`; fuser plus /proc checks; deletes nothing if any check fails).

## Other open work and branches

- `release-keep-pin-unconfirmed` (#140): merged into dev as `0ead4e9`. Worktree `.claude/worktrees/release-pin-3f1a` is no longer needed.
- Open notes for the coordinator (engine side, not mine to fix): none outstanding from /redesign right now. Earlier ones resolved: "committed by" wording, Tarrant note, monthly-rate note.
- Possible future work, only if asked: use `scripts/deploy-redesign.sh` for the next deploy (it has not run for real); extend the Savant/`/redesign` live checks.
- Gemini: the Gemini reader (#139) is shadow-only; `/redesign` has no live Gemini reader. The older live follow-up rewriter reads `GEMINI_API_KEY` from the server's environment (VPS key in `/opt/nibrs-beta/shared/.env`); a variable named `GEMINI_API_KEY` is also defined in the laptop's shell (value never read).

## Waiting on Jeff

- Whether to merge #143 (after the two Linux CI jobs finish).
- Nothing else pending from this session. No nibrsai.com release is planned.
