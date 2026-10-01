import '../../../scripts/offline-evidence-guard';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {validateQueryContractSql} from '../../../lib/query-contract-validator';
const root=process.cwd(),dir=resolve('audit/phase3-comma-alias-2026-09-28/cma1');
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const json=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
function verify(file:string){return readFileSync(join(dir,file),'utf8').trim().split(/\r?\n/).map(line=>{const m=/^([a-f0-9]{64})\s+\*?(.+)$/.exec(line)!;return {file:m[2],match:hash(join(root,m[2]))===m[1]};});}
const manifests=['candidate-cma1.sha256','codex-receipts-before.sha256','submitted-receipts.sha256'].map(file=>({file,entries:verify(file)}));
const q='How many rapes were cleared by arrest in Illinois in 2025?';
const base="SELECT SUM(b.cleared_by_arrest) AS rapes_cleared_by_arrest FROM summary_clearance_detail a, summary_clearance_detail b WHERE a.ori = b.ori AND a.ucr_offense_code = b.ucr_offense_code AND a.year = 2025 AND b.state = 'IL' AND b.ucr_offense_code = '11A'";
const cases:[string,string,boolean][]=[
 ['wrong second year',base+' AND b.year = 2024',true],
 ['open second year',base,true],
 ['requested second year',base+' AND b.year = 2025',false],
 ['tautology reopens year',base+' AND (b.year = 2025 OR 1 = 1)',true],
 ['scalar year mention is not a pin',base.replace('SUM(b.cleared_by_arrest)','SUM(b.cleared_by_arrest) + (SELECT 0 WHERE 2025 = 2025)'),true],
 ['unused pinned CTE cannot pin used comma CTE',"WITH pin AS (SELECT SUM(cleared_by_arrest) c FROM summary_clearance_detail WHERE year = 2025), y AS (SELECT 1 n), t AS (SELECT SUM(cleared_by_arrest) c FROM summary_clearance_detail WHERE state = 'IL' AND ucr_offense_code = '11A') SELECT t.c AS rapes_cleared_by_arrest FROM y, t",true],
];
const probes=cases.map(([name,sql,expected])=>{const r=validateQueryContractSql({question:q,source:'nibrs',sql});const period=r.enforced.includes('contract-single-year-temporal-scope');return {name,sql,expectedPeriodRefusal:expected,periodRefusal:period,enforced:r.enforced,pass:period===expected};});
const sig=(x:any)=>JSON.stringify({rows:x.rows||[],sql:x.sql||null,explanation:x.explanation??x.finalNarrative??null,title:x.title||null,calls:(x.modelCalls||[]).length});
const comparisons=json(join(dir,'r1/combined-offline.json')).runs.filter((r:any)=>r.acceptedReceipt).map((r:any)=>{const old=new Map(json(join(root,r.acceptedReceipt)).results.map((x:any)=>[x.id,sig(x)])),now=new Map(json(join(root,r.out)).results.map((x:any)=>[x.id,sig(x)]));return {id:r.id,old:old.size,now:now.size,missing:[...old.keys()].filter(k=>!now.has(k)),changed:[...old].filter(([k,v])=>now.has(k)&&now.get(k)!==v).map(([k])=>k)};});
const p4Before=json(resolve('audit/p4-final-statement-binding-2026-09-28/codex-witness-r1.json'));
const p4After=json(join(dir,'p41-binding-witness.json'));
const p4Sig=(x:any)=>JSON.stringify([x.rows,x.responseSql,x.explanation]);
const p4Changed=p4Before.results.filter((x:any)=>{const after=p4After.results.find((y:any)=>y.id===x.id);return !after||p4Sig(x)!==p4Sig(after);}).map((x:any)=>x.id);
const report={at:new Date().toISOString(),manifests,probes,comparisons,p4:{before:p4Before.results.length,after:p4After.results.length,changed:p4Changed},limit:'Pure contract probes and saved-output comparison; broad suites and mutations not rerun.'};
writeFileSync(join(dir,'codex-cma1-review.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report,null,2));
if(manifests.some(m=>m.entries.some(e=>!e.match))||probes.some(p=>!p.pass)||comparisons.some((c:any)=>c.missing.length||c.changed.length||c.old!==c.now)||p4Changed.length)process.exitCode=1;
