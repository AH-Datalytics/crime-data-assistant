import '../../scripts/offline-evidence-guard';
import {writeFileSync} from 'node:fs';
import {validateQueryContractSql} from '../../lib/query-contract-validator';
import {findNibrsSqlIssues} from '../../lib/sql-guardrails';
const before = require('./before-tree/lib/query-contract-validator.ts');
const beforeGuard = require('./before-tree/lib/sql-guardrails.ts');
const q = 'How many rapes were cleared by arrest in Illinois in 2025?';
const cases = [
 ['comma-unpinned', "SELECT SUM(b.cleared_by_arrest) AS rapes_cleared_by_arrest FROM summary_clearance_detail a, summary_clearance_detail b WHERE a.ori = b.ori AND a.year = 2025 AND b.state = 'IL' AND b.ucr_offense_code = '11A'"],
 ['join-unpinned', "SELECT SUM(b.cleared_by_arrest) AS rapes_cleared_by_arrest FROM summary_clearance_detail a JOIN summary_clearance_detail b ON a.ori = b.ori WHERE a.year = 2025 AND b.state = 'IL' AND b.ucr_offense_code = '11A'"],
 ['comma-pinned', "SELECT SUM(b.cleared_by_arrest) AS rapes_cleared_by_arrest FROM summary_clearance_detail a, summary_clearance_detail b WHERE a.ori = b.ori AND a.year = 2025 AND b.year = 2025 AND b.state = 'IL' AND b.ucr_offense_code = '11A'"],
 ['simple', "SELECT SUM(cleared_by_arrest) AS rapes_cleared_by_arrest FROM summary_clearance_detail WHERE state = 'IL' AND year = 2025 AND ucr_offense_code = '11A'"],
];
const results = cases.map(([id,sql])=>({id,sql,before:{guard:beforeGuard.findNibrsSqlIssues(sql),contract:before.validateQueryContractSql({question:q,source:'nibrs',sql})},after:{guard:findNibrsSqlIssues(sql),contract:validateQueryContractSql({question:q,source:'nibrs',sql})}}));
writeFileSync('audit/phase3-comma-alias-2026-09-28/codex-period-probe.json',JSON.stringify(results,null,2)+'\n',{flag:'wx'});
for(const r of results) console.log(JSON.stringify({id:r.id,beforeGuard:r.before.guard.fired,afterGuard:r.after.guard.fired,beforeEnforced:r.before.contract.enforced,afterEnforced:r.after.contract.enforced}));
