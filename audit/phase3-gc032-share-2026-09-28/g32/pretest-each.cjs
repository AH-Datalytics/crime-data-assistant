/*
 * The `pretest` chain stops at test-structural-route-placement, so the suites after it never run.
 * This runs EVERY pretest step on its own, windowless, once against the current tree and once against
 * the pre-change copy (before-tree/, whose scripts/ is a copy of the current scripts/), with cwd the
 * repository in both, and records each exit and FAIL count. Python steps run once (current tree).
 *
 * Run: node audit/phase3-comma-alias-2026-09-28/pretest-each.cjs  -> writes pretest-each.json beside this file
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const BEFORE = path.join(__dirname, 'before-tree');
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const steps = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts.pretest
  .split('&&').map((s) => s.trim()).filter(Boolean);
if (!fs.existsSync(path.join(BEFORE, 'scripts', 'test-nibrs-rollup-router.ts'))) {
  fs.cpSync(path.join(REPO, 'scripts'), path.join(BEFORE, 'scripts'), { recursive: true, force: false, errorOnExist: false, filter: (src) => !/\.log$/i.test(src) });
}
function run(tree, step) {
  const [tool, ...args] = step.split(/\s+/);
  if (tool === 'npm') return { skipped: 'npm script (runs its own chain)' };
  const rel = args.find((a) => /^scripts[\\/]/.test(a));
  const argv = args.map((a) => (a === rel ? path.join(tree, rel) : a));
  let file;
  if (tool === 'tsx') { file = process.execPath; argv.unshift(TSX); }
  else if (tool === 'node') file = process.execPath;
  else if (tool === 'python') { if (tree !== REPO) return { skipped: 'python runs once' }; file = 'python'; }
  else return { skipped: tool };
  const r = spawnSync(file, argv, { cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const failLines = out.split(/\r?\n/).filter((l) => /^\s*FAIL\b/.test(l)).map((l) => l.trim());
  return { exit: r.status, failLines, tail: out.trim().split(/\r?\n/).slice(-1)[0] };
}
const results = [];
for (const step of steps) {
  const after = run(REPO, step);
  const before = run(BEFORE, step);
  results.push({ step, after, before });
  const fmt = (x) => (x.skipped ? `skip(${x.skipped})` : `exit=${x.exit} fails=${x.failLines.length}`);
  console.log(`${step.padEnd(64).slice(0, 64)} after ${fmt(after).padEnd(22)} before ${fmt(before)}`);
}
fs.writeFileSync(path.join(__dirname, 'pretest-each.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
