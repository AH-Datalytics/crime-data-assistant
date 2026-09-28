/*
 * Mutations for the P4.1 R1 correction (planner rollup families in the final capability checks).
 * Derived from mutations.cjs; the binding mutations there target unchanged code and are not re-run.
 * Original header: Mutations for the P4.1 final-statement binding. Each breaks one decision and must turn every
 * listed check red; the file is restored from memory and verified by sha256 after each. Includes the
 * required "a mutation bypassing the binding makes the relevant witness fail". Windowless; no
 * PowerShell. Writes mutations.json and mutation-witness/<id>.json.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const OUTDIR = path.join(__dirname, 'mutation-witness');
fs.mkdirSync(OUTDIR, { recursive: true });
const ROUTE = 'app/api/nibrs-query/route.ts';
const DB = 'lib/nibrs-db.ts';
const WORKER = 'lib/nibrs-query-worker.js';
const BIND = 'lib/nibrs-execution-binding.ts';
const SUITE = { label: 'scripts/test-nibrs-execution-binding.ts', run: () => spawnSync(process.execPath, [TSX, 'scripts/test-nibrs-execution-binding.ts'], { cwd: REPO, encoding: 'utf8', windowsHide: true }) };
const witness = (id) => ({ label: 'binding-witness --assert', run: () => spawnSync(process.execPath, [
  'audit/p4-final-statement-binding-2026-09-28/binding-witness.cjs', '--assert', '--out', path.join(OUTDIR, `${id}.json`)], { cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }) });

const FAMILY = { label: 'scripts/test-nibrs-rollup-capability-family.ts', run: () => spawnSync(process.execPath, [TSX, 'scripts/test-nibrs-rollup-capability-family.ts'], { cwd: REPO, encoding: 'utf8', windowsHide: true }) };
const CAPS = 'lib/source-capabilities.ts';
const ROUTER = 'lib/nibrs-rollup-router.ts';
const MUTATIONS = [
  { id: 'R1-M1-rollup-family-ignored', file: CAPS, what: 'required families are checked against raw table names again (the submitted behavior)',
    from: '    const missingRequired = rule.requiresAnyTables && !hasAnyTable(families, rule.requiresAnyTables);', to: '    const missingRequired = rule.requiresAnyTables && !hasAnyTable(tables, rule.requiresAnyTables);', checks: [FAMILY, witness('R1-M1')] },
  { id: 'R1-M2-any-rollup-name-trusted', file: ROUTER, what: 'any rollup.state_/national_ name is trusted as a family, not only the router sources',
    from: '    if (!(ROLLUP_SOURCES as readonly string[]).includes(sourceTable)) continue;', to: '    void ROLLUP_SOURCES;', checks: [FAMILY] },
  { id: 'R1-M3-forbidden-rollup-allowed', file: CAPS, what: 'a forbidden family is not forbidden in its rollup form',
    from: '    const hasForbidden = rule.forbidsTables && hasForbiddenTable(families, rule.forbidsTables);', to: '    const hasForbidden = rule.forbidsTables && hasForbiddenTable(tables, rule.forbidsTables);', checks: [FAMILY] },
];

const results = [];
for (const m of MUTATIONS) {
  const file = path.join(REPO, m.file);
  const original = fs.readFileSync(file);
  const originalSha = sha(file);
  const text = original.toString('utf8');
  const n = text.split(m.from).length - 1;
  const applied = n === 1;
  const record = { id: m.id, file: m.file, what: m.what, applied, occurrences: n, checks: [] };
  if (applied) {
    try {
      fs.writeFileSync(file, text.replace(m.from, m.to));
      for (const c of m.checks) {
        const r = c.run();
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        record.checks.push({ check: c.label, exitCode: r.status, red: r.status !== 0,
          failing: out.split(/\r?\n/).filter((l) => /^\s*FAIL\s/.test(l)).slice(0, 3).map((l) => l.trim().slice(0, 200)) });
      }
    } finally { fs.writeFileSync(file, original); }
  }
  record.restored = sha(file) === originalSha;
  record.red = applied && record.checks.length > 0 && record.checks.every((c) => c.red);
  results.push(record);
  console.log(`${m.id.padEnd(30)} applied=${applied} restored=${record.restored} ${record.red ? 'RED' : 'NOT RED'} ${record.checks.map((c) => `${path.basename(c.check)}:${c.exitCode}`).join(' ')}`);
  if (!record.restored) throw new Error(`${m.file} was not restored byte-identically; stopping`);
}
const summary = { at: new Date().toISOString(), total: results.length, red: results.filter((r) => r.red).length, allRestored: results.every((r) => r.restored), results };
fs.writeFileSync(path.join(__dirname, 'r1-mutations.json'), JSON.stringify(summary, null, 1));
console.log(`\n${summary.red}/${summary.total} red; all restored: ${summary.allRestored}`);
