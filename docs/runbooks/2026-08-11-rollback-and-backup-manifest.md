# Rollback and backup manifest — verified-answer-only project

**Created:** 2026-08-11 (Stage 0)
**Contract:** `docs/superpowers/specs/2026-08-11-verified-answer-only-handoff.md` §12
**Baseline measurements:** `docs/reviews/2026-08-11-stage0-production-baseline.md`

**Nothing in this document has been executed.** Every command that mutates production is listed here for separate approval. Stage 0 performed read-only inspection only.

---

## 1. Preserved baseline

| Item | Value |
|---|---|
| Baseline release directory | `/opt/nibrs/releases/20260811_151557` |
| Baseline commit | `c2b52ca638149e1f282c6e1bffe4f90760c373f0` |
| Commit subject | "Preserve unknown-month juvenile incident totals" |
| Branch carrying it (VPS) | `dev` |
| Branch carrying it (local) | `fix/clearance-session-reliability` |
| Previous releases retained | `20260811_151139`, `20260811_141624`, `20260810_235313`, `20260810_234249` |

**Do not delete `/opt/nibrs/releases/20260811_151557` until enforcement has passed its observation period and cleanup is explicitly approved** (handoff §12).

### Pinning is required, and a tag is not a substitute

`deploy-zero-downtime.sh` keeps the last `KEEP_RELEASES=5` releases and previously protected only the current symlink target. Five deploys after this baseline was chosen, it would have been pruned — while the observation window was still open. A git tag does not help: it preserves the *source*, not the built release directory, and a rebuild is not the same artifact (different `node_modules` resolution, different build inputs).

The deploy script now honours a pin list. **Creating it is a production action awaiting approval:**

```bash
mkdir -p /opt/nibrs/releases
echo "20260811_151557" >> /opt/nibrs/releases/.pinned
cat /opt/nibrs/releases/.pinned
```

Verify on the next deploy that the log contains `Keeping 20260811_151557 (pinned)`. **Unpinning while an observation window is open requires owner approval.** Rollback for this step is deleting the line.

### Awaiting approval — tag the baseline

The handoff requires the baseline commit to be tagged. Not done: tagging pushes a ref to a shared remote.

```bash
git tag -a verified-answer-baseline-20260811 c2b52ca -m "Baseline before verified-answer-only work"
git push origin verified-answer-baseline-20260811
```

### Release provenance — fixed forward, but the baseline stays inferred

A release directory contained no `.git` and no `RELEASE_INFO`, so `20260811_151557 -> c2b52ca` is **inferred** from the VPS repo HEAD and deploy timing rather than read from the release.

`deploy-zero-downtime.sh` now writes `RELEASE_INFO` (release, commit, branch, built_at, built_by, host) into each release directory *before* the build, so an aborted build still leaves an identifiable directory. This is fixed forward only: **every release that exists today, including the baseline, remains unstamped.** Treat the baseline mapping as inferred until a stamped release supersedes it, and confirm the commit from `/opt/nibrs/repo` before relying on it during a rollback.

---

## 2. Application rollback (primary path)

Rollback is the existing atomic symlink swap. It is unchanged by this project and remains the first response to any problem.

```bash
ssh root@178.156.243.51
bash /opt/nibrs/repo/scripts/rollback.sh --list          # show available releases
bash /opt/nibrs/repo/scripts/rollback.sh                 # revert to previous release
bash /opt/nibrs/repo/scripts/rollback.sh 20260811_151557 # revert to the named baseline
```

### Verification after any rollback

Run all of these; a rollback is not complete until each passes.

```bash
ls -l /opt/nibrs/current                       # symlink points where intended
pm2 jlist | grep -o '"name":"nibrs"'           # app present
pm2 describe nibrs | grep -E 'status|restart'  # online, restarts not climbing
curl -s -o /dev/null -w '%{http_code}\n' https://nibrsai.com/
curl -s -o /dev/null -w '%{http_code}\n' https://nibrsai.com/test
```

Then exercise one live query per source (Current Trends, Historical, NIBRS, SHR, Hate Crime) through the UI and confirm each returns an answer and a chart where expected. Per CLAUDE.md, a passing build is not evidence a feature works.

Finally confirm logging survived the rollback:

```bash
sqlite3 /opt/nibrs/shared/query_log.db "select max(id), datetime(max(ts)/1000,'unixepoch') from query_log;"
```

The id must advance after the post-rollback test queries. This is the check that proves the additive-schema requirement held: **the baseline application must be able to read and write a migrated `query_log`.**

---

## 3. Database backup procedure (awaiting approval)

Required before **each** schema migration (handoff §12.5). `query_log.db` is 13.2 MiB, so a full copy is trivial.

```bash
# On the VPS, immediately before a migration:
STAMP=$(date -u +%Y%m%d_%H%M%S)
sqlite3 /opt/nibrs/shared/query_log.db ".backup '/opt/nibrs/shared/backups/query_log.${STAMP}.db'"
sqlite3 /opt/nibrs/shared/backups/query_log.${STAMP}.db "pragma integrity_check;"
ls -la /opt/nibrs/shared/backups/query_log.${STAMP}.db
```

`.backup` is used rather than `cp` deliberately: the app is live and SQLite may be mid-write, so a filesystem copy can capture a torn page. `.backup` takes a consistent snapshot of a database in use.

