'use strict';
/*
 * GC-032 supported-share repair: the REAL route and worker over disposable fixtures, reusing
 * ../phase3-comma-alias-2026-09-28/route-witness.cjs the way the CMA1 witness does (scenarios, checks,
 * synthetic rows and the scripted model change in memory only).
 *
 * Question (GC-032): "what share of serious violent crimes in California are committed by youth under 18?"
 * Synthetic rows added to the fixture so a dropped filter changes the number:
 *   TX 2025 09A  Under 18 500, 18-24 500   (state control)
 *   CA 2019 09A  Under 18 400              (period control)
 *   CA 2025 23H  Under 18 900              (offense control: larceny is not in the list)
 *   CA 2025 09A  Unknown  1000             (recorded offenders of unknown age: IN the total)
 * Correct answer from the rows alone: 1200 youth of 15000 recorded offenders = 8.0%.
 *
 * The scripted model returns each scenario's SQL for generation/retry calls, and for the post-query
 * explanation call returns a sentence written in the WRONG unit ("% of serious violent crimes"), the
 * wording a model plausibly writes, so the delivered text shows what the product does with it.
 *
 * Run: node audit/phase3-gc032-share-2026-09-28/route-witness-gc032.cjs --out <file.json> [--assert] [--root <staged tree>]
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const original = path.join(__dirname, '..', 'phase3-comma-alias-2026-09-28', 'route-witness.cjs');
let text = fs.readFileSync(original, 'utf8');

const q = 'what share of serious violent crimes in California are committed by youth under 18?';
const T = 'summary_offender_demographics';
const CODES = "('09A','11A','11B','11C','120','13A')";
const SCOPE = `d.state = 'CA' AND d.ucr_offense_code IN ${CODES} AND d.year BETWEEN 2021 AND 2025`;
const cte = (name, agg, where) => `${name} AS (SELECT ${agg} AS ${name === 'youth_offenders' ? 'youth_count' : 'total_count'} FROM ${T} d WHERE ${where})`;
const outer = (scale = '100.0', num = 'y.youth_count', den = 't.total_count') =>
  `SELECT ROUND(${scale} * ${num} / ${den}, 1) AS youth_share_pct, y.youth_count, t.total_count`;
const twoCte = ({ youthAgg = 'SUM(d.offender_count)', youthWhere = `${SCOPE} AND d.age_group = 'Under 18'`,
  totalAgg = 'SUM(d.offender_count)', totalWhere = SCOPE, select = outer(), from = 'FROM youth_offenders y, total_offenders t' } = {}) =>
  `WITH ${cte('youth_offenders', youthAgg, youthWhere)}, ${cte('total_offenders', totalAgg, totalWhere)} ${select} ${from}`;
// The retained 09-22 GC-032 statement, byte-for-byte as saved (it puts age_group before year).
const RETAINED = "WITH youth_offenders AS (SELECT SUM(d.offender_count) AS youth_count FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.age_group = 'Under 18' AND d.year BETWEEN 2021 AND 2025), total_offenders AS (SELECT SUM(d.offender_count) AS total_count FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.year BETWEEN 2021 AND 2025) SELECT ROUND(100.0 * y.youth_count / t.total_count, 1) AS youth_share_pct, y.youth_count, t.total_count FROM youth_offenders y, total_offenders t";
const YOUTH = "SUM(CASE WHEN d.age_group = 'Under 18' THEN d.offender_count ELSE 0 END)";
const SINGLE = `SELECT ROUND(100.0 * ${YOUTH} / SUM(d.offender_count), 1) AS youth_share_pct, ${YOUTH} AS youth_count, SUM(d.offender_count) AS total_count FROM ${T} d WHERE ${SCOPE}`;

// wrong: the figure this statement would deliver if admitted (from the rows), for the record.
const cases = [
  { id: 'retained-gc032', expect: 'answer', sql: RETAINED },
  { id: 'cross-join-form', expect: 'answer', sql: twoCte({ from: 'FROM youth_offenders y CROSS JOIN total_offenders t' }) },
  { id: 'join-on-1-form', expect: 'answer', sql: twoCte({ from: 'FROM youth_offenders y JOIN total_offenders t ON 1 = 1' }) },
  { id: 'single-select-control', expect: 'answer', sql: SINGLE },
  // The explanation call leaks internal JSON, so the firewall replaces the narrative; the unit must survive.
  { id: 'retained-gc032-leaky-explanation', expect: 'answer', leaky: true, sql: RETAINED },
  { id: 'wrong-denominator-drops-state', expect: 'refuse', wrong: 7.5, sql: twoCte({ totalWhere: `d.ucr_offense_code IN ${CODES} AND d.year BETWEEN 2021 AND 2025` }) },
  { id: 'wrong-denominator-counts-rows', expect: 'refuse', sql: twoCte({ totalAgg: 'COUNT(*)' }) },
  { id: 'wrong-numerator-counts-rows', expect: 'refuse', sql: twoCte({ youthAgg: 'COUNT(*)' }) },
  { id: 'wrong-subset-18-24', expect: 'refuse', wrong: 32.0, sql: twoCte({ youthWhere: `${SCOPE} AND d.age_group = '18-24'` }) },
  { id: 'wrong-scale-200', expect: 'refuse', wrong: 16.0, sql: twoCte({ select: outer('200.0') }) },
  { id: 'wrong-numerator-period', expect: 'refuse', sql: twoCte({ youthWhere: `d.state = 'CA' AND d.ucr_offense_code IN ${CODES} AND d.year = 2025 AND d.age_group = 'Under 18'` }) },
  { id: 'wrong-inverted', expect: 'refuse', wrong: 1250.0, sql: twoCte({ select: outer('100.0', 't.total_count', 'y.youth_count') }) },
  { id: 'wrong-numerator-offenses', expect: 'refuse', wrong: 2.0, sql: twoCte({ youthWhere: `d.state = 'CA' AND d.ucr_offense_code IN ('09A') AND d.year BETWEEN 2021 AND 2025 AND d.age_group = 'Under 18'` }) },
].map((c) => ({ ...c, q }));

const EXPLAIN = 'Youth under 18 accounted for 8.0% of serious violent crimes in California from 2021 to 2025.';

text = text.replace(/const SCENARIOS = \[[\s\S]*?\n\];/, 'const SCENARIOS = ' + JSON.stringify(cases) + ';');
text = text.replace('  return rows;', `
  const add = (state, year, code, age, n) => rows.nibrs.summary_offender_demographics.push({ ori: state === 'CA' ? 'CA0010100' : 'TX0000000', state, year, ucr_offense_code: code, age_group: age, offender_count: n });
  add('TX', 2025, '09A', 'Under 18', 500); add('TX', 2025, '09A', '18-24', 500);
  add('CA', 2019, '09A', 'Under 18', 400);
  add('CA', 2025, '23H', 'Under 18', 900);
  add('CA', 2025, '09A', 'Unknown', 1000);
  return rows;`);
const EXPLAIN_JSON = JSON.stringify(EXPLAIN);
text = text.replace(/function makeModel\(s\) \{[\s\S]*?\n\}\n/, `function makeModel(s) {
  const calls = [];
  const reply = (text) => ({ id: 'offline', type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  return {
    calls,
    client: { messages: { create: async (request) => {
      const last = (request.messages || []).filter((m) => m.role === 'user').slice(-1)[0];
      const content = last ? String(typeof last.content === 'string' ? last.content : JSON.stringify(last.content)) : '';
      calls.push({ user: content.slice(0, 400), explanation: /Results metadata:/.test(content) });
      if (/Results metadata:/.test(content) && !s.leaky) return reply(${EXPLAIN_JSON});
      return reply(JSON.stringify({ sql: s.sql, title: 'Youth share of recorded offenders', explanation: 'The scripted statement for this witness.', chartType: 'none', yAxis: [] }));
    } } },
  };
}
`);
const start = text.indexOf('  const checks = [');
const end = text.indexOf('  const out = {', start);
if (start < 0 || end < 0 || !text.includes('Results metadata:')) throw new Error('witness anchors absent');
text = text.slice(0, start) + `  // Expected figures from the fixture rows alone, independent of any SQL.
  const all = fixtureRows().nibrs.summary_offender_demographics;
  const CODESET = ['09A','11A','11B','11C','120','13A'];
  const inScope = all.filter((r) => r.state === 'CA' && CODESET.includes(r.ucr_offense_code) && r.year >= 2021 && r.year <= 2025);
  const youthN = inScope.filter((r) => r.age_group === 'Under 18').reduce((n, r) => n + r.offender_count, 0);
  const totalN = inScope.reduce((n, r) => n + r.offender_count, 0);
  const pct = Math.round(1000 * youthN / totalN) / 10;
  const figure = (id) => ((by[id].rows || [])[0] || {});
  const checks = [];
  for (const s of SCENARIOS) {
    const r = by[s.id];
    if (s.expect === 'answer') {
      const f = figure(s.id);
      checks.push({ name: s.id + ': delivers ' + pct + '% = ' + youthN + ' / ' + totalN, ok: f.youth_share_pct === pct && f.youth_count === youthN && f.total_count === totalN,
        detail: JSON.stringify(r.rows) });
      if (s.leaky) checks.push({ name: s.id + ': the firewall replaced the leaking narrative and the unit sentence survived it',
        ok: /offenders recorded in NIBRS reports \\(including offenders recorded with an unknown age\\), not of crimes or incidents/.test(r.explanation) && !/"sql"/.test(r.explanation),
        detail: r.explanation.slice(0, 400) });
      else checks.push({ name: s.id + ': delivered text names the unit as recorded offenders, not crimes, and keeps the figure, place and period',
        ok: /recorded offenders|offenders recorded/i.test(r.explanation) && !/% of serious violent crimes/i.test(r.explanation) && r.explanation.includes(String(pct)) && /California/.test(r.explanation) && /2021/.test(r.explanation) && /unknown/i.test(r.explanation),
        detail: r.explanation.slice(0, 400) });
    } else {
      checks.push({ name: s.id + ': no figure delivered, never executed', ok: (r.rows || []).length === 0 && r.workerReceived.length === 0,
        detail: JSON.stringify({ rows: r.rows, worker: r.workerReceived.length }) });
    }
  }
  checks.push({ name: 'expected figure is derived from rows: 1200 / 15000 = 8.0%', ok: youthN === 1200 && totalN === 15000 && pct === 8, detail: JSON.stringify({ youthN, totalN, pct }) });
  const gc032Delivery = { delivered: figure('retained-gc032').youth_share_pct === pct, retryRules: by['retained-gc032'].retryRules || [], expected: { youthN, totalN, pct } };
` + text.slice(end);
const mod = new Module(original, module);
mod.filename = original; mod.paths = Module._nodeModulePaths(path.dirname(original));
mod._compile(text, original);
