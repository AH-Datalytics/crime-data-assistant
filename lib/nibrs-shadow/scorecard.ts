/**
 * The crime scorecard (P215, Jeff 2026-11-22: the new engine reproduces the live scorecard): nine rows (Violent Crime, Murder, Rape, Robbery, Aggravated Assault,
 * Property Crime, Burglary, Theft, Motor Vehicle Theft), columns Type | Offenses | Change from <prior year> | Rate per 100k | Clearance Rate, for one agency, one
 * state or the nation. The live card (lib/agency-scorecard.ts, lib/historical-scorecard.ts) read the old SQLite file; this reads the Crime Index build the new
 * engine reads (agency_crime, agency_clearances, state_crime, nation_crime, current_final: the RTCI months for the reliability cross-check), with the same
 * rules:
 *   - the newest year with complete crime, population and clearance data for every row (an agency); a state's or the nation's newest complete year;
 *   - a card is a statement about NOW: a newest complete year more than STALE_SCORECARD_YEARS behind the file's newest year is refused;
 *   - an agency year the reliability checks reject (lib/agency-reliability.ts, the same decision functions: own history, and the RTCI months) falls back to the
 *     latest reliable year, said ("<year> data may be incomplete, so this is the most recent year of known complete data.");
 *   - the change is against the prior year's count, blank when that is missing or zero (never 0.0%); clearance rates are never clamped, and a rate over 100%
 *     says why; state and national cards have no clearance column (the FBI publishes no state-level clearance series).
 * A county card is not built here (it needs the county-to-agencies crosswalk): the caller declines it.
 */
import type { ResultTable } from "../nibrs-plan/result";
import { RELIABILITY_OFFENSES, HISTORY_LOOKBACK_YEARS, MURDER_RATIO_LOOKBACK_YEARS, RTCI_CROSSCHECK_MIN_COUNT, evaluateOwnHistory, evaluateRtciCrosscheck, describeFindings } from "../agency-reliability";
import type { HistoricalBuild } from "./historical";

/** How far behind the newest year in the data a card's year may be before the card is refused (the live card's STALE_SCORECARD_YEARS). */
export const SCORECARD_STALE_YEARS = 3;

/** The nine rows: the parquet stem (`<stem>_total`, `<stem>_capita`, `<stem>_cleared_rate`), the old key the reliability functions use, the label and whether it is a section. */
const ROWS = [
  { stem: "violent", key: "violent", label: "Violent Crime", section: true },
  { stem: "murder", key: "murder", label: "Murder" },
  { stem: "rape", key: "rape", label: "Rape" },
  { stem: "robbery", key: "robbery", label: "Robbery" },
  { stem: "assault", key: "assault", label: "Aggravated Assault" },
  { stem: "property", key: "property", label: "Property Crime", section: true },
  { stem: "burglary", key: "burglary", label: "Burglary" },
  { stem: "theft", key: "theft", label: "Theft" },
  { stem: "motor", key: "motor_vehicle_theft", label: "Motor Vehicle Theft" },
] as const;
const PARTS = ROWS.filter((r) => !("section" in r));
const VIOLENT_PARTS = ["murder", "rape", "robbery", "assault"], PROPERTY_PARTS = ["burglary", "theft", "motor"];

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
import { roundHalfAway1 } from "../round-half-away";
const round1 = (x: number) => Math.round(x * 10) / 10;
const num = (v: unknown): number | null => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const pq = (root: string, file: string) => `read_parquet(${q(`${root}/${file}.parquet`)})`;

export type ScorecardPlace = { kind: "agency"; ori: string; label: string } | { kind: "state"; code: string; name: string } | { kind: "national" };
export type ScorecardResult =
  | { kind: "card"; year: number; title: string; text: string[]; table: ResultTable; scope: "agency" | "state" | "national"; fallback: number | null; sql: string }
  | { kind: "none"; explanation: string };

