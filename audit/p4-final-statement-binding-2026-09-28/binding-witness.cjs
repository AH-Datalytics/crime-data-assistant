/*
 * P4.1 final-statement binding - the REAL NIBRS route, in-process, with the REAL query worker over
 * disposable fixture databases (Codex's scope at "Preservation branch pushed - proposed bounded Phase 4
 * final-statement binding"). Driver taken from audit/phase3-gc057-2026-09-26/delivery-witness.cjs.
 *
 * Three statements are named separately for every scenario:
 *   modelSql     the pre-transformation statement(s) the scripted model returned;
 *   responseSql  the statement the route reports it ran (the finally validated one, after the change);
 *   received     what the worker process actually received and prepared, with the identity it was sent.
 * A boundary seam records every worker launch, forces it windowless, and for the two "altered in
 * transit" scenarios changes the statement after it left the route - the case the binding must refuse
 * at prepare. One scenario forces the final check to refuse, to show a refusal never reaches the worker.
 * Isolation: network blocked, real sources refused, no provider; PowerShell never launched.
 *
 * Run: node audit/p4-final-statement-binding-2026-09-28/binding-witness.cjs --out <file.json> [--assert] [--baseline <file.json>]
 */
'use strict';
/* Worker boundary seam: installed before the loader, so the loader's own launch observer wraps it. */
const crypto0 = require('crypto');
const WORKER = { launches: [], alter: false };
{
  const cp = require('node:child_process');
  const original = cp.execFile;
  cp.execFile = function (file, args, options, ...rest) {
    if (Array.isArray(args) && typeof args[0] === 'string' && /nibrs-query-worker\.js$/.test(args[0])) {
      const next = args.slice();
      let altered = false;
      if (WORKER.alter && typeof next[3] === 'string') { const [from, to] = WORKER.alter === true ? ["'09A'", "'120'"] : [WORKER.alter.from, WORKER.alter.to]; next[3] = next[3].replace(from, to); altered = next[3] !== args[3]; }
      const received = next[3];
      WORKER.launches.push({ received, sha: next[4] || null, shaOfReceived: crypto0.createHash('sha256').update(String(received), 'utf8').digest('hex'), altered });
      const opts = typeof options === 'function' ? { windowsHide: true } : { ...(options || {}), windowsHide: true };
      return typeof options === 'function' ? original.call(this, file, next, opts, options, ...rest) : original.call(this, file, next, opts, ...rest);
    }
    if (Array.isArray(args) && options && typeof options === 'object') return original.call(this, file, args, { ...options, windowsHide: true }, ...rest);
    return original.apply(this, arguments);
  };
}


const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const HARNESS = path.join(REPO, 'audit', 'model-comparison-offline-2026-09-19');
const { prepare } = require(path.join(HARNESS, 'loader.cjs'));
const { buildAll } = require(path.join(HARNESS, 'schema.cjs'));
const { buildRollups } = require(path.join(HARNESS, 'rollups.cjs'));

const argValue = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = argValue('--out');
if (!OUT) { console.error('usage: --out <file.json>'); process.exit(2); }
const WORK = path.join(os.tmpdir(), `p4-binding-${process.pid}-${Date.now()}`);
const SECRET = 'p4-binding-offline-page-token-secret';

const GC057 = 'What jurisdictions had the highest murder rates in 2024?';

/* ------------------------------------------------------------------ fixtures */

/* [ori, agency, state, type, murders in 2024, population or null]. Rates per 100,000 in comments. */
const AGENCIES = [];

function fixtureRows() {
  const base = JSON.parse(fs.readFileSync(path.join(HARNESS, 'fixtures2.json'), 'utf8')).fixtureRows;
  const rows = JSON.parse(JSON.stringify(base));
  for (const [ori, agency, state, type, murders, population] of AGENCIES) {
    // Spread the year's murders over 12 months so every agency reports Jan-Dec.
    for (let month = 1; month <= 12; month++) {
      const count = Math.floor(murders / 12) + (month <= murders % 12 ? 1 : 0);
      rows.current.agency_monthly.push({ ori, agency, state, type, year: 2024, month, offense: 'Murder', count });
    }
    if (population !== null) rows.current.agency_population.push({ ori, year: 2024, population });
  }
  return rows;
}

