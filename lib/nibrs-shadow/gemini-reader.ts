/**
 * The Gemini reader (plan 3, B+C; docs/superpowers/specs/2026-11-09-gemini-reader.md). For a question the pattern
 * reader can't fully read, Gemini proposes a replacement for each span of words the reader left unread ("killings" ->
 * a measure, "San fran" -> a place, "broken out by race of the killers" -> a breakdown). Everything else in the question
 * stays the user's own words, read by the pattern reader as always. The engine accepts the replacements only when:
 *   - each span is the question's own words, found once, and each replacement is from the plan language's vocabulary
 *     for its kind, grounded in the span (a year written in it; whose attribute named in it; a state named in it);
 *   - Gemini left nothing unhandled;
 *   - the rewritten question reads in full (nothing unread), keeps every part the original question already read
 *     (none lost or changed), and gains only parts of the kinds the replacements declared.
 * Then the engine answers the rewritten question by its normal path (a follow-up's by its normal follow-up path, with
 * the previous question as state). Any refusal keeps today's outcome. Gemini never produces numbers.
 * (Codex review 01 of the first design, a full reading checked by evidence substrings: a reading could quote real words
 * and still misread them, and quoted words could hide conditions. Here the user's words carry everything Gemini doesn't
 * replace, and the pattern reader reads them.)
 */
import { createHash } from "node:crypto";
import { readQuestion } from "./reading";
import { STATE_NAMES } from "./places";

export const READER_MODEL_ID = "gemini-3.8-flash";
export const READER_PROMPT_VERSION = "gr-5-withhold1";   // what is withheld is part of what was sent: an older cache never loads
/**
 * The output cap and thinking level (the model rewriter's, proven with this model). Thinking is billed as output and
 * isn't capped by the level, so the fetch reserves an allowance for it: 4,096 tokens, twice the most this model used at
 * "low" over the model rewriter's 2,102 calls (1,963); a response that costs more than its reservation stops the run.
 */
export const READER_GENERATION = { temperature: 0, maxOutputTokens: 1024, thinkingLevel: "low", thinkingAllowance: 4096 } as const;

export type Kind = "measure" | "place" | "period" | "breakdown" | "statistic" | "unit" | "spelling";
export type Breakdown = "year" | "month" | "quarter" | "race" | "sex" | "age" | "ethnicity" | "weapon" | "location" | "relationship" | "offense";
export type Replacement = {
  /** The exact words of the question replaced (contiguous, copied). */
  span: string;
  kind: Kind;
  measure?: string | null;
  place?: string | null;
  period?: { kind: "year" | "range" | "years" | "since"; years: number[] } | null;
  breakdown?: { value: Breakdown; person: "victim" | "offender" | "arrestee" | null } | null;
  statistic?: "rate" | "percent_change" | "share" | null;
  unit?: "victims" | "offenses" | "offenders" | "arrests" | "incidents" | null;
  /** The correct spelling of a misspelled word (kind "spelling"): the pattern reader then reads it. */
  spelling?: string | null;
};
export type Proposal = { replacements: Replacement[]; unhandled: string[] };

/** The measures a replacement may name, with the words the pattern reader reads as each (singular, plural). */
export const MEASURE_WORDS: Record<string, [string, string]> = {
  murder: ["murder", "murders"], homicide: ["homicide", "homicides"], rape: ["rape", "rapes"], robbery: ["robbery", "robberies"],
  aggravated_assault: ["aggravated assault", "aggravated assaults"], simple_assault: ["simple assault", "simple assaults"],
  intimidation: ["intimidation", "intimidation"], burglary: ["burglary", "burglaries"], theft: ["theft", "thefts"],
  shoplifting: ["shoplifting", "shoplifting"], motor_vehicle_theft: ["motor vehicle theft", "motor vehicle thefts"],
  carjacking: ["carjacking", "carjackings"], arson: ["arson", "arsons"], violent_crime: ["violent crime", "violent crime"],
  property_crime: ["property crime", "property crime"], sex_offense: ["sex offense", "sex offenses"],
};
const BREAKDOWNS: Breakdown[] = ["year", "month", "quarter", "race", "sex", "age", "ethnicity", "weapon", "location", "relationship", "offense"];
const PERSON_ATTRS = new Set<Breakdown>(["race", "sex", "age", "ethnicity"]);
/** Words that say whose attribute it is, in the span itself; a person is accepted only with one of them. */
const PERSON_WORDS: Record<"victim" | "offender" | "arrestee", RegExp> = {
  victim: /\b(?:victims?|killed|dead|deceased)\b/i,
  offender: /\b(?:offenders?|suspects?|perpetrators?|killers?|shooters?|attackers?|assailants?|murderers?|robbers?)\b/i,
  arrestee: /\b(?:arrestees?|arrested|arrests?)\b/i,
};
/** The concepts each kind may add to the reading. */
const ADDS: Record<Kind, string[]> = {
  measure: ["measure"], place: ["place"], period: ["period"], breakdown: ["breakdown", "grain"],
  statistic: ["statistic", "share", "change"], unit: ["unit"],
  // A corrected spelling is the user's own word: the pattern reader decides what it adds (checked against nothing lost).
  spelling: [],
};

