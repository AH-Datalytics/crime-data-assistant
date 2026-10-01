'use strict';
/*
 * Runs the full binding witness (same scenarios, fixture and checks) against the PRE-CHANGE route and
 * database module, loaded in memory from backup-before/ at their original module identities -- the
 * technique of Codex's codex-rollup-probe.cjs. No checkout file is changed. The current worker serves
 * those calls in its unchanged legacy (no-hash) mode. Writes only witness-r1-prechange.json.
 */
const fs = require('fs'), path = require('path'), Module = require('module');
const root = path.resolve(__dirname, '../..');
const filename = path.join(__dirname, 'binding-witness.cjs');
const oldRead = fs.readFileSync;
const files = ['app/api/nibrs-query/route.ts', 'lib/nibrs-db.ts'];
const backups = new Map(files.map((p) => [path.normalize(path.join(root, p)), oldRead(path.join(__dirname, 'backup-before', p))]));
fs.readFileSync = function (p, options) {
  const b = typeof p === 'string' ? backups.get(path.normalize(p)) : null;
  if (b) { const enc = typeof options === 'string' ? options : options && options.encoding; return enc ? b.toString(enc) : Buffer.from(b); }
  return oldRead.apply(this, arguments);
};
let source = oldRead(filename, 'utf8').replace("kind: 'p4-final-statement-binding-witness'", "kind: 'p4-binding-witness-prechange-route-db'");
process.argv = [process.execPath, filename, '--out', path.join(__dirname, 'witness-r1-prechange.json')];
const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(__dirname); mod._compile(source, filename);
