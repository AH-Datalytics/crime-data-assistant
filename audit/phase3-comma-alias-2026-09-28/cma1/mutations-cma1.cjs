/*
 * CMA1: is each new call site load-bearing? For each, a scratch copy of the CURRENT lib (never the
 * product tree) gets that one change undone, then the unmodified scripts/test-comma-from-items.ts runs
 * against the copy. A surviving mutant means the test cannot see that call site. Windowless.
 *
 * Run: node audit/phase3-comma-alias-2026-09-28/cma1/mutations-cma1.cjs  -> writes mutations-cma1.json beside this file
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const R = 'lib/sql-restriction.ts';
const T = 'lib/table-allowlist.ts';
const MUTANTS = [
  { id: 'C1-occurrences', file: R, from: 'if (source.table === table.toLowerCase()) names.push(source.name);', to: 'if (false) names.push(source.name);' },
  { id: 'C2-alias-map', file: R, from: 'map.set(source.name, source.table);', to: 'void 0;' },
  { id: 'C3-table-in-scope', file: R, from: ' || commaSources(flat).some((source) => source.table === table.toLowerCase())', to: '' },
  { id: 'C4-cte-references', file: R, from: 'if (source.table !== name.toLowerCase()) continue;', to: 'continue;' },
  { id: 'C5-unquote', file: R, from: '(_m, a, b, c) => a ?? b ?? c)', to: '(m) => m)' },
  { id: 'C6-stop-at-join', file: T, from: 'EXCEPT|SELECT|FROM|VALUES)\\b/i;', to: 'EXCEPT|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|NATURAL|ON|USING|SELECT|FROM|VALUES)\\b/i;' },
  { id: 'C7-subquery-close-paren', file: T, from: 'item.slice(close + 1).match(COMMA_SUBQUERY_ALIAS)', to: 'item.slice(item.lastIndexOf(")") + 1).match(COMMA_SUBQUERY_ALIAS)' },
];
const WORK = path.join(__dirname, 'mutation-trees');
const results = [];
for (const m of MUTANTS) {
  const root = path.join(WORK, m.id);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.cpSync(path.join(REPO, 'lib'), path.join(root, 'lib'), { recursive: true });
  for (const f of ['test-comma-from-items.ts', 'offline-evidence-guard.ts']) fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(root, 'scripts', f));
  const target = path.join(root, m.file);
  const text = fs.readFileSync(target, 'utf8');
  const occurrences = text.split(m.from).length - 1;
  if (occurrences !== 1) { results.push({ ...m, applied: false, occurrences }); console.log(`${m.id} NOT APPLIED (${occurrences})`); continue; }
  fs.writeFileSync(target, text.replace(m.from, m.to));
  const r = spawnSync(process.execPath, [TSX, path.join(root, 'scripts', 'test-comma-from-items.ts')], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const failing = out.split(/\r?\n/).filter((l) => /^\s*FAIL\s/.test(l)).map((l) => l.trim());
  results.push({ id: m.id, file: m.file, applied: true, exit: r.status, killed: r.status !== 0, failing, tail: out.trim().split(/\r?\n/).slice(-1)[0] });
  console.log(`${m.id.padEnd(24)} exit=${r.status} ${r.status !== 0 ? 'KILLED' : 'SURVIVED'} (${failing.length} failing)`);
  fs.rmSync(root, { recursive: true, force: true });
}
fs.rmSync(WORK, { recursive: true, force: true });
fs.writeFileSync(path.join(__dirname, 'mutations-cma1.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
if (results.some((r) => !r.applied || !r.killed)) process.exitCode = 1;
