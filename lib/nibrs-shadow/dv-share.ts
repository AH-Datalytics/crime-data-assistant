/**
 * What share of a state's or the nation's aggravated assaults were domestic violence (P302, Jeff 2026-11-24):
 *
 *   "what share of aggravated assaults in Texas are domestic violence according to NIBRS"
 *
 * It is the INCIDENTS share (Jeff's ruling): the aggravated assault incidents with at least one domestic violence victim (P82), out of all aggravated
 * assault incidents, summed over the agencies that reported. It is not the victims' share. Each month counts only where the agency reported it for both
 * figures, so the two sums cover the same agencies and months.
 */
import type { NibrsPlan } from "../nibrs-plan/plan";
import { compilePlan } from "../nibrs-plan/compile";
import type { AnswerStatement } from "../nibrs-plan/result";
import { DOMESTIC_VIOLENCE_INCIDENTS_LINE, DOMESTIC_VIOLENCE_LINE, deliverTable, fmt, periodWords } from "./deliver";
import { stateName } from "./places";
import { agencyHeaderSql, universeStates } from "./state-sum";
import { NOT_YET } from "./wording";
import type { ShadowDeps, ShadowOutcome } from "./answer";

type Decline = (explanation: string, detail?: string) => ShadowOutcome;
const OK = new Set(["VALUE", "REPORTED_ZERO"]);

export function answerDvShare(plan: NibrsPlan, period: { from: string; to: string }, deps: ShadowDeps, statements: AnswerStatement[], readings: string[], decline: Decline): ShadowOutcome {
  const place = plan.geography.places[0];
  if ((place.kind !== "state" && place.kind !== "national") || plan.measures.length !== 2) return decline("This isn't available: this share of domestic violence.");
  if (period.from.slice(0, 4) !== period.to.slice(0, 4)) return decline("This isn't available: a share over several years. Ask for one year.");
  const where = place.kind === "national" ? "the United States" : stateName(place.code);
  const when = periodWords(period.from, period.to);
  const year = Number(period.from.slice(0, 4));
  const header = deps.execute(agencyHeaderSql(deps.target.root, universeStates(place), [year]));
  const oris = [...new Set(header.map((r) => String(r[0])))];
  if (!oris.length) return decline(`No agency in ${where} has a header in the data for ${when}.`);
  const sums: Map<string, number>[] = [];
  let sql = "";
  for (const m of plan.measures) {
    const sub: NibrsPlan = { ...plan, measures: [{ ...m, filters: undefined }], filters: [...plan.filters, ...(m.filters ?? [])], transforms: [], groupings: [{ dimension: "time.month", unknown: "visible", absent: "show" }],
      statistics: [{ kind: "count", as: "n", measure: m.as }] };
    const c = compilePlan(sub, { kind: "absolute", ...period }, { ...deps.target, agencies: oris });
    if (c.kind === "unsupported") return decline(NOT_YET, c.reason);
    for (const s of c.query.statements) if (!statements.includes(s)) statements.push(s);
    sql = c.query.sql;
    const rows = deps.execute(`WITH g AS MATERIALIZED (${c.query.sql}) SELECT ori, period, n, n_status FROM g`);
    sums.push(new Map(rows.filter((r) => OK.has(String(r[3]))).map((r) => [`${r[0]}|${r[1]}`, Number(r[2] ?? 0)])));
  }
  const [pop, dv] = sums;
  let denominator = 0, part = 0;
  const agencies = new Set<string>();
  for (const [k, n] of pop) if (dv.has(k)) { denominator += n; part += dv.get(k)!; if (n > 0) agencies.add(k.split("|")[0]); }
  if (!denominator) return decline(`No share is given: no aggravated assault incidents were reported in ${when}.`);
  const value = Math.round((1000 * part) / denominator) / 10;
  const lines = [`In ${where} in ${when}, ${value}% of the aggravated assault incidents had a domestic violence victim, summed over the ${fmt(agencies.size)} agencies with aggravated assault incidents.`,
    "This is the share of incidents, not of victims: an incident counts once when at least one of its victims is a domestic violence victim.",
    DOMESTIC_VIOLENCE_LINE, DOMESTIC_VIOLENCE_INCIDENTS_LINE, "Includes all agencies."];
  const plan2: NibrsPlan = { ...plan, statistics: [...plan.statistics, { kind: "count", as: "denominator", measure: plan.measures[0].as }, { kind: "count", as: "dv_incidents", measure: plan.measures[1].as }] };
  const delivered = deliverTable(plan2, null, { as: "share", header: "Aggravated assault incidents with a domestic violence victim (%)" }, [{ key: null, value, status: "VALUE" }], lines, statements, deps.release.id, readings,
    [{ as: "denominator", header: "Aggravated assault incidents", cells: [{ value: denominator, status: "VALUE" }] },
      { as: "dv_incidents", header: "With a domestic violence victim", cells: [{ value: part, status: "VALUE" }] }]);
  if (delivered.contractProblems.length) return decline(NOT_YET, `answer contract: ${delivered.contractProblems.join("; ")}`);
  const text = [...lines, "Source: NIBRS."];
  return { kind: "answer", plan: plan2, period, sql, delivered: { ...delivered, text, headline: text[0] } };
}
