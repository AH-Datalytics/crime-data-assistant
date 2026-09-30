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
const fs = require("node:fs");
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

/**
 * P1.1-R — the SECOND class of checkout-sensitive file, and why the inventory above did not catch it.
 *
 * That inventory scans ONE file for RAW-BYTE hashes. It was the whole declared scope of P1.1, and it
 * was incomplete: a tracked text file also decides a test result when it is
 *
 *   (a) BYTE-COMPARED against what its generator emits right now -- the generator writes "\n", a CRLF
 *       checkout puts "\r\n" on disk, and the comparison fails with nothing actually wrong; or
 *   (b) read with `readFileSync(path, "utf8")` and then HASHED -- utf8 decoding does NOT normalise
 *       line endings, so the digest moves even though the read looks text-mode.
 *
 * Measured at 3e3fd55 before this increment: the canonical suite was 147/0/10/0 exit 0 under LF and
 * 144/3/10/0 exit 1 under core.autocrlf=true. A real exposure, not a hypothetical.
 */
const CHECKOUT_SENSITIVE = [
  { path: PINNED, why: "raw-byte hash -> _generatedFrom.record" },
  { path: POLICY, why: "byte-compared to generator output, test-stage2b-workbook.ts" },
  { path: "lib/source-health-inventory.ts", why: "byte-compared to renderInventory()" },
  { path: "lib/stage2b-plain-language.js", why: "utf8 read hashed -> _generatedFrom.contract" },
];

check("every checkout-sensitive file is pinned to LF by attribute", () => {
  for (const entry of CHECKOUT_SENSITIVE) {
    const attr = git(["check-attr", "eol", "--", entry.path]).toString("utf8").trim();
    assert.match(attr, /eol: lf$/, `${entry.path} (${entry.why}) is not pinned: ${attr}`);
    const eol = git(["ls-files", "--eol", "--", entry.path]).toString("utf8");
    assert.match(eol, /i\/lf/, `${entry.path} recorded blob is not LF`);
    assert.match(eol, /w\/lf/, `${entry.path} working copy is not LF -- attribute not in force`);
  }
});

check("no checkout-sensitive blob contains a CR", () => {
  for (const entry of CHECKOUT_SENSITIVE) {
    const blob = git(["cat-file", "blob", `:${entry.path}`]);
    assert.equal(blob.indexOf(0x0d), -1, `${entry.path} recorded blob contains a CR`);
  }
});

check("a CRLF form of each would really differ, so no pin is decoration", () => {
  // Non-vacuity per file: a file with no LF could not be EOL-sensitive, so listing it would mislead.
  for (const entry of CHECKOUT_SENSITIVE) {
    const blob = git(["cat-file", "blob", `:${entry.path}`]);
    assert.notEqual(blob.indexOf(0x0a), -1, `${entry.path} has no LF, so it cannot be EOL-sensitive`);
    const asCrlf = Buffer.from(blob.toString("binary").replace(/\n/g, "\r\n"), "binary");
    assert.notEqual(shortDigest(asCrlf), shortDigest(blob),
      `${entry.path} digests identically as CRLF, so pinning it proves nothing`);
  }
});

/**
 * DUAL VIEW, and why source checks need both.
 *
 * The EOL and blob claims above read the INDEX, which is correct: what Git materialises on checkout is
 * a function of the recorded blob and the attributes, not of anyone's working copy.
 *
 * Source-shape claims are different. Reading only the index gives a local blind spot: a developer runs
 * tests before staging, so an unstaged relaxation would pass. That happened during this increment --
 * the first M2 mutation edited the working tree, the check read unchanged staged bytes, and it reported
 * a false pass. So shape checks inspect BOTH views and name whichever one fails.
 *
 * This is the same dual-view discipline the control-character gate already uses: verdict A over index
 * blobs, verdict B over bytes on disk.
 */
function sourceViews(file) {
  return [
    { view: "index", text: git(["cat-file", "blob", `:${file}`]).toString("utf8") },
    { view: "worktree", text: fs.readFileSync(path.join(REPO, file), "utf8") },
  ];
}

