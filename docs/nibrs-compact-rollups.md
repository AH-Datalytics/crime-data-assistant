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
- Routing falls back to `nibrs.db` when `NIBRS_ROLLUP_DB_PATH` is unset, absent,
  or empty.
- City, county, agency, ORI, and continuous-reporter SQL never routes to the
  compact DB.

## Build and validate off-production

```bash
python3 scripts/build-nibrs-rollups.py \
  --source /data/nibrs.db \
  --output /data/nibrs_rollups-YYYYMMDD.db
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

Copy to a versioned temporary path, verify the digest, then rename and update
the stable symlink. Do not overwrite an open database file.

```bash
scp nibrs_rollups-YYYYMMDD.db root@WEB:/opt/nibrs/shared/nibrs_rollups-YYYYMMDD.db.tmp
ssh root@WEB 'sha256sum /opt/nibrs/shared/nibrs_rollups-YYYYMMDD.db.tmp'
ssh root@WEB 'mv /opt/nibrs/shared/nibrs_rollups-YYYYMMDD.db.tmp /opt/nibrs/shared/nibrs_rollups-YYYYMMDD.db && ln -sfn nibrs_rollups-YYYYMMDD.db /opt/nibrs/shared/nibrs_rollups.db'
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
