#!/usr/bin/env node
/**
 * Shared pre-push check. Every session runs it before pushing and states its exit code in the PR text.
 *   node scripts/prepush.js [--base origin/dev]
 * Runs, in order, and stops at the first failure:
 *   1. real node_modules present (a missing or empty install makes tsc fail for the wrong reason);
 *   2. real-module `tsc --noEmit`;
 *   3. line endings: every text file this branch changes (against the base) is LF in the index, and none has CRLF in the working tree
 *      when .gitattributes pins it to LF (CI checks out LF);
 *   4. the policy-row test (scripts/test-policy-rows.js).
 * It does not run the full suite: run touched-file tests while building and one full run at the end.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "origin/dev";

function run(label, cmd, cmdArgs) {
  console.log(`prepush: ${label}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`prepush: FAILED at "${label}" (exit ${r.status === null ? "signal" : r.status})`);
    process.exit(r.status || 1);
  }
}

function out(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(`prepush: "${cmd} ${cmdArgs.join(" ")}" failed: ${(r.stderr || "").trim()}`);
    process.exit(r.status || 1);
  }
  return r.stdout;
}

// 1. real node_modules
if (!fs.existsSync(path.join(ROOT, "node_modules", "typescript", "bin", "tsc"))) {
  console.error("prepush: node_modules/typescript is missing. Install it, or junction node_modules from a checkout that has it; do not run npx tsc without it.");
  process.exit(1);
}

// 2. type check
run("tsc --noEmit", process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--noEmit"]);

// 3. line endings of the files this branch changes
console.log(`prepush: line endings against ${base}`);
const changed = out("git", ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`]).split(/\r?\n/).filter(Boolean);
const eol = new Map();
for (const line of out("git", ["ls-files", "--eol", "--", ...changed.length ? changed : ["."]]).split(/\r?\n/).filter(Boolean)) {
  const m = /^i\/(\S+)\s+w\/(\S+)\s+attr\/(.*?)\s*\t(.+)$/.exec(line);
  if (m) eol.set(m[4], { index: m[1], work: m[2], attr: m[3] });
}
const bad = [];
for (const f of changed) {
  const e = eol.get(f);
  if (!e) continue;
  if (e.index === "crlf" || e.index === "mixed") bad.push(`${f}: CRLF in the index (i/${e.index})`);
  else if (/eol=lf/.test(e.attr) && (e.work === "crlf" || e.work === "mixed")) bad.push(`${f}: pinned to LF but CRLF in the working tree (w/${e.work})`);
}
if (bad.length) {
  console.error("prepush: FAILED at line endings:\n  " + bad.join("\n  "));
  process.exit(1);
}

// 3b. duplicate ids in the policy-row id list (a union merge can double a line; the list is not sorted, so order is not checked)
{
  const seen = new Set();
  const dup = [];
  for (const raw of fs.readFileSync(path.join(ROOT, "scripts", "fixtures", "policy-row-ids.txt"), "utf8").split(/\r?\n/)) {
    const id = raw.trim();
    if (!id || id.startsWith("#")) continue;
    if (seen.has(id)) dup.push(id);
    seen.add(id);
  }
  if (dup.length) {
    console.error(`prepush: FAILED: duplicate lines in policy-row-ids.txt: ${[...new Set(dup)].join(", ")}`);
    process.exit(1);
  }
}

// 4. policy rows
run("policy rows", process.execPath, [path.join(ROOT, "scripts", "test-policy-rows.js")]);

console.log("prepush: exit 0");
