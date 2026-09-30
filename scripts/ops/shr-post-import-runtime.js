'use strict';
/**
 * The SHR importer's post-import steps, run on ONE pinned, reviewed runtime (Codex SHR runtime ruling,
 * handoff "Codex SHR runtime ruling - cause established, diagnostic branch closed, prepare the bounded
 * repair").
 *
 * WHY. On 2026-09-16 the importer re-inserted 2026 and then ran
 *   cd /opt/nibrs/repo && npx tsx scripts/normalize-shr-agencies.ts --apply
 * which loaded `/opt/nibrs/repo/node_modules/better-sqlite3`, a native module built for NODE_MODULE_VERSION
 * 127, under Node 24 (137). It crashed, and every 2026 row stayed untyped. `tsx` was not installed in that
 * checkout, so `npx` offered to install it from the registry during a root cron run.
 *
 * WHAT THIS CHANGES -- the runtime only. The same scripts run with the same arguments and environment, so
 * normalization, state population and ANALYZE keep their existing data semantics:
 *   - the release is resolved ONCE per run (`fs.realpathSync` of the link), and every script and dependency
 *     is taken from that one directory -- script, `tsx` and `better-sqlite3` cannot come from different trees;
 *   - each script, and the local modules it imports, must match the reviewed SHA-256 in the manifest, or the
 *     run refuses: an unreviewed release script is never executed because it happens to exist;
 *   - `tsx` is the release's installed loader (`node_modules/tsx/dist/loader.mjs`), passed to this Node binary
 *     with `--import`, so the script runs IN the spawned process and a timeout kill reaches it directly (the
 *     tsx CLI would run it in a second, grandchild process). There is no `npx`/`npm` anywhere, so a missing
 *     dependency fails instead of installing one;
 *   - `preflight` checks all of that before the importer touches any data. For `better-sqlite3` it constructs,
 *     queries and closes an in-memory database in a child on THIS Node: the package loads its native addon
 *     only inside the Database constructor, so a bare `require` does not reach the September failure. It
 *     opens no source or file database;
 *   - one monotonic deadline for the whole invocation is checked before EVERY process dispatch, preflight's
 *     own included (`admit`); an expired budget dispatches nothing. Each command's timeout is the smaller of
 *     its own limit and the time remaining, so a stalled command is killed at the deadline, not after it;
 *   - a failed step stops the run with a non-zero result, and a status record says which step failed.
 *
 * No notification is sent from here; the status record and exit status are what an existing monitor reads.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const DEFAULT_RELEASE_LINK = '/opt/nibrs/current';
const DEFAULT_STATUS_PATH = '/opt/nibrs/shr-update-status.json';
/** No dispatch is admitted with less than this left: a command with seconds to live is refused, not started. */
const MIN_ADMIT_MS = 5000;

class PostImportRefusal extends Error {
  constructor(stage, reasons) {
    super(`SHR post-import ${stage} refused: ${reasons.join('; ')}`);
    this.name = 'PostImportRefusal';
    this.stage = stage;
    this.reasons = reasons;
  }
}

/** One monotonic deadline for the whole invocation. */
function createDeadline(totalMs) {
  if (!Number.isFinite(totalMs) || totalMs <= 0) throw new Error(`invalid deadline ${totalMs}`);
  const end = process.hrtime.bigint() + BigInt(Math.floor(totalMs)) * 1000000n;
  return {
    totalMs,
    remainingMs() { return Math.max(0, Math.floor(Number(end - process.hrtime.bigint()) / 1e6)); },
  };
}

/**
 * Admission for one dispatch or destructive action: refuses (throws, nothing started) with less than
 * MIN_ADMIT_MS left, otherwise returns the timeout to use -- the smaller of `limitMs` and the time remaining.
 */
function admit(deadline, what, limitMs = Infinity) {
  const remaining = deadline.remainingMs();
  if (remaining < MIN_ADMIT_MS) throw new PostImportRefusal('deadline', [`${what} not dispatched: ${remaining} ms left`]);
  return Math.min(limitMs, remaining);
}

/** The existing post-import commands, as the importer ran them: same scripts, arguments and environment. */
function shrPostImportSteps({ shrDbPath, nibrsDbPath, rtciDbPath }) {
  return [
    { name: 'normalize-shr-agencies', kind: 'tsx', script: 'scripts/normalize-shr-agencies.ts', args: ['--apply'],
      env: { SHR_DB_PATH: shrDbPath, NIBRS_DB_PATH: nibrsDbPath }, timeoutMs: 600000 },
    { name: 'build-shr-state-population', kind: 'tsx', script: 'scripts/build-shr-state-population.ts', args: ['--apply'],
      env: { SHR_DB_PATH: shrDbPath, RTCI_DB_PATH: rtciDbPath }, timeoutMs: 600000 },
    { name: 'extend-state-population-cde', kind: 'tsx', script: 'scripts/extend-state-population-cde.ts', args: [`--db=${shrDbPath}`, '--apply'],
      env: {}, timeoutMs: 600000 },
    { name: 'analyze', kind: 'sqlite3', args: [shrDbPath, 'PRAGMA analysis_limit=1000; ANALYZE;'], timeoutMs: 120000 },
  ];
}

