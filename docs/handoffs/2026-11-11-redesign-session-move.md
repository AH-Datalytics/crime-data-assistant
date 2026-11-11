# Redesign session handoff: move to the MSI runner (2026-11-11)

Refreshes `docs/handoffs/2026-11-10-redesign-session-move.md` (still valid for the deploy recipe and prune details).
Written by the "redesign" side session; coordinator: NIBRSAI, session `local_47332826-46e7-4060-9c72-d313e06feb8b`
(message it with `mcp__ccd_session_mgmt__send_message`, parameter `session_id`).

## Rules (do not relax)

- **No live site changes.** Nothing on nibrsai.com (`/opt/nibrs`, the `nibrs` PM2 process, nginx routes) changes without the coordinator's say-so.
- **No VPS runs without asking the coordinator first** (builds, tests, scripts). Read-only looks (`ls`, `readlink`, `pm2 jlist`, `curl`) are what the standing deploy routine uses; anything else, ask.
- **No redeploys or restarts of /redesign 10 PM to 1 AM CT** (04:00 to 07:00 UTC).
- **No server work Nov 15 to 19.** Nothing on the VPS in those days; a deploy that would land then waits until after.
- **PM2 only by name** (`pm2 restart nibrs-redesign --update-env`). Never `pm2 update`, `pm2 kill`, `pm2 restart all`; never touch `nibrs` or `cors-proxy`. No apt.
- **Locks:** `fuser /opt/nibrs/maintenance.lock /opt/nibrs/release.lock` (no output = free). Never `flock`. The files always exist.
- Never print or log the Gemini key (VPS: `/opt/nibrs-beta/shared/.env`); the daily Gemini cap stays at the $2 default.
- Don't merge into `dev`; PRs go to `dev` (never master). `.claude/launch.json` stays uncommitted. No `git checkout` / `reset --hard` / `clean` without asking. Commit only when asked (the merge rule below covers merge commits on `nibrsai-redesign`); never amend. Engine code (`lib/nibrs-shadow`, `lib/nibrs-plan`, `lib/answer-contract`) is not changed from here: report problems to the coordinator.

## State on 2026-11-11 (read at 19:55 UTC)

