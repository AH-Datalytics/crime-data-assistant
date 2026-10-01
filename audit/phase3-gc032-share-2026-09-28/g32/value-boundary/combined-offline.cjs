/*
 * COPY for the comma-alias repair regression check (copied from audit/p4-final-statement-binding-2026-09-28/r1-combined-offline.cjs): the same runner as audit/phase3-closeout-2026-09-27/combined-offline.cjs, writing
 * its outputs beside this file so the accepted Phase 3 receipts are not overwritten.
 *
 * The combined offline check of candidate C plus the CR1 repair (Codex P3.3 continuation ruling,
 * part C). No new evaluator: it re-runs the EXISTING witnesses against the one identified tree, each
 * windowless in its own process, and compares every delivered result with the receipt Codex accepted
 * for that batch (rows, SQL, explanation, title, model calls).
 *
 *   GC-084/098  audit/phase3-gc084-gc098-2026-09-26/delivery-witness.cjs  vs witness-correction.json (accepted :22534)
 *   GC-057      audit/phase3-gc057-2026-09-26/delivery-witness.cjs        vs witness-candidate.json  (accepted :22844)
 *   GC-080      audit/phase3-gc080-2026-09-26/owned-count-witness.cjs     vs witness-owned.json      (unchanged at :24494)
 *   GC-080      audit/phase3-gc080-2026-09-26/period-probes.cjs           vs period-probes-numeric.json (accepted :24494)
 *   CR1         audit/phase3-closeout-2026-09-27/cr1-witness.ts and cr1-route.cjs
 *   controls    audit/phase3-closeout-2026-09-27/controls-route.cjs (ten clarification/refusal controls, GC-064, GC-070 clean)
 * GC-003/004 has no route witness; its accepted evidence is its suites, which run in the npm chain.
 * Existing suites run separately through npm-chain-hidden.cjs and post-taxonomy-hidden.cjs.
 * Writes combined/*.json and combined-offline.json. No PowerShell; no source, provider or network.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const OUT = path.join(__dirname, 'r1', 'combined');
fs.mkdirSync(OUT, { recursive: true });
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const RUNS = [
  { id: 'GC-084/098', cmd: ['audit/phase3-gc084-gc098-2026-09-26/delivery-witness.cjs'], out: 'gc084-gc098.json', accepted: 'audit/phase3-gc084-gc098-2026-09-26/witness-correction.json' },
  { id: 'GC-057', cmd: ['audit/phase3-gc057-2026-09-26/delivery-witness.cjs'], out: 'gc057.json', accepted: 'audit/phase3-gc057-2026-09-26/witness-candidate.json' },
  { id: 'GC-080 owned count', cmd: ['audit/phase3-gc080-2026-09-26/owned-count-witness.cjs'], out: 'gc080-owned.json', accepted: 'audit/phase3-gc080-2026-09-26/witness-owned.json' },
  { id: 'GC-080 periods', cmd: ['audit/phase3-gc080-2026-09-26/period-probes.cjs'], out: 'gc080-periods.json', accepted: 'audit/phase3-gc080-2026-09-26/period-probes-numeric.json' },
  { id: 'CR1 route decision', cmd: [TSX, 'audit/phase3-closeout-2026-09-27/cr1-witness.ts'], out: 'cr1-witness.json', accepted: null },
  { id: 'CR1 real route', cmd: ['audit/phase3-closeout-2026-09-27/cr1-route.cjs'], out: 'cr1-route.json', accepted: null },
  { id: 'controls', cmd: ['audit/phase3-closeout-2026-09-27/controls-route.cjs'], out: 'controls-route.json', accepted: null },
];
const sig = (r) => JSON.stringify({ rows: r.rows || [], sql: r.sql || null, explanation: r.explanation ?? r.finalNarrative ?? null, title: r.title || null, calls: (r.modelCalls || []).length });
const summary = [];
for (const run of RUNS) {
  const outPath = path.join(OUT, run.out);
  const r = spawnSync(process.execPath, [...run.cmd, '--out', outPath, '--assert'], { cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  let checks = null; let changed = null; let compared = null;
  try {
    const w = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    checks = w.checks && typeof w.checks.passed === 'number' ? `${w.checks.passed}/${w.checks.passed + w.checks.failed}`
      : Array.isArray(w.checks) ? `${w.checks.filter((c) => c.ok).length}/${w.checks.length}` : null;
    if (run.accepted && fs.existsSync(path.join(REPO, run.accepted))) {
      const a = JSON.parse(fs.readFileSync(path.join(REPO, run.accepted), 'utf8'));
      const before = new Map((a.results || []).map((x) => [x.id, sig(x)]));
      const now = (w.results || []).filter((x) => before.has(x.id));
      compared = now.length;
      changed = now.filter((x) => before.get(x.id) !== sig(x)).map((x) => x.id);
    }
  } catch (e) { checks = `unreadable: ${e.message}`; }
  const row = { id: run.id, exit: r.status, checks, acceptedReceipt: run.accepted, comparedWithAccepted: compared, changedFromAccepted: changed, out: path.relative(REPO, outPath).split(path.sep).join('/') };
  summary.push(row);
  console.log(`${run.id.padEnd(20)} exit=${r.status} checks=${checks}${compared !== null ? ` vs accepted: ${compared - changed.length}/${compared} identical${changed.length ? ` CHANGED ${changed.join(',')}` : ''}` : ''}`);
}
fs.writeFileSync(path.join(__dirname, 'r1', 'combined-offline.json'), JSON.stringify({ kind: 'phase3-closeout-combined-offline', at: new Date().toISOString(), runs: summary }, null, 1));
if (summary.some((s) => s.exit !== 0)) process.exitCode = 1;
