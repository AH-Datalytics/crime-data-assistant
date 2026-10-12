/**
 * Stage 3b: the "why" explainer (plan r1-r1.4; round 2 plan 2026-10-12 r2 + r2.1). PURE except for each tab's own ledger
 * (its source registry), which it reads but never changes. No database, no model.
 *
 * A clause is first given its PROTECTED SUBJECTS -- the parts the tab's own ledger recognizes (place, measure, period,
 * statistic) and any row label of the explained answer found in it -- then split only into independent explanation
 * requests (R2.1'). Every word of a sub-clause must be accounted for by its subjects, its topic, a crime-level predicate,
 * attribution words, field or chart words, or a closed stopword list; any leftover word declines that sub-clause by
 * name. What is explained decides the topic (F5): a crime level (a direction, level or difference) is a cause, whatever
 * else is said; otherwise an artifact topic W1-W6. A W topic is answered only from the explained answer's own rows and
 * its producer's facts (R2.4'); corrections are bound to the measure, place, statistic and period asked (R2.5').
 */
import { detectAndPivotChartData } from "./chart-layout";
import { accountCurrentRequest } from "./current-request-accounting";
import { accountHistoricalRequest } from "./historical-request-accounting";
import { accountNibrsRequest } from "./nibrs-request-accounting";
import { accountShrRequest } from "./shr-request-accounting";
import { OFFENSES_OF, MEASURE_LABEL as CURRENT_LABEL } from "./current-question-types";
import type { WhyFact } from "./why-scope";

export type WhyTab = "current" | "historical" | "nibrs" | "shr";
export type WhyTopic = "W1" | "W2" | "W3" | "W4" | "W5" | "W6" | "cause" | "unsupported";

/** What the explainer reads: the delivered answer of the explained question, with its producer's facts. */
export type WhyAnswerFacts = {
  /** The question whose answer is explained (the rebuilt earlier question, or the turn's data part). */
  question: string;
  columns: string[];
  rows: Record<string, unknown>[];
  chartConfig: { type?: string; xAxis?: string; yAxis?: string[] | string } | null;
  /** Answer-level notes the producer returned as structured facts (r1.3). */
  notes: string[];
  /** Producer facts paired with this answer's emission (R2.4'). */
  facts: WhyFact[];
};

const SOURCE: Record<WhyTab, { name: string; records: string; Name: string }> = {
  current: { name: "Current Trends", Name: "Current Trends", records: "reported offenses" },
  historical: { name: "the Historical Library", Name: "The Historical Library", records: "reported offenses" },
  nibrs: { name: "NIBRS", Name: "NIBRS", records: "reported incidents" },
  shr: { name: "Homicide Reports", Name: "Homicide Reports", records: "reported homicides" },
};
const verbOf = (tab: WhyTab) => (tab === "shr" ? "record" : "records");

export const WHY_SENTENCES = {
  lead: (q: string) => `About your earlier question, "${q}", as answered now:`,
  cause: (tab: WhyTab) => `I can't explain why: ${SOURCE[tab].name} ${verbOf(tab)} ${SOURCE[tab].records}, not their causes.`,
  unsupported: (clause: string, leftover?: string[]) => `I can explain blank or unknown values, missing months or agencies, what a category counts, how the chart is drawn, why values are equal or withheld, and how totals and rates are formed. I can't tell from the data why ${clause}${leftover && leftover.length ? ` ("${leftover.join(" ")}")` : ""}.`,
  noPrevious: "There's no earlier answer in this conversation for me to explain.",
  cantRebuild: "I can't rebuild your earlier question here; ask it again together with what you want explained.",
  otherTab: (tab: string) => `That question was on the ${tab} tab; ask there.`,
  k2: (sentence: string) => `I can't rebuild your earlier question: ${sentence}`,
  earlierDeclined: (sentence: string) => `Your earlier question isn't answered now, so there are no figures to explain: ${sentence}`,
  notRecorded: (what: string) => `This answer doesn't record ${what}.`,
};

const fmt = (n: number) => n.toLocaleString("en-US");
const pct1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_RE = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const listAnd = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ============================================================== vocabulary */

