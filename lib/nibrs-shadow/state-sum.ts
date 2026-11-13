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
import { compilePlan, NO_CATEGORY } from "../nibrs-plan/compile";
import { rate } from "../nibrs-plan/transforms";
import type { AnswerStatement } from "../nibrs-plan/result";
import { deliver as deliverRows, deliverTable, fmt, fmtRate, measureWords, monthName, periodWords } from "./deliver";
import { stateName, STATE_NAMES } from "./places";
import { srsPopulation } from "./srs";
import { headerStates } from "../nibrs-plan/state-codes";
import type { ShadowDeps, ShadowOption, ShadowOutcome } from "./answer";

type Decline = (explanation: string, detail?: string) => ShadowOutcome;
/** The nation's header states: the 50 states and DC, each under every header code it is filed under (Nebraska: NE, NB). */
const NATION = Object.keys(STATE_NAMES).flatMap(headerStates);
const headerCodes = headerStates;
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
/**
 * `everyCurrentPopulation` (P90, Jeff 2026-11-02: "population should be sum of current population of consistent
 * agencies"): the Consistent Reporting Agencies' current populations summed, each agency's most recent FBI population
 * in the build whatever the answer's span; `missing` agencies have none.
 */
export type StateSumMeta = { years: StateSumYear[]; everyAgencies: number; crimeIndexPopulation: Record<number, number>; everyCurrentPopulation: { sum: number; missing: number } };
/** Each agency's most recent FBI population in the build (P90). */
export function currentPopulationSql(root: string, oris: string[]): string {
  return `SELECT ori, arg_max(u.population, u.data_year) AS current_population
    FROM read_parquet('${root.replace(/'/g, "''")}/agency/data.parquet'), unnest(by_year) AS t(u)
    WHERE ori IN (${list(oris)}) AND u.population IS NOT NULL GROUP BY ori`;
}

