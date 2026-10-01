'use strict';
// Reuse the submitted isolated real-route harness; no product files are changed.
// Before mode loads the preserved route/db module bytes at their original module identities.
const fs = require('fs'), path = require('path'), Module = require('module');
const root = path.resolve(__dirname,'../..');
const before = process.argv.includes('--before');
const filename = path.join(__dirname,'binding-witness.cjs');
let source = fs.readFileSync(filename,'utf8');
const scenarios = [
 {id:'state-clearance',q:'How many rapes were cleared by arrest in Illinois in 2025?',sql:"SELECT SUM(cleared_by_arrest) AS rapes_cleared_by_arrest FROM summary_clearance_detail WHERE state = 'IL' AND year = 2025 AND ucr_offense_code = '11A'",expect:'observe'},
 {id:'national-clearance',q:'How many rapes were cleared by arrest nationwide in 2025?',sql:"SELECT SUM(cleared_by_arrest) AS rapes_cleared_by_arrest FROM summary_clearance_detail WHERE year = 2025 AND ucr_offense_code = '11A'",expect:'observe'},
 {id:'state-clearance-retry',q:'How many rapes were cleared by arrest in Illinois in 2025?',sql:"SELECT SUM(nonexistent_count) AS rapes_cleared_by_arrest FROM summary_clearance_detail WHERE state = 'IL' AND year = 2025 AND ucr_offense_code = '11A'",retrySql:"SELECT SUM(cleared_by_arrest) AS rapes_cleared_by_arrest FROM summary_clearance_detail WHERE state = 'IL' AND year = 2025 AND ucr_offense_code = '11A'",expect:'observe'},
];
const start=source.indexOf('const SCENARIOS = [');const end=source.indexOf('\n];',start)+3;
if(start<0||end<3)throw Error('scenario anchor missing');
source=source.slice(0,start)+'const SCENARIOS = '+JSON.stringify(scenarios)+';'+source.slice(end);
source=source.replace('const checks = assertBinding(results, expected);','const checks = []; // observation-only reviewer probes; no submitted assertions are reused');
if(before){
 const oldRead=fs.readFileSync;
 const files=['app/api/nibrs-query/route.ts','lib/nibrs-db.ts'];
 const backups=new Map(files.map(p=>[path.normalize(path.join(root,p)),oldRead(path.join(__dirname,'backup-before',p))]));
 fs.readFileSync=function(p,options){const b=typeof p==='string'?backups.get(path.normalize(p)):null;if(b){const enc=typeof options==='string'?options:options&&options.encoding;return enc?b.toString(enc):Buffer.from(b);}return oldRead.apply(this,arguments);};
}
source=source.replace("kind: 'p4-final-statement-binding-witness'",`kind: 'codex-rollup-${before?'before-route-db':'candidate'}'`);
const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(__dirname);mod._compile(source,filename);
