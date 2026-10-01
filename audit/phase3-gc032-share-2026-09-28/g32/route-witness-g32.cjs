'use strict';
/*
 * G32-1 / G32-2 correction witness (Codex GC-032 ruling). Reuses ../route-witness-gc032.cjs (itself the
 * submitted comma driver) in memory only: scenarios, one extra fixture row, per-scenario scripted
 * explanations and the checks change; no submitted file is edited.
 *
 * Fixture: the submitted GC-032 rows plus Codex's extra 60 in-scope youth, so the correct share is
 * NON-INTEGRAL: 1,260 / 15,060 = 8.3665...% -> 8.4 at one decimal. Integer division gives 8 (or 0).
 *
 * Explanations the scripted model returns for the post-query explanation call:
 *   conflicting - Codex's "8.4% of all reported serious violent crimes were committed by youth under 18"
 *   recorded    - a correct recorded-offender sentence
 *   leaky       - the generation JSON again (the internal-leak firewall replaces the narrative)
 *
 * Run: node audit/phase3-gc032-share-2026-09-28/g32/route-witness-g32.cjs --out <file.json> [--assert] [--root <staged tree>]
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const file = path.join(__dirname, '..', 'route-witness-gc032.cjs');
let source = fs.readFileSync(file, 'utf8');
const swap = (from, to) => { if (source.split(from).length !== 2) throw new Error('anchor not unique: ' + from.slice(0, 60)); source = source.replace(from, to); };

const start = source.indexOf('const cases = [');
const end = source.indexOf('].map((c) => ({ ...c, q }));', start);
if (start < 0 || end < 0) throw new Error('scenario anchors absent');
const CONFLICT = 'In California from 2021 to 2025, 8.4% of all reported serious violent crimes were committed by youth under 18.';
const RECORDED = 'Of recorded offenders in these offenses in California, 2021 to 2025, 8.4% were under 18.';
source = source.slice(0, start) + `const CONFLICT = ${JSON.stringify(CONFLICT)};
const RECORDED = ${JSON.stringify(RECORDED)};
const TOTALS = (sql) => sql.replace(/SUM\\(d\\.offender_count\\)/g, 'TOTAL(d.offender_count)');
const cases = [
  // supported: must deliver 8.4 (1,260 / 15,060) with the owned recorded-offender statement
  { id: 'retained-gc032', expect: 'answer', explain: CONFLICT, sql: RETAINED },
  { id: 'retained-gc032-recorded-wording', expect: 'answer', explain: RECORDED, sql: RETAINED },
  { id: 'retained-gc032-leaky-explanation', expect: 'answer', leaky: true, sql: RETAINED },
  { id: 'retained-gc032-leaky-title', expect: 'answer', explain: CONFLICT, title: 'summary_offender_demographics youth share', firewall: true, sql: RETAINED },
  { id: 'cross-join-form', expect: 'answer', explain: CONFLICT, sql: twoCte({ from: 'FROM youth_offenders y CROSS JOIN total_offenders t' }) },
  { id: 'join-on-1-form', expect: 'answer', explain: CONFLICT, sql: twoCte({ from: 'FROM youth_offenders y JOIN total_offenders t ON 1 = 1' }) },
  { id: 'single-select-control', expect: 'answer', explain: CONFLICT, sql: SINGLE },
  { id: 'total-aggregates-integer-100', expect: 'answer', explain: CONFLICT, sql: TOTALS(RETAINED).replace('100.0 *', '100 *') },
  { id: 'fraction-with-1.0', expect: 'answer', fraction: true, explain: CONFLICT, sql: RETAINED.replace('ROUND(100.0 * y.youth_count / t.total_count, 1)', 'ROUND(1.0 * y.youth_count / t.total_count, 3)') },
  // G32-1: previously admitted, truncating -- must now be refused
  { id: 'integer-percentage-cte', expect: 'refuse', wrong: 8, explain: CONFLICT, sql: RETAINED.replace('100.0 *', '100 *') },
  { id: 'fraction-no-coercion-cte', expect: 'refuse', wrong: 0, explain: CONFLICT, sql: RETAINED.replace('100.0 * y.youth_count / t.total_count', 'y.youth_count / t.total_count') },
  { id: 'integer-percentage-single', expect: 'refuse', wrong: 8, explain: CONFLICT, sql: SINGLE.replace('ROUND(100.0 *', 'ROUND(100 *') },
  { id: 'scale-after-division-single', expect: 'refuse', explain: CONFLICT, sql: SINGLE.replace('ROUND(100.0 * ' + YOUTH + ' / SUM(d.offender_count), 1)', 'ROUND(' + YOUTH + ' / SUM(d.offender_count) * 100.0, 1)') },
  // retained wrong-answer controls from the submission
` + source.slice(source.indexOf("  { id: 'wrong-denominator-drops-state'", start), end) + source.slice(end);

swap("add('CA', 2025, '09A', 'Unknown', 1000);", "add('CA', 2025, '09A', 'Unknown', 1000); add('CA', 2025, '09A', 'Under 18', 60);");
swap('return reply(${EXPLAIN_JSON});', 'return reply(s.explain || ${EXPLAIN_JSON});');
// A title naming an internal table makes the internal-leak firewall replace the whole explanation,
// which is what the route's post-firewall re-application exists for.
swap("title: 'Youth share of recorded offenders'", "title: s.title || 'Youth share of recorded offenders'");

const cStart = source.indexOf('  const checks = [];');
const cEnd = source.indexOf('  const gc032Delivery', cStart);
if (cStart < 0 || cEnd < 0) throw new Error('check anchors absent');
source = source.slice(0, cStart) + `  const checks = [];
  const CONFLICT_RE = /% of (?:all )?(?:reported )?serious violent crimes|crimes were committed by youth/i;
  for (const s of SCENARIOS) {
    const r = by[s.id];
    const f = figure(s.id);
    if (s.expect === 'answer') {
      const value = s.fraction ? Math.round(f.youth_share_pct * 1000) / 10 : f.youth_share_pct;
      checks.push({ name: s.id + ': row delivers ' + pct + '% = ' + youthN + ' / ' + totalN, ok: value === pct && f.youth_count === youthN && f.total_count === totalN, detail: JSON.stringify(r.rows) });
      const owned = 'Of the offenders recorded in NIBRS reports for the requested offenses in California, 2021\\u20132025, ' + pct.toFixed(1) + '% (' + youthN.toLocaleString('en-US') + ' of ' + totalN.toLocaleString('en-US') + ') had a recorded age group of Under 18.';
      checks.push({ name: s.id + ': delivered text is the owned recorded-offender statement with figure, counts, place and period',
        ok: r.explanation.includes(owned), detail: r.explanation.slice(0, 420) });
      checks.push({ name: s.id + ': no crime-share claim survives, and the unit note (with unknown ages) is present',
        ok: !CONFLICT_RE.test(r.explanation) && /offenders recorded in NIBRS reports \\\\(including offenders recorded with an unknown age\\\\), not of crimes or incidents/.test(r.explanation),
        detail: r.explanation.slice(0, 420) });
    } else {
      checks.push({ name: s.id + ': no figure delivered, never executed', ok: (r.rows || []).length === 0 && r.workerReceived.length === 0,
        detail: JSON.stringify({ rows: r.rows, worker: r.workerReceived.length }) });
    }
  }
  checks.push({ name: 'the leaky-title control really went through the firewall (safe message present)',
    ok: /The requested results are shown above\\./.test(by['retained-gc032-leaky-title'].explanation), detail: by['retained-gc032-leaky-title'].explanation.slice(0, 200) });
  checks.push({ name: 'expected figure is derived from rows: 1260 / 15060 = 8.4% (non-integral)', ok: youthN === 1260 && totalN === 15060 && pct === 8.4, detail: JSON.stringify({ youthN, totalN, pct }) });
` + source.slice(cEnd);

const mod = new Module(file, module);
mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
mod._compile(source, file);
