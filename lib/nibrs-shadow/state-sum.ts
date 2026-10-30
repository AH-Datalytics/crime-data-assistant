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
import type { NibrsPlan } from "../nibrs-plan/plan";
import { compilePlan } from "../nibrs-plan/compile";
import { rate, type MonthCell } from "../nibrs-plan/transforms";
import type { AnswerStatement } from "../nibrs-plan/result";
import { deliverTable, fmt, measureWords, periodWords } from "./deliver";
import { stateName, STATE_NAMES } from "./places";
import { srsPopulation } from "./srs";
import type { ShadowDeps, ShadowOption, ShadowOutcome } from "./answer";

type Decline = (explanation: string) => ShadowOutcome;
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
export const universeStates = (p: NibrsPlan["geography"]["places"][number]) => (p.kind === "national" ? NATION : p.kind === "state" ? headerCodes(p.code) : []);

/** `noPopulation`: agencies counted with no FBI population (coverage is then a lower bound, and no rate is given). */
export type StateSumYear = { year: number; sum: number; agencies: number; partial: number; population: number; share: number; noPopulation: number; conflicts: number;
  every: { agencies: number; sum: number; population: number; share: number; noPopulation: number } };
export type StateSumMeta = { years: StateSumYear[]; everyAgencies: number; crimeIndexPopulation: Record<number, number> };

