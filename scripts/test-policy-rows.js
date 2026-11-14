#!/usr/bin/env node
/**
 * The answer policy's rows are never lost in a merge (2026-11-14: rows D33 to D37 were dropped when a squash merge
 * resolved an end-of-file conflict by taking one side; nothing flagged it).
 *
 * Every row id of docs/policy/nibrsai-answer-policy.csv is listed in scripts/fixtures/policy-row-ids.txt, one per line.
 * The list merges with git's union driver (.gitattributes), so two PRs that each add rows both keep their ids. This test
 * fails when:
 *   - a listed id has no row in the CSV: a row was deleted. If a row is meant to go, remove its id from the list in the
 *     same PR and say so in the PR text;
 *   - a CSV row's id is not listed: add it (node scripts/test-policy-rows.js --write);
 *   - two rows share an id.
 *   node scripts/test-policy-rows.js            check
 *   node scripts/test-policy-rows.js --write    add the CSV's new ids to the list (never removes one)
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CSV = path.join(ROOT, "docs", "policy", "nibrsai-answer-policy.csv");
const LIST = path.join(ROOT, "scripts", "fixtures", "policy-row-ids.txt");

/** RFC 4180 records (quoted fields may hold commas, doubled quotes and newlines); a leading BOM is dropped. */
function records(text) {
  const out = [];
  let row = [], field = "", quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') {
      if (field !== "") throw new Error(`a quote inside an unquoted field (record ${out.length + 1})`);
      quoted = true;
    } else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") out.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) throw new Error("an unterminated quoted field");
  if (field !== "" || row.length) { row.push(field); out.push(row); }
  return out;
}

const idsOf = (csvText) => records(csvText).slice(1).map((r, i) => {
  const id = r[0].trim();
  if (!id) throw new Error(`a policy row has no id (record ${i + 2}): ${r.join(",").slice(0, 60)}`);
  return id;
});
const listed = (listText) => listText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

/** Pure check, for the self-test: what is wrong with a CSV against a list. */
function problems(csvText, listText) {
  let ids;
  try { ids = idsOf(csvText); } catch (e) { return [`the CSV is malformed: ${e.message}`]; }
  const want = listed(listText);
  const have = new Set(ids), known = new Set(want);
  const out = [];
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) out.push(`two rows share an id: ${[...new Set(dup)].join(", ")}`);
  const lost = want.filter((id) => !have.has(id));
  if (lost.length) out.push(`policy rows deleted: ${lost.join(", ")}. If a row is meant to go, remove its id from scripts/fixtures/policy-row-ids.txt in the same PR and say so in the PR text.`);
  const unlisted = ids.filter((id) => !known.has(id));
  if (unlisted.length) out.push(`rows not in scripts/fixtures/policy-row-ids.txt: ${unlisted.join(", ")}. Add them: node scripts/test-policy-rows.js --write`);
  return out;
}

// Self-test: the check sees a deleted row, a new unlisted row and a duplicate; an untouched file is clean.
{
  const header = "id,topic\n";
  const csv = header + 'D1,"a, b"\nD2,"two\nlines ""quoted"""\nP3,c\n';
  const list = "# ids\nD1\nD2\nP3\n";
  if (problems(csv, list).length) throw new Error("self-test: an untouched file must be clean: " + problems(csv, list).join("; "));
  if (!/deleted: D2/.test(problems(header + 'D1,"a, b"\nP3,c\n', list).join(" "))) throw new Error("self-test: a deleted row must be found");
  if (!/not in .*: D4/.test(problems(csv + "D4,d\n", list).join(" "))) throw new Error("self-test: an unlisted row must be found");
  if (!/share an id: D1/.test(problems(csv + "D1,again\n", list).join(" "))) throw new Error("self-test: a duplicate id must be found");
  if (idsOf("﻿id,topic\r\nD1,x\r\nD2,y\r\n").join() !== "D1,D2") throw new Error("self-test: BOM and CRLF");
  if (!/malformed.*quote/.test(problems(header + 'P"1"2,x\n', "P12\n").join(" "))) throw new Error("self-test: a quote inside an unquoted field must be refused");
  if (!/malformed.*unterminated/.test(problems(header + 'D1,"open\n', "D1\n").join(" "))) throw new Error("self-test: an unterminated quote must be refused");
  if (!/malformed.*no id/.test(problems(header + ",orphan row\n", "").join(" "))) throw new Error("self-test: a row without an id must be refused");
}

const csvText = fs.readFileSync(CSV, "utf8");
const listText = fs.existsSync(LIST) ? fs.readFileSync(LIST, "utf8") : "";

if (process.argv.includes("--write")) {
  const have = idsOf(csvText), known = new Set(listed(listText));
  const add = have.filter((id) => !known.has(id));
  const head = listText.trim() ? listText.replace(/\s*$/, "\n") : "# Every policy row id (docs/policy/nibrsai-answer-policy.csv). Union-merged; see scripts/test-policy-rows.js.\n";
  fs.writeFileSync(LIST, head + add.map((id) => id + "\n").join(""));
  console.log(`policy rows: ${add.length} id(s) added to the list`);
  process.exit(0);
}

const bad = problems(csvText, listText);
if (bad.length) {
  console.error("FAIL policy rows:\n  " + bad.join("\n  "));
  process.exit(1);
}
console.log(`policy rows: ${idsOf(csvText).length} rows, all listed, none lost`);
