#!/usr/bin/env bash
# test-release.sh -- offline tests of scripts/release.sh (Linux: needs flock, timeout, node). Every failure path of
# the design runs against fakes in a scratch directory: the deploy, the rollback script, pm2, /proc, curl, the Studio
# control CLI, the query log and the public site. Nothing touches /opt or the network beyond 127.0.0.1.
#   bash scripts/test-release.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
OLD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
pass=0; fail=0
ok()  { if [[ "$2" == "$3" ]]; then pass=$((pass+1)); echo "  PASS  $1"; else fail=$((fail+1)); echo "  FAIL  $1 (expected '$3', got '$2')"; fi; }
has() { if grep -q -- "$3" "$2" 2>/dev/null; then pass=$((pass+1)); echo "  PASS  $1"; else fail=$((fail+1)); echo "  FAIL  $1 ('$3' not in $2)"; fi; }

PORT=$(( 20000 + RANDOM % 20000 ))
TOP=$(mktemp -d)
trap 'kill $SITE_PID 2>/dev/null; rm -rf "$TOP"' EXIT

# A fresh fake server for one scenario. $1 = the new release's answer variant, $2.. = KEY=VALUE behavior switches.
setup() {
  T="$TOP/case$((++CASE))"; R="$T/opt"
  mkdir -p "$R/releases" "$R/shared" "$R/scripts" "$T/bin" "$T/proc" "$T/bundle"
  : > "$T/qlog"; : > "$T/notify"; : > "$T/studio"
  mk_release R1 "$OLD" same
  ln -sfn "$R/releases/R1" "$R/current"
  ln -sfn "$R/current/scripts/nibrs-auto-update.py" "$R/scripts/nibrs-auto-update.py"
  echo "AUTH_PASSWORD=test-secret" > "$R/shared/.env"
  : > "$R/maintenance.lock"
  NEWVARIANT="$1"; shift
  for kv in "$@"; do export "$kv"; done
  # /proc/<pid>/cwd -> the release the fake pm2 has loaded (follows the link unless frozen)
  for i in 1 2 3 4; do rm -rf "$T/proc/10$i"; mkdir -p "$T/proc/10$i"; ln -sfn "$R/current" "$T/proc/10$i/cwd"; done
  # the bundle = this repo's scripts (release.sh runs from it)
  cp -r "$REPO/scripts" "$T/bundle/"
  cat > "$T/bin/pm2" <<EOF
#!/usr/bin/env bash
if [[ "\$1" == jlist ]]; then
  cur=\$(basename "\$(readlink -f "$R/current")")
  st=online; [[ -e "$T/unhealthy-\$cur" ]] && st=errored
  echo '[{"name":"nibrs","pid":101,"pm2_env":{"status":"'\$st'"}},{"name":"nibrs","pid":102,"pm2_env":{"status":"'\$st'"}},{"name":"nibrs","pid":103,"pm2_env":{"status":"'\$st'"}},{"name":"nibrs","pid":104,"pm2_env":{"status":"'\$st'"}}]'
fi
[[ "\$1" == reload ]] && { echo reload "\$@" >> "$T/reloads"; [[ -e "$T/fixed-by-reload" ]] && rm -f "$T"/unhealthy-*; }
exit 0
EOF
  cat > "$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo 200
EOF
  cat > "$T/bin/studio" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$T/studio"
case "\$1" in
  lock) [[ -e "$T/studio-locked" ]] && { echo "refused: lock held or maintenance"; exit 1; }; echo '{"token":"tok1"}' ;;
  wait-drained) [[ -e "$T/studio-busy" ]] && exit 1; exit 0 ;;
  unlock) exit 0 ;;
esac
EOF
  cat > "$T/bin/sqlite3" <<EOF
#!/usr/bin/env bash
sid=\$(echo "\$3" | sed -n "s/.*session_id = '\([^']*\)'.*/\1/p")
n=\$(grep -c "^\$sid " "$T/qlog"); d=\$(grep -c "^\$sid deterministic\$" "$T/qlog")
echo "\$n|\$d"
EOF
  # the fake deploy: FAKE_DEPLOY = ok | fail-before | fail-after | hang-after | no-switch-ok
  cat > "$T/bin/deploy" <<EOF
#!/usr/bin/env bash
case "\${FAKE_DEPLOY:-ok}" in
  fail-before) echo "build failed"; exit 1 ;;
  no-switch-ok) exit 0 ;;
esac
mkdir -p "$R/releases/R2/node_modules/better-sqlite3"
cp "$R/releases/R1/node_modules/better-sqlite3/index.js" "$R/releases/R2/node_modules/better-sqlite3/"
printf 'commit=%s\n' "\$1" > "$R/releases/R2/RELEASE_INFO"; echo "$NEWVARIANT" > "$R/releases/R2/variant"
ln -sfn "$R/releases/R2" "$R/current.tmp" && mv -Tf "$R/current.tmp" "$R/current"
case "\${FAKE_DEPLOY:-ok}" in
  fail-after) exit 1 ;;
  hang-after) sleep 300; ln -sfn "$R/releases/R2" "$R/late-switch-marker" ;;