// ------------------------------------------------------------------------------------------------- the prompt
export const READER_SYSTEM_PROMPT = `A crime-data question reader read some of a user's words and could not read others. For each span of words it could not read, you propose what that span means in the reader's vocabulary. You never answer the question and never give numbers.

You get the question and the spans the reader could not read. For each such span you can map, return a replacement:
- span: the exact words of the question you replace, copied (some or all of the words of one unread span; never words the reader already read).
- kind and its value:
  - measure: one of ${Object.keys(MEASURE_WORDS).join(", ")}. "homicide" and "murder" are different: use what the words say ("killings" is murder).
  - place: the city, county, state or "the United States" the words name, as named; add a state only if the span itself names it.
  - period: { kind, years }: kind "year", "range" (both ends written), "since" (a start year written), or "years" (separate years). Every year must be written as a number in the span.
  - breakdown: { value, person }: value one of ${BREAKDOWNS.join(", ")}; person victim, offender or arrestee only when the span says whose.
  - statistic: rate (per population), percent_change, or share (percent of a total).
  - unit: victims, offenses, offenders, arrests or incidents.
  - spelling: the correct spelling of one misspelled word (the span is that one word, e.g. "aggravates" -> "aggravated", "comparied" -> "compared"). Only an obvious typo of the word the user meant; never a different word.
- unhandled: every unread word or phrase that is a condition, qualifier or request you could not map (for example "unsolved", "near schools", "predict", "why", "compared to the national average"). Leave a span out of replacements rather than map it loosely.`;

export const READER_FOLLOW_UP_PROMPT = `${READER_SYSTEM_PROMPT}

The question is a follow-up to a previous question, given for context only. Replace spans of the follow-up only.`;

const opt = (t: Record<string, unknown>) => ({ ...t, nullable: true });
export const READER_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    replacements: { type: "ARRAY", items: { type: "OBJECT", properties: {
      span: { type: "STRING" },
      kind: { type: "STRING", enum: ["measure", "place", "period", "breakdown", "statistic", "unit", "spelling"] },
      measure: opt({ type: "STRING", enum: Object.keys(MEASURE_WORDS) }),
      place: opt({ type: "STRING" }),
      period: opt({ type: "OBJECT", properties: { kind: { type: "STRING", enum: ["year", "range", "years", "since"] }, years: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["kind", "years"] }),
      breakdown: opt({ type: "OBJECT", properties: { value: { type: "STRING", enum: BREAKDOWNS }, person: { type: "STRING", nullable: true, enum: ["victim", "offender", "arrestee"] } }, required: ["value"] }),
      statistic: opt({ type: "STRING", enum: ["rate", "percent_change", "share"] }),
      unit: opt({ type: "STRING", enum: ["victims", "offenses", "offenders", "arrests", "incidents"] }),
      spelling: opt({ type: "STRING" }),
    }, required: ["span", "kind"] } },
    unhandled: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["replacements", "unhandled"],
} as const;

