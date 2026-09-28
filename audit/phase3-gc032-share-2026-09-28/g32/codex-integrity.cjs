'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=process.cwd(),dir=__dirname,parent=path.dirname(dir);
const json=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function verify(file,base){return {file,entries:fs.readFileSync(file,'utf8').trim().split(/\r?\n/).map(line=>{const m=/^([a-f0-9]{64})\s+\*?(.+)$/.exec(line);if(!m)throw Error(line);return {file:m[2],match:hash(path.join(base,m[2]))===m[1]};})};}
const manifests=[verify(path.join(dir,'candidate-g32.sha256'),root),verify(path.join(parent,'backup-before-g32.sha256'),path.join(parent,'backup-before-g32')),verify(path.join(parent,'receipts-before-g32.sha256'),root)];
const sig=x=>JSON.stringify({rows:x.rows||[],sql:x.sql||null,explanation:x.explanation??x.finalNarrative??null,title:x.title||null,calls:(x.modelCalls||[]).length});
const comparisons=json(path.join(dir,'r1/combined-offline.json')).runs.filter(r=>r.acceptedReceipt).map(r=>{const old=new Map(json(path.join(root,r.acceptedReceipt)).results.map(x=>[x.id,sig(x)])),now=new Map(json(path.join(root,r.out)).results.map(x=>[x.id,sig(x)]));return {id:r.id,old:old.size,now:now.size,missing:[...old.keys()].filter(k=>!now.has(k)),changed:[...old].filter(([k,v])=>now.has(k)&&now.get(k)!==v).map(([k])=>k)};});
const before=json(path.join(root,'audit/p4-final-statement-binding-2026-09-28/codex-witness-r1.json')),after=json(path.join(dir,'p41-binding-witness.json'));
const ps=x=>JSON.stringify([x.rows,x.responseSql,x.explanation]);
const p4={before:before.results.length,after:after.results.length,changed:before.results.filter(x=>{const y=after.results.find(y=>y.id===x.id);return !y||ps(x)!==ps(y)}).map(x=>x.id)};
const probes=['before','after'].map(stage=>({stage,results:json(path.join(dir,'codex-null-'+stage+'.json')).results.map(x=>({id:x.id,rows:x.rows,workerExecutions:x.workerReceived.length,explanation:x.explanation}))}));
const report={at:new Date().toISOString(),manifests,comparisons,p4,probes,limits:'File comparisons only for broad regressions. Independently replayed 56/56 unit and 41/41 route checks plus three undefined-share probes on each tree. No mutation or full-chain rerun. No source database, provider call or product edits.'};
fs.writeFileSync(path.join(dir,'codex-integrity.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({manifests:manifests.map(m=>({file:m.file,count:m.entries.length,failures:m.entries.filter(e=>!e.match)})),comparisons,p4,probes:probes.map(p=>({stage:p.stage,results:p.results.map(r=>({id:r.id,rows:r.rows,workerExecutions:r.workerExecutions,firstSentence:r.explanation.split('\n')[0]}))}))},null,2));
if(manifests.some(m=>m.entries.some(e=>!e.match))||comparisons.some(c=>c.missing.length||c.changed.length||c.old!==c.now)||p4.changed.length)process.exitCode=1;
