#!/usr/bin/env node
'use strict';
/**
 * Supervised recovery: the SHR agency-type evidence only, with no re-import and no upstream download.
 *
 * For the known 2026-09-16 failure the imported rows are already in place. Under Jeff's approved
 * classification policy (2026-09-30) the recovery does NOT run the old normalizer: it builds the
 * evidence-backed agency-type tables the SHR city ranking reads (`scripts/build-shr-agency-type-evidence.ts`,
 * which writes only `shr_agency_type_binding`/`shr_agency_type_evidence` and reads nibrs.db read-only) and
 * refreshes statistics (`ANALYZE`) -- through the same pinned runtime, preflight, deadline and status record
 * as the monthly importer (scripts/ops/shr-post-import-runtime.js, `shrTypeRecoverySteps`). It does not write
 * `incidents`, rebuild state_population or call the FBI CDE API. Running it is a production data write and
 * needs its own owner approval.
 *
 *   SHR_UPDATE_DEADLINE_MS=<ms> SHR_RELEASE_LINK=<release link> node scripts/ops/shr-post-import-recover.js
 *
 * `--preflight-only` checks the runtime and exits without dispatching any step.
 */
const postImport = require('./shr-post-import-runtime');

function main() {
  const deadline = postImport.createDeadline(Number(process.env.SHR_UPDATE_DEADLINE_MS) || 30 * 60 * 1000);
  const runtime = postImport.resolveRuntime();
  const steps = postImport.shrTypeRecoverySteps({
    shrDbPath: process.env.SHR_DB_PATH || '/opt/nibrs/shr.db',
    nibrsDbPath: process.env.NIBRS_DB_PATH || '/opt/nibrs/nibrs.db',
    rtciDbPath: process.env.RTCI_DB_PATH || '/opt/nibrs/shared/crime_data.db',
  });
  postImport.preflight(runtime, steps, deadline);
  console.log(`Post-import runtime: ${runtime.release} (Node ${process.version}); ${deadline.remainingMs()} ms left; steps: ${steps.map((s) => s.name).join(', ')}`);
  if (process.argv.includes('--preflight-only')) { console.log('Preflight passed; no step dispatched.'); return; }
  postImport.runSteps(runtime, steps, deadline);
  console.log('Type recovery steps complete.');
}

try { main(); } catch (e) { console.error(e && e.message ? e.message : e); process.exit(1); }
