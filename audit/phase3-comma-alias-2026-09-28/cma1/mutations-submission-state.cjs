/*
 * SUBMISSION-STATE REPRODUCTION (lib = before-cma1-tree, test = backup-before 38-check version) of ../mutations.cjs, whose original receipt was overwritten. Is each of the five comma-item call sites load-bearing? For each, a scratch copy of the CURRENT lib
 * (never the product tree) has that one call fed an empty string, then the unmodified
 * scripts/test-comma-from-items.ts runs against the copy. A mutant that still passes means the test
 * cannot see that call site. Windowless; no product file is written.
 *
 * Run: node audit/phase3-comma-alias-2026-09-28/mutations.cjs  -> writes mutations.json beside this file
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MUTANTS = [
  { id: 'M1-alias-rule', file: 'lib/sql-guardrails.ts', from: 'for (const item of commaFromItems(sql)) {', to: 'for (const item of commaFromItems("")) {' },
  { id: 'M2-table-list', file: 'lib/table-allowlist.ts', from: 'for (const item of commaFromItems(cleaned)) {', to: 'for (const item of commaFromItems("")) {' },
  { id: 'M3-rollup-family', file: 'lib/nibrs-rollup-router.ts', from: '...commaFromItems(cleaned).filter(', to: '...commaFromItems("").filter(' },
  { id: 'M4-router-guard', file: 'lib/nibrs-rollup-router.ts', from: 'if (commaFromItems(stripSqlStrings(sql)).some(', to: 'if (commaFromItems("").some(' },
  { id: 'M5-lineage', file: 'lib/sql-lineage.ts', from: 'for (const item of commaFromItems(query)) {', to: 'for (const item of commaFromItems("")) {' },
];
const results = [];
for (const m of MUTANTS) {
  const root = path.join(__dirname, 'mutation-trees', m.id);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.cpSync(path.join(__dirname, 'before-cma1-tree', 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'backup-before', 'test-comma-from-items.ts'), path.join(root, 'scripts', 'test-comma-from-items.ts')); fs.copyFileSync(path.join(REPO, 'scripts', 'offline-evidence-guard.ts'), path.join(root, 'scripts', 'offline-evidence-guard.ts'));
  const target = path.join(root, m.file);
  const text = fs.readFileSync(target, 'utf8');
  const occurrences = text.split(m.from).length - 1;
  if (occurrences !== 1) { results.push({ ...m, applied: false, occurrences }); continue; }
  fs.writeFileSync(target, text.replace(m.from, m.to));
  const r = spawnSync(process.execPath, [TSX, path.join(root, 'scripts', 'test-comma-from-items.ts')], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const failing = out.split(/\r?\n/).filter((l) => /^\s*FAIL\s/.test(l)).map((l) => l.trim());
  results.push({ id: m.id, file: m.file, applied: true, exit: r.status, killed: r.status !== 0, failing, tail: out.trim().split(/\r?\n/).slice(-1)[0] });
  console.log(`${m.id.padEnd(18)} exit=${r.status} ${r.status !== 0 ? 'KILLED' : 'SURVIVED'} (${failing.length} failing)`);
  fs.rmSync(root, { recursive: true, force: true });
}
fs.rmSync(path.join(__dirname, 'mutation-trees'), { recursive: true, force: true });
fs.writeFileSync(path.join(__dirname, 'mutations-submission-state.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
if (results.some((r) => !r.applied || !r.killed)) process.exitCode = 1;
