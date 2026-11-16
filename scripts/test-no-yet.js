/**
 * No "yet" in what the new engine says (Jeff 2026-11-15: "Drop yet. We can either figure out how to do that or not.").
 *
 * Reads lib/nibrs-shadow, lib/nibrs-plan and lib/answer-contract and fails on the word "yet" in any string literal that is shown
 * to a reader. Not checked: comments, regular expressions, and an object key (an internal reason that a lookup matches, such as
 * a reason string in wording.ts: its value is what the reader sees). Reads files only: no database, no model,
 * no network.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DIRS = ["lib/nibrs-shadow", "lib/nibrs-plan", "lib/answer-contract"];
const STR = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const YET = /\byet\b/;

/** The string literals of a line that say "yet" and are neither an object key nor in a comment. */
function offenders(line) {
  if (!YET.test(line) || /^\s*(?:\/\/|\*|\/\*)/.test(line)) return [];
  const out = [];
  let m;
  STR.lastIndex = 0;
  while ((m = STR.exec(line))) {
    if (!YET.test(m[0])) continue;
    const after = line.slice(m.index + m[0].length);
    if (/^\s*:/.test(after) && !/^\s*:\s*[A-Za-z_$]+\s*[?]/.test(after)) continue; // an object key
    out.push(m[0]);
  }
  return out;
}

// Self-test: a shown sentence is caught; a key, a comment and a pattern are not.
{
  if (offenders('decline("x", "This isn\'t available yet: a thing.");').length !== 1) throw new Error("self-test: a shown sentence must be caught");
  if (offenders('  "we don\'t have LEOKA data in yet.": () => "We don\'t have LEOKA data.",').length !== 0) throw new Error("self-test: a lookup key is not shown");
  if (offenders("  // not yet decided").length !== 0 || offenders("const re = /\\byet\\b/;").length !== 0) throw new Error("self-test: a comment or a pattern is not shown");
}

const bad = [];
for (const d of DIRS) {
  for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith(".ts"))) {
    fs.readFileSync(path.join(ROOT, d, f), "utf8").split(/\r?\n/).forEach((line, i) => {
      for (const lit of offenders(line)) bad.push(`${d}/${f}:${i + 1}: ${lit.slice(0, 110)}`);
    });
  }
}
if (bad.length) {
  console.error(`FAIL no yet: ${bad.length} shown string(s) say "yet"; drop it:`);
  for (const b of bad) console.error("  " + b);
  process.exit(1);
}
console.log('no yet: nothing the engine says to a reader contains "yet"');
