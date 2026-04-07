# Crime Data Assistant

## Overview
AI chatbot for exploring U.S. crime data across three tabs: Current Trends (RTCI), Historical Library (FBI UCR), and NIBRS Explorer. Deployed at nibrsai.com on a Hetzner VPS.

## Tech Stack
- Next.js 16, React 19, TypeScript, Tailwind CSS v4, Recharts
- better-sqlite3 (readonly) for three databases: `crime_data.db` (RTCI + Historical), `nibrs.db` (NIBRS), `query_log.db`
- Anthropic API: Haiku 4.5 for Current Trends/Historical, Sonnet 4 for NIBRS Explorer
- Auth: HMAC-SHA256 cookie-based (middleware.ts)

## Build & Deploy
```bash
npm run build          # local build check
# Deploy to VPS:
scp <files> root@178.156.243.51:/opt/nibrs/app/
ssh root@178.156.243.51 "cd /opt/nibrs/app && npm run build && pm2 restart nibrs"
```

## Architecture
- `lib/claude.ts` — System prompt for Current Trends + Historical tabs
- `lib/nibrs-claude.ts` — System prompt for NIBRS Explorer tab (~1200 lines)
- `app/api/query/route.ts` — API route for Current Trends/Historical (SSE streaming)
- `app/api/nibrs-query/route.ts` — API route for NIBRS Explorer (JSON response)
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
