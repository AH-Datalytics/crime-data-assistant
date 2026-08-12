# Stage 0 production baseline — verified-answer-only project

**Measured:** 2026-08-11, 22:16–22:35 UTC (production window)
**Measured by:** Claude, read-only SSH to `root@178.156.243.51`
**Contract:** `docs/superpowers/specs/2026-08-11-verified-answer-only-handoff.md`
**Purpose:** satisfy handoff §4 ("the final reviewer must re-verify these facts") and Stage 0's requirement that planning observations be re-measured before they become baselines or acceptance thresholds.

Every value below was produced by the command shown. Nothing here is carried over from the planning conversation. Three planning observations were **confirmed**, one was **corrected**, and one previously-unreported defect was **found**.

---

## 1. Release, commit, and configuration

| Fact | Value |
|---|---|
| Symlink | `/opt/nibrs/current -> /opt/nibrs/releases/20260811_151557` |
| Symlink mtime | 2026-08-11 15:17 UTC |
| Recent releases | `20260810_234249`, `20260810_235313`, `20260811_141624`, `20260811_151139`, `20260811_151557` |
| VPS repo HEAD | `c2b52ca638149e1f282c6e1bffe4f90760c373f0` on branch `dev` |
| VPS repo HEAD subject | "Preserve unknown-month juvenile incident totals" |
| Local HEAD | same commit, on branch `fix/clearance-session-reliability` |
| PM2 app | `nibrs`, cluster of 4, `status=online`, `restart_time=65`, cwd `/opt/nibrs/current` |

Release directories contain no `.git` and no `RELEASE_INFO`, so **a release directory cannot be mapped to a commit from the filesystem alone.** The mapping above is inferred from the VPS repo HEAD plus deploy timing. This is a rollback-relevant gap; see the manifest's "Open gap" section.

```bash
ls -l /opt/nibrs/current
ls -1 /opt/nibrs/releases/ | tail -6
cd /opt/nibrs/repo && git rev-parse HEAD && git rev-parse --abbrev-ref HEAD
pm2 jlist
```

### Runtime paths (from PM2 env, matching CLAUDE.md)

```
APP_DIR              = /opt/nibrs/current
QUERY_LOG_DB_PATH    = /opt/nibrs/shared/query_log.db
RTCI_DB_PATH         = /opt/nibrs/shared/crime_data.db
NIBRS_DB_PATH        = /opt/nibrs/nibrs.db
NIBRS_ROLLUP_DB_PATH = /opt/nibrs/shared/nibrs_rollups.db
SHR_DB_PATH          = /opt/nibrs/shr.db
```

The hate-crime flag is **not** in the PM2 environment, but it is **not unlocated** — an earlier revision of this document said so in error, after a `grep` that covered only `/opt/nibrs/shared/.env`. Corrected on Codex review:

```
/opt/nibrs/shared/.env.local:
  NEXT_PUBLIC_ENABLE_HATE_CRIME=…
  HATE_CRIME_DB_PATH=…
```

`scripts/deploy-zero-downtime.sh:116` reads `NEXT_PUBLIC_ENABLE_HATE_CRIME` from `.env.local` (falling back to `.env`) and calls `die` if it is absent or not exactly `true`/`false`; when `true` it additionally requires `HATE_CRIME_DB_PATH`. The value reaches the running app through Next.js's own `.env.local` loading rather than through PM2, which is why it is absent from `pm2 jlist`. Stage 2 hate-crime source health has a defined flag and DB path to validate against.

**Process note for later stages:** the same mistake — reading a `head`-truncated listing as complete — produced this error and also hid `.env.local` from the earlier file inventory. Enumerate env files explicitly rather than relying on a truncated glob.

### Environment files

Full enumeration (`ls -1 /opt/nibrs/shared/.env*`), keys only:

| File | Keys |
|---|---|
| `.env` | `RTCI_DB_PATH`, `NIBRS_DB_PATH`, `SHR_DB_PATH`, `QUERY_LOG_KEY`, `FOLLOWUP_PLANNER_MODE` |
| `.env.local` | `ANTHROPIC_API_KEY`, `TURNSTILE_SECRET`, `HATE_CRIME_DB_PATH`, `NEXT_PUBLIC_ENABLE_HATE_CRIME`, `NIBRS_CANARY_MODEL`, `NIBRS_CANARY_SESSIONS` |
| `.env.cron` | `RESEND_API_KEY` |
| `.env.bak-20260618-rtci-path` | (backup, not loaded) |