check("the governed byte-identity consumers stay pinned, in both views", () => {
  /**
   * SCOPE CLAIM, stated honestly: this proves the two CURRENTLY GOVERNED consumers remain pinned. It
   * does NOT prove no third consumer exists elsewhere in the repository -- it opens two named files and
   * maps two known constants, so it cannot. The repository-wide detector for a newly introduced
   * checkout-sensitive consumer is executing the canonical suite in both LF and CRLF materialisations,
   * which is acceptance evidence for this increment and belongs to the later hosted-CI increment as a
   * standing job. A brittle repo-wide regex inventory is deliberately not built here.
   */
  const CONSUMER_CONSTANTS = {
    GENERATED_POLICY_FILE: POLICY,
    INVENTORY_FILE: "lib/source-health-inventory.ts",
  };
  const pinned = new Set(CHECKOUT_SENSITIVE.map((e) => e.path));

  for (const testFile of ["scripts/test-stage2b-workbook.ts", "scripts/test-source-health-inventory.ts"]) {
    for (const { view, text } of sourceViews(testFile)) {
      for (const m of text.matchAll(/readFileSync\(\s*([A-Z_]+)\s*,\s*"utf8"\s*\)/g)) {
        const mapped = CONSUMER_CONSTANTS[m[1]];
        if (!mapped) continue;
        assert.ok(pinned.has(mapped),
          `[${view}] ${testFile} byte-compares ${m[1]} (${mapped}) but it is not in CHECKOUT_SENSITIVE`);
      }
    }
  }

  // The utf8-read-then-hash site feeding the contract fingerprint, also in both views.
  for (const { view, text } of sourceViews("scripts/generate-stage2b-workbook.ts")) {
    assert.match(text, /readFileSync\(PLAIN_LANGUAGE_MODULE_FILE, "utf8"\)/,
      `[${view}] the utf8-read translation source moved; re-derive the inventory`);
  }
  assert.ok(pinned.has("lib/stage2b-plain-language.js"),
    "the translation source is hashed but not pinned");
});

check("each governed comparison keeps its DIRECT shape, in both views", () => {
  /**
   * The property, asserted AT ITS BOUNDARY rather than by banning a spelling.
   *
   * An earlier version rejected `.replace(/\r\n/g` anywhere in either whole test file. That was both
   * overbroad -- an unrelated CRLF normalisation elsewhere in the file would false-refuse -- and
   * incomplete, because `replaceAll`, a helper, an intermediate variable or a different regex all slip
   * past a spelling list.
   *
   * Instead: require the compared value to arrive at `strictEqual` DIRECTLY. Any transformation
   * inserted into that data path breaks the shape, whatever it is spelled like, and code elsewhere in
   * the file is none of this check's business.
   */
  const SITES = [
    {
      file: "scripts/test-stage2b-workbook.ts",
      what: "the file read is the direct first operand and generated text the direct second",
      // strictEqual(fs.readFileSync(GENERATED_POLICY_FILE, "utf8"), generated.text,
      shape: /strictEqual\(\s*fs\.readFileSync\(\s*GENERATED_POLICY_FILE\s*,\s*"utf8"\s*\)\s*,\s*generated\.text\s*,/,
    },
    {
      file: "scripts/test-source-health-inventory.ts",
      what: "onDisk is assigned directly from the read, with nothing appended",
      // const onDisk = fs.readFileSync(INVENTORY_FILE, "utf8");
      shape: /const\s+onDisk\s*=\s*fs\.readFileSync\(\s*INVENTORY_FILE\s*,\s*"utf8"\s*\)\s*;/,
    },
    {
      file: "scripts/test-source-health-inventory.ts",
      what: "onDisk is compared directly against renderInventory()",
      // assert.strictEqual(onDisk, renderInventory(),
      shape: /strictEqual\(\s*onDisk\s*,\s*renderInventory\(\)\s*,/,
    },
  ];
  for (const site of SITES) {
    for (const { view, text } of sourceViews(site.file)) {
      assert.match(text, site.shape,
        `[${view}] ${site.file}: ${site.what} -- the compared value no longer reaches strictEqual ` +
        `directly, so a transformation has been inserted into the governed data path`);
    }
  }
});

console.log(`checkout determinism tests: ${passed} passed`);

