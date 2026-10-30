/**
 * Scoring the shadow slice (lib/nibrs-shadow) against the labeled set, at every level the slice delivers:
 *   action          answer, clarify or decline (gates.ts outcomes);
 *   interpretation  the answered plan against the label's meaning (compare.ts);
 *   statements      each sentence the label requires, checked on the delivered text where a check is defined;
 *   values          delivered cells against independent expected values (NOT MEASURED until they are given);
 *   clarifications  every option the label lists is offered, leads where it should, and its continuation (the original
 *                   question with that choice filled in) is the label's meaning for that option;
 *   declines        the reason is the label's reason class, and the alternative, when the label expects one, runs to the
 *                   label's alternative meaning.
 * A refusal because this build does not hold the months (`notBuilt`) is not scored: it is listed apart.
 */
import type { NibrsPlan } from "../nibrs-plan/plan";
import type { ShadowOption, ShadowOutcome } from "../nibrs-shadow/answer";
import { ANSWER_STATEMENTS, type AnswerStatement } from "../nibrs-plan/result";
import { MEASURE_CODES } from "../nibrs-question-types";
import { categoryName, periodWords } from "../nibrs-shadow/deliver";
import type { Case, Meaning } from "./case";
import { compareMeaning, planToMeaning, type Diff, type Release } from "./compare";
import { outcomeOf, type ActualAction, type CaseResult, type Outcome } from "./gates";

/** The slice: its designed group, the replay cases inside it, and replay cases next to it (action and reason only). */
export const SLICE_REPLAY = ["LS-151", "LS-140"];
export const SLICE_NEAR = ["LS-124", "LS-135", "LS-146", "LS-156", "LS-043", "LS-150", "LS-160", "LS-141", "LS-012", "LS-020", "LS-005", "LS-009"];
export function sliceGroup(c: Case): "designed" | "replay" | "near" | null {
  if (/^designed:(slice|reader|breakdown|inc2|inc3|inc4)-/.test(c.group)) return "designed";
  if (SLICE_REPLAY.includes(c.id)) return "replay";
  if (SLICE_NEAR.includes(c.id)) return "near";
  return null;
}

/**
 * Independent expected cells for one delivered answer, keyed by period ("2024-03", "2024") or "" for a total, with the
 * cell's status. The map's keys: a case id ("LS-219"), a case and one of its options ("LS-231|Kansas City, Missouri"),
 * or a case's alternative ("LS-236|alternative").
 */
export type ExpectedCell = { key: string; value: number | null; status: string; share?: number | null;
  /** A file with several measures: the cell's measure, as "<key>: <definition>" (its codes and unit are matched to the plan's). */
  measure?: string };
export type ExpectedValues = Map<string, ExpectedCell[]>;

/**
 * Reads nibrs-model's slice values (correctness/slice/V*.json on its main branch, read with `git show`, never from a work
 * tree) into expected cells. Each file names the cases it serves in `nibrsai_cases`: `LS-230, LS-233 "This year so
 * far", LS-236 alternative`. A file with more than one measure gives a cell per measure for each period (or the total),
 * each carrying its measure.
 */
