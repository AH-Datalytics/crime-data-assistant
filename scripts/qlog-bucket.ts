/**
 * The scorecard's bucket rules (one per label), shared by the engine's run (run-qlog-scorecard.ts) and the old app's
 * logged replies (score-old-engine.ts, scoring gap 2): both are scored by the same code.
 */
import fs from "node:fs";
import path from "node:path";

export type Label = { id: string; tab: string; kind: "first" | "follow-up"; times: number; question: string; previous: string | null;
  expected: { outcome: "answer" | "clarify" | "decline" | "exclude"; source: string | null; about?: string; about_any?: string[]; source_any?: string[]; reason?: string };
  label: { status: string; rule: string; notes?: string } };
export type Got = { kind: string; source: string | null; about?: string; reason?: string; ms: number; digest?: string };
/** The part a clarify asks about, in the label's words. */
export function aboutClass(s: string): string {
  const t = s.toLowerCase();
  if (/^which (?:place|places|period|year|years|crime|crimes)\b/.test(t)) return aboutClass(t.slice(6));
  if (/rolling window|window length|how many months/.test(t)) return "rolling window";
  // D31's "which kind of crime" asks the crime (it was scored as a "which <place>" question: root-causes PR, 2026-11-06).
  if (/^which kind of crime\b/.test(t)) return "crime";
  if (/^which /.test(t)) return "which";
  if (/violent|property/.test(t)) return "violent, property or both";
  // "victim or offender race", "victims or offenders", "victim or offender age": one question, whose people are counted.
  if (/\bvictims?\s+or\s+offenders?\b/.test(t)) return "victims or offenders";
  if (/place|where|location|agency|city|state/.test(t)) return "place";
  if (/period|year|when|month|time/.test(t)) return "period";
  if (/crime|offen[cs]e|measure/.test(t)) return "crime";
  return t;
}

/**
 * The classes an asked question counts as. D31's "which kind of crime" (buttons Violent crime, Property crime, Both) is
 * the label rules' "violent, property or both" question (D09) as well as a crime question: one question, two names
 * (wrong-clarify audit, 2026-11-07: 79 were filed under "crime" against labels wanting "violent, property or both").
 */
function askedClasses(about: string): string[] {
  const c = aboutClass(about);
  return /^which kind of crime\b/i.test(about) ? [c, "violent, property or both"] : [c];
}

/** Answers whose every shown number matched independent values (blind SQL, Model's canonical values), by digest. */
export const VERIFIED_FILE = path.join(__dirname, "fixtures", "answer-eval", "qlog-verified.json");
export const VERIFIED: Record<string, { digest: string }> = fs.existsSync(VERIFIED_FILE) ? JSON.parse(fs.readFileSync(VERIFIED_FILE, "utf8")).verified : {};

export type Bucket = "correct" | "unverified" | "wrong answer" | "bad decline" | "wrong clarify" | "follow-up error" | "error" | "excluded";
export function bucket(l: Label, g: Got | null): Bucket {
  if (l.expected.outcome === "exclude") return "excluded";
  if (!g || g.kind === "error") return "error";
  // A follow-up's wrong answer is a wrong answer, in the gate like any other (coordinator 2026-11-08, scoring gap 1);
  // its other misses (a bad decline, a wrong clarify) stay follow-up errors.
  const miss = (b: Bucket): Bucket => (l.kind === "follow-up" && b !== "wrong answer" ? "follow-up error" : b);
  const e = l.expected;
  // A proposal ("Did you mean ...?") runs nothing: a clarify in effect.
  const kind = g.kind === "proposal" ? "clarify" : g.kind;
  if (e.outcome === "answer") {
    const okSource = (x: string | null) => x === e.source || (!!x && (e.source_any ?? []).includes(x));
    // Verified (every shown number matched independent values, at this digest): correct.
    if (kind === "answer") return !okSource(g.source) ? miss("wrong answer") : g.digest && VERIFIED[l.id]?.digest === g.digest ? "correct" : "unverified";
    if (kind === "route") return okSource(g.source) ? "unverified" : miss("bad decline");
    return miss(kind === "decline" ? "bad decline" : "wrong clarify");
  }
  if (e.outcome === "clarify") {
    if (kind === "clarify") {
      // Any missing part is a right one to ask about (D31 asks one at a time; the labels list them all).
      const wants = (e.about_any ?? [e.about ?? ""]).map((w) => (/^which /.test(w) ? "which" : aboutClass(w)));
      return wants.includes("the whole question") || askedClasses(g.about ?? "").some((c) => wants.includes(c)) ? "correct" : miss("wrong clarify");
    }
    // Asking for the whole question again is what a decline of the words does ("try asking another way").
    if (kind === "decline" && (e.about === "the whole question") && g.reason === "reader") return "correct";
    return kind === "route" ? "unverified" : miss(kind === "answer" ? "wrong answer" : "bad decline");
  }
  // A decline: any plain decline or route away is a decline; its reason is not checked yet.
  if (kind === "decline" || kind === "route") return "correct";
  return miss(kind === "answer" ? "wrong answer" : "wrong clarify");
}
