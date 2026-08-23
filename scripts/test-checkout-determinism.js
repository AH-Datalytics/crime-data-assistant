/**
 * P1.1 criterion 1: the byte-hashed provenance input is checkout-invariant.
 *
 * THE DEFECT. `recordDigest()` in lib/stage2b-authored-record.ts hashes the RAW BYTES of
 * scripts/fixtures/operation-taxonomy/capability-answers.json. That digest is stamped into the
 * committed capability-policy.json as `_generatedFrom.record` and asserted by
 * scripts/test-stage2b-workbook.ts. A developer whose Git has core.autocrlf=true -- the default this
 * project's own Git install ships with -- gets CRLF in the working tree, recomputes a different
 * digest, and fails an assertion that has nothing wrong with it.
 *
 * THE FIX, AND WHY IT IS THIS ONE. `.gitattributes` declares `eol=lf` for that path. With an explicit
 * eol attribute Git writes LF on checkout regardless of core.autocrlf, so the bytes are the same
 * everywhere and the digest cannot drift.
 *
 * The fix is emphatically NOT regenerating capability-policy.json. That would bake one machine's line
 * endings into a committed artifact and break the assertion for everyone whose checkout differs -- the
 * trap recorded before this increment began. So this test also asserts the committed digest is the LF
 * digest, which is what makes a regeneration visible instead of silently "fixing" the symptom.
 */
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const PINNED = "scripts/fixtures/operation-taxonomy/capability-answers.json";
const POLICY = "scripts/fixtures/operation-taxonomy/capability-policy.json";

function git(args, opts) {
  return execFileSync("git", args, { cwd: REPO, maxBuffer: 64 * 1024 * 1024, ...opts });
}

function shortDigest(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

let passed = 0;
function check(name, body) {
  body();
  passed++;
  console.log(`  ok  ${name}`);
}

check("the hashed input is pinned to LF by attribute, not by luck", () => {
  const attr = git(["check-attr", "eol", "--", PINNED]).toString("utf8").trim();
  assert.match(attr, /eol: lf$/, `expected eol=lf, got: ${attr}`);
  // With an explicit eol attribute, core.autocrlf cannot change what lands in the working tree.
  const eol = git(["ls-files", "--eol", "--", PINNED]).toString("utf8");
  assert.match(eol, /i\/lf/, "the recorded blob is not LF");
  assert.match(eol, /w\/lf/, "the working tree copy is not LF");
  assert.match(eol, /attr\/text eol=lf/, "the attribute is not in force");
});

check("the recorded blob contains no CR at all", () => {
  const blob = git(["cat-file", "blob", `:${PINNED}`]);
  assert.equal(blob.indexOf(0x0d), -1, "the recorded blob contains a CR");
});

check("the committed provenance digest is the LF digest", () => {
  // If someone regenerates the policy on a CRLF checkout, this is what catches it.
  const blob = git(["cat-file", "blob", `:${PINNED}`]);
  const policy = JSON.parse(git(["cat-file", "blob", `:${POLICY}`]).toString("utf8"));
  assert.equal(policy._generatedFrom.record, shortDigest(blob),
    "the committed _generatedFrom.record is not the digest of the LF input -- either the input was " +
    "regenerated on a CRLF checkout, or the policy was regenerated instead of the input being pinned");
});

check("a CRLF form of the same content really would produce a different digest", () => {
  // The exposure is real, not hypothetical. This is why the attribute matters.
  const blob = git(["cat-file", "blob", `:${PINNED}`]);
  const asCrlf = Buffer.from(blob.toString("binary").replace(/\n/g, "\r\n"), "binary");
  assert.notEqual(shortDigest(asCrlf), shortDigest(blob),
    "a CRLF checkout would digest identically, which would mean this test proves nothing");
});

check("the byte-hash inventory is still complete", () => {
  // One call site hashes raw file bytes. If a second appears, .gitattributes needs another entry and
  // this increment's scope claim is stale.
  const source = git(["cat-file", "blob", ":lib/stage2b-authored-record.ts"]).toString("utf8");
  const byteHashes = source.match(/update\(fs\.readFileSync\(/g) || [];
  assert.equal(byteHashes.length, 1,
    `expected exactly one raw-byte hash site, found ${byteHashes.length}`);
});

console.log(`checkout determinism tests: ${passed} passed`);

