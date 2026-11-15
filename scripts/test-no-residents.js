/**
 * No user-visible "residents" (Jeff 2026-11-15: the site says "people" and "population", never "residents").
 *
 * Reads lib/nibrs-shadow/*.ts and fails on the word "residents" in any line that is not a comment and not a pattern
 * that recognises what a reader typed (a regular expression: it contains \b, \s or (?: ). A string the answer shows is
 * neither. Reads files only: no database, no model, no network.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.resolve(__dirname, "..", "lib", "nibrs-shadow");
const bad = [];
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith(".ts"))) {
  fs.readFileSync(path.join(DIR, f), "utf8").split(/\r?\n/).forEach((line, i) => {
    if (!/residents?/i.test(line)) return;
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return; // a comment
    if (/\\b|\\s|\(\?:/.test(line)) return; // a pattern that reads what was typed
    bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
}
// Self-test: a shown string is caught, a pattern and a comment are not.
{
  const caught = (l) => /residents?/i.test(l) && !/^\s*(?:\/\/|\*|\/\*)/.test(l) && !/\\b|\\s|\(\?:/.test(l);
  if (!caught('text.push("the residents of the agencies");')) throw new Error("self-test: a shown string must be caught");
  if (caught("  // the most residents") || caught("const re = /\\bresidents?\\b/i;")) throw new Error("self-test: a comment or a pattern is not a shown string");
}
if (bad.length) {
  console.error(`FAIL no residents: ${bad.length} line(s) show "residents" to the user; say "people" or "population":`);
  for (const b of bad) console.error("  " + b);
  process.exit(1);
}
console.log("no residents: no answer, ask or note text says \"residents\"");
