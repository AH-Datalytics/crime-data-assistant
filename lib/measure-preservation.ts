/**
 * Measure preservation (Codex Phase 3 direction, handoff :34106; CALC/INTENT obligations).
 *
 * Count, within-record share, count-to-count ratio and population rate are DIFFERENT measures. A model-written
 * statement may not silently deliver one in place of another -- on the initial request or on a follow-up that
 * changes only the year, place or period. October's capture showed the failure: after a share request (GC-050),
 * the year-only follow-up "now give me 2026 so far" was answered with a per-100,000 population rate.
 *
 * This module decides two things, read-only and source-aware:
 *   1. the REQUESTED measure: the one the current question states, or -- when it states none and there is a
 *      conversation -- the one the user last stated. An explicit change ("now the rate per 100k") always wins;
 *   2. the DELIVERED measure: what the statement actually computes.
 * When they are different measures, `measureDriftIssue` returns the truthful limitation the shared contract
 * validator blocks with (before any execution). It never rewrites SQL, never invents a denominator, and never
 * treats a missing implementation as missing source data: the message names the requested measure and what the
 * answer would have been instead.
 *
 * Deliberately narrow: it acts only on a CLEAR contradiction (share/ratio vs population rate; a clearance share
 * over the other denominator; a hate-crime unit other than the one asked for). Anything it cannot classify is left
 * to the existing checks.
 */

export type MeasureKind = "count" | "share" | "ratio" | "rate_per_100k" | "clearance_rate";
export type ShareDenominator = "offenses" | "clearances";
export type HateCrimeUnit = "incidents" | "offenses" | "victims";

export type RequestedMeasure = {
  kind: MeasureKind;
  /** For a clearance share: what the share is OF, when the wording says so. */
  denominator: ShareDenominator | null;
  /** Hate Crime only: the recorded unit asked for. */
  hcUnit: HateCrimeUnit | null;
  /** Where it came from: the current question, or inherited from an earlier user turn. */
  origin: "question" | "inherited";
};

type HistoryTurn = { role: string; content: string };

const CLEARANCE_RATE = /\b(?:clearance|solve|closure)\s+rates?\b|\brates?\s+of\s+clearance\b/i;
const POPULATION_RATE = /\b(?:rates?|per\s*(?:capita|100k|100,?000|10k|10,?000|1k|1,?000|million|1m)|relative\s+to\s+population|population[-\s]+adjusted)\b/i;
const RATIO = /\bratios?\b/i;
const SHARE = /\b(?:shares?|percent(?:age)?s?|proportions?|fraction)\b/i;
const COUNT = /\b(?:how\s+many|number\s+of|counts?|totals?)\b/i;
const SHARE_OF_CLEARANCES = /\b(?:share|percent(?:age)?|proportion|fraction)\s+of\s+(?:all\s+|the\s+)?(?:\w+\s+){0,3}clearances\b/i;
const SHARE_OF_CLEARED = /\b(?:share|percent(?:age)?|proportion|fraction)\s+of\s+(?:all\s+|the\s+)?(?:\w+\s+){0,3}(?:that\s+were\s+|which\s+were\s+)?cleared\b/i;

/**
 * A measure the user explicitly REPLACES ("instead of the share", "rather than a percentage", "not the rate") is not a
 * request for it (Codex R1, :34305): it is removed before the requested measure is read.
 */
const REPLACED = /\b(?:instead\s+of|rather\s+than|in\s+place\s+of|not)\s+(?:the\s+|a\s+|an\s+|just\s+|its\s+|their\s+)?(?:[a-z-]+\s+){0,2}?(?:shares?|percent(?:age)?s?|proportions?|fractions?|ratios?|rates?|per[\s-]*capita|counts?|totals?|numbers?)\b/gi;

/** The text with every explicitly replaced measure removed. */
export function withoutReplacedMeasures(text: string): string {
  return text.replace(REPLACED, " ");
}

export type StatedMeasure = Omit<RequestedMeasure, "origin" | "hcUnit"> | "multiple" | null;