function buildFixtureDatabases() {
  const dir = path.join(WORK, 'fixture-dbs');
  fs.mkdirSync(dir, { recursive: true });
  const crime = path.join(dir, 'crime_data.db');
  const targets = { current: crime, historical: crime, nibrs: path.join(dir, 'nibrs.db'), shr: path.join(dir, 'shr.db'), hate_crime: path.join(dir, 'hc.db') };
  const built = buildAll(fixtureRows(), targets);
  for (const db of Object.values(built.dbs)) { try { db.pragma('journal_mode = WAL'); } catch { /* ok */ } db.close(); }
  const rollup = path.join(dir, 'nibrs_rollups.db');
  buildRollups(targets.nibrs, rollup);
  const queryLog = path.join(dir, 'query_log.db');
  const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3'));
  new Database(queryLog).close();
  return { crime, targets, rollup, queryLog };
}

/* ------------------------------------------------------------------ scripted model */


/* ------------------------------------------------------------------ route driving */

function mintPageToken(ageMs = 5000) {
  const ts = String(Date.now() - ageMs);
  const sig = crypto.createHmac('sha256', SECRET).update(ts).digest('hex').slice(0, 16);
  return Buffer.from(`${ts}:${sig}`).toString('base64');
}
async function consume(response) {
  const status = response.status;
  const text = await response.text();
  if (/^data:/m.test(text)) {
    const events = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { events.push(JSON.parse(payload)); } catch { events.push({ unparsed: payload.slice(0, 200) }); }
    }
    return { status, events };
  }
  try { return { status, events: [JSON.parse(text)] }; } catch { return { status, events: [{ raw: text.slice(0, 500) }] }; }
}
function shape(consumed) {
  const narratives = []; let rows = []; let columns = []; let sql = null; let title = null; let chartConfig = null;
  for (const e of consumed.events) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.explanation === 'string') narratives.push(e.explanation);
    if (e.type === 'explanation' && typeof e.text === 'string') narratives.push(e.text);
    if (Array.isArray(e.rows) && e.rows.length && rows.length === 0) rows = e.rows;
    if (Array.isArray(e.columns) && e.columns.length && columns.length === 0) columns = e.columns;
    if (typeof e.sql === 'string' && e.sql) sql = e.sql;
    if (typeof e.title === 'string' && e.title) title = e.title;
    if (e.chartConfig && !chartConfig) chartConfig = e.chartConfig;
  }
  return { finalNarrative: narratives.length ? narratives[narratives.length - 1] : '', rows, columns, sql, title, chartConfig };
}

/* ------------------------------------------------------------------ scenarios (NIBRS model paths) */

const MURDER = "SELECT SUM(victim_count) AS murder_victims FROM summary_victim_city_monthly WHERE ori = 'ILCPD0000' AND year = 2025 AND ucr_offense_code = '09A'";
const ROBBERY = "SELECT SUM(victim_count) AS robbery_victims FROM summary_victim_city_monthly WHERE ori = 'ILCPD0000' AND year = 2025 AND ucr_offense_code = '120'";
const ARRESTS = "SELECT SUM(arrest_count) AS arrests FROM summary_arrestee_demographics WHERE ori = 'ILCPD0000' AND year = 2025";
const BROKEN = "SELECT SUM(victim_total) AS murder_victims FROM summary_victim_city_monthly WHERE ori = 'ILCPD0000' AND year = 2025 AND ucr_offense_code = '09A'";
const Q = 'Using the victim summary, add up the 09A victim_count for ORI ILCPD0000 in 2025';
const QR = 'Using the victim summary, add up the 120 victim_count for ORI ILCPD0000 in 2025';
const QA = 'Using the arrestee summary, add up the arrest count for ORI ILCPD0000 in 2025';
const CLEAR_IL = "SELECT SUM(cleared_by_arrest) AS rapes_cleared_by_arrest FROM summary_clearance_detail WHERE state = 'IL' AND year = 2025 AND ucr_offense_code = '11A'";
const CLEAR_US = "SELECT SUM(cleared_by_arrest) AS rapes_cleared_by_arrest FROM summary_clearance_detail WHERE year = 2025 AND ucr_offense_code = '11A'";
const CLEAR_BROKEN = "SELECT SUM(nonexistent_count) AS rapes_cleared_by_arrest FROM summary_clearance_detail WHERE state = 'IL' AND year = 2025 AND ucr_offense_code = '11A'";
const CLEAR_WRONG = "SELECT SUM(offense_count) AS rapes_cleared_by_arrest FROM summary_state_monthly WHERE state = 'IL' AND year = 2025 AND ucr_offense_code = '11A'";
const QC = 'How many rapes were cleared by arrest in Illinois in 2025?';
const QCN = 'How many rapes were cleared by arrest nationwide in 2025?';

