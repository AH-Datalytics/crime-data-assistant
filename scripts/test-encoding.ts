// Guards against UTF-8/cp1252 mojibake landing in source files.
// Editor misconfiguration double-encoded em-dashes and arrows twice on
// 2026-07-28 (commits 3679412, bd180fc), including user-facing strings.
// Corrupt samples below are built from char codes so this file stays clean.
// Run: npx tsx scripts/test-encoding.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["app", "components", "lib", "scripts"];
const EXT_RE = /\.(ts|tsx|js|jsx|css|md)$/;
// Double-encoding markers: a-circumflex (U+00E2) or A-tilde (U+00C3) followed
// by a Latin-1 supplement char or cp1252-mapped punctuation, or a stray C1
// control char. Legitimate prose never produces these pairs; bare em-dashes
// and arrows stay legal.
const MOJIBAKE_RE = new RegExp(
  "[\\u00e2\\u00c3][\\u0080-\\u00bf\\u0152\\u0153\\u0160\\u0161\\u0178\\u017d\\u017e\\u0192\\u02c6\\u02dc\\u2013-\\u203a\\u20ac\\u2122]" +
  "|[\\u0080-\\u009f]"
);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      yield* walk(p);
    } else if (EXT_RE.test(name)) {
      yield p;
    }
  }
}

// Self-test: the detector must catch known corruption shapes and pass legit text
const cc = String.fromCharCode;
const corrupt = [
  `incomplete data ${cc(0xe2)}${cc(0x20ac)}${cc(0x201d)} especially`, // double-encoded em-dash
  `NE${cc(0xe2)}${cc(0x2020)}${cc(0x2019)}NB`,                        // double-encoded arrow
  `caveats ${cc(0xc3)}${cc(0xa2)} filter`,                            // triple-encoding prefix
  `stray ${cc(0x9d)} byte`,                                           // orphaned C1 control char
];
for (const s of corrupt) {
  if (!MOJIBAKE_RE.test(s)) {
    console.error(`SELF-TEST FAILED: detector missed ${JSON.stringify(s)}`);
    process.exit(1);
  }
}
if (MOJIBAKE_RE.test("legit em-dash — and arrow → stay allowed")) {
  console.error("SELF-TEST FAILED: detector flags legitimate punctuation");
  process.exit(1);
}

let bad = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const text = readFileSync(file, "utf-8");
    const m = text.match(MOJIBAKE_RE);
    if (m) {
      const line = text.slice(0, m.index).split("\n").length;
      console.error(`MOJIBAKE ${file}:${line}: ${JSON.stringify(m[0])}`);
      bad++;
    }
  }
}
if (bad > 0) {
  console.error(`encoding check FAILED: ${bad} file(s) contain mojibake`);
  process.exit(1);
}
console.log("encoding check passed");
