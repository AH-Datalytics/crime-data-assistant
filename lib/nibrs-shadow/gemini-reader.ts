/**
 * The Gemini reader (plan 3, B+C; docs/superpowers/specs/2026-11-09-gemini-reader.md). Gemini proposes a reading in
 * the plan language's terms for a question the pattern reader can't fully read; the engine accepts it only when every
 * field is grounded in the question's own words, nothing is left unhandled, every content word is accounted for, and
 * the reading, written back as a canonical question in the reader's own grammar, reads back exactly. Then the engine
 * answers the canonical question by its normal path. Any refusal keeps today's outcome. Gemini never produces numbers.
 */
import { createHash } from "node:crypto";
import { readQuestion } from "./reading";
import { STATE_NAMES } from "./places";

export const READER_MODEL_ID = "gemini-3.8-flash";
export const READER_PROMPT_VERSION = "gr-1";
export const READER_GENERATION = { temperature: 0, maxOutputTokens: 1024, thinkingLevel: "low" } as const;

/** Where a field's words come from: the question itself, or (a follow-up's state) the previous question. */
export type From = "question" | "previous";
type Field<T> = T & { evidence: string; from?: From };
export type Reading = {
  measure: Field<{ id: string }> | null;
  unit: Field<{ value: "victims" | "offenses" | "offenders" | "arrests" | "incidents" }> | null;
  places: Field<{ name: string }>[];
  period: Field<{ kind: "year" | "range" | "years" | "since"; years: number[] }> | null;
  breakdowns: Field<{ value: Breakdown; person: "victim" | "offender" | "arrestee" | null }>[];
  statistic: Field<{ value: "count" | "rate" | "percent_change" | "share" }> | null;
  /** Every condition or word Gemini could not put in a field. Any at all refuses the reading. */
  unhandled: string[];
};
export type Breakdown = "year" | "month" | "quarter" | "race" | "sex" | "age" | "ethnicity" | "weapon" | "location" | "relationship" | "offense";

/** The measures a reading may name, with the words the pattern reader reads as each (singular, plural). */
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

// ------------------------------------------------------------------------------------------------- the prompt
export const READER_SYSTEM_PROMPT = `You turn one question about U.S. crime data into a structured reading. You never answer it and never give numbers.

Return JSON with these fields. Every field you fill must quote, in "evidence", the exact words of the question it comes from (copied, not paraphrased). Leave a field null (or the list empty) when the question doesn't say it; never fill a field from your own knowledge or a default.
- measure: { id, evidence }: id is one of ${Object.keys(MEASURE_WORDS).join(", ")}. "homicide" and "murder" are different ids: use the one the question says ("killings" or "people killed" is murder).
- unit: { value, evidence } when the question names what is counted: victims, offenses, offenders, arrests, incidents.
- places: [{ name, evidence }] each city, county, state or "United States" the question names, as named (add the state only if the question gives it).
- period: { kind, years, evidence }: kind "year" (one year), "range" (first and last year written, e.g. "from 2019 to 2023"), "since" (one start year, e.g. "since 2018"), or "years" (a list of separate years). Years must be written in the question as numbers.
- breakdowns: [{ value, person, evidence }] each "by ..." the question asks: value one of ${BREAKDOWNS.join(", ")}; person is victim, offender or arrestee only when the question says whose (else null).
- statistic: { value, evidence }: count, rate (per population), percent_change, or share (percent of a total). Null for a plain count.
- unhandled: every other condition, qualifier or request in the question you could not put in a field above (for example "unsolved", "with a gun", "near schools", "predict", "why", "compared to the national average"), as the question words them. Leave it empty only when nothing else is asked.`;

export const READER_FOLLOW_UP_PROMPT = `${READER_SYSTEM_PROMPT}

This question is a follow-up. You get the previous question too. Return the full reading the follow-up asks for: keep the previous question's fields the follow-up doesn't change, and replace what it changes ("same for Dallas" replaces the places; "as a rate" sets the statistic). Each field also has "from": "question" when its evidence is in the follow-up, "previous" when it is kept from the previous question (evidence quoted from the previous question). "unhandled" lists only what the follow-up itself asks that you could not put in a field.`;

