/**
 * No user-visible "residents" (Jeff 2026-11-15: the site says "people" and "population", never "residents").
 *
 * Reads lib/nibrs-shadow/*.ts and the policy rows' rule text (docs/policy/nibrsai-answer-policy.csv) and fails on the word "residents" in any line that is not a comment and not a pattern
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
// The policy rows (docs/policy/nibrsai-answer-policy.csv): the rule's own words ("proposed behavior" and "exact default or
// choices offered") never say "residents" either. The situation column quotes what a reader typed, "what the app does today"
// and "why" tell history, and "status" quotes Jeff, so those are not rule text.
const LF = String.fromCharCode(10), CR = String.fromCharCode(13);
function csvRows(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === LF || c === CR) {
      if (c === CR && text[i + 1] === LF) i++;
      row.push(cell); cell = ""; rows.push(row); row = [];
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const POLICY = path.resolve(__dirname, "..", "docs", "policy", "nibrsai-answer-policy.csv");
{
  const rows = csvRows(fs.readFileSync(POLICY, "utf8"));
  const head = rows[0];
  const cols = ["proposed behavior", "exact default or choices offered"].map((n) => head.indexOf(n));
  if (cols.includes(-1)) throw new Error("self-test: the policy file's columns changed: " + head.join(" | "));
  for (const r of rows.slice(1)) for (const c of cols) if (/residents?/i.test(r[c] || "")) bad.push(`policy ${r[0]}: ${head[c]}: ${(r[c].match(/.{0,40}residents?.{0,30}/i) || [""])[0]}`);
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
