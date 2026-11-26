/**
 * The scorecard's bucket rules (one per label), shared by the engine's run (run-qlog-scorecard.ts) and the old app's
 * logged replies (score-old-engine.ts, scoring gap 2): both are scored by the same code.
 */
import fs from "node:fs";
import path from "node:path";

export type Label = { id: string; tab: string; kind: "first" | "follow-up"; times: number; question: string; previous: string | null;
  expected: { outcome: "answer" | "clarify" | "decline" | "exclude"; source: string | null; about?: string; about_any?: string[]; source_any?: string[]; reason?: string;
    /** The period the answer must show: from and to as "YYYY" or "YYYY-MM", to "latest" for the release's last month; or a span not checked here. */
    period?: { from?: string; to?: string; span?: string };
    /** A ranking shows exactly this many rows. */
    top_n?: number;
    /** Every place shown has at least this population. */
    min_population?: number;
    /** The sentence a decline must say; "<...>" stands for any words (a place, a crime). */
    wording?: string };
  label: { status: string; rule: string; notes?: string } };
export type Got = { kind: string; source: string | null; about?: string; reason?: string; ms: number; digest?: string; via?: string; read?: string;
  /** What the answer's table shows: its first and last period, its rows, its smallest population (null: no population column). */
  period?: { from: string; to: string }; rows?: number; minPop?: number | null;
  /** Some place shown has no population (so min_population cannot be confirmed). */
  popGaps?: boolean;
  /** The release's last month ("YYYY-MM"), for a label's period to "latest". */
  latest?: string;
  /** The sentence a decline said. */
  text?: string };

/**
 * Whether an answer shows what the label's period, top_n and min_population ask for: "ok", "miss" (it shows something
 * else: a wrong answer whatever its numbers), or "unknown" (the run did not record it, so it cannot be correct).
 */
export function shapeCheck(e: Label["expected"], g: Got): "ok" | "miss" | "unknown" {
  let unknown = false;
  const p = e.period;
  // Compared as months: a year starts in its January and ends in its December ("2024" = "2024-01" to "2024-12").
  const start = (s: string) => (/^\d{4}$/.test(s) ? `${s}-01` : s);
  const end = (s: string) => (/^\d{4}$/.test(s) ? `${s}-12` : s);
  if (p && (p.from || p.to)) {
    if (!g.period) unknown = true;
    else {
      if (p.from && start(g.period.from) !== start(p.from)) return "miss";
      const to = p.to === "latest" ? g.latest : p.to;
      if (p.to && !to) unknown = true;
      else if (to && end(g.period.to) !== end(to)) return "miss";
    }
  }
  if (e.top_n !== undefined) {
    if (g.rows === undefined) unknown = true;
    else if (g.rows !== e.top_n) return "miss";
  }
  if (e.min_population !== undefined) {
    // A known population under the floor is a miss; a place with none leaves it unconfirmed.
    if (typeof g.minPop === "number" && g.minPop < e.min_population) return "miss";
    if (typeof g.minPop !== "number" || g.popGaps !== false) unknown = true;
  }
  return unknown ? "unknown" : "ok";
}

export type Table = { columns?: { binding?: { kind?: string; dimension?: string }; header?: string }[]; rows?: unknown[][] };
/**
 * What an answer's table shows, for the labels' period, top_n and min_population: the first and last period (the time
 * column's values, or year/month column headers when the periods run across), the row count, the smallest population.
 */
export function tableShape(t: Table | undefined, latest: string): Pick<Got, "period" | "rows" | "minPop" | "popGaps" | "latest"> {
  if (!t || !Array.isArray(t.rows)) return { latest };
  const cols = t.columns ?? [];
  const isPeriod = (s: string) => /^\d{4}(?:-\d{2})?$/.test(s);
  const ti = cols.findIndex((c) => c.binding?.kind === "grouping" && /^time\./.test(c.binding.dimension ?? ""));
  const periods = (ti >= 0 ? t.rows.map((r) => String(r[ti] ?? "")) : cols.map((c) => String(c.header ?? ""))).filter(isPeriod).sort();
  const pi = cols.findIndex((c) => /^population$/i.test(String(c.header ?? "").trim()));
  const cells = pi >= 0 ? t.rows.map((r) => r[pi]) : [];
  const pops = cells.filter((v): v is number => typeof v === "number");
  return {
    ...(periods.length ? { period: { from: periods[0], to: periods[periods.length - 1] } } : {}),
    rows: t.rows.length, minPop: pops.length ? Math.min(...pops) : null, popGaps: pops.length < cells.length, latest,
  };
}

const RECORDED = ["period", "rows", "minPop", "popGaps", "latest", "text"] as const;
/**
 * Whether two runs' outcomes are the same, where they came from aside. A field one run did not record (an older
 * progress file) is left out; recorded by both, it is compared (a year header can change while the rows' digest does not).
 */
export function sameOutcome(a: Got | null, b: Got | null): boolean {
  const strip = (g: Got | null, other: Got | null) => {
    if (!g) return g;
    const s: Record<string, unknown> = { ...g, ms: 0, via: undefined, read: undefined };
    for (const k of RECORDED) if (!other || other[k] === undefined) s[k] = undefined;
    return s;
  };
  return JSON.stringify(strip(a, b)) === JSON.stringify(strip(b, a));
}

const plain = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
/** Whether a decline said the label's sentence ("<...>" matches any words; case, quotes and spacing aside). */
export function wordingMatches(want: string, said: string): boolean {
  const parts = plain(want).split(/<[^>]*>/).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".+?")}$`).test(plain(said));
}
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
    if (kind === "answer") {
      // A coverage reply (data coverage, sources, definitions) fits only a label that expects methodology or nibrs, and no check
      // of its numbers exists: always unverified. Any other label source is a wrong answer.
      if (g.source === "coverage") return e.source === "methodology" || e.source === "nibrs" || (e.source_any ?? []).some((x) => x === "methodology" || x === "nibrs") ? "unverified" : miss("wrong answer");
      if (!okSource(g.source)) return miss("wrong answer");
      // The right numbers for the wrong period, or too many places, are a wrong answer.
      const shape = shapeCheck(e, g);
      if (shape === "miss") return miss("wrong answer");
      return shape === "ok" && g.digest && VERIFIED[l.id]?.digest === g.digest ? "correct" : "unverified";
    }
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
  // A decline: any plain decline or route away is a decline. Where the label gives the sentence, the decline must say it
  // (a route says no sentence, and an older run recorded none: neither can be correct).
  if (e.wording !== undefined && (kind === "decline" || kind === "route")) {
    if (kind === "route" || g.text === undefined) return "unverified";
    return wordingMatches(e.wording, g.text) ? "correct" : miss("bad decline");
  }
  if (kind === "decline" || kind === "route") return "correct";
  return miss(kind === "answer" ? "wrong answer" : "wrong clarify");
}