type Execute = (sql: string) => unknown[][];

/** A change that is unknown (blank), never 0.0%: no prior count, or a prior of zero. */
const changePct = (current: number | null, previous: number | null): number | null =>
  current === null || previous === null || previous <= 0 ? null : roundHalfAway1(((current - previous) * 100) / previous);

function table(year: number, rows: { label: string; offenses: number | null; change: number | null; rate: number | null; clearance: number | null }[], clearance: boolean): ResultTable {
  const stat = (as: string, header: string) => ({ binding: { kind: "statistic" as const, as }, header });
  const columns = [{ binding: { kind: "grouping" as const, dimension: "scorecard.type" }, header: "Type" }, stat("offenses", "Offenses"), stat("change", `Change from ${year - 1}`),
    stat("rate", "Rate per 100k"), ...(clearance ? [stat("clearance", "Clearance Rate")] : [])];
  return { columns, rows: rows.map((r) => [r.label, r.offenses, r.change, r.rate, ...(clearance ? [r.clearance] : [])]) } as unknown as ResultTable;
}

/** One agency's card, or why there is none. `label` is the place as the answer names it ("Tulsa, OK"). */
function agencyCard(build: HistoricalBuild, execute: Execute, ori: string, label: string): ScorecardResult {
  const cols = (prefix: string, suffix: string) => ROWS.map((r) => `${prefix}.${r.stem}_${suffix}`);
  const complete = execute(`SELECT c.year FROM ${pq(build.root, "agency_crime")} c JOIN ${pq(build.root, "agency_clearances")} k ON k.ori = c.ori AND k.year = c.year
    WHERE c.ori = ${q(ori)} AND c.population > 0 AND ${cols("c", "total").map((c) => `${c} IS NOT NULL`).join(" AND ")} AND ${cols("k", "cleared_rate").map((c) => `${c} IS NOT NULL`).join(" AND ")}
    ORDER BY c.year DESC`).map((r) => Number(r[0]));
  const newest = complete[0] ?? null;
  if (newest === null) return { kind: "none", explanation: `${label} does not have one recent year with complete crime, population, and clearance data for every scorecard row. No scorecard is shown.` };
  const datasetMax = Number(execute(`SELECT max(year) FROM ${pq(build.root, "agency_crime")}`)[0]?.[0]);
  if (Number.isFinite(datasetMax) && newest < datasetMax - SCORECARD_STALE_YEARS)
    return { kind: "none", explanation: `${label} has no recent year with complete crime, population, and clearance data. Its most recent complete year is ${newest}, which is too far behind ${datasetMax} to present as a current scorecard.` };

  const rowSql = (year: number) => `SELECT c.population, ${ROWS.map((r) => `c.${r.stem}_total`).join(", ")}, ${ROWS.map((r) => `k.${r.stem}_cleared_rate`).join(", ")}
    FROM ${pq(build.root, "agency_crime")} c JOIN ${pq(build.root, "agency_clearances")} k ON k.ori = c.ori AND k.year = c.year WHERE c.ori = ${q(ori)} AND c.year = ${year}`;
  const reliabilityKeys = RELIABILITY_OFFENSES.map((o) => o.column);
  const stemOf = (key: string) => ROWS.find((r) => r.key === key)!.stem;
  const toKeyed = (r: unknown[]): Record<string, number | null> => Object.fromEntries(ROWS.map((row, i) => [row.key, num(r[1 + i])]));
  // The agency's own prior years (the own-history check) and the RTCI months of the year (the cross-check): current_final carries every month by agency.
  const priors = (year: number) => execute(`SELECT ${reliabilityKeys.map((k) => `${stemOf(k)}_total`).join(", ")} FROM ${pq(build.root, "agency_crime")}
    WHERE ori = ${q(ori)} AND year BETWEEN ${year - HISTORY_LOOKBACK_YEARS} AND ${year - 1}`).map((r) => Object.fromEntries(reliabilityKeys.map((k, i) => [k, num(r[i])])) as Record<string, number | null>);
  const monthly = (from: number, to: number) => execute(`SELECT year, ${reliabilityKeys.map((k) => `sum(${stemOf(k)}_total), count(${stemOf(k)}_total)`).join(", ")} FROM ${pq(build.root, "current_final")}
    WHERE ori = ${q(ori)} AND year BETWEEN ${from} AND ${to} GROUP BY year`);
  const suspectOf = (year: number, row: Record<string, number | null>): string[] => {
    const byOffense = new Map<string, number>();
    for (const m of monthly(year, year)) RELIABILITY_OFFENSES.forEach((o, i) => { if (Number(m[2 + 2 * i]) === 12) byOffense.set(o.offense, Number(m[1 + 2 * i])); });
    const ratios: number[] = [];
    const annual = new Map(execute(`SELECT year, murder_total FROM ${pq(build.root, "agency_crime")} WHERE ori = ${q(ori)} AND year BETWEEN ${year - MURDER_RATIO_LOOKBACK_YEARS} AND ${year - 1}`).map((r) => [Number(r[0]), num(r[1])]));
    const murderIdx = RELIABILITY_OFFENSES.findIndex((o) => o.column === "murder");
    for (const m of monthly(year - MURDER_RATIO_LOOKBACK_YEARS, year - 1)) {
      const reported = Number(m[2 + 2 * murderIdx]) === 12 ? Number(m[1 + 2 * murderIdx]) : null, murder = annual.get(Number(m[0]));
      if (murder === null || murder === undefined || reported === null || reported < RTCI_CROSSCHECK_MIN_COUNT) continue;
      ratios.push(murder / reported);
    }
    return describeFindings([...evaluateRtciCrosscheck(row, byOffense, ratios), ...evaluateOwnHistory(row, priors(year))]);
  };

  let year: number | null = null, data: unknown[] | null = null, firstRejection: { year: number } | null = null;
  for (const candidate of complete) {
    if (Number.isFinite(datasetMax) && candidate < datasetMax - SCORECARD_STALE_YEARS) break;
    const r = execute(rowSql(candidate))[0];
    if (!r || num(r[0]) === null || (num(r[0]) as number) <= 0) continue;
    if (suspectOf(candidate, toKeyed(r)).length > 0) { if (!firstRejection) firstRejection = { year: candidate }; continue; }
    year = candidate; data = r;
    break;
  }
  if (year === null || !data) {
    return { kind: "none", explanation: firstRejection
      ? `${label} data may be incomplete for ${firstRejection.year}, and there is no earlier year of known complete data recent enough to show instead.`
      : `${label} has no valid population denominator for its latest complete scorecard year.` };
  }
  const population = num(data[0]) as number;
  const prev = execute(`SELECT ${ROWS.map((r) => `${r.stem}_total`).join(", ")} FROM ${pq(build.root, "agency_crime")} WHERE ori = ${q(ori)} AND year = ${year - 1}`)[0];
  let over100 = false;
  const rows = ROWS.map((r, i) => {
    const count = num(data![1 + i]), clearance = num(data![1 + ROWS.length + i]), before = prev ? num(prev[i]) : null;
    if (clearance !== null && clearance > 100) over100 = true;
    return { label: r.label, offenses: count, change: changePct(count, before), rate: count === null ? null : round1((count * 100000) / population), clearance };
  });
  const fallback = newest > year ? newest : null;
  const text = [`${label} Scorecard (${year})`,
    `${label} crime scorecard for the most recent year with complete crime, population, and clearance data: ${year}.${fallback ? ` ${newest} data may be incomplete, so this is the most recent year of known complete data.` : ""}${over100 ? " Some clearance rates exceed 100% because the FBI can clear cases in the current year that originated in prior reporting years." : ""}`];
  return { kind: "card", year, title: text[0], text, table: table(year, rows, true), scope: "agency", fallback, sql: rowSql(year) };
}

