import type Database from "better-sqlite3";
import { resolveGeoPlaces } from "./geo-place-resolver";
import { resolveCountyAgencyScorecardTarget } from "./historical-scorecard";
import { consolidatedDisplayName, historicalAgencyTarget } from "./agency-consolidations";
import { RELIABILITY_OFFENSES } from "./agency-reliability";

/**
 * The ordinary-answer counterpart of the scorecard's reliability guard: when a
 * Historical answer touches an agency-year flagged in agency_year_reliability, append
 * one vague caveat -- "may be incomplete", no figures, no accusation -- so "murders in
 * Louisville in 2025" no longer returns 19 as unqualified fact.
 *
 * FAIL OPEN is the design rule. Ordinary answers are arbitrary LLM-generated SQL, so
 * "which agency-years did this answer touch" cannot be recovered reliably in general.
 * This matcher only speaks when every part is unambiguous: exactly one resolved city
 * agency or lead county agency, identifiable years, offense-level intersection with
 * the flagged columns. In
 * any other situation it stays silent -- a missed caveat is a smaller error than a
 * caveat attached to the wrong data, and the scorecard path already covers the
 * highest-traffic case independently.
 *
 * Offense-level matching (Codex review, point 4): a Louisville murder collapse must
 * never caveat a theft answer. partial-year and systemic findings taint every crime
 * measure for that year; column-collapse taints only its flagged columns, and the
 * stored violent/property totals do NOT inherit a component's warning.
 */

/**
 * Disclosure gate by finding kind, from the historical-distribution review
 * (2026-08-06): partial-year and systemic signatures are unambiguous in every era --
 * New Orleans 2005 is Katrina, Honolulu 2013-14 and Jacksonville 2018 are genuine
 * partial submissions. Single-column collapses are NOT safe to disclose historically:
 * 5,228 of them are aggravated assault, where decades of reclassification practice
 * can produce the same arithmetic signature as a bad figure. So column-collapse is
 * disclosed only in the recent window that was human-verified (the newest two data
 * years), or when the independent RTCI cross-check corroborates it.
 */
export const COLLAPSE_DISCLOSURE_RECENT_YEARS = 1; // year >= datasetMax - 1

type FlagRow = { year: number; kind: string; source: string; columns_json: string };

const OFFENSE_LABEL = new Map(RELIABILITY_OFFENSES.map((o) => [o.column, o.label]));

/** Map a result column name to an offense key, a total, or nothing. */
export function classifyResultColumn(name: string): string | null {
  const base = name.toLowerCase()
    .replace(/_?(rate|count|total|per_?100k|per_?capita)$/g, "")
    .replace(/s$/, "");
  if (/motor_?vehicle|auto_?theft|^mvt$/.test(base)) return "motor_vehicle_theft";
  if (/aggravated|^assault$/.test(base)) return "assault";
  if (/^murder$/.test(base)) return "murder";
  if (/^rape$/.test(base)) return "rape";
  if (/^robber(y|ie)$/.test(base)) return "robbery";
  if (/^burglar(y|ie)$/.test(base)) return "burglary";
  if (/^(theft|larceny|larcenie)$/.test(base)) return "theft";
  // Totals count as crime measures (partial-year taints them) but never match a
  // column-collapse: the stored FBI totals do not inherit a component's warning.
  if (/^violent|^property|total_offense/.test(base)) return "total";
  return null;
}

function formatYearList(years: number[]): string | null {
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return String(sorted[0]);
  if (sorted.length === 2) return `${sorted[0]} and ${sorted[1]}`;
  if (sorted.length === 3) return `${sorted[0]}, ${sorted[1]} and ${sorted[2]}`;
  return `several years in this range, including ${sorted[sorted.length - 1]}`;
}