const field = (props: Record<string, unknown>, required: string[]) => ({ type: "OBJECT", nullable: true, properties: { ...props, evidence: { type: "STRING" }, from: { type: "STRING", enum: ["question", "previous"] } }, required: [...required, "evidence"] });
export const READER_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    measure: field({ id: { type: "STRING", enum: Object.keys(MEASURE_WORDS) } }, ["id"]),
    unit: field({ value: { type: "STRING", enum: ["victims", "offenses", "offenders", "arrests", "incidents"] } }, ["value"]),
    places: { type: "ARRAY", items: field({ name: { type: "STRING" } }, ["name"]) },
    period: field({ kind: { type: "STRING", enum: ["year", "range", "years", "since"] }, years: { type: "ARRAY", items: { type: "INTEGER" } } }, ["kind", "years"]),
    breakdowns: { type: "ARRAY", items: field({ value: { type: "STRING", enum: BREAKDOWNS }, person: { type: "STRING", nullable: true, enum: ["victim", "offender", "arrestee"] } }, ["value"]) },
    statistic: field({ value: { type: "STRING", enum: ["count", "rate", "percent_change", "share"] } }, ["value"]),
    unhandled: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["places", "breakdowns", "unhandled"],
} as const;
export const readerUserPrompt = (question: string) => `Question: ${question}`;
export const readerFollowUpPrompt = (previous: string, followUp: string) => `Previous question: ${previous}\nFollow-up: ${followUp}`;

/** Identity of a cached reading: the model, prompt, generation and the words sent. */
export const readerBinding = () => createHash("sha256").update(JSON.stringify([READER_MODEL_ID, READER_PROMPT_VERSION, READER_SYSTEM_PROMPT, READER_FOLLOW_UP_PROMPT, READER_RESPONSE_SCHEMA, READER_GENERATION])).digest("hex");
export const readerKey = (question: string, previous?: string | null) => createHash("sha256").update(JSON.stringify([previous?.trim() ?? null, question.trim()])).digest("hex");

// ------------------------------------------------------------------------------------------------- validation
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
/** Words that ask for data without saying which (never a condition). Content words are anything else. */
const FILLER = new Set(("show me give list get display provide find pull what what's whats which is are was were be been the a an of for in on at to " +
  "from and or how many much number numbers total totals count counts data stats statistics statistic figures info information please can could would " +
  "you i i'd id want like need see tell about there their has have had did do does by with all any also during per its it this that these those " +
  "reported report reports recorded happened occur occurred crimes crime nibrs fbi " +
  // Words that only introduce a breakdown the evidence names ("broken out by race of the killers").
  "broken break breakdown down out split separated grouped " +
  // Words that only point a follow-up back at the previous question ("same for Dallas", "now as a rate").
  "same now instead then but ok okay again too").split(" "));

export type Verdict = { ok: true; question: string } | { ok: false; reason: string };

/**
 * Accepts a reading only when it is grounded, complete and reads back exactly; returns the canonical question the
 * engine then answers by its normal path. `previous` is a follow-up's previous question (its state).
 */
export function validateReading(r: Reading | null, question: string, previous: string | null, currentYear: number): Verdict {
  if (!r) return { ok: false, reason: "no reading" };
  if ((r.unhandled ?? []).some((u) => norm(u))) return { ok: false, reason: "unhandled" };
  const q = norm(question), prev = norm(previous ?? "");
  const fields = [r.measure, r.unit, ...(r.places ?? []), r.period, ...(r.breakdowns ?? []), r.statistic].filter((f): f is NonNullable<typeof f> => !!f);
  // Grounding: each field's words are in the text it says they come from (the previous question only for a follow-up).
  for (const f of fields) {
    const ev = norm(f.evidence ?? "");
    const from = f.from === "previous" && previous ? prev : q;
    if (!ev || !` ${from} `.includes(` ${ev} `)) return { ok: false, reason: "ungrounded" };
    if (f.from === "previous" && !previous) return { ok: false, reason: "ungrounded" };
  }
  // Coverage: every content word of the question is in some field's evidence from the question.
  const covered = new Set(fields.filter((f) => f.from !== "previous").flatMap((f) => norm(f.evidence).split(" ")));
  const left = q.split(" ").filter((w) => w && !FILLER.has(w) && !covered.has(w));
  if (left.length) return { ok: false, reason: "uncovered" };
  if (!r.measure || !MEASURE_WORDS[r.measure.id]) return { ok: false, reason: "no measure" };
  // The measure's own words, where the pattern reader reads them as a measure, must read as the same one ("homicides"
  // is homicide, never murder).
  const own = readQuestion(r.measure.evidence, currentYear).ledger.parts.filter((p) => p.concept === "measure").map((p) => p.value);
  if (own.length && !own.includes(r.measure.id)) return { ok: false, reason: "measure words read as another measure" };
  // Years: written in the evidence, and a range has its two ends.
  if (r.period) {
    const ys = r.period.years ?? [];
    if (!ys.length || ys.some((y) => !Number.isInteger(y) || !norm(r.period!.evidence).includes(String(y)) || y > currentYear)) return { ok: false, reason: "period" };
    if (r.period.kind === "range" && ys.length !== 2) return { ok: false, reason: "period" };
    if ((r.period.kind === "year" || r.period.kind === "since") && ys.length !== 1) return { ok: false, reason: "period" };
  }
  for (const b of r.breakdowns ?? []) {
    if (!BREAKDOWNS.includes(b.value)) return { ok: false, reason: "breakdown" };
    if (b.person && !PERSON_ATTRS.has(b.value)) return { ok: false, reason: "breakdown" };
  }
  // A place's state, when the question doesn't name it ("Portland" given as "Portland, Oregon"), is dropped: the
  // engine then resolves the name as asked, and asks which when several places share it.
  const words = ` ${q} `;
  const places = (r.places ?? []).map((p) => {
    const m = /^(.*?),\s*([^,]+)$/.exec(p.name.trim());
    if (!m) return p;
    const st = norm(m[2]), abbr = Object.entries(STATE_NAMES).find(([, n]) => norm(n) === st)?.[0].toLowerCase();
    const named = (st && words.includes(` ${st} `)) || (abbr && words.includes(` ${abbr} `)) || (st.length === 2 && words.includes(` ${st} `));
    return named ? p : { ...p, name: m[1] };
  });
  const canonical = renderReading({ ...r, places });
  if (!canonical) return { ok: false, reason: "not renderable" };
  // The pattern reader reads the canonical question back: nothing unread, and the same measure and places.
  const back = readQuestion(canonical, currentYear).ledger as ReturnType<typeof readQuestion>["ledger"] & { comparison?: unknown };
  const parts = back.parts.filter((p) => p.clause === 0);
  if (parts.some((p) => p.concept === "unrecognized" || p.state === "not-interpreted")) return { ok: false, reason: "reads back unread" };
  if (!parts.some((p) => p.concept === "measure" && p.value === r.measure!.id)) return { ok: false, reason: "reads back another measure" };
  if (parts.filter((p) => p.concept === "place").length !== (r.places ?? []).length) return { ok: false, reason: "reads back other places" };
  // The statistic reads back as itself: a comparison for a percent change (and none otherwise), a rate, a share.
  const stat = r.statistic?.value ?? "count";
  if ((stat === "percent_change") !== !!back.comparison) return { ok: false, reason: "reads back another statistic" };
  if ((stat === "rate") !== parts.some((p) => p.concept === "statistic" && p.value === "rate")) return { ok: false, reason: "reads back another statistic" };
  if ((stat === "share") !== parts.some((p) => p.concept === "share")) return { ok: false, reason: "reads back another statistic" };
  return { ok: true, question: canonical };
}

