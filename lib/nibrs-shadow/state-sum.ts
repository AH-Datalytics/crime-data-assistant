/**
 * A NIBRS-only crime or detail for a state or the nation (P53): the sum of what the agencies reported, as the FBI sums
 * it (P61, Jeff 2026-10-30), with the disclaimer and the consistent-reporters button.
 *
 *   universe     every agency with a batch header in the data year's file whose header state is the state asked; the
 *                nation is the 50 states and DC (Nebraska's header code is NB), territories and federal agencies left out
 *   sum          the measure over every reported agency-month (REPORTED_CRIMES or REPORTED_ZERO); an unknown month adds
 *                nothing and is not a zero
 *   counted      agencies with at least one month reported; partial reporters: counted, not every month of the period
 *   coverage     (P61's note, coordinator decision following Jeff's CDE-like rule) the agencies' FBI populations over
 *                the Crime Index population of the state or nation for the year: one figure for the agencies counted,
 *                one for those that reported every month
 *   rate         (P62) the sum per 100,000 residents of exactly the agencies counted (their summed FBI populations, no
 *                month weighting); the button's view: per 100,000 residents of the agencies that reported every month
 *   button       one fixed set of agencies that reported every month of the whole period (P03, P61)
 */
import { NOT_YET } from "./wording";
import type { NibrsPlan } from "../nibrs-plan/plan";
import { compilePlan } from "../nibrs-plan/compile";
import { rate } from "../nibrs-plan/transforms";
import type { AnswerStatement } from "../nibrs-plan/result";
import { deliverTable, fmt, fmtRate, measureWords, monthName, periodWords } from "./deliver";
import { stateName, STATE_NAMES } from "./places";
import { srsPopulation } from "./srs";
import type { ShadowDeps, ShadowOption, ShadowOutcome } from "./answer";