export function reliabilityDisclosureNote(
  db: Database.Database,
  question: string,
  sql: string | null | undefined,
  rows: Record<string, unknown>[],
  tab: string | undefined
): string | null {
  if (tab !== "historical" || rows.length === 0) return null;

  // Exactly one unambiguous agency, or silence. County questions resolve through the
  // same lead-county-agency resolver the county scorecard uses -- a county card is a
  // single FBI county agency, never a countywide crosswalk sum -- so a flagged county
  // year gets the same caveat a flagged city year does. Anything ambiguous fails open.
  let target: { agency: string; type: "city" | "county"; ori?: string };
  let state: string;
  let label: string;
  try {
    const county = resolveCountyAgencyScorecardTarget(db, question);
    if (county.kind === "ambiguous") return null;
    if (county.kind === "resolved") {
      // A county-name question is only the LEAD COUNTY AGENCY's data when the SQL says
      // so. Countywide answers -- crosswalk sums over every agency in the county, or
      // explicit all-agencies phrasing -- must never inherit the sheriff's reliability
      // flag: the sheriff's bad year is a small slice of that total. Require positive
      // evidence of a single county-agency query (a type = 'county' filter or an
      // explicit ORI equality) and fail open otherwise.
      if (!sql || /agency_county_crosswalk/i.test(sql)) return null;
      if (/\bcounty-?wide\b|\ball (?:law enforcement )?agencies\b|\bevery agency\b|\bagencies (?:in|across|within)\b/i.test(question)) return null;
      if (!/type\s*=\s*'county'/i.test(sql) && !/\bori\s*=\s*'/i.test(sql)) return null;
      // CARRY THE ORI. The resolver has already identified the exact agency; dropping its `ori`
      // here sent the flag lookup below down its name-matching branch, which matched nothing once
      // the Historical rebuild stopped appending " County" to county agency names. Measured on the
      // served database 2026-08-27: 'Marshall County' + al + county returned 0 flag rows while
      // AL0500000 returned 13, and 1,815 of 1,815 flagged county agencies were missed. Every
      // flagged county silently lost its caveat -- the behaviour this function's own comment
      // promises: "a flagged county year gets the same caveat a flagged city year does".
      target = { agency: county.target.agency, type: "county", ori: county.target.ori };
      state = county.target.state.toLowerCase();
      label = `${county.target.agency}, ${county.target.state.toUpperCase()}`;
    } else {
      const resolution = resolveGeoPlaces(question);
      if (resolution.mentions.some((mention) => mention.requiresClarification)) return null;
      const candidates = resolution.mentions.flatMap((m) => m.candidates).filter((c) => c.kind === "city" && c.state);
      if (candidates.length !== 1) return null;
      const candidate = candidates[0];
      state = candidate.state!.toLowerCase();
      target = historicalAgencyTarget(candidate.state, candidate.name);
      label = `${consolidatedDisplayName(candidate.state, candidate.name)}, ${candidate.state!.toUpperCase()}`;
    }
  } catch {
    return null;
  }

  // Which years does the ANSWER cover? Precedence: returned year columns, then years
  // named in the question, then year-comparison literals in the SQL. The question
  // outranks the SQL deliberately -- replay found a question asking about 2024 whose
  // generated SQL carried a stray 1990 literal, and a bare grab of every 4-digit
  // number in the SQL attached a caveat about 1990 to an answer about 2024. What the
  // user asked for and what the rows show define the answer; SQL internals do not.
  const years = new Set<number>();
  const yearColumns = Object.keys(rows[0] ?? {}).filter((key) => /(^|_)year$|^yr$/i.test(key));
  for (const row of rows) {
    for (const key of yearColumns) {
      const value = Number(row[key]);
      if (Number.isInteger(value) && value >= 1900 && value <= 2100) years.add(value);
    }
  }
  if (years.size === 0) {
    for (const match of question.match(/\b(19[0-9]{2}|20[0-9]{2})\b/g) ?? []) years.add(Number(match));
  }
  if (years.size === 0 && sql) {
    // Only literals in a year-comparison context ("year = 2025", "year BETWEEN a AND b",
    // "year IN (...)"), never any 4-digit number anywhere in the SQL.
    for (const clause of sql.match(/\byear\b\s*(?:=|==|>=|<=|>|<|BETWEEN|IN)\s*\(?\s*(?:19|20)[0-9]{2}(?:\s*(?:AND|,)\s*(?:19|20)[0-9]{2})*/gi) ?? []) {
      for (const literal of clause.match(/\b(?:19|20)[0-9]{2}\b/g) ?? []) years.add(Number(literal));
    }
  }
  if (years.size === 0) return null;

  // Which offense measures does the answer actually show?
  const offenseKeys = new Set<string>();
  let hasAnyCrimeMeasure = false;
  for (const key of Object.keys(rows[0] ?? {})) {
    const classified = classifyResultColumn(key);
    if (!classified) continue;
    hasAnyCrimeMeasure = true;
    if (classified !== "total") offenseKeys.add(classified);
  }
  if (!hasAnyCrimeMeasure) return null;

  let flags: FlagRow[];
  let datasetMax: number;
  try {
    const whereTarget = target.ori
      ? "ha.ori = ?"
      : "ha.agency = ? AND ha.state = ? AND ha.type = ?";
    const params = target.ori ? [target.ori] : [target.agency, state, target.type];
    flags = db.prepare(`
      SELECT r.year AS year, r.kind AS kind, r.source AS source, r.columns_json AS columns_json
      FROM agency_year_reliability r
      JOIN historical_agency ha ON ha.ori = r.ori
      WHERE ${whereTarget}
    `).all(...params) as FlagRow[];
    datasetMax = (db.prepare("SELECT MAX(year) AS y FROM historical_agency_crime").get() as { y: number }).y;
  } catch {
    // Table absent (not yet built on this copy of the database): fail open.
    return null;
  }

  const broadYears: number[] = [];
  const collapseYears = new Map<string, number[]>();
  for (const flag of flags) {
    if (!years.has(flag.year)) continue;
    if (flag.kind === "partial-year" || flag.kind === "systemic") {
      broadYears.push(flag.year);
      continue;
    }
    // column-collapse: gated by era, then intersected with the displayed offences.
    const recent = flag.year >= datasetMax - COLLAPSE_DISCLOSURE_RECENT_YEARS;
    if (!recent && flag.source !== "rtci-crosscheck") continue;
    let flaggedColumns: string[];
    try { flaggedColumns = JSON.parse(flag.columns_json) as string[]; } catch { continue; }
    for (const column of flaggedColumns) {
      if (!offenseKeys.has(column)) continue;
      if (!collapseYears.has(column)) collapseYears.set(column, []);
      collapseYears.get(column)!.push(flag.year);
    }
  }

  // One sentence, vague by policy: naming an agency's own submission as wrong is not a
  // claim to make in passing, and the figures invite a debate the answer cannot settle.
  const broad = formatYearList(broadYears);
  if (broad) return `Note: ${label}'s reported data may be incomplete for ${broad}.`;
  if (collapseYears.size > 0) {
    const labels = [...collapseYears.keys()].map((c) => OFFENSE_LABEL.get(c) ?? c).sort();
    const offenseList = labels.length <= 2
      ? labels.join(" and ")
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
    const allYears = formatYearList([...collapseYears.values()].flat());
    return `Note: ${label}'s reported ${offenseList} data may be incomplete for ${allYears}.`;
  }
  return null;
}