const SCENARIOS = [
  { id: 'initial-plain', q: Q, sql: MURDER, expect: 'murder' },
  { id: 'initial-robbery', q: QR, sql: ROBBERY, expect: 'robbery' },
  { id: 'initial-schema-corrected', q: QA, sql: ARRESTS, expect: 'arrests-corrected' },
  { id: 'retry-after-schema-failure', q: Q, sql: BROKEN, retrySql: MURDER, expect: 'murder-retry' },
  { id: 'initial-altered-in-transit', q: Q, sql: MURDER, alter: true, expect: 'refused-at-prepare' },
  { id: 'retry-altered-in-transit', q: Q, sql: BROKEN, retrySql: MURDER, alter: true, expect: 'refused-at-prepare' },
  { id: 'final-check-refusal', q: Q, sql: MURDER, forceFinalRefusal: true, expect: 'refused-before-prepare' },
  /* R1 (Codex P4.1 ruling): the planner's state/national clearance rollups, retained from
     codex-rollup-probe.cjs, plus the unsafe ordinary-offense-table counterpart. */
  { id: 'rollup-state-clearance', q: QC, sql: CLEAR_IL, expect: 'state-clearance' },
  { id: 'rollup-national-clearance', q: QCN, sql: CLEAR_US, expect: 'national-clearance' },
  { id: 'rollup-state-clearance-retry', q: QC, sql: CLEAR_BROKEN, retrySql: CLEAR_IL, expect: 'state-clearance-retry' },
  { id: 'rollup-clearance-altered-in-transit', q: QC, sql: CLEAR_IL, alter: { from: "'IL'", to: "'CA'" }, expect: 'refused-at-prepare' },
  { id: 'wrong-table-clearance', q: QC, sql: CLEAR_WRONG, expect: 'refused-owned' },
];

