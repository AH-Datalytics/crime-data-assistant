# release-health.sh -- sourced by scripts/release.sh. The release windows' accepted health helpers (audit
# release packages, server/lib-c.sh: app_workers, db_probe, app_healthy) with the window's T0/STAGE plumbing
# replaced by absolute deadlines and a work directory. Needs bounded_run (scripts/lib/bounded-run.sh).
#
# FAIL-CLOSED RULE: a read that fails, times out or returns nothing is NEVER evidence. It cannot count as
# healthy, and every caller treats non-zero as "not established".
: "${NIBRS_ROOT:=/opt/nibrs}"
: "${SHR_DB:=$NIBRS_ROOT/shr.db}"
: "${PM2:=pm2}"
: "${NODE:=/usr/bin/node}"
: "${HEALTH_BASE:=http://localhost:3000}"
: "${PROC:=/proc}"
: "${APP:=nibrs}"
: "${WORKERS:=4}"
: "${WORK:?WORK, the attempt work directory, is not set}"

canon_dir() { ( cd "$1" 2>/dev/null && pwd -P ); }

# "<pid>\t<status>" for each worker of $APP from `pm2 jlist` (bounded by the deadline $1). Non-zero if pm2 or the
# parse fails.
app_workers() {
  bounded_run "$1" 5 -- $PM2 jlist > "$WORK/.jlist" 2>/dev/null || return 1
  "$NODE" -e '
const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").replace(/^[^\[]*/,""));
if(!Array.isArray(a)) process.exit(2);
for (const p of a.filter(p=>p.name===process.argv[2])) console.log([p.pid,p.pm2_env.status].join("\t"));
' "$WORK/.jlist" "$APP"
}

# Read-only probe through the release's OWN better-sqlite3: `/` and `/test` never open SQLite, so health alone
# proves nothing about the database binding.
db_probe() {
  local release="$1" dl="$2"
  bounded_run "$dl" 5 -- "$NODE" -e '
const DB=require(process.argv[1]+"/node_modules/better-sqlite3");
const d=new DB(process.argv[2],{readonly:true,fileMustExist:true});
const b=d.prepare("SELECT COUNT(*) n FROM shr_agency_type_binding").get().n;
console.log(JSON.stringify({binding:b}));
process.exit(b>0 ? 0 : 1);
' "$release" "$SHR_DB"
}

# Healthy = exactly $WORKERS workers online with cwd = $1, then `/` and `/test` 200 on two consecutive rounds, then
# the database probe. Polls until the absolute deadline $2. A failed worker read counts as NOT healthy.
app_healthy() {
  local release="$1" dl="$2" ok rounds=0 pid status c s p n=0 canon rows
  canon=$(canon_dir "$release")
  [[ -n "$canon" ]] || { log "release $release is not a readable directory"; return 1; }
  while (( $(date +%s) < dl )); do
    ok=1; n=0
    if rows=$(app_workers "$dl"); then
      while IFS=$'\t' read -r pid status; do
        [[ -z "$pid" ]] && continue; n=$((n+1))
        c=$(canon_dir "$PROC/$pid/cwd")
        [[ "$status" == online && -n "$c" && "$c" == "$canon" ]] || ok=0
      done <<< "$rows"
    else ok=0; fi
    (( n == WORKERS )) || ok=0
    if (( ok )); then
      for p in / /test; do
        # With a site password set, pages need the auth cookie (middleware.ts); HEALTH_COOKIE carries it.
        s=$(bounded_run "$dl" 5 -- curl -s -o /dev/null -w '%{http_code}' --max-time 10 ${HEALTH_COOKIE:+-H "Cookie: nibrs_auth=$HEALTH_COOKIE"} "$HEALTH_BASE$p" 2>/dev/null)
        [[ "$s" =~ ^[0-9]{3}$ ]] || s=000
        [[ "$s" =~ ^(200|304)$ ]] || ok=0
      done
    fi
    if (( ok )); then rounds=$((rounds+1)); else rounds=0; fi
    if (( rounds >= 2 )); then
      if db_probe "$release" "$dl" > "$WORK/.dbprobe" 2>&1; then log "healthy: $WORKERS workers on $release, / and /test twice, database probe"; return 0; fi
      log "workers and HTTP healthy but the database probe failed: $(head -c 300 "$WORK/.dbprobe")"; return 1
    fi
    sleep 2
  done
  log "not healthy by the deadline (workers $n/$WORKERS)"; return 1
}