/** The words the pattern reader left unread in a question (sent to Gemini). */
export function unreadSpans(question: string, currentYear: number): string[] {
  return readQuestion(question, currentYear).ledger.parts.filter((p) => p.clause === 0 && (p.concept === "unrecognized" || p.state === "not-interpreted")).map((p) => p.text.trim()).filter(Boolean);
}
export const readerUserPrompt = (question: string, unread: string[]) => `Question: ${question}\nUnread spans: ${JSON.stringify(unread)}`;
export const readerFollowUpPrompt = (previous: string, followUp: string, unread: string[]) => `Previous question (context only): ${previous}\nFollow-up: ${followUp}\nUnread spans of the follow-up: ${JSON.stringify(unread)}`;

/** Identity of a cached proposal: the model, prompt, generation and schema. */
export const readerBinding = () => createHash("sha256").update(JSON.stringify([READER_MODEL_ID, READER_PROMPT_VERSION, READER_SYSTEM_PROMPT, READER_FOLLOW_UP_PROMPT, READER_RESPONSE_SCHEMA, READER_GENERATION])).digest("hex");
export const readerKey = (question: string, previous?: string | null) => createHash("sha256").update(JSON.stringify([previous?.trim() ?? null, question.trim()])).digest("hex");

// ------------------------------------------------------------------------------------------------- validation
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
const STATE_WORDS = new Set([...Object.values(STATE_NAMES).map((n) => n.toLowerCase()), ...Object.keys(STATE_NAMES).map((a) => a.toLowerCase())]);

/**
 * What a span must say for a unit or statistic (Codex review 02.3: "per household" is not a population rate, "families"
 * are not victims): a word for it in the span itself.
 */
const UNIT_WORDS: Record<NonNullable<Replacement["unit"]>, RegExp> = {
  victims: /\b(?:victims?|killed|dead|people|persons?|individuals?)\b/i, offenders: PERSON_WORDS.offender, arrests: /\barrest/i,
  offenses: /\b(?:offen[cs]es?|crimes?|charges?)\b/i, incidents: /\b(?:incidents?|events?|cases?)\b/i,
};
const STAT_WORDS: Record<NonNullable<Replacement["statistic"]>, RegExp> = {
  rate: /\b(?:per[-\s]?capita|capita|population|residents?|people|persons?|inhabitants|100[, ]?000|1[, ]?000|100k)\b|\bper\s+(?:\d|ten\b|one\b|a\s+(?:thousand|million))/i,
  share: /%|\b(?:percent(?:age)?|share|proportion|portion|fraction)\b/i,
  percent_change: /\b(?:change[ds]?|increase[ds]?|decrease[ds]?|rose|rise|risen|fell|fall|fallen|drop(?:ped)?|gr[eo]w|grown|jump(?:ed)?|declin\w*)\b/i,
};
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;
/** Edits (insert, delete, substitute, swap two neighbours) from one word to another. */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

