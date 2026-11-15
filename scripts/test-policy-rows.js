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
 *   - two rows share an id;
 *   - the generator (scripts/build-answer-policy-csv.py) does not produce the CSV: a row only in the CSV, only in the
 *     generator, or with different words. A row added to the CSV by hand is dropped the next time anyone regenerates it
 *     (the D33 to D42 and P107 to P112 rows were), so the generator must carry every row.
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

/** What differs between the CSV and what the generator produces: rows by id, compared field by field (order does not matter). */
function generatorProblems(csvText, genText) {
  const byId = (text) => new Map(records(text).slice(1).map((r) => [r[0].trim(), r]));
  const have = byId(csvText), made = byId(genText);
  const out = [];
  const onlyCsv = [...have.keys()].filter((id) => !made.has(id));
  const onlyGen = [...made.keys()].filter((id) => !have.has(id));
  const differ = [...have.keys()].filter((id) => made.has(id) && JSON.stringify(have.get(id)) !== JSON.stringify(made.get(id)));
  if (onlyCsv.length) out.push(`in the CSV but not made by the generator (it would be dropped on regeneration): ${onlyCsv.join(", ")}. Add them to scripts/build-answer-policy-csv.py.`);
  if (onlyGen.length) out.push(`made by the generator but not in the CSV: ${onlyGen.join(", ")}. Run python scripts/build-answer-policy-csv.py and keep the CSV rows others added.`);
  if (differ.length) out.push(`different words in the CSV and the generator: ${differ.join(", ")}. Make the generator say what the CSV says (or the reverse).`);
  return out;
}
// Self-test: a row only on one side, or with other words, is found; the same rows in another order are clean.
{
  const h = "id,topic\n";
  if (generatorProblems(h + "D1,a\nD2,b\n", h + "D2,b\nD1,a\n").length) throw new Error("self-test: the same rows in another order must be clean");
  if (!/not made by the generator.*: D3/.test(generatorProblems(h + "D1,a\nD3,c\n", h + "D1,a\n").join(" "))) throw new Error("self-test: a CSV-only row must be found");
  if (!/not in the CSV: D4/.test(generatorProblems(h + "D1,a\n", h + "D1,a\nD4,d\n").join(" "))) throw new Error("self-test: a generator-only row must be found");
  if (!/different words.*: D1/.test(generatorProblems(h + "D1,a\n", h + "D1,z\n").join(" "))) throw new Error("self-test: different words must be found");
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
{
  // The generator's output to a temporary file, compared with the CSV (python, or python3 where that is its name).
  const { spawnSync } = require("node:child_process");
  const os = require("node:os");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "policy-")), "generated.csv");
  let ran = null;
  for (const py of ["python", "python3"]) {
    const r = spawnSync(py, [path.join(ROOT, "scripts", "build-answer-policy-csv.py"), tmp], { encoding: "utf8" });
    if (r.error) continue;
    ran = r;
    break;
  }
  if (!ran) bad.push("python was not found, so the generator could not be compared with the CSV");
  else if (ran.status !== 0) bad.push("the generator failed (exit " + ran.status + "): " + String(ran.stderr || ran.stdout).trim().slice(-300));
  else bad.push(...generatorProblems(csvText, fs.readFileSync(tmp, "utf8")));
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
}
if (bad.length) {
  console.error("FAIL policy rows:\n  " + bad.join("\n  "));
  process.exit(1);
}
console.log(`policy rows: ${idsOf(csvText).length} rows, all listed, none lost`);