const FIELD_WORDS = /\b(location|locations|codes?|ages?|age\s+groups?|sex|gender|race|ethnicity|weapons?|relationship|circumstances?|fields?|values?|categor(?:y|ies))\b/i;
const W1_CUE = /\b(unknown|blank|empty|not\s+(?:all\s+)?filled\s+in|filled\s+in|not\s+recorded|missing)\b/i;
const W4_CUE = /\b(chart|graph|plot|axis|trend\s+lines?|lines?|bars?)\b/i;
const W2_CUE = /\b(missing|no\s+(?:number|data|value|figure|row)s?|not\s+shown|gap)\b/i;
const W5_CUE = /\b(the\s+same|identical|equal|all\s+zero|no\s+change|not\s+(?:given|shown)|withheld)\b/i;
const W6_CUE = /\b(national\s+(?:total|number|figure)s?|totals?\s+only\s+from|only\s+from\s+some\s+agencies|sample|rates?\s+(?:is\s+|are\s+)?calculated|how\s+(?:the\s+)?(?:rates?|totals?)|per\s+100,?000|population|estimates?)\b/i;
const W3_CUE = /\b(included|include|counted|count(?:s|ed)?\s+as|part\s+of)\b/i;
/** Direction words: ONE map for classification and correction (R2.5'). */
const UP_WORDS = ["rise", "rises", "rose", "risen", "rising", "increase", "increased", "increases", "increasing", "up", "grow", "grew", "grown", "higher", "spike", "spiked", "surge", "surged"];
const DOWN_WORDS = ["fall", "falls", "fell", "fallen", "falling", "drop", "dropped", "drops", "decline", "declined", "declines", "declining", "decrease", "decreased", "decreases", "decreasing", "down", "lower"];
const DIRECTION = new RegExp(`\\b(${[...UP_WORDS, ...DOWN_WORDS].join("|")})\\b`, "i");
const LEVEL = /\b(high|low|so\s+high|so\s+low|more|fewer|less|dangerous|safe|safer|worse|better|bad|common|frequent)\b/i;
const CHANGE_WORD = /\b(change[sd]?|changing|trends?)\b/i;
const ATTRIBUTION = /\b(caused?|causes|because|due\s+to|prove[sd]?|proves|effect\s+of|result\s+of|reasons?|evidence|commit(?:s|ted)?|happen(?:s|ed)?)\b/i;
const CRIME_NOUN = /\b(crimes?|murders?|homicides?|robber(?:y|ies)|burglar(?:y|ies)|thefts?|rapes?|assaults?|violence|shootings?|offen[cs]es?|incidents?|victims?)\b/i;
const STOP = new Set(("is are was were be been the a an there no not some all any of in on at for to so do does did it its they them this that these those why and or but by from than when we you i say said mean means call called " +
  "how what which much many every each year years month months number numbers value values figure figures data answer cities agencies city agency place places one ones only just still yet very really " +
  "isn't aren't wasn't weren't doesn't don't didn't can't won't hasn't haven't " +
  "given shown listed calculated computed formed measured worked out made done").split(" "));
const CHART_WORDS = /\b(chart|graph|plot|axis|lines?|bars?|trend)\b/i;

/* ============================================================== protected subjects (R2.1') */

type Subject = { span: [number, number]; text: string; kind: "place" | "measure" | "period" | "statistic" | "label" };
function ledgerOf(tab: WhyTab, text: string): { parts: { concept: string; state: string; text: string; span: [number, number]; value?: string | null }[] } {
  try {
    if (tab === "current") return accountCurrentRequest(text) as never;
    if (tab === "historical") return accountHistoricalRequest(text) as never;
    if (tab === "nibrs") return accountNibrsRequest(text) as never;
    return accountShrRequest(text, {}) as never;
  } catch { return { parts: [] }; }
}
function subjectsOf(clause: string, tab: WhyTab, f: WhyAnswerFacts | null): Subject[] {
  const out: Subject[] = [];
  for (const p of ledgerOf(tab, clause).parts) {
    if (p.state !== "recognized") continue;
    const kind = MONTH_RE.test(p.text) && p.concept === "place" ? "period" : p.concept;
    if (["place", "measure", "period", "statistic"].includes(kind)) out.push({ span: p.span, text: p.text, kind: kind as Subject["kind"] });
  }
  // Month names and years are periods in every tab.
  for (const re of [new RegExp(MONTH_RE.source, "gi"), /\b(?:19|20)\d{2}\b/g]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(clause))) if (!out.some((s) => s.span[0] <= m!.index && m!.index < s.span[1])) out.push({ span: [m.index, m.index + m[0].length], text: m[0], kind: "period" });
  }
  // The explained answer's own row labels (places, categories), verbatim.
  if (f) {
    const labels = new Set<string>();
    for (const r of f.rows) for (const k of ["place", "category", "agency_label"]) if (typeof r[k] === "string" && (r[k] as string).length > 2) labels.add(r[k] as string);
    for (const r of f.rows) if (typeof r.place === "string") labels.add(String(r.place).split(",")[0]);
    for (const label of labels) {
      const m = new RegExp(`(?<![\\w])${escapeRe(label)}(?![\\w])`, "i").exec(clause);
      if (m && !out.some((s) => s.span[0] <= m.index && m.index < s.span[1])) out.push({ span: [m.index, m.index + m[0].length], text: m[0], kind: "label" });
    }
  }
  // Capitalized words not at the start: a place or name the user wrote (accounted, then bound in R2.5').
  const cap = /(?<=\s)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)(?:,\s*[A-Z]{2}\b)?/g;
  let m: RegExpExecArray | null;
  while ((m = cap.exec(clause))) if (!out.some((s) => s.span[0] <= m!.index && m!.index < s.span[1])) out.push({ span: [m.index, m.index + m[0].length], text: m[0], kind: "place" });
  return out.sort((a, b) => a.span[0] - b.span[0]);
}

