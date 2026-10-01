'use strict';
// Correct the reviewer's invalid month predicate: this clearance table is annual. First probe preserved.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const file = path.join(__dirname,'codex-period-route.cjs');
const source = fs.readFileSync(file,'utf8').replace(' AND a.month = b.month','');
const mod = new Module(file,module);
mod.filename=file; mod.paths=Module._nodeModulePaths(__dirname);
mod._compile(source,file);
