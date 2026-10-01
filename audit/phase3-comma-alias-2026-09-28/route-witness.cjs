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
 * Run: node audit/phase3-comma-alias-2026-09-28/route-witness.cjs --out <file.json> [--assert] [--root <staged tree>]  (prelude copied from the P4.1 binding witness)
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
const WORK = path.join(os.tmpdir(), `comma-alias-${process.pid}-${Date.now()}`);
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

/* ------------------------------------------------------------------ scenarios (comma-join alias repair) */
/*
 * Appended to the P4.1 driver prelude (seam, fixtures, consume/shape) by build-route-witness.cjs.
 * --root <dir> loads the route from a staged tree (the pre-change copy); default is the repository.
 */

const QY = 'what share of serious violent crimes in California are committed by youth under 18?';
const GC032 = "WITH youth_offenders AS (SELECT SUM(d.offender_count) AS youth_count FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.age_group = 'Under 18' AND d.year BETWEEN 2021 AND 2025), total_offenders AS (SELECT SUM(d.offender_count) AS total_count FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.year BETWEEN 2021 AND 2025) SELECT ROUND(100.0 * y.youth_count / t.total_count, 1) AS youth_share_pct, y.youth_count, t.total_count FROM youth_offenders y, total_offenders t";
const GC032_JOIN = GC032.replace('FROM youth_offenders y, total_offenders t', 'FROM youth_offenders y JOIN total_offenders t ON 1 = 1');
const GC032_UNDECLARED = GC032.replace('y.youth_count, t.total_count FROM', 'zz.youth_count, t.total_count FROM');
const QC = 'How many rapes were cleared by arrest in Illinois in 2025?';
const CLEAR_IL = "SELECT SUM(cleared_by_arrest) AS rapes_cleared_by_arrest FROM summary_clearance_detail WHERE state = 'IL' AND year = 2025 AND ucr_offense_code = '11A'";
const CLEAR_WRONG_COMMA = "SELECT SUM(s.offense_count) AS rapes_cleared_by_arrest FROM agencies a, summary_state_monthly s WHERE a.state = s.state AND s.state = 'IL' AND s.year = 2025 AND s.ucr_offense_code = '11A'";

const SCENARIOS = [
  { id: 'gc032-comma-join', q: QY, sql: GC032, expect: 'answer' },
  { id: 'gc032-join-form', q: QY, sql: GC032_JOIN, expect: 'same-as-comma' },
  { id: 'gc032-undeclared-alias', q: QY, sql: GC032_UNDECLARED, expect: 'refused' },
  { id: 'clearance-wrong-table-comma', q: QC, sql: CLEAR_WRONG_COMMA, expect: 'refused' },
  { id: 'clearance-control', q: QC, sql: CLEAR_IL, expect: 'answer' },
];