function makeModel(s) {
  const calls = [];
  const reply = (text) => ({ id: 'offline', type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  return {
    calls,
    client: { messages: { create: async (request) => {
      const last = (request.messages || []).filter((m) => m.role === 'user').slice(-1)[0];
      calls.push({ user: last ? String(typeof last.content === 'string' ? last.content : JSON.stringify(last.content)).slice(0, 300) : '' });
      const sql = calls.length === 1 ? s.sql : (s.retrySql || s.sql);
      return reply(JSON.stringify({ sql, title: 'Victims', explanation: 'The scripted statement for this witness.', chartType: 'none', yAxis: [] }));
    } } },
  };
}

async function main() {
  const dbs = buildFixtureDatabases();
  const REAL_SOURCES = [path.join(REPO, 'crime_data.db'), path.join(REPO, 'nibrs.db'), path.join(REPO, 'shr.db'), '/opt/nibrs/nibrs.db'];
  let current = { messages: { create: async () => { throw new Error('no model bound'); } } };
  const app = prepare({
    root: REPO,
    modelClient: { messages: { create: (...a) => current.messages.create(...a) } },
    databasePaths: [dbs.crime, dbs.targets.nibrs, dbs.targets.shr, dbs.targets.hate_crime, dbs.queryLog, dbs.rollup],
    env: {
      RTCI_DB_PATH: dbs.crime, NIBRS_DB_PATH: dbs.targets.nibrs, SHR_DB_PATH: dbs.targets.shr, HC_DB_PATH: dbs.targets.hate_crime,
      QUERY_LOG_DB_PATH: dbs.queryLog, NIBRS_ROLLUP_DB_PATH: dbs.rollup, APP_DIR: REPO,
      ANTHROPIC_API_KEY: 'offline-witness-placeholder-not-a-key', AUTH_PASSWORD: SECRET, NODE_ENV: 'test',
    },
  });
  const networkProbe = app.network.probe();
  const databaseProbe = app.db.probe(REAL_SOURCES);
  const expected = derive();
  // The final check, loaded from the same tree, so one scenario can force it to refuse and show that
  // a refusal never reaches the worker. Absent before the change: the scenario then has no effect.
  let binding = null;
  try { binding = app.route('lib/nibrs-execution-binding.ts'); } catch { binding = null; }
  const realFinalize = binding ? binding.finalizeNibrsStatement : null;
  const results = [];
  for (const s of SCENARIOS) {
    const model = makeModel(s);
    current = model.client;
    const cache = app.route('lib/response-cache.ts');
    if (typeof cache.__resetResponseCacheForTests === 'function') cache.__resetResponseCacheForTests();
    const mod = app.route('app/api/nibrs-query/route.ts');
    WORKER.launches = []; WORKER.alter = s.alter || false;
    if (binding) binding.finalizeNibrsStatement = s.forceFinalRefusal
      ? () => ({ ok: false, stage: 'contract', reason: 'forced refusal (witness)', sql: 'n/a', contract: null })
      : realFinalize;
    const body = { question: s.q, sessionId: `w-${s.id}-${Date.now()}`, pageToken: mintPageToken() };
    const request = new Request('http://localhost/api/witness', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.11.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify(body),
    });
    let consumed; let threw = null;
    try { consumed = await consume(await mod.POST(request)); }
    catch (e) { threw = String(e && e.stack || e).slice(0, 600); consumed = { status: 0, events: [] }; }
    const delivered = shape(consumed);
    const errors = consumed.events.map((e) => e && e.error).filter(Boolean);
    results.push({ id: s.id, question: s.q, expect: s.expect, status: consumed.status, threw, modelCalls: model.calls.length,
      modelSql: [s.sql, ...(s.retrySql ? [s.retrySql] : [])], responseSql: delivered.sql, workerLaunches: WORKER.launches.slice(),
      rows: delivered.rows, columns: delivered.columns, explanation: delivered.finalNarrative, errors });
    const w = WORKER.launches.map((l) => `${l.sha ? 'bound' : 'unbound'}${l.altered ? '+altered' : ''}`).join(',');
    console.log(`${s.id.padEnd(28)} status=${consumed.status} calls=${model.calls.length} rows=${delivered.rows.length} worker=[${w}] ${threw ? 'THREW ' : ''}| ${(delivered.finalNarrative || errors.join(' ')).replace(/\s+/g, ' ').slice(0, 110)}`);
  }
  if (binding) binding.finalizeNibrsStatement = realFinalize;
  const report = app.report();
  app.teardown();

  const checks = assertBinding(results, expected);
  const baseline = argValue('--baseline') ? JSON.parse(fs.readFileSync(path.resolve(argValue('--baseline')), 'utf8')) : null;
  const out = {
    kind: 'p4-final-statement-binding-witness', at: new Date().toISOString(), expected,
    boundaries: { networkProbe, databaseProbe, outboundNetworkAttempts: report.outboundNetworkAttempts.length,
      refusedDatabaseOpens: report.databaseOpens.filter((d) => !d.allowed).length, substitutedModules: report.substitutedModules },
    checks: { passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length, list: checks },
    changesFromBaseline: baseline ? compare(baseline.results, results) : null,
    results,
  };
  fs.writeFileSync(path.resolve(OUT), JSON.stringify(out, null, 1));
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  -- ${c.detail}`}`);
  if (out.changesFromBaseline) for (const c of out.changesFromBaseline) console.log(`  CHANGED  ${c.id}: ${c.before} -> ${c.after}`);
  console.log(`\nwrote ${OUT}; checks ${out.checks.passed} passed / ${out.checks.failed} failed; network blocked ${networkProbe.filter((p) => p.blocked).length}/${networkProbe.length}; real sources refused ${databaseProbe.filter((p) => p.blocked).length}/${databaseProbe.length}`);
  if (process.argv.includes('--assert') && out.checks.failed > 0) process.exitCode = 1;
}

