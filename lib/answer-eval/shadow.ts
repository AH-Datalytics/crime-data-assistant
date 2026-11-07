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
import { NOT_YET } from "../nibrs-shadow/wording";
import type { NibrsPlan } from "../nibrs-plan/plan";
import type { ShadowOption, ShadowOutcome } from "../nibrs-shadow/answer";
import { answerDimensions } from "../nibrs-shadow/answer";
import { missingGroupings } from "../nibrs-shadow/named-groupings";
import { ANSWER_STATEMENTS, clearanceDims, peopleFacts, SHOWN, type AnswerStatement } from "../nibrs-plan/result";
import { MEASURE_CODES } from "../nibrs-question-types";
import { categoryName, periodWords, UNKNOWN_NAMES } from "../nibrs-shadow/deliver";
import type { Case, Meaning } from "./case";
import { compareMeaning, fbiNameFor, planToMeaning, type Diff, type PlanView, type Release } from "./compare";
import { RETURN_A } from "../nibrs-shadow/places";
import { readQuestion } from "../nibrs-shadow/reading";
import { coveredText } from "../nibrs-shadow/state-sum";
import { outcomeOf, type ActualAction, type CaseResult, type Outcome } from "./gates";

/** The slice: its designed group, the replay cases inside it, and replay cases next to it (action and reason only). */
export const SLICE_REPLAY = ["LS-151", "LS-140"];
export const SLICE_NEAR = ["LS-124", "LS-135", "LS-146", "LS-156", "LS-043", "LS-150", "LS-160", "LS-141", "LS-012", "LS-020", "LS-005", "LS-009"];
export function sliceGroup(c: Case): "designed" | "replay" | "near" | null {
  if (/^designed:(slice|reader|breakdown|inc2|inc3|inc4|inc5|inc6|inc7|inc7b|category|period|current)-/.test(c.group)) return "designed";
  if (SLICE_REPLAY.includes(c.id)) return "replay";
  if (SLICE_NEAR.includes(c.id)) return "near";
  return null;
}

/**
 * Independent expected cells for one delivered answer, keyed by period ("2024-03", "2024") or "" for a total, with the
 * cell's status. The map's keys: a case id ("LS-219"), a case and one of its options ("LS-231|Kansas City, Missouri"),
 * or a case's alternative ("LS-236|alternative").
 */
/**
 * `unverifiable`: the cell must be there, but no independent value exists for it (an Unknown merged from categories
 * that overlap, P86): its row is required, its value never judged.
 */
export type ExpectedCell = { key: string; value: number | null; status: string; share?: number | null; unverifiable?: true;
  /** Current Trends group sums: the agencies left out (blank) of the agencies counted. */
  blank?: number; agencies?: number;
  /** Increment 6 (P66): the distinct incidents of the cell's units, beside its count. */
  incidents?: number | null;
  /** Increment 7b (P72): the population the cell's rate divides by (the file's FBI agency population). */
  population?: number | null;
  /** A file with several measures: the cell's measure, as "<key>: <definition>" (its codes and unit are matched to the plan's). */
  measure?: string;
  /** A ranking's row: its place in the order (1 = first row). */
  position?: number;
  /** A ranking's agency left out under P60 (not a row): `value` is its months reported. */
  leftOut?: boolean;
  /** Batch 8, the historical file: the column and row (uid) the value is read from (provenance, not just the number). */
  column?: string; uid?: string;
  /**
   * Batch 8, a NIBRS state or national sum (P61): which view the cell belongs to (all reported months, the
   * every-month set, their rates), or "meta" for the disclaimer's figures (key "agencies|<year>" and the like).
   */
  view?: "all" | "every" | "rate" | "every-rate" | "meta" };
export type ExpectedValues = Map<string, ExpectedCell[]>;

/**
 * Reads nibrs-model's slice values (correctness/slice/V*.json on its main branch, read with `git show`, never from a work
 * tree) into expected cells. Each file names the cases it serves in `nibrsai_cases`: `LS-230, LS-233 "This year so
 * far", LS-236 alternative`. A file with more than one measure gives a cell per measure for each period (or the total),
 * each carrying its measure.
 */
/**
 * nibrs-model's merged-Unknown files (V156-V166, 2026-11-02: "one Unknown per period, last", each unit once): a
 * breakdown's categories with one Unknown, for one period or by month or quarter, each with its count and the share of
 * its period's units. They restate earlier files with the Unknown merged, so they are read last and win.
 */
type MergedFile = { nibrsai_cases: string[]; question: string; unknown_rule: string;
  values: { categories?: Record<string, number>; total?: number;
    by_period?: Record<string, { status: string; units: number | null; categories: Record<string, { count: number | null; share_pct: number | null }> }> } };
const MERGED_DIMS: [RegExp, string][] = [[/offender race/, "offender.race"], [/offender sex/, "offender.sex"], [/offender ethnicity/, "offender.ethnicity"],
  [/offender age|offenders .* by age/, "offender.age"], [/victim sex|by sex/, "victim.sex"], [/victim race|by race/, "victim.race"], [/weapon/, "offense_weapon.weapon"], [/by age/, "victim.age"]];
function mergedCells(v: MergedFile): ExpectedCell[] | null {
  if (!v.unknown_rule || !v.values || !Array.isArray(v.nibrsai_cases)) return null;
  const dim = MERGED_DIMS.find(([re]) => re.test(v.question.toLowerCase()))?.[1];
  if (!dim) return null;
  const age = dim.endsWith(".age");
  const name = (k: string) => (k === "Unknown" ? "Unknown" : age ? (k === "under_18" ? "Under 18" : k) : categoryName(dim, k));
  if (v.values.by_period) return Object.entries(v.values.by_period).flatMap(([p, c]) => Object.entries(c.categories).map(([k, x]) => ({
    key: `${p}|${name(k)}`, value: c.status === "VALUE" || c.status === "REPORTED_ZERO" ? x.count : null, status: c.status, share: x.share_pct })));
  const cats = v.values.categories ?? {}, total = v.values.total ?? 0;
  return Object.entries(cats).map(([k, n]) => ({ key: name(k), value: n, status: "VALUE", share: total > 0 ? Math.round((1000 * n) / total) / 10 : null }));
}