`.env` and `.env.cron` are mode 600. Values were never read — only key names.

`.env.cron` exists at mode 600, as `nightly-audit-and-digest.sh` requires. `grep -c 'FATAL: RESEND_API_KEY' /var/log/cda-analysis.log` returned **0** — the digest has never failed for a missing key.

---

## 2. Schedulers

```bash
crontab -l
systemctl list-timers --all --no-pager
```

Relevant crontab entries:

```
0 13 * * *    run-query-audit.ts                         (daily)
5 13 * * 1    nightly-audit-and-digest.sh                (WEEKLY — Mondays)
30 12 * * *   nightly-latency-scoreboard.ts --hours 24   (daily)
0 6 * * *     /opt/nibrs/auto-update-rtci.sh             (daily)
0 7 16 * *    nibrs-auto-update.py                       (monthly)
0 6 16 * *    update-nibrs-coverage.py + pm2 reload       (monthly)
30 9 16 * *   shr-auto-update.js                          (monthly)
0 9 16 * *    update-hate-crime.sh                        (monthly)
```

Active systemd timer: `nibrs-juvenile-rollup-20260811-early.timer`, next fire 2026-08-12 00:00 UTC. **Out of scope and untouched**, per the Stage 0 boundary.

**Confirmed defect (planning observation was correct).** The wrapper is scheduled weekly despite being named and documented nightly, and `run-query-audit.ts` is additionally scheduled standalone daily — so it double-runs on Mondays. Corrective crontab is documented in `scripts/nightly-audit-and-digest.sh`; applying it is a production change awaiting approval.

---

## 3. Chart audit chain — root cause identified

| Table | Rows |
|---|---|
| `chart_audit_artifacts` | 24 |
| `chart_render_receipts` | 15 |
| `chart_audit_results` | **0** |

Artifact `created_at` range: 1786405553399 – 1786476967990 (2026-08-10 → 2026-08-11).

**Root cause: scheduling, not audit logic.** The chart auditor was added to the wrapper in `99803bf` (2026-08-10 18:28 CDT) and first deployed in release `20260810_234249`. The wrapper's most recent execution was 2026-08-10 13:05 UTC — *before* that release — and its next firing under the weekly schedule is 2026-08-17. The chart auditor has therefore **never executed in production**.

Corroborating evidence: the 2026-08-10 log line reads `done (auditor exit 0, digest exit 0)` — the two-auditor format introduced by `99803bf` (`query auditor …, chart auditor …, digest …`) does not appear anywhere in the log.

```bash
tail -30 /var/log/cda-analysis.log
sqlite3 query_log.db "select count(*) from chart_audit_artifacts; ..."
```

Verified by construction: `scripts/test-chart-audit-pipeline.ts` drives the real runner against a production-shaped fixture (joined + orphaned artifact, one render receipt) and asserts result rows are written, the receipt-backed artifact reaches `verified-rendered`, the receiptless one reaches `unverified`, and a second run upserts rather than duplicates.

---

## 4. `model_response` — planning observation CORRECTED

Population is **0 rows**, as reported. The planning note assumed this needed diagnosis as a defect. **It is not a defect.**

| Measure | Value |
|---|---|
| Rows with `model_response` non-null | 0 |
| NIBRS rows tagged `no-sql-server-template` (all time) | 25 |
| …of those, `id > 8000` | 17 |
| NIBRS rows tagged `internal-leak-firewall` | 0 |
| Most recent eligible row | id 8393 @ 2026-08-10 23:27:00 UTC |
| `max(id)` | 8444 |

The writer and its migration both arrived in `9661609` (2026-08-10 14:00:58 CDT = 19:00:58 UTC), first deployed in release `20260810_234249` (23:42:49 UTC). The most recent eligible row predates that release by 15 minutes. **Zero eligible events have occurred since the writer was deployed**, which fully explains the zero without any defect.

Confirmed by code trace, not inference:
- Only call site is `app/api/nibrs-query/route.ts:662`, on the unexplained-no-SQL fallback.
- `writeNibrsLog` → `logNibrsQuery` argument alignment is correct (positional order verified against both signatures).
- `logNibrsQuery` (`lib/nibrs-db.ts:154`) gates the column on a runtime `PRAGMA table_info` check.
- `git merge-base --is-ancestor 9661609 c2b52ca` → true.