/**
 * What a piece of user text asks for: one measure, "multiple" (it genuinely asks for more than one -- not this
 * module's call, and never a reason to inherit an older one), or null (it names none). Measures the text explicitly
 * replaces are not counted.
 */
export function statedMeasureOrMultiple(raw: string): StatedMeasure {
  if (!raw) return null;
  const text = withoutReplacedMeasures(raw);
  if (CLEARANCE_RATE.test(text)) return { kind: "clearance_rate", denominator: null };
  const rate = POPULATION_RATE.test(text);
  const ratio = RATIO.test(text);
  const share = SHARE.test(text);
  const kinds = [rate, ratio, share].filter(Boolean).length;
  if (kinds > 1) return "multiple";
  return singleMeasure(text, rate, ratio, share);
}

/** The single measure a piece of user text states, or null when it states none -- or more than one. */
export function statedMeasure(raw: string): Omit<RequestedMeasure, "origin" | "hcUnit"> | null {
  const s = statedMeasureOrMultiple(raw);
  return s === "multiple" ? null : s;
}

function singleMeasure(text: string, rate: boolean, ratio: boolean, share: boolean): Omit<RequestedMeasure, "origin" | "hcUnit"> | null {
  if (rate) return { kind: "rate_per_100k", denominator: null };
  if (ratio) return { kind: "ratio", denominator: null };
  if (share) {
    const denominator = SHARE_OF_CLEARANCES.test(text) ? "clearances" : SHARE_OF_CLEARED.test(text) ? "offenses" : null;
    return { kind: "share", denominator };
  }
  if (COUNT.test(text)) return { kind: "count", denominator: null };
  return null;
}

/** The hate-crime unit a piece of user text names (incidents are the source's stated default). */
export function statedHateCrimeUnit(text: string): HateCrimeUnit | null {
  const victims = /\bvictims?\b/i.test(text);
  const offenses = /\boffen[cs]es?\b/i.test(text);
  const incidents = /\bincidents?\b/i.test(text);
  if ([victims, offenses, incidents].filter(Boolean).length !== 1) return null;
  return victims ? "victims" : offenses ? "offenses" : "incidents";
}

/**
 * The measure the answer must deliver: stated by this question, or inherited from the user's most recent turn
 * that stated one, when this question states none. Null when nothing establishes one.
 */
export function requestedMeasure(question: string, history: HistoryTurn[] | null | undefined, source: string): RequestedMeasure | null {
  const stated = statedMeasureOrMultiple(question);
  const ownUnit = source === "hate_crime" ? statedHateCrimeUnit(question) : null;
  const users = (history ?? []).filter((t) => t && t.role === "user" && typeof t.content === "string");
  const unitOnly = (): RequestedMeasure | null => {
    const unit = ownUnit ?? inheritedHateCrimeUnit(history, source);
    return unit ? { kind: "count", denominator: null, hcUnit: unit, origin: ownUnit ? "question" : "inherited" } : null;
  };
  // Codex R1: a question that asks for more than one measure, or that explicitly replaces one without naming another,
  // is a deliberate change -- no older measure is inherited, and no single-measure contradiction is invented.
  if (stated === "multiple") return unitOnly();
  if (!stated && withoutReplacedMeasures(question) !== question) return unitOnly();
  const own = stated;
  if (own) {
    // "just the share that's prosecution declined" names a share but not what it is a share OF: the follow-up keeps the
    // denominator the user last stated for a share. A stated denominator always wins.
    let denominator = own.denominator;
    if (own.kind === "share" && !denominator) {
      for (let i = users.length - 1; i >= 0 && !denominator; i -= 1) {
        const prior = statedMeasure(users[i].content);
        if (prior?.kind === "share" && prior.denominator) denominator = prior.denominator;
      }
    }
    return { ...own, denominator, hcUnit: ownUnit ?? inheritedHateCrimeUnit(history, source), origin: "question" };
  }
  // Year/place/period-only follow-up: the user's most recent stated measure is kept. A turn that asked for several
  // measures ends the search (nothing single to keep).
  for (let i = users.length - 1; i >= 0; i -= 1) {
    const prior = statedMeasureOrMultiple(users[i].content);
    if (prior === "multiple") return unitOnly();
    if (prior) return { ...prior, hcUnit: ownUnit ?? inheritedHateCrimeUnit(history, source), origin: "inherited" };
  }
  return unitOnly();
}

