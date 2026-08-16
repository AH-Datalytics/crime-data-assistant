import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const route = fs.readFileSync(path.join(process.cwd(), "app", "api", "query", "route.ts"), "utf8");
const emptyStart = route.indexOf("// Step 4: Handle empty results");
const emptyEnd = route.indexOf("// Step 5", emptyStart);
assert.ok(emptyStart >= 0, "empty-result branch is missing");
const branch = route.slice(emptyStart, emptyEnd >= 0 ? emptyEnd : emptyStart + 12000);

assert.match(branch, /classifyCurrentTrendsSqlAbsence\(db, sql, 0\)/);
assert.match(branch, /currentAbsence\?\.state === "not_in_source_snapshot"/);
assert.match(branch, /emptyIsSourceAbsence \? "decline_data" : "decline_capability"/);
assert.match(branch, /empty_result_unverified/);
assert.match(branch, /can't tell whether there are no matching source records or our system has a data problem/);

const unsafeComment = /findSimilarAgencies\(\).*establish deterministically what the source has/;
assert.doesNotMatch(branch, unsafeComment);

console.log("current trends empty-result egress: 6/6 guards passed");