type Decline = (explanation: string, detail?: string) => ShadowOutcome;
/** The nation's header states: the 50 states and DC; Nebraska's header code is NB. */
const NATION = [...Object.keys(STATE_NAMES).filter((c) => c !== "NE"), "NB"];
const headerCodes = (code: string) => (code === "NE" ? ["NB", "NE"] : [code]);
const list = (xs: string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(", ");
const pct = (part: number, whole: number) => Math.round((1000 * part) / whole) / 10;

/** Header agencies of the states asked, by data year: ori, year, FBI population, header state. */
export function agencyHeaderSql(root: string, states: string[], years: number[]): string {
  return `SELECT ori, u.data_year, u.population, u.state_abbr
    FROM read_parquet('${root.replace(/'/g, "''")}/agency/data.parquet'), unnest(by_year) AS t(u)
    WHERE u.state_abbr IN (${list(states)}) AND u.data_year IN (${years.map(Number).join(", ")}) ORDER BY ori, u.data_year`;
}
/**
 * The population covered as shown (Jeff 2026-11-01): a percent, "≥" when some agencies have no FBI population, and
 * never above 100%. The agencies' FBI populations are their own estimates and can sum a little above the Crime Index
 * estimate for the place (Tennessee 2021: 6,995,842 against 6,968,351, city and county agencies only): that is all the
 * residents, shown as 100.0%. The share computed stays in the answer's metadata for checking.
 */
export const coveredText = (share: number, lower: boolean) => `${lower ? "≥" : ""}${Math.min(share, 100).toFixed(1)}%`;
export const universeStates = (p: NibrsPlan["geography"]["places"][number]) => (p.kind === "national" ? NATION : p.kind === "state" ? headerCodes(p.code) : []);

/** `noPopulation`: agencies counted with no FBI population (coverage is then a lower bound, and no rate is given). */
export type StateSumYear = { year: number; sum: number; agencies: number; partial: number; population: number; share: number; noPopulation: number; conflicts: number;
  every: { agencies: number; sum: number; population: number; share: number; noPopulation: number } };
export type StateSumMeta = { years: StateSumYear[]; everyAgencies: number; crimeIndexPopulation: Record<number, number> };

export function answerStateSum(plan: NibrsPlan, period: { from: string; to: string }, yearSet: number[] | null, deps: ShadowDeps, statements: AnswerStatement[],
  readings: string[], consistent: boolean, decline: Decline): ShadowOutcome {
  const place = plan.geography.places[0];
  // P72: the agencies reporting, or the population a rate divides by, may stand beside the value.
  const supportStat = plan.statistics.find((s) => s.kind === "agencies" || s.kind === "population");
  const st = plan.statistics.filter((s) => s !== supportStat)[0];
  const isRate = st.kind === "rate";
  const yearG = plan.groupings.some((g) => g.dimension === "time.year");
  if (plan.groupings.some((g) => g.dimension !== "time.year")) return decline("This isn't available yet: a state or national sum by month or by category.");
  const years = yearSet ?? Array.from({ length: Number(period.to.slice(0, 4)) - Number(period.from.slice(0, 4)) + 1 }, (_, i) => Number(period.from.slice(0, 4)) + i);
  if (years.length > 1 && !yearG) return decline("This isn't available yet: a state or national total over several years without \"by year\" (each year has its own reporting agencies).");
  if (isRate && yearG) return decline("This isn't available yet: a state or national rate by year.");
  const where = place.kind === "national" ? "the United States" : stateName((place as { code: string }).code);
  const Where = place.kind === "national" ? "United States" : where;
  // A share always with its one decimal ("89.0%").
  const pc = (n: number) => `${n.toFixed(1)}%`;
  const root = deps.target.root;

  // The universe and populations, per data year.
  const header = deps.execute(agencyHeaderSql(root, universeStates(place), years));
  // A missing FBI population stays missing (null), never 0: it withholds the rate and makes coverage a lower bound
  // (Codex increment-5 review 2.5). A population of 0 is the FBI's own figure (a state police, a university).
  const pop = new Map<string, number | null>();
  const inYear = new Map<number, Set<string>>(years.map((y) => [y, new Set<string>()]));
  for (const r of header) { inYear.get(Number(r[1]))?.add(String(r[0])); pop.set(`${r[0]}|${r[1]}`, r[2] === null ? null : Number(r[2])); }
  const oris = [...new Set(header.map((r) => String(r[0])))];
  if (!oris.length) return decline(`No agency in ${where} has a header in the data for ${periodWords(period.from, period.to)}.`);
  const ciPop: Record<number, number> = {};
  for (const y of years) { const p = srsPopulation(place.kind === "national" ? { kind: "national" } : { kind: "state", code: (place as { code: string }).code }, y); if (!p) return decline(`The Crime Index has no ${y} population for ${where}, so coverage cannot be stated.`); ciPop[y] = p; }

  // The monthly grid of every agency (compile.ts), as for several agencies.
  const m = plan.measures[0];
  const sub: NibrsPlan = { ...plan, measures: [{ ...m, filters: undefined }], filters: [...plan.filters, ...(m.filters ?? [])], transforms: [],
    groupings: [{ dimension: "time.month", unknown: "visible", absent: "show" }], statistics: [{ kind: "count", as: "n", measure: m.as }] };
  const c = compilePlan(sub, { kind: "absolute", ...period }, { ...deps.target, agencies: oris });
  if (c.kind === "unsupported") return decline(NOT_YET, c.reason);
  for (const s of c.query.statements) if (!statements.includes(s)) statements.push(s);
  // Speed (Jeff 2026-11-01, "it's very slow to load"): the grid is summed by agency and year in DuckDB, not read back
  // month by month (the nation's grid is 1.4 million rows; its sums are 90,000). The same figures: per agency and year,
  // the months in the period, the months reported (VALUE or REPORTED_ZERO; a conflict or unknown month is not), the sum
  // of the reported months, and the conflict months.
  const agg = new Map<string, { months: number; rep: number; sum: number; conflicts: number }>();
  const monthsIn = new Map<number, number>();
  for (const r of deps.execute(`SELECT ori, CAST(substr(period, 1, 4) AS INTEGER) AS y, count(*) AS months,
      count(*) FILTER (WHERE n_status IN ('VALUE', 'REPORTED_ZERO')) AS rep,
      coalesce(sum(n) FILTER (WHERE n_status IN ('VALUE', 'REPORTED_ZERO')), 0) AS repsum,
      count(*) FILTER (WHERE n_status = 'EVIDENCE_CONFLICT') AS conflicts
    FROM (${c.query.sql}) GROUP BY ALL`)) {
    const y = Number(r[1]);
    if (yearSet && !yearSet.includes(y)) continue;
    agg.set(`${r[0]}|${y}`, { months: Number(r[2]), rep: Number(r[3]), sum: Number(r[4]), conflicts: Number(r[5]) });
    monthsIn.set(y, Math.max(monthsIn.get(y) ?? 0, Number(r[2])));
  }
  const keptYears = years.filter((y) => monthsIn.has(y));
  const of = (o: string, y: number) => agg.get(`${o}|${y}`);
  // The button's set: reported every month of the whole period, with a header in every year (one fixed set).
  const everySet = oris.filter((o) => years.every((y) => inYear.get(y)!.has(o)) && keptYears.some((y) => of(o, y))
    && keptYears.every((y) => { const a = of(o, y); return !a || a.rep === a.months; }));
  const byYear: StateSumYear[] = years.map((y) => {
    let sum = 0, agencies = 0, partial = 0, population = 0, noPopulation = 0, conflicts = 0;
    for (const o of inYear.get(y)!) {
      const a = of(o, y);
      if (!a) continue;
      // A month whose records conflict with its reporting status is neither reported nor zero: not summed, and said
      // (review 2.4), never folded silently into "reported only some months".
      conflicts += a.conflicts;
      if (!a.rep) continue;
      agencies++;
      const p = pop.get(`${o}|${y}`);
      if (p === null || p === undefined) noPopulation++; else population += p;
      if (a.rep < (monthsIn.get(y) ?? 0)) partial++;
      sum += a.sum;
    }
    const ev = { agencies: everySet.length, sum: 0, population: 0, share: 0, noPopulation: 0 };
    for (const o of everySet) {
      ev.sum += of(o, y)?.sum ?? 0;
      const p = pop.get(`${o}|${y}`);
      if (p === null || p === undefined) ev.noPopulation++; else ev.population += p;
    }
    ev.share = pct(ev.population, ciPop[y]);
    return { year: y, sum, agencies, partial, population, share: pct(population, ciPop[y]), noPopulation, conflicts, every: ev };
  });
  const meta: StateSumMeta = { years: byYear, everyAgencies: everySet.length, crimeIndexPopulation: ciPop };

  // Jeff (2026-11-01, "WAAAAY too much disclaimer"): no "counts reported to NIBRS" line; the lead says where they come from.
  const what = measureWords(plan);
  const Header = `${what[0].toUpperCase()}${what.slice(1)}${isRate ? " per 100,000" : ""}`;
  const when = yearSet && yearSet.length > 1 ? `${yearSet.slice(0, -1).join(", ")} and ${yearSet[yearSet.length - 1]}` : periodWords(period.from, period.to);
  // Jeff (2026-11-01): the Consistent Reporting Agencies are one fixed set, complete for every month of the whole span
  // asked (never per year), and the span is always named.
  const span = yearSet && yearSet.length > 1 ? `in ${when}` : `from ${monthName(period.from)} through ${monthName(period.to)}`;

  type Row = { key: string | null; value: number | null; status: string };
  type Cell = { value: number | string | null; status: string };
  // Jeff (2026-11-01): the agencies and the population they cover are table columns, not prose; a lower bound (some
  // agencies have no FBI population) is marked "≥" in its cell. P80: the fixed set is "Consistent Reporting Agencies".
  const covered = (share: number, lower: number): Cell => ({ value: coveredText(share, lower > 0), status: "VALUE" });
  const CRA = "Consistent Reporting Agencies";
  // Jeff (2026-11-01): one note, his words, then the source; a rate adds its basis. Nothing else.
  const note = (every: boolean) => (every ? "Includes only agencies that reported complete data." : "Includes all agencies.");
  const view = (every: boolean): { lines: string[]; rows: Row[]; agencies: Cell[]; coverage: Cell[]; population: Cell[] } => {
    const lines: string[] = [];
    if (years.length === 1) {
      const y = byYear[0];
      const n = every ? y.every.sum : y.sum, P = every ? y.every.population : y.population;
      const noPop = every ? y.every.noPopulation : y.noPopulation;
      // No rate over an incomplete denominator (P62, review 2.5).
      const v = isRate ? (noPop ? null : rate({ value: n, status: "VALUE" }, P).value) : n;
      const counted = every ? `the ${CRA}` : "the agencies counted";
      lines.push(isRate && v === null
        ? `${Where}: no rate is given for ${when}, because ${noPop ? `${fmt(noPop)} of ${counted} have no FBI population` : `the FBI population of ${counted} is 0`}.`
        : every
        ? `${Where}: ${isRate ? `${fmtRate(v!)} ${what} per 100,000` : `${fmt(n)} ${what}`} in ${when}, counting only the ${fmt(y.every.agencies)} ${CRA} that reported every month ${span}.`
        : `${Where}: ${isRate ? `${fmtRate(v!)} ${what} per 100,000` : `${fmt(n)} ${what}`} in ${when}, summed over the agencies that reported.`);
      lines.push(note(every));
      if (isRate && v !== null) lines.push(`The rate uses the combined population of ${counted}: ${fmt(P)} (the FBI's ${y.year} populations).`);
      // By year for one year keeps its Year cell (review 2.8).
      return { lines, rows: [{ key: yearG ? String(y.year) : null, value: v, status: v === null ? "UNAVAILABLE" : "VALUE" }],
        agencies: [{ value: every ? y.every.agencies : y.agencies, status: "VALUE" }],
        coverage: [covered(every ? y.every.share : y.share, noPop)],
        population: [noPop ? { value: null, status: "UNAVAILABLE" } : { value: P, status: "VALUE" }] };
    }
    lines.push(every
      ? `${Where}: ${what} by year, ${when}, counting only the ${fmt(meta.everyAgencies)} ${CRA} that reported every month ${span}.`
      : `${Where}: ${what} by year, ${when}, summed over the agencies that reported each year.`);
    lines.push(note(every));
    return { lines, rows: byYear.map((y) => ({ key: String(y.year), value: every ? y.every.sum : y.sum, status: "VALUE" })),
      agencies: byYear.map((y) => ({ value: every ? meta.everyAgencies : y.agencies, status: "VALUE" })),
      coverage: byYear.map((y) => covered(every ? y.every.share : y.share, every ? y.every.noPopulation : y.noPopulation)),
      population: byYear.map(() => ({ value: null, status: "UNAVAILABLE" })) };
  };
  // The plan names every column it shows (the answer contract): the agencies and the population covered only when the
  // question asks for the agencies reporting (P87, Jeff 2026-11-01: coverage columns on request; the figures are still
  // carried in stateSum); the population a rate divides by when asked (P72).
  const measureOf = "measure" in st ? st.measure : "";
  const askedCoverage = plan.statistics.some((x) => x.kind === "agencies");
  const withColumns = (p: NibrsPlan): NibrsPlan => ({ ...p, statistics: [...p.statistics.filter((x) => x.kind !== "agencies"),
    { kind: "agencies", as: "agencies", measure: measureOf }, { kind: "coverage", as: "coverage", measure: measureOf }] });
  const deliver = (p: NibrsPlan, every: boolean) => {
    const v = view(every);
    return deliverTable(p, yearG ? { dimension: "time.year", header: "Year" } : null, { as: st.as, header: Header }, v.rows, v.lines, statements, deps.release.id, readings,
      [...(askedCoverage ? [{ as: "agencies", header: every ? CRA : "Agencies reporting", cells: v.agencies }, { as: "coverage", header: "Population covered", cells: v.coverage }] : []),
        ...(supportStat?.kind === "population" ? [{ as: supportStat.as, header: "Population", cells: v.population }] : [])]);
  };
  if (askedCoverage) plan = withColumns(plan);
  const everyPlan: NibrsPlan = { ...plan, coverage: { ...plan.coverage, cohort: "same_agencies" } };
  const everyDelivered = deliver(everyPlan, true);
  const everyOutcome: ShadowOutcome = { kind: "answer", plan: everyPlan, period, sql: c.query.sql, delivered: everyDelivered, stateSum: meta };
  if (consistent) return everyDelivered.contractProblems.length ? decline(NOT_YET, `answer contract: ${everyDelivered.contractProblems.join("; ")}`) : everyOutcome;
  const delivered = deliver(plan, false);
  if (delivered.contractProblems.length) return decline(NOT_YET, `answer contract: ${delivered.contractProblems.join("; ")}`);
  const button: ShadowOption = { label: "Consistent Reporting Agencies", continuation: everyOutcome };
  return { kind: "answer", plan, period, sql: c.query.sql, delivered, buttons: [button], stateSum: meta };
}