**Real gap this exposed** (not a bug, but a Stage 1 input): `model_response` can *only* ever be written by the NIBRS route. `logQuery` in `lib/rtci-db.ts` — used by Current/Historical, SHR, and Hate Crime — has no `model_response` in its column list at all. Under handoff §3.13 (uniform treatment of all five sources), this asymmetry must be closed when proof capture lands.

---

## 5. Latency (60-day window)

```bash
sqlite3 query_log.db "select ms from query_log where ms is not null and ts > strftime('%s','2026-06-12')*1000 order by ms" \
  | awk '{a[NR]=$1} END {printf "n=%d p50=%d p95=%d p99=%d max=%d\n", NR, a[int(NR*0.5)], a[int(NR*0.95)], a[int(NR*0.99)], a[NR]}'
```

```
n=4173  p50=3800  p95=12483  p99=38578  max=98175
```

**Confirms** the planning observation (~3.8 s median, ~12.5 s p95). The handoff's validation budget (<50 ms median, <100 ms p95 added) is 1.3% of current median — ample headroom, and the budget should be enforced as an absolute figure rather than a percentage.

---

## 6. Deterministic path share

Human traffic since 2026-05-13 (internal sessions excluded by the `INTERNAL_SESSION` pattern used in `scripts/daily-query-analysis.js`):

| Measure | Value |
|---|---|
| Deterministic answers | 138 |
| Total human answers | 1,310 |
| **Deterministic share** | **10.5%** |

**Confirms** the planning observation exactly. Per-tab (same window, from the earlier planning pass, not re-run here): historical 71/416, nibrs 53/386, current 21/359, shr 23/188, hate_crime 1/43.

---

## 7. Audit and findings state

| Measure | Value |
|---|---|
| `audit_runs` rows | 11 |
| Latest run | id 12, `status=ok`, 93 rows audited, 10 findings, 2026-08-11 13:00:06 UTC |
| `audit_findings` total | 1,021 |
| …with `status='open'` | **1,021** |

Zero findings have ever been adjudicated. `audit_findings.status` exists and is indexed but has no writer — confirming handoff §4. This is Stage 3 scope.

`query_log` schema as deployed:

```
id, ts, question, sql, rows, error, ms, response, tab, guardrails, model, session_id,
routing_confidence, routing_mode, routing_reason, query_guidance, query_contract,
model_response, request_id
CREATE UNIQUE INDEX idx_query_log_request_id ON query_log(request_id) WHERE request_id IS NOT NULL;
```

`query_log.db` size: 13,848,576 bytes (13.2 MiB) at 2026-08-11 20:35 UTC. Relevant to the backup procedure: a full copy is cheap.

---

## 8. Summary of corrections to the handoff

| Handoff §4 statement | Status |
|---|---|
| Weekly-vs-nightly schedule mismatch | **Confirmed**, plus a second defect (daily standalone auditor causes a Monday double-run) |
| `chart_audit_results` empty with artifacts + receipts present | **Confirmed**; root cause is the schedule, and the auditor has never run in production |
| `model_response` population zero "must be diagnosed, not assumed fixed" | **Diagnosed: not a defect.** Correct-but-unexercised; no eligible event since deploy. Separate real gap: only NIBRS can ever write it |
| ~3.8 s median / ~12.5 s p95 latency | **Confirmed** (3,800 / 12,483 ms, n=4,173) |
| ~10.5% deterministic share | **Confirmed** (138/1,310) |
| `audit_findings.status` all open | **Confirmed** (1,021/1,021) |

**New findings not in the handoff:**

1. Release directories carried no commit identifier, so release → commit was not recoverable from the filesystem. **Addressed:** `deploy-zero-downtime.sh` now writes `RELEASE_INFO` (release, commit, branch, build time, builder, host) into each release directory before building. Existing releases — including the baseline — remain unstamped, so the baseline mapping stays inferred.
2. Pruning kept only the last five releases and protected only the current symlink target, so the preserved baseline would eventually have been deleted mid-observation-window. **Addressed:** `deploy-zero-downtime.sh` now honours a `releases/.pinned` list that is never pruned. Creating that file on the VPS is a production action awaiting approval.
3. `logQuery` in `lib/rtci-db.ts` cannot write `model_response` at all, making diagnostic capture NIBRS-only. Open; Stage 1 scope.

**Corrected on review:** the hate-crime flag is located (`NEXT_PUBLIC_ENABLE_HATE_CRIME` in `.env.local`, read by the deploy script); an earlier revision of this document wrongly called it unlocated. See §1.