- **`dev` is `9abf06ef`** (#144 to #149 merged; #149 is "Rankings B: regions, counties, county-wide sums, where a city ranks"; #147 asks instead of declining on vague overviews; #146 label fix; #145 ranks a state's cities from Crime Index for pre-NIBRS years). **#143 is merged as `196bff21`** (empty or unreadable pin file no longer aborts the nibrsai.com deploy or drops pins). #143 reaches the VPS only with the next approved nibrsai.com release.
- **/redesign is deployed at release `20261110_032810`**: merge `afee451718181b548e7f4d16f4d30c70f491f2f0` of dev `6ea26bc` (#139). `/opt/nibrs-beta/current` points there; PM2 `nibrs-redesign` PID 1731814, 16 restarts (all mine, by name). `/opt/nibrs-beta/releases` holds `20261108_145912`, `20261109_002656`, `20261109_142206`, `20261110_032810`.
- **Not merged into `nibrsai-redesign`, not deployed:** dev changes after `6ea26bc` (that is #140 to #149). Nothing has been announced for /redesign since #139; wait for the coordinator's "Engine merge: #NNN is in dev as <sha>" and any "deploy after the post-merge checks pass" condition.
- **Branch `nibrsai-redesign`:** head `b5a9a11bc656339c57f268c659a439d17ae5cd45` (the 2026-11-10 handoff) on top of `afee451`; pushed; in sync with origin. Only `.claude/launch.json` is uncommitted (it must stay so). Worktree: `.claude/worktrees/nibrsai-redesign-88b882`.
- **nibrsai.com** (read-only): `nibrs` PIDs 76939 / 76940 / 76965 / 76966 at 78 restarts, `cors-proxy` 1957018 at 1 restart; current release `/opt/nibrs/releases/20261028_201507`. Root disk 84G used, 65G free (57%).
- **`.pinned` on the VPS:** `/opt/nibrs/releases/.pinned` **does not exist** (renamed during the Nov 10 cleanup). Backups: `/opt/nibrs/releases/.pinned.bak-20261110_070716` and `/opt/nibrs/releases/.pinned.removed-20261110` (both 848 bytes, 53 lines, byte-identical to the original); 52 old `.pinned.pre-<timestamp>` snapshots remain. `/opt/nibrs/releases` holds only the 5 newest: `20261027_130033`, `20261027_133041`, `20261027_213428`, `20261028_130620`, `20261028_201507` (current). With #143 in dev, a missing, empty or comment-only pin file is safe once a release carries it; until then a missing file is the safe state and an empty file would trip the deploy.
- No wakeups, retries or local servers are running from this session.

## Open work and what waits on Jeff

- Nothing open from /redesign. No nibrsai.com release is planned (#143's change rides the next approved one).
- Pending only on the coordinator: announcing which of #140 to #149 /redesign should take, then the standing merge-and-deploy routine below (remember Nov 15 to 19 is closed).
- Codex review: run through the CLI, not the plugin (the `codex:codex-rescue` wrapper reports "not installed" although the CLI works): `codex exec --sandbox read-only --skip-git-repo-check -C <worktree> - < prompt.txt`.

## Standing routine for an announced engine merge

1. `git fetch origin`; `git merge --no-ff <sha>` into `nibrsai-redesign` (resolve by editing); push.
2. `npx tsc --noEmit`; then `test-nibrs-shadow`, `-shadow-reading`, `-follow-up`, `-current`, `-historical` with `npx tsx scripts/<name>.ts` (add any test the merge adds, e.g. `test-gemini-reader`). Use `nice` / low priority.
3. Deploy only after the coordinator's yes, outside 04:00 to 07:00 UTC and Nov 15 to 19: `fuser` the locks; on the VPS `git fetch origin nibrsai-redesign` in `/opt/nibrs/repo`, `git archive <sha>` into `/opt/nibrs-beta/releases/<UTC timestamp>`, `nice -n 19 npm ci`, `NEXT_PUBLIC_BASE_PATH=/redesign NODE_OPTIONS=--max-old-space-size=2048 nice -n 19 npm run build`, check `.next/BUILD_ID`, `fuser` again, `ln -sfn` to `/opt/nibrs-beta/current`, `pm2 restart nibrs-redesign --update-env; pm2 save`, `curl` `http://127.0.0.1:3011/redesign/assistant` for 200. `scripts/deploy-redesign.sh` encodes this plus the keep-3 prune (`scripts/prune-redesign-releases.sh`); it has not been used for a real deploy.
4. Live checks: `https://nibrsai.com/` 200; PIDs and restart counts above unchanged; `/root/.pm2/logs/nibrs-redesign-error-5.log` empty; no "local preview" in the page.
5. Public spot checks: POST `{"question": ...}` to `https://nibrsai.com/redesign/api/assistant-query` for the questions the coordinator names, plus "Murder rate in Memphis and Tennessee in 2023" (Memphis 57, Tennessee 10). Report the release id.

## What the runner needs for this session to work there

**Access**
- **VPS SSH:** `ssh root@178.156.243.51` using the default key `~/.ssh/id_ed25519` (no `~/.ssh/config` entry; host key must be in `known_hosts`). No password, no other account. Do not copy the key into the repo or into messages.
- **GitHub:** `gh` logged in as `Jeff-alytics` (keyring) with push rights to `AH-Datalytics/crime-data-assistant`; `origin` fetch/push for `nibrsai-redesign` (git LFS lock verification failed transiently once; a retry worked).
- **Codex CLI** 0.157.1 on PATH and logged in (`codex login status`: "Logged in using ChatGPT").
- **Coordinator messaging:** the `mcp__ccd_session_mgmt__send_message` tool, address `local_47332826-46e7-4060-9c72-d313e06feb8b`.

**Files and folders outside the repo (for the local tests and local preview)**
- The worktree's untracked `.env.local` (copy it; keys only: `NIBRS_SHADOW_ROOT`, `NIBRS_SHADOW_RELEASE`, `NIBRS_SHADOW_PYTHON`, `NIBRS_HISTORICAL_ROOT`). On the laptop they point at:
  - `NIBRS_SHADOW_ROOT=C:/Users/jeffm/nibrs-model/work/buildhost/test6-20261031/release/canonical` (the canonical NIBRS build)
  - `NIBRS_SHADOW_RELEASE=test6-20261031-host`
  - `NIBRS_SHADOW_PYTHON=C:/Users/jeffm/nibrs-model/.venv/Scripts/python.exe` (Python with `duckdb`)
  - `NIBRS_HISTORICAL_ROOT=C:/Users/jeffm/crimeindex-build/crimeindex-20261101-ct` (the Crime Index build, 10 files, about 105 MB; the same build is on the VPS under `/opt/nibrs-beta/data`)
  On the runner, copy those folders (or rebuild them) and edit the four paths. Never point them at the VPS or at Neon.
- User memory notes (not in the repo): `C:\Users\jeffm\.claude\projects\C--Users-jeffm-crime-data-assistant\memory\` (relevant: `check-vps-locks-with-fuser.md`, `pr-base-dev.md`, `heavy-runs-low-priority.md`, `no-summary-boxes.md`, `owner-decision-format.md`).
- Nothing else is read from outside the repo. The scratchpad scripts I used earlier were throwaway; the public checks are inline Python (`urllib`) posting to the public URL.

**Environment variables**
- Only the four in `.env.local`. `GEMINI_API_KEY` is not needed locally and should stay unset there (the live key lives only in `/opt/nibrs-beta/shared/.env` on the VPS; never read or print it). `ASSISTANT_MODEL_DAILY_USD` stays at its default of 2.
- The VPS side (already set, for reference): `/opt/nibrs-beta/ecosystem.redesign.config.js` runs PM2 `nibrs-redesign` on `127.0.0.1:3011` with `NEXT_PUBLIC_BASE_PATH=/redesign`, `ASSISTANT_PUBLIC_PREVIEW=1`, and the Gemini key parsed from the shared `.env`. nginx: `/etc/nginx/conf.d/redesign-limit.conf` and the `/redesign` locations in `sites-enabled/nibrsai` (backup `/root/nginx-backup-20261105_191819`). Data under `/opt/nibrs-beta/data` (release and Crime Index build, on `/mnt/HC_Volume_105124811/nibrs-beta-data`); venv `/opt/nibrs-beta/venv` (duckdb).

**Local requirements of the deploy and test scripts**
- Bash (Git Bash on Windows is fine), `ssh`, `git`, `gh`, Node 24 with npm (`tsc`, `tsx`), Python 3 (public-URL checks), `curl`.
- The build runs **on the VPS** (`npm ci` and `next build`, at nice 19); nothing heavy runs locally. Locally: `tsc` and the five or six `tsx` test scripts.
- `scripts/test-release.sh` and anything using `flock` need Linux: run it in Docker (`node:20-bookworm`, repo mounted read-only, copy `scripts` to a scratch folder) and never on the VPS.
- Local preview, if asked: `preview_start` with the `assistant-dev` entry in the worktree's `.claude/launch.json` (port 3210, `next dev`); stop it with `preview_stop` by serverId. About 2.2 GB of RAM; one server at a time.
- Low priority (`nice`) for anything heavy; no heavy runs during Savant builds.
