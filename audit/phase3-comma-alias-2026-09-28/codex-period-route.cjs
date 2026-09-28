'use strict';
// Reuse the submitted isolated real-route witness. Only scenarios and synthetic rows change in memory.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const original = path.join(__dirname, 'route-witness.cjs');
let text = fs.readFileSync(original, 'utf8');
const join = "a.ori = b.ori AND a.month = b.month AND a.ucr_offense_code = b.ucr_offense_code";
const query = `SELECT SUM(b.cleared_by_arrest) AS rapes_cleared_by_arrest FROM summary_clearance_detail a, summary_clearance_detail b WHERE ${join} AND a.year = 2025 AND b.state = 'IL' AND b.ucr_offense_code = '11A'`;
const q = 'How many rapes were cleared by arrest in Illinois in 2025?';
const cases = [
 {id:'comma-unpinned',q,sql:query},
 {id:'join-unpinned',q,sql:query.replace(' a, summary_clearance_detail b WHERE',' a JOIN summary_clearance_detail b ON 1 = 1 WHERE')},
 {id:'comma-pinned',q,sql:query+' AND b.year = 2025'},
 {id:'simple-control',q,sql:"SELECT SUM(cleared_by_arrest) AS rapes_cleared_by_arrest FROM summary_clearance_detail WHERE state = 'IL' AND year = 2025 AND ucr_offense_code = '11A'"},
];
text = text.replace(/const SCENARIOS = \[[\s\S]*?\n\];/, 'const SCENARIOS = '+JSON.stringify(cases)+';');
text = text.replace('  return rows;', `
  const baseRow = rows.nibrs.summary_clearance_detail.find(r => r.state === 'IL' && r.year === 2025 && r.ucr_offense_code === '11A');
  if (!baseRow) throw new Error('fixture row absent');
  rows.nibrs.summary_clearance_detail.push({...baseRow, year:2024, cleared_by_arrest:100});
  return rows;`);
const start = text.indexOf('  const checks = [');
const end = text.indexOf('  const out = {', start);
if(start<0||end<0)throw new Error('witness anchors absent');
text = text.slice(0,start)+'  const checks = []; const gc032Delivery = {delivered:false,retryRules:[]};\n'+text.slice(end);
const mod = new Module(original,module);
mod.filename=original; mod.paths=Module._nodeModulePaths(__dirname);
mod._compile(text,original);