/** The words a replacement puts in place of its span; null when its value isn't in the vocabulary or not grounded. */
export function replacementText(r: Replacement): string | null {
  const span = norm(r.span ?? "");
  if (!span) return null;
  switch (r.kind) {
    // A measure's span is the crime's own word or two ("slayings", "agg assaults"), never a phrase that could carry a
    // condition ("slayings near schools": Codex review 02.1).
    case "measure": return r.measure && MEASURE_WORDS[r.measure] && wordCount(span) <= 2 ? MEASURE_WORDS[r.measure][1] : null;
    case "unit": return r.unit && wordCount(span) <= 2 && UNIT_WORDS[r.unit]?.test(r.span) ? r.unit : null;
    case "statistic": {
      if (!r.statistic || !STAT_WORDS[r.statistic]?.test(r.span) || wordCount(span) > 4) return null;
      return r.statistic === "rate" ? "rate" : r.statistic === "share" ? "share of" : "percent change in";
    }
    case "place": {
      const name = (r.place ?? "").trim();
      if (!name || /\d/.test(name)) return null;
      // Every word of the span starts a word of the name, or names its state ("san fran" is San Francisco; "downtown"
      // is not part of any name, so "downtown San fran" is refused: Codex review 02.2).
      const nameWords = norm(name).replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
      if (!span.replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean).every((w) => nameWords.some((n) => n.startsWith(w)) || STATE_WORDS.has(w))) return null;
      // A state only when the span itself names it as a whole word (never from Gemini's knowledge: "Portland" stays
      // Portland, asked about; "in" is never Indiana: a state's two letters count only in capitals in the span).
      const m = /^(.*?),\s*([^,]+)$/.exec(name);
      if (!m) return name;
      const st = norm(m[2]), spanWords = ` ${r.span.replace(/[^A-Za-z ]/g, " ").replace(/\s+/g, " ")} `;
      const named = STATE_WORDS.has(st) && (st.length === 2 ? spanWords.includes(` ${st.toUpperCase()} `) : ` ${span.replace(/[^a-z ]/g, " ")} `.includes(` ${st} `));
      return named ? name : m[1].trim() || null;
    }
    case "period": {
      const p = r.period;
      if (!p || !p.years?.length || p.years.some((y) => !Number.isInteger(y) || !new RegExp(`\\b${y}\\b`).test(span))) return null;
      if ((p.kind === "year" || p.kind === "since") && p.years.length !== 1) return null;
      if (p.kind === "range" && p.years.length !== 2) return null;
      if (p.kind === "years" && p.years.length < 2) return null;
      return p.kind === "year" ? `in ${p.years[0]}` : p.kind === "since" ? `since ${p.years[0]}` : p.kind === "range" ? `from ${p.years[0]} to ${p.years[1]}`
        : `in ${p.years.slice(0, -1).join(", ")} and ${p.years[p.years.length - 1]}`;
    }
    case "spelling": {
      // One word for one word, letters only, at least four of them, within two edits and a quarter of its length
      // ("aggravates" -> "aggravated", "comparied" -> "compared"); never the same word.
      const from = span, to = norm(r.spelling ?? "");
      if (!/^[a-z]{4,}$/.test(from) || !/^[a-z]+$/.test(to) || from === to) return null;
      // The first two letters stay: a prefix added, dropped or changed turns a word into another ("unreported" ->
      // "reported", "deported" -> "reported", "unrelated" -> "related": Codex review 08), never a typo of it.
      if (from.slice(0, 2) !== to.slice(0, 2)) return null;
      const d = editDistance(from, to);
      return d <= 2 && d <= Math.max(1, Math.floor(from.length / 4)) ? to : null;
    }
    case "breakdown": {
      const b = r.breakdown;
      if (!b || !BREAKDOWNS.includes(b.value)) return null;
      if (!PERSON_ATTRS.has(b.value)) return b.person ? null : ["year", "month", "quarter"].includes(b.value) ? `by ${b.value}` : b.value === "offense" ? "by offense type" : `by ${b.value}`;
      if (b.person && !PERSON_WORDS[b.person].test(r.span)) return null;
      return `by ${b.person ? `${b.person} ` : ""}${b.value}`;
    }
  }
  return null;
}

export type Verdict = { ok: true; question: string } | { ok: false; reason: string };
type Part = { concept: string; value: string | null; clause: number; state: string; text?: string };
const keyOf = (p: Part) => `${p.concept}=${p.value}`;
/** The ledger's own bookkeeping; every other key is a condition or setting the reader read (clearance, circumstance, ...). */
const BOOKKEEPING = new Set(["parts", "question", "text", "obligations", "finalized", "taken", "readings"]);
function readParts(q: string, year: number) {
  const l = readQuestion(q, year).ledger as unknown as Record<string, unknown> & { parts: Part[] };
  const flags = Object.fromEntries(Object.entries(l).filter(([k]) => !BOOKKEEPING.has(k)).map(([k, v]) => [k, JSON.stringify(v ?? null)]));
  return { parts: l.parts.filter((p) => p.clause === 0), flags };
}
const counts = (ps: Part[]) => ps.filter((x) => x.state === "recognized").reduce((m, x) => m.set(keyOf(x), (m.get(keyOf(x)) ?? 0) + 1), new Map<string, number>());

/**
 * Accepts Gemini's replacements only when the rewritten question reads in full, keeps everything the original read,
 * and gains only what the replacements declared; returns the rewritten question (a follow-up's: the rewritten follow-up).
 */