/** A state's or the nation's card: the FBI's own estimate row for the newest complete year, never a sum over agencies; no clearance column. */
function aggregateCard(build: HistoricalBuild, execute: Execute, place: { kind: "state"; code: string; name: string } | { kind: "national" }): ScorecardResult {
  const state = place.kind === "state";
  const file = state ? "state_crime" : "nation_crime";
  const name = state ? place.name : "United States";
  const where = state ? `state = ${q(place.code)}` : "TRUE";
  const parts: string[] = PARTS.map((r) => r.stem);
  const complete = `population > 0 AND ${parts.flatMap((s) => [`${s}_total IS NOT NULL`, `${s}_capita IS NOT NULL`]).join(" AND ")}`;
  const latest = num(execute(`SELECT max(year) FROM ${pq(build.root, file)} WHERE ${where} AND ${complete}`)[0]?.[0]);
  if (latest === null) return { kind: "none", explanation: `${name} has no year in the FBI state-level series with a valid population and complete offense counts and rates.` };
  const tableMax = num(execute(`SELECT max(year) FROM ${pq(build.root, file)}`)[0]?.[0]);
  if (tableMax !== null && latest < tableMax - SCORECARD_STALE_YEARS)
    return { kind: "none", explanation: `${name} has no recent year of complete FBI state-level data. Its most recent complete year is ${latest}, which is too far behind ${tableMax} to present as a current scorecard.` };
  // The FBI publishes violent_capita and property_capita itself; read them after the part columns (P75: published rate first).
  const read = (year: number) => execute(`SELECT ${[...parts.flatMap((s) => [`${s}_total`, `${s}_capita`]), "violent_capita", "property_capita"].join(", ")} FROM ${pq(build.root, file)} WHERE ${where} AND year = ${year}`)[0];
  const cur = read(latest), before = read(latest - 1);
  const field = (r: unknown[] | undefined, stem: string, what: 0 | 1) => (r ? num(r[parts.indexOf(stem) * 2 + what]) : null);
  const group = (r: unknown[] | undefined, stems: string[], what: 0 | 1): number | null => {
    let total = 0;
    for (const s of stems) { const v = field(r, s, what); if (v === null) return null; total += v; }
    return total;   // a sum of the stored values; null if any component is missing, never a partial sum
  };
  const rows = ROWS.map((r) => {
    const stems = r.stem === "violent" ? VIOLENT_PARTS : r.stem === "property" ? PROPERTY_PARTS : null;
    const published = stems && cur ? num(cur[parts.length * 2 + (r.stem === "violent" ? 0 : 1)]) : null;   // the whole's own published rate; the sum of rounded parts can be 0.1 off
    const count = stems ? group(cur, stems, 0) : field(cur, r.stem, 0), rate = stems ? (published ?? group(cur, stems, 1)) : field(cur, r.stem, 1);
    const prior = stems ? group(before, stems, 0) : field(before, r.stem, 0);
    return { label: r.label, offenses: count, change: changePct(count, prior), rate: rate === null ? null : round1(rate), clearance: null };
  });
  const noun = state ? "state-level" : "national";
  const text = [`${name} Scorecard (${latest})`, `${name} crime scorecard from official FBI ${noun} estimates for ${latest}, the latest FBI reporting year. Clearance rates are not shown: the FBI does not publish state-level clearance data in this series.`];
  return { kind: "card", year: latest, title: text[0], text, table: table(latest, rows, false), scope: state ? "state" : "national", fallback: null, sql: `SELECT ... FROM ${file} WHERE ${where} AND year = ${latest}` };
}

export function buildScorecard(build: HistoricalBuild, execute: Execute, place: ScorecardPlace): ScorecardResult {
  return place.kind === "agency" ? agencyCard(build, execute, place.ori, place.label) : aggregateCard(build, execute, place);
}
