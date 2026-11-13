/**
 * The delivered answer of the shadow slice: the compiled rows become the user-facing table (groupings and numbers only,
 * result.ts), its server-side evidence, a chart description, and the answer text. The text is built from fixed
 * templates and the authorized statements only: a headline that restates the table, the months with no data (D04), the
 * months covered when the period ends early (D06), the fixed statements, and the source statement last (D30). Several
 * measures are columns side by side; a combined total (D19, P31) is a sentence that adds the table's own cells, given only
 * when every part is known. No commentary, no causes, no comparisons the question did not ask for.
 */
import { CIRCUMSTANCE, CIRCUMSTANCE_HELD } from "../nibrs-plan/draft-layer";
import { stateName } from "./places";
import { DRAFT_LAYER } from "../nibrs-plan/draft-layer";
import type { NibrsPlan } from "../nibrs-plan/plan";
type Measure = NibrsPlan["measures"][number];
import type { Comparison } from "../nibrs-plan/transforms";
import { ANSWER_STATEMENTS, checkEnvelope, shownStatements, finalStatistics, peopleFacts, type AnswerStatement, type CellEvidence, type CellStatus, type ResultColumn, type ResultTable } from "../nibrs-plan/result";
import { MEASURE_CODES, MEASURE_LABEL } from "../nibrs-question-types";
import { ETHNICITY_CODES, LOCATION_TYPES, RACE_CODES, WEAPON_TYPES } from "../nibrs-codes";
import { RELATIONSHIP_LABEL } from "../nibrs-question-compiler";