export function sliceValues(files: { name: string; json: string }[]): ExpectedValues {
  const out: ExpectedValues = new Map();
  // One-case files (V185 on): a case's all-agencies values, and its Consistent Reporting Agencies values. A case with
  // both asks for all agencies, so the consistent values are its button's ("<case>|button", V197-V201); a case with
  // only the consistent file asks for that view itself (LS-457, V191).
  const allOf = new Map<string, ExpectedCell[]>(), consistentOf = new Map<string, ExpectedCell[]>();
  // The merged-Unknown files last, so they win over the earlier files they restate.
  const merged = (f: { json: string }) => /"unknown_rule"/.test(f.json);
  for (const f of [...files.filter((x) => !merged(x)), ...files.filter(merged)]) {
    const mv = merged(f) ? mergedCells(JSON.parse(f.json) as MergedFile) : null;
    if (mv) { for (const c of (JSON.parse(f.json) as MergedFile).nibrsai_cases) out.set(c, mv); continue; }
    const v = JSON.parse(f.json) as { nibrsai_cases: string; grouping: string; measures: Record<string, string>; totals: Record<string, { status: string; value: number | null }>;
      rows: ({ month?: string; year?: string } & Record<string, unknown>)[] | null };
    // Current Trends group sums (V173-V176, P91): one cell per group, size, month and column, keyed by the file's case;
    // a case names its cell in values.source and bindValueSources hands it over.
    const cur = currentCells(v as unknown as CurrentFile);
    if (cur) { for (const [k, c] of cur) out.set(k, c); continue; }
    // One case per file (V185 on: "nibrsai_case"): a state or national sum by one category, or a circumstance breakdown
    // or filter (V192-V195, code 06 held back and not in the file's rows).
    const one = singleCaseCells(v as unknown as SingleCaseFile, f.name);
    if (one) { (one.consistent ? consistentOf : allOf).set(one.lsCase, one.cells); continue; }
    // A file that lists no cases (SHR's V177-V184) is read only through a case's binding: never a crash.
    if (typeof v.nibrsai_cases !== "string") continue;
    // Batch 8: the historical file's values, and NIBRS state and national sums (P61).
    const batch8 = srsCells(v as unknown as SrsFile) ?? stateSumCells(v as unknown as StateSumFile);
    if (batch8) {
      // A state sum's button (the every-month view) is checked under "<case>|button" with the same cells.
      for (const m of v.nibrsai_cases.matchAll(/LS-\d{3}/g)) { out.set(m[0], batch8); out.set(`${m[0]}|button`, batch8); }
      continue;
    }
    // Batch 10 (increment 7): people, a category map or one count per case.
    const b10 = peopleCells((v as unknown as { values?: Record<string, unknown> }).values);
    if (b10 && !v.measures) {
      for (const m of v.nibrsai_cases.matchAll(/LS-\d{3}/g)) out.set(m[0], b10);
      continue;
    }
    // Batch 9 (increment 6): clearances, property selections and arrests, each case reading its own part of the file.
    const b9 = (v as unknown as { values?: ClearanceValues }).values;
    if (b9 && !v.measures) {
      for (const m of v.nibrsai_cases.matchAll(/LS-\d{3}/g)) { const c = clearanceCells(m[0], b9); if (c) out.set(m[0], c); }
      continue;
    }
    if (!v.measures) continue;   // a file of no form read here: no cells, never a crash
    const measures = Object.keys(v.measures);
    const cell = (x: unknown) => x as { status: string; value: number | null };
    const time = timeCells(v as unknown as TimeFile) ?? placesCells(v as unknown as PlacesFile);
    if (time) {
      // Increment 7b: one agency's rate file also gives its count ("<case>|count"), for a follow-up that asks for it.
      const total = v.grouping === "rate" ? (v as unknown as PlacesFile).agencies?.[0]?.total : undefined;
      for (const m of v.nibrsai_cases.matchAll(/(LS-\d{3})(?:\s+"([^"]+)"|\s+(alternative))?/g)) {
        out.set(m[3] ? `${m[1]}|alternative` : m[2] ? `${m[1]}|${m[2]}` : m[1], time);
        if (total && !m[2] && !m[3]) out.set(`${m[1]}|count`, [{ key: "", value: total.value, status: total.status }]);
      }
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
    const knownTotal = !!total && ["VALUE", "REPORTED_ZERO"].includes(total.status) && total.value !== null;
    const denOf = (p: string) => (!p && knownTotal ? total!.value! : periodTotal.get(p) ?? undefined);
    const definition = (m: string) => (measures.length > 1 ? { measure: `${m}: ${v.measures[m]}` } : {});
    const cells: ExpectedCell[] = v.grouping === "total" && !catField
      ? measures.map((m) => ({ key: "", ...pick(v.totals[m]), ...definition(m) }))
      : measures.length > 1 && !catField
      ? (v.rows ?? []).flatMap((r) => measures.map((m) => ({ key: String(r.year ?? r.month ?? ""), ...pick(cell(r[m])), ...definition(m) })))
      : (v.rows ?? []).map((r) => {
        const c = pick(cell(r[measures[0]]));
        // Increment 7: an offender record with sequence 00 is "seq_00" in the file (the segment convention, V59
        // regenerated); P86 (coordinator 2026-11-02) counts it in the one Unknown row, as the engine does in SQL.
        const code = catField ? (String(r[catField]) === "seq_00" ? "U" : CODE_ALIASES[catField]?.[String(r[catField])] ?? r[catField]) : null;
        const key = [r.year ?? r.month, catField ? categoryName(CATEGORY_FIELDS[catField], code) : null].filter((x) => x !== undefined && x !== null).map(String).join("|");
        const p = String(r.year ?? r.month ?? "");
        // A known 0 denominator (P51) is evidence: its share is an expected blank (UNAVAILABLE). Only absent or unknown
        // denominator evidence leaves the share unverified (Codex P51 review).
        const den = denOf(p);
        const share = c.value === null || den === 0 ? null : den === undefined ? undefined : Math.round((1000 * c.value) / den) / 10;
        return { key, ...c, ...(catField ? { share } : {}) };
      });
    // P86: rows that name the same category (Unknown) are one row: values add (blank when either is), share recomputed.
    if (catField) {
      const seen = new Map<string, ExpectedCell>();
      for (const c of cells.splice(0)) {
        const m = seen.get(c.key);
        if (!m) { seen.set(c.key, c); cells.push(c); continue; }
        if (m.unverifiable) continue;
        if (MULTI_FIELDS.has(catField) && m.value !== 0 && c.value !== 0) { m.unverifiable = true; m.share = undefined; continue; }
        m.value = m.value === null || c.value === null ? null : m.value + c.value;
        if (m.value === null) m.status = m.status === "VALUE" || m.status === "REPORTED_ZERO" ? c.status : m.status;
        else m.status = m.value === 0 && m.status === "REPORTED_ZERO" && c.status === "REPORTED_ZERO" ? "REPORTED_ZERO" : "VALUE";
        const den = denOf(c.key.includes("|") ? c.key.split("|")[0] : "");
        m.share = m.value === null || den === 0 ? null : den === undefined ? undefined : Math.round((1000 * m.value) / den) / 10;
      }
    }
    for (const m of v.nibrsai_cases.matchAll(/(LS-\d{3})(?:\s+"([^"]+)"|\s+(alternative))?/g)) {
      const k = m[3] ? `${m[1]}|alternative` : m[2] ? `${m[1]}|${m[2]}` : m[1];
      out.set(P28_VALUE_KEYS[k] ?? k, cells);
    }
  }
  for (const [c, cells] of allOf) out.set(c, cells);
  for (const [c, cells] of consistentOf) out.set(allOf.has(c) ? `${c}|button` : c, cells);
  for (const [c, keys] of Object.entries(SAME_VALUES)) { const cells = consistentOf.get(c) ?? allOf.get(c); if (cells) for (const k of keys) if (!out.has(k)) out.set(k, cells); }
  return out;
}
const pick = (c: { status: string; value: number | null }) => ({ value: c.value, status: c.status });
/**
 * Files of one case each (nibrs-model V185 on). A sum by one category (V185-V191): each year's categories, keyed as the
 * answer shows them ("<year>|<name>" when several years), each with its share of the year's total. A circumstance
 * breakdown (V192-V193): each circumstance with its share of the victims (a victim can have two, so the shares are over
 * the victims, not the rows); code 06 is held back in the file as in the answer. A circumstance filter (V194-V195): one
 * count. A file whose question is no longer its case's is left out (SUPERSEDED_VALUES), so its case stays unverified.
 */
type SingleCaseFile = { nibrsai_case?: string; unit?: string; grouping?: string; years?: number[]; view?: string; place?: string;
  by_year?: { year: number; by_category: Record<string, number>; total: number }[];
  victims?: number; by_circumstance?: Record<string, number>; filter?: string[]; count?: number };
const SUPERSEDED_VALUES: Record<string, string> = {
  // Request 13 asked for aggravated assault (13A) by location type; LS-455 was changed to burglary in #108's review.
  "V189": "LS-455",
};
/** A case's values that are also another answer's: LS-452's button is LS-457's question (the nation's Consistent Reporting Agencies). */
const SAME_VALUES: Record<string, string[]> = { "LS-457": ["LS-452|button"] };
const UNIT_ENTITY: Record<string, string> = { victims: "victim", offenders: "offender", arrests: "arrestee", offenses: "offense" };
const share1 = (n: number, total: number) => (total > 0 ? Math.round((1000 * n) / total) / 10 : null);
function singleCaseCells(v: SingleCaseFile, file: string): { lsCase: string; cells: ExpectedCell[]; consistent: boolean } | null {
  if (typeof v.nibrsai_case !== "string" || !/^LS-\d{3}$/.test(v.nibrsai_case)) return null;
  const name = /V\d+(?=\.json$)/.exec(file)?.[0];
  if (name && SUPERSEDED_VALUES[name] === v.nibrsai_case) return null;
  // The Consistent Reporting Agencies view: named in "view", or (circumstance files) in the place ("TN-consistent").
  const consistent = /consistent/i.test(v.view ?? "") || /-consistent$/i.test(v.place ?? "");
  if (v.by_circumstance && typeof v.victims === "number") {
    const dim = "victim_circumstance.circumstance";
    return { consistent, lsCase: v.nibrsai_case, cells: Object.entries(v.by_circumstance).map(([code, n]) =>
      ({ key: categoryName(dim, code), value: n, status: "VALUE", share: share1(n, v.victims!) })) };
  }
  if (v.filter && typeof v.count === "number") return { consistent, lsCase: v.nibrsai_case, cells: [{ key: "", value: v.count, status: "VALUE" }] };
  if (v.by_year?.length && v.grouping && v.unit && UNIT_ENTITY[v.unit]) {
    const dim = `${UNIT_ENTITY[v.unit]}.${v.grouping}`;
    const many = v.by_year.length > 1;
    // Age groups are named by their labels in the file and the answer alike; other codes by the answer's names.
    const label = (code: string) => (v.grouping === "age" ? code : categoryName(dim, code));
    return { consistent, lsCase: v.nibrsai_case, cells: v.by_year.flatMap((y) => Object.entries(y.by_category).map(([code, n]) =>
      ({ key: `${many ? `${y.year}|` : ""}${label(code)}`, value: n, status: "VALUE", share: share1(n, y.total) }))) };
  }
  return null;
}
/** Batch 9: units and their incidents (P66), per status or type, or for one selection. */
type UnitsIncidents = { units: number; incidents: number };
type ClearanceValues = { by_status?: Record<string, UnitsIncidents>; by_type?: Record<string, UnitsIncidents> } & Record<string, unknown>;
/** The part of a batch-9 file a case reads, where the file serves several (V116, V117). */
const CLEARANCE_PART: Record<string, string> = { "LS-358": "cleared", "LS-362": "cleared_by_arrest", "LS-369": "uncleared", "LS-370": "exceptional_excluding_ties" };
/** A batch-9 key as the answer names its category: "exceptional_B" is type B, "arrest" and "uncleared" their own. */
const CLEARANCE_CODE: Record<string, string> = { arrest: "arrest", uncleared: "none", cleared: "cleared" };
/**
 * Batch 9 (increment 6) as expected cells: a breakdown by clearance status or type, a cell per category named as the
 * answer names it, with its incidents; a selection, one total with its incidents; offenses with a property selection,
 * one total with its incidents; arrests, one total. Null for a case whose part the file does not give (the share
 * cleared until the slice answers it).
 */
/**
 * Batch 10 (increment 7): a case's category map ("victims_by_offender_race", "by_category", ...) as cells keyed by the
 * category's name as NIBRSAI shows it, or its one count ("victims", "count"). The file's own category names: "seq_00"
 * (offender 00) is "Unknown offender"; "no_relationship_reported"; " " is not recorded; age groups by their labels.
 */
const PEOPLE_MAPS: [RegExp, string][] = [[/_race$/, "victim.race"], [/_ethnicity$/, "victim.ethnicity"], [/_sex$/, "victim.sex"], [/_age$/, "victim.age"]];
function peopleCells(v: Record<string, unknown> | undefined): ExpectedCell[] | null {
  if (!v) return null;
  const key = Object.keys(v).find((k) => /^(?:victims|offenses|offenders)_by_|^by_category$/.test(k) && v[k] && typeof v[k] === "object");
  if (!key) return typeof v.victims === "number" && Object.keys(v).some((k) => /contrast|negative_control/.test(k)) ? [{ key: "", value: v.victims, status: "VALUE" }]
    : typeof v.count === "number" && "group_b_arrests_07" in v ? [{ key: "", value: v.count, status: "VALUE" }] : null;
  const map = v[key] as Record<string, number>;
  // Each category's share of the independent total, in percent to one decimal as the answer shows it: the file's own
  // total for a crime by its offenders (categories overlap), else the categories' sum (each unit in one category).
  const own = Object.keys(v).find((k) => /_total$/.test(k) && typeof v[k] === "number");
  const total = own ? (v[own] as number) : Object.values(map).reduce((a, b) => a + b, 0);
  const share = (n: number) => (total > 0 ? Math.round((1000 * n) / total) / 10 : null);
  const age = Object.keys(map).some((k) => /^\d{2}-\d{2}$|^under_18$/.test(k));
  const dim = age ? "victim.age" : PEOPLE_MAPS.find(([re]) => re.test(key))?.[1]
    ?? (Object.keys(map).some((k) => ["H", "N"].includes(k)) ? "victim.ethnicity" : Object.keys(map).some((k) => ["F", "M"].includes(k)) ? "victim.sex" : "victim.race");
  // P86: no offender identified, and a person's detail left blank, are the one Unknown row (merged below).
  const person = age || /(?:sex|race|ethnicity|age)$/.test(dim);
  const name = (k: string) => k === "seq_00" || (person && k === " ") ? "Unknown" : k === "no_relationship_reported" ? "No relationship reported" : k === " " ? "Not recorded"
    : age ? (k === "under_18" ? "Under 18" : k === "00" ? "Unknown" : k) : categoryName(dim, k);
  // Categories that overlap (the file's own total): a merged Unknown cannot be summed, so it has no expected cell.
  const cells = new Map<string, number>(), merged = new Set<string>();
  for (const [k, n] of Object.entries(map)) { const key = name(k); if (cells.has(key) && cells.get(key)! > 0 && n > 0) merged.add(key); cells.set(key, (cells.get(key) ?? 0) + n); }
  return [...cells].map(([key, n]) => (own && merged.has(key) ? { key, value: n, status: "VALUE", unverifiable: true as const } : { key, value: n, status: "VALUE", share: share(n) }));
}
function clearanceCells(lsCase: string, v: ClearanceValues): ExpectedCell[] | null {
  const ui = (x: UnitsIncidents, key: string, dim?: string): ExpectedCell =>
    ({ key: dim ? categoryName(dim, CLEARANCE_CODE[key] ?? key.replace(/^exceptional_/, "")) : "", value: x.units, status: "VALUE", incidents: x.incidents });
  // The share cleared (V116): the cleared count with its incidents, the total, and the share.
  if (lsCase === "LS-359" && typeof v.share_cleared_percent === "number" && v.cleared)
    return [{ key: "cleared", value: (v.cleared as UnitsIncidents).units, status: "VALUE", incidents: (v.cleared as UnitsIncidents).incidents },
      { key: "total", value: v.total_offenses as number, status: "VALUE" }, { key: "share", value: v.share_cleared_percent, status: "VALUE" }];
  const part = CLEARANCE_PART[lsCase];
  if (part) return v[part] ? [ui(v[part] as UnitsIncidents, part)] : null;
  if (v.by_status) return Object.entries(v.by_status).map(([k, x]) => ui(x, k, "offense.clearance_status"));
  if (v.by_type) return Object.entries(v.by_type).map(([k, x]) => ui(x, k, "offense.clearance_type"));
  if (typeof v.offenses === "number") return [{ key: "", value: v.offenses, status: "VALUE" }];
  if (typeof v.arrests === "number") return [{ key: "", value: v.arrests, status: "VALUE" }];
  return null;
}
type StatusValue = { status: string; value: number | null };
type PlacesAgency = { ori?: string; agency_name: string | null; population_year?: number; population?: number | null; total: StatusValue; rate: StatusValue };
/** Batch 8, the historical file: each value with its row (uid), year and column; a change carries its cells. */
type SrsFile = { basis?: string; values?: { uid: string; year: number; column: string; value: string | null }[]; change?: { earlier: number; later: number; change: number; percent_change: number | null } };
function srsCells(v: SrsFile): ExpectedCell[] | null {
  if (v.basis !== "crime_index_snapshot" || !v.values) return null;
  const vals = v.values.filter((x) => x.value !== null && x.value !== "");
  if (v.change) {
    const [e, l] = vals;
    return [{ key: "earlier", value: v.change.earlier, status: "VALUE", column: e.column, uid: e.uid }, { key: "later", value: v.change.later, status: "VALUE", column: l.column, uid: l.uid },
      { key: "change", value: v.change.change, status: "VALUE" }, { key: "pct_change", value: v.change.percent_change, status: v.change.percent_change === null ? "UNAVAILABLE" : "VALUE" }];
  }
  // The first value of a year is the answer's own column; later values of the same year are supporting evidence (a
  // rate's total, a sum's parts), not cells.
  const primary = vals.filter((x, i) => vals.findIndex((y) => y.year === x.year) === i);
  return primary.map((x) => ({ key: primary.length > 1 ? String(x.year) : "", value: Number(x.value), status: "VALUE", column: x.column, uid: x.uid }));
}
/** Current Trends group sums (nibrs-model V173-V176): each value's measures, with the agencies left out (blank_cells). */
type CurrentFile = { basis?: string; case?: string; values?: { group: string; size: string; year: number; month: number; agencies: number;
  measures: Record<string, { value: number | null; blank_cells: number }> }[] };
function currentCells(v: CurrentFile): Map<string, ExpectedCell[]> | null {
  if (v.basis !== "crime_index_snapshot_recomputed" || !v.values || !v.case) return null;
  const out = new Map<string, ExpectedCell[]>();
  for (const x of v.values) {
    const ym = `${x.year}-${String(x.month).padStart(2, "0")}`;
    for (const [col, m] of Object.entries(x.measures)) {
      // A month's total is keyed by its month (the answer's row); a year to date is one figure (key "").
      out.set(`${v.case}|${x.group}|${x.size}|${ym}|${col}`, [{ key: /_ytd$/.test(col) ? "" : ym, value: m.value, status: m.value === null ? "UNAVAILABLE" : "VALUE",
        column: col.replace(/_ytd$/, "_total"), population: null, blank: m.blank_cells, agencies: x.agencies } as ExpectedCell]);
    }
  }
  return out;
}
/**
 * The cells a case names in values.source ("nibrs-model V173 us all 2026-08 murder_total"), for files that don't list
 * their cases (Current Trends'): set under the case's id.
 */
export function bindValueSources(ev: ExpectedValues, cases: { id: string; expected?: unknown }[]): void {
  for (const c of cases) {
    const src = (c.expected as { values?: { source?: string } } | undefined)?.values?.source;
    const m = src ? /^nibrs-model (V\d+) (\w+) (\w+) (\d{4}-\d{2}) (\w+)$/.exec(src) : null;
    const cells = m ? ev.get(`${m[1]}|${m[2]}|${m[3]}|${m[4]}|${m[5]}`) : undefined;
    if (cells) ev.set(c.id, cells);
  }
}
/** Batch 8, NIBRS state and national sums (P61): read in stateSumCells, defined with the state-sum checks below. */
type StateSumYearFile = { year: number; agencies_counted: number; partial_reporters: number; all_months_sum: number; every_month_agencies_sum: number;
  rate_p62?: { rate: number }; every_month_rate?: { rate: number };
  coverage: { any_month: { agencies: number; share: number }; every_month: { agencies: number; share: number } } };
type StateSumFile = { basis?: string; by_year?: StateSumYearFile[];
  consistent_reporters?: { agencies: number; by_year: { year: number; sum: number; share_of_crime_index_population: number }[] } };
function stateSumCells(v: StateSumFile): ExpectedCell[] | null {
  // Raw files, or canonical where nibrs-model checked the raw counts on a sample (V111, the nation).
  if (!["raw", "canonical"].includes(v.basis ?? "") || !v.by_year?.length || v.by_year[0].all_months_sum === undefined) return null;
  const many = v.by_year.length > 1;
  const key = (y: number) => (many ? String(y) : "");
  const out: ExpectedCell[] = [];
  for (const y of v.by_year) {
    // The every-month set: one fixed set over a span of years (the file's consistent_reporters), else the year's own.
    const cr = v.consistent_reporters?.by_year.find((x) => x.year === y.year);
    out.push({ key: key(y.year), value: y.all_months_sum, status: "VALUE", view: "all" },
      { key: key(y.year), value: cr ? cr.sum : y.every_month_agencies_sum, status: "VALUE", view: "every" },
      { key: `agencies|${y.year}`, value: y.coverage.any_month.agencies, status: "VALUE", view: "meta" },
      { key: `partial|${y.year}`, value: y.partial_reporters, status: "VALUE", view: "meta" },
      { key: `share|${y.year}`, value: y.coverage.any_month.share, status: "VALUE", view: "meta" },
      { key: `every-agencies|${y.year}`, value: v.consistent_reporters ? v.consistent_reporters.agencies : y.coverage.every_month.agencies, status: "VALUE", view: "meta" },
      { key: `every-share|${y.year}`, value: cr ? cr.share_of_crime_index_population : y.coverage.every_month.share, status: "VALUE", view: "meta" });
    if (!many && y.rate_p62) out.push({ key: "", value: y.rate_p62.rate, status: "VALUE", view: "rate" });
    if (!many && y.every_month_rate) out.push({ key: "", value: y.every_month_rate.rate, status: "VALUE", view: "every-rate" });
  }
  return out;
}

type PlacesFile = { grouping: string; agencies?: PlacesAgency[]; years?: PlacesAgency[]; combined_total?: StatusValue; combined_rate?: StatusValue;
  left_out_months_unknown?: { ori?: string; agency_name: string | null; months_reported: string[] }[];
  ranked_by?: "count" | "rate"; result?: { ori?: string; agency_name: string | null; count: number; rate: number | null; position: number }[] };
/**
 * Batch 7 (increment 4): several agencies, combined totals, rates and rankings. Rows are keyed as the answer shows
 * them: an agency by its FBI name, a year, or "" for one value. A ranking's cells carry their position. Null for any
 * other file.
 */
const popOf = (a: PlacesAgency) => ("population" in a ? { population: a.population || null } : {});
function placesCells(v: PlacesFile): ExpectedCell[] | null {
  // No FBI name: the ORI, as the answer shows it (never the build's mailing city).
  const name = (a: { agency_name: string | null; ori?: string }) => a.agency_name ?? a.ori ?? "";
  switch (v.grouping) {
    case "per_agency": return v.agencies!.map((a) => ({ key: name(a), ...pick(a.total) }));
    // A rate's cells carry the population it divides by when the file gives it (P72's column is checked against it).
    case "per_agency_rate": return v.agencies!.map((a) => ({ key: name(a), ...pick(a.rate), ...popOf(a) }));
    case "rate": return [{ key: "", ...pick(v.agencies![0].rate), ...popOf(v.agencies![0]) }];
    case "rate_per_year": return v.years!.map((y) => ({ key: String(y.population_year), ...pick(y.rate), ...popOf(y) }));
    case "combined": return [{ key: "", ...pick(v.combined_total!) }];
    case "combined_rate": return [{ key: "", ...pick(v.combined_rate!) }];
    case "ranking": return [
      ...v.result!.map((r) => ({ key: name(r), value: v.ranked_by === "rate" ? r.rate : r.count, status: "VALUE", position: r.position })),
      ...(v.left_out_months_unknown ?? []).map((r) => ({ key: name(r), value: r.months_reported.length, status: "LEFT_OUT", leftOut: true }))];
    default: return null;
  }
}
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
  // P86: an age not recorded (" ") and an age recorded as unknown ("00") are one Unknown row.
  age_group: { under_18: "Under 18", "00": "Unknown", " ": "Unknown" },
  // P86 (coordinator 2026-11-02): no offender identified, and a sex, race or ethnicity left blank, are Unknown ('U').
  offender_sex: { "00": "U", " ": "U" }, offender_segment_sex: { "00": "U", " ": "U" },
  sex: { " ": "U" }, race: { " ": "U" }, ethnicity: { " ": "U" },
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
  // Increment 5: no state clearance rate (P18); years outside the historical file (D04, P14).
  [/no state clearance rate/i, "not_recorded_in_nibrs"], [/figures in the data cover \d{4} through \d{4}|outside them/i, "outside_release_coverage"],
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
/** A rate's column says per 100,000 (Jeff 2026-11-01: never "residents"). */
const rateHeader = (o: Extract<ShadowOutcome, { kind: "answer" }>) =>
  o.plan.statistics.some((x) => x.kind === "rate") && o.delivered.table.columns.some((c) => c.binding.kind === "statistic" && /per 100,000$/.test(c.header));

function comparisonProse(o: Extract<ShadowOutcome, { kind: "answer" }>): boolean {
  const cols = comparisonCells(o);
  const t = o.plan.transforms.find((x) => x.kind === "period_comparison");
  if (!cols || !t || t.kind !== "period_comparison") return false;
  const E = periodWords(t.earlier.from, t.earlier.to), L = periodWords(t.later.from, t.later.to);
  const f = (n: number) => n.toLocaleString("en-US");
  const signed = (n: number) => (n > 0 ? `+${f(n)}` : n < 0 ? `-${f(-n)}` : "0");
  const changeLine = cols.change === null ? null : `${f(cols.earlier!)} in ${E} and ${f(cols.later!)} in ${L}: a change of ${signed(cols.change)}${cols.pct_change !== null ? ` (${cols.pct_change > 0 ? "+" : ""}${cols.pct_change}%)` : ""}.`;
  const allowed = (line: string) => line === changeLine || line === "The percent change cannot be computed from a zero base." || /^Source: /.test(line) || /^Read "/.test(line) || /^Reported by .+\.$/.test(line)
    || (Object.values(ANSWER_STATEMENTS) as string[]).includes(line) || /^Compares the same months of each year: [A-Za-z ]+\.$/.test(line)
    || line.endsWith(`, ${E} against ${L}.`)
    || (cols.change === null && ((cols.earlier !== null && line === `${f(cols.earlier)} in ${E}.`) || (cols.later !== null && line === `${f(cols.later)} in ${L}.`)
      || new RegExp(`^No report is known for .+, so the (?:${E}|${L}) total is not established and no change is given\\.$`).test(line)));
  const text = o.delivered.text;
  return text.every(allowed) && (changeLine === null || text.includes(changeLine)) && (cols.pct_change !== null || cols.change === null || text.includes("The percent change cannot be computed from a zero base."));
}

/**
 * A fixed statement the answer carries (P86): in its answerStatements, and in its text too when it is one shown (SHOWN).
 * A statement no longer shown is still checked, so a note removed from the text never scores as missing.
 */
function carries(o: Extract<ShadowOutcome, { kind: "answer" }>, k: keyof typeof ANSWER_STATEMENTS): boolean {
  return o.delivered.answerStatements.includes(k) && (!SHOWN.has(k) || o.delivered.text.includes(ANSWER_STATEMENTS[k]));
}

/** Increment 7: a label statement about people, judged against the answer; null when the statement is not one of these. */
function peopleStatement(s: string, o: Extract<ShadowOutcome, { kind: "answer" }>): boolean | null {
  const text = o.delivered.text, plan = o.plan;
  const says = (k: keyof typeof ANSWER_STATEMENTS) => carries(o, k);
  const filters = [...plan.filters, ...plan.measures.flatMap((m) => m.filters ?? [])];
  const conds = (pred: (scope: string, entity: string, w: { dimension: string; op: string; values?: (string | number)[] }) => boolean) =>
    filters.some((f) => (f.kind === "attribute" ? pred("unit", "unit", f) : !f.negate && f.where.some((w) => w.kind === "attribute" && pred(f.scope, f.entity, w))));
  const under18 = (w: { op: string; values?: (string | number)[] }) => w.op === "between" && (w.values ?? []).map(String).join(",") === "1,17";
  const unit = plan.measures[0]?.unit;
  const grouped = (d: RegExp, multi?: boolean) => plan.groupings.some((g) => d.test(g.dimension) && (multi === undefined || !!g.multiValue === multi));
  if (/^says a (?:crime with offenders|victim linked to offenders) (?:in|of) more than one (?:category|race) counts once in each/.test(s)) return says("categories_overlap");
  if (/^uses the incident's offenders, not the pair-linked reading/.test(s)) return grouped(/^offender\./, true) && !says("pair_linked");
  if (/^uses only the offenders linked to each victim by the relationship segment, and says so/.test(s)) return grouped(/^victim_offender\.offender_/) && says("pair_linked");
  if (/^shows victims with no relationship reported as their own category/.test(s)) return says("pair_linked");
  const each = /^counts (victims|robbery offenses|offenses) \(D18\), each under the (?:races|age groups|ethnicities) of its incident's offenders/.exec(s);
  if (each) return unit === (each[1] === "victims" ? "victim" : "offense") && grouped(/^offender\./, true);
  if (/^reads "by juveniles" as offenders under 18/.test(s) || /^counts victims of incidents with at least one offender under 18, each once/.test(s))
    return conds((scope, entity, w) => scope === "incident" && entity === "offender" && w.dimension === "offender.age" && under18(w));
  if (/^says (?:offenders|victims|arrestees) of unknown age(?: or sex)? are not counted/.test(s)) return says("unknown_not_counted");
  // Element 31 (coordinator 2026-11-04): a filtered count says agencies often record the circumstance as unknown.
  if (/^says agencies often record the circumstance as unknown/.test(s)) return says("circumstance_unknown");
  if (/^reads "against juveniles" as victims under 18/.test(s) || /^counts victims under 18/.test(s)) return conds((sc, _e, w) => sc === "unit" && w.dimension === "victim.age" && under18(w));
  if (/^counts female victims whose aggravated assault involved a firearm/.test(s))
    return unit === "victim" && conds((sc, _e, w) => sc === "unit" && w.dimension === "victim.sex" && (w.values ?? []).join() === "F") && conds((sc, e) => sc === "victim" && e === "offense_weapon");
  const both = /^counts victims who are both (female|male) and under 18/.exec(s);
  if (both)
    return conds((sc, _e, w) => sc === "unit" && w.dimension === "victim.sex" && (w.values ?? []).join() === (both[1] === "female" ? "F" : "M")) && conds((sc, _e, w) => sc === "unit" && w.dimension === "victim.age" && under18(w));
  // Increment 7b (P69): the rewritten question travels with the answer, for the page to show above it.
  if (/^shows the rewritten question above the answer/.test(s)) { const rw = (o as { rewrite?: unknown }).rewrite; return typeof rw === "string" && rw.length > 0; }
  if (/^counts offenders, each once, who are linked as a stranger/.test(s))
    return unit === "offender" && conds((sc, e, w) => sc === "offender" && e === "victim_offender" && w.dimension === "victim_offender.relationship" && (w.values ?? []).join() === "ST");
  if (/^counts offenders, each offender segment once/.test(s)) return unit === "offender" && !grouped(/./, true);
  if (/^says it counts offender records \(segments\)/.test(s)) return says("offender_records");
  if (/^says standalone Group B arrests \(with no incident\) are included/.test(s)) return says("arrests_include_group_b");
  if (/^counts arrests with robbery as the arrest offense, by arrest date/.test(s)) return plan.measures[0]?.id === "arrests.robbery" && plan.timeBasis === "arrest_date";
  if (/^reads juvenile as an arrestee under 18/.test(s)) return conds((sc, _e, w) => sc === "unit" && w.dimension === "arrestee.age" && under18(w)) && says("unknown_not_counted");
  if (/^counts each victim once, under the victim's own race/.test(s)) return unit === "victim" && grouped(/^victim\.race$/, false);
  if (/^applies the offender's age through the victim-offender pairing the question names, and says so/.test(s))
    return conds((sc, e, w) => sc === "victim" && e === "victim_offender" && w.dimension === "victim_offender.offender_age" && under18(w)) && says("pair_condition") && !says("pair_linked");
  return null;
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
    // The agency by its FBI name, as the answer's "Reported by" line gives it (Jeff 2026-10-30).
    // The FBI's name may put the label's agency in other words ("Portland Police Bureau" is its "Portland Police
    // Department"): either is accepted for an agency the plan names.
    if (ag) ok = all.includes(ag[1]) || o.plan.geography.places.some((p) => p.kind === "agency" && (() => { const f = fbiNameFor(ag[1], p.ori); return !!f && all.includes(f); })());
    else if (s === "names its source at the end") ok = /^Source: /.test(text[text.length - 1]) && text.filter((t) => /^Source: /.test(t)).length === 1;
    // A state or national sum by category (coordinator 2026-11-04): the agencies it sums over, or the fixed set it counts.
    else if (s === "names how many agencies it sums over") ok = /Summed over the [\d,]+ agencies that reported\./.test(all) && !!o.stateSum;
    else if (s === "names the Consistent Reporting Agencies it counts") ok = /Counting only the [\d,]+ Consistent Reporting Agencies that reported every month/.test(all) && !!o.stateSum;
    else if (s === "lists the unknown category after the known ones in each period") {
      // P86 (coordinator 2026-11-02): within each period, the not-known categories after the known ones, Unknown once.
      const cols = o.delivered.table.columns;
      const it = cols.findIndex((c) => c.binding.kind === "grouping" && c.binding.dimension.startsWith("time."));
      const ic = cols.findIndex((c) => c.binding.kind === "grouping" && !c.binding.dimension.startsWith("time.") && !c.binding.dimension.startsWith("geo."));
      const per = new Map<string, string[]>();
      for (const r of o.delivered.table.rows) { const k = it >= 0 ? String(r[it]) : ""; per.set(k, [...(per.get(k) ?? []), String(r[ic])]); }
      ok = ic >= 0 && [...per.values()].every((ls) => { const f = ls.findIndex((v) => UNKNOWN_NAMES.has(v)); return ls.filter((v) => v === "Unknown").length <= 1 && (f < 0 || ls.slice(f).every((v) => UNKNOWN_NAMES.has(v))); });
    }
    else if (/^gives each quarter as the sum of its three months; a quarter in which the agency did not report/.test(s)) {
      // P71: quarters from months; exactly the blank quarters are named incomplete.
      const inc = text.find((t) => /^Incomplete: /.test(t)) ?? "";
      ok = o.plan.groupings.some((g) => g.dimension === "time.quarter")
        && o.delivered.table.rows.every((r) => { const [y, qn] = String(r[0]).split("-"); return (r[1] === null) === inc.includes(`${qn} ${y}`); });
    } else if (/^[A-Z].*\.$/.test(s) && !/^(names|says|states|labels)\b/.test(s)) ok = text.includes(s);   // a fixed sentence
    else if (s === "names any months with no data as missing, not zero") ok = !blank || /No report is known for|Not every month of|were recorded for|does not establish|shown blank, not zero: reporting for|Shown blank, not zero, because reporting/.test(all);
    else if (s === "names the months covered") ok = all.includes(periodWords(o.period.from, o.period.to));
    else if (/^says drug crimes include/.test(s)) ok = /drug equipment/i.test(all);
    else if (/^says a unit with several categories counts once in each/.test(s)) ok = carries(o, "categories_overlap");
    else if (/^says each arrest counts once/.test(s)) ok = carries(o, "arrests_counted_once");
    else if (/^says it counts the crimes of the period cleared as of the file date/.test(s)) ok = carries(o, "clearance_as_of_file");
    else if (/^says arrest takes precedence over exceptional clearance/.test(s)) ok = carries(o, "clearance_arrest_first");
    else if (/^gives the number of incidents beside the count/.test(s)) ok = o.plan.statistics.some((x) => x.kind === "incidents") && o.delivered.table.columns.some((c) => c.header === "Incidents");
    // Increment 6: the breakdowns by name (P66), each unit taking its incident's status, property on the incident (N2),
    // arrests by arrest date (P50), and an uncleared selection under P64's statement.
    else if (/^breaks down into cleared and uncleared/.test(s)) ok = clearanceRows(o, "offense.clearance_status", ["Cleared", "Uncleared"]);
    else if (/^breaks down into cleared by arrest, each exceptional clearance type by name, and uncleared/.test(s))
      ok = clearanceRows(o, "offense.clearance_type", ["Cleared by arrest", "Uncleared"]) && o.delivered.table.rows.every((r) => typeof r[0] !== "string" || !/^Code /.test(r[0]));
    else if (/^counts victims, each taking its incident's clearance status/.test(s)) ok = o.plan.measures[0].unit === "victim" && clearanceDims(o.plan).length > 0;
    else if (/^says property belongs to the incident, not to one offense/.test(s)) ok = carries(o, "property_not_attributed");
    else if (/^counts arrests by arrest date/.test(s)) ok = o.plan.timeBasis === "arrest_date";
    else if (/^says arrests with no incident \(standalone Group B arrests\) are not included/.test(s)) ok = carries(o, "arrests_through_incident");
    else if (/^gives the cleared count, the total and the share$/.test(s)) ok = o.plan.statistics.map((x) => x.kind).join(",") === "count,incidents,count,ratio" && o.delivered.table.columns.length === 4;
    else if (/^says it counts the period's .* still uncleared as of the file date/.test(s)) ok = carries(o, "clearance_as_of_file");
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
      // P86: the age groups are named by their rows, in age order, with one Unknown row (no age or an unknown age) last.
      const bins = o.plan.groupings.find((g) => g.bins)?.bins ?? [];
      // Within each period (a time column before it), checked apart (Codex notes-audit review 01.2).
      const cols = o.delivered.table.columns;
      const ia = cols.findIndex((c) => c.binding.kind === "grouping" && c.binding.dimension === o.plan.groupings.find((g) => g.bins)?.dimension);
      const it = cols.findIndex((c) => c.binding.kind === "grouping" && c.binding.dimension.startsWith("time."));
      const periods = new Map<string, string[]>();
      for (const r of o.delivered.table.rows) { const k = it >= 0 ? String(r[it]) : ""; periods.set(k, [...(periods.get(k) ?? []), String(r[ia])]); }
      ok = bins.length > 0 && ia >= 0 && [...periods.values()].every((labels) => {
        const order = labels.filter((l) => l !== "Unknown").map((l) => bins.findIndex((b) => b.label === l));
        return order.every((i, j) => i >= 0 && (j === 0 || i > order[j - 1])) && labels.filter((l) => l === "Unknown").length <= 1
          && (!labels.includes("Unknown") || labels[labels.length - 1] === "Unknown") && !labels.includes("Not recorded");
      });
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
    } else if (s === "defines each point as the sum of the 12 months ending that month") ok = o.plan.transforms.some((t) => t.kind === "rolling" && t.months === 12) && /12-month/.test(o.delivered.table.columns.map((c) => c.header).join(" "));
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
    // Increment 7: people (P29, P30, P44, P46, P49, P65). A statement about a fixed sentence checks the sentence; one
    // about what is counted checks the plan's unit, condition or grouping.
    else if ((ok = peopleStatement(s, o)) !== null) { /* judged by peopleStatement */ }
    // Increment 5: P63's source line, and P61's disclaimer and button on a state or national sum.
    else if (/^ends with the source line "(.+?)"/.test(s)) { const want = /^ends with the source line "(.+?)"/.exec(s)![1]; ok = text[text.length - 1] === want && text.filter((t) => /^Source: /.test(t)).length === 1; }
    else if (/^states how many agencies are counted, what share of residents they cover, and that agencies reporting only some months are included/.test(s)) {
      // Jeff (2026-11-01): the agencies and the population they cover are table columns. Each row's cells against what
      // the answer computed (never a substring search), and the sentence that partial reporters are included.
      const ys = o.stateSum?.years ?? [];
      ok = ys.length > 0 && coverageColumnsMatch(o, ys.map((y) => ({ agencies: y.agencies, share: y.share, lower: y.noPopulation > 0 })), "Agencies reporting")
        && text.includes("Includes all agencies.");
    } else if (/^offers a button to show only agencies that reported every month/.test(s)) {
      // Clicked: the same place, crime, filters and period, counting only the Consistent Reporting Agencies (P80; one
      // fixed set over years).
      const b = (o.buttons ?? []).find((x) => x.label === "Consistent Reporting Agencies")?.continuation;
      const same = (p: NibrsPlan) => JSON.stringify([p.geography, p.measures, p.filters, p.period, p.groupings, p.statistics]) === JSON.stringify([o.plan.geography, o.plan.measures, o.plan.filters, o.plan.period, o.plan.groupings, o.plan.statistics]);
      ok = !!b && b.kind === "answer" && b.plan.coverage.cohort === "same_agencies" && same(b.plan) && !!b.stateSum && b.delivered.table.rows.length === o.delivered.table.rows.length
        && (!/one fixed set/.test(s) || new RegExp(`only the ${b.stateSum.everyAgencies.toLocaleString("en-US")} Consistent Reporting Agencies that reported every month (?:from |in )`).test(b.delivered.text[0] ?? ""));
    } else if (/^states how many agencies reported every month and what share of residents they cover/.test(s))
      ok = o.plan.coverage.cohort === "same_agencies" && !!o.stateSum && coverageColumnsMatch(o, o.stateSum.years.map((y) => ({ agencies: o.stateSum!.years.length > 1 ? o.stateSum!.everyAgencies : y.every.agencies, share: y.every.share, lower: y.every.noPopulation > 0 })), "Consistent Reporting Agencies");
    else if (/^gives each year's agencies counted and share of residents covered/.test(s))
      ok = !!o.stateSum && o.stateSum.years.length > 1 && coverageColumnsMatch(o, o.stateSum.years.map((y) => ({ agencies: y.agencies, share: y.share, lower: y.noPopulation > 0 })), "Agencies reporting");
    // P03 (Jeff 2026-11-01): the participation note is the Consistent Reporting Agencies offer, not a sentence in the
    // notes: a sum over several years offers the fixed set (the lead's sentence names it; the button opens it).
    else if (/^notes that participation changed over the years|^offers the Consistent Reporting Agencies view for the participation change/.test(s))
      ok = (o.stateSum?.years.length ?? 0) > 1 && (o.buttons ?? []).some((b) => b.label === "Consistent Reporting Agencies" && b.continuation?.kind === "answer" && b.continuation.plan.coverage.cohort === "same_agencies");
    else if (/^gives the rate per 100,000 residents of the reporting agencies/.test(s))
      ok = rateHeader(o) && /^The rate uses the combined population of the agencies counted: [\d,]+ /m.test(text.join("\n"));
    // Increment 4: several agencies, combined totals, rates and rankings.
    else if (/^gives one total of both agencies/.test(s)) {
      // One known number of the plan's distinct agencies, said as combined.
      const oris = o.plan.geography.places.map((p) => (p.kind === "agency" ? p.ori : ""));
      ok = o.plan.geography.combine === "combined" && new Set(oris).size === 2 && oris.every(Boolean) && o.delivered.table.rows.length === 1
        && typeof o.delivered.table.rows[0][0] === "number"
        // The headline's number is the table's (Codex 02.5), never any number.
        && Number((/, combined: ([\d,.]+) /.exec(text[0] ?? "")?.[1] ?? "x").replace(/,/g, "")) === o.delivered.table.rows[0][0];
    } else if (/^gives no (?:combined total|rate), because not every month|^gives no combined total, because/.test(s)) {
      // Blank, with a reason, never a part-sum.
      ok = o.delivered.table.rows.length === 1 && o.delivered.table.rows[0].every((x) => typeof x === "string" || x === null)
        && o.delivered.evidence.every((x) => x.status !== "VALUE") && /no (?:total|rate) is given .*because not every month is known/.test(text[0] ?? "");
    } else if (s === "gives the rate per 100,000 residents and names the population and its year") {
      const y = o.period.to.slice(0, 4);
      ok = rateHeader(o) && text.some((t) => new RegExp(`the FBI's ${y} population of the agency: .+ [\\d,]+\\.$`).test(t));
    } else if (/^gives the population the rate divides by .+ in its own column beside the rate/.test(s)) {
      // P72: a Population column beside the rate, each cell the population the rate sentence names (the number itself
      // is checked against the independent file's denominator with the values, Codex 7b-04.6).
      const t = o.delivered.table, pi = t.columns.findIndex((c) => c.binding.kind === "statistic" && c.header === "Population");
      const popOf = o.plan.statistics.find((x) => x.kind === "population");
      const named = text.find((l) => /^Rates are per 100,000, using the FBI's \d{4} population of /.test(l)) ?? "";
      ok = rateHeader(o) && pi >= 0 && popOf?.kind === "population" && o.plan.statistics.some((x) => x.kind === "rate" && x.as === popOf.of)
        && t.rows.length > 0 && t.rows.every((r) => typeof r[pi] === "number" && new RegExp(` ${(r[pi] as number).toLocaleString("en-US")}(?:;|\\.$)`).test(named));
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
        && text.filter((t) => t.startsWith("Not ranked because they didn't report")).every((t) => /\((?:population [\d,]+, )?\d+ months?\)/.test(t))
        && !("alternative" in o && (o as { alternative?: unknown }).alternative);
    } else if (s === "orders ties alphabetically by agency name") {
      const rows = o.delivered.table.rows;
      ok = text.some((t) => /ties are ordered by agency name/.test(t)) && rows.every((r, i) => i === 0 || r[1] !== rows[i - 1][1] || String(rows[i - 1][0]).localeCompare(String(r[0])) <= 0);
    } else if (s === "adds no other eligibility filter") {
      const p = o.plan.geography.places[0];
      ok = p.kind === "agency_set" && p.where.every((w) => w.field === "agency.type") && o.plan.filters.length === 0;
    } else if (s === "says large means 250,000 residents or more") ok = /with a population of 250,000 or more/.test(text[0] ?? "");
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
/** Increment 6, the share cleared: its cleared count (and incidents), total and share against the expected cells. */
function shareDiffs(prefix: string, o: Extract<ShadowOutcome, { kind: "answer" }>, expected: ExpectedCell[]): { diffs: Diff[]; values: Values } {
  const [cCount, cInc, aCount, ratio] = o.plan.statistics.map((x) => x.as);
  const { columns, rows } = o.delivered.table;
  const at = (as: string) => rows[0]?.[columns.findIndex((c) => c.binding.kind === "statistic" && c.binding.as === as)] ?? null;
  const got: Record<string, unknown> = { cleared: at(cCount), total: at(aCount), share: at(ratio) };
  const diffs: Diff[] = [];
  if (rows.length !== 1) diffs.push({ field: `${prefix}rows`, expected: "one row", actual: `${rows.length} rows`, kind: "material" });
  for (const x of expected) {
    if (got[x.key] !== x.value) diffs.push({ field: `${prefix}value ${x.key}`, expected: String(x.value), actual: String(got[x.key]), kind: "material" });
    if (x.incidents !== undefined && at(cInc) !== x.incidents) diffs.push({ field: `${prefix}incidents ${x.key}`, expected: String(x.incidents), actual: String(at(cInc)), kind: "material" });
  }
  return { diffs, values: diffs.some((d) => d.kind === "material") ? "mismatch" : "match" };
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
export function valueDiffs(prefix: string, o: Extract<ShadowOutcome, { kind: "answer" }>, expected0: ExpectedCell[] | undefined): { diffs: Diff[]; values: Values } {
  // A ranking's left-out agencies (P60) are not rows: checked against the answer's "Not ranked" line below.
  const leftOut = (expected0 ?? []).filter((x) => x.leftOut);
  let expected = expected0?.filter((x) => !x.leftOut);
  if (!expected) return { values: "not measured", diffs: [{ field: `${prefix}values`, expected: "independent expected values", actual: "none given: NOT MEASURED", kind: "unverified" }] };
  if (expected.some((x) => x.view)) return stateSumDiffs(prefix, o, expected);
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
  if (o.plan.statistics.some((x) => x.kind === "ratio") && expected.some((x) => x.key === "share")) return shareDiffs(prefix, o, expected);
  if (o.plan.measures.length > 1 || expected.some((x) => x.measure)) {
    if (o.plan.measures.length > 1 && expected.every((x) => x.measure)) return severalDiffs(prefix, o, expected);
    return { values: "mismatch", diffs: [{ field: `${prefix}measures`, expected: `${new Set(expected.map((x) => x.measure)).size} measures`, actual: `${o.plan.measures.length} measures`, kind: "material" }] };
  }
  // Each row by its grouping values (period, category), its count by the first statistic's column, its incidents (P66)
  // and its share (if any) by theirs.
  const { columns, rows } = o.delivered.table;
  const groupCols = columns.map((c, i) => (c.binding.kind === "grouping" ? i : -1)).filter((i) => i >= 0);
  const statCol = (n: number) => columns.findIndex((c, i) => c.binding.kind === "statistic" && columns.slice(0, i).filter((x) => x.binding.kind === "statistic").length === n);
  const colOf = (kind: string) => { const st = o.plan.statistics.find((x) => x.kind === kind); return st ? columns.findIndex((c) => c.binding.kind === "statistic" && c.binding.as === st.as) : -1; };
  const [ci, si, ii, pi] = [statCol(0), colOf("share"), colOf("incidents"), colOf("population")];
  const countAs = (columns[ci].binding as { as: string }).as;
  const keys = rows.map((r) => groupCols.map((j) => String(r[j]).replace(RETURN_A, "")).join("|"));  // a Return A name matches the FBI text without its marker
  const got = new Map(rows.map((r, i) => [keys[i],
    { value: r[ci] as number | null, share: si >= 0 ? (r[si] as number | null) : undefined, incidents: ii >= 0 ? (r[ii] as number | null) : undefined,
      population: pi >= 0 ? (r[pi] as number | null) : undefined, status: o.delivered.evidence.find((e) => e.row === i && e.statistic === countAs)?.status ?? "?" }]));
  const diffs: Diff[] = [];
  // A key delivered twice could hide a wrong row behind a right one: never compared, always wrong.
  const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (twice.length) diffs.push({ field: `${prefix}rows`, expected: "each grouping once", actual: `repeated: ${[...new Set(twice)].join(", ")}`, kind: "material" });
  // A series starts at its first reported period (owner 2026-10-31): leading expected cells with no value (no report),
  // absent from the answer, are left out, never counted as missing rows; one with a value is still judged missing.
  const firstGot = [...got.keys()].sort()[0];
  const timeKeyed = columns[groupCols[0]]?.binding.kind === "grouping" && (columns[groupCols[0]].binding as { dimension: string }).dimension.startsWith("time.") && groupCols.length === 1;
  // Only where delivery trims: the answer's first row is reported (Codex month review 02.1).
  if (timeKeyed && firstGot !== undefined && got.get(firstGot)!.value !== null) expected = expected.filter((x) => !(x.value === null && !got.has(x.key) && x.key < firstGot));
  // A category with a known 0 is the same listed or left out (the engine lists every category of the period's
  // breakdown, nibrs-model's files only those that occur, and Unknown always): a 0 on one side, absent on the other, is
  // no difference. A category breakdown only; a blank or any other number is still judged.
  // The row's share must be 0 or absent too (Codex scorer check 01: a 0 count with a 99% share is wrong, never ignored).
  const zero = (v: number | null, st: string, share: number | null | undefined) => v === 0 && (st === "VALUE" || st === "REPORTED_ZERO") && (share === undefined || share === null || share === 0);
  if (groupCols.some((j) => columns[j].binding.kind === "grouping" && !(columns[j].binding as { dimension: string }).dimension.startsWith("time."))) {
    expected = expected.filter((x) => !(zero(x.value, x.status, x.share) && !got.has(x.key)));
    for (const [k, g] of [...got]) if (zero(g.value, g.status, g.share) && !expected.some((x) => x.key === k)) got.delete(k);
  }
  if (got.size !== expected.length) diffs.push({ field: `${prefix}values`, expected: `${expected.length} cells`, actual: `${got.size} cells`, kind: "material" });
  // A breakdown promises each category's share (increment 1): a table without it is incomplete.
  if (si < 0 && expected.some((x) => "share" in x)) diffs.push({ field: `${prefix}shares`, expected: "each category's share of its period", actual: "no share column", kind: "material" });
  for (const x of expected) {
    const g = got.get(x.key);
    if (x.unverifiable) {
      diffs.push(g ? { field: `${prefix}value ${x.key}`, expected: "(merged from overlapping categories: no independent value)", actual: `${g.value} ${g.status}`, kind: "unverified" }
        : { field: `${prefix}value ${x.key}`, expected: "a row", actual: "missing", kind: "material" });
      continue;
    }
    if (!g || g.value !== x.value || g.status !== x.status) diffs.push({ field: `${prefix}value ${x.key || "total"}`, expected: `${x.value} ${x.status}`, actual: g ? `${g.value} ${g.status}` : "missing", kind: "material" });
    // A ranking: each agency in its place (P17's tie order included).
    else if (x.position !== undefined && keys.indexOf(x.key) + 1 !== x.position)
      diffs.push({ field: `${prefix}position ${x.key}`, expected: String(x.position), actual: String(keys.indexOf(x.key) + 1), kind: "material" });
    else if (g.share !== undefined && x.share !== undefined && g.share !== x.share)   // null against a number included
      diffs.push({ field: `${prefix}share ${x.key}`, expected: String(x.share), actual: String(g.share), kind: "material" });
    else if (g.share !== undefined && x.share === undefined)
      diffs.push({ field: `${prefix}share ${x.key}`, expected: "(no independent share)", actual: String(g.share), kind: "unverified" });
    else if (g.incidents !== undefined && x.incidents !== undefined && g.incidents !== x.incidents)
      diffs.push({ field: `${prefix}incidents ${x.key}`, expected: String(x.incidents), actual: String(g.incidents), kind: "material" });
    else if (g.incidents !== undefined && x.incidents === undefined)
      diffs.push({ field: `${prefix}incidents ${x.key}`, expected: "(no independent incident count)", actual: String(g.incidents), kind: "unverified" });
    // P72: the population column against the file's denominator (Codex 7b-04.6).
    else if (g.population !== undefined && x.population !== undefined && g.population !== x.population)
      diffs.push({ field: `${prefix}population ${x.key || "total"}`, expected: String(x.population), actual: String(g.population), kind: "material" });
    else if (g.population !== undefined && x.population === undefined)
      diffs.push({ field: `${prefix}population ${x.key || "total"}`, expected: "(no independent population)", actual: String(g.population), kind: "unverified" });
  }
  // P60 (Codex 02.6): a ranking with agencies left out names them, five or fewer each with its months reported, more
  // than five as their count and five of them, each named agency with its own months; none left out, no such line.
  if (expected.some((x) => x.position !== undefined)) {
    const lines = o.delivered.text.filter((t) => t.startsWith("Not ranked because they didn't report"));
    // Each "<name> (<n> months)" after the line's last colon; more than five are named as "The five with the largest
    // populations: <name> (population <n>, <n> months), ..." (Codex 02 re-check C; coordinator 2026-11-07).
    const named = lines.flatMap((t) => [...t.slice(t.lastIndexOf(": ") + 2).matchAll(/(?:^|, )([^,]+?) \((?:population [\d,]+, )?(\d+) months?\)/g)].map((m) => ({ key: m[1].replace(RETURN_A, ""), months: Number(m[2]) })));
    const months = new Map(leftOut.map((x) => [x.key, x.value]));
    const bad = (why: string, actual: string) => diffs.push({ field: `${prefix}left out`, expected: why, actual, kind: "material" });
    if (!leftOut.length) { if (lines.length) bad("no agency left out", lines.join(" / ")); }
    else if (lines.length !== 1) bad(`one line naming the ${leftOut.length} agencies left out`, lines.join(" / ") || "none");
    else if (leftOut.length > 5 && !lines[0].includes(`: ${leftOut.length} agencies. The five with the largest populations: `)) bad(`${leftOut.length} agencies and the five with the largest populations`, lines[0]);
    else if (named.length !== Math.min(5, leftOut.length) || new Set(named.map((n) => n.key)).size !== named.length || named.some((n) => months.get(n.key) !== n.months))
      bad(`${Math.min(5, leftOut.length)} of them, each with its months reported`, lines[0]);
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

/** A clearance breakdown (P66): grouped by `dimension`, its column holding each of `names` (the categories it has). */
function clearanceRows(o: Extract<ShadowOutcome, { kind: "answer" }>, dimension: string, names: string[]): boolean {
  const col = o.delivered.table.columns.findIndex((c) => c.binding.kind === "grouping" && c.binding.dimension === dimension);
  const shown = new Set(o.delivered.table.rows.map((r) => String(r[col])));
  return col >= 0 && names.every((n) => shown.has(n));
}
/** The question and the answers already checked against a label, shared by one case's checks. */
type Walk = { question: string; checked: Set<object> };

/**
 * The fixed sentences an answer must carry where they apply (result.ts ANSWER_STATEMENTS), checked on its text:
 * property_counted_by_offense when the question asks for victims and the answer counts offenses (P11);
 * property_not_attributed for an incident-level property filter; reported_nibrs_counts for the nation;
 * categories_overlap for a multi-valued grouping; arrests_counted_once for arrests (P46); clearance_as_of_file for a
 * clearance grouping or selection (P64), and clearance_arrest_first where arrests and exceptional clearances are told apart (P67).
 */
function fixedStatementDiffs(question: string, c: Extract<ShadowOutcome, { kind: "answer" }>): Diff[] {
  const plan = c.plan;
  const want: AnswerStatement[] = [];
  if (/\bvictims?\b/i.test(question) && plan.measures.every((m) => m.unit === "offense")) want.push("property_counted_by_offense");
  if ([...plan.filters, ...plan.measures.flatMap((m) => m.filters ?? [])].some((f) => f.kind === "exists" && f.entity === "property")) want.push("property_not_attributed");
  if (plan.groupings.some((g) => g.multiValue)) want.push("categories_overlap");
  if (plan.measures.some((m) => m.unit === "arrest" || m.unit === "arrestee")) want.push("arrests_counted_once");
  // Increment 7: every arrest (Group B included) or arrests through an incident; the linked offenders; offender records;
  // a condition on a person.
  const people = peopleFacts(plan);
  if (people.throughIncident) want.push("arrests_through_incident");
  if (people.allArrests) want.push("arrests_include_group_b");
  if (people.pair) want.push("pair_linked");
  if (people.pairCondition) want.push("pair_condition");
  if (people.offenders) want.push("offender_records");
  if (people.personFilter) want.push("unknown_not_counted");
  const clr = clearanceDims(plan);
  if (clr.length) want.push("clearance_as_of_file");
  if (clr.some((d) => d !== "offense.clearance_status")) want.push("clearance_arrest_first");
  return want.filter((s) => !carries(c, s))
    .map((s) => ({ field: "statement", expected: ANSWER_STATEMENTS[s], actual: c.delivered.text.join(" / ").slice(0, 200), kind: "material" as const }));
}

/**
 * Every answer the outcome delivers, wherever it sits (the answer itself, any button however deep, any offered
 * alternative, expected by the label or not), visited once. One not already checked against the label is checked
 * without a meaning: its values where given, its contract and its text, and it stays unverified.
 */
function walkAnswers(prefix: string, key: string, o: ShadowOutcome, r: Release, ev: ExpectedValues | undefined, ctx: Walk): Check {
  if (o.kind === "answer") {
    // An answer's own buttons (P61's consistent-reporters view) are answers too: clicked and checked, values under
    // `<case>|button`.
    const own = ctx.checked.has(o) ? none() : deliveredCheck(prefix, key, o, null, r, ev, ctx);
    return (o.buttons ?? []).reduce((acc, x) => (x.continuation ? merge(acc, walkAnswers(`${prefix}button "${x.label}" `, `${key}|button`, x.continuation, r, ev, ctx)) : acc), own);
  }
  if (o.kind === "srs" || o.kind === "historical" || o.kind === "current" || o.kind === "route") return none();
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
  // P74: a complete question offered on the button, run only when chosen: nothing ran, so nothing is scored behind it.
  if (got.question) return one(d("", wantLeads, `offers the question "${got.question}", run only when chosen`, "unverified"));
  if (got.otherSource) return one(want && want.source === got.otherSource ? d("", `${want.source} answer`, `routed to ${got.otherSource}: not run by this NIBRS shadow`, "unverified") : d("source", want?.source ?? wantLeads, got.otherSource, "material"));
  const c = got.continuation!;
  if (c.kind === "decline" && c.notBuilt) return one(d("", wantLeads, "refused: this build does not hold the months (not built)", "unverified"));
  // Not available yet (a capability the shadow doesn't have): the plain prefix, or the plain sentence for an internal reason (P74).
  if (c.kind === "decline" && (/^This isn't available yet/.test(c.explanation) || c.explanation === NOT_YET)) return one(d("", wantLeads, c.explanation, "unverified"));
  // A historical-file answer or a route behind a button: not scored as a NIBRS answer here.
  if (c.kind === "srs" || c.kind === "historical" || c.kind === "current" || c.kind === "route") return one(d("", wantLeads, c.kind === "route" ? `routed to ${c.source}` : "a historical-file answer", "unverified"));
  if (wantLeads === "answer") {
    if (c.kind !== "answer") return one(d("", "answer", `${c.kind}: ${c.kind === "decline" ? c.explanation.slice(0, 160) : c.about}`, "material"));
    return deliveredCheck(prefix, key, c, want, r, ev, ctx);
  }
  return { ...none(), diffs: c.kind === wantLeads ? [] : [d("", wantLeads, c.kind, "material")] };
}

export type ShadowScore = { result: CaseResult | null; excluded?: string };

/**
 * Increment 7b (P69): a follow-up's rewrite against the label's. Two rewrites are the same question when their words
 * match (case and punctuation aside) or the reader finds the same parts in both ("Memphis TN" and "Memphis, Tennessee").
 * A rewrite where the label asks (null), or a different question, is material; a question where the label rewrites is
 * already judged by the action.
 */
const rwNorm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
// The reader's parts and the pre-pass flags that change the answer without a part (quarters, P72's columns): monthly
// and quarterly, or a rate with and without its population column, are different questions (Codex 7b-04.5).
const readingKey = (q: string) => {
  // The people flag too: whose race or age, and which persons' conditions (Codex model-rewriter amendment check 3).
  const l = readQuestion(q, 2026).ledger as ReturnType<typeof readQuestion>["ledger"] & { quarter?: boolean; column?: string | null; people?: unknown };
  return [...l.parts.filter((p) => p.clause === 0 && !["filler", "context"].includes(p.concept) && p.state !== "context")
    .map((p) => `${p.concept}=${String(p.value).toLowerCase().replace(/[^a-z0-9:=]+/g, " ").trim()}`).sort(), `quarter=${!!l.quarter}`, `column=${l.column ?? ""}`,
    `people=${JSON.stringify(l.people ?? null)}`].join("|");
};
/**
 * P71: a monthly series' expected cells summed into quarters ("2025-Q1"): a quarter is known only when all three of its
 * months are, else it is expected blank (incomplete).
 */
export function quarterCells(months: ExpectedCell[]): ExpectedCell[] {
  const by = new Map(months.filter((m) => /^\d{4}-\d{2}$/.test(m.key)).map((m) => [m.key, m]));
  const keys = [...new Set([...by.keys()].map((k) => `${k.slice(0, 4)}-Q${Math.floor((Number(k.slice(5, 7)) - 1) / 3) + 1}`))].sort();
  return keys.map((q) => {
    const first = (Number(q.slice(6)) - 1) * 3 + 1;
    const ms = [0, 1, 2].map((i) => by.get(`${q.slice(0, 4)}-${String(first + i).padStart(2, "0")}`));
    const known = ms.every((m) => m && ["VALUE", "REPORTED_ZERO"].includes(m.status) && m.value !== null);
    return known ? { key: q, value: ms.reduce((a, m) => a + (m!.value ?? 0), 0), status: ms.every((m) => m!.status === "REPORTED_ZERO") ? "REPORTED_ZERO" : "VALUE" }
      : { key: q, value: null, status: "UNKNOWN" };
  });
}
export function sameRewrite(a: string, b: string): boolean { return rwNorm(a) === rwNorm(b) || readingKey(a) === readingKey(b); }
export function withRewrite(res: CaseResult, c: Case, o: { rewrite: string | null }): CaseResult {
  if (c.rewrite === undefined) return res;
  const diff: Diff | null = c.rewrite === null
    ? (o.rewrite === null ? null : { field: "rewrite", expected: "(ask: the rewrite is uncertain)", actual: o.rewrite, kind: "material" })
    // An expected rewrite that was asked about instead is missing (Codex 7b-04.5).
    : o.rewrite === null ? { field: "rewrite", expected: c.rewrite, actual: "(none: asked)", kind: "material" }
    : sameRewrite(c.rewrite, o.rewrite) ? null : { field: "rewrite", expected: c.rewrite, actual: o.rewrite, kind: "material" };
  if (!diff) return res;
  const outcome: Outcome = res.outcome === "correct" || res.outcome === "unverified" ? (res.actual === "answer" ? "wrong_answer" : "wrong_action") : res.outcome;
  return { ...res, outcome, diffs: [...res.diffs, diff] };
}

export function scoreShadow(c: Case, o: ShadowOutcome, r: Release, ctx: { capability: string; era: string }, expectedValues?: ExpectedValues): ShadowScore {
  const e = c.expected!;
  if (o.kind === "srs" || o.kind === "historical" || o.kind === "current" || o.kind === "route") return { result: scoreOther(c, o, r, ctx, expectedValues) };
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
    // P61's button: the label's own question over the every-month set, checked as an answer (values "<case>|button").
    for (const b of o.buttons ?? []) if (b.continuation?.kind === "answer" && b.label === "Consistent Reporting Agencies") {
      walk.checked.add(b.continuation);
      const want: Meaning = { ...e.meaning, cohort: "same_agencies", filters: [...e.meaning.filters, "agencies that reported every month of the period"] };
      take(deliveredCheck(`button "${b.label}" `, `${c.id}|button`, b.continuation, want, r, expectedValues, walk));
    }
  }
  // A requested breakdown is never silently dropped (coordinator 2026-11-02): whatever was expected, an answer missing a
  // breakdown the question names is wrong.
  const dims = answerDimensions(o);
  const dropped = dims ? missingGroupings(c.question, dims) : [];
  if (dropped.length) diffs.push({ field: "breakdowns", expected: `by ${dropped.join(" and ")}`, actual: `answered without it (${dims!.join(", ") || "no breakdown"})`, kind: "material" });
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

/* ------------------------------------------------------------------ increment 5: the historical file and routes ---- */

/** A figure read from a Crime Index file: the states and nation file (P53) or the agencies build (Historical). */
type SrsOutcome = Extract<ShadowOutcome, { kind: "srs" | "historical" | "current" }>;
/** A historical-file answer as the comparator's view: its own meaning (it has no NIBRS plan). */
function srsView(o: SrsOutcome): PlanView {
  const m = o.meaning;
  const p = m.period as { from: string; to: string };
  return {
    meaning: { ...m, denominator: undefined }, measures: m.measures.map((x) => ({ ...x, role: "value" as const })), filterKeys: [], statistics: [m.statistic],
    years: null, yearsThrough: null, rank: null, denominator: null, untracked: [],
    comparison: m.statistic === "change" ? { earlier: { from: p.from, to: `${p.from.slice(0, 4)}-12` }, later: { from: `${p.to.slice(0, 4)}-01`, to: p.to } } : null,
  };
}
/** The required statements a historical-file answer can show: each checked on its text, table and what it read. */
function srsStatementDiffs(e: Extract<NonNullable<Case["expected"]>, { action: "answer" }>, o: SrsOutcome): Diff[] {
  const out: Diff[] = [];
  const text = o.delivered.text, all = text.join(" "), rows = o.delivered.table.rows;
  for (const s of e.statements) {
    let ok: boolean | null = null;
    const src = /^ends with the source line "(.+?)"/.exec(s);
    const st = /^names the state \((.+)\)$/.exec(s);
    const ag = /^names the agency \((.+)\)$/.exec(s);
    if (src) ok = text[text.length - 1] === src[1] && text.filter((t) => /^Source: /.test(t)).length === 1;
    else if (st) ok = (text[0] ?? "").startsWith(`${st[1]}:`);
    // Historical's agencies, named by their FBI names ("Figures for the Denver Police Department.").
    else if (ag) ok = all.includes(ag[1]);
    else if (s === "names its source at the end") ok = /^Source: /.test(text[text.length - 1]) && text.filter((t) => /^Source: /.test(t)).length === 1;
    else if (/^gives the rate per 100,000 residents/.test(s)) ok = /_capita$/.test(o.read.column) && all.includes("per 100,000");
    else if (/^gives (\w+) yearly totals from one source/.test(s)) ok = rows.length === ({ ten: 10 } as Record<string, number>)[/^gives (\w+)/.exec(s)![1]] && /_total$/.test(o.read.column);
    // Provenance (Codex label review): the file's own aggregate column, read as given, never its parts re-added.
    else if (/^gives the file's (violent|property) crime total, not a re-added sum/.test(s)) ok = o.read.column === `${/(violent|property)/.exec(s)![1]}_total` && (!("uids" in o.read) || o.read.uids.length === 1);
    else if (/^gives both counts, the change and the percent change, with no adjectives/.test(s)) {
      const [ev, lv, ch, pc] = rows[0] as (number | null)[];
      const f = (n: number) => n.toLocaleString("en-US");
      const line = `${f(ev!)} in ${o.period.from.slice(0, 4)} and ${f(lv!)} in ${o.period.to.slice(0, 4)}: a change of ${ch! > 0 ? "+" : ch! < 0 ? "-" : ""}${ch === 0 ? "0" : f(Math.abs(ch!))}${pc !== null ? ` (${pc > 0 ? "+" : ""}${pc}%)` : ""}.`;
      ok = [ev, lv, ch].every((x) => typeof x === "number") && text.includes(line) && !ADJECTIVES.test(all);
    } else if (/^names the comparison year \((\d{4})\)$/.test(s)) ok = new RegExp(`\\b${/\((\d{4})\)/.exec(s)![1]}\\b`).test(text[0] ?? "");
    else if (/^gives the national (\w+) clearance rate$/.test(s)) ok = /_cleared_rate$/.test(o.read.column) && /% of .+ were cleared in \d{4}\.$/.test(text[0] ?? "");
    else if (/^says the data covers (\d{4}) through (\d{4}), so (\d{4}) through (\d{4}) are outside it/.test(s)) {
      const [, a, b, c, d] = /^says the data covers (\d{4}) through (\d{4}), so (\d{4}) through (\d{4})/.exec(s)!;
      ok = text.some((t) => t.includes(`cover ${a} through ${b}`) && t.includes(`${c} through ${d} are outside`));
    } else if (/^uses one source for every year shown/.test(s)) ok = rows.every((r) => Number(r[0]) >= 1960) && /_total$/.test(o.read.column);
    // Current Trends (design note 2026-11-03): P90's sentence; the agencies left out, by count; an unknown month never zero.
    else if (s === "names the Consistent Reporting Agencies it counts and the people they cover") ok = /This counts only the [\d,]+ Consistent Reporting Agenc(?:y|ies), covering (?:roughly|at least) [\d.,]+(?: million)? people/.test(all);
    else if (/^names the agencies with no figure, left out of the total \((\d+) of (\d+)\)$/.test(s)) {
      const [, n, of] = /\((\d+) of (\d+)\)/.exec(s)!;
      ok = new RegExp(`left out of the total: .*\\(${n} of ${of}\\)`).test(all);
    } else if (/^says no figure is known for (.+) \(never zero\)$/.test(s)) ok = all.includes(`No figure is known for ${/for (.+) \(never/.exec(s)![1]}: shown blank, not zero.`) && rows.every((r) => r[r.length - 1] === null);
    if (ok === null) out.push({ field: "statement", expected: s, actual: "(no check defined)", kind: "unverified" });
    else if (!ok) out.push({ field: "statement", expected: s, actual: all.slice(0, 200), kind: "material" });
  }
  return out;
}
/** A historical-file answer's cells against the file's own values: the number, and the column and row it came from. */
function srsValueDiffs(o: SrsOutcome, expected: ExpectedCell[] | undefined): { diffs: Diff[]; values: Values } {
  if (!expected) return { values: "not measured", diffs: [{ field: "values", expected: "independent expected values", actual: "none given: NOT MEASURED", kind: "unverified" }] };
  const diffs: Diff[] = [];
  const rows = o.delivered.table.rows;
  const isChange = expected.some((x) => x.key === "pct_change");
  const got = (k: string): number | null | undefined => isChange ? (rows[0] as (number | null)[])[["earlier", "later", "change", "pct_change"].indexOf(k)]
    : k === "" ? (rows.length === 1 && rows[0].length === 1 ? (rows[0][0] as number) : undefined) : (rows.find((r) => r[0] === k)?.[1] as number | null | undefined);
  if (!isChange && rows.length !== expected.length) diffs.push({ field: "values", expected: `${expected.length} cells`, actual: `${rows.length} rows`, kind: "material" });
  // One figure: the sentence must give the table's number (Codex review 01.6), in any of the forms an answer writes it.
  const lone = rows.length === 1 && rows[0].length === 1 && typeof rows[0][0] === "number" ? (rows[0][0] as number) : null;
  if (lone !== null) {
    const forms = [String(lone), lone.toLocaleString("en-US"), lone.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })];
    // The whole number: nothing numeric continues it ("351" is not "351,000" or "351.9"; Codex confirmation 01).
    if (!forms.some((f) => new RegExp(`(^|[^0-9.,])${f.replace(/[.,]/g, "\\$&")}(?![0-9]|[.,][0-9])`).test(o.delivered.text[0] ?? "")))
      diffs.push({ field: "value in the sentence", expected: forms[1], actual: (o.delivered.text[0] ?? "").slice(0, 160), kind: "material" });
  }
  for (const x of expected) {
    const g = got(x.key);
    if (g !== x.value) diffs.push({ field: `value ${x.key || "total"}`, expected: String(x.value), actual: String(g), kind: "material" });
    if (x.column && x.column !== o.read.column) diffs.push({ field: `column ${x.key || "total"}`, expected: x.column, actual: o.read.column, kind: "material" });
    // The states and nation file names its rows (uid); the agencies build is checked by value and column.
    const uids = "uids" in o.read ? o.read.uids : [];
    if (x.uid && "uids" in o.read && !uids.includes(x.uid)) diffs.push({ field: `row ${x.key || "total"}`, expected: x.uid, actual: uids.join(", "), kind: "material" });
  }
  return { diffs, values: diffs.some((d) => d.kind === "material") ? "mismatch" : "match" };
}
/**
 * A historical-file answer or a route, scored as an answer. A route verifies the routing only (Codex label review): the
 * other source's values and statements are not run here, so a right route is unverified, never correct.
 */
function scoreOther(c: Case, o: SrsOutcome | Extract<ShadowOutcome, { kind: "route" }>, r: Release, ctx: { capability: string; era: string }, ev?: ExpectedValues): CaseResult {
  const e = c.expected!;
  const notes: string[] = [];
  let diffs: Diff[] = [];
  let values: Values | undefined;
  if (o.kind === "route") {
    notes.push(`routed to ${o.source}: ${o.explanation.slice(0, 200)}`);
    if (e.action === "answer") diffs = [e.meaning.source === o.source
      ? { field: "route", expected: `${e.meaning.source} answer`, actual: `routed to ${o.source}: not run by this NIBRS shadow`, kind: "unverified" }
      : { field: "source", expected: e.meaning.source, actual: o.source, kind: "material" }];
  } else {
    notes.push(`delivered: ${o.delivered.text.join(" / ").slice(0, 240)}`);
    if (e.action === "answer") {
      // The denominator is compared below, as words (the comparator's mapping is for NIBRS plans).
      diffs = [...compareMeaning({ ...e.meaning, denominator: undefined }, srsView(o), r), ...srsStatementDiffs(e, o)];
      if (e.meaning.denominator !== undefined && e.meaning.denominator !== o.meaning.denominator)
        diffs.push({ field: "denominator", expected: e.meaning.denominator, actual: o.meaning.denominator ?? "(none)", kind: "material" });
      const v = srsValueDiffs(o, ev?.get(c.id));
      diffs.push(...v.diffs); values = v.values;
    }
  }
  const material = diffs.filter((x) => x.kind === "material").length, unverified = diffs.filter((x) => x.kind === "unverified").length;
  let outcome: Outcome = outcomeOf(e.action, "answer", { material, unverified, structured: true, alternativeMissing: false });
  if (values === "mismatch") outcome = "wrong_answer";
  return { id: c.id, split: c.split, expected: e.action, actual: "answer", outcome, diffs, notes, capability: ctx.capability, era: ctx.era, ...(values ? { values } : {}) };
}

/* ------------------------------------------------------------------ increment 5: NIBRS state and national sums ----- */

/**
 * A state or national sum (P61) against nibrs-model's file: the view the answer shows (every reported month, or the
 * every-month set its button gives; or either's rate, P62), each row, and the disclaimer's figures the answer carries
 * (agencies counted, partial reporters, coverage, the every-month set) per year.
 */
/**
 * A state or national sum's coverage columns (Jeff 2026-11-01): each row's agencies (under `agenciesHeader`) and
 * population covered ("84.1%", or "≥84.1%" for a lower bound) equal what the answer computed. P87: the columns are
 * shown only when the question asks for the agencies reporting; otherwise neither column is shown and the figures are
 * carried in stateSum, one per row.
 */
function coverageColumnsMatch(o: Extract<ShadowOutcome, { kind: "answer" }>, want: { agencies: number; share: number; lower: boolean }[], agenciesHeader: string): boolean {
  const cols = o.delivered.table.columns.map((c) => c.header);
  const ia = cols.indexOf(agenciesHeader), ic = cols.indexOf("Population covered");
  const rows = o.delivered.table.rows;
  if (!o.plan.statistics.some((s) => s.kind === "agencies"))
    return ia < 0 && ic < 0 && !cols.includes("Agencies reporting") && !cols.includes("Consistent Reporting Agencies") && rows.length === want.length;
  return ia >= 0 && ic >= 0 && rows.length === want.length
    && want.every((w, i) => rows[i][ia] === w.agencies && rows[i][ic] === coveredText(w.share, w.lower));
}
function stateSumDiffs(prefix: string, o: Extract<ShadowOutcome, { kind: "answer" }>, expected: ExpectedCell[]): { diffs: Diff[]; values: Values } {
  const every = o.plan.coverage.cohort === "same_agencies";
  const isRate = o.plan.statistics[0].kind === "rate";
  const view = isRate ? (every ? "every-rate" : "rate") : every ? "every" : "all";
  const want = expected.filter((x) => x.view === view);
  const diffs: Diff[] = [];
  const rows = o.delivered.table.rows;
  const keyOf = (r: (string | number | null)[]) => (o.delivered.table.columns[0]?.binding.kind === "grouping" ? String(r[0]) : "");
  if (!want.length) diffs.push({ field: `${prefix}values`, expected: `a ${view} figure`, actual: "none in the independent file", kind: "unverified" });
  if (want.length && rows.length !== want.length) diffs.push({ field: `${prefix}values`, expected: `${want.length} cells`, actual: `${rows.length} rows`, kind: "material" });
  for (const x of want) {
    const r = rows.find((row) => keyOf(row) === x.key);
    // The value column (the plan's first statistic): the agencies and coverage columns follow it.
    const iv = o.delivered.table.columns.findIndex((c) => c.binding.kind === "statistic" && c.binding.as === o.plan.statistics[0].as);
    const g = r ? r[iv] : undefined;
    if (g !== x.value) diffs.push({ field: `${prefix}value ${x.key || "total"} (${view})`, expected: String(x.value), actual: String(g), kind: "material" });
  }
  const meta = o.stateSum;
  if (!meta) diffs.push({ field: `${prefix}coverage`, expected: "the disclaimer's figures", actual: "none carried", kind: "material" });
  // The columns shown, whatever the label asks (Codex coverage review 01.2): each row's agencies and population covered
  // are the answer's own figures, in either view.
  else if (!coverageColumnsMatch(o, meta.years.map((y) => every
    ? { agencies: meta.years.length > 1 ? meta.everyAgencies : y.every.agencies, share: y.every.share, lower: y.every.noPopulation > 0 }
    : { agencies: y.agencies, share: y.share, lower: y.noPopulation > 0 }), every ? "Consistent Reporting Agencies" : "Agencies reporting"))
    diffs.push({ field: `${prefix}coverage columns`, expected: "the answer's agencies and population covered", actual: JSON.stringify(o.delivered.table.rows).slice(0, 160), kind: "material" });
  else for (const x of expected.filter((c) => c.view === "meta")) {
    const [what, y] = x.key.split("|");
    const yr = meta.years.find((m) => m.year === Number(y));
    const got = !yr ? undefined : what === "agencies" ? yr.agencies : what === "partial" ? yr.partial : what === "share" ? yr.share : what === "every-agencies" ? yr.every.agencies : yr.every.share;
    if (got !== x.value) diffs.push({ field: `${prefix}${what} ${y}`, expected: String(x.value), actual: String(got), kind: "material" });
  }
  return { diffs, values: diffs.some((d) => d.kind === "material") ? "mismatch" : diffs.length ? "not measured" : "match" };
}
