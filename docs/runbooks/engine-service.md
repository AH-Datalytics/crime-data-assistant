# Engine service runbook (stage 1: the NIBRS tab, private flag)

The engine service answers questions from the canonical NIBRS release, in its own capped processes, so a slow question can never freeze the website. Nothing in this file has been installed anywhere yet. Every server step below needs the owner's typed OK first, one step at a time.

## What it is

- `services/engine/main.ts` (bundled to `services/engine/dist/main.cjs`): an HTTP service on 127.0.0.1 only, a shared token on every request but `/health`, a pool of forked worker processes (`worker.cjs`), a bounded queue, a per-question time limit.
- Each worker holds one DuckDB (Python) executor with a memory limit and thread count. One question per worker at a time.
- `lib/engine-service/*`: the protocol, the pool, the HTTP face and the engine adapter (`core.ts`), all unit-tested without data (`scripts/test-engine-service.ts`).
- Build: `node scripts/build-engine-service.mjs` (esbuild; the server then needs only node and a python with duckdb 1.5.6, no tsx).
- Install path: build in the deployed release, then copy the bundle to a stable folder the unit runs from:
  `cd /opt/nibrs/current && node scripts/build-engine-service.mjs && mkdir -p /opt/nibrs/engine/dist /opt/nibrs/engine/tmp && cp -r services/engine/dist/. /opt/nibrs/engine/dist/`.
  The unit (`services/engine/engine.service`) runs `/opt/nibrs/engine/dist/main.cjs` with the release as its working directory. After every deploy (a new release folder) repeat the build and copy, then `systemctl restart nibrs-engine`.

## Configuration (environment file, `/opt/nibrs/engine/engine.env`)

| Variable | Meaning | Start value |
|---|---|---|
| `ENGINE_TOKEN` | shared secret, at least 16 characters (the web route sends it in `x-engine-token`) | random, owner-held |
| `ENGINE_PORT` | listen port on 127.0.0.1 | 8420 |
| `ENGINE_WORKERS` | worker processes | 2 (the runner measurement decides) |
| `ENGINE_QUEUE_MAX` | waiting requests beyond the busy workers; more is answered "busy" | 8 |
| `ENGINE_TIMEOUT_MS` | a worker that overruns is killed and replaced | 120000 |
| `ENGINE_DUCKDB_MEMORY`, `ENGINE_DUCKDB_THREADS` | per worker: one DuckDB process serves every tab, so memory is workers x this, not tabs x workers x this | 2GB, 1 |
| `ENGINE_NIBRS_ROOT` | the canonical release folder, `.../canonical` | `/opt/nibrs/engine/releases/<release id>/canonical` |
| `ENGINE_CRIME_INDEX_ROOT`, `ENGINE_SHR_ROOT`, `ENGINE_HATE_ROOT` | the data folder of each other source (Crime Index serves both Historical and Current). A tab with no root, or whose source fails to load, answers "unavailable" and the other tabs keep answering; a failed source is tried again after 30 seconds. NIBRS stays the base: without `ENGINE_NIBRS_ROOT` no tab answers. A source answers only once its builder ships; setting a root early does nothing. | unset until that source is switched on |
| `ENGINE_PYTHON` | python with duckdb | `/opt/nibrs/engine/venv/bin/python` |
| `NIBRS_CUBE`, `NIBRS_CUBE_SET`, `NIBRS_CUBE_SET_SHA256` | the cubes (the set manifest and its pinned hash) | `on`, `/opt/nibrs/engine/cubes/<release id>/cube-set-<release id>-<n>.json`, its sha256 |

The service reads `scripts/fixtures/nibrs-shadow/{release,agencies,agency-names}.json` from its working directory (the release folder `/opt/nibrs/current`); those fixtures are bound to the canonical release by its manifest, and a mismatch stops the worker at its first question.

## Checks without the site

`curl -s http://127.0.0.1:8420/health` (pool, release, cubes loaded), then a question: `curl -s -X POST http://127.0.0.1:8420/answer -H "x-engine-token: $ENGINE_TOKEN" -H "content-type: application/json" -d '{"tab":"nibrs","question":"Robberies in Texas in 2024"}'`.

## Release check before a release is served

`python scripts/check-release-occurrence.py <release>/canonical` (read-only, about a minute): fails (exit 1) when an offense code repeats inside an incident in any year. The engine reads a victim's weapon by incident and offense code only (compile.ts, P31), which is exact only while that never happens; a failing release is not served until the victim weapon join uses an occurrence. Run it where the release is copied, before a new release folder is pinned.

## Rollback

The site never depends on the service in stage 1: the page calls it only for a visitor holding the private cookie. Rollback = stop the service (`systemctl stop nibrs-engine`) or remove the cookie. A new release or cube set is a new folder and a new pin in the environment file; the previous folders stay on disk.