export function answerStateSum(plan: NibrsPlan, period: { from: string; to: string }, yearSet: number[] | null, deps: ShadowDeps, statements: AnswerStatement[],
  readings: string[], consistent: boolean, decline: Decline): ShadowOutcome {
  const place = plan.geography.places[0];
  const st = plan.statistics[0];
  const isRate = st.kind === "rate";
  const yearG = plan.groupings.some((g) => g.dimension === "time.year");
  if (plan.groupings.some((g) => g.dimension !== "time.year")) return decline("Not in the slice yet: a state or national sum by month or by category.");
  const years = yearSet ?? Array.from({ length: Number(period.to.slice(0, 4)) - Number(period.from.slice(0, 4)) + 1 }, (_, i) => Number(period.from.slice(0, 4)) + i);
  if (years.length > 1 && !yearG) return decline("Not in the slice yet: a state or national total over several years without a year grouping (each year has its own agencies).");
  if (isRate && yearG) return decline("Not in the slice yet: a state or national rate by year.");
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
  if (c.kind === "unsupported") return decline(`Not in the slice yet: ${c.reason}`);
  for (const s of c.query.statements) if (!statements.includes(s)) statements.push(s);
  const cells = new Map<string, MonthCell[]>();
  for (const r of deps.execute(c.query.sql)) {
    const ym = String(r[1]);
    if (yearSet && !yearSet.includes(Number(ym.slice(0, 4)))) continue;
    (cells.get(String(r[0])) ?? cells.set(String(r[0]), []).get(String(r[0]))!).push({ ym, value: r[2] === null || r[2] === undefined ? null : Number(r[2]), status: String(r[3]) });
  }
  // A month is reported when its status is known (VALUE or REPORTED_ZERO); a conflict or unknown month is not.
  const reported = (x: MonthCell) => x.status === "VALUE" || x.status === "REPORTED_ZERO";
  const monthsOf = (y: number) => (cells.values().next().value ?? []).filter((x) => x.ym.startsWith(`${y}-`)).length;
  // The button's set: reported every month of the whole period, with a header in every year (one fixed set).
  const everySet = oris.filter((o) => years.every((y) => inYear.get(y)!.has(o)) && (cells.get(o) ?? []).length > 0 && (cells.get(o) ?? []).every(reported));
  const byYear: StateSumYear[] = years.map((y) => {
    let sum = 0, agencies = 0, partial = 0, population = 0, noPopulation = 0, conflicts = 0;
    for (const o of inYear.get(y)!) {
      const mine = (cells.get(o) ?? []).filter((x) => x.ym.startsWith(`${y}-`));
      // A month whose records conflict with its reporting status is neither reported nor zero: not summed, and said
      // (review 2.4), never folded silently into "reported only some months".
      conflicts += mine.filter((x) => x.status === "EVIDENCE_CONFLICT").length;
      const rep = mine.filter(reported);
      if (!rep.length) continue;
      agencies++;
      const p = pop.get(`${o}|${y}`);
      if (p === null || p === undefined) noPopulation++; else population += p;
      if (rep.length < monthsOf(y)) partial++;
      sum += rep.reduce((a, x) => a + (x.value ?? 0), 0);
    }
    const ev = { agencies: everySet.length, sum: 0, population: 0, share: 0, noPopulation: 0 };
    for (const o of everySet) {
      ev.sum += (cells.get(o) ?? []).filter((x) => x.ym.startsWith(`${y}-`)).reduce((a, x) => a + (x.value ?? 0), 0);
      const p = pop.get(`${o}|${y}`);
      if (p === null || p === undefined) ev.noPopulation++; else ev.population += p;
    }
    ev.share = pct(ev.population, ciPop[y]);
    return { year: y, sum, agencies, partial, population, share: pct(population, ciPop[y]), noPopulation, conflicts, every: ev };
  });
  const meta: StateSumMeta = { years: byYear, everyAgencies: everySet.length, crimeIndexPopulation: ciPop };

  if (place.kind === "national" && !statements.includes("reported_nibrs_counts")) statements.push("reported_nibrs_counts");
  const what = measureWords(plan);
  const Header = `${what[0].toUpperCase()}${what.slice(1)}${isRate ? " per 100,000 residents of the reporting agencies" : ""}`;
  const when = yearSet && yearSet.length > 1 ? `${yearSet.slice(0, -1).join(", ")} and ${yearSet[yearSet.length - 1]}` : periodWords(period.from, period.to);
  const nationNote = place.kind === "national" ? ["The nation here is the 50 states and D.C.; territories and federal agencies are not included."] : [];
  const residents = place.kind === "national" ? "the nation's residents" : "the state's residents";

  const view = (every: boolean): { lines: string[]; rows: { key: string | null; value: number | null; status: string }[] } => {
    const lines: string[] = [];
    if (years.length === 1) {
      const y = byYear[0];
      const n = every ? y.every.sum : y.sum, P = every ? y.every.population : y.population;
      const noPop = every ? y.every.noPopulation : y.noPopulation;
      // No rate over an incomplete denominator (P62, review 2.5); a lower-bound share says "at least".
      const v = isRate ? (noPop ? null : rate({ value: n, status: "VALUE" }, P).value) : n;
      const atLeast = (k: number) => (k ? "at least " : "");
      lines.push(isRate && v === null
        ? `${Where}: no rate is given for ${when}, because ${noPop ? `${fmt(noPop)} of the agencies ${every ? "that reported every month" : "counted"} have no FBI population` : `the FBI population of the agencies ${every ? "that reported every month" : "counted"} is 0`}.`
        : every
        ? `${Where}: ${isRate ? `${v} ${what} per 100,000 residents` : `${fmt(n)} ${what}`} in ${when}, counting only the ${fmt(y.every.agencies)} agencies that reported every month (${atLeast(y.every.noPopulation)}${pc(y.every.share)} of ${residents}).`
        : `${Where}: ${isRate ? `${v} ${what} per 100,000 residents of the reporting agencies` : `${fmt(n)} ${what}`} in ${when}, summed over the agencies that reported.`);
      if (!every) lines.push(`${fmt(y.agencies)} agencies reported at least one month of ${when}, covering ${atLeast(y.noPopulation)}${pc(y.share)} of ${residents}; ${fmt(y.partial)} of them reported only some months and are included. ${fmt(y.every.agencies)} reported every month (${atLeast(y.every.noPopulation)}${pc(y.every.share)} of ${residents}).`);
      if (y.noPopulation && !every) lines.push(`${fmt(y.noPopulation)} of the agencies counted have no FBI population, so the share covered is a lower bound.`);
      if (y.conflicts) lines.push(`${fmt(y.conflicts)} agency-month${y.conflicts === 1 ? "" : "s"} whose records conflict with the agency's reporting status ${y.conflicts === 1 ? "is" : "are"} not counted.`);
      if (isRate && v !== null) lines.push(`The rate is the sum per 100,000 residents of the agencies ${every ? "that reported every month" : "counted"}: ${fmt(P)} residents (the FBI's ${y.year} populations).`);
      // By year for one year keeps its Year cell (review 2.8).
      return { lines, rows: [{ key: yearG ? String(y.year) : null, value: v, status: v === null ? "UNAVAILABLE" : "VALUE" }] };
    }
    lines.push(every
      ? `${Where}: ${what} by year, ${when}, counting only the ${fmt(meta.everyAgencies)} agencies that reported every month of ${when}.`
      : `${Where}: ${what} by year, ${when}, summed over the agencies that reported each year.`);
    lines.push(every
      ? `Residents covered by those agencies: ${byYear.map((y) => `${y.year} ${y.every.noPopulation ? "at least " : ""}${pc(y.every.share)}`).join("; ")}.${byYear.some((y) => y.every.noPopulation) ? " Some of them have no FBI population, so those shares are lower bounds." : ""}`
      : `Agencies counted and share of ${residents} covered: ${byYear.map((y) => `${y.year} ${fmt(y.agencies)} (${y.noPopulation ? "at least " : ""}${pc(y.share)}, ${fmt(y.partial)} reporting only some months)`).join("; ")}. Agencies reporting only some months are included.`);
    const conflicted = byYear.filter((y) => y.conflicts);
    if (conflicted.length) lines.push(`Agency-months whose records conflict with the agency's reporting status are not counted: ${conflicted.map((y) => `${y.year} ${fmt(y.conflicts)}`).join("; ")}.`);
    if (!every) lines.push(`Which agencies report changed over these years, so part of a change can be agencies joining or leaving; the button shows one fixed set of ${fmt(meta.everyAgencies)} agencies that reported every month of ${when}.`);
    return { lines, rows: byYear.map((y) => ({ key: String(y.year), value: every ? y.every.sum : y.sum, status: "VALUE" })) };
  };
  const deliver = (p: NibrsPlan, every: boolean) => {
    const v = view(every);
    return deliverTable(p, yearG ? { dimension: "time.year", header: "Year" } : null, { as: st.as, header: Header }, v.rows, [...v.lines, ...nationNote], statements, deps.release.id, readings);
  };
  const everyPlan: NibrsPlan = { ...plan, coverage: { ...plan.coverage, cohort: "same_agencies" } };
  const everyDelivered = deliver(everyPlan, true);
  const everyOutcome: ShadowOutcome = { kind: "answer", plan: everyPlan, period, sql: c.query.sql, delivered: everyDelivered, stateSum: meta };
  if (consistent) return everyDelivered.contractProblems.length ? decline(`Not in the slice yet: the answer would not meet the answer contract (${everyDelivered.contractProblems.join("; ")}).`) : everyOutcome;
  const delivered = deliver(plan, false);
  if (delivered.contractProblems.length) return decline(`Not in the slice yet: the answer would not meet the answer contract (${delivered.contractProblems.join("; ")}).`);
  const button: ShadowOption = { label: "Show only agencies that reported every month", continuation: everyOutcome };
  return { kind: "answer", plan, period, sql: c.query.sql, delivered, buttons: [button], stateSum: meta };
}
