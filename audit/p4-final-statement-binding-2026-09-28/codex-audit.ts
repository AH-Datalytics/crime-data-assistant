import '../../scripts/offline-evidence-guard';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { validateQueryContractSql, queryContractFailureMessage } from '../../lib/query-contract-validator';
import { optimizeNibrsSql } from '../../lib/nibrs-sql-optimizer';
const dir='audit/p4-final-statement-binding-2026-09-28';
const read=(p:string)=>readFileSync(p,'utf8');
const json=(p:string)=>JSON.parse(read(p));
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
function verify(file:string,base:string){return read(file).trim().split(/\r?\n/).map(l=>{const m=/^([a-f0-9]{64})\s+\*?(.+)$/.exec(l)!;const p=m[2].replace(/^\.\//,'');return {path:p,expected:m[1],actual:hash(join(base,p)),match:hash(join(base,p))===m[1]};});}
const candidate=verify(`${dir}/pre-mutation.sha256`,'.');
const backups=verify(`${dir}/backup-before.sha256`,`${dir}/backup-before`);
const before=json(`${dir}/codex-rollup-before.json`),after=json(`${dir}/codex-rollup-after.json`);
const fixture=json('audit/model-comparison-offline-2026-09-19/fixtures2.json').fixtureRows.nibrs.summary_clearance_detail;
const sum=(state?:string)=>fixture.filter((r:any)=>r.year===2025&&r.ucr_offense_code==='11A'&&(!state||r.state===state)).reduce((n:number,r:any)=>n+r.cleared_by_arrest,0);
const cases=before.results.map((r:any)=>{
 const a=after.results.find((x:any)=>x.id===r.id);const original=r.modelSql.at(-1)+' LIMIT 1000';const planned=optimizeNibrsSql(original,true);
 const check=(sql:string)=>{const c=validateQueryContractSql({question:r.question,source:'nibrs',sql});return {sql:c.sql,enforced:c.enforced,warnings:c.warnings,failure:queryContractFailureMessage(c)};};
 return {id:r.id,question:r.question,independentFixtureExpected:r.id==='national-clearance'?sum():sum('IL'),beforeRows:r.rows,afterRows:a.rows,beforeSql:r.responseSql,afterExplanation:a.explanation,beforeLaunches:r.workerLaunches,afterLaunches:a.workerLaunches,originalCheck:check(original),plannedCheck:check(planned)};
});
const unsafeSql="SELECT SUM(offense_count) AS rapes_cleared_by_arrest FROM summary_state_monthly WHERE state = 'IL' AND year = 2025 AND ucr_offense_code = '11A' LIMIT 1000";
const unsafe=validateQueryContractSql({question:cases[0].question,source:'nibrs',sql:unsafeSql});
const comparisons=json(`${dir}/combined-offline.json`).runs.filter((r:any)=>r.acceptedReceipt).map((r:any)=>{
 const a=json(r.acceptedReceipt),b=json(r.out);
 const sig=(x:any)=>JSON.stringify({rows:x.rows||[],sql:x.sql||null,explanation:x.explanation??x.finalNarrative??null,title:x.title||null,calls:(x.modelCalls||[]).length});
 const old=new Map(a.results.map((x:any)=>[x.id,sig(x)])),now=new Map(b.results.map((x:any)=>[x.id,sig(x)]));
 return {id:r.id,old:old.size,now:now.size,missing:[...old.keys()].filter(k=>!now.has(k)),changed:[...old].filter(([k,v])=>now.has(k)&&now.get(k)!==v).map(([k])=>k)};
});
const report={at:new Date().toISOString(),candidate,backups,cases,unsafeTableControl:{sql:unsafeSql,enforced:unsafe.enforced,failure:queryContractFailureMessage(unsafe)},comparisons,
 baselineLimit:'Pre-change route/db module bytes loaded in memory at their original identities; current worker executes legacy no-hash calls, whose prior behavior is preserved. Synthetic rows; not production qualification.'};
writeFileSync(`${dir}/codex-audit.json`,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report,null,2));
if(candidate.some(x=>!x.match)||backups.some(x=>!x.match))process.exitCode=1;
