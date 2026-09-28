'use strict';
/*
 * Value boundary of the owned offender-share statement (Codex "G32 correction review"): an undefined
 * share (SQL NULL) is delivered as unavailable, never as a percentage; a genuine numeric zero is 0.0%.
 * Reuses ../../route-witness-gc032.cjs in memory, exactly as Codex's ../codex-null-share.cjs does
 * (fixture, scenarios, scripted replies and checks only). The positive 8.4% case is the unchanged
 * ../route-witness-g32.cjs, rerun separately.
 *
 *   --mode unavailable  Codex's fixture: every in-scope offender count is 0, so the share is NULL.
 *   --mode zero         every in-scope 'Under 18' count is 0, the rest unchanged: a real 0% share.
 *
 * Run: node audit/phase3-gc032-share-2026-09-28/g32/value-boundary/route-witness-value.cjs --mode <unavailable|zero> --out <file.json> [--assert] [--root <tree>]
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const mode = process.argv[process.argv.indexOf('--mode') + 1];
if (!['unavailable', 'zero'].includes(mode)) throw new Error('--mode unavailable|zero');
const file = path.join(__dirname, '..', '..', 'route-witness-gc032.cjs');
let source = fs.readFileSync(file, 'utf8');
const swap = (from, to) => { if (source.split(from).length !== 2) throw new Error('anchor not unique: ' + from.slice(0, 60)); source = source.replace(from, to); };

const TRUE_TEXT = mode === 'unavailable'
  ? 'The percentage cannot be calculated because there are no recorded offenders in the requested scope.'
  : 'None of the recorded offenders in the requested scope were under 18.';
const FALSE_TEXT = mode === 'unavailable'
  ? '0.0% of serious violent crimes in California from 2021 to 2025 were committed by youth under 18.'
  : 'About 8% of serious violent crimes in California were committed by youth under 18.';
const start = source.indexOf('const cases = [');
const end = source.indexOf('].map((c) => ({ ...c, q }));', start);
if (start < 0 || end < 0) throw new Error('scenario anchors absent');
source = source.slice(0, start) + `const TRUE_TEXT = ${JSON.stringify(TRUE_TEXT)};
const FALSE_TEXT = ${JSON.stringify(FALSE_TEXT)};
const TOTAL_CTE = RETAINED.replace(/SUM\\(d\\.offender_count\\)/g, 'TOTAL(d.offender_count)');
const cases = [
  { id: 'retained-gc032', explain: TRUE_TEXT, sql: RETAINED },
  { id: 'retained-cte-false-wording', explain: FALSE_TEXT, sql: RETAINED },
  { id: 'single-select', explain: TRUE_TEXT, sql: SINGLE },
  { id: 'single-select-false-wording', explain: FALSE_TEXT, sql: SINGLE },
  { id: 'total-cte', explain: TRUE_TEXT, sql: TOTAL_CTE },
  { id: 'total-cte-false-wording', explain: FALSE_TEXT, sql: TOTAL_CTE },
` + source.slice(end);

const anchor = "add('CA', 2025, '09A', 'Unknown', 1000);";
const zeroing = mode === 'unavailable'
  ? "for (const r of rows.nibrs.summary_offender_demographics) { if (r.state === 'CA' && r.year >= 2021 && r.year <= 2025 && ['09A','11A','11B','11C','120','13A'].includes(r.ucr_offense_code)) r.offender_count = 0; }"
  : "for (const r of rows.nibrs.summary_offender_demographics) { if (r.state === 'CA' && r.year >= 2021 && r.year <= 2025 && ['09A','11A','11B','11C','120','13A'].includes(r.ucr_offense_code) && r.age_group === 'Under 18') r.offender_count = 0; }";
swap(anchor, anchor + ' ' + zeroing);
swap('return reply(${EXPLAIN_JSON});', 'return reply(s.explain || ${EXPLAIN_JSON});');

const cs = source.indexOf('  const checks = [];');
const ce = source.indexOf('  const gc032Delivery', cs);
if (cs < 0 || ce < 0) throw new Error('check anchors absent');
const SCOPE_TEXT = 'Of the offenders recorded in NIBRS reports for the requested offenses in California, 2021–2025, ';
source = source.slice(0, cs) + `  const checks = [];
  const MODE = ${JSON.stringify(mode)};
  const SCOPE_TEXT = ${JSON.stringify(SCOPE_TEXT)};
  for (const s of SCENARIOS) {
    const r = by[s.id];
    const f = figure(s.id);
    const text = r.explanation;
    checks.push({ name: s.id + ': executed once by the bound worker', ok: r.workerReceived.length === 1 && (r.rows || []).length === 1, detail: JSON.stringify({ rows: r.rows, worker: r.workerReceived.length }) });
    if (MODE === 'unavailable') {
      checks.push({ name: s.id + ': the row holds NULL for the share and zero counts', ok: f.youth_share_pct === null && f.youth_count === 0 && f.total_count === 0, detail: JSON.stringify(r.rows) });
      const owned = SCOPE_TEXT + 'the share that had a recorded age group of Under 18 is unavailable: the result contains no recorded offenders in this scope, so no percentage can be computed.';
      checks.push({ name: s.id + ': delivered as unavailable, with no percentage anywhere', ok: text.includes(owned) && !/\\\\d%/.test(text), detail: text.slice(0, 400) });
    } else {
      const zeroN = youthN === 0 && totalN > 0;
      checks.push({ name: s.id + ': the row holds a real 0 share over ' + totalN + ' recorded offenders', ok: zeroN && f.youth_share_pct === 0 && f.youth_count === 0 && f.total_count === totalN, detail: JSON.stringify(r.rows) });
      const owned = SCOPE_TEXT + '0.0% (0 of ' + totalN.toLocaleString('en-US') + ') had a recorded age group of Under 18.';
      checks.push({ name: s.id + ': delivered as 0.0% with its counts, not as unavailable, no crime claim', ok: text.includes(owned) && !/unavailable/.test(text) && !/of serious violent crimes/.test(text), detail: text.slice(0, 400) });
    }
  }
` + source.slice(ce);

const mod = new Module(file, module);
mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
mod._compile(source, file);
