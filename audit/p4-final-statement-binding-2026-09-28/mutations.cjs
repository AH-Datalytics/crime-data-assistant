/*
 * Mutations for the P4.1 final-statement binding. Each breaks one decision and must turn every
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

const MUTATIONS = [
  { id: 'B1-initial-bypasses-binding', file: ROUTE, what: 'the initial path executes the text without its bound authority',
    from: '      const result = await executeBoundNibrsStatement(finalCheck.authority);', to: '      const result = await executeWithTimeout(sql);', checks: [SUITE, witness('B1')] },
  { id: 'B2-retry-bypasses-binding', file: ROUTE, what: 'the retry path executes the text without its bound authority',
    from: '              const retryResult = await executeBoundNibrsStatement(retryFinalCheck.authority);', to: '              const retryResult = await executeWithTimeout(retrySql);', checks: [SUITE, witness('B2')] },
  { id: 'B3-worker-skips-identity', file: WORKER, what: 'the worker prepares whatever it receives, ignoring the identity',
    from: 'if (expectedSha256 && sql && crypto.createHash("sha256").update(sql, "utf8").digest("hex") !== expectedSha256) {', to: 'if (false) {', checks: [SUITE, witness('B3')] },
  { id: 'B4-executor-skips-authority', file: DB, what: 'the bound executor accepts an unissued authority',
    from: '  if (issue) return Promise.reject(new Error(`NIBRS execution refused: ${issue}`));', to: '  void issue;', checks: [SUITE] },
  { id: 'B5-refusal-issues-authority', file: BIND, what: 'a contract failure still issues an authority',
    from: '    if (failure) return { ok: false, stage: "contract", reason: failure, sql: contract.sql, contract };', to: '    void failure;', checks: [SUITE] },
  { id: 'B6-rewrite-not-rechecked', file: BIND, what: 'a statement rewritten by a check is issued without passing the checks unchanged',
    from: '    if (checked === candidate) {', to: '    if (true) {', checks: [SUITE] },
  { id: 'B7-check-before-schema', file: ROUTE, what: 'the initial final check runs on the text before schema correction',
    from: '        sql, path: "model-initial",', to: '        sql: plannedSql, path: "model-initial",', checks: [witness('B7')] },
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
fs.writeFileSync(path.join(__dirname, 'mutations.json'), JSON.stringify(summary, null, 1));
console.log(`\n${summary.red}/${summary.total} red; all restored: ${summary.allRestored}`);
