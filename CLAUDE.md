# Crime Data Assistant

## Overview
AI chatbot for exploring U.S. crime data across four tabs: Current Trends (RTCI), Historical Library (FBI UCR), NIBRS, and Homicide Reports (SHR). Deployed at nibrsai.com on a Hetzner VPS.

## Tech Stack
- Next.js 16, React 19, TypeScript, Tailwind CSS v4, Recharts
- better-sqlite3 (readonly) for four databases: `crime_data.db` (RTCI + Historical), `nibrs.db` (NIBRS), `shr.db` (SHR), `query_log.db`
- Anthropic API: Haiku 4.5 for all four tabs (benchmarked against Sonnet — same quality, 2.4x faster, 4.1x cheaper)
- Auth: HMAC-SHA256 cookie-based (middleware.ts)

## Build & Deploy (Zero-Downtime)

The app uses symlink-based atomic deploys. Builds happen in an isolated release
directory. If the build fails, the live app is never touched.

```
/opt/nibrs/
├── current -> releases/20260604_143000   # symlink, atomically swapped
├── releases/
│   ├── 20260604_143000/                  # immutable app release
│   └── 20260603_120000/                  # previous (kept for rollback)
├── shared/                               # persistent across releases
│   ├── .env
│   ├── .env.local
│   ├── crime_data.db
│   └── query_log.db
├── repo/                                 # git clone (build source)
├── nibrs.db                              # too large to move (118 GB)
└── shr.db
```

**Normal deploy:**
```bash
ssh root@178.156.243.51
cd /opt/nibrs/repo
bash scripts/deploy-zero-downtime.sh          # deploys HEAD of main
bash scripts/deploy-zero-downtime.sh <branch> # deploys a specific branch
```

**Rollback:**
```bash
bash scripts/rollback.sh              # revert to previous release
bash scripts/rollback.sh --list       # show available releases
bash scripts/rollback.sh 20260603_120000  # revert to specific release
```

**Why not build in the live directory:** If `npm run build` fails mid-way, the
`.next` directory is left in a broken state and the running app goes down.
Isolated builds guarantee the live app is unaffected by build failures.

**Do not run heavy SQLite summary builders on the web VPS.** Rebuilding summary
tables (100M+ row aggregations) consumes all CPU/RAM and will crash the app.
Run those on a separate machine and SCP the updated DB files to `/opt/nibrs/shared/`.

## Runtime Paths
- Set explicit env vars in production. Do not rely on fallback path detection.
- Production env vars (set in `ecosystem.config.js`):
  - `RTCI_DB_PATH=/opt/nibrs/shared/crime_data.db`
  - `NIBRS_DB_PATH=/opt/nibrs/nibrs.db`
  - `SHR_DB_PATH=/opt/nibrs/shr.db`
  - `QUERY_LOG_DB_PATH=/opt/nibrs/shared/query_log.db`
  - `APP_DIR=/opt/nibrs/current`
- `crime_data.db` and `query_log.db` live in `/opt/nibrs/shared/` (symlinked into each release).
- `nibrs.db` and `shr.db` stay at `/opt/nibrs/` (too large to move; referenced by absolute path).

## Architecture
- `lib/claude.ts` — System prompt for Current Trends + Historical tabs
- `lib/nibrs-claude.ts` — System prompt for NIBRS tab (~1200 lines)
- `app/api/query/route.ts` — API route for Current Trends/Historical (SSE streaming)
- `app/api/nibrs-query/route.ts` — API route for NIBRS (JSON response)
- `lib/sql-safety.ts` — SQL validation/sanitization
- `lib/dynamic-facts.ts` — Runtime DB introspection for prompt context
- `scripts/daily-query-analysis.js` — Daily email digest via Resend (cron noon)

## Key Rules
- **Never use raw NIBRS tables for counts/trends.** Always use summary tables (summary_victim_state_monthly, summary_victim_city_monthly, summary_state_monthly, summary_city_monthly, etc.). Raw tables (victims, offenses, etc.) have 100M+ rows and will crash.
- **Person crimes must use victim summary tables.** Murder, rape, assault, etc. are counted per victim, not per offense. Using offense tables undercounts by ~20%.
- **National data is not an agency.** For RTCI: use `national_monthly`. For Historical: use `historical_state_national` with `state = 'United States'`. For NIBRS: SUM across states from state-level summary tables. Never look up "USA" as an agency/city.
- **Server-side guardrails in route.ts files** detect and retry known bad SQL patterns (wrong table, cross-level JOINs, missing filters, national-as-agency lookups).
- **Claude must never be analytical.** No policy recommendations, causal explanations, or trend commentary. Generate SQL and report what the query returns — nothing more.
- **Email addresses** (`daily-query-analysis.js`) are currently using Resend sandbox (`onboarding@resend.dev`) pending domain verification. This is intentional, not a bug.

## Databases
- `crime_data.db` — RTCI (2017–present, ~700 agencies) + Historical UCR (1930–2024) + staffing/clearance
- `nibrs.db` — Full NIBRS (1991–present, 1B+ incidents, ~118GB). Summary tables pre-aggregated for performance.
- `query_log.db` — Query logs for all tabs (question, SQL, response, timing)
- All opened readonly via better-sqlite3

## Testing
No automated test suite. Smoke test via `scripts/smoke-test.py`. Manual testing against nibrsai.com.