/* Expected figures, derived from the fixture rows alone. */
function derive() {
  const rows = fixtureRows().nibrs.summary_victim_city_monthly;
  const sum = (code) => rows.filter((r) => r.ori === 'ILCPD0000' && r.year === 2025 && r.ucr_offense_code === code).reduce((n, r) => n + r.victim_count, 0);
  const offense = fixtureRows().nibrs.summary_city_monthly || [];
  const offenseSum = offense.filter((r) => r.ori === 'ILCPD0000' && r.year === 2025 && r.ucr_offense_code === '120').reduce((n, r) => n + r.offense_count, 0);
  // The route rewrites this statement to the offense table before the execution block (pre-existing,
  // outside this slice); the expected figure is what that table holds: none in this fixture, so NULL.
  const clearance = fixtureRows().nibrs.summary_clearance_detail || [];
  const cleared = (pred) => clearance.filter((r) => r.year === 2025 && r.ucr_offense_code === '11A' && pred(r)).reduce((n, r) => n + r.cleared_by_arrest, 0);
  return { murder2025: sum('09A'), robbery2025: sum('120'), robberyOffenseTable2025: offense.length ? offenseSum : null,
    illinoisRapesClearedByArrest2025: cleared((r) => r.state === 'IL'), nationalRapesClearedByArrest2025: cleared(() => true) };
}

