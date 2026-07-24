# NIBRS compact rollups

The compact database accelerates state and national queries while preserving
the 165 GB `nibrs.db` as the source of truth. It contains separate state and
national tables for arrestee, victim, offender, relationship, weapon,
circumstance, and clearance summaries. ORI-level rows are deliberately absent.

## Safety contract

- Never run `build-nibrs-rollups.py` on the production web host. The script
  refuses the known production hostname.
- Build from a quiescent copy or volume snapshot on another machine.
- Do not replace `nibrs.db`. Deploy the compact DB as a separate immutable file.
- Routing falls back to `nibrs.db` when the rollup is absent, older than the source,
  or has a generation token that differs from the production source marker.
- City, county, agency, ORI, and continuous-reporter SQL never routes to the
  compact DB.

## Build and validate off-production

```bash
python3 scripts/build-nibrs-rollups.py \
  --source /data/nibrs.db \
  --output /data/nibrs_rollups-YYYYMMDD.db \
  --source-generation "$(tr -d '\r\n' < /data/nibrs_source.generation)"
```

The release build must run without `--skip-verify`. The builder checks exact
measure totals against the source plus state/year and national/year totals,
then prints the output size and SHA-256.

Replay the May-July slow-query corpus on the same build machine:

```bash
python3 scripts/benchmark-nibrs-rollups.py \
  --query-log /data/query_log.db \
  --source /data/nibrs.db \
  --rollup /data/nibrs_rollups-YYYYMMDD.db \
  --output /data/nibrs-rollup-benchmark-YYYYMMDD.json
```

## Atomic data deployment

Use the deployment helper to verify the artifact SHA-256 and ensure its generation
still matches production before atomically switching the stable symlink. Do not
overwrite an open database file.

```bash
scripts/deploy-nibrs-rollup.sh /data/nibrs_rollups-YYYYMMDD.db root@WEB
```

Deploy the application with `scripts/deploy-zero-downtime.sh`. The ecosystem
configuration sets `NIBRS_ROLLUP_DB_PATH=/opt/nibrs/shared/nibrs_rollups.db`.
After reload, confirm the juvenile-arrest-by-race query is logged with
`nibrs-query-plan`, returns the same totals, and completes well below the 38s
baseline. Check the NIBRS P95 against the pre-fix 45.5s baseline.

## Rollback

Application rollback uses `scripts/rollback.sh`. Data rollback only requires
repointing `nibrs_rollups.db` to the prior version and reloading PM2. Removing
the symlink also safely disables rollup routing and returns all traffic to
`nibrs.db`.

## Continuity after a source update

`nibrs-auto-update.py` publishes `/opt/nibrs/shared/nibrs_source.generation`
only after the source update, summary rebuild, verification, and final WAL checkpoint
succeed. A source-file modification time newer than the compact database also
invalidates routing, covering an updater crash before the marker is published.

After either signal changes, the API automatically uses the full `nibrs.db`.
This preserves correctness but temporarily restores pre-rollup latency. To restore
the fast path:

1. Copy the quiescent source database and `nibrs_source.generation` to a
   non-production build machine. Preserve the source file timestamp when possible.
2. Build and validate with the copied generation token using the command above.
3. Run `deploy-nibrs-rollup.sh`. It refuses activation if production changed
   again during the build or upload.
4. Run `NIBRS_DB_PATH=/opt/nibrs/nibrs.db NIBRS_ROLLUP_DB_PATH=/opt/nibrs/shared/nibrs_rollups.db NIBRS_SOURCE_GENERATION_PATH=/opt/nibrs/shared/nibrs_source.generation npx tsx scripts/check-nibrs-rollup-freshness.ts` on the web host.

No application restart is required for a data-only rollup switch; new query workers
resolve the stable symlink for each query.