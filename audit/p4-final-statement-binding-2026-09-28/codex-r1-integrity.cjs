'use strict';
// Read-only review of submitted identities and saved regression receipts; no database or network.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dir = __dirname;
const root = path.resolve(dir, '../..');
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function verify(manifest, base) {
  return fs.readFileSync(path.join(dir, manifest), 'utf8').trim().split(/\r?\n/).map(line => {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line);
    const file = m[2].replace(/^\.\//, '');
    return { file, match: hash(path.join(base, file)) === m[1] };
  });
}
const candidate = verify('pre-mutation-r1.sha256', root);
const backups = verify('backup-before-r1.sha256', path.join(dir, 'backup-before-r1'));
const sig = x => JSON.stringify({rows:x.rows||[],sql:x.sql||null,explanation:x.explanation??x.finalNarrative??null,title:x.title||null,calls:(x.modelCalls||[]).length});
const comparisons = json(path.join(dir,'r1/combined-offline.json')).runs.filter(r=>r.acceptedReceipt).map(r=>{
  const old = new Map(json(path.join(root,r.acceptedReceipt)).results.map(x=>[x.id,sig(x)]));
  const now = new Map(json(path.join(root,r.out)).results.map(x=>[x.id,sig(x)]));
  return {id:r.id,old:old.size,now:now.size,missing:[...old.keys()].filter(k=>!now.has(k)),changed:[...old].filter(([k,v])=>now.has(k)&&now.get(k)!==v).map(([k])=>k)};
});
const bindingFiles = ['app/api/nibrs-query/route.ts','lib/nibrs-db.ts','lib/nibrs-query-worker.js','lib/nibrs-execution-binding.ts','scripts/test-nibrs-execution-binding.ts'];
const bindingUnchanged = bindingFiles.map(file=>({file,match:hash(path.join(root,file))===hash(path.join(dir,'backup-before-r1',file))}));
const report = {at:new Date().toISOString(),candidate,backups,bindingUnchanged,comparisons,limit:'Saved regression outputs independently compared; broad regression suites not rerun by this script.'};
fs.writeFileSync(path.join(dir,'codex-r1-integrity.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report,null,2));
if([...candidate,...backups,...bindingUnchanged].some(x=>!x.match)||comparisons.some(x=>x.missing.length||x.changed.length||x.old!==x.now))process.exitCode=1;