export type Delivered = {
  table: ResultTable;
  evidence: CellEvidence[];
  /** A chart of a time series: the period column on x, the count on y. Null for a single number. */
  chart: { kind: "line" | "bar"; x: string; y: string[] } | null;
  /** Answer text, one sentence or block per line; the last line is always the source statement. */
  text: string[];
  /**
   * The answer contract (lib/answer-contract): the line of `text` that states the answer (the title and lead restate
   * it), so every other line is kept as a note, never guessed; and a combined total's name ("drug crimes").
   */
  headline?: string;
  combined?: string;
  answerStatements: AnswerStatement[];
  /** checkEnvelope's problems (empty when the table, evidence and statements meet the answer contract). */
  contractProblems: string[];
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
/** A month range in words: "2024", "2021 to 2025", "January to October 2026", "March 2021 to June 2025". */
export function periodWords(from: string, to: string): string {
  const fy = from.slice(0, 4), ty = to.slice(0, 4);
  if (from.endsWith("-01") && to.endsWith("-12")) return fy === ty ? fy : `${fy} to ${ty}`;
  if (fy === ty) return from === to ? monthName(from) : `${MONTHS[Number(from.slice(5)) - 1]} through ${monthName(to)}`;
  return `${monthName(from)} through ${monthName(to)}`;
}

const UNIT_PLURAL: Record<string, string> = { offense: "offenses", incident: "incidents", victim: "victims", offender: "offenders", arrest: "arrests", arrestee: "arrests" };
const MEASURE_WORDS: Record<string, string> = { drug_possession: "drug/narcotic violation", drug_equipment: "drug equipment violation" };
/**
 * A filter on weapons or relationships, in words ("with a firearm", "by a stranger", "with a weapon recorded as
 * Handgun"); null for any other, or for a code with no name. The shadow declines a weapon or relationship filter this
 * cannot name, so no restricted count is shown under an unrestricted name (Codex review 02).
 */
/** Property descriptions and loss types an answer can name (NIBRS data elements 15 and 14). */
export const PROPERTY_CODES: Record<string, { codes: string[]; words: string }> = {
  firearm: { codes: ["13"], words: "a firearm" },
  vehicle: { codes: ["03", "05", "24", "28", "37"], words: "the vehicle" },
  car: { codes: ["03"], words: "a car" },
};
const PROPERTY_WORDS: Record<string, string> = Object.fromEntries(Object.values(PROPERTY_CODES).map((x) => [[...x.codes].sort().join(","), x.words]));
export const LOSS_CODES: Record<string, string> = { stolen: "7", recovered: "5", seized: "6", damaged: "4", burned: "2" };
const LOSS_WORDS: Record<string, string> = Object.fromEntries(Object.entries(LOSS_CODES).map(([w, c]) => [c, w]));
export function filterWords(f: NonNullable<Measure["filters"]>[number]): string | null {
  // Increment 6: property on one segment, its description and loss type together ("where a firearm was stolen").
  if (f.kind === "exists" && !f.negate && f.entity === "property") {
    const at = (d: string) => f.where.find((w) => w.kind === "attribute" && w.dimension === d) as { values?: (string | number)[] } | undefined;
    const loss = at("property.loss_type")?.values?.map(String), desc = at("property.description")?.values?.map(String);
    const what = desc && PROPERTY_WORDS[[...desc].sort().join(",")], how = loss && loss.length === 1 ? LOSS_WORDS[loss[0]] : undefined;
    return what && how && f.where.length === 2 ? `where ${what} was ${how}` : null;
  }
  // Element 31 (coordinator 2026-11-04): the victims whose circumstance was one of these, in the FBI's code names.
  if (f.kind === "exists" && !f.negate && f.entity === "victim_circumstance" && f.scope === "victim" && f.where.length === 1 && f.where[0].kind === "attribute"
    && f.where[0].dimension === "victim_circumstance.circumstance" && f.where[0].values?.length) {
    const names = f.where[0].values.map((v) => CIRCUMSTANCE[String(v)]?.toLowerCase());
    return names.every(Boolean) ? `where the circumstance was ${names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0]}` : null;
  }
  // Increment 6: a clearance selection (P64, P66): "cleared", "not cleared", "cleared by arrest", "cleared by exceptional means".
  if (f.kind === "attribute" && f.op === "in" && f.values?.length === 1) {
    const v = String(f.values[0]);
    if (f.dimension === "offense.clearance_status") return v === "cleared" ? "cleared" : v === "none" ? "not cleared" : null;
    if (f.dimension === "offense.clearance_method") return v === "arrest" ? "cleared by arrest" : v === "exceptional" ? "cleared by exceptional means" : null;
  }
  // Increment 7: a person's own attribute ("victims under 18", "female victims"), an offender of the incident (P49), an
  // offender linked to the victim (P65), or an offender's relationship to a victim.
  if (f.kind === "attribute" && /^(?:victim|arrestee|offender)\.(?:sex|race|ethnicity|age)$/.test(f.dimension)) {
    const who = f.dimension.split(".")[0] === "arrestee" ? "arrestees " : "";
    const p = personWords(f);
    const said = p && (f.dimension.endsWith(".sex") ? `who were ${p}` : p);
    return said && (who ? `of ${who}${said}` : said);
  }
  if (f.kind === "exists" && !f.negate && f.entity === "offender" && f.scope === "incident") {
    const ws = f.where.map((w) => (w.kind === "attribute" && w.dimension.startsWith("offender.") ? personWords(w) : null));
    return ws.every(Boolean) ? `with an offender ${ws.join(" and ")} in the incident` : null;
  }
  if (f.kind === "exists" && !f.negate && f.entity === "victim_offender" && f.scope === "victim" && f.where.every((w) => w.kind === "attribute" && w.dimension.startsWith("victim_offender.offender_"))) {
    const ws = f.where.map((w) => personWords({ ...w, dimension: w.dimension.replace("victim_offender.offender_", "offender.") }));
    return ws.every(Boolean) ? `of an offender ${ws.join(" and ")} (linked to the victim by the victim-offender relationship)` : null;
  }
  if (f.kind === "exists" && !f.negate && f.entity === "victim_offender" && f.scope === "offender" && f.where.length === 1 && f.where[0].kind === "attribute" && f.where[0].dimension === "victim_offender.relationship") {
    const codes = (f.where[0].values ?? []).map(String);
    return codes.length === 1 && codes[0] === "ST" ? "who were strangers to the victim" : null;
  }
  if (f.kind !== "exists" || f.negate || f.where.length !== 1 || f.where[0].kind !== "attribute" || f.where[0].op !== "in") return null;
  // Increment 6: an offense of the incident ("that included a robbery"), named by the crime with exactly those codes.
  if (f.entity === "offense" && f.where[0].dimension === "offense.offense") {
    const v = (f.where[0].values ?? []).map(String).sort().join(",");
    const name = Object.keys(MEASURE_CODES).find((k) => [...MEASURE_CODES[k]].sort().join(",") === v);
    const words = name && (MEASURE_LABEL[name] ?? name.replace(/_/g, " "));
    return words ? `that included ${/^[aeiou]/i.test(words) ? "an" : "a"} ${words}` : null;
  }
  const codes = (f.where[0].values ?? []).map(String);
  const v = [...codes].sort().join(",");
  const named = (names: Record<string, string>) => (codes.length && codes.every((c) => names[c]) ? codes.map((c) => names[c]).join(" or ") : null);
  if (f.where[0].dimension === "offense_weapon.weapon") {
    if (v === "11,11A,12,12A,13,13A,14,14A,15,15A") return "with a firearm";
    if (v === "20") return "with a knife or cutting instrument";
    const n = named(WEAPON_TYPES);
    return n && `with a weapon recorded as ${n}`;
  }
  if (f.where[0].dimension === "victim_offender.relationship") {
    if (v === "ST") return "by a stranger";
    const n = named(RELATIONSHIP_LABEL);
    return n && `with an offender relationship recorded as ${n}`;
  }
  return null;
}
/** Increment 7: a person condition in words: "under 18", "aged 18 to 24", "female", "recorded as Black". */
function personWords(w: { dimension: string; op: string; values?: (string | number)[] }): string | null {
  const attr = w.dimension.split(".")[1], vs = (w.values ?? []).map(String);
  if (attr === "age" && w.op === "between" && vs.length === 2) return Number(vs[0]) <= 1 ? `under ${Number(vs[1]) + 1}` : `aged ${vs[0]} to ${vs[1]}`;
  if (attr === "sex" && w.op === "in" && vs.length === 1 && (vs[0] === "F" || vs[0] === "M")) return vs[0] === "F" ? "female" : "male";
  const names = attr === "race" ? RACE_CODES : attr === "ethnicity" ? ETHNICITY_CODES : null;
  return names && w.op === "in" && vs.length && vs.every((v) => names[v]) ? `recorded as ${vs.map((v) => names[v]).join(" or ")}` : null;
}
/** "shoplifting offenses", "simple assault victims", "murder victims with a firearm". */
export function measureWords(plan: NibrsPlan, m: Measure = plan.measures[0]): string {
  const name = m.id.replace(/^[a-z_]+\./, "");
  const filters = [...plan.filters, ...(m.filters ?? [])].map(filterWords).filter(Boolean);
  // Increment 6: every arrest on an incident with the condition ("arrests on incidents where a firearm was stolen").
  // Increment 7: with no condition on the incident, every arrest (standalone Group B arrests included).
  if (m.id === "arrests.all_crime") return [peopleFacts(plan).throughIncident ? "arrests on incidents" : "arrests", ...filters].join(" ");
  return [`${MEASURE_WORDS[name] ?? MEASURE_LABEL[name] ?? name.replace(/_/g, " ")} ${UNIT_PLURAL[m.unit] ?? m.unit}`, ...filters].join(" ");
}
/** A combined total of several measures (D19, P31): what it is called, and the sentence that defines it. */
export type Combined = { label: string; definition: string };
/** Consecutive periods as ranges: "January 2017 to June 2020, March 2021", "2017 to 2019". */
export function runs(periods: string[]): string {
  const idx = (p: string) => (p.length === 7 ? Number(p.slice(0, 4)) * 12 + Number(p.slice(5)) - 1 : Number(p));
  const name = (p: string) => (p.length === 7 ? monthName(p) : p);
  const out: string[] = [];
  for (let i = 0; i < periods.length; ) {
    let j = i;
    while (j + 1 < periods.length && idx(periods[j + 1]) === idx(periods[j]) + 1) j++;
    out.push(i === j ? name(periods[i]) : `${name(periods[i])} to ${name(periods[j])}`);
    i = j + 1;
  }
  return out.join(", ");
}
export const fmt = (n: number) => n.toLocaleString("en-US");
/**
 * A grouping's column; a category grouping says whether its categories are exclusive for the primary count; a time
 * grouping or age groups (bins) say their rows are in natural order (P86).
 */
const groupingColumn = (g: NibrsPlan["groupings"][number], header: string): ResultColumn =>
  g.dimension.startsWith("time.") ? { binding: { kind: "grouping", dimension: g.dimension }, header, ordered: true }
    : g.dimension.startsWith("geo.") ? { binding: { kind: "grouping", dimension: g.dimension }, header }
    : { binding: { kind: "grouping", dimension: g.dimension }, header, exclusive: !g.multiValue, ...(g.bins ? { ordered: true as const } : {}) };
/**
 * The incidents beside a count (P66) by category: they sum to their total only when every category grouping is
 * exclusive and of the incident itself (clearance); below the incident, one incident can have victims in several
 * categories (Codex review 01, P1). Null with no category grouping.
 */
const incidentsExclusive = (plan: NibrsPlan): boolean | null => {
  const cats = plan.groupings.filter((g) => !g.dimension.startsWith("time.") && !g.dimension.startsWith("geo."));
  return cats.length ? cats.every((g) => !g.multiValue && DRAFT_LAYER.dimension(g.dimension)?.entity === "incident") : null;
};
/** A rate as shown: one decimal, with thousands separators ("1,459.7"; assistant preview findings, 2026-10-31). */
export const fmtRate = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
/** "1 carjacking offense", not "1 carjacking offenses": the unit word in the singular for a count of one. */
const one = (n: number, words: string) => (n === 1 ? words.replace(/\b(offense|incident|victim|offender|arrest)s\b/, "$1") : words);
const GROUPING_HEADER: Record<string, string> = { "time.month": "Month", "time.quarter": "Quarter", "time.year": "Year" };
const BLANK: CellStatus[] = ["UNKNOWN", "NOT_REPORTED", "UNKNOWN_UNEVIDENCED_ZERO", "UNAVAILABLE"];

// P63 (Jeff 2026-10-30): the source line names the source plainly. The release stays in the outcome's metadata (the
// caller's deps.release), not in the text.
export const SOURCE_STATEMENT = (_release: string) => "Source: FBI NIBRS.";
/** P77 (Jeff 2026-11-01, amends P63): the line for Historical's figures, the Crime Index files (states and nation, P53; agencies). */
export const SRS_SOURCE = "Source: Crime Index.";

const SEX = { F: "Female", M: "Male", U: "Unknown", X: "Non-binary" };
/**
 * Category groupings the slice delivers, with their header and their codes' names (lib/nibrs-codes.ts). Age groups are
 * named by their bins (names null: the compiled label is the name).
 */
export const CATEGORY: Record<string, { header: string; plural: string; names: Record<string, string> | null }> = {
  "victim.race": { header: "Victim race", plural: "race", names: RACE_CODES },
  "victim.sex": { header: "Victim sex", plural: "sex", names: SEX },
  "victim.ethnicity": { header: "Victim ethnicity", plural: "ethnicity", names: ETHNICITY_CODES },
  "victim.age": { header: "Victim age", plural: "age group", names: null },
  "offense.location_type": { header: "Location type", plural: "location type", names: LOCATION_TYPES },
  "offense_weapon.weapon": { header: "Weapon", plural: "weapon", names: WEAPON_TYPES },
  "victim_offender.relationship": { header: "Victim's relationship to offender", plural: "relationship to the offender", names: RELATIONSHIP_LABEL },
  "victim_circumstance.circumstance": { header: "Circumstance", plural: "circumstance", names: CIRCUMSTANCE },
  // A crime by its offenders' sexes, races, ethnicities or ages (P49), or offenders by their own (P44).
  "offender.sex": { header: "Offender sex", plural: "offender sex", names: { ...SEX, unknown_offender: "Unknown offender" } },
  "offender.race": { header: "Offender race", plural: "offender race", names: { ...RACE_CODES, unknown_offender: "Unknown offender" } },
  "offender.ethnicity": { header: "Offender ethnicity", plural: "offender ethnicity", names: { ...ETHNICITY_CODES, unknown_offender: "Unknown offender" } },
  "offender.age": { header: "Offender age", plural: "offender age group", names: null },
  // Increment 7: arrests by the arrestee's own attributes.
  "arrestee.sex": { header: "Arrestee sex", plural: "arrestee sex", names: SEX },
  "arrestee.race": { header: "Arrestee race", plural: "arrestee race", names: RACE_CODES },
  "arrestee.ethnicity": { header: "Arrestee ethnicity", plural: "arrestee ethnicity", names: ETHNICITY_CODES },
  "arrestee.age": { header: "Arrestee age", plural: "arrestee age group", names: null },
  // Arrests (2026-11-11): Group B arrests (DUI, disorderly conduct ...) by the arrestee's own attributes too.
  "group_b_arrest.sex": { header: "Arrestee sex", plural: "arrestee sex", names: SEX },
  "group_b_arrest.race": { header: "Arrestee race", plural: "arrestee race", names: RACE_CODES },
  "group_b_arrest.ethnicity": { header: "Arrestee ethnicity", plural: "arrestee ethnicity", names: ETHNICITY_CODES },
  "group_b_arrest.age": { header: "Arrestee age", plural: "arrestee age group", names: null },
  // P65: a victim by the offenders its relationship segments link to it.
  "victim_offender.offender_sex": { header: "Linked offender sex", plural: "the sex of the linked offenders", names: { ...SEX, no_relationship: "No relationship reported" } },
  "victim_offender.offender_race": { header: "Linked offender race", plural: "the race of the linked offenders", names: { ...RACE_CODES, no_relationship: "No relationship reported" } },
  "victim_offender.offender_ethnicity": { header: "Linked offender ethnicity", plural: "the ethnicity of the linked offenders", names: { ...ETHNICITY_CODES, no_relationship: "No relationship reported" } },
  "victim_offender.offender_age": { header: "Linked offender age", plural: "the age group of the linked offenders", names: null },
  // P66 (Jeff 2026-10-30): STATUS is cleared or uncleared; TYPE is by arrest, each exceptional type, or uncleared.
  "offense.clearance_status": { header: "Clearance status", plural: "clearance status", names: { cleared: "Cleared", none: "Uncleared" } },
  "offense.clearance_type": { header: "Clearance type", plural: "clearance type", names: {
    arrest: "Cleared by arrest", A: "Exceptional: death of the offender", B: "Exceptional: prosecution declined",
    C: "Exceptional: in custody of another jurisdiction", D: "Exceptional: victim refused to cooperate", E: "Exceptional: juvenile, no custody", none: "Uncleared" } },
};
/** The category names that say a detail is not known: always listed after the known categories. */
export const UNKNOWN_NAMES: ReadonlySet<string> = new Set(["Unknown", "Not recorded", "Unknown offender", "No relationship reported", "Unknown circumstances"]);
/** A category's name: the code's name; a blank field is "Not recorded"; a code with no name keeps its code. */
export function categoryName(dimension: string, code: unknown): string {
  const c = code === null || code === undefined ? "" : String(code).trim();
  if (!c) return "Not recorded";
  // Increment 7: the compiler's two categories that are not codes (offender 00; a victim with no relationship segment).
  if (c === "unknown_offender") return "Unknown offender";
  if (c === "no_relationship") return "No relationship reported";
  const names = CATEGORY[dimension]?.names;
  return names === null ? c : names?.[c] ?? `Code ${c}`;
}

/**
 * rows: the compiled query's rows, in `columns` order: the period key when grouped by time, each category grouping, then
 * per statistic its value and status. Statistics: a count, and optionally its share within the time grouping (each
 * category's part of all units of its own period).
 */
/** Time forms (increment 3): a set of years, or rolling windows (each row a window ending that month). */
export type TimeOptions = { years?: number[]; rolling?: { months: number; average?: boolean; missing: string[] }; quarters?: { incomplete: string[] } };
/** P66: the incidents beside a count (answer.ts): their statistic, or null. */
export function incidentsBeside(plan: NibrsPlan): string | null {
  return plan.statistics.find((s) => s.kind === "incidents")?.as ?? null;
}
/** The place an answer names: the agency's label, a state's name, or the United States (a state or national sum by category). */
const placeLabel = (p: NibrsPlan["geography"]["places"][number]) =>
  p.kind === "agency" ? p.label : p.kind === "state" ? stateName((p as { code: string }).code) : p.kind === "national" ? "United States" : "the place";
export function deliver(plan: NibrsPlan, effective: { from: string; to: string }, requestedTo: string, columns: string[], rows: unknown[][],
  statements: AnswerStatement[], release: string, readings: string[] = [], combined: Combined | null = null, opts: TimeOptions = {}): Delivered {
  const place = plan.geography.places[0];
  const agency = placeLabel(place);
  // Several measures: a count each, side by side (no categories, no shares). One measure: a count and optionally its share.
  const beside = incidentsBeside(plan);
  if (plan.statistics.some((x) => x.kind === "ratio")) return deliverShare(plan, effective, requestedTo, columns, rows, statements, release, readings);
  if (plan.measures.length > 1) return deliverSeveral(plan, effective, requestedTo, columns, rows, statements, release, readings, combined);
  const [countStat, shareStat] = plan.statistics.filter((x) => x.as !== beside);
  const count = countStat.as, share = shareStat?.as;
  const what = measureWords(plan);
  const header = `${what[0].toUpperCase()}${what.slice(1)}${opts.rolling ? `, rolling ${opts.rolling.months}-month ${opts.rolling.average ? "average per month" : "total"}` : ""}`;
  const time = plan.groupings.find((g) => g.dimension.startsWith("time."))?.dimension;
  const cats = plan.groupings.filter((g) => !g.dimension.startsWith("time.")).map((g) => g.dimension);
  const labels: Record<string, string> = { [`statistic:${count}`]: header };
  if (share) labels[`statistic:${share}`] = `Share of all ${what} (%)`;
  if (beside) labels[`statistic:${beside}`] = "Incidents";
  const tableCols: ResultColumn[] = [];
  for (const g of plan.groupings) {
    labels[`grouping:${g.dimension}`] = GROUPING_HEADER[g.dimension] ?? CATEGORY[g.dimension]?.header ?? g.dimension;
    tableCols.push(groupingColumn(g, labels[`grouping:${g.dimension}`]));
  }
  tableCols.push({ binding: { kind: "statistic", as: count }, header });
  const besideExclusive = beside ? incidentsExclusive(plan) : null;
  if (beside) tableCols.push({ binding: { kind: "statistic", as: beside }, header: labels[`statistic:${beside}`], ...(besideExclusive === null ? {} : { exclusive: besideExclusive }) });
  if (share) tableCols.push({ binding: { kind: "statistic", as: share }, header: labels[`statistic:${share}`] });
  const ip = columns.indexOf("period");
  const at = (name: string) => columns.indexOf(name);
  // Age groups (binned) are shown in age order, with "Not recorded" (no age) merged into "Unknown" and last (Jeff
  // 2026-11-01: ordered by age range, not by count; one Unknown row). Their counts and shares add; a blank in either
  // leaves the merged cell blank; the incidents beside them could overlap, so a merged row has none.
  // The SQL already counts both as Unknown (compile.ts ageBins); this merges any rows that still arrive apart, only for an
  // exclusive grouping, where counts add (Codex notes-audit review 01.1: a multi-valued one's would double-count).
  const binned = plan.groupings.find((g) => g.bins && cats.includes(g.dimension));
  const addable = !!binned && !binned.multiValue;
  if (binned && cats.length === 1) {
    const ic = at(cats[0]);
    const known = (st: unknown) => st === "VALUE" || st === "REPORTED_ZERO";
    const merged = new Map<string, unknown[]>();
    const out: unknown[][] = [];
    const both = new Set<unknown[]>();   // the Unknown rows that took in a second row
    for (const r of rows) {
      const isUnknown = r[ic] === null || r[ic] === undefined || String(r[ic]).trim() === "" || categoryName(cats[0], r[ic]) === "Unknown";
      if (!isUnknown || !addable) { out.push(r); continue; }
      const key = ip >= 0 ? String(r[ip]) : "";
      const m = merged.get(key);
      if (!m) { const c = [...r]; c[ic] = "Unknown"; merged.set(key, c); out.push(c); continue; }
      for (const stat of [count, share].filter(Boolean) as string[]) {
        const sv = at(stat), ss = at(`${stat}_status`);
        const both = known(m[ss]) && known(r[ss]);
        m[sv] = both ? Number(m[sv] ?? 0) + Number(r[sv] ?? 0) : null;
        m[ss] = both ? (m[ss] === "REPORTED_ZERO" && r[ss] === "REPORTED_ZERO" ? "REPORTED_ZERO" : "VALUE") : (known(m[ss]) ? r[ss] : m[ss]);
      }
      if (beside) { m[at(beside)] = null; m[at(`${beside}_status`)] = "UNAVAILABLE"; }
      both.add(m);
    }
    // A merged row's share is recomputed from its count over its period's total (age groups partition the people),
    // so it equals one computed from the merged count; when a count in its period is blank, the shares stay added.
    if (share) for (const m of both) {
      const same = out.filter((r) => ip < 0 || String(r[ip]) === String(m[ip]));
      if (!same.every((r) => known(r[at(`${count}_status`)]))) continue;
      const total = same.reduce((a, r) => a + Number(r[at(count)] ?? 0), 0);
      if (total > 0) m[at(share)] = Number(m[at(count)] ?? 0) / total;
    }
    const order = binned.bins!.map((b) => b.label);
    const rank = (r: unknown[]) => { const name = categoryName(cats[0], r[ic]); const i = order.indexOf(name); return i >= 0 ? i : name === "Unknown" ? order.length + 1 : order.length; };
    rows = out.sort((x, y) => (ip >= 0 ? String(x[ip]).localeCompare(String(y[ip])) : 0) || rank(x) - rank(y));
  } else if (cats.length) {
    // Within each period, categories by count, largest first; blanks last; then by name. A category that says the detail
    // is not known (Unknown, Not recorded, No relationship reported) is always after the known ones, whatever its count
    // (coordinator 2026-11-02: Unknown last in every grouping, table, chart and CSV alike).
    const n = (r: unknown[]) => (r[at(count)] === null || r[at(count)] === undefined ? -1 : Number(r[at(count)]));
    const last = (r: unknown[]) => (UNKNOWN_NAMES.has(categoryName(cats[0], r[at(cats[0])])) ? 1 : 0);
    rows = [...rows].sort((x, y) => (ip >= 0 ? String(x[ip]).localeCompare(String(y[ip])) : 0) || last(x) - last(y) || n(y) - n(x)
      || categoryName(cats[0], x[at(cats[0])]).localeCompare(categoryName(cats[0], y[at(cats[0])])));
  }
  // A held-back circumstance (CIRCUMSTANCE_HELD: code 06 until the domestic violence note, Jeff 2026-11-04) is left out
  // of the table, the chart and the export; the note gives its count, so the rows don't look short with nothing said.
  const held: { period: string; n: number }[] = [];
  const ih = at("victim_circumstance.circumstance");
  if (cats.includes("victim_circumstance.circumstance") && ih >= 0) {
    for (const r of rows) if (CIRCUMSTANCE_HELD.has(String(r[ih])) && r[at(count)] !== null && r[at(count)] !== undefined && Number(r[at(count)]) > 0)
      held.push({ period: ip >= 0 ? String(r[ip]) : "", n: Number(r[at(count)]) });
    rows = rows.filter((r) => !CIRCUMSTANCE_HELD.has(String(r[ih])));
  }
  // A series that begins with periods no report is known for starts at the first reported one (owner 2026-10-31; the
  // engine, not the page, since 2026-11-02): those leading rows are left out of the table, the chart and the export,
  // and the note says where the series starts. Months only: a blank year may be partly reported (Codex month review
  // 02.2), so years keep their blank rows and the "not every month is known" note. Rolling windows and quarters too.
  let leadingGap: string[] = [];
  if (time === "time.month" && !cats.length && !opts.rolling && !opts.quarters && ip >= 0) {
    const noReport = (r: unknown[]) => ["UNKNOWN", "NOT_REPORTED"].includes(String(r[at(`${count}_status`)]));
    const first = rows.findIndex((r) => !noReport(r));
    if (first > 0) { leadingGap = rows.slice(0, first).map((r) => String(r[ip])); rows = rows.slice(first); }
  }
  const evidence: CellEvidence[] = [];
  const tableRows = rows.map((r, i) => {
    const out: (string | number | null)[] = [];
    if (ip >= 0) out.push(String(r[ip]));
    for (const d of cats) out.push(categoryName(d, r[at(d)]));
    const cStatus = String(r[at(`${count}_status`)]) as CellStatus;
    const c = r[at(count)];
    out.push(c === null || c === undefined ? null : Number(c));
    evidence.push({ row: i, statistic: count, status: cStatus });
    if (beside) {
      const b = r[at(beside)];
      out.push(b === null || b === undefined ? null : Number(b));
      evidence.push({ row: i, statistic: beside, status: String(r[at(`${beside}_status`)]) as CellStatus });
    }
    if (share) {
      const sStatus = String(r[at(`${share}_status`)]) as CellStatus;
      const s = r[at(share)];
      out.push(s === null || s === undefined ? null : Math.round(Number(s) * 1000) / 10);
      evidence.push({ row: i, statistic: share, status: sStatus });
    }
    return out;
  });
  const table: ResultTable = { columns: tableCols, rows: tableRows };
  const text: string[] = [];
  const when = opts.years ? andList(opts.years.map(String)) : periodWords(effective.from, effective.to);
  const by = [time === "time.month" ? "month" : time === "time.quarter" ? "quarter" : time === "time.year" ? "year" : null, ...cats.map((d) => CATEGORY[d]?.plural ?? d)].filter(Boolean).join(" and ");
  const statusOf = (r: unknown[]) => String(r[at(`${count}_status`)]);
  if (!time && !cats.length) {
    const v = tableRows[0]?.[0] as number | null | undefined;
    text.push(v === null || v === undefined
      ? `${agency}: the available evidence does not establish the number of ${what} in ${when}, so no number is given.`
      : `${agency}: ${fmt(v)} ${one(v, what)} in ${when}${beside && typeof tableRows[0]?.[1] === "number" ? `, in ${fmt(tableRows[0][1] as number)} ${one(tableRows[0][1] as number, "incidents")}` : ""}.`);
  } else if (!cats.length && opts.rolling) {
    // Rolling windows: each a total of its months, known only when all of them are (never a shorter sum).
    const n = opts.rolling.months;
    // An average (Jeff 2026-11-05): each window's total over its ${n} months, said as an average, never as the total.
    text.push(opts.rolling.average ? `${agency}: ${what}, rolling ${n}-month averages per month (each window's total divided by ${n}), by month, ${when}.`
      : `${agency}: ${what}, rolling ${n}-month totals by month, ${when}.`);
    if (rows.some((r) => statusOf(r) !== "VALUE" && statusOf(r) !== "REPORTED_ZERO") && opts.rolling.missing.length)
      text.push(`No report is known for ${runs(opts.rolling.missing)}: every window containing one of those months is shown blank, not zero or a shorter ${opts.rolling.average ? "average" : "total"}.`);
  } else if (!cats.length && opts.quarters) {
    // P71: each quarter the sum of its three months; an incomplete quarter is marked, never shown as a whole quarter.
    text.push(`${agency}: ${what} by quarter, ${when}.`);
    const q = (k: string) => `Q${k.slice(6)} ${k.slice(0, 4)}`;
    if (opts.quarters.incomplete.length) text.push(`Incomplete: ${opts.quarters.incomplete.map(q).join(", ")}. The agency did not report every month of ${opts.quarters.incomplete.length === 1 ? "that quarter" : "those quarters"}, so ${opts.quarters.incomplete.length === 1 ? "it is" : "they are"} shown blank, not as a whole quarter.`);
  } else if (!cats.length) {
    text.push(`${agency}: ${what} by ${by}, ${when}.`);
    if (leadingGap.length) {
      const start = String(rows[0][ip]);
      text.push(`No report is known for ${runs(leadingGap)}, so the chart and table start at ${start.length === 7 ? monthName(start) : start}.`);
    }
    const missing = rows.filter((r) => statusOf(r) === "UNKNOWN" || statusOf(r) === "NOT_REPORTED").map((r) => String(r[ip]));
    // Only what the status establishes: an unknown month has no known report; a year is known only when all its months are.
    // (A month with crimes reported and none of these is a known 0, P51.)
    if (missing.length) text.push(time === "time.year" ? `Not every month of ${runs(missing)} is known: shown blank, not zero.` : `No report is known for ${runs(missing)}: shown blank, not zero.`);
  } else {
    text.push(`${agency}: ${what} by ${by}, ${when}.`);
    // P86: the share's meaning is its column header ("Share of all ... (%)"), not a sentence.
    // A category's total is known only when every month of it is: a month without reporting evidence leaves it unknown.
    // Said once per period (coordinator, 2026-11-01): a period with every category blank is one plain sentence.
    const isBlank = (i: number) => !!evidence.find((e) => e.row === i && e.statistic === count && BLANK.includes(e.status));
    const periodOf = (r: (string | number | null)[]) => (ip >= 0 ? String(r[0]) : "");
    const catsOf = (r: (string | number | null)[]) => r.slice(ip >= 0 ? 1 : 0, (ip >= 0 ? 1 : 0) + cats.length).join(", ");
    const periods = [...new Set(tableRows.map(periodOf))];
    const whole = periods.filter((p) => tableRows.every((r, i) => periodOf(r) !== p || isBlank(i)));
    const partial = periods.filter((p) => !whole.includes(p)).map((p) => [p, tableRows.filter((r, i) => periodOf(r) === p && isBlank(i)).map(catsOf)] as const)
      .filter(([, cs]) => cs.length);
    // Quarters are named as quarters ("Q3 2026"); months and years by runs.
    const named = (ps: string[]) => (ps.every((p) => /^\d{4}-Q\d$/.test(p)) ? andList(ps.map((p) => `Q${p.slice(6)} ${p.slice(0, 4)}`)) : runs(ps));
    if (whole.length) text.push(ip >= 0
      ? `${named(whole)} ${whole.length === 1 ? "is" : "are"} shown blank, not zero: reporting for ${whole.length === 1 ? named(whole) : "those periods"} isn't complete.`
      : `Every category is shown blank, not zero: reporting for ${when} isn't complete.`);
    if (partial.length) text.push(`Shown blank, not zero, because reporting isn't complete: ${partial.map(([p, cs]) => (p ? `${p}: ${cs.join("; ")}` : cs.join("; "))).join(". ")}.`);
  }
  if (held.length) {
    const when1 = (p: string) => (/^\d{4}-\d{2}$/.test(p) ? monthName(p) : /^\d{4}-Q\d$/.test(p) ? `Q${p.slice(6)} ${p.slice(0, 4)}` : p);
    const counts = held.map((h, i) => `${fmt(h.n)}${i === 0 ? ` ${one(h.n, what)}` : ""}${h.period && ip >= 0 ? ` in ${when1(h.period)}` : ""}`);
    text.push(`One circumstance category is left out of this table for now: ${andList(counts)} ${held.length === 1 && held[0].n === 1 ? "was" : "were"} recorded under it.`);
  }
  if (effective.to < requestedTo) text.push(`The data runs through ${monthName(effective.to)}: this covers ${periodWords(effective.from, effective.to)}.`);
  // How a misspelled word was read (reading.ts), then the fixed statements; the source stays last.
  text.push(...readings);
  text.push(...shownStatements(statements));
  text.push(SOURCE_STATEMENT(release));
  // Charts bind one series per statistic: a time series of a single count only. Category charts wait until a series
  // can bind to each category (Codex plan review).
  const chart = time && !cats.length && tableRows.length > 1 ? { kind: time === "time.month" ? "line" as const : "bar" as const, x: labels[`grouping:${time}`], y: [header] } : null;
  const contractProblems = checkEnvelope({ plan, table, evidence, answerStatements: statements }, labels);
  for (const e of evidence) {
    const col = tableCols.findIndex((c) => c.binding.kind === "statistic" && c.binding.as === e.statistic);
    if (BLANK.includes(e.status) !== (table.rows[e.row][col] === null)) contractProblems.push(`row ${e.row}, ${e.statistic}: value and status disagree`);
  }
  return { table, evidence, chart, text, headline: text[0], answerStatements: statements, contractProblems };
}

/**
 * Increment 6: the share cleared, one total: the cleared count and its incidents (P66), the total, and the share in
 * percent to one decimal, known only when both counts are (no total is UNAVAILABLE).
 */
function deliverShare(plan: NibrsPlan, effective: { from: string; to: string }, requestedTo: string, columns: string[], rows: unknown[][],
  statements: AnswerStatement[], release: string, readings: string[]): Delivered {
  const place = plan.geography.places[0];
  const agency = placeLabel(place);
  const [cleared, all] = plan.measures;
  const [cCount, cInc, aCount, ratio] = plan.statistics.map((s) => s.as);
  const r = rows[0] ?? [];
  const num = (as: string) => { const v = r[columns.indexOf(as)]; return v === null || v === undefined ? null : Number(v); };
  // No row (never from a total's query) is unknown, never blank without a status.
  const st = (as: string) => (rows.length ? String(r[columns.indexOf(`${as}_status`)]) : "UNKNOWN") as CellStatus;
  const c = num(cCount), inc = num(cInc), t = num(aCount);
  const known = (s: CellStatus) => s === "VALUE" || s === "REPORTED_ZERO";
  const share = c !== null && t !== null && t > 0 ? Math.round((1000 * c) / t) / 10 : null;
  const shareStatus: CellStatus = !known(st(cCount)) ? st(cCount) : !known(st(aCount)) ? st(aCount) : t === 0 ? "UNAVAILABLE" : "VALUE";
  const what = measureWords(plan, cleared), whatAll = measureWords(plan, all);
  const labels: Record<string, string> = { [`statistic:${cCount}`]: `${what[0].toUpperCase()}${what.slice(1)}`, [`statistic:${cInc}`]: "Incidents",
    [`statistic:${aCount}`]: `All ${whatAll}`, [`statistic:${ratio}`]: "Share cleared (%)" };
  const order = [cCount, cInc, aCount, ratio];
  const table: ResultTable = { columns: order.map((as) => ({ binding: { kind: "statistic", as }, header: labels[`statistic:${as}`] })), rows: [[c, inc, t, share]] };
  const evidence: CellEvidence[] = [{ row: 0, statistic: cCount, status: st(cCount) }, { row: 0, statistic: cInc, status: st(cInc) }, { row: 0, statistic: aCount, status: st(aCount) },
    { row: 0, statistic: ratio, status: shareStatus }];
  const when = periodWords(effective.from, effective.to);
  const text = [share !== null && inc !== null
    ? `${agency}: ${fmt(c!)} of the ${fmt(t!)} ${whatAll} in ${when} were cleared (${share}%); the cleared ${whatAll} were in ${fmt(inc)} ${one(inc, "incidents")}.`
    : `${agency}: the available evidence does not establish the share of ${whatAll} cleared in ${when}, so no share is given.`];
  if (effective.to < requestedTo) text.push(`The data runs through ${monthName(effective.to)}: this covers ${periodWords(effective.from, effective.to)}.`);
  text.push(...readings);
  text.push(...shownStatements(statements));
  text.push(SOURCE_STATEMENT(release));
  const contractProblems = checkEnvelope({ plan, table, evidence, answerStatements: statements }, labels);
  return { table, evidence, chart: null, text, headline: text[0], answerStatements: statements, contractProblems };
}

/** Several measures (no categories): a column per measure; a combined total (D19, P31) as a sentence, totals only. */
function deliverSeveral(plan: NibrsPlan, effective: { from: string; to: string }, requestedTo: string, columns: string[], rows: unknown[][],
  statements: AnswerStatement[], release: string, readings: string[], combined: Combined | null): Delivered {
  const place = plan.geography.places[0];
  const agency = placeLabel(place);
  const time = plan.groupings.find((g) => g.dimension.startsWith("time."))?.dimension;
  const at = (name: string) => columns.indexOf(name);
  const ip = at("period");
  const stats = plan.measures.map((m) => ({ as: plan.statistics.find((s) => "measure" in s && s.measure === m.as)!.as, what: measureWords(plan, m) }));
  const labels: Record<string, string> = {};
  const tableCols: ResultColumn[] = [];
  for (const g of plan.groupings) {
    labels[`grouping:${g.dimension}`] = GROUPING_HEADER[g.dimension] ?? g.dimension;
    tableCols.push(groupingColumn(g, labels[`grouping:${g.dimension}`]));
  }
  for (const s of stats) {
    labels[`statistic:${s.as}`] = `${s.what[0].toUpperCase()}${s.what.slice(1)}`;
    tableCols.push({ binding: { kind: "statistic", as: s.as }, header: labels[`statistic:${s.as}`] });
  }
  const evidence: CellEvidence[] = [];
  const tableRows = rows.map((r, i) => [...(ip >= 0 ? [String(r[ip])] : []), ...stats.map((s) => {
    evidence.push({ row: i, statistic: s.as, status: String(r[at(`${s.as}_status`)]) as CellStatus });
    const v = r[at(s.as)];
    return v === null || v === undefined ? null : Number(v);
  })]);
  const table: ResultTable = { columns: tableCols, rows: tableRows };
  const when = periodWords(effective.from, effective.to);
  const names = stats.map((s) => s.what);
  const list = names.length > 2 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join(" and ");
  const text: string[] = [];
  if (combined) text.push(combined.definition);
  if (!time) {
    const v = tableRows[0] ?? [];
    text.push(`${agency}, ${when}: ${stats.map((s, i) => (v[i] === null || v[i] === undefined ? `the number of ${s.what} is not established` : `${fmt(v[i] as number)} ${s.what}`)).join("; ")}.`);
    if (combined) {
      const known = v.length === stats.length && v.every((x) => x !== null && x !== undefined);
      text.push(known ? `Together: ${fmt((v as number[]).reduce((a, b) => a + b, 0))} ${combined.label} in ${when}.`
        : `No combined total of ${combined.label} is given: the available evidence does not establish every part.`);
    }
    if (v.some((x) => x === null || x === undefined)) text.push("A number not established is shown blank, not zero: reporting evidence is incomplete.");
  } else {
    text.push(`${agency}: ${list} by ${time === "time.month" ? "month" : "year"}, ${when}.`);
    // As for one measure (the same sentence): the periods without reporting evidence.
    const missing = rows.filter((r) => stats.some((s) => ["UNKNOWN", "NOT_REPORTED"].includes(String(r[at(`${s.as}_status`)])))).map((r) => String(r[ip]));
    if (missing.length) text.push(time === "time.year" ? `Not every month of ${runs(missing)} is known: shown blank, not zero.` : `No report is known for ${runs(missing)}: shown blank, not zero.`);
  }
  if (effective.to < requestedTo) text.push(`The data runs through ${monthName(effective.to)}: this covers ${periodWords(effective.from, effective.to)}.`);
  text.push(...readings);
  text.push(...shownStatements(statements));
  text.push(SOURCE_STATEMENT(release));
  const chart = time && tableRows.length > 1 ? { kind: time === "time.month" ? "line" as const : "bar" as const, x: labels[`grouping:${time}`], y: stats.map((s) => labels[`statistic:${s.as}`]) } : null;
  const contractProblems = checkEnvelope({ plan, table, evidence, answerStatements: statements }, labels);
  for (const e of evidence) {
    const col = tableCols.findIndex((c) => c.binding.kind === "statistic" && c.binding.as === e.statistic);
    if (BLANK.includes(e.status) !== (table.rows[e.row][col] === null)) contractProblems.push(`row ${e.row}, ${e.statistic}: value and status disagree`);
  }
  return { table, evidence, chart, text, headline: text[combined ? 1 : 0], ...(combined ? { combined: combined.label } : {}), answerStatements: statements, contractProblems };
}

const andList = (xs: string[]) => (xs.length > 2 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join(" and "));
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : "0");
/** "January through September" for a span inside one year that is not the whole year; null for whole years. */
function monthsOf(p: { from: string; to: string }): string | null {
  if (p.from.endsWith("-01") && p.to.endsWith("-12")) return null;
  const [a, b] = [MONTHS[Number(p.from.slice(5)) - 1], MONTHS[Number(p.to.slice(5)) - 1]];
  return a === b ? a : `${a} through ${b}`;
}