/**
 * The one-time supervised recovery, under Jeff's approved classification policy (2026-09-30): build the
 * evidence-backed SHR agency-type tables and refresh statistics. The old normalizer is NOT run (Codex: not
 * approved as-is -- it copies legacy and name-default City labels into incidents). The evidence builder
 * writes only `shr_agency_type_binding` / `shr_agency_type_evidence` and reads nibrs.db read-only; the SHR
 * city ranking reads those tables (lib/shr-agency-classification.ts). state_population and the CDE extension
 * are not rerun. The monthly importer's four steps are unchanged, and its activation stays held.
 */
const TYPE_RECOVERY_STEPS = ['build-shr-agency-type-evidence', 'analyze'];
function shrTypeRecoverySteps({ shrDbPath, nibrsDbPath, rtciDbPath }) {
  const analyze = shrPostImportSteps({ shrDbPath, nibrsDbPath, rtciDbPath }).find((step) => step.name === 'analyze');
  return [
    { name: 'build-shr-agency-type-evidence', kind: 'tsx', script: 'scripts/build-shr-agency-type-evidence.ts', args: ['--apply'],
      env: { SHR_DB_PATH: shrDbPath, NIBRS_DB_PATH: nibrsDbPath }, timeoutMs: 600000 },
    analyze,
  ];
}

function loadManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || typeof manifest.files !== 'object') throw new Error(`manifest ${manifestPath} has no files`);
  return manifest;
}

/** Resolve the release ONCE; every path below is inside it. */
function resolveRuntime({ releaseLink = process.env.SHR_RELEASE_LINK || DEFAULT_RELEASE_LINK, manifestPath, sqliteBin = process.env.SHR_SQLITE3 || 'sqlite3' } = {}) {
  const release = fs.realpathSync(releaseLink);
  const nodeModules = path.join(release, 'node_modules');
  return {
    releaseLink, release, nodeModules, sqliteBin,
    tsxLoader: path.join(nodeModules, 'tsx', 'dist', 'loader.mjs'),
    betterSqlite3: path.join(nodeModules, 'better-sqlite3'),
    manifest: loadManifest(manifestPath || path.join(__dirname, 'shr-post-import-manifest.json')),
  };
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function childEnv(runtime, extra) {
  // NODE_PATH pins module resolution to the release; npm_config_offline forbids any registry access even if
  // something tried. No PATH change: `npx` is simply never invoked.
  return { ...process.env, ...extra, NODE_PATH: runtime.nodeModules, npm_config_offline: 'true' };
}

/** Child code for the native check: construct, query and close an in-memory database (the lazy addon load). */
const nativeProbe = (moduleDir) => `const D = require(${JSON.stringify(moduleDir)});
const db = new D(':memory:');
const row = db.prepare('SELECT sqlite_version() AS v').get();
db.close();
process.stdout.write('better-sqlite3 ok ' + row.v);`;

/**
 * Everything the steps need, checked before the importer mutates data. Opens no source or file database.
 * Throws PostImportRefusal with every reason found; an expired budget refuses before anything is dispatched,
 * and each of its two child processes is admitted against the deadline on its own (`admit` throws first).
 */
function preflight(runtime, steps, deadline) {
  if (deadline.remainingMs() < MIN_ADMIT_MS) throw new PostImportRefusal('preflight', [`deadline: ${deadline.remainingMs()} ms left, nothing dispatched`]);
  const reasons = [];
  if (!fs.existsSync(runtime.tsxLoader)) reasons.push(`tsx is not installed in the release (${runtime.tsxLoader})`);
  for (const [rel, expected] of Object.entries(runtime.manifest.files)) {
    const file = path.join(runtime.release, rel);
    if (!fs.existsSync(file)) { reasons.push(`reviewed file missing from the release: ${rel}`); continue; }
    const actual = sha256(file);
    if (actual !== expected) reasons.push(`release ${rel} is not the reviewed version (${actual.slice(0, 12)} != ${expected.slice(0, 12)})`);
  }
  for (const step of steps) {
    if (step.kind === 'tsx' && !(step.script in runtime.manifest.files)) reasons.push(`step ${step.name} runs an unreviewed script ${step.script}`);
  }
  if (!fs.existsSync(runtime.betterSqlite3)) {
    reasons.push(`better-sqlite3 is not installed in the release (${runtime.betterSqlite3})`);
  } else {
    // Force the native addon load under THIS Node binary, in a child, admitted and bounded by the deadline
    // (`admit` throws, dispatching nothing, when too little time is left).
    const r = spawnSync(process.execPath, ['-e', nativeProbe(runtime.betterSqlite3)], {
      env: childEnv(runtime, {}), encoding: 'utf8', windowsHide: true, timeout: admit(deadline, 'better-sqlite3 check', 30000),
    });
    if (r.error || r.status !== 0 || !String(r.stdout).startsWith('better-sqlite3 ok')) {
      const lines = String(r.stderr || '').split(/\r?\n/);
      const detail = lines.find((l) => /MODULE_VERSION/.test(l)) || lines.find((l) => /Error|Cannot find|not a valid/.test(l))
        || (r.error && r.error.message) || `exit ${r.status}${r.signal ? `, signal ${r.signal}` : ''}`;
      reasons.push(`better-sqlite3 does not load under Node ${process.version}: ${String(detail).trim()}`);
    }
  }
  if (steps.some((s) => s.kind === 'sqlite3')) {
    const r = spawnSync(runtime.sqliteBin, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: admit(deadline, 'sqlite3 check', 10000) });
    if (r.error || r.status !== 0) reasons.push(`sqlite3 CLI unavailable (${runtime.sqliteBin})`);
  }
  if (reasons.length > 0) throw new PostImportRefusal('preflight', reasons);
  return true;
}