export function answerStateSum(plan: NibrsPlan, period: { from: string; to: string }, yearSet: number[] | null, deps: ShadowDeps, statements: AnswerStatement[],
  readings: string[], consistent: boolean, decline: Decline): ShadowOutcome {
  const place = plan.geography.places[0];
  // P72: the agencies reporting, or the population a rate divides by, may stand beside the value.
  const supportStat = plan.statistics.find((s) => s.kind === "agencies" || s.kind === "population");
  const st = plan.statistics.filter((s) => s !== supportStat)[0];
  const isRate = st.kind === "rate";
  const yearG = plan.groupings.some((g) => g.dimension === "time.year");
  // One category (coordinator 2026-11-04), by year or not; a month or two categories are not built yet.
  const catDims = plan.groupings.filter((g) => !g.dimension.startsWith("time."));
  if (plan.groupings.some((g) => g.dimension.startsWith("time.") && g.dimension !== "time.year") || catDims.length > 1)
    return decline("This isn't available yet: a state or national sum by month or by two categories.");
  if (catDims.length && isRate) return decline("Rates by category aren't given for a state or the nation: there is no population for each group.");
  const years = yearSet ?? Array.from({ length: Number(period.to.slice(0, 4)) - Number(period.from.slice(0, 4)) + 1 }, (_, i) => Number(period.from.slice(0, 4)) + i);
  if (years.length > 1 && !yearG) return decline("This isn't available yet: a state or national total over several years without \"by year\" (each year has its own reporting agencies).");
  if (isRate && yearG) return decline("This isn't available yet: a state or national rate by year.");
  const where = place.kind === "national" ? "the United States" : stateName((place as { code: string }).code);
  const Where = place.kind === "national" ? "United States" : where;
  // A share always with its one decimal ("89.0%").
  const pc = (n: number) => `${n.toFixed(1)}%`;
  const root = deps.target.root;

  // The universe and populations, per data year.
  const headerSql = agencyHeaderSql(root, universeStates(place), years);
  const header = deps.execute(headerSql);
  // Arrests' category sums (byCategory) join this universe too: an agency counts in a year only with that year's header
  // in the place, as the yearly totals (inYear) count it (Codex arrests review 04.2: a late arrest dated in a year
  // without one is a counted month for arrests). Crimes need no join: a unit in a year without a header has no
  // REPORTED_CRIMES status there, so its month is a conflict and never summed; their SQL stays as it was (FA5: the
  // join on every crime breakdown made each one a fresh, slower query).
  const arrests = plan.measures.every((m) => /^(?:arrests|group_b_arrests)\./.test(m.id));
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
    groupings: [{ dimension: "time.month", unknown: "visible", absent: "show" }, ...catDims], statistics: [{ kind: "count", as: "n", measure: m.as }] };
  const c = compilePlan(sub, { kind: "absolute", ...period }, { ...deps.target, agencies: oris });
  if (c.kind === "unsupported") return decline(NOT_YET, c.reason);
  for (const s of c.query.statements) if (!statements.includes(s)) statements.push(s);
  // Speed (Jeff 2026-11-01, "it's very slow to load"): the grid is summed by agency and year in DuckDB, not read back
  // month by month (the nation's grid is 1.4 million rows; its sums are 90,000). The same figures: per agency and year,
  // the months in the period, the months reported (VALUE or REPORTED_ZERO; a conflict or unknown month is not), the sum
  // of the reported months, and the conflict months.
  const agg = new Map<string, { months: number; rep: number; sum: number; conflicts: number }>();
  const monthsIn = new Map<number, number>();
  // By category (coordinator 2026-11-04), a month is one row per category: its status and its own total (den) are the
  // agency-month's, read once per month, so the year's total is the sum of the months' totals, never of the categories
  // (which can overlap). Two passes over the grid: this one for coverage, one below for both views' category sums.
  const monthly = catDims.length
    ? `SELECT ori, period, any_value(n_status) AS n_status, any_value(den) AS n FROM (${c.query.sql}) GROUP BY ori, period`
    : c.query.sql;
  const covSql = (from: string) => `SELECT ori, CAST(substr(period, 1, 4) AS INTEGER) AS y, count(*) AS months,
      count(*) FILTER (WHERE n_status IN ('VALUE', 'REPORTED_ZERO')) AS rep,
      coalesce(sum(n) FILTER (WHERE n_status IN ('VALUE', 'REPORTED_ZERO')), 0) AS repsum,
      count(*) FILTER (WHERE n_status = 'EVIDENCE_CONFLICT') AS conflicts
    FROM (${from}) GROUP BY ALL`;
  // Speed (job AR6: national arrests by age took minutes): an arrest breakdown reads its grid ONCE. One query gives the
  // coverage rows ('c'), the category sums for every reporting agency and for the Consistent Reporting Agencies ('s'),
  // and how many agencies that set has ('e'); the set is computed in SQL by the rule below (a header in every year,
  // every month reported) and checked against it, falling back to the two-pass reading if they differ. Crimes keep
  // the two passes, their SQL unchanged.
  let onePass: { sums: unknown[][]; every: number } | null = null;
  let covRows: unknown[][];
  if (catDims.length && arrests) {
    const rows = deps.execute(`WITH gr AS MATERIALIZED (${c.query.sql}),
      mo AS (SELECT ori, period, any_value(n_status) AS n_status, any_value(den) AS n FROM gr GROUP BY ori, period),
      cov AS (${covSql("SELECT * FROM mo")}),
      hdr AS (${headerSql}),
      ev AS (SELECT ori FROM cov WHERE ori IN (SELECT ori FROM hdr GROUP BY ori HAVING count(DISTINCT data_year) = ${years.length})
        GROUP BY ori HAVING bool_and(rep = months)),
      su AS (SELECT CAST(substr(period, 1, 4) AS INTEGER) AS y, g0, sum(n) AS n_all,
          coalesce(sum(n) FILTER (WHERE ori IN (SELECT ori FROM ev)), 0) AS n_every
        FROM gr SEMI JOIN hdr h ON h.ori = gr.ori AND h.data_year = CAST(substr(gr.period, 1, 4) AS INTEGER)
        WHERE n_status IN ('VALUE', 'REPORTED_ZERO') AND g0 IS DISTINCT FROM '${NO_CATEGORY}' GROUP BY ALL)
    SELECT 'c' AS t, ori, y, months, rep, repsum, conflicts, NULL AS g0, NULL AS n_all, NULL AS n_every FROM cov
    UNION ALL SELECT 's', NULL, y, NULL, NULL, NULL, NULL, g0, n_all, n_every FROM su
    UNION ALL SELECT 'e', NULL, NULL, count(*), NULL, NULL, NULL, NULL, NULL, NULL FROM ev`);
    if (rows.length && rows.every((r) => r[0] === "c" || r[0] === "s" || r[0] === "e")) {
      covRows = rows.filter((r) => r[0] === "c").map((r) => r.slice(1, 7));
      onePass = { sums: rows.filter((r) => r[0] === "s").map((r) => [r[2], r[7], r[8], r[9]]).sort((a, b) => Number(a[0]) - Number(b[0]) || String(a[1]).localeCompare(String(b[1]))),
        every: Number(rows.find((r) => r[0] === "e")?.[3] ?? -1) };
    } else covRows = deps.execute(covSql(monthly));
  } else covRows = deps.execute(covSql(monthly));
  for (const r of covRows) {
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
  const current = new Map(everySet.length ? deps.execute(currentPopulationSql(deps.target.root, everySet)).map((r) => [String(r[0]), Number(r[1])]) : []);
  const everyCurrentPopulation = { sum: everySet.reduce((a, o) => a + (current.get(o) ?? 0), 0), missing: everySet.filter((o) => !current.has(o)).length };
  const meta: StateSumMeta = { years: byYear, everyAgencies: everySet.length, crimeIndexPopulation: ciPop, everyCurrentPopulation };

  const gridSql = c.query.sql;
  if (catDims.length) return byCategory();

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
  const button: ShadowOption = { label: "Consistent Reporting Agencies", continuation: everyOutcome, role: "consistent_agencies", targetSource: "nibrs" };
  return { kind: "answer", plan, period, sql: c.query.sql, delivered, buttons: [button], stateSum: meta };

  /**
   * A state or national sum by one category (coordinator 2026-11-04): each category summed over the agencies counted
   * (each year's reporting agencies), or over the Consistent Reporting Agencies for the button, reported months only;
   * a category's share is of the year's total units (a multi-valued category's shares can add up to more than 100%).
   * The table and words are the shared delivery's (deliver.ts: labels, order, Unknown last); the coverage line is the
   * state sum's.
   */
  function byCategory(): ShadowOutcome {
    const g = catDims[0].dimension, count = plan.statistics.find((x) => x.kind === "count")!, share = plan.statistics.find((x) => x.kind === "share");
    // Both views' sums in one pass: every reported agency-month, and those of the Consistent Reporting Agencies.
    const sums2 = onePass && onePass.every === everySet.length ? onePass.sums : deps.execute(`SELECT CAST(substr(period, 1, 4) AS INTEGER) AS y, g0, sum(n) AS n_all,
        coalesce(sum(n) FILTER (WHERE ori IN (SELECT unnest([${list(everySet.length ? everySet : [""])}]))), 0) AS n_every
      FROM (${gridSql})${arrests ? ` gr SEMI JOIN (${headerSql}) h ON h.ori = gr.ori AND h.data_year = CAST(substr(gr.period, 1, 4) AS INTEGER)` : ""}
      WHERE n_status IN ('VALUE', 'REPORTED_ZERO') AND g0 IS DISTINCT FROM '${NO_CATEGORY}' GROUP BY ALL ORDER BY 1, 2`);
    const sumsFor = (every: boolean) => sums2.map((r) => [r[0], r[1], every ? r[3] : r[2]]);
    const deliverView = (every: boolean, p: NibrsPlan) => {
      const sums = sumsFor(every).filter((r) => keptYears.includes(Number(r[0])));
      const cats = [...new Set(sums.map((r) => r[1] as string | null))];
      const total = (y: number) => { const b = byYear.find((x) => x.year === y)!; return every ? b.every.sum : b.sum; };
      const rows: unknown[][] = [];
      for (const y of keptYears) for (const k of cats) {
        const n = Number(sums.find((r) => Number(r[0]) === y && r[1] === k)?.[2] ?? 0), den = total(y);
        rows.push([...(yearG ? [String(y)] : []), k, n, "VALUE", ...(share ? [den > 0 ? n / den : null, den > 0 ? "VALUE" : "UNAVAILABLE"] : [])]);
      }
      const columns = [...(yearG ? ["period"] : []), g, count.as, `${count.as}_status`, ...(share ? [share.as, `${share.as}_status`] : [])];
      const d = deliverRows(p, period, period.to, columns, rows, statements, deps.release.id, readings);
      // The state sum's coverage, in its words (Jeff 2026-11-01), after the headline.
      const span = yearSet && yearSet.length > 1 ? `in ${yearSet.join(", ")}` : `from ${monthName(period.from)} through ${monthName(period.to)}`;
      const covered = every ? `Counting only the ${fmt(meta.everyAgencies)} Consistent Reporting Agencies that reported every month ${span}.`
        : keptYears.length === 1 ? `Summed over the ${fmt(byYear.find((x) => x.year === keptYears[0])!.agencies)} agencies that reported.` : "Summed over the agencies that reported each year.";
      // No units at all in the agencies counted: a verified zero, said (Codex state-categories review 01.1).
      const none = !rows.length && (every ? meta.everyAgencies : byYear.some((x) => x.agencies)) ? [`None were reported${every ? " by the Consistent Reporting Agencies" : ""} in ${periodWords(period.from, period.to)}.`] : [];
      return { ...d, text: [d.text[0], covered, ...none, every ? "Includes only agencies that reported complete data." : "Includes all agencies.", ...d.text.slice(1)] };
    };
    const everyPlan: NibrsPlan = { ...plan, coverage: { ...plan.coverage, cohort: "same_agencies" } };
    const everyDelivered = deliverView(true, everyPlan);
    const everyOutcome: ShadowOutcome = { kind: "answer", plan: everyPlan, period, sql: gridSql, delivered: everyDelivered, stateSum: meta };
    if (consistent) return everyDelivered.contractProblems.length ? decline(NOT_YET, `answer contract: ${everyDelivered.contractProblems.join("; ")}`) : everyOutcome;
    const delivered = deliverView(false, plan);
    if (delivered.contractProblems.length) return decline(NOT_YET, `answer contract: ${delivered.contractProblems.join("; ")}`);
    const button: ShadowOption = { label: "Consistent Reporting Agencies", continuation: everyOutcome, role: "consistent_agencies", targetSource: "nibrs" };
    return { kind: "answer", plan, period, sql: gridSql, delivered, buttons: [button], stateSum: meta };
  }
}
