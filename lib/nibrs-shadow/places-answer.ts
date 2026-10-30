/**
 * Several agencies, rates and rankings in the shadow slice (compiler increment 4). One compiled query gives every
 * agency's monthly cells (compile.ts agency grid); the transforms roll them (transforms.ts); this module shapes the
 * answer:
 *
 *   separate   a row per agency, each with its own status; an agency with a month unknown has no total, its months named
 *   combined   one total of the distinct agencies, known only when every agency's every month is (D6, P58)
 *   rate       count per 100,000 residents over the FBI's agency population of the data year (P15), only when the
 *              count is known (P58); a part of a year is that months' count, never annualized (P59); a missing or zero
 *              population gives no rate; a combined rate is the sum of counts over the sum of populations
 *   by year    one agency's rate (or count) for each year, over that year's population
 *   ranking    a state's city agencies (FBI agency indicator 1; P08's 250,000+ when "large"), only those with every
 *              month of the period known ranked (P60), by count or rate, ties alphabetical, cut at the limit (P17, D05);
 *              one line names those left out with their months reported (more than five: the count and the five
 *              largest by population)
 */
import type { NibrsPlan } from "../nibrs-plan/plan";
import { agencyPopulationSql, compilePlan } from "../nibrs-plan/compile";
import { combineMonths, rankAgencies, rate, rollup, type Cell, type MonthCell } from "../nibrs-plan/transforms";
import type { AnswerStatement } from "../nibrs-plan/result";
import { deliverTable, fmt, measureWords, monthName, periodWords, runs } from "./deliver";
import type { ShadowDeps, ShadowOutcome } from "./answer";

type Decline = (explanation: string) => ShadowOutcome;
const STATE: Record<string, string> = { TX: "Texas", OH: "Ohio", CO: "Colorado" };
const title = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const knownMonths = (cells: MonthCell[]) => cells.filter((c) => c.status === "VALUE" || c.status === "REPORTED_ZERO").length;

