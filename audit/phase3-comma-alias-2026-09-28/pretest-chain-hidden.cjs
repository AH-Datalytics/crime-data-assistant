/*
 * COPY reading the `pretest` chain instead (comma-alias repair). Runs the exact `npm test` chain from package.json, in order, stopping at the first failing step as
 * `&&` does -- but with every child process windowless and without cmd.exe, because Jeff saw visible
 * terminal windows during earlier runs. PowerShell steps are NOT launched: they sit after
 * test-operation-taxonomy, which fails on the two standing baseline findings, so `npm test` never
 * reaches them either. Writes a log to the path given as the first argument.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const out = path.resolve(process.argv[2] || path.join(__dirname, 'npm-chain-hidden.log'));
const script = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts.pretest;
const steps = script.split('&&').map((s) => s.trim()).filter(Boolean);
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const log = [];
let exit = 0;
for (const step of steps) {
  const [tool, ...args] = step.split(/\s+/);
  let file; let argv;
  if (tool === 'tsx') { file = process.execPath; argv = [TSX, ...args]; }
  else if (tool === 'node') { file = process.execPath; argv = args; }
  else if (tool === 'python') { file = 'python'; argv = args; }
  else { log.push(`=== ${step}\n[not launched here: ${tool}]`); exit = exit || 1; break; }
  const r = spawnSync(file, argv, { cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  log.push(`=== ${step}\n${r.stdout || ''}${r.stderr || ''}\n=== exit ${r.status}`);
  if (r.status !== 0) { exit = r.status || 1; log.push(`=== chain stopped at: ${step}`); break; }
}
log.push(`chain exit ${exit}; steps run ${log.filter((l) => l.startsWith('=== ') && !l.startsWith('=== chain')).length} of ${steps.length}`);
fs.writeFileSync(out, log.join('\n'));
console.log(log[log.length - 1]);
process.exitCode = exit;