esac
exit 0
EOF
  # the fake rollback script: FAKE_ROLLBACK = ok | noop
  cat > "$T/bin/rollback" <<EOF
#!/usr/bin/env bash
[[ "\${FAKE_ROLLBACK:-ok}" == noop ]] && exit 0
ln -sfn "$R/releases/\$1" "$R/current.tmp" && mv -Tf "$R/current.tmp" "$R/current"
EOF
  cat > "$T/bin/notify" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$T/notify"
EOF
  chmod +x "$T/bin/"*
  restart_site
}
mk_release() {
  mkdir -p "$R/releases/$1/node_modules/better-sqlite3"
  printf 'commit=%s\n' "$2" > "$R/releases/$1/RELEASE_INFO"; echo "$3" > "$R/releases/$1/variant"
  cat > "$R/releases/$1/node_modules/better-sqlite3/index.js" <<'EOF'
module.exports = class { constructor() {} prepare() { return { get: () => ({ n: 1 }) }; } };
EOF
}
SITE_PID=""
restart_site() {
  [[ -n "$SITE_PID" ]] && kill "$SITE_PID" 2>/dev/null && wait "$SITE_PID" 2>/dev/null
  PORT=$((PORT+1))
  node "$REPO/scripts/fixtures/release-checks/fake-site.cjs" "$PORT" "$R" "$T/qlog" > "$T/site.log" 2>&1 &
  SITE_PID=$!
  for _ in $(seq 1 50); do grep -q "fake site" "$T/site.log" 2>/dev/null && break; sleep 0.1; done
}
run() {
  ( unset FAKE_DEPLOY FAKE_ROLLBACK
    for kv in "$@"; do export "$kv"; done
    PATH="$T/bin:$PATH" NIBRS_ROOT="$R" RELEASE_LOG_DIR="$T/logs" RELEASE_LOCK="$R/release.lock" \
    NIBRS_MAINTENANCE_LOCK="$R/maintenance.lock" QUERY_LOG_DB="$T/qlog" RELEASE_BASE_URL="http://127.0.0.1:$PORT" \
    RELEASE_DEPLOY_CMD="$T/bin/deploy" RELEASE_ROLLBACK_CMD="$T/bin/rollback" STUDIO_CTL="$T/bin/studio" \
    RELEASE_NOTIFY_CMD="$T/bin/notify" PM2="$T/bin/pm2" NODE="$(command -v node)" PROC="$T/proc" SQLITE="$T/bin/sqlite3" \
    SHR_DB="$T/shr.db" STUDIO_DRAIN_MAX=5 DEPLOY_MAX="${DEPLOY_MAX:-60}" CHECK_MAX=15 ROLLBACK_MAX=24 \
    bash "$T/bundle/scripts/release.sh" "$SHA" )
  RC=$?
  RES=$(sed -n 's/^RESULT=//p' "$T/logs/$SHA.latest" 2>/dev/null)
  LIVE=$(basename "$(readlink -f "$R/current")")
}
CASE=0

echo "1. everything passes"
setup same; run; ok "result" "$RES" "LIVE"; ok "exit" "$RC" 0; ok "live" "$LIVE" R2
has "Studio locked then unlocked" "$T/studio" "unlock tok1"
ok "pin removed" "$(cat "$R/releases/.pinned" 2>/dev/null | grep -c 'release.sh')" 0
ok "8 check answers, all logged model-free" "$(grep -c ' deterministic$' "$T/qlog")" 8

echo "2. another release holds the lock"
setup same; ( flock -n 9 && sleep 6 ) 9> "$R/release.lock" & HOLDER=$!; sleep 0.5; run
ok "result" "$RES" "NOT DEPLOYED"; ok "live" "$LIVE" R1; wait $HOLDER

echo "3. the NIBRS maintenance lock is held"
setup same; ( flock -n 9 && sleep 6 ) 9> "$R/maintenance.lock" & HOLDER=$!; sleep 0.5; run
ok "result" "$RES" "NOT DEPLOYED"; ok "live" "$LIVE" R1; wait $HOLDER

echo "4. Studio is busy / its lock is held"
setup same; touch "$T/studio-busy"; run; ok "busy: result" "$RES" "NOT DEPLOYED"; has "busy: unlocked" "$T/studio" "unlock tok1"
setup same; touch "$T/studio-locked"; run; ok "locked: result" "$RES" "NOT DEPLOYED"; ok "locked: live" "$LIVE" R1

echo "5. the baseline is unusable (live release answers with errors)"
setup same; echo error > "$R/releases/R1/variant"; run; ok "result" "$RES" "NOT DEPLOYED"; ok "live" "$LIVE" R1