function assertBinding(results, e) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: ok ? '' : String(detail).slice(0, 500) });
  const by = (id) => results.find((r) => r.id === id);
  const first = (r) => (r.rows[0] ? Object.values(r.rows[0])[0] : undefined);
  const bound = (l) => Boolean(l.sha) && l.sha === l.shaOfReceived;
  // The executed statement is the one that passed the final checks: the worker received it with its
  // identity, and the response reports the same text.
  const deliveredBound = (r) => r.workerLaunches.length >= 1 && r.workerLaunches.every(bound) && r.workerLaunches[r.workerLaunches.length - 1].received === r.responseSql;

  const p = by('initial-plain');
  check(`initial path: an unchanged useful answer (${e.murder2025}) from the statement that passed the final checks, prepared with its identity`,
    p.modelCalls >= 1 && Number(first(p)) === e.murder2025 && deliveredBound(p), JSON.stringify({ rows: p.rows, launches: p.workerLaunches }));
  const r = by('initial-robbery');
  check(`initial path: a statement rewritten upstream to the offense table (pre-existing) still runs as that checked statement, bound (${e.robberyOffenseTable2025})`,
    first(r) === e.robberyOffenseTable2025 && /summary_city_monthly/.test(r.responseSql || '') && deliveredBound(r), JSON.stringify({ rows: r.rows, launches: r.workerLaunches }));
  const sc = by('initial-schema-corrected');
  check('initial path: a legitimate schema correction still runs, and the CORRECTED statement is the one checked and prepared',
    sc.status === 200 && deliveredBound(sc) && /arrestee_count/.test(sc.responseSql || '') && !/arrest_count\b/.test(sc.responseSql || '') && sc.modelSql[0] !== sc.responseSql,
    JSON.stringify({ model: sc.modelSql[0], response: sc.responseSql, launches: sc.workerLaunches, err: sc.errors }));
  const rt = by('retry-after-schema-failure');
  check(`retry path: after a schema failure the retried statement delivers ${e.murder2025}, prepared with its identity`,
    rt.modelCalls === p.modelCalls + 1 && Number(first(rt)) === e.murder2025 && deliveredBound(rt), JSON.stringify({ calls: rt.modelCalls, rows: rt.rows, launches: rt.workerLaunches }));
  for (const id of ['initial-altered-in-transit', 'retry-altered-in-transit']) {
    const a = by(id);
    check(`${id}: an alteration after the final check reaches the worker and is refused at prepare (no rows, not the altered statement's figure)`,
      a.rows.length === 0 && a.workerLaunches.length >= 1 && a.workerLaunches.every((l) => l.altered && l.sha && l.sha !== l.shaOfReceived),
      JSON.stringify({ rows: a.rows, launches: a.workerLaunches, err: a.errors, explanation: a.explanation.slice(0, 160) }));
  }
  /* R1: the planner's clearance rollups deliver through the bound worker. The national question first
     tries an EXCLUDED deterministic arrestee query (its rollup table is absent in the fixture), so only the
     FINAL launch -- the one that answers -- is required to be the bound, checked statement. */
  const lastBound = (x, table) => { const l = x.workerLaunches[x.workerLaunches.length - 1]; return Boolean(l) && bound(l) && l.received === x.responseSql && new RegExp(table).test(l.received); };
  const sr = by('rollup-state-clearance');
  check(`R1 initial: "rapes cleared by arrest in Illinois" is planned to the state clearance rollup and delivers ${e.illinoisRapesClearedByArrest2025}, bound`,
    Number(first(sr)) === e.illinoisRapesClearedByArrest2025 && lastBound(sr, 'rollup\.state_summary_clearance_detail'), JSON.stringify({ rows: sr.rows, launches: sr.workerLaunches, explanation: sr.explanation.slice(0, 160) }));
  const nc = by('rollup-national-clearance');
  check(`R1 initial: the national question is planned to the national clearance rollup and delivers ${e.nationalRapesClearedByArrest2025}, bound`,
    Number(first(nc)) === e.nationalRapesClearedByArrest2025 && lastBound(nc, 'rollup\.national_summary_clearance_detail'), JSON.stringify({ rows: nc.rows, launches: nc.workerLaunches, explanation: nc.explanation.slice(0, 160) }));
  const rc = by('rollup-state-clearance-retry');
  check(`R1 retry: after a schema failure the retried clearance rollup delivers ${e.illinoisRapesClearedByArrest2025}, bound`,
    Number(first(rc)) === e.illinoisRapesClearedByArrest2025 && lastBound(rc, 'rollup\.state_summary_clearance_detail'), JSON.stringify({ rows: rc.rows, launches: rc.workerLaunches, explanation: rc.explanation.slice(0, 160) }));
  const ac = by('rollup-clearance-altered-in-transit');
  check('R1: a clearance rollup altered after the final check (IL -> CA) is refused at prepare',
    ac.rows.length === 0 && ac.workerLaunches.length >= 1 && ac.workerLaunches.filter((l) => l.altered).every((l) => l.sha && l.sha !== l.shaOfReceived) && ac.workerLaunches.some((l) => l.altered),
    JSON.stringify({ rows: ac.rows, launches: ac.workerLaunches }));
  const wt = by('wrong-table-clearance');
  check('R1 unsafe counterpart: an ordinary offense-count table used as an arrest-clearance count is still refused, never executed',
    wt.rows.length === 0 && !wt.workerLaunches.some((l) => /summary_state_monthly/.test(l.received)) && /couldn't build a reliable query/i.test(wt.explanation),
    JSON.stringify({ rows: wt.rows, launches: wt.workerLaunches, explanation: wt.explanation.slice(0, 160) }));
  const f = by('final-check-refusal');
  check('a final-check refusal never reaches the worker (no launch, no rows)', f.workerLaunches.length === 0 && f.rows.length === 0,
    JSON.stringify({ launches: f.workerLaunches, rows: f.rows, explanation: f.explanation.slice(0, 160) }));
  return checks;
}

function compare(before, after) {
  const summary = (r) => r ? `${r.rows.length} rows ${JSON.stringify(r.rows[0] || null)}, launches ${r.workerLaunches.length} ${r.workerLaunches.map((l) => (l.sha ? 'bound' : 'unbound')).join('/')}` : 'absent';
  return after.filter((r) => {
    const b = before.find((y) => y.id === r.id);
    return !(b && JSON.stringify(b.rows) === JSON.stringify(r.rows) && (b.responseSql || null) === (r.responseSql || null) && b.explanation === r.explanation);
  }).map((r) => ({ id: r.id, before: summary(before.find((y) => y.id === r.id)), after: summary(r) }));
}

main().catch((e) => { console.error(e); process.exit(1); });