export function sliceValues(files: { name: string; json: string }[]): ExpectedValues {
  const out: ExpectedValues = new Map();
  for (const f of files) {
    const v = JSON.parse(f.json) as { nibrsai_cases: string; grouping: string; measures: Record<string, string>; totals: Record<string, { status: string; value: number | null }>;
      rows: ({ month?: string; year?: string } & Record<string, unknown>)[] | null };
    const measures = Object.keys(v.measures);
    const cell = (x: unknown) => x as { status: string; value: number | null };
    const time = timeCells(v as unknown as TimeFile);
    if (time) {
      for (const m of v.nibrsai_cases.matchAll(/(LS-\d{3})(?:\s+"([^"]+)"|\s+(alternative))?/g))
        out.set(m[3] ? `${m[1]}|alternative` : m[2] ? `${m[1]}|${m[2]}` : m[1], time);
      continue;
    }
    // A breakdown's rows carry a category field (race, sex, ethnicity, location_type): keyed by period (if any) and the
    // category's name as NIBRSAI shows it. Each category's share is its count over its own period's independent total:
    // the measure's known total, or the sum of every category of that period when all of them are known (each unit is in
    // exactly one category). No independent total: the share is undefined (unverified), never an expected blank.
    // The file names its category field ("category"); older files are found by the field in their rows.
    const named = (v as { category?: string }).category;
    const catField = named && CATEGORY_FIELDS[named] ? named : Object.keys(CATEGORY_FIELDS).find((f) => (v.rows ?? []).some((r) => f in r));
    // A multi-valued field's categories overlap: their sum is never the period's total.
    const multi = !!catField && MULTI_FIELDS.has(catField);
    const total = v.totals?.[measures[0]];
    const periodTotal = new Map<string, number | null>();
    const add = (p: string, value: number | null) => { const sofar = periodTotal.has(p) ? periodTotal.get(p)! : 0; periodTotal.set(p, sofar === null || value === null ? null : sofar + value); };
    const measureMonths = (v as { months?: Record<string, Record<string, unknown>> }).months;
    if (measureMonths) {
      // The measure's own month cells (independent of the category rows): a year's total when every month is known.
      for (const [m, c] of Object.entries(measureMonths)) { const x = cell(c[measures[0]]); add(m.slice(0, 4), ["VALUE", "REPORTED_ZERO"].includes(x.status) ? x.value ?? 0 : null); }
    } else if (!multi) for (const r of v.rows ?? []) add(String(r.year ?? r.month ?? ""), cell(r[measures[0]]).value);
    const definition = (m: string) => (measures.length > 1 ? { measure: `${m}: ${v.measures[m]}` } : {});
    const cells: ExpectedCell[] = v.grouping === "total" && !catField
      ? measures.map((m) => ({ key: "", ...pick(v.totals[m]), ...definition(m) }))
      : measures.length > 1 && !catField
      ? (v.rows ?? []).flatMap((r) => measures.map((m) => ({ key: String(r.year ?? r.month ?? ""), ...pick(cell(r[m])), ...definition(m) })))
      : (v.rows ?? []).map((r) => {
        const c = pick(cell(r[measures[0]]));
        const code = catField ? (CODE_ALIASES[catField]?.[String(r[catField])] ?? r[catField]) : null;
        const key = [r.year ?? r.month, catField ? categoryName(CATEGORY_FIELDS[catField], code) : null].filter((x) => x !== undefined && x !== null).map(String).join("|");
        const p = String(r.year ?? r.month ?? "");
        // A known 0 denominator (P51) is evidence: its share is an expected blank (UNAVAILABLE). Only absent or unknown
        // denominator evidence leaves the share unverified (Codex P51 review).
        const knownTotal = !!total && ["VALUE", "REPORTED_ZERO"].includes(total.status) && total.value !== null;
        const den = !p && knownTotal ? total!.value! : periodTotal.get(p) ?? undefined;
        const share = c.value === null || den === 0 ? null : den === undefined ? undefined : Math.round((1000 * c.value) / den) / 10;
        return { key, ...c, ...(catField ? { share } : {}) };
      });
    for (const m of v.nibrsai_cases.matchAll(/(LS-\d{3})(?:\s+"([^"]+)"|\s+(alternative))?/g)) {
      const k = m[3] ? `${m[1]}|alternative` : m[2] ? `${m[1]}|${m[2]}` : m[1];
      out.set(P28_VALUE_KEYS[k] ?? k, cells);
    }
  }
  return out;
}
const pick = (c: { status: string; value: number | null }) => ({ value: c.value, status: c.status });
/**
 * Batch 6 (increment 3): time files carry `periods` (each with its total), and for a change its `change`, for rolling
 * windows its `rolling`. A set of years: a cell per year. A change: the cells "earlier", "later", "change" and
 * "pct_change" (no percent from a zero base is UNAVAILABLE, from an unknown period UNKNOWN). Rolling: a cell per
 * displayed month. One period with no `totals` (the last 12 months): its total. Null for any other file.
 */
type TimeTotal = { status: string; value: number | null };
type TimeFile = { grouping: string; totals?: unknown; periods?: { from: string; to: string; total: TimeTotal }[];
  change?: { change: number | null; percent_change: number | null; percent_reason?: string };
  rolling?: { month: string; total: TimeTotal }[] };
function timeCells(v: TimeFile): ExpectedCell[] | null {
  if (!v.periods) return null;
  if (v.grouping === "years") return v.periods.map((p) => ({ key: p.from.slice(0, 4), ...pick(p.total) }));
  if (v.grouping === "change" && v.change && v.periods.length === 2) {
    const c = v.change;
    return [{ key: "earlier", ...pick(v.periods[0].total) }, { key: "later", ...pick(v.periods[1].total) },
      { key: "change", value: c.change, status: c.change === null ? "UNKNOWN" : "VALUE" },
      { key: "pct_change", value: c.percent_change, status: c.percent_change !== null ? "VALUE" : c.percent_reason ? "UNAVAILABLE" : "UNKNOWN" }];
  }
  if (v.grouping === "rolling" && v.rolling) return v.rolling.map((r) => ({ key: r.month, ...pick(r.total) }));
  if (v.grouping === "total" && !v.totals && v.periods.length === 1) return [{ key: "", ...pick(v.periods[0].total) }];
  return null;
}
/** nibrs-model's breakdown field names -> the plan's grouping dimensions. */
const CATEGORY_FIELDS: Record<string, string> = { race: "victim.race", sex: "victim.sex", ethnicity: "victim.ethnicity", location_type: "offense.location_type",
  weapon: "offense_weapon.weapon", relationship: "victim_offender.relationship", age_group: "victim.age", offender_sex: "offender.sex", offender_segment_sex: "offender.sex" };
const MULTI_FIELDS = new Set(["weapon", "relationship", "offender_sex"]);
/** nibrs-model's category codes that NIBRSAI labels differently (batch 5). */
const CODE_ALIASES: Record<string, Record<string, string>> = {
  age_group: { under_18: "Under 18", "00": "Unknown" },
  offender_sex: { "00": "unknown_offender" },
};
/**
 * Values requested before a label changed: P28 made these questions ask city or county first, so the city's values serve
 * the city button; P06's button now names its year. (nibrs-model's files name the cases as they were requested.)
 */
export const P28_VALUE_KEYS: Record<string, string> = { "LS-151": "LS-151|Baltimore city, Maryland", "LS-223": "LS-223|Baltimore city, Maryland", "LS-224": "LS-224|St. Louis city, Missouri",
  // P06 names the latest complete year on its button (Codex slice review 1).
  "LS-233|The latest complete year": "LS-233|The latest complete year (2025)",
  // LS-140 asks the city or county first; the years are asked behind the city button.
  "LS-140|Every year available": "LS-140|St. Louis city, Missouri|Every year available" };

const normLabel = (s: string) => s.toLowerCase().replace(/^the /, "").replace(/[^a-z0-9]+/g, " ").trim();
const LABEL_REASON: [RegExp, string][] = [
  [/agency level|zip code|neighborhood/i, "below_agency_level"], [/court|conviction|prosecution|defendant|charging|charged/i, "court_outcome"],
  // P45, P31: terms the data does not define, and counts it does not hold.
  [/not a term the data defines|non-fatal shootings/i, "not_recorded_in_nibrs"],
  [/cannot predict|predict/i, "forecast"], [/is not in the data/i, "outside_release_coverage"], [/cause/i, "explanation_requested"],
];
const reasonClass = (s: string) => LABEL_REASON.find(([re]) => re.test(s))?.[1] ?? null;
/** The answered plan as a meaning; a set of years keeps its years (through the answer's end when clipped). */
const viewOf = (plan: NibrsPlan, p: { from: string; to: string }) => planToMeaning(plan, plan.period.kind === "years"
  ? { kind: "years", years: plan.period.years, ...(p.to < `${Math.max(...plan.period.years)}-12` ? { through: p.to } : {}) }
  : { kind: "absolute", ...p });

const MONTH_WORDS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** "November and December 2025", "September 2026" -> ["2025-11", "2025-12"], ["2026-09"]. */
function monthsNamed(words: string): string[] {
  const out: string[] = [];
  for (const m of words.toLowerCase().matchAll(new RegExp(`((?:(?:${MONTH_WORDS.join("|")})(?:,\\s*|\\s+and\\s+|\\s+)?)+)(\\d{4})`, "g")))
    for (const name of m[1].match(new RegExp(MONTH_WORDS.join("|"), "g")) ?? []) out.push(`${m[2]}-${String(MONTH_WORDS.indexOf(name) + 1).padStart(2, "0")}`);
  return out;
}
/** The months a "No report is known for ..." sentence names, ranges ("November 2025 to December 2025") expanded. */
function monthsReported(text: string[]): Set<string> {
  const out = new Set<string>();
  const idx = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
  const ymOf = (k: number) => `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`;
  for (const t of text.filter((x) => /^No report is known for /.test(x))) {
    const list = /^No report is known for (.+?)(?:[:,] |$)/.exec(t)?.[1] ?? "";
    for (const part of list.split(/,\s*/)) {
      const ends = part.split(/\s+to\s+/).map(monthsNamed).map((x) => x[0]).filter(Boolean);
      if (ends.length === 2) for (let k = idx(ends[0]); k <= idx(ends[1]); k++) out.add(ymOf(k));
      else if (ends.length === 1) out.add(ends[0]);
    }
  }
  return out;
}
/** Words that characterize a change instead of reporting it (P54: no adjectives). */
const ADJECTIVES = /\b(?:sharply|slightly|significantly|dramatically|substantially|modestly|markedly|considerably|steeply|notably|alarming(?:ly)?|huge|massive|small|large)\b/i;

/** The label's agency name as the words an answer must carry (its city), e.g. "St. Louis". */
function agencyWords(name: string): string {
  return name.replace(/\b(Metropolitan|Metro|Police|Department|Bureau|Division of|Sheriff'?s?|Office|County)\b/g, " ").replace(/\s+/g, " ").trim();
}

/** A comparison answer's cells by output ("earlier", "later", "change", "pct_change"), or null for any other answer. */
function comparisonCells(o: Extract<ShadowOutcome, { kind: "answer" }>): Record<string, number | null> | null {
  const cols = o.delivered.table.columns;
  if (!cols.length || !cols.every((c) => c.binding.kind === "statistic" && /\.(earlier|later|change|pct_change)$/.test(c.binding.as))) return null;
  return Object.fromEntries(cols.map((c, i) => [(c.binding as { as: string }).as.split(".").pop()!, o.delivered.table.rows[0]?.[i] as number | null]));
}

/**
 * A comparison answer's text is only its templates, and its numbers are the table's (Codex increment-3 review): the
 * header line; the same-months line; the change line, rebuilt from the cells; the zero-base line; a known period's count;
 * a period not established; then readings, fixed statements and the source.
 */
/** A rate's column says per 100,000 residents. */
const rateHeader = (o: Extract<ShadowOutcome, { kind: "answer" }>) =>
  o.plan.statistics.some((x) => x.kind === "rate") && o.delivered.table.columns.some((c) => c.binding.kind === "statistic" && /per 100,000 residents$/.test(c.header));

function comparisonProse(o: Extract<ShadowOutcome, { kind: "answer" }>): boolean {
  const cols = comparisonCells(o);
  const t = o.plan.transforms.find((x) => x.kind === "period_comparison");
  if (!cols || !t || t.kind !== "period_comparison") return false;
  const E = periodWords(t.earlier.from, t.earlier.to), L = periodWords(t.later.from, t.later.to);
  const f = (n: number) => n.toLocaleString("en-US");
  const signed = (n: number) => (n > 0 ? `+${f(n)}` : n < 0 ? `-${f(-n)}` : "0");
  const changeLine = cols.change === null ? null : `${f(cols.earlier!)} in ${E} and ${f(cols.later!)} in ${L}: a change of ${signed(cols.change)}${cols.pct_change !== null ? ` (${cols.pct_change > 0 ? "+" : ""}${cols.pct_change}%)` : ""}.`;
  const allowed = (line: string) => line === changeLine || line === "The percent change cannot be computed from a zero base." || /^Source: /.test(line) || /^Read "/.test(line)
    || (Object.values(ANSWER_STATEMENTS) as string[]).includes(line) || /^Compares the same months of each year: [A-Za-z ]+\.$/.test(line)
    || line.endsWith(`, ${E} against ${L}.`)
    || (cols.change === null && ((cols.earlier !== null && line === `${f(cols.earlier)} in ${E}.`) || (cols.later !== null && line === `${f(cols.later)} in ${L}.`)
      || new RegExp(`^No report is known for .+, so the (?:${E}|${L}) total is not established and no change is given\\.$`).test(line)));
  const text = o.delivered.text;
  return text.every(allowed) && (changeLine === null || text.includes(changeLine)) && (cols.pct_change !== null || cols.change === null || text.includes("The percent change cannot be computed from a zero base."));
}

function statementDiffs(e: Extract<NonNullable<Case["expected"]>, { action: "answer" }>, o: Extract<ShadowOutcome, { kind: "answer" }>): Diff[] {
  const out: Diff[] = [];
  const text = o.delivered.text;
  const all = text.join(" ");
  // Missing reporting evidence only: a share UNAVAILABLE because its denominator is a known 0 is not a missing month.
  const blank = o.delivered.evidence.some((x) => !["VALUE", "REPORTED_ZERO", "UNAVAILABLE"].includes(x.status));
  for (const s of e.statements) {
    let ok: boolean | null = null;
    const ag = /^names the agency \((.+)\)$/.exec(s);
    if (ag) ok = all.toLowerCase().includes(agencyWords(ag[1]).toLowerCase());
    else if (s === "names its source at the end") ok = /^Source: /.test(text[text.length - 1]) && text.filter((t) => /^Source: /.test(t)).length === 1;
    else if (/^[A-Z].*\.$/.test(s) && !/^(names|says|states|labels)\b/.test(s)) ok = text.includes(s);   // a fixed sentence
    else if (s === "names any months with no data as missing, not zero") ok = !blank || /No report is known for|Not every month of|were recorded for|does not establish|No total is established for/.test(all);
    else if (s === "names the months covered") ok = all.includes(periodWords(o.period.from, o.period.to));
    else if (/^says drug crimes include/.test(s)) ok = /drug equipment/i.test(all);
    else if (/^says a unit with several categories counts once in each/.test(s)) ok = text.includes(ANSWER_STATEMENTS.categories_overlap);
    else if (/^says each arrest counts once/.test(s)) ok = text.includes(ANSWER_STATEMENTS.arrests_counted_once);
    else if (/^gives the .* total \(/.test(s)) {
      // The combined total: a "Together:" sentence whose number is the sum of the table's counts (all of them known).
      const cells = o.delivered.table.rows[0]?.filter((x) => typeof x === "number" || x === null) ?? [];
      const sum = cells.every((x) => typeof x === "number") ? (cells as number[]).reduce((a, b) => a + b, 0) : null;
      // Exactly that number, under the total's own name ("gun-crime" -> gun crime), never a number merely containing it
      // (Codex review 02).
      const lines = text.filter((t) => /^Together: /.test(t));
      const m = lines.length === 1 ? /^Together: ([\d,]+) (.+) in .+\.$/.exec(lines[0]) : null;
      const name = (/^gives the (?:combined )?(.+?) total \(/.exec(s)?.[1] ?? "").replace(/-/g, " ").replace(/s$/, "");
      ok = o.delivered.table.rows.length === 1 && (sum === null ? !lines.length && /No combined total/.test(all)
        : !!m && Number(m[1].replace(/,/g, "")) === sum && m[2].replace(/s$/, "").includes(name));
    } else if (/^names the crimes counted \((.+)\)$/.test(s)) {
      // Each crime named, and the weapon.
      const inner = /^names the crimes counted \((.+)\)$/.exec(s)![1];
      const [crimes, weapon] = inner.split(/ with an? /);
      ok = crimes.split(/,\s*|\s+and\s+/).every((x) => all.toLowerCase().includes(x.trim().toLowerCase())) && (!weapon || all.toLowerCase().includes(weapon.toLowerCase()));
    } else if (/^groups ages as /.test(s)) {
      // The age groups named with what they hold: every group of the plan, infants, unknown and not-recorded ages.
      const line = text.find((t) => /^Age groups: /.test(t)) ?? "";
      const bins = o.plan.groupings.find((g) => g.bins)?.bins ?? [];
      ok = bins.length > 0 && bins.every((b) => line.includes(b.label)) && /infants/.test(line) && /Unknown/.test(line) && /Not recorded/.test(line);
    }
    // Increment 3: comparisons and rolling windows.
    else if (/^gives both counts, the change and the percent change, with no adjectives$/.test(s) || /^gives both counts and the change$/.test(s)) {
      const cols = comparisonCells(o);
      const need = /percent/.test(s) ? ["earlier", "later", "change", "pct_change"] : ["earlier", "later", "change"];
      ok = !!cols && need.every((k) => typeof cols[k] === "number") && !ADJECTIVES.test(all) && comparisonProse(o);
    } else if (s === "says the percent change cannot be computed from a zero base") ok = text.includes("The percent change cannot be computed from a zero base.") && comparisonCells(o)?.pct_change === null && comparisonProse(o);
    else if (/^makes no change claim/.test(s)) { const cols = comparisonCells(o); ok = !!cols && cols.change === null && cols.pct_change === null && !/a change of/.test(all) && comparisonProse(o); }
    else if (/^names the comparison year \((\d{4})\)$/.test(s)) ok = new RegExp(`\\b${/\((\d{4})\)/.exec(s)![1]}\\b`).test(text[0] ?? "");
    else if (s === "names the months compared") {
      const t = o.plan.transforms.find((x) => x.kind === "period_comparison");
      ok = !!t && t.kind === "period_comparison" && all.includes(periodWords(t.earlier.from, t.earlier.to)) && all.includes(periodWords(t.later.from, t.later.to));
    } else if (s === "compares the same months of each year") ok = /^Compares the same months of each year: /m.test(text.join("\n"));
    else if (/^names (.+) as having no data$/.test(s)) {
      const want = monthsNamed(/^names (.+) as having no data$/.exec(s)![1]);
      const named = monthsReported(text);
      ok = want.length > 0 && want.every((m) => named.has(m));
    } else if (s === "defines each point as the sum of the 12 months ending that month") ok = text.includes("Each month's figure is the total of that month and the 11 months before it.");
    else if (/^shows (?:any window lacking a month|the windows ending .+|every window) as missing/.test(s)) {
      // Each window with a status other than a known one is blank (never zero or a shorter sum); "the windows ending A
      // through B" and "every window" also say which windows those are.
      const rows = o.delivered.table.rows;
      // Every displayed month, in order: a window cannot pass by being left out.
      const months: string[] = [];
      for (let k = Number(o.period.from.slice(0, 4)) * 12 + Number(o.period.from.slice(5)) - 1; k <= Number(o.period.to.slice(0, 4)) * 12 + Number(o.period.to.slice(5)) - 1; k++)
        months.push(`${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`);
      const complete = rows.map((r) => String(r[0])).join(",") === months.join(",");
      const blankAt = rows.map((r) => r[1] === null);
      const statusBlank = o.delivered.evidence.map((x) => !["VALUE", "REPORTED_ZERO"].includes(x.status));
      ok = complete && rows.length > 0 && blankAt.every((b, i) => b === statusBlank[i]);
      const span = /^shows the windows ending (.+?) through (.+?) as missing/.exec(s);
      if (ok && span) {
        const [a, b] = [monthsNamed(span[1])[0], monthsNamed(span[2])[0]];
        ok = rows.every((r) => (String(r[0]) >= a && String(r[0]) <= b) === (r[1] === null));
      }
      if (ok && /^shows every window as missing/.test(s)) ok = rows.every((r) => r[1] === null);
    }
    else if (/^shows unknown and not-recorded categories as their own rows/.test(s)) {
      // Every row names its category (unknown and not-recorded are named categories); only number cells may be blank.
      const cols = o.delivered.table.columns.map((c, i) => (c.binding.kind === "grouping" && !c.binding.dimension.startsWith("time.") ? i : -1)).filter((i) => i >= 0);
      ok = cols.length > 0 && o.delivered.table.rows.every((r) => cols.every((i) => typeof r[i] === "string" && r[i] !== ""));
    }
    // Increment 4: several agencies, combined totals, rates and rankings.
    else if (/^gives one total of both agencies/.test(s)) {
      // One known number of the plan's distinct agencies, said as combined.
      const oris = o.plan.geography.places.map((p) => (p.kind === "agency" ? p.ori : ""));
      ok = o.plan.geography.combine === "combined" && new Set(oris).size === 2 && oris.every(Boolean) && o.delivered.table.rows.length === 1
        && typeof o.delivered.table.rows[0][0] === "number" && /, combined: [\d,]+ /.test(text[0] ?? "");
    } else if (/^gives no (?:combined total|rate), because not every month|^gives no combined total, because/.test(s)) {
      // Blank, with a reason, never a part-sum.
      ok = o.delivered.table.rows.length === 1 && o.delivered.table.rows[0].every((x) => typeof x === "string" || x === null)
        && o.delivered.evidence.every((x) => x.status !== "VALUE") && /no (?:total|rate) is given .*because not every month is known/.test(text[0] ?? "");
    } else if (s === "gives the rate per 100,000 residents and names the population and its year") {
      const y = o.period.to.slice(0, 4);
      ok = rateHeader(o) && text.some((t) => new RegExp(`the FBI's ${y} population of the agency: .+ [\\d,]+\\.$`).test(t));
    } else if (s === "gives each year's rate over that year's population") {
      const line = text.find((t) => /^Each year's rate uses the FBI's population for that year: /.test(t)) ?? "";
      ok = rateHeader(o) && o.plan.groupings.some((g) => g.dimension === "time.year") && o.delivered.table.rows.length > 0
        && o.delivered.table.rows.every((r) => new RegExp(`\\b${r[0]} [\\d,]+`).test(line));
    } else if (s === "gives each agency's rate over its own population") {
      const line = text.find((t) => /population of each agency: /.test(t)) ?? "";
      ok = rateHeader(o) && o.plan.geography.combine !== "combined" && o.delivered.table.rows.length > 1
        && o.delivered.table.rows.every((r) => line.includes(`${r[0]} `));
    } else if (/^gives one rate: both agencies' offenses over both agencies' populations/.test(s)) {
      ok = rateHeader(o) && o.plan.geography.combine === "combined" && o.delivered.table.rows.length === 1
        && text.some((t) => /^The rate is both agencies' offenses over both agencies' populations /.test(t));
    } else if (s === "says the rate is for those months and is not annualized") ok = text.some((t) => /the rate is for those months and is not annualized\.$/.test(t));
    else if (/^shows (?:exactly )?(\d+) agencies/.test(s)) ok = o.delivered.table.rows.length === Number(/(\d+)/.exec(s)![1]);
    else if (/^ranks only agencies that reported (?:all 12 months of (\d{4})|every month of (\d{4}) so far)/.test(s)) {
      // The rule said, every ranked agency known, the left-out named with their months, and no button to include them.
      const when = periodWords(o.period.from, o.period.to);
      const full = o.period.from.slice(5) === "01" && o.period.to.slice(5) === "12" ? `all 12 months of ${when}` : `every month of ${when}`;
      ok = text.includes(`Ranked: agencies that reported ${full}; ties are ordered by agency name.`)
        && o.delivered.evidence.every((x) => x.status === "VALUE" || x.status === "REPORTED_ZERO")
        && text.filter((t) => t.startsWith("Not ranked because they didn't report")).every((t) => /\(\d+ months?\)/.test(t))
        && !("alternative" in o && (o as { alternative?: unknown }).alternative);
    } else if (s === "orders ties alphabetically by agency name") {
      const rows = o.delivered.table.rows;
      ok = text.some((t) => /ties are ordered by agency name/.test(t)) && rows.every((r, i) => i === 0 || r[1] !== rows[i - 1][1] || String(rows[i - 1][0]).localeCompare(String(r[0])) <= 0);
    } else if (s === "adds no other eligibility filter") {
      const p = o.plan.geography.places[0];
      ok = p.kind === "agency_set" && p.where.every((w) => w.field === "agency.type") && o.plan.filters.length === 0;
    } else if (s === "says large means 250,000 residents or more") ok = text.includes("Large means 250,000 residents or more (the FBI's agency population).");
    if (ok === null) out.push({ field: "statement", expected: s, actual: "(no check defined)", kind: "unverified" });
    else if (!ok) out.push({ field: "statement", expected: s, actual: text.join(" / ").slice(0, 200), kind: "material" });
  }
  return out;
}

type Values = "match" | "mismatch" | "not measured";
/**
 * The expected measure a plan measure's column is checked against: the one whose definition names exactly the plan
 * measure's offense codes and its unit (victim, offense, offender, arrest). Null when none or several do.
 */
function matchMeasure(m: NibrsPlan["measures"][number], defs: string[]): string | null {
  const name = m.id.replace(/^[a-z_]+\./, "");
  const codes = MEASURE_CODES[name] ?? ({ drug_equipment: ["35B"] } as Record<string, string[]>)[name];
  if (!codes && name !== "carjacking") return null;
  const unit = { victim: /victim/i, offense: /offense/i, offender: /offender/i, arrest: /arrest/i, arrestee: /arrest/i }[m.unit as string];
  const named = (d: string) => new Set(d.match(/\b(?:\d{2}[A-Z]|\d{3})\b/g) ?? []);
  // Carjacking (D18) is robbery (120) with a motor vehicle taken: its definition names 120 and loss type 7.
  if (name === "carjacking") {
    const cj = defs.filter((d) => named(d).has("120") && /loss type 7/i.test(d) && !!unit?.test(d));
    return cj.length === 1 ? cj[0] : null;
  }
  const hits = defs.filter((d) => { const n = named(d); return n.size === codes.length && codes.every((c) => n.has(c)) && !!unit?.test(d); });
  return hits.length === 1 ? hits[0] : null;
}
/** Several measures side by side (no categories): each measure's column against its own expected cells. */
function severalDiffs(prefix: string, o: Extract<ShadowOutcome, { kind: "answer" }>, expected: ExpectedCell[]): { diffs: Diff[]; values: Values } {
  const { columns, rows } = o.delivered.table;
  const ip = columns.findIndex((c) => c.binding.kind === "grouping");
  const diffs: Diff[] = [];
  const defs = [...new Set(expected.map((x) => x.measure!))];
  const used = new Set<string>();
  for (const m of o.plan.measures) {
    const as = o.plan.statistics.find((s) => "measure" in s && s.measure === m.as)!.as;
    const col = columns.findIndex((c) => c.binding.kind === "statistic" && c.binding.as === as);
    const def = matchMeasure(m, defs);
    if (!def || used.has(def)) { diffs.push({ field: `${prefix}measure ${m.id}`, expected: defs.join("; "), actual: "no single matching expected measure", kind: "unverified" }); continue; }
    used.add(def);
    const want = expected.filter((x) => x.measure === def);
    const got = new Map(rows.map((r, i) => [ip >= 0 ? String(r[ip]) : "", { value: r[col] as number | null, status: o.delivered.evidence.find((e) => e.row === i && e.statistic === as)?.status ?? "?" }]));
    if (got.size !== rows.length) diffs.push({ field: `${prefix}rows`, expected: "each period once", actual: `${rows.length} rows, ${got.size} periods`, kind: "material" });
    if (got.size !== want.length) diffs.push({ field: `${prefix}values ${m.id}`, expected: `${want.length} cells`, actual: `${got.size} cells`, kind: "material" });
    for (const x of want) {
      const g = got.get(x.key);
      if (!g || g.value !== x.value || g.status !== x.status) diffs.push({ field: `${prefix}value ${m.id} ${x.key || "total"}`, expected: `${x.value} ${x.status}`, actual: g ? `${g.value} ${g.status}` : "missing", kind: "material" });
    }
  }
  if (used.size !== defs.length) diffs.push({ field: `${prefix}measures`, expected: defs.join("; "), actual: `${used.size} matched`, kind: diffs.some((d) => d.kind === "unverified") ? "unverified" : "material" });
  return { diffs, values: diffs.some((d) => d.kind === "material") ? "mismatch" : diffs.length ? "not measured" : "match" };
}
/** Delivered cells (value and status) against independent expected cells; none given is NOT MEASURED, never a match. */
function valueDiffs(prefix: string, o: Extract<ShadowOutcome, { kind: "answer" }>, expected: ExpectedCell[] | undefined): { diffs: Diff[]; values: Values } {
  if (!expected) return { values: "not measured", diffs: [{ field: `${prefix}values`, expected: "independent expected values", actual: "none given: NOT MEASURED", kind: "unverified" }] };
  // A change: each output cell (earlier, later, change, percent change) against its expected cell, value and status.
  const cmpCells = comparisonCells(o);
  if (cmpCells) {
    const as = o.plan.statistics[0].as;
    const diffs: Diff[] = [];
    // A change is one row: any other row is a number no expected cell vouches for (Codex value-loading review).
    if (o.delivered.table.rows.length !== 1) diffs.push({ field: `${prefix}rows`, expected: "one comparison row", actual: `${o.delivered.table.rows.length} rows`, kind: "material" });
    for (const k of ["earlier", "later", "change", "pct_change"]) {
      const x = expected.find((e) => e.key === k);
      const status = o.delivered.evidence.find((e) => e.statistic === `${as}.${k}`)?.status ?? "?";
      if (!x) diffs.push({ field: `${prefix}value ${k}`, expected: "an expected cell", actual: "none given", kind: "unverified" });
      else if (cmpCells[k] !== x.value || status !== x.status) diffs.push({ field: `${prefix}value ${k}`, expected: `${x.value} ${x.status}`, actual: `${cmpCells[k]} ${status}`, kind: "material" });
    }
    return { diffs, values: diffs.some((d) => d.kind === "material") ? "mismatch" : diffs.length ? "not measured" : "match" };
  }
  if (o.plan.measures.length > 1 || expected.some((x) => x.measure)) {
    if (o.plan.measures.length > 1 && expected.every((x) => x.measure)) return severalDiffs(prefix, o, expected);
    return { values: "mismatch", diffs: [{ field: `${prefix}measures`, expected: `${new Set(expected.map((x) => x.measure)).size} measures`, actual: `${o.plan.measures.length} measures`, kind: "material" }] };
  }
  // Each row by its grouping values (period, category), its count by the first statistic's column, its share (if any)
  // by the second's.
  const { columns, rows } = o.delivered.table;
  const groupCols = columns.map((c, i) => (c.binding.kind === "grouping" ? i : -1)).filter((i) => i >= 0);
  const statCol = (n: number) => columns.findIndex((c, i) => c.binding.kind === "statistic" && columns.slice(0, i).filter((x) => x.binding.kind === "statistic").length === n);
  const [ci, si] = [statCol(0), statCol(1)];
  const countAs = (columns[ci].binding as { as: string }).as;
  const keys = rows.map((r) => groupCols.map((j) => String(r[j])).join("|"));
  const got = new Map(rows.map((r, i) => [keys[i],
    { value: r[ci] as number | null, share: si >= 0 ? (r[si] as number | null) : undefined, status: o.delivered.evidence.find((e) => e.row === i && e.statistic === countAs)?.status ?? "?" }]));
  const diffs: Diff[] = [];
  // A key delivered twice could hide a wrong row behind a right one: never compared, always wrong.
  const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (twice.length) diffs.push({ field: `${prefix}rows`, expected: "each grouping once", actual: `repeated: ${[...new Set(twice)].join(", ")}`, kind: "material" });
  if (got.size !== expected.length) diffs.push({ field: `${prefix}values`, expected: `${expected.length} cells`, actual: `${got.size} cells`, kind: "material" });
  // A breakdown promises each category's share (increment 1): a table without it is incomplete.
  if (si < 0 && expected.some((x) => "share" in x)) diffs.push({ field: `${prefix}shares`, expected: "each category's share of its period", actual: "no share column", kind: "material" });
  for (const x of expected) {
    const g = got.get(x.key);
    if (!g || g.value !== x.value || g.status !== x.status) diffs.push({ field: `${prefix}value ${x.key || "total"}`, expected: `${x.value} ${x.status}`, actual: g ? `${g.value} ${g.status}` : "missing", kind: "material" });
    else if (g.share !== undefined && x.share !== undefined && g.share !== x.share)   // null against a number included
      diffs.push({ field: `${prefix}share ${x.key}`, expected: String(x.share), actual: String(g.share), kind: "material" });
    else if (g.share !== undefined && x.share === undefined)
      diffs.push({ field: `${prefix}share ${x.key}`, expected: "(no independent share)", actual: String(g.share), kind: "unverified" });
  }
  return { diffs, values: diffs.some((d) => d.kind === "material") ? "mismatch" : diffs.length ? "not measured" : "match" };
}
const worst = (vs: Values[]): Values | undefined => (vs.includes("mismatch") ? "mismatch" : vs.includes("not measured") ? "not measured" : vs.length ? "match" : undefined);
const sameAbout = (a: string, b: string) => normLabel(a) === normLabel(b);

/** What checking one delivered outcome found: its diffs, its value verdicts, and whether it delivered a wrong number. */
type Check = { diffs: Diff[]; values: Values[]; wrong: boolean; unverifiedAnswers: number };
const none = (): Check => ({ diffs: [], values: [], wrong: false, unverifiedAnswers: 0 });
const merge = (a: Check, b: Check): Check => ({ diffs: [...a.diffs, ...b.diffs], values: [...a.values, ...b.values], wrong: a.wrong || b.wrong, unverifiedAnswers: a.unverifiedAnswers + b.unverifiedAnswers });

/**
 * A delivered answer behind a button or an offered alternative, checked as a direct answer is: the meaning it should
 * have (when the label gives one), its values under `key`, the answer contract, and the text every answer must carry
 * (the agency named, months with no data named, the source last). A wrong meaning, value or contract is a wrong
 * answer; anything that cannot be checked leaves the answer unverified.
 */
function deliveredCheck(prefix: string, key: string, c: Extract<ShadowOutcome, { kind: "answer" }>, want: Meaning | null, r: Release, ev: ExpectedValues | undefined, ctx: Walk): Check {
  ctx.checked.add(c);
  const meaning = want ? compareMeaning(want, viewOf(c.plan, c.period), r).map((x) => ({ ...x, field: `${prefix}${x.field}` }))
    : [{ field: `${prefix}meaning`, expected: "(the label gives no meaning past this button)", actual: `${c.plan.measures[0].id} ${c.period.from}..${c.period.to}`, kind: "unverified" as const }];
  const v = valueDiffs(prefix, c, ev?.get(key));
  const contract: Diff[] = c.delivered.contractProblems.length ? [{ field: `${prefix}answer contract`, expected: "no problems", actual: c.delivered.contractProblems.join("; "), kind: "material" }] : [];
  const place = want?.places[0];
  const required = [...(place && place.kind !== "national" && place.kind !== "state" ? [`names the agency (${place.name})`] : []), "names any months with no data as missing, not zero", "names its source at the end"];
  const text = [...statementDiffs({ statements: required } as never, c), ...fixedStatementDiffs(ctx.question, c)].map((x) => ({ ...x, field: `${prefix}${x.field}` }));
  const diffs = [...meaning, ...v.diffs, ...contract, ...text];
  const wrong = [...meaning, ...v.diffs, ...contract].some((x) => x.kind === "material");
  return { diffs, values: [v.values], wrong, unverifiedAnswers: !wrong && diffs.some((x) => x.kind === "unverified") ? 1 : 0 };
}

/** The question and the answers already checked against a label, shared by one case's checks. */
type Walk = { question: string; checked: Set<object> };

/**
 * The fixed sentences an answer must carry where they apply (result.ts ANSWER_STATEMENTS), checked on its text:
 * property_counted_by_offense when the question asks for victims and the answer counts offenses (P11);
 * property_not_attributed for an incident-level property filter; reported_nibrs_counts for the nation;
 * categories_overlap for a multi-valued grouping; arrests_counted_once for arrests (P46).
 */
function fixedStatementDiffs(question: string, c: Extract<ShadowOutcome, { kind: "answer" }>): Diff[] {
  const plan = c.plan;
  const want: AnswerStatement[] = [];
  if (/\bvictims?\b/i.test(question) && plan.measures.every((m) => m.unit === "offense")) want.push("property_counted_by_offense");
  if ([...plan.filters, ...plan.measures.flatMap((m) => m.filters ?? [])].some((f) => f.kind === "exists" && f.entity === "property")) want.push("property_not_attributed");
  if (plan.geography.places.some((p) => p.kind === "national")) want.push("reported_nibrs_counts");
  if (plan.groupings.some((g) => g.multiValue)) want.push("categories_overlap");
  if (plan.measures.some((m) => m.unit === "arrest" || m.unit === "arrestee")) want.push("arrests_counted_once");
  return want.filter((s) => !c.delivered.text.includes(ANSWER_STATEMENTS[s]))
    .map((s) => ({ field: "statement", expected: ANSWER_STATEMENTS[s], actual: c.delivered.text.join(" / ").slice(0, 200), kind: "material" as const }));
}

/**
 * Every answer the outcome delivers, wherever it sits (the answer itself, any button however deep, any offered
 * alternative, expected by the label or not), visited once. One not already checked against the label is checked
 * without a meaning: its values where given, its contract and its text, and it stays unverified.
 */
function walkAnswers(prefix: string, key: string, o: ShadowOutcome, r: Release, ev: ExpectedValues | undefined, ctx: Walk): Check {
  if (o.kind === "answer") return ctx.checked.has(o) ? none() : deliveredCheck(prefix, key, o, null, r, ev, ctx);
  if (o.kind === "clarify") return o.options.reduce((acc, x) => (x.continuation ? merge(acc, walkAnswers(`${prefix}option "${x.label}" `, `${key}|${x.label}`, x.continuation, r, ev, ctx)) : acc), none());
  return o.alternative?.continuation ? walkAnswers(`${prefix}alternative `, `${key}|alternative`, o.alternative.continuation, r, ev, ctx) : none();
}

/**
 * An option's or alternative's continuation against what it should reach: the label's meaning and everything a
 * delivered answer must satisfy (deliveredCheck). An option that asks the next part must ask the part the label names,
 * and the answers behind that next question are checked too.
 */
function continuationCheck(prefix: string, key: string, want: Meaning | null, wantLeads: string, nextAbout: string | undefined, got: ShadowOption, r: Release, ev: ExpectedValues | undefined, ctx: Walk): Check {
  const d = (field: string, e: string, a: string, kind: Diff["kind"]): Diff => ({ field: `${prefix}${field}`, expected: e, actual: a, kind });
  const one = (x: Diff): Check => ({ ...none(), diffs: [x] });
  if (wantLeads === "clarify") {
    const asked = got.entry ?? (got.continuation?.kind === "clarify" ? got.continuation.about : null);
    if (asked === null) return one(d("", `asks ${nextAbout ?? "the next part"}`, got.continuation?.kind ?? got.otherSource ?? "?", "material"));
    return { ...none(), diffs: nextAbout && !sameAbout(asked, nextAbout) ? [d("next part", nextAbout, asked, "material")] : [] };
  }
  if (got.entry) return one(d("", wantLeads, `opens an entry (${got.entry})`, "material"));
  if (got.otherSource) return one(want && want.source === got.otherSource ? d("", `${want.source} answer`, `routed to ${got.otherSource}: not run by this NIBRS shadow`, "unverified") : d("source", want?.source ?? wantLeads, got.otherSource, "material"));
  const c = got.continuation!;
  if (c.kind === "decline" && c.notBuilt) return one(d("", wantLeads, "refused: this build does not hold the months (not built)", "unverified"));
  if (c.kind === "decline" && /^Not in the slice yet/.test(c.explanation)) return one(d("", wantLeads, c.explanation, "unverified"));
  if (wantLeads === "answer") {
    if (c.kind !== "answer") return one(d("", "answer", `${c.kind}: ${c.kind === "decline" ? c.explanation.slice(0, 160) : c.about}`, "material"));
    return deliveredCheck(prefix, key, c, want, r, ev, ctx);
  }
  return { ...none(), diffs: c.kind === wantLeads ? [] : [d("", wantLeads, c.kind, "material")] };
}

export type ShadowScore = { result: CaseResult | null; excluded?: string };

export function scoreShadow(c: Case, o: ShadowOutcome, r: Release, ctx: { capability: string; era: string }, expectedValues?: ExpectedValues): ShadowScore {
  const e = c.expected!;
  const actual: ActualAction = o.kind;
  const notes: string[] = [];
  let diffs: Diff[] = [];
  const vals: Values[] = [];
  let wrongBehindButton = false, unverifiedAnswers = 0;
  const take = (k: Check) => { diffs.push(...k.diffs); vals.push(...k.values); wrongBehindButton ||= k.wrong; unverifiedAnswers += k.unverifiedAnswers; };
  const walk: Walk = { question: c.question, checked: new Set() };
  if (o.kind === "decline" && o.notBuilt) return { result: null, excluded: `refused as not built: ${o.explanation}` };
  if (o.kind === "decline") notes.push(`declined (${o.reason}): ${o.explanation.slice(0, 200)}`);
  if (o.kind === "clarify") notes.push(`asked ${o.about}: ${o.options.map((x) => x.label).join(" | ")}`);
  let structured = true, alternativeMissing = false;
  if (e.action === "answer" && o.kind === "answer") {
    walk.checked.add(o);
    diffs = [...compareMeaning(e.meaning, viewOf(o.plan, o.period), r), ...statementDiffs(e, o), ...fixedStatementDiffs(c.question, o)];
    const v = valueDiffs("", o, expectedValues?.get(c.id));
    diffs.push(...v.diffs); vals.push(v.values);
    if (v.diffs.some((x) => x.kind === "unverified")) unverifiedAnswers++;
    if (o.delivered.contractProblems.length) diffs.push({ field: "answer contract", expected: "no problems", actual: o.delivered.contractProblems.join("; "), kind: "material" });
    notes.push(`delivered: ${o.delivered.text.join(" / ").slice(0, 240)}`);
  }
  if (e.action === "clarify" && o.kind === "clarify") {
    for (const want of e.options) {
      const got = o.options.find((x) => normLabel(x.label) === normLabel(want.label));
      if (!got) { diffs.push({ field: `option "${want.label}"`, expected: "offered", actual: "missing", kind: "material" }); continue; }
      take(continuationCheck(`option "${want.label}" `, `${c.id}|${want.label}`, want.meaning, want.leads_to, want.next_about, got, r, expectedValues, walk));
    }
    for (const got of o.options) if (!e.options.some((w) => normLabel(w.label) === normLabel(got.label))) diffs.push({ field: `option "${got.label}"`, expected: "not offered", actual: "offered", kind: "material" });
    structured = !diffs.some((x) => x.kind === "unverified");
  }
  if (e.action === "decline" && o.kind === "decline") {
    const want = reasonClass(e.reason);
    if (!want) diffs.push({ field: "reason", expected: e.reason, actual: o.reason, kind: "unverified" });
    else if (want !== o.reason) diffs.push({ field: "reason", expected: `${want}: ${e.reason}`, actual: `${o.reason}: ${o.explanation.slice(0, 160)}`, kind: "material" });
    if (e.alternative) {
      if (!o.alternative) alternativeMissing = true;
      else {
        take(continuationCheck("alternative ", `${c.id}|alternative`, e.alternative, "answer", undefined, o.alternative, r, expectedValues, walk));
      }
    }
    structured = !diffs.some((x) => x.kind === "unverified");
  }
  // Then every other answer the outcome delivers, whatever the label expected.
  const rest = walkAnswers("", c.id, o, r, expectedValues, walk);
  take(rest);
  if (rest.diffs.length) structured = false;
  const material = diffs.filter((x) => x.kind === "material").length;
  const unverified = diffs.filter((x) => x.kind === "unverified").length;
  let outcome: Outcome = outcomeOf(e.action, actual, { material, unverified, structured, alternativeMissing });
  // The right action that carries the wrong options, reason or alternative is incomplete, never correct.
  if (e.action !== "answer" && actual === e.action && material) outcome = "incomplete";
  // A wrong number delivered anywhere, directly or behind a button or an offered alternative, is a wrong answer.
  // So is a number for a different question behind a button (a wrong meaning or contract).
  const values = worst(vals);
  if (values === "mismatch" || wrongBehindButton) outcome = "wrong_answer";
  return { result: { id: c.id, split: c.split, expected: e.action, actual, outcome, diffs, notes, capability: ctx.capability, era: ctx.era, ...(values ? { values } : {}),
    ...(unverifiedAnswers ? { unverifiedAnswers } : {}) } };
}