function writeStatus(statusPath, status) {
  if (!statusPath) return;
  const tmp = `${statusPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 1));
  fs.renameSync(tmp, statusPath);
}

/**
 * Run the steps in order. Each is admitted only with time left; each is bounded by the remaining time; a
 * failure stops the run. The status record is written after every step, so a crash mid-run still leaves one.
 */
function runSteps(runtime, steps, deadline, { statusPath = process.env.SHR_UPDATE_STATUS_PATH || DEFAULT_STATUS_PATH, log = console.log } = {}) {
  const status = { kind: 'shr-post-import', startedAt: new Date().toISOString(), release: runtime.release, node: process.version, outcome: 'running', steps: [] };
  writeStatus(statusPath, status);
  for (const step of steps) {
    const remaining = deadline.remainingMs();
    if (remaining < MIN_ADMIT_MS) {
      status.steps.push({ name: step.name, outcome: 'not-dispatched', reason: `deadline: ${remaining} ms left` });
      status.outcome = 'failed'; status.finishedAt = new Date().toISOString(); writeStatus(statusPath, status);
      throw new PostImportRefusal('dispatch', [`${step.name} not dispatched: ${remaining} ms left`]);
    }
    const timeout = Math.min(step.timeoutMs, remaining);
    const [file, args, opts] = step.kind === 'tsx'
      ? [process.execPath, ['--import', pathToFileURL(runtime.tsxLoader).href, path.join(runtime.release, step.script), ...step.args], { cwd: runtime.release, env: childEnv(runtime, step.env) }]
      : [runtime.sqliteBin, step.args, { cwd: runtime.release, env: childEnv(runtime, {}) }];
    log(`  [post-import] ${step.name} (timeout ${timeout} ms)`);
    const t0 = process.hrtime.bigint();
    const r = spawnSync(file, args, { ...opts, stdio: 'inherit', windowsHide: true, timeout });
    const elapsedMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    const ok = !r.error && r.status === 0 && !r.signal;
    status.steps.push({ name: step.name, outcome: ok ? 'ok' : 'failed', exit: r.status, signal: r.signal || null, error: r.error ? r.error.message : null, elapsedMs, timeoutMs: timeout });
    if (!ok) {
      status.outcome = 'failed'; status.finishedAt = new Date().toISOString(); writeStatus(statusPath, status);
      throw new Error(`SHR post-import step ${step.name} failed (exit ${r.status}${r.signal ? `, signal ${r.signal}` : ''}${r.error ? `, ${r.error.message}` : ''})`);
    }
    writeStatus(statusPath, status);
  }
  status.outcome = 'ok'; status.finishedAt = new Date().toISOString(); writeStatus(statusPath, status);
  return status;
}

module.exports = { createDeadline, admit, shrPostImportSteps, shrTypeRecoverySteps, TYPE_RECOVERY_STEPS, resolveRuntime, preflight, runSteps, writeStatus, PostImportRefusal, MIN_ADMIT_MS };