echo "6. the deploy fails before the switch / exits 0 without switching"
setup same; run FAKE_DEPLOY=fail-before; ok "fail-before: result" "$RES" "NOT DEPLOYED"; ok "fail-before: live" "$LIVE" R1
setup same; run FAKE_DEPLOY=no-switch-ok; ok "no-switch: result" "$RES" "NOT DEPLOYED"

echo "7. the deploy fails after the switch"
setup same; run FAKE_DEPLOY=fail-after; ok "result" "$RES" "ROLLED BACK"; ok "exit" "$RC" 1; ok "live" "$LIVE" R1

echo "8. the deploy hangs after the switch (stopped at the deadline, cannot switch later)"
setup same; run FAKE_DEPLOY=hang-after DEPLOY_MAX=8; ok "result" "$RES" "ROLLED BACK"; ok "live" "$LIVE" R1
sleep 2; ok "the deploy was reaped (no late action)" "$(ls "$R/late-switch-marker" 2>/dev/null | wc -l)" 0

echo "9. the new release is unhealthy"
setup same; touch "$T/unhealthy-R2"; run; ok "result" "$RES" "ROLLED BACK"; ok "live" "$LIVE" R1

echo "10. an answer changed (no expected change)"
setup changed-rows; run; ok "result" "$RES" "ROLLED BACK"; ok "live" "$LIVE" R1
has "compare names the question" "$(ls -d "$T/logs/$SHA".*/ | head -1)compare.txt" "FAIL O352: the answer changed"

echo "11. the new release answers errors (equal errors never pass)"
setup error; run; ok "result" "$RES" "ROLLED BACK"

echo "12. a check answer used the model"
setup model; run; ok "result" "$RES" "ROLLED BACK"

echo "13. a reviewed expected change: title only"
setup changed-title
cat > "$T/bundle/scripts/fixtures/release-checks/expected-changes.json" <<'EOF'
{ "changes": { "O352": { "fields": ["title"], "checker": "scripts/fixtures/release-checks/title-checker.cjs" },
               "H1": { "fields": ["title"], "checker": "scripts/fixtures/release-checks/title-checker.cjs" },
               "H2": { "fields": ["title"], "checker": "scripts/fixtures/release-checks/title-checker.cjs" },
               "H3": { "fields": ["title"], "checker": "scripts/fixtures/release-checks/title-checker.cjs" } } }
EOF
echo 'exports.check = (a) => (a.title === "A New Title" ? { ok: true } : { ok: false, why: `title ${a.title}` });' > "$T/bundle/scripts/fixtures/release-checks/title-checker.cjs"
run; ok "listed field + checker: result" "$RES" "LIVE"
setup changed-rows
cp "$TOP/case$((CASE-1))/bundle/scripts/fixtures/release-checks/"{expected-changes.json,title-checker.cjs} "$T/bundle/scripts/fixtures/release-checks/"
run; ok "a change outside the listed fields: result" "$RES" "ROLLED BACK"

echo "14. the rollback script does nothing: the link is switched directly and verified"
setup same; touch "$T/unhealthy-R2"; run FAKE_ROLLBACK=noop; ok "result" "$RES" "ROLLED BACK"; ok "live" "$LIVE" R1

echo "15. the old release stays unhealthy after rollback and a corrective reload"
setup same; touch "$T/unhealthy-R2" "$T/unhealthy-R1"; run
ok "result" "$RES" "ROLLBACK NOT CONFIRMED"; ok "exit" "$RC" 3; has "notified" "$T/notify" "ROLLBACK NOT CONFIRMED"
has "corrective reload from the target's ecosystem file" "$T/reloads" "R1/ecosystem.config.js"
setup same; touch "$T/unhealthy-R2" "$T/unhealthy-R1" "$T/fixed-by-reload"; run
ok "a corrective reload that works: result" "$RES" "ROLLED BACK"

echo "16. a retry of the same SHA never shows the earlier result"
setup same; run FAKE_DEPLOY=fail-before; first="$RES"; sleep 1; run; ok "first" "$first" "NOT DEPLOYED"; ok "latest after retry" "$RES" "LIVE"
ok "one result file per attempt" "$(ls "$T/logs/$SHA".*.result | wc -l)" 2

echo "17. a hand-run deploy or rollback refuses while a release holds the lock"
setup same; ( flock -n 9 && sleep 6 ) 9> "$R/release.lock" & HOLDER=$!; sleep 0.5
out=$(RELEASE_LOCK="$R/release.lock" bash "$REPO/scripts/rollback.sh" R1 2>&1); ok "rollback.sh exit" "$?" 1
echo "$out" | grep -q "release.lock is held" && ok "rollback.sh says why" yes yes || ok "rollback.sh says why" no yes
out=$(RELEASE_LOCK="$R/release.lock" bash "$REPO/scripts/deploy-zero-downtime.sh" "$SHA" dev 2>&1); ok "deploy exit" "$?" 1
echo "$out" | grep -q "release.lock is held" && ok "deploy says why" yes yes || ok "deploy says why" no yes
wait $HOLDER

echo
echo "release.sh: $pass passed, $fail failed"
(( fail == 0 ))