function makeModel(s) {
  const calls = [];
  const reply = (text) => ({ id: 'offline', type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  return {
    calls,
    client: { messages: { create: async (request) => {
      const last = (request.messages || []).filter((m) => m.role === 'user').slice(-1)[0];
      calls.push({ user: last ? String(typeof last.content === 'string' ? last.content : JSON.stringify(last.content)).slice(0, 400) : '' });
      // Every generation/retry call returns the same scripted statement: a refusal cannot be
      // "repaired" by the model writing something else, so the outcome is the gate's alone.
      return reply(JSON.stringify({ sql: s.sql, title: 'Witness', explanation: 'The scripted statement for this witness.', chartType: 'none', yAxis: [] }));
    } } },
  };
}

/* Expected figures, derived from the fixture rows alone. */
function derive() {
  const rows = fixtureRows().nibrs.summary_offender_demographics;
  const codes = ['09A', '11A', '11B', '11C', '120', '13A'];
  const inScope = rows.filter((r) => r.state === 'CA' && codes.includes(r.ucr_offense_code) && r.year >= 2021 && r.year <= 2025);
  const youth = inScope.filter((r) => r.age_group === 'Under 18').reduce((s, r) => s + r.offender_count, 0);
  const total = inScope.reduce((s, r) => s + r.offender_count, 0);
  const clear = (fixtureRows().nibrs.summary_clearance_detail || [])
    .filter((r) => r.state === 'IL' && r.year === 2025 && r.ucr_offense_code === '11A').reduce((s, r) => s + (r.cleared_by_arrest || 0), 0);
  return { youth_count: youth, total_count: total, youth_share_pct: Math.round(1000 * youth / total) / 10, rapes_cleared_by_arrest: clear };
}

async function main() {
  const ROOT = argValue('--root') ? path.resolve(argValue('--root')) : REPO;
  const dbs = buildFixtureDatabases();
  const REAL_SOURCES = [path.join(REPO, 'crime_data.db'), path.join(REPO, 'nibrs.db'), path.join(REPO, 'shr.db'), '/opt/nibrs/nibrs.db'];
  let current = { messages: { create: async () => { throw new Error('no model bound'); } } };
  const app = prepare({
    root: ROOT,
    modelClient: { messages: { create: (...a) => current.messages.create(...a) } },
    databasePaths: [dbs.crime, dbs.targets.nibrs, dbs.targets.shr, dbs.targets.hate_crime, dbs.queryLog, dbs.rollup],
    env: {
      RTCI_DB_PATH: dbs.crime, NIBRS_DB_PATH: dbs.targets.nibrs, SHR_DB_PATH: dbs.targets.shr, HC_DB_PATH: dbs.targets.hate_crime,
      QUERY_LOG_DB_PATH: dbs.queryLog, NIBRS_ROLLUP_DB_PATH: dbs.rollup, APP_DIR: ROOT,
      ANTHROPIC_API_KEY: 'offline-witness-placeholder-not-a-key', AUTH_PASSWORD: SECRET, NODE_ENV: 'test',
    },
  });
  const networkProbe = app.network.probe();
  const databaseProbe = app.db.probe(REAL_SOURCES);
  const expected = derive();
  const results = [];
  for (const s of SCENARIOS) {
    const model = makeModel(s);
    current = model.client;
    const cache = app.route('lib/response-cache.ts');
    if (typeof cache.__resetResponseCacheForTests === 'function') cache.__resetResponseCacheForTests();
    const mod = app.route('app/api/nibrs-query/route.ts');
    WORKER.launches = []; WORKER.alter = false;
    const body = { question: s.q, sessionId: `w-${s.id}-${Date.now()}`, pageToken: mintPageToken() };
    const request = new Request('http://localhost/api/witness', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.12.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify(body),
    });
    let consumed; let threw = null;
    try { consumed = await consume(await mod.POST(request)); }
    catch (e) { threw = String(e && e.stack || e).slice(0, 600); consumed = { status: 0, events: [] }; }
    const delivered = shape(consumed);
    const errors = consumed.events.map((e) => e && e.error).filter(Boolean);
    results.push({ id: s.id, question: s.q, expect: s.expect, status: consumed.status, threw, modelCalls: model.calls.length,
      retryPrompts: model.calls.slice(1).map((c) => c.user), modelSql: s.sql, responseSql: delivered.sql,
      workerReceived: WORKER.launches.map((l) => l.received), rows: delivered.rows, columns: delivered.columns,
      explanation: delivered.finalNarrative, errors });
    console.log(`${s.id.padEnd(30)} status=${consumed.status} calls=${model.calls.length} rows=${delivered.rows.length} worker=${WORKER.launches.length} ${threw ? 'THREW ' : ''}| ${(delivered.finalNarrative || errors.join(' ')).replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  const report = app.report();
  app.teardown();

  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  const row0 = (id) => (by[id].rows || [])[0] || {};
  const aliasRetry = (id) => by[id].retryPrompts.some((p) => /undeclared table alias/i.test(p));
  const retryRules = (id) => [...new Set(by[id].retryPrompts.flatMap((p) => [...p.matchAll(/violation \(([a-z0-9-]+)\)/g)].map((m) => m[1])
    .concat(/undeclared table alias/i.test(p) ? ['nibrs-undeclared-table-alias'] : [])))].sort();
  const STRUCTURE_REFUSAL = /couldn't build a valid query after correcting the SQL structure/i;
  const sameOutcome = (a, b) => JSON.stringify([by[a].rows, by[a].explanation, retryRules(a), by[a].workerReceived.length])
    === JSON.stringify([by[b].rows, by[b].explanation, retryRules(b), by[b].workerReceived.length]);
  for (const r of results) r.retryRules = retryRules(r.id);
  const checks = [
    { name: 'GC-032 comma form: neither comma-sensitive rule (undeclared alias, untraceable returned value) fires',
      ok: !retryRules('gc032-comma-join').includes('nibrs-undeclared-table-alias') && !retryRules('gc032-comma-join').includes('structural-returned-series-unresolved'),
      detail: retryRules('gc032-comma-join').join(',') },
    { name: 'GC-032 comma form and explicit JOIN form get the identical outcome (rows, reply, retry rules, execution)',
      ok: sameOutcome('gc032-comma-join', 'gc032-join-form'), detail: JSON.stringify({ comma: retryRules('gc032-comma-join'), join: retryRules('gc032-join-form') }) },
    { name: 'a genuinely undeclared alias in the same statement is refused as a structure failure and never executed',
      ok: STRUCTURE_REFUSAL.test(by['gc032-undeclared-alias'].explanation) && (by['gc032-undeclared-alias'].rows || []).length === 0 && by['gc032-undeclared-alias'].workerReceived.length === 0,
      detail: JSON.stringify({ rules: retryRules('gc032-undeclared-alias'), reply: by['gc032-undeclared-alias'].explanation.slice(0, 80), worker: by['gc032-undeclared-alias'].workerReceived.length }) },
    { name: 'a comma-joined wrong-table clearance statement delivers no figure and is never executed',
      ok: (by['clearance-wrong-table-comma'].rows || []).length === 0 && by['clearance-wrong-table-comma'].workerReceived.length === 0,
      detail: JSON.stringify({ rules: retryRules('clearance-wrong-table-comma'), rows: by['clearance-wrong-table-comma'].rows, worker: by['clearance-wrong-table-comma'].workerReceived.length }) },
    { name: 'control: the single-table clearance answer still delivers the fixture figure', ok: row0('clearance-control').rapes_cleared_by_arrest === expected.rapes_cleared_by_arrest,
      detail: JSON.stringify(row0('clearance-control')) },
  ];
  // Observation, not a check: whether GC-032 now delivers its figure, and if not, which rule stops it.
  const gc032Delivery = { delivered: row0('gc032-comma-join').youth_share_pct === expected.youth_share_pct, rows: by['gc032-comma-join'].rows,
    retryRules: retryRules('gc032-comma-join'), reply: by['gc032-comma-join'].explanation };
  const out = {
    kind: 'phase3-comma-alias-route-witness', at: new Date().toISOString(), root: path.relative(REPO, ROOT) || '.', expected,
    boundaries: { networkProbe, databaseProbe, outboundNetworkAttempts: report.outboundNetworkAttempts.length,
      refusedDatabaseOpens: report.databaseOpens.filter((d) => !d.allowed).length, substitutedModules: report.substitutedModules },
    gc032Delivery,
    checks: { passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length, list: checks },
    results,
  };
  fs.writeFileSync(path.resolve(OUT), JSON.stringify(out, null, 1));
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  -- ${c.detail}`}`);
  console.log(`  OBSERVED  GC-032 delivered=${gc032Delivery.delivered}; retry rules: ${gc032Delivery.retryRules.join(', ') || 'none'}`);
  console.log(`\nwrote ${OUT}; checks ${out.checks.passed} passed / ${out.checks.failed} failed; network blocked ${networkProbe.filter((p) => p.blocked).length}/${networkProbe.length}; real sources refused ${databaseProbe.filter((p) => p.blocked).length}/${databaseProbe.length}`);
  if (process.argv.includes('--assert') && out.checks.failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* ok */ } });
