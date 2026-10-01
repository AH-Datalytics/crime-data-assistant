'use strict';
// Reuse the accepted isolated route fixture. Only the fixture and scripted replies change in memory.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const file=path.join(__dirname,'../route-witness-gc032.cjs');
let source=fs.readFileSync(file,'utf8');
const start=source.indexOf('const cases = ['),end=source.indexOf('].map((c) => ({ ...c, q }));',start);
if(start<0||end<0)throw Error('scenario anchors absent');
source=source.slice(0,start)+`const cases = [
 {id:'retained-gc032',expect:'answer',sql:RETAINED},
 {id:'single-select-zero-denominator',expect:'answer',sql:SINGLE},
 {id:'total-zero-denominator',expect:'answer',sql:RETAINED.replace(/SUM\\(d\\.offender_count\\)/g,'TOTAL(d.offender_count)')},
`+source.slice(end);
const anchor="add('CA', 2025, '09A', 'Unknown', 1000);";
if(!source.includes(anchor))throw Error('fixture anchor absent');
source=source.replace(anchor,anchor+" for (const r of rows.nibrs.summary_offender_demographics) { if (r.state === 'CA' && r.year >= 2021 && r.year <= 2025 && ['09A','11A','11B','11C','120','13A'].includes(r.ucr_offense_code)) r.offender_count = 0; }");
source=source.replace("const EXPLAIN = 'Youth under 18 accounted for 8.0% of serious violent crimes in California from 2021 to 2025.';", "const EXPLAIN = 'The percentage cannot be calculated because there are no recorded offenders in the requested scope.';");
const cs=source.indexOf('  const checks = [];'),ce=source.indexOf('  const gc032Delivery',cs);
if(cs<0||ce<0)throw Error('check anchors absent');
source=source.slice(0,cs)+`  const checks = SCENARIOS.map(s => ({name:s.id + ': undefined share is not narrated as zero percent',ok:!by[s.id].explanation.includes('0.0%'),detail:JSON.stringify({rows:by[s.id].rows,explanation:by[s.id].explanation,workerExecutions:by[s.id].workerReceived.length})}));
`+source.slice(ce);
const mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(path.dirname(file));mod._compile(source,file);