/**
 * A change between two periods (period_comparison, increment 3): both totals, the change and the percent change, as
 * one row. No change from an unknown period (D17), with its months named (D04); no percent change from a zero base
 * (P55); the same months of each year named when the periods are not whole years (D06). No adjectives (P54).
 */
export function deliverComparison(plan: NibrsPlan, periods: { earlier: { from: string; to: string }; later: { from: string; to: string } }, cmp: Comparison,
  statements: AnswerStatement[], release: string, readings: string[] = []): Delivered {
  const place = plan.geography.places[0];
  const agency = placeLabel(place);
  const what = measureWords(plan);
  const Header = `${what[0].toUpperCase()}${what.slice(1)}`;
  const [E, L] = [periodWords(periods.earlier.from, periods.earlier.to), periodWords(periods.later.from, periods.later.to)];
  const outs = finalStatistics(plan);
  const as = plan.statistics[0].as;
  const headerOf: Record<string, string> = { [`${as}.earlier`]: `${Header}, ${E}`, [`${as}.later`]: `${Header}, ${L}`, [`${as}.change`]: "Change", [`${as}.pct_change`]: "Percent change (%)" };
  const cellOf: Record<string, { value: number | null; status: string }> = { [`${as}.earlier`]: cmp.earlier, [`${as}.later`]: cmp.later, [`${as}.change`]: cmp.change, [`${as}.pct_change`]: cmp.pctChange };
  const labels: Record<string, string> = Object.fromEntries(outs.map((o) => [`statistic:${o}`, headerOf[o]]));
  const tableCols: ResultColumn[] = outs.map((o) => ({ binding: { kind: "statistic", as: o }, header: headerOf[o] }));
  const evidence: CellEvidence[] = outs.map((o) => ({ row: 0, statistic: o, status: cellOf[o].status as CellStatus }));
  const table: ResultTable = { columns: tableCols, rows: [outs.map((o) => cellOf[o].value)] };
  const text: string[] = [`${agency}: ${what}, ${E} against ${L}.`];
  const months = monthsOf(periods.earlier);
  if (months && months === monthsOf(periods.later)) text.push(`Compares the same months of each year: ${months}.`);
  if (cmp.change.value !== null) {
    text.push(`${fmt(cmp.earlier.value!)} in ${E} and ${fmt(cmp.later.value!)} in ${L}: a change of ${signed(cmp.change.value)}${cmp.pctChange.value !== null ? ` (${cmp.pctChange.value > 0 ? "+" : ""}${cmp.pctChange.value}%)` : ""}.`);
    if (cmp.zeroBase) text.push("The percent change cannot be computed from a zero base.");
  } else {
    for (const [p, words] of [[cmp.earlier, E], [cmp.later, L]] as const)
      if (p.value !== null) text.push(`${fmt(p.value)} in ${words}.`);
      else if (p.missing.length) text.push(`No report is known for ${runs(p.missing)}, so the ${words} total is not established and no change is given.`);
  }
  text.push(...readings);
  text.push(...shownStatements(statements));
  text.push(SOURCE_STATEMENT(release));
  const contractProblems = checkEnvelope({ plan, table, evidence, answerStatements: statements }, labels);
  evidence.forEach((e, j) => { if (BLANK.includes(e.status) !== (table.rows[0][j] === null)) contractProblems.push(`${e.statistic}: value and status disagree`); });
  return { table, evidence, chart: null, text, headline: text[0], answerStatements: statements, contractProblems };
}

