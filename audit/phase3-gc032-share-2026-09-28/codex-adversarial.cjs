'use strict';
// Execute the submitted real route/worker fixture, with targeted reviewer variations in memory only.
const fs=require('node:fs'), path=require('node:path'), Module=require('node:module');
const file=path.join(__dirname,'route-witness-gc032.cjs');
let source=fs.readFileSync(file,'utf8');
const start=source.indexOf('const cases = [');
const end=source.indexOf("].map((c) => ({ ...c, q }));",start);
if(start<0||end<0)throw new Error('scenario anchors absent');
source=source.slice(0,start)+`const cases = [
 {id:'retained-gc032',expect:'answer',sql:RETAINED},
 {id:'integer-percentage',expect:'answer',sql:RETAINED.replace('100.0 *','100 *')},
 {id:'fraction-no-coercion',expect:'answer',sql:RETAINED.replace('100.0 * y.youth_count / t.total_count','y.youth_count / t.total_count')},
`+source.slice(end);
// 1260 / 15060 -> 8.3665...%; rounded to one decimal it is 8.4, so integer truncation is observable.
source=source.replace("add('CA', 2025, '09A', 'Unknown', 1000);", "add('CA', 2025, '09A', 'Unknown', 1000); add('CA', 2025, '09A', 'Under 18', 60);");
source=source.replace("const EXPLAIN = 'Youth under 18 accounted for 8.0% of serious violent crimes in California from 2021 to 2025.';", "const EXPLAIN = 'In California from 2021 to 2025, 8.4% of all reported serious violent crimes were committed by youth under 18.';");
// This is an observation probe. Do not reuse the submission's expected 1200/15000 checks.
source=source.replace("youthN === 1200 && totalN === 15000 && pct === 8", "youthN === 1260 && totalN === 15060 && pct === 8.4");
source=source.replace("expected figure is derived from rows: 1200 / 15000 = 8.0%", "reviewer fixture: 1260 / 15060 rounds to 8.4%");
source=source.replace("!/% of serious violent crimes/i", "!/% of all reported serious violent crimes/i");
const mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(__dirname);mod._compile(source,file);