`/opt/nibrs/shared/backups/` does not exist yet and must be created (`mkdir -p`), which is itself a production mutation awaiting approval.

Retention: keep every pre-migration backup until enforcement passes its observation period. At 13 MiB each this is immaterial.

**Databases affected by planned additive migrations:** `query_log.db` only, through Stage 3. `crime_data.db`, `nibrs.db`, `shr.db`, and `nibrs_rollups.db` are read-only to the app; Stage 2 build receipts will write to whichever database each builder owns, and that migration will require its own backup entry here before it runs.

### Restoring is a last resort

Restoring an older `query_log.db` **loses every query and audit record written since the backup**. Because all migrations are additive and nullable, the baseline application can run against a migrated database — so the correct response to a bad migration is almost always application rollback (§2), not database restore. Restore only if the migration corrupted data, and only with explicit approval.

---

## 4. Crontab change (awaiting approval)

From the baseline: the digest wrapper runs weekly instead of nightly, and `run-query-audit.ts` is separately scheduled daily, so it double-runs on Mondays.

**Current:**
```
0 13 * * *   cd /opt/nibrs/current && SHR_DB_PATH=/opt/nibrs/shr.db npx tsx scripts/run-query-audit.ts >> /var/log/cda-analysis.log 2>&1
5 13 * * 1   bash /opt/nibrs/current/scripts/nightly-audit-and-digest.sh >> /var/log/cda-analysis.log 2>&1
```

**Proposed — replace both with one line:**
```
0 13 * * *   /opt/nibrs/current/scripts/nightly-audit-and-digest.sh >> /var/log/cda-analysis.log 2>&1
```

Before applying, capture the current crontab so rollback is exact:

```bash
crontab -l > /root/crontab.backup.$(date -u +%Y%m%d_%H%M%S)
```

**Rollback:** `crontab /root/crontab.backup.<stamp>`

**Expected effects, all internal:** the digest email moves from weekly to daily; the rendered-chart auditor executes for the first time and begins populating `chart_audit_results` (24 artifacts are waiting); the Monday double-run of the query auditor stops. No user-visible behavior changes — the wrapper touches no request path.

**Watch after applying:** the run is bounded by `AUDIT_TIMEOUT_SECONDS=900` and `CHART_AUDIT_TIMEOUT_SECONDS=300`, and Resend headers observed on 2026-08-10 showed `x-resend-daily-quota: 0` / `x-resend-monthly-quota: 9`. Moving from weekly to daily multiplies send volume by ~7; confirm the Resend plan tolerates it before enabling, or the digest will start failing to send for a quota reason that looks like an auth failure.

---

## 5. Kill switches available today

Stage 0 shipped the configuration surface (`lib/proof-modes.ts`). It is not yet consulted by any request path, so these are inert until Stage 1 — but they are the documented controls from here on.

| Control | Effect |
|---|---|
| `PROOF_KILL_SWITCH=1` | Forces every source to `off`, outranking all other settings |
| `PROOF_MODE=off` | Global ceiling; clamps every per-source and per-family override down to `off` |
| `PROOF_MODE_<SOURCE>` | Per-source override, clamped by the global ceiling |
| `PROOF_MODE_FAMILY_<SOURCE>_<FAMILY>` | Per-family override, clamped by the global ceiling |

Overrides can only narrow behavior, never widen it past the global setting — so setting `PROOF_MODE=off` during an incident is sufficient on its own; no stale per-family variable can keep enforcing. Verified by `scripts/test-proof-modes.ts`.

Applying any of these to production is a PM2 environment change (`pm2 reload nibrs --update-env`) and requires approval.

---

## 6. Rollback rehearsal (required before enforcement, not yet performed)

Handoff §12 requires a rehearsal before any user-visible enforcement. Sequence, to be run and recorded here when scheduled:

1. Deploy the shadow release.
2. Verify all five query surfaces and PM2 workers (§2 verification).
3. Roll back to `20260811_151557`.
4. Verify all five surfaces and workers again, including that `query_log` still accepts writes under the migrated schema.
5. Return to the shadow release.
6. Record commands, timestamps, release IDs, and outcomes in this document.

---

## 7. Production actions awaiting approval — consolidated

| # | Action | Risk | Reversible by |
|---|---|---|---|
| 1 | **Pin the baseline release** (`echo 20260811_151557 >> /opt/nibrs/releases/.pinned`) | Very low | Delete the line |
| 2 | Tag baseline commit and push the tag | Very low | `git tag -d` / `git push --delete` |
| 3 | `mkdir -p /opt/nibrs/shared/backups` | Very low | `rmdir` |
| 4 | Back up `query_log.db` before any migration | Very low (read-only on the live DB) | Delete the backup file |
| 5 | Replace the two crontab lines with one nightly entry | Low — internal only; **resolve the Resend daily-volume question first** | Restore `crontab.backup.<stamp>` |
| 6 | Deploy any Stage 0/1 code | Low in `off` mode | `rollback.sh` |

None has been performed. **Item 1 must happen before the first staged deployment**, since each deploy moves the baseline one place closer to the prune threshold. `RELEASE_INFO` writing and pin support are now in the deploy script (item 6 carries them to production); no separate action is required for either.
