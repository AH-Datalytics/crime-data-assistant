/**
 * Plain wording for every user-facing string of the shadow (P74, Jeff 2026-11-01: "The answers need to be much, much
 * more crystal clear for users"). A decline, a question back, a button and a note:
 *   - say in plain words what the data records (as a verb: "recorded for each offense");
 *   - say why the question can't be answered as asked;
 *   - offer the nearest answerable question as a button whenever one exists;
 *   - never use engine vocabulary.
 * `jargon` finds engine vocabulary in a string; the tests fail when any reaches user-facing text.
 */

/** Engine vocabulary that must never reach a user (with why each is banned, for the test's message). */
export const BANNED: { re: RegExp; what: string }[] = [
  { re: /\bslice\b/i, what: "slice" },
  { re: /\bshadow\b/i, what: "shadow" },
  { re: /\b[PDFGRS]\d{1,2}\b/, what: "a policy or rule id" },
  { re: /\bv0\b/i, what: "v0" },
  { re: /\btyped reading\b|\breading\b(?! (?:the|this|that))/i, what: "reading (engine term)" },
  { re: /\binterpret(?:ed|ing)?\b/i, what: "interpret" },
  { re: /\bapply\b/i, what: "apply" },
  { re: /\bunits?\b/i, what: "unit" },
  { re: /\brecords\b|\ba record\b|\brecord\b(?=\s+(?:of|for|is|are|was|were))/i, what: "record (as a noun)" },
  { re: /\bdimension\b|\bfield\b|\bsegments?\b|\bledger\b|\bcompil\w*|\bplan\b|\bthe reader\b/i, what: "an engine word" },
  { re: /\b[a-z]+_[a-z_]+\b|\b[a-z]+\.[a-z_]+\b/, what: "a code name (snake_case or dotted)" },
  { re: /\bnot in the slice\b|\bnot built\b|\bincrement\b/i, what: "build status" },
];

/** The engine words in a user-facing string, or [] when it is plain. */
export function jargon(text: string): string[] {
  return BANNED.filter((b) => b.re.test(text)).map((b) => b.what);
}