export function validateProposal(p: Proposal | null, question: string, currentYear: number): Verdict {
  if (!p || !Array.isArray(p.replacements)) return { ok: false, reason: "no proposal" };
  if ((p.unhandled ?? []).some((u) => norm(String(u)))) return { ok: false, reason: "unhandled" };
  if (!p.replacements.length) return { ok: false, reason: "no replacements" };
  const unread = unreadSpans(question, currentYear).map(norm);
  let text = question;
  for (const r of p.replacements) {
    const words = replacementText(r);
    if (words === null) return { ok: false, reason: `${r.kind}: not in the vocabulary or not in its words` };
    // The span lies inside one stretch of words the reader left unread (never across words it read: "downtown Memphis"
    // can't become Memphis; Codex review 02.2).
    // The refinement (a breakdown naming whose) may also cover the "by race" the reader read; its other words, each
    // stretch, still lie in unread words.
    const chunks = r.kind === "breakdown" && r.breakdown?.person
      ? norm(r.span ?? "").split(new RegExp(`\\bby\\s+(?:the\\s+)?${r.breakdown.value}\\b`, "i")).map((c) => c.trim()).filter(Boolean)
      : [norm(r.span ?? "")];
    if (!chunks.every((c) => unread.some((u) => u.includes(c)))) return { ok: false, reason: "span not within unread words" };
    // The span is the question's own contiguous words, found exactly once, case aside.
    const esc = (r.span ?? "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    if (!esc) return { ok: false, reason: "span not found once" };
    const src = `(?<![\\w])${esc}(?![\\w])`;
    if ((text.match(new RegExp(src, "gi")) ?? []).length !== 1) return { ok: false, reason: "span not found once" };
    text = text.replace(new RegExp(src, "i"), words);
  }
  const before = readParts(question, currentYear), after = readParts(text, currentYear);
  if (after.parts.some((x) => x.concept === "unrecognized" || x.state === "not-interpreted")) return { ok: false, reason: "still unread" };
  // Everything the original read is still read, the same (the replacements touched only unread words).
  const b = counts(before.parts), a = counts(after.parts);
  // One refinement only: a breakdown the reader read ("by race") may become the same breakdown with whose it is ("by race
  // of the killers" -> by offender race), when its span holds both and names the person.
  const refined = (k: string) => p.replacements.some((r) => r.kind === "breakdown" && !!r.breakdown?.person && k === `breakdown=${r.breakdown.value}`
    && new RegExp(`\\b${r.breakdown.value}\\b`, "i").test(r.span));
  // And a corrected spelling may join a part the reader read into a longer one of the same kind ("aggravates assaults":
  // "assaults" read as assault becomes "aggravated assaults", aggravated assault), when the new part's words hold both
  // the corrected word and the old part's words.
  const spellings = p.replacements.filter((r) => r.kind === "spelling").map((r) => norm(r.spelling ?? ""));
  const joined = (k: string) => {
    const old = before.parts.find((x) => x.state === "recognized" && keyOf(x) === k);
    if (!old || !spellings.length) return false;
    return after.parts.some((x) => x.state === "recognized" && x.concept === old.concept && keyOf(x) !== k
      && spellings.some((w) => new RegExp(`\\b${w}\\b`).test(norm(x.text ?? ""))) && norm(x.text ?? "").includes(norm(old.text ?? "")));
  };
  for (const [k, n] of b) if ((a.get(k) ?? 0) < n && !refined(k) && !joined(k)) return { ok: false, reason: "a part the reader read was lost or changed" };
  // What is new is only what the replacements declared.
  const allowed = new Set(p.replacements.flatMap((r) => ADDS[r.kind]));
  // A corrected spelling is the user's word: what it adds is the pattern reader's reading of it, whatever its kind.
  const spelled = p.replacements.some((r) => r.kind === "spelling");
  for (const [k, n] of a) if (n > (b.get(k) ?? 0) && !spelled && !allowed.has(k.split("=")[0])) return { ok: false, reason: `gained an undeclared ${k.split("=")[0]}` };
  // Every condition or setting the reader read ("unsolved" is a clearance setting, not a part) is unchanged, except one a
  // replacement declares where there was none: a comparison (percent change), whose attribute (people), quarters.
  const declared: Record<string, boolean> = {
    comparison: p.replacements.some((r) => r.kind === "statistic" && r.statistic === "percent_change"),
    people: p.replacements.some((r) => r.kind === "breakdown" && !!r.breakdown?.person),
    quarter: p.replacements.some((r) => r.kind === "breakdown" && r.breakdown?.value === "quarter"),
  };
  const unset = new Set(["null", "false", "[]", "\"\""]);
  for (const k of new Set([...Object.keys(before.flags), ...Object.keys(after.flags)])) {
    const was = before.flags[k] ?? "null", now = after.flags[k] ?? "null";
    // A bare "by race" asks victims or offenders; a span naming whose answers that ask (and nothing else about people).
    const bareAsk = k === "people" && was === JSON.stringify({ by: null, where: [], ask: "victims or offenders" });
    // A corrected spelling may switch a setting on (the user's own word read), never change or clear one already set.
    if (was !== now && !((declared[k] || spelled) && (unset.has(was) || bareAsk))) return { ok: false, reason: `the reader's ${k} was lost or changed` };
  }
  return { ok: true, question: text };
}

// ------------------------------------------------------------------------------------------------- when to call
/** Declines that are the reader's, not policy's: the words weren't understood, or a place wasn't found. */
const READER_DECLINES = new Set(["reader", "unresolved_place"]);
/**
 * Whether Gemini is consulted (the coordinator for Jeff, 2026-11-09): only when the engine doesn't answer, a decline is
 * the reader's own and not a policy decision (forecast, court, not recorded, unsupported, outside the data: Codex review
 * 01.4), the question carries no policy flag, and the reader left the question's words unread (so there is something
 * to replace). For a follow-up, the words are the follow-up's.
 */
export function qualifies(question: string, outcome: { kind: string; reason?: string | null }, currentYear: number): boolean {
  if (outcome.kind === "decline") { if (!READER_DECLINES.has(outcome.reason ?? "")) return false; }
  else if (outcome.kind !== "clarify") return false;
  const l = readQuestion(question, currentYear).ledger as ReturnType<typeof readQuestion>["ledger"] & { forecast?: boolean; court?: boolean; undefinedTerm?: string | null };
  if (l.forecast || l.court || l.undefinedTerm) return false;
  const parts = l.parts.filter((p) => p.clause === 0);
  if (parts.some((p) => p.state === "not-recorded")) return false;
  return parts.some((p) => p.concept === "unrecognized" || p.state === "not-interpreted");
}

// ------------------------------------------------------------------------------------------------- personal details
/**
 * Whether a question may hold a personal detail (an email, a phone number, an address, a ZIP). Such a question (or a
 * follow-up whose previous question is one) is withheld: never sent to Google, never cached; it keeps today's outcome.
 * A blunt rule (the coordinator, 2026-11-09, after five review rounds of address patterns): over-withholding costs
 * little, since a withheld question keeps today's outcome. Withheld when the question has
 *   - an at sign ("@" or a full-width one);
 *   - seven or more digits in a row once spaces, dots, dashes and parentheses are taken out;
 *   - any number other than a four-digit year from 1900 to 2099, a percent, or a number of one or two digits;
 *   - "box", "apt", "suite" or "unit" next to a number.
 */
export function looksPersonal(text: string): boolean {
  if (/[@＠﹫]/.test(text)) return true;
  const t = text.normalize("NFKC");
  // Any space, dot, parenthesis or dash character (Unicode hyphens too: Codex review 16) is a separator.
  if (/\d{7,}/.test(t.replace(/[\s.()\p{Pd}]/gu, ""))) return true;
  // A number with its decimals is one number ("123.45%" is a percent: Codex review 16).
  for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) {
    const n = m[0].split(".")[0];
    if (n.length <= 2) continue;
    if (/^(?:19|20)\d\d$/.test(n)) continue;
    if (/^\s*(?:%|percent\b)/i.test(t.slice(m.index! + m[0].length))) continue;
    return true;
  }
  return /\b(?:box|apt|suite|unit)\b\.?\s*#?\s*\d|\d\s*#?\s*(?:box|apt|suite|unit)\b/i.test(t);
}
