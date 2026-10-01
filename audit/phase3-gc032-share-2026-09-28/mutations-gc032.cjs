/*
 * GC-032: is each change point load-bearing? For each mutant, a scratch copy of the CURRENT lib (never
 * the product tree) has one change undone or loosened, then the unmodified scripts/test-gc032-share.ts
 * runs against it. Also runs the test once against the pre-change copy (lib with backup-before/ restored).
 * Windowless. Writes mutations-gc032.json beside this file (this folder only).
 *
 * Run: node audit/phase3-gc032-share-2026-09-28/mutations-gc032.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const S = 'lib/structural-semantics.ts';
const TS = 'lib/table-semantics.ts';
const RD = 'lib/result-disclosure.ts';
const MUTANTS = [
  { id: 'G0-pre-change', restore: ['structural-semantics.ts', 'table-semantics.ts', 'result-disclosure.ts'] },
  { id: 'G1-rollup-measure', file: TS, from: 'return source === table ? undefined : NIBRS_RECORDED_MEASURES[source];', to: 'return undefined;' },
  { id: 'G2-schema-alias', file: S, from: 'matchAll(/\\b(?:FROM|JOIN)\\s+(?:[A-Za-z_]\\w*\\s*\\.\\s*)?([A-Za-z_]\\w*)', to: 'matchAll(/\\b(?:FROM|JOIN)\\s+([A-Za-z_]\\w*)' },
  { id: 'G3-cte-equivalence', file: S, from: '|| twoCteShareIsTheAnswer(opts.sql, opts.source, opts.question)', to: '' },
  { id: 'G4-route-limit', file: S, from: '(?:\\s+LIMIT\\s+([1-9]\\d*))?\\s*$/i;', to: '\\s*$/i;' },
  { id: 'G5-unit-disclosure', file: RD, from: 'explanation = offenderShareUnit(explanation, opts.question, opts.sql);', to: '' },
  { id: 'G6-relabel', file: RD, from: '"$1 of recorded offenders in $2$3"', to: '"$1 of $2$3"' },
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
    for (const f of m.restore) fs.copyFileSync(path.join(__dirname, 'backup-before', f), path.join(root, 'lib', f));
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
  results.push({ id: m.id, file: m.file || 'backup-before', applied: true, exit: r.status, killed: r.status !== 0, failing, tail: out.trim().split(/\r?\n/).slice(-1)[0] });
  console.log(`${m.id.padEnd(26)} exit=${r.status} ${r.status !== 0 ? 'KILLED' : 'SURVIVED'} (${failing.length} failing) ${out.trim().split(/\r?\n/).slice(-1)[0].slice(0, 30)}`);
  fs.rmSync(root, { recursive: true, force: true });
}
fs.rmSync(WORK, { recursive: true, force: true });
fs.writeFileSync(path.join(__dirname, 'mutations-gc032.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
