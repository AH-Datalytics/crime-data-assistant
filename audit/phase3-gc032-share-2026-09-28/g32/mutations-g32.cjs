/*
 * G32 correction: is each change point load-bearing? Scratch copies of the CURRENT lib only (never the
 * product tree); the unmodified scripts/test-gc032-share.ts runs against each. H0 restores the submitted
 * (pre-correction) lib files from ../backup-before-g32. The submission's G mutants that still apply are
 * repeated against the current code. Writes mutations-g32.json in THIS folder (the submitted
 * ../mutations-gc032.json is not touched). Windowless.
 *
 * Run: node audit/phase3-gc032-share-2026-09-28/g32/mutations-g32.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const S = 'lib/structural-semantics.ts';
const TS = 'lib/table-semantics.ts';
const RD = 'lib/result-disclosure.ts';
const MUTANTS = [
  { id: 'H0-submitted-lib', restore: ['structural-semantics.ts', 'result-disclosure.ts'] },
  // G32-1
  { id: 'H1-real-division-skipped', file: S, from: 'if (!divisionIsReal(operands.numerator, operands.denominator)) return false;', to: '' },
  { id: 'H2-integer-literal-counts-as-real', file: S, from: 'const REAL_LITERAL = /^[-+]?(?:\\d+\\.\\d*|\\.\\d+|\\d+(?:\\.\\d*)?[eE][-+]?\\d+)$/;', to: 'const REAL_LITERAL = /^[-+]?\\d/;' },
  { id: 'H3-total-not-real', file: S, from: 'return total(numerator) || total(denominator);', to: 'return false;' },
  // G32-2
  { id: 'H4-model-sentence-kept', file: RD, from: '  return delivery.join("\\n\\n");', to: '  return appendSentence(explanation, delivery[1]);' },
  { id: 'H5-any-count-pair-quoted', file: RD, from: '.filter(([a, b]) => b > 0 && a >= 0 && a <= b && Math.abs((100 * a) / b - percent) <= tolerance);', to: '.filter(([a, b]) => b > 0 && a >= 0 && a < b);' },
  { id: 'H6-first-state-guessed', file: RD, from: 'const place = states.length === 1 ? stateNameForAbbr(states[0]) : null;', to: 'const place = states.length >= 1 ? stateNameForAbbr(states[0]) : null;' },
  { id: 'H7-first-group-guessed', file: RD, from: 'const group = groups.length === 1 ?', to: 'const group = groups.length >= 1 ?' },
  { id: 'H8-fraction-not-scaled', file: RD, from: 'const percent = percentScaled ? value : value * 100;', to: 'const percent = value;' },
  { id: 'H9-first-of-many-rows', file: RD, from: 'const row = rows.length === 1 ? rows[0] : null;', to: 'const row = rows[0] ?? null;' },
  // the submission's change points, repeated against the corrected code
  { id: 'G1-rollup-measure', file: TS, from: 'return source === table ? undefined : NIBRS_RECORDED_MEASURES[source];', to: 'return undefined;' },
  { id: 'G2-schema-alias', file: S, from: 'matchAll(/\\b(?:FROM|JOIN)\\s+(?:[A-Za-z_]\\w*\\s*\\.\\s*)?([A-Za-z_]\\w*)', to: 'matchAll(/\\b(?:FROM|JOIN)\\s+([A-Za-z_]\\w*)' },
  { id: 'G3-cte-equivalence', file: S, from: '|| twoCteShareIsTheAnswer(opts.sql, opts.source, opts.question)', to: '' },
  { id: 'G4-route-limit', file: S, from: '(?:\\s+LIMIT\\s+([1-9]\\d*))?\\s*$/i;', to: '\\s*$/i;' },
  { id: 'G5-unit-disclosure', file: RD, from: 'explanation = offenderShareUnit(explanation, opts.question, opts.sql, opts.rows);', to: '' },
  { id: 'G7-unknown-always', file: RD, from: `const unknown = /'unknown'/i.test(sql) ? "" : `, to: 'const unknown = ' },
  { id: 'G8-one-extra-conjunct', file: S, from: 'x!.normal.length === y!.normal.length + 1', to: 'x!.normal.length >= y!.normal.length + 1' },
  { id: 'G9-single-row-keywords', file: S, from: '/\\b(?:GROUP|HAVING|ORDER|LIMIT|UNION|INTERSECT|EXCEPT|JOIN|WINDOW|SELECT|OR)\\b/i.test(bare)', to: '/\\b(?:OR)\\b/i.test(bare)' },
  { id: 'G10-outer-only-outputs', file: S, from: 'if (!body || body.output !== col.toLowerCase()) { failed = true; return whole; }', to: 'if (!body) { failed = true; return whole; }' },
  { id: 'G11-same-measure', file: S, from: 'a.table !== b.table || a.fn !== b.fn || a.measure !== b.measure', to: 'a.fn !== b.fn' },
];
const WORK = path.join(__dirname, 'mutation-trees');
const results = [];
for (const m of MUTANTS) {
  const root = path.join(WORK, m.id);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.cpSync(path.join(REPO, 'lib'), path.join(root, 'lib'), { recursive: true });
  for (const f of ['test-gc032-share.ts', 'offline-evidence-guard.ts']) fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(root, 'scripts', f));
  if (m.restore) {
    for (const f of m.restore) fs.copyFileSync(path.join(__dirname, '..', 'backup-before-g32', f), path.join(root, 'lib', f));
  } else {
    const target = path.join(root, m.file);
    const text = fs.readFileSync(target, 'utf8');
    const occurrences = text.split(m.from).length - 1;
    if (occurrences !== 1) { results.push({ ...m, applied: false, occurrences }); console.log(`${m.id} NOT APPLIED (${occurrences})`); fs.rmSync(root, { recursive: true, force: true }); continue; }
    fs.writeFileSync(target, text.replace(m.from, m.to));
  }
  const r = spawnSync(process.execPath, [TSX, path.join(root, 'scripts', 'test-gc032-share.ts')], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const failing = out.split(/\r?\n/).filter((l) => /^\s*FAIL\s/.test(l)).map((l) => l.trim());
  const tail = out.trim().split(/\r?\n/).slice(-1)[0];
  // A crash is not a catch: only a completed run with FAIL lines counts as killed.
  const killed = failing.length > 0 && /passed; offline guard/.test(tail);
  results.push({ id: m.id, file: m.file || 'backup-before-g32', applied: true, exit: r.status, killed, failing, tail });
  console.log(`${m.id.padEnd(34)} ${killed ? 'KILLED' : 'SURVIVED'} (${failing.length} failing) ${tail.slice(0, 40)}`);
  fs.rmSync(root, { recursive: true, force: true });
}
fs.rmSync(WORK, { recursive: true, force: true });
fs.writeFileSync(path.join(__dirname, 'mutations-g32.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
if (results.some((r) => !r.applied || !r.killed)) process.exitCode = 1;
