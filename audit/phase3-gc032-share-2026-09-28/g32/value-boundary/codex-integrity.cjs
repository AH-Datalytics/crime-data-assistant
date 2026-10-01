'use strict';
// Read-only manifest and saved-output comparisons. No product imports or source database access.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=process.cwd(),dir=__dirname,parent=path.dirname(dir);
const json=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function verify(file,base,exclude=[]){return {file,entries:fs.readFileSync(file,'utf8').trim().split(/\r?\n/).map(line=>{const m=/^([a-f0-9]{64})\s+\*?(.+)$/.exec(line);if(!m)throw Error(line);return {file:m[2],expected:m[1]};}).filter(e=>!exclude.includes(e.file)).map(e=>({...e,match:hash(path.join(base,e.file))===e.expected}))};}
const manifests=[verify(path.join(dir,'candidate-value.sha256'),root),verify(path.join(dir,'backup-before.sha256'),path.join(dir,'backup-before')),verify(path.join(dir,'receipts-before.sha256'),root),verify(path.join(parent,'candidate-g32.sha256'),root,['lib/result-disclosure.ts','scripts/test-gc032-share.ts'])];
const sig=x=>JSON.stringify({rows:x.rows||[],sql:x.sql||null,explanation:x.explanation??x.finalNarrative??null,title:x.title||null,calls:(x.modelCalls||[]).length});
const comparisons=json(path.join(dir,'r1/combined-offline.json')).runs.filter(r=>r.acceptedReceipt).map(r=>{const old=new Map(json(path.join(root,r.acceptedReceipt)).results.map(x=>[x.id,sig(x)])),now=new Map(json(path.join(root,r.out)).results.map(x=>[x.id,sig(x)]));return {id:r.id,old:old.size,now:now.size,missing:[...old.keys()].filter(k=>!now.has(k)),changed:[...old].filter(([k,v])=>now.has(k)&&now.get(k)!==v).map(([k])=>k)};});
const before=json(path.join(root,'audit/p4-final-statement-binding-2026-09-28/codex-witness-r1.json')),after=json(path.join(dir,'p41-binding-witness.json'));
const ps=x=>JSON.stringify([x.rows,x.responseSql,x.explanation]);
const p4={before:before.results.length,after:after.results.length,changed:before.results.filter(x=>{const y=after.results.find(y=>y.id===x.id);return !y||ps(x)!==ps(y)}).map(x=>x.id)};
const observations=['unavailable','zero','positive'].map(mode=>{const r=json(path.join(dir,'codex-'+mode+'.json'));return {mode,checks:r.checks,results:r.results.map(x=>({id:x.id,rows:x.rows,workerExecutions:x.workerReceived.length,firstSentence:x.explanation.split('\n')[0],numericPercentClaim:/\d(?:\.\d+)?\s*%/.test(x.explanation)}))};});
const noFalseZero=observations.find(x=>x.mode==='unavailable').results.every(r=>!r.numericPercentClaim&&r.rows[0]?.youth_share_pct===null&&r.firstSentence.includes('unavailable'));
const realZeroKept=observations.find(x=>x.mode==='zero').results.every(r=>r.rows[0]?.youth_share_pct===0&&r.firstSentence.includes('0.0% (0 of 13,800)'));
const report={at:new Date().toISOString(),manifests,comparisons,p4,observations,noFalseZero,realZeroKept,limits:'Independent unit 63/63 and route 18/18 unavailable, 18/18 genuine zero, 41/41 positive replay. Broad regression results compared from saved receipts, not rerun. No mutations, whole-chain rerun, product changes, source database or provider access.'};
fs.writeFileSync(path.join(dir,'codex-integrity.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({manifests:manifests.map(m=>({file:m.file,count:m.entries.length,failures:m.entries.filter(e=>!e.match)})),comparisons,p4,noFalseZero,realZeroKept},null,2));
if(manifests.some(m=>m.entries.some(e=>!e.match))||comparisons.some(c=>c.missing.length||c.changed.length||c.old!==c.now)||p4.changed.length||!noFalseZero||!realZeroKept)process.exitCode=1;