/* ============================================================== sub-clauses and topics (R2.1') */

export type SubClause = { text: string; topic: WhyTopic; leftover: string[]; subjects: Subject[] };

const hasPredicate = (t: string) => W1_CUE.test(t) || W2_CUE.test(t) || W4_CUE.test(t) || W5_CUE.test(t) || W6_CUE.test(t) || W3_CUE.test(t) || DIRECTION.test(t) || LEVEL.test(t) || CHANGE_WORD.test(t) || ATTRIBUTION.test(t);

/** The topic of ONE sub-clause, by the thing explained (F5): a crime level first, else an artifact topic. */
export function topicOf(text: string, subjects: Subject[] = []): WhyTopic {
  const c = text.toLowerCase();
  if (!/[\p{L}\p{N}]/u.test(c)) return "cause";
  const crimeLevel = DIRECTION.test(c) || (LEVEL.test(c) && (CRIME_NOUN.test(c) || subjects.length > 0)) || (CHANGE_WORD.test(c) && !/\bno\s+change\b/.test(c) && (CRIME_NOUN.test(c) || subjects.some((s) => s.kind === "measure")));
  const attributes = ATTRIBUTION.test(c) && (CRIME_NOUN.test(c) || DIRECTION.test(c));
  const artifact = (W1_CUE.test(c) && FIELD_WORDS.test(c)) || W4_CUE.test(c) || W5_CUE.test(c) || W2_CUE.test(c) || W6_CUE.test(c) || (W3_CUE.test(c));
  if (crimeLevel && !(W5_CUE.test(c) && !DIRECTION.test(c) && !LEVEL.test(c))) return "cause";
  if (attributes && !(W1_CUE.test(c) && FIELD_WORDS.test(c) && !DIRECTION.test(c))) return "cause";
  if (W4_CUE.test(c) && !/\bon\s+the\s+line\b/.test(c)) return "W4";
  if (W1_CUE.test(c) && FIELD_WORDS.test(c)) return "W1";
  if (W5_CUE.test(c)) return "W5";
  if (W2_CUE.test(c) || (MONTH_RE.test(c) && /\bno\b|\bmissing\b/.test(c)) || (/\b(19|20)\d{2}\b/.test(c) && /\bmissing\b/.test(c))) return "W2";
  if (W6_CUE.test(c)) return "W6";
  if (W3_CUE.test(c)) return "W3";
  if (artifact) return "unsupported";
  if (ATTRIBUTION.test(c) || CRIME_NOUN.test(c)) return "cause";
  return "unsupported";
}
/** Back-compatible name used by the turn's tags. */
export const whyTopic = (clause: string): WhyTopic => topicOf(clause);