export function answerPlaces(plan: NibrsPlan, period: { from: string; to: string }, deps: ShadowDeps, statements: AnswerStatement[], readings: string[], decline: Decline): ShadowOutcome {
  const st = plan.statistics[0];
  if (plan.statistics.length !== 1 || (st.kind !== "count" && st.kind !== "rate")) return decline("Not in the slice yet: this statistic for several agencies.");
  const isRate = st.kind === "rate";
  const yearG = plan.groupings.some((g) => g.dimension === "time.year");
  const geoG = plan.groupings.find((g) => g.dimension.startsWith("geo."));
  if (plan.groupings.some((g) => !g.dimension.startsWith("geo.") && g.dimension !== "time.year") || (geoG && yearG))
    return decline("Not in the slice yet: several agencies by month, by year or by category.");
  const years = Array.from({ length: Number(period.to.slice(0, 4)) - Number(period.from.slice(0, 4)) + 1 }, (_, i) => Number(period.from.slice(0, 4)) + i);
  if (isRate && years.length > 1 && !yearG) return decline("Not in the slice yet: a rate over several years without a year grouping (each year has its own population).");
  const rankT = plan.transforms.find((t) => t.kind === "rank");
  const set = plan.geography.places[0].kind === "agency_set" ? plan.geography.places[0] : null;
  const root = deps.target.root;

  // The agencies: the named ones, or the state's city agencies (with P08's floor), named by the place index when it
  // has them.
  let agencies: { ori: string; label: string; population: number | null }[];
  if (set) {
    if (set.within.kind !== "state") return decline("Not in the slice yet: this set of agencies.");
    const floor = set.where.find((w) => w.field === "agency.population" && w.op === ">=");
    const lastYear = years[years.length - 1];
    const rows = deps.execute(agencyPopulationSql(root, { state: set.within.code, city: true }, [lastYear]));
    const names = new Map<string, string>();
    for (const xs of deps.places.byName.values()) for (const a of xs) names.set(a.ori, a.name);
    agencies = rows.map((r) => ({ ori: String(r[0]), label: names.get(String(r[0])) ?? (r[3] ? title(String(r[3])) : String(r[0])), population: r[2] === null ? null : Number(r[2]) }))
      .filter((a) => !floor || (a.population ?? 0) >= Number(floor.value));
  } else {
    agencies = plan.geography.places.map((p) => (p.kind === "agency" ? { ori: p.ori, label: p.label, population: null } : { ori: "", label: "", population: null }));
  }
  if (!agencies.length) return decline("No city agency in this place meets the conditions.");
  const oris = agencies.map((a) => a.ori);
  const pops = new Map<string, number | null>();
  for (const r of deps.execute(agencyPopulationSql(root, { oris }, years))) pops.set(`${r[0]}|${r[1]}`, r[2] === null ? null : Number(r[2]));

  // The monthly grid: one count, by month, for every agency.
  const m = plan.measures[0];
  const sub: NibrsPlan = { ...plan, measures: [{ ...m, filters: undefined }], filters: [...plan.filters, ...(m.filters ?? [])], transforms: [],
    groupings: [{ dimension: "time.month", unknown: "visible", absent: "show" }], statistics: [{ kind: "count", as: "n", measure: m.as }] };
  const c = compilePlan(sub, { kind: "absolute", ...period }, { ...deps.target, agencies: oris });
  if (c.kind === "unsupported") return decline(`Not in the slice yet: ${c.reason}`);
  for (const s of c.query.statements) if (!statements.includes(s)) statements.push(s);
  const byOri = new Map<string, MonthCell[]>(oris.map((o) => [o, []]));
  for (const r of deps.execute(c.query.sql)) byOri.get(String(r[0]))?.push({ ym: String(r[1]), value: r[2] === null || r[2] === undefined ? null : Number(r[2]), status: String(r[3]) });
  // A conflict refuses a named place; in a ranking the agency is left out, never ranked.
  if (!set && [...byOri.values()].some((cells) => cells.some((x) => x.status === "EVIDENCE_CONFLICT")))
    return decline("The records for this agency and period conflict with its monthly reporting status, so no number is given.");

  const what = measureWords(plan);
  const Header = `${what[0].toUpperCase()}${what.slice(1)}`;
  const statHeader = isRate ? `${Header} per 100,000 residents` : Header;
  const when = periodWords(period.from, period.to);
  const partYear = !(period.from.endsWith("-01") && period.to.endsWith("-12"));
  const valueOf = (cells: MonthCell[], ori: string | null, year: number): Cell & { missing: string[] } => {
    const total = rollup(cells);
    if (!isRate) return total;
    const pop = ori ? pops.get(`${ori}|${year}`) : null;
    return { ...rate(total, pop), missing: total.missing };
  };
  const lines: string[] = [];
  const popLine = (year: number, list: { ori: string; label: string }[]) =>
    `Rates are per 100,000 residents, using the FBI's ${year} population of ${list.length > 1 ? "each agency" : "the agency"}: ${list.map((a) => `${a.label} ${pops.get(`${a.ori}|${year}`) ? fmt(pops.get(`${a.ori}|${year}`)!) : "(none)"}`).join("; ")}.`;
  const partLine = () => { if (partYear) lines.push(`This covers ${when}${isRate ? "; the rate is for those months and is not annualized" : ""}.`); };
  const year = years[years.length - 1];

  // A ranking of a state's city agencies (P60).
  if (set && rankT && rankT.kind === "rank") {
    const entries = agencies.map((a) => {
      const cells = byOri.get(a.ori) ?? [];
      const v = valueOf(cells, a.ori, year);
      return { ...a, name: a.label, value: v.value, known: v.status === "VALUE" || v.status === "REPORTED_ZERO", monthsKnown: knownMonths(cells), months: cells.length };
    });
    const { ranked, leftOut } = rankAgencies(entries, rankT.direction, rankT.limit);
    const code = set.within.kind === "state" ? set.within.code : "";
    const where = STATE[code] ?? code;
    const floor = set.where.find((w) => w.field === "agency.population");
    lines.push(`${where} city agencies${floor ? " of 250,000 residents or more" : ""}: the ${ranked.length} with the ${rankT.direction === "top" ? (isRate ? "highest" : "most") : (isRate ? "lowest" : "fewest")} ${what}${isRate ? " per 100,000 residents" : ""}, ${when}.`);
    if (floor) lines.push("Large means 250,000 residents or more (the FBI's agency population).");
    partLine();
    const full = partYear ? `every month of ${when}` : `all 12 months of ${when}`;
    lines.push(`Ranked: agencies that reported ${full}; ties are ordered by agency name.`);
    const out = leftOut.filter((a) => a.monthsKnown < a.months);
    if (out.length) {
      const name = (a: (typeof out)[number]) => `${a.label} (${a.monthsKnown} month${a.monthsKnown === 1 ? "" : "s"})`;
      const largest = [...out].sort((a, b) => (b.population ?? 0) - (a.population ?? 0) || a.label.localeCompare(b.label)).slice(0, 5);
      lines.push(out.length <= 5 ? `Not ranked because they didn't report ${full}: ${out.map(name).join(", ")}.`
        : `Not ranked because they didn't report ${full}: ${out.length} agencies, the largest ${largest.map(name).join(", ")}.`);
    }
    const noPop = leftOut.filter((a) => a.monthsKnown === a.months);
    if (isRate && noPop.length) lines.push(`Not ranked because the FBI gives no population: ${noPop.map((a) => a.label).join(", ")}.`);
    if (isRate) lines.push(`Rates are per 100,000 residents of each agency (the FBI's ${year} population).`);
    const delivered = deliverTable(plan, { dimension: geoG!.dimension, header: "Agency" }, { as: st.as, header: statHeader },
      ranked.map((a) => ({ key: a.label, value: a.value, status: "VALUE" })), lines, statements, deps.release.id, readings);
    return done(plan, period, c.query.sql, delivered, decline);
  }
  if (set) return decline("Not in the slice yet: a set of agencies without a ranking.");

  // One agency's values by year.
  if (yearG) {
    const a = agencies[0], cells = byOri.get(a.ori) ?? [];
    const rows = years.map((y) => {
      const v = valueOf(cells.filter((x) => x.ym.startsWith(`${y}-`)), a.ori, y);
      return { key: String(y), value: v.value, status: v.status, missing: v.missing };
    });
    lines.push(`${a.label}: ${isRate ? `${what} per 100,000 residents` : what} by year, ${when}.`);
    if (isRate) lines.push(`Each year's rate uses the FBI's population for that year: ${years.map((y) => `${y} ${pops.get(`${a.ori}|${y}`) ? fmt(pops.get(`${a.ori}|${y}`)!) : "(none)"}`).join("; ")}.`);
    const missing = rows.flatMap((r) => r.missing);
    if (missing.length) lines.push(`No report is known for ${runs(missing)}: that year's ${isRate ? "rate" : "total"} is not given.`);
    const delivered = deliverTable(plan, { dimension: "time.year", header: "Year" }, { as: st.as, header: statHeader }, rows, lines, statements, deps.release.id, readings);
    return done(plan, period, c.query.sql, delivered, decline);
  }

  // Combined: one total of the distinct agencies.
  if (plan.geography.combine === "combined") {
    const cells = combineMonths(agencies.map((a) => byOri.get(a.ori) ?? []));
    const total = rollup(cells);
    const popSum = agencies.every((a) => pops.get(`${a.ori}|${year}`)) ? agencies.reduce((s, a) => s + pops.get(`${a.ori}|${year}`)!, 0) : null;
    const v: Cell = isRate ? rate(total, popSum) : total;
    const names = agencies.map((a) => a.label);
    const together = names.length > 2 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join(" and ");
    lines.push(v.value !== null ? `${together}, combined: ${isRate ? `${v.value} ${what} per 100,000 residents` : `${fmt(v.value)} ${what}`} in ${when}.`
      : `${together}, combined: no ${isRate ? "rate" : "total"} is given for ${when}, because not every month is known for every agency counted.`);
    if (isRate && v.value !== null) lines.push(`The rate is both agencies' offenses over both agencies' populations (the FBI's ${year} figures: ${agencies.map((a) => `${a.label} ${fmt(pops.get(`${a.ori}|${year}`)!)}`).join("; ")}).`);
    for (const a of agencies) { const miss = rollup(byOri.get(a.ori) ?? []).missing; if (miss.length) lines.push(`No report is known for ${runs(miss)} for ${a.label}.`); }
    partLine();
    const delivered = deliverTable(plan, null, { as: st.as, header: statHeader }, [{ key: null, value: v.value, status: v.status }], lines, statements, deps.release.id, readings);
    return done(plan, period, c.query.sql, delivered, decline);
  }

  // Separate: a row per agency (or one agency's single value).
  const rows = agencies.map((a) => { const v = valueOf(byOri.get(a.ori) ?? [], a.ori, year); return { key: a.label, value: v.value, status: v.status, missing: v.missing, a }; });
  if (agencies.length === 1) {
    const r = rows[0];
    lines.push(r.value !== null ? `${r.key}: ${isRate ? `${r.value} ${what} per 100,000 residents` : `${fmt(r.value)} ${what}`} in ${when}.`
      : `${r.key}: no ${isRate ? "rate" : "number"} is given for ${when}, because not every month is known.`);
  } else lines.push(`${what[0].toUpperCase()}${what.slice(1)}${isRate ? " per 100,000 residents" : ""} by agency, ${when}.`);
  if (isRate) lines.push(popLine(year, agencies));
  for (const r of rows) if (r.missing.length) lines.push(`No report is known for ${runs(r.missing)} for ${r.key}, so its ${isRate ? "rate" : `${when} total`} is not given.`);
  partLine();
  const delivered = deliverTable(plan, geoG ? { dimension: geoG.dimension, header: "Agency" } : null, { as: st.as, header: statHeader },
    rows.map((r) => ({ key: r.key, value: r.value, status: r.status })), lines, statements, deps.release.id, readings);
  return done(plan, period, c.query.sql, delivered, decline);
}

function done(plan: NibrsPlan, period: { from: string; to: string }, sql: string, delivered: ReturnType<typeof deliverTable>, decline: Decline): ShadowOutcome {
  if (delivered.contractProblems.length) return decline(`Not in the slice yet: the answer would not meet the answer contract (${delivered.contractProblems.join("; ")}).`);
  return { kind: "answer", plan, period, sql, delivered };
}

export { monthName };