/**
 * A table of one statistic over one grouping or none (increment 4: agencies side by side, a combined total, a ranking,
 * a rate by year), with the text lines its caller built from templates: the fixed statements and the source are added
 * last. The columns are exactly the plan's groupings and statistic (the answer contract).
 */
/** A supporting column of deliverTable: its statistic, header and one cell per row. */
export type Support = { as: string; header: string; cells: { value: number | string | null; status: string }[] };
export function deliverTable(plan: NibrsPlan, grouping: { dimension: string; header: string } | null, stat: { as: string; header: string },
  rows: { key: string | null; value: number | null; status: string }[], lines: string[], statements: AnswerStatement[], release: string, readings: string[] = [],
  /**
   * P72: supporting statistics beside the value (the population a rate divides by; the agencies reporting and the
   * population they cover), row by row, in order. A cell may be text where the figure carries a mark ("≥84.1%").
   */
  supports?: Support | Support[]): Delivered {
  const sup = supports === undefined ? [] : Array.isArray(supports) ? supports : [supports];
  const labels: Record<string, string> = { [`statistic:${stat.as}`]: stat.header };
  const tableCols: ResultColumn[] = [];
  if (grouping) {
    labels[`grouping:${grouping.dimension}`] = grouping.header;
    tableCols.push({ binding: { kind: "grouping", dimension: grouping.dimension }, header: grouping.header, ...(grouping.dimension.startsWith("time.") ? { ordered: true as const } : {}) });
  }
  tableCols.push({ binding: { kind: "statistic", as: stat.as }, header: stat.header });
  for (const s of sup) { labels[`statistic:${s.as}`] = s.header; tableCols.push({ binding: { kind: "statistic", as: s.as }, header: s.header }); }
  const evidence: CellEvidence[] = rows.flatMap((r, i) => [{ row: i, statistic: stat.as, status: r.status as CellStatus },
    ...sup.map((s) => ({ row: i, statistic: s.as, status: s.cells[i].status as CellStatus }))]);
  const table: ResultTable = { columns: tableCols, rows: rows.map((r, i) => [...(grouping ? [r.key ?? ""] : []), r.value, ...sup.map((s) => s.cells[i].value)]) };
  const text = [...lines, ...readings, ...shownStatements(statements), SOURCE_STATEMENT(release)];
  const contractProblems = checkEnvelope({ plan, table, evidence, answerStatements: statements }, labels);
  rows.forEach((r, i) => { if (BLANK.includes(r.status as CellStatus) !== (r.value === null)) contractProblems.push(`row ${i}: value and status disagree`); });
  for (const s of sup) s.cells.forEach((c, i) => { if (BLANK.includes(c.status as CellStatus) !== (c.value === null)) contractProblems.push(`row ${i}, ${s.as}: value and status disagree`); });
  return { table, evidence, chart: null, text, headline: text[0], answerStatements: statements, contractProblems };
}