/** Split a clause into independent explanation requests and account for every word (R2.1'). */
export function subClauses(clause: string, tab: WhyTab, f: WhyAnswerFacts | null): SubClause[] {
  const subjects = subjectsOf(clause, tab, f);
  const inSubject = (i: number) => subjects.some((s) => s.span[0] <= i && i < s.span[1]);
  const cuts: number[] = [];
  const sep = /\s+(?:and|or|but)\s+|\s*[,;]\s*/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = sep.exec(clause))) {
    if (inSubject(m.index)) continue;
    const left = clause.slice(last, m.index); const right = clause.slice(m.index + m[0].length);
    if (hasPredicate(left) && hasPredicate(right)) { cuts.push(m.index, m.index + m[0].length); last = m.index + m[0].length; }
  }
  const pieces: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < cuts.length; i += 2) { pieces.push([start, cuts[i]]); start = cuts[i + 1]; }
  pieces.push([start, clause.length]);
  // Round 3: a piece cut at a comma may open with the joining word and a repeated introducer ("..., and why isn't fraud
  // counted"); they belong to neither request, so the piece starts after them.
  const opener = /^(?:(?:and|or|but)\s+)?(?:why|how\s+come)\s+/i;
  return pieces.map(([a0, b]) => {
    const a = a0 + (opener.exec(clause.slice(a0, b))?.[0].length ?? 0);
    const text = clause.slice(a, b).trim();
    const own = subjects.filter((s) => s.span[0] >= a && s.span[1] <= b);
    const topic = topicOf(text, own);
    // Account for every word (offsets relative to the whole clause).
    const covered = new Array(clause.length).fill(false);
    for (const s of own) for (let i = s.span[0]; i < s.span[1]; i += 1) covered[i] = true;
    for (const re of [W1_CUE, W2_CUE, W4_CUE, W5_CUE, W6_CUE, W3_CUE, DIRECTION, LEVEL, CHANGE_WORD, ATTRIBUTION, CRIME_NOUN, FIELD_WORDS, CHART_WORDS, /\bwhen\s+(?:we|you|i|people)\s+(?:say|talk\s+about|mean)\b/i, /"[^"]*"/]) {
      const g = new RegExp(re.source, "gi");
      let x: RegExpExecArray | null;
      const seg = clause.slice(a, b);
      while ((x = g.exec(seg))) for (let i = a + x.index; i < a + x.index + x[0].length; i += 1) covered[i] = true;
    }
    if (topic === "W3") { const cat = w3Category(text); const at = clause.indexOf(cat, a); if (at >= 0) for (let i = at; i < at + cat.length; i += 1) covered[i] = true; }
    const leftover: string[] = [];
    const word = /[\p{L}\p{N}'’/-]+/gu;
    let w: RegExpExecArray | null;
    const seg = clause.slice(a, b);
    while ((w = word.exec(seg))) {
      const at = a + w.index;
      if (covered[at]) continue;
      if (STOP.has(w[0].toLowerCase().replace(/['’]s$/, ""))) continue;
      leftover.push(w[0]);
    }
    // A cause is declined whatever else it says, so its leftover words change nothing and are not reported.
    return { text, topic: leftover.length && topic !== "cause" ? "unsupported" : topic, leftover: topic === "cause" ? [] : leftover, subjects: own };
  });
}

/* ============================================================== facts helpers */

const numeric = (rows: Record<string, unknown>[], col: string) => rows.some((r) => typeof r[col] === "number") && rows.every((r) => r[col] === null || r[col] === undefined || typeof r[col] === "number");
function valueColumn(f: WhyAnswerFacts): string | null {
  for (const c of ["value", "count"]) if (f.columns.includes(c)) return c;
  const nums = f.columns.filter((c) => numeric(f.rows, c) && !/^(year|month|period|share|first_year|last_year|years_with_records|earlier_year|later_year|prior_year_total|change_pct)$/.test(c));
  return nums.length ? nums[nums.length - 1] : null;
}
function categoryColumn(f: WhyAnswerFacts): string | null {
  if (f.columns.includes("category")) return "category";
  for (const c of f.columns) {
    if (["place", "measure", "statistic", "unit", "filter", "dimension", "note", "period"].includes(c)) continue;
    if (numeric(f.rows, c)) continue;
    if (new Set(f.rows.map((r) => String(r[c] ?? ""))).size >= 2) return c;
  }
  return null;
}
const OFFENSE_WORDS: [RegExp, string][] = [
  [/\bmotor\s+vehicle\s+thefts?\b/i, "motor vehicle theft"], [/\brobber(?:y|ies)\b/i, "robbery"], [/\bmurders?\b|\bhomicides?\b/i, "murder"],
  [/\bburglar(?:y|ies)\b/i, "burglary"], [/\brapes?\b/i, "rape"], [/\baggravated\s+assaults?\b/i, "aggravated assault"], [/\btheft\b|\bthefts\b|\blarceny\b/i, "theft"],
];
function measureOf(f: WhyAnswerFacts): string {
  const m = f.rows.find((r) => typeof r.measure === "string")?.measure as string | undefined;
  if (m) return m.replace(/_/g, " ");
  for (const [re, name] of OFFENSE_WORDS) if (re.test(f.question)) return name;
  return "reported";
}
function unitOf(f: WhyAnswerFacts, valueCol: string): string {
  const u = f.rows.find((r) => typeof r.unit === "string")?.unit as string | undefined;
  if (u) return u;
  if (/^(offenders|victims|offenses|incidents|arrests)$/.test(valueCol)) return valueCol;
  return "offenses";
}
const fieldOf = (col: string, f: WhyAnswerFacts) => {
  const dim = f.rows.find((r) => typeof r.dimension === "string")?.dimension as string | undefined;
  if (dim) return dim.replace(/_/g, " ");
  return col === "age_group" ? "age group" : col.replace(/_group$/, "").replace(/_/g, " ");
};
const UNKNOWN_CAT = /^(?:unknown|other\/unknown|not\s+specified|not\s+reported|blank|)$/i;
/** Legacy breakdowns whose categories are exclusive (one per counted unit), so their row sum is the total. Reasons: */
const EXCLUSIVE_LEGACY: Record<string, string> = {
  "age_group:offenders": "an offender has one age group",
  "victim_sex:victims": "an SHR victim has one recorded sex",
  "weapon_group:victims": "an SHR victim has one recorded weapon group",
};

/* ============================================================== W1 (R2.4') */

function restrictionOn(field: string, f: WhyAnswerFacts): string | null {
  if (/commercial/i.test(String(f.rows.find((r) => r.filter)?.filter ?? "")) && /location|code/.test(field)) return 'the commercial location types, which don\'t include "Other/Unknown"';
  if (/weapon/.test(field)) {
    const m = f.question.match(/\b(firearm|gun|handgun|rifle|shotgun|knife)\b/i);
    if (m) return `victims whose weapon is recorded as ${/knife/i.test(m[1]) ? "Knife/Cutting" : "Firearm"}`;
  }
  return null;
}
type Denominator = { value: number; overlap: boolean } | null;
function denominatorFor(f: WhyAnswerFacts, row: Record<string, unknown> | null, ccol: string, vcol: string): Denominator {
  const key = row ?? f.rows[0] ?? {};
  const fact = f.facts.find((x): x is Extract<WhyFact, { kind: "breakdown" }> => x.kind === "breakdown"
    && x.key.period === String(key.period ?? key.year ?? "") && (x.key.place === null || x.key.place === key.place)
    && (x.key.measure === null || x.key.measure === key.measure) && (x.key.dimension === null || x.key.dimension === key.dimension) && (x.key.unit === null || x.key.unit === key.unit));
  if (fact) return fact.denominator === null ? null : { value: fact.denominator, overlap: fact.overlap };
  if (EXCLUSIVE_LEGACY[`${ccol}:${vcol}`]) return { value: f.rows.reduce((s, r) => s + (typeof r[vcol] === "number" ? (r[vcol] as number) : 0), 0), overlap: false };
  return null;
}
/** Round 3 (R3.1'): the fields a W1 sub-clause names, in written order. Generic words (codes, values, fields) name none. */
const NAMED_FIELD = /\b(locations?|ages?|sex|gender|races?|ethnicity|weapons?|relationships?|circumstances?)\b/gi;
const fieldName = (word: string) => {
  const w = word.toLowerCase();
  return w.startsWith("location") ? "location" : w.startsWith("age") ? "age" : w === "gender" ? "sex" : w.replace(/s$/, "");
};
const namedFields = (text: string) => [...new Set([...text.matchAll(NAMED_FIELD)].map((m) => fieldName(m[1])))];
function w1(clause: string, f: WhyAnswerFacts): string | null {
  const asked = namedFields(clause);
  if (!asked.length) {
    const word = clause.match(FIELD_WORDS)?.[1]?.toLowerCase() ?? "";
    return w1Field(/code|location/.test(word) ? "location" : word.replace(/s$/, ""), f, false);
  }
  // Each named field is bound to the answer's own field: equal -> explained; different -> "doesn't show" (never another
  // field's facts in its place).
  const out = asked.map((field) => w1Field(field, f, true));
  return out.every((s) => s === null) ? null : out.filter((s): s is string => s !== null).join(" ");
}
function w1Field(askedField: string, f: WhyAnswerFacts, bound: boolean): string | null {
  const vcol = valueColumn(f);
  const notShown = `This answer doesn't show ${askedField}.`;
  if (!vcol) return bound ? notShown : null;
  const measure = measureOf(f); const unit = unitOf(f, vcol);
  const restricted = restrictionOn(askedField, f);
  if (restricted) {
    const total = f.rows.reduce((s, r) => s + (typeof r[vcol] === "number" ? (r[vcol] as number) : 0), 0);
    return /commercial/.test(restricted)
      ? `This answer counts only ${restricted}, so none of its ${fmt(total)} ${measure} ${unit} is recorded as unknown.`
      : `This answer counts only ${restricted}, so none of its ${fmt(total)} ${measure} ${unit} has the ${askedField} recorded as unknown.`;
  }
  const ccol = categoryColumn(f);
  if (!ccol) return bound ? notShown : null;
  const field = fieldOf(ccol, f);
  if (bound && namedFields(field)[0] !== askedField) return notShown;
  const unknownRow = f.rows.find((r) => UNKNOWN_CAT.test(String(r[ccol] ?? "")));
  const d = denominatorFor(f, unknownRow ?? null, ccol, vcol);
  const once = "a category total that counts each one once";
  if (!unknownRow) {
    if (!d) return `None of the ${measure} ${unit} in this answer has the ${field} recorded as unknown or left blank.`;
    return d.overlap
      ? `None of the ${fmt(d.value)} ${measure} ${unit} in this answer (${once}) has the ${field} recorded as unknown or left blank.`
      : `None of the ${fmt(d.value)} ${measure} ${unit} in this answer has the ${field} recorded as unknown or left blank.`;
  }
  const n = Number(unknownRow[vcol]); const cat = String(unknownRow[ccol]);
  const meaning = /^other\/unknown$/i.test(cat) && field === "location"
    ? " That NIBRS location code covers both places that aren't one of the listed location types and places that weren't known; NIBRS doesn't separate the two."
    : ` That is the value the source uses when the ${field} wasn't known.`;
  if (!d) return `${fmt(n)} ${measure} ${unit} in this answer are recorded as "${cat}".${meaning}`;
  const p = pct1((n * 100) / d.value);
  return d.overlap
    ? `${fmt(n)} ${measure} ${unit} in this answer are recorded as "${cat}" (${p}% of the ${fmt(d.value)} ${unit}, ${once}).${meaning}`
    : `${fmt(n)} of the ${fmt(d.value)} ${measure} ${unit} in this answer (${p}%) are recorded as "${cat}".${meaning}`;
}

/* ============================================================== W2 */

const ymLabel = (p: string) => { const ym = p.match(/^(\d{4})-(\d{2})$/); return ym ? `${MONTHS[Number(ym[2]) - 1]} ${ym[1]}` : p; };
function askedPeriod(clause: string): { month: number | null; year: number | null } {
  const m = clause.match(MONTH_RE); const y = clause.match(/\b((?:19|20)\d{2})\b/);
  return { month: m ? MONTHS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase()) + 1 : null, year: y ? Number(y[1]) : null };
}
function w2(clause: string, f: WhyAnswerFacts, tab: WhyTab): string | null {
  const want = askedPeriod(clause);
  const periodOf = (r: Record<string, unknown>) => String(r.period ?? r.year ?? "");
  if (f.columns.includes("value")) {
    const matches = (r: Record<string, unknown>) => {
      const p = periodOf(r); const ym = p.match(/^(\d{4})-(\d{2})$/);
      if (want.month) return Boolean(ym) && Number(ym![2]) === want.month && (!want.year || Number(ym![1]) === want.year);
      if (want.year) return p === String(want.year);
      return true;
    };
    const asked = f.rows.filter(matches);
    const missing = asked.filter((r) => r.value === null && /no report/i.test(String(r.note ?? "")));
    if (missing.length) {
      const place = String(missing[0].place ?? "");
      const periods = missing.map((r) => ymLabel(periodOf(r)));
      return `No data was received for ${place} for ${listAnd(periods)}, so ${periods.length === 1 ? "it is" : "they are"} shown as missing, not as zero.`;
    }
    const present = asked.find((r) => typeof r.value === "number");
    if (present && (want.month || want.year)) return `${ymLabel(periodOf(present))} isn't missing in this answer: it shows ${fmt(present.value as number)}.`;
    return null;
  }
  if (tab === "nibrs" && f.columns.includes("month") && want.month) {
    const years = [...new Set(f.rows.map((r) => Number(r.year)))];
    const has = f.rows.some((r) => Number(r.month) === want.month);
    if (!has && years.length === 1) return `No offenses were recorded for ${MONTHS[want.month - 1]} ${years[0]} in this answer's data, so that month has no row; NIBRS can't show whether none occurred or the agency didn't report.`;
    const row = f.rows.find((r) => Number(r.month) === want.month);
    const vcol = valueColumn(f);
    if (row && vcol) return `${MONTHS[want.month - 1]} ${row.year} isn't missing in this answer: it shows ${fmt(Number(row[vcol]))}.`;
  }
  return null;
}

/* ============================================================== W3: included / excluded / unresolved (R2.3') */

export const CURRENT_OFFENSES = ["murder", "rape", "robbery", "aggravated assault", "burglary", "theft", "motor vehicle theft"];
function w3Category(clause: string): string {
  const m = clause.match(/^(?:(?:isn't|is\s+not|aren't|are\s+not|wasn't|weren't|doesn't|don't|is|are|was|were|does|do)\b\s*)?(.+?)\s+(?:not\s+)?(?:included|counted|include|count(?:ed)?\s+as|part\s+of)\b/i);
  return (m ? m[1] : clause).replace(/^(?:the|a|an)\s+/i, "").replace(/\s+(?:not|n't)$/i, "").replace(/^["']|["']$/g, "").trim();
}
export function w3(clause: string, tab: WhyTab): string {
  const x = w3Category(clause);
  const Cap = `${x.charAt(0).toUpperCase()}${x.slice(1)}`;
  const parts = ledgerOf(tab, x).parts.filter((p) => p.state !== "context");
  const whole = parts.length === 1 && parts[0].text.trim().toLowerCase() === x.toLowerCase();
  const measure = whole && parts[0].concept === "measure" && parts[0].state === "recognized" ? (parts[0].value ?? null) : null;
  if (measure) {
    if (tab === "current") {
      if (CURRENT_OFFENSES.includes(CURRENT_LABEL[measure] ?? "")) return `Current Trends counts ${CURRENT_LABEL[measure]} (one of its ${CURRENT_OFFENSES.length} offenses: ${listAnd(CURRENT_OFFENSES)}).`;
      const parts7 = (OFFENSES_OF[measure] ?? []).map((o) => o.toLowerCase());
      if (parts7.length > 1) return `Current Trends counts ${CURRENT_LABEL[measure] ?? x} as ${listAnd(parts7)} together.`;
    }
    return `${SOURCE[tab].Name} does count ${x.toLowerCase()}.`;
  }
  const refused = whole && parts[0].state === "not-recorded";
  if (refused && tab === "current") return `Current Trends counts ${CURRENT_OFFENSES.length} offenses: ${listAnd(CURRENT_OFFENSES)}. ${Cap} isn't one of them.`;
  if (refused) return `${SOURCE[tab].Name} doesn't record ${x.toLowerCase()}.`;
  return `${SOURCE[tab].Name} has no category called "${x}", so I can't say which of its records you mean.`;
}

/* ============================================================== W4 */

const label = (key: string) => key.replace(/^_ym$/, "month").replace(/_/g, " ");
function w4(f: WhyAnswerFacts): string {
  const cfg = f.chartConfig;
  if (!cfg || !cfg.type) return "This answer has no chart; it is shown as a table.";
  const yKeys = Array.isArray(cfg.yAxis) ? cfg.yAxis : cfg.yAxis ? [cfg.yAxis] : [];
  const xKey = cfg.xAxis ?? "";
  if (cfg.type === "line") {
    const pivot = detectAndPivotChartData(f.rows, xKey, yKeys);
    const k = pivot.effectiveYKeys.length;
    if (k > 1) {
      const seriesKey = Object.keys(f.rows[0] ?? {}).find((key) => key !== xKey && !yKeys.includes(key) && !numeric(f.rows, key) && new Set(f.rows.map((r) => String(r[key] ?? ""))).size === k) ?? "series";
      return `This answer's chart does draw lines: one line per ${label(seriesKey)} (${k} lines), by ${label(xKey)}.`;
    }
    return `This answer's chart draws one line, by ${label(xKey)}.`;
  }
  if (cfg.type === "bar") return `This answer's chart is a bar chart with one bar per ${label(xKey)}.`;
  return `This answer's chart is a ${cfg.type} chart.`;
}

/* ============================================================== W5 */

function w5(clause: string, f: WhyAnswerFacts): string | null {
  const vcol = valueColumn(f);
  if (/\bno\s+change|not\s+(?:given|shown)|withheld/i.test(clause)) {
    const counts = f.rows.filter((r) => r.statistic !== "change" && r.statistic !== "percent_change");
    const nullRow = counts.find((r) => r[vcol ?? "value"] === null);
    if (nullRow && !f.rows.some((r) => r.statistic === "change")) {
      const place = String(nullRow.place ?? "");
      const reasonNote = f.notes.map((n) => n.match(new RegExp(`^${escapeRe(place)}: no report for (.+?)\\.?$`))).find(Boolean);
      const reason = reasonNote ? `no data was received for ${reasonNote[1]}` : "no value was recorded for that period";
      return `No change is given because ${place} has no value for ${nullRow.period ?? nullRow.year}: ${reason}.`;
    }
    return null;
  }
  if (!vcol) return null;
  const vals = f.rows.map((r) => r[vcol]).filter((v): v is number => typeof v === "number");
  if (!vals.length) return null;
  const min = Math.min(...vals); const max = Math.max(...vals);
  return min === max ? `They are all ${fmt(min)} in this answer.` : `They aren't the same in this answer: they range from ${fmt(min)} to ${fmt(max)}.`;
}

/* ============================================================== W6 (R2.4') */

function w6(f: WhyAnswerFacts): string {
  const out: string[] = [];
  const seenGroups = new Set<string>();
  for (const g of f.facts.filter((x): x is Extract<WhyFact, { kind: "group" }> => x.kind === "group")) {
    const key = JSON.stringify(g); if (seenGroups.has(key)) continue; seenGroups.add(key);
    out.push(`These totals are for a fixed comparison group of ${fmt(g.members)} agencies that reported every requested offense in every month of every period compared, from a starting sample of ${fmt(g.sample)}.`);
  }
  const sampleRows = f.rows.filter((r) => /^\d+ of \d+ sample agencies reported$/.test(String(r.note ?? "")));
  if (!out.length && sampleRows.length) {
    const first = String(sampleRows[0].note).match(/^(\d+) of (\d+)/)!;
    out.push(sampleRows.length === 1
      ? `National figures here are totals over the ${first[2]} agencies in the Current Trends national sample that reported every requested offense in a month; ${first[1]} of ${first[2]} reported for ${ymLabel(String(sampleRows[0].period))}. They are not national estimates.`
      : `National figures here are totals over the ${first[2]} agencies in the Current Trends national sample that reported every requested offense in a month; each row says how many of them reported. They are not national estimates.`);
  }
  // Round 3 (R3.2'): one sentence per method, over the union of the places its facts name.
  const methods = new Map<string, Extract<WhyFact, { kind: "rate" }>>();
  for (const r of f.facts.filter((x): x is Extract<WhyFact, { kind: "rate" }> => x.kind === "rate")) {
    const key = `${r.method}|${r.per}`;
    const had = methods.get(key);
    methods.set(key, had ? { ...had, places: [...new Set([...had.places, ...r.places])] } : r);
  }
  for (const r of methods.values()) {
    const per = r.per === 1000 ? "1,000" : "100,000";
    const one = r.places.length === 1;
    if (r.method === "nibrs-agency-annual") out.push(one
      ? `Each rate is ${r.places[0]}'s reported count for a year divided by its population for that year, times ${per}.`
      : `Each rate is that place's reported count for a year divided by its own population for that year, times ${per}.`);
    else if (r.method === "nibrs-cohort-annual") out.push(`Each rate is the reported count for a year divided by the population of the agencies that reported to NIBRS that year and have a positive population on file, each weighted by the months it reported, times ${per}; it is not an estimate for agencies that didn't report.`);
    else if (r.method === "nibrs-agency-rolling") out.push(one
      ? `Each 12-month rate is ${r.places[0]}'s reported count over those 12 months divided by its population for the last month's year, times ${per}.`
      : `Each 12-month rate is that place's reported count over those 12 months divided by its own population for the last month's year, times ${per}.`);
    else if (r.method === "nibrs-cohort-rolling") out.push(`Each 12-month rate is the reported count of the agency-months that show reported offenses and have a positive population on file, divided by the sum of those agency-months' population values divided by 12, times ${per}. A month counts as reported when it has reported offenses, which is the source's evidence of reporting, not a confirmed report.`);
    else if (r.method === "nibrs-clearance") out.push("Each clearance rate is the offenses cleared divided by the offenses reported, times 100.");
    else if (r.method === "nibrs-clearance-pooled") out.push("Each clearance rate is the offenses cleared over the whole period divided by the offenses reported over it, times 100.");
    else if (r.method === "shr-agency-annual") out.push(`Each rate is ${one ? `${r.places[0]}'s` : "that place's"} recorded victims for a year divided by the population recorded on its own homicide reports for that year, times ${per}; a year with no single recorded population has no rate.`);
    else if (r.method === "current-period") out.push(one
      ? `Each rate is ${r.places[0]}'s reported count for the period divided by its population for that period's year, times ${per}; a month's rate is not annualized.`
      : `Each rate is that place's reported count for the period divided by its own population for that period's year, times ${per}; a month's rate is not annualized.`);
    else if (r.method === "current-rolling") out.push(one
      ? `Each 12-month rate is ${r.places[0]}'s reported count over those 12 months divided by its average population over them, times ${per}.`
      : `Each 12-month rate is that place's reported count over those 12 months divided by its own average population over them, times ${per}.`);
    else out.push(one
      ? `Each rate is ${r.places[0]}'s count for a year divided by its population for that year, times ${per}.`
      : `Each rate is that place's count for a year divided by its own population for that year, times ${per}.`);
  }
  const noPop = f.rows.filter((r) => r.value === null && /no population/i.test(String(r.note ?? ""))).map((r) => String(r.year ?? r.period));
  if (out.length && noPop.length) out.push(`${listAnd(noPop)} ${noPop.length === 1 ? "has" : "have"} no population recorded, so no rate is given.`);
  return out.length ? out.join(" ") : WHY_SENTENCES.notRecorded("how its rates or totals were formed");
}

/* ============================================================== dispatch */

/** The sentence for one sub-clause about the answer `f` (W1, W2, W4, W5, W6). Null = the answer doesn't record it. */
export function answerTopic(topic: WhyTopic, clause: string, f: WhyAnswerFacts, tab: WhyTab): string | null {
  switch (topic) {
    case "W1": return w1(clause, f);
    case "W2": return w2(clause, f, tab);
    case "W4": return w4(f);
    case "W5": return w5(clause, f);
    case "W6": return w6(f);
    default: return null;
  }
}

export { COMMERCIAL_LOCATION_CODES, COMMERCIAL_LOCATION_NAMES } from "./nibrs-codes";
