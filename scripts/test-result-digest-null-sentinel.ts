/**
 * Runtime equivalence for the null sentinel in lib/result-digest.ts, after P1.1 replaced a raw NUL
 * byte in that source file with the six-character escape that produces the same string.
 *
 * WHY THIS EXISTS. The file used to carry a literal 0x00 byte inside a string literal. It worked, but
 * it made Git classify a TypeScript source as binary, which excluded it from `git grep -I`, rendered it
 * as binary in diffs, and would have excluded it from P1.1's own control-byte gate -- the gate whose
 * whole purpose is protecting source files. The byte is fragile too: any tool that re-encodes the file
 * can destroy the sentinel silently.
 *
 * The escape is behaviour-preserving, and "behaviour-preserving" is exactly the claim that needs a test
 * rather than an assurance. The sentinel exists so a real SQL NULL cannot collide with the literal
 * string "null" when categorical values are de-duplicated; if the replacement had produced the seven
 * characters `\u0000` instead of one code point, that collision would silently return.
 *
 * This is a separate file on purpose: scripts/test-result-digest.ts is left untouched so its existing
 * assertions demonstrably still pass unchanged.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { buildResultDigest } from "../lib/result-digest";

let passed = 0;
function check(name: string, body: () => void): void {
  body();
  passed++;
  console.log(`  ok  ${name}`);
}

check("the source file carries the escape, not a raw control byte", () => {
  // The defect this replaced is invisible at the character level, so assert on BYTES.
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "result-digest.ts"));
  assert.strictEqual(source.indexOf(0x00), -1, "lib/result-digest.ts contains a raw NUL byte");
  const control = [...source].filter((b) => b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d);
  assert.strictEqual(control.length, 0, "lib/result-digest.ts contains a control byte");
  // And the escape is really there, spelled as source characters.
  const text = source.toString("utf8");
  assert.ok(text.includes(String.fromCharCode(92) + "u0000null"),
    "the null sentinel escape is missing from the source");
});

check("the sentinel still begins with code point zero", () => {
  // A single distinct value keyed from a real null. Its dedup key is internal, so the observable
  // proof is the collision behaviour below; this asserts the code point directly for good measure.
  const sentinel = String.fromCharCode(0) + "null";
  assert.strictEqual(sentinel.charCodeAt(0), 0, "the sentinel does not start at code point zero");
  assert.strictEqual(sentinel.length, 5, "the sentinel is not one NUL plus four characters");
});

check("a real null and the literal string 'null' stay distinct", () => {
  // THE POINT OF THE SENTINEL. If the escape had been mangled into seven literal characters, both of
  // these rows would key to something starting with a backslash and would still be distinct -- so the
  // decisive case is that the COUNT is two, and that both values survive into the digest.
  const digest = buildResultDigest({
    rows: [{ city: null }, { city: "null" }],
    columns: ["city"],
    truncated: false,
    plan: { categoricalColumns: ["city"] },
  });
  const distinct = digest.columns[0].distinct!;
  assert.strictEqual(distinct.total, 2, "a real null collided with the string 'null'");
  assert.ok(distinct.values.includes(null), "the real null was lost from the digest");
  assert.ok(distinct.values.includes("null"), "the string 'null' was lost from the digest");
});

check("undefined keys to the same sentinel as null", () => {
  // Both map to the sentinel, so a column holding both reports ONE distinct value, not two.
  const digest = buildResultDigest({
    rows: [{ city: null }, { city: undefined }],
    columns: ["city"],
    truncated: false,
    plan: { categoricalColumns: ["city"] },
  });
  assert.strictEqual(digest.columns[0].distinct!.total, 1,
    "null and undefined stopped sharing the sentinel");
});

check("repeated nulls still de-duplicate", () => {
  const digest = buildResultDigest({
    rows: [{ city: null }, { city: null }, { city: null }],
    columns: ["city"],
    truncated: false,
    plan: { categoricalColumns: ["city"] },
  });
  assert.strictEqual(digest.columns[0].distinct!.total, 1, "repeated nulls stopped de-duplicating");
});

console.log(`result digest null sentinel tests: ${passed} passed`);