/** The reading as a question in the pattern reader's own grammar; null for a combination it doesn't write. */
export function renderReading(r: Reading): string | null {
  const [one, many] = MEASURE_WORDS[r.measure!.id];
  const unit = r.unit?.value;
  const stat = r.statistic?.value ?? "count";
  let head: string;
  if (stat === "rate") { if (unit) return null; head = `${one} rate`; }
  else head = unit ? `${one} ${unit}` : many;
  if (stat === "share") { if (!(r.breakdowns ?? []).length) return null; head = `share of ${head}`; }
  if (stat === "percent_change") { if (r.period?.kind !== "range") return null; head = `percent change in ${head}`; }
  const places = (r.places ?? []).map((p) => p.name.trim()).filter(Boolean);
  let s = head + (places.length ? ` in ${places.join(" and ")}` : "");
  if (r.period) {
    const ys = r.period.years;
    s += r.period.kind === "year" ? ` in ${ys[0]}` : r.period.kind === "since" ? ` since ${ys[0]}` : r.period.kind === "range" ? ` from ${ys[0]} to ${ys[1]}`
      : ` in ${ys.slice(0, -1).join(", ")} and ${ys[ys.length - 1]}`;
  }
  for (const b of r.breakdowns ?? []) {
    if (["year", "month", "quarter"].includes(b.value)) s += ` by ${b.value}`;
    else if (PERSON_ATTRS.has(b.value)) s += ` by ${b.person ? `${b.person} ` : ""}${b.value}`;
    else s += b.value === "offense" ? " by offense type" : ` by ${b.value}`;
  }
  return s;
}

// ------------------------------------------------------------------------------------------------- when to call
/** The deterministic follow-up path's own "I can't tell" (the rewriter asked for the whole question). */
const FOLLOW_UP_UNREAD = /^(?:I couldn't tell how this changes|The previous question was itself a change)/;
/**
 * Whether Gemini is consulted (the coordinator for Jeff, 2026-11-09): only when the engine doesn't answer (a decline or
 * a clarify) and the pattern reader left the question's words unread, or, for a follow-up, its rewriter couldn't tell
 * what changes. A question read in full is never Gemini's, whatever its outcome.
 */
export function qualifies(question: string, outcome: { kind: string; about?: string | null }, followUp: boolean, currentYear: number): boolean {
  if (outcome.kind !== "decline" && outcome.kind !== "clarify") return false;
  if (followUp && FOLLOW_UP_UNREAD.test(outcome.about ?? "")) return true;
  return readQuestion(question, currentYear).ledger.parts.some((p) => p.clause === 0 && (p.concept === "unrecognized" || p.state === "not-interpreted"));
}
