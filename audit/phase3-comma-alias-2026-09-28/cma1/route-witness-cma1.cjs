'use strict';
/*
 * CMA1 (Codex comma-join ruling): the period proof must account for every counted comma-joined
 * instance. Reuses ../route-witness.cjs (the submitted real-route + real-worker driver) the same way
 * Codex's codex-period-route.cjs does: scenarios, checks and one synthetic row change in memory only.
 *
 * Synthetic row: Illinois 2025 rape clearances are 300; one added 2024 row holds 100, so any answer
 * that lets a second instance read every year says 400.
 *
 * Run: node audit/phase3-comma-alias-2026-09-28/cma1/route-witness-cma1.cjs --out <file.json> [--assert] [--root <staged tree>]
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const original = path.join(__dirname, '..', 'route-witness.cjs');
let text = fs.readFileSync(original, 'utf8');

const q = 'How many rapes were cleared by arrest in Illinois in 2025?';
const SCD = 'summary_clearance_detail';
const J = 'a.ori = b.ori AND a.ucr_offense_code = b.ucr_offense_code';
const TAIL = "a.year = 2025 AND b.state = 'IL' AND b.ucr_offense_code = '11A'";
const PLAIN = `SELECT SUM(cleared_by_arrest) AS c FROM ${SCD} WHERE state = 'IL' AND ucr_offense_code = '11A'`;
const cases = [
  { id: 'comma-unpinned', expect: 'refuse', sql: `SELECT SUM(b.cleared_by_arrest) AS rapes_cleared_by_arrest FROM ${SCD} a, ${SCD} b WHERE ${J} AND ${TAIL}` },
  { id: 'comma-pinned', expect: 300, sql: `SELECT SUM(b.cleared_by_arrest) AS rapes_cleared_by_arrest FROM ${SCD} a, ${SCD} b WHERE ${J} AND ${TAIL} AND b.year = 2025` },
  { id: 'join-unpinned', expect: 'refuse', sql: `SELECT SUM(b.cleared_by_arrest) AS rapes_cleared_by_arrest FROM ${SCD} a JOIN ${SCD} b ON ${J} WHERE ${TAIL}` },
  { id: 'join-pinned', expect: 300, sql: `SELECT SUM(b.cleared_by_arrest) AS rapes_cleared_by_arrest FROM ${SCD} a JOIN ${SCD} b ON ${J} WHERE ${TAIL} AND b.year = 2025` },
  { id: 'quoted-comma-unpinned', expect: 'refuse', sql: `SELECT SUM(b.cleared_by_arrest) AS rapes_cleared_by_arrest FROM ${SCD} a, "${SCD}" b WHERE ${J} AND ${TAIL}` },
  { id: 'join-then-comma-unpinned', expect: 'refuse', sql: `SELECT SUM(${SCD}.cleared_by_arrest) AS rapes_cleared_by_arrest FROM ${SCD} a JOIN agencies g ON g.ori = a.ori AND g.year = 2025, ${SCD} WHERE a.ori = ${SCD}.ori AND a.ucr_offense_code = ${SCD}.ucr_offense_code AND a.year = 2025 AND ${SCD}.state = 'IL' AND ${SCD}.ucr_offense_code = '11A'` },
  { id: 'cte-comma-unpinned', expect: 'refuse', sql: `WITH y AS (${PLAIN} AND year = 2025), t AS (${PLAIN}) SELECT t.c AS rapes_cleared_by_arrest FROM y, t` },
  { id: 'cte-comma-pinned', expect: 300, sql: `WITH y AS (${PLAIN} AND year = 2025), t AS (${PLAIN} AND year = 2025) SELECT t.c AS rapes_cleared_by_arrest FROM y, t` },
  { id: 'simple-control', expect: 300, sql: `SELECT SUM(cleared_by_arrest) AS rapes_cleared_by_arrest FROM ${SCD} WHERE state = 'IL' AND year = 2025 AND ucr_offense_code = '11A'` },
].map((c) => ({ ...c, q }));

text = text.replace(/const SCENARIOS = \[[\s\S]*?\n\];/, 'const SCENARIOS = ' + JSON.stringify(cases) + ';');
text = text.replace('  return rows;', `
  const baseRow = rows.nibrs.summary_clearance_detail.find(r => r.state === 'IL' && r.year === 2025 && r.ucr_offense_code === '11A');
  if (!baseRow) throw new Error('fixture row absent');
  rows.nibrs.summary_clearance_detail.push({...baseRow, year:2024, cleared_by_arrest:100});
  return rows;`);
const start = text.indexOf('  const checks = [');
const end = text.indexOf('  const out = {', start);
if (start < 0 || end < 0) throw new Error('witness anchors absent');
text = text.slice(0, start) + `  const checks = SCENARIOS.map((s) => {
    const r = by[s.id];
    const figure = ((r.rows || [])[0] || {}).rapes_cleared_by_arrest;
    if (s.expect === 'refuse') return { name: s.id + ': refused, no figure, never executed',
      ok: (r.rows || []).length === 0 && r.workerReceived.length === 0, detail: JSON.stringify({ rows: r.rows, worker: r.workerReceived.length }) };
    return { name: s.id + ': delivers ' + s.expect, ok: figure === s.expect, detail: JSON.stringify(r.rows) };
  });
  const gc032Delivery = { delivered: false, retryRules: [], note: 'not exercised by this witness' };
` + text.slice(end);
const mod = new Module(original, module);
mod.filename = original; mod.paths = Module._nodeModulePaths(path.dirname(original));
mod._compile(text, original);