function inheritedHateCrimeUnit(history: HistoryTurn[] | null | undefined, source: string): HateCrimeUnit | null {
  if (source !== "hate_crime") return null;
  const users = (history ?? []).filter((t) => t && t.role === "user" && typeof t.content === "string");
  for (let i = users.length - 1; i >= 0; i -= 1) {
    const unit = statedHateCrimeUnit(users[i].content);
    if (unit) return unit;
  }
  return null;
}

/* ------------------------------------------------------------------ delivered */

const strip = (sql: string) => sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, "''");

/** Every division in the statement as [numerator side, denominator side] text windows. */
function divisions(sql: string): { left: string; right: string }[] {
  const s = strip(sql);
  const out: { left: string; right: string }[] = [];
  const re = /\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out.push({ left: s.slice(Math.max(0, m.index - 220), m.index), right: s.slice(m.index + 1, m.index + 160) });
  }
  return out;
}

/** The denominator expression right after a "/" (to its closing paren at depth zero or the next comma). */
function denominatorExpr(right: string): string {
  let depth = 0;
  for (let i = 0; i < right.length; i += 1) {
    const ch = right[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") { if (depth === 0) return right.slice(0, i); depth -= 1; }
    else if (ch === "," && depth === 0) return right.slice(0, i);
    else if (depth === 0 && /^\s+(?:AS|FROM|WHERE|GROUP|ORDER|LIMIT|END|THEN|ELSE)\b/i.test(right.slice(i))) return right.slice(0, i);
  }
  return right;
}

export type DeliveredMeasure = {
  /** A population-rate division (population in the denominator, or a per-100,000 multiplier). */
  populationRate: boolean;
  /** A division whose denominator is not population (a share or a count-to-count ratio). */
  countDivision: boolean;
  /** For a clearance share: what the denominator is, when recognizable. */
  clearanceDenominator: ShareDenominator | null;
  /** Hate Crime: the unit(s) the statement counts. */
  hcUnits: HateCrimeUnit[];
};

/** The output names of the final SELECT list (aliases, or bare column names). */
function outputNames(sql: string): string[] {
  const s = strip(sql);
  const selects = [...s.matchAll(/\bSELECT\b/gi)];
  if (selects.length === 0) return [];
  const last = selects[selects.length - 1].index!;
  const from = s.slice(last).search(/\bFROM\b/i);
  const list = s.slice(last + 6, from < 0 ? undefined : last + from);
  const names: string[] = [];
  let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(") depth += 1; else if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { names.push(cur); cur = ""; } else cur += ch;
  }
  names.push(cur);
  return names.map((n) => (/\bAS\s+"?(\w+)"?\s*$/i.exec(n.trim())?.[1] ?? /(?:^|\.)"?(\w+)"?\s*$/.exec(n.trim())?.[1] ?? "").toLowerCase()).filter(Boolean);
}

export function deliveredMeasure(sql: string): DeliveredMeasure {
  // A stored population rate (Historical/Current `murder_rate`, `rate_per_100k`) is a rate too; a clearance
  // percentage (`*_clr`, `clearance_rate`) is not.
  const storedRate = outputNames(sql).some((n) => /(?:^|_)rate(?:_per_100k)?$|per_100k|per_capita/.test(n) && !/clr|clear|solve/.test(n));
  let populationRate = storedRate || /\b100000(?:\.0+)?\b|\b1e5\b/i.test(strip(sql));
  let countDivision = false;
  let clearanceDenominator: ShareDenominator | null = null;
  for (const d of divisions(sql)) {
    const den = denominatorExpr(d.right);
    if (/population/i.test(den)) { populationRate = true; continue; }
    countDivision = true;
    if (/cleared|clearance|cleared_by_arrest|cleared_[a-e]\b/i.test(den)) clearanceDenominator = "clearances";
    else if (/total_offenses|offense_count|\boffenses\b|actual/i.test(den) && /cleared|clear/i.test(d.left)) clearanceDenominator = clearanceDenominator ?? "offenses";
  }
  const s = strip(sql);
  const hcUnits: HateCrimeUnit[] = [];
  // Units are read only from the Hate Crime tables themselves; a COUNT(*) over any other table says nothing about
  // hate-crime incidents, offenses or victims (other checks own a wrong-table statement).
  const readsRaw = /\bhate_crime_incidents\b/i.test(s);
  const readsSummary = /\bsummary_hate_crime\w*\b/i.test(s);
  if (readsRaw || readsSummary) {
    if (/offense_victims|\bvictim_count\b/i.test(s)) hcUnits.push("victims");
    if (/COUNT\s*\(\s*DISTINCT\s+[^)]*incident|\bincident_count\b/i.test(s)) hcUnits.push("incidents");
    if (/\boffense_count\b/i.test(s) || (readsRaw && /COUNT\s*\(\s*\*\s*\)/i.test(s))) hcUnits.push("offenses");
  }
  return { populationRate, countDivision, clearanceDenominator, hcUnits };
}

/* ------------------------------------------------------------------ the decision */

const MEASURE_WORDS: Record<MeasureKind, string> = {
  count: "a count",
  share: "a share (percentage)",
  ratio: "a ratio of two counts",
  rate_per_100k: "a rate per 100,000 residents",
  clearance_rate: "a clearance rate",
};

export const MEASURE_DRIFT_GUARDRAIL = "contract-measure-drift";

/**
 * The truthful limitation when the statement would deliver a different measure than the request asked for;
 * null when it would not (or when the module cannot tell).
 */
export function measureDriftIssue(opts: { question: string; history?: HistoryTurn[] | null; source: string; sql: string }): string | null {
  const requested = requestedMeasure(opts.question, opts.history, opts.source);
  if (!requested || !opts.sql) return null;
  const d = deliveredMeasure(opts.sql);
  const asked = requested.origin === "inherited" ? "You asked earlier for" : "You asked for";
  const keep = requested.origin === "inherited" ? " A follow-up that changes only the year, place or period keeps that measure." : "";
  // Share or ratio requested, population rate delivered (GC-050's follow-up).
  if ((requested.kind === "share" || requested.kind === "ratio") && d.populationRate && !d.countDivision) {
    return `${asked} ${MEASURE_WORDS[requested.kind]}, but the answer I could build would give ${MEASURE_WORDS.rate_per_100k} instead, ` +
      `which is a different measure, so I haven't shown it.${keep} Ask for the count or the rate per 100,000 if either would help.`;
  }
  // Population rate requested, a share/ratio delivered with no population at all.
  if (requested.kind === "rate_per_100k" && d.countDivision && !d.populationRate) {
    return `${asked} ${MEASURE_WORDS.rate_per_100k}, but the answer I could build divides two counts instead of using population, ` +
      `which is a different measure, so I haven't shown it.${keep}`;
  }
  // A clearance share over the other denominator (GC-001/004 family): of clearances vs of offenses.
  if (requested.kind === "share" && requested.denominator && d.clearanceDenominator && requested.denominator !== d.clearanceDenominator) {
    const want = requested.denominator === "clearances" ? "all clearances" : "all offenses";
    const got = d.clearanceDenominator === "clearances" ? "all clearances" : "all offenses";
    return `${asked} a share of ${want}, but the answer I could build divides by ${got} instead, which is a different share, so I haven't shown it.${keep}`;
  }
  // Hate Crime: incidents, offenses and victims are different recorded units.
  if (opts.source === "hate_crime" && requested.hcUnit && d.hcUnits.length > 0 && !d.hcUnits.includes(requested.hcUnit)) {
    return `${asked} hate-crime ${requested.hcUnit}, but the answer I could build counts ${d.hcUnits.join(" and ")} instead. ` +
      `Incidents, offenses and victims are different counts in this source, so I haven't shown it.${keep}`;
  }
  return null;
}
