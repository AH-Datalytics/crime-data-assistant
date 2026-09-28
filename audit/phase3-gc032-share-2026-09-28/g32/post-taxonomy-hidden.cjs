/*
 * Runs the tsx suites that sit AFTER test-operation-taxonomy in the `npm test` chain, one by one and
 * windowless, because the chain stops at the taxonomy baseline and never reaches them. PowerShell
 * steps are not launched. Then runs the type check windowless and counts type-error lines by area.
 * Writes post-taxonomy-hidden.log beside this file.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const steps = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts.test
  .split('&&').map((s) => s.trim()).filter(Boolean);
const after = steps.slice(steps.findIndex((s) => s.includes('test-operation-taxonomy')) + 1);
const log = [];
const summary = [];
for (const step of after) {
  const [tool, file] = step.split(/\s+/);
  if (tool !== 'tsx') { summary.push(`${step} -> not launched (${tool})`); continue; }
  const r = spawnSync(process.execPath, [TSX, file], { cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const fails = out.split(/\r?\n/).filter((l) => /^\s*FAIL\s/.test(l)).length;
  log.push(`=== ${step}\n${out}\n=== exit ${r.status}`);
  summary.push(`${file} -> exit ${r.status}, FAIL lines ${fails}; tail: ${out.trim().split(/\r?\n/).slice(-1)[0]}`);
}
const TSC = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
const t = spawnSync(process.execPath, [TSC, '--noEmit', '-p', '.'], { cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const lines = `${t.stdout || ''}${t.stderr || ''}`.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
const inProduct = lines.filter((l) => /^(app|lib|scripts)[\\/]/.test(l));
summary.push(`tsc -> exit ${t.status}; error lines ${lines.length}; under app/lib/scripts ${inProduct.length}`);
if (inProduct.length) summary.push(...inProduct.slice(0, 20));
log.push('=== summary', ...summary);
fs.writeFileSync(path.join(__dirname, 'post-taxonomy-hidden.log'), log.join('\n'));
console.log(summary.join('\n'));
