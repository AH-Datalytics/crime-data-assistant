/**
 * The current year's clearance rate of a Part I offense, from NIBRS (P57; Jeff 2026-11-16, through the coordinator).
 *
 *   rate        the offenses cleared over the offenses reported, in the months of the year the data holds (January through the
 *               release's last month); the answer says the months. Jeff's answer, whole: "Houston, Texas: 41% of murders reported
 *               in January through September 2026 were cleared. Source: NIBRS." Rate only: no counts, no method sentence.
 *   agency      every month of the span must be reported (a month with no report is named and no rate is given)
 *   state, nation  "Current year calcs for state or nation require only consistent reporting agencies and should say so": the
 *               agencies that reported crimes in every month of the span (state-sum.ts's rule for the Consistent Reporting
 *               Agencies: a VALUE month each, a header in the year), the answer counting only them, with their number
 *   one set     the same agencies for the offenses and for the cleared offenses, so the figures are of one group
 *
 * The completed years' clearance rate is the FBI annual method from Crime Index (P57); this is only the current year.
 */
import type { NibrsPlan } from "../nibrs-plan/plan";
import { compilePlan } from "../nibrs-plan/compile";
import type { AnswerStatement } from "../nibrs-plan/result";
import { deliverTable, fmt, monthName, periodWords, runs } from "./deliver";
import { HISTORICAL_MEASURE } from "./historical";
import { stateName } from "./places";
import { agencyHeaderSql, universeStates } from "./state-sum";
import { NOT_YET } from "./wording";
import type { ShadowDeps, ShadowOutcome } from "./answer";

type Decline = (explanation: string, detail?: string) => ShadowOutcome;
type Measure = NibrsPlan["measures"][number];
const list = (xs: string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(", ");

/** The months from `from` through `to`, as "YYYY-MM". */
function monthsOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7)); `${y}-${String(m).padStart(2, "0")}` <= to; m === 12 ? (y++, m = 1) : m++) out.push(`${y}-${String(m).padStart(2, "0")}`);
  return out;
}

export function answerCurrentClearance(plan: NibrsPlan, period: { from: string; to: string }, crime: string, deps: ShadowDeps, statements: AnswerStatement[],
  readings: string[], decline: Decline): ShadowOutcome {
  const place = plan.geography.places[0];
  const all = plan.measures.find((m) => !m.as.endsWith("_cleared")), cleared = plan.measures.find((m) => m.as.endsWith("_cleared"));
  const stat = plan.statistics[0];
  if (!all || !cleared || plan.measures.length !== 2 || plan.statistics.length !== 1 || stat.kind !== "ratio" || plan.groupings.length || plan.transforms.length
    || (place.kind !== "agency" && place.kind !== "state" && place.kind !== "national"))
    return decline("This isn't available: this form of a clearance rate.");
  const words = HISTORICAL_MEASURE[crime]?.words ?? crime.replace(/_/g, " ");
  const when = periodWords(period.from, period.to);
  const span = `from ${monthName(period.from)} through ${monthName(period.to)}`;
  const target = deps.target;
  // The cleared offenses are the crime with a clearance filter (a cleared status, as the file has it): the `_cleared` measure is a catalog
  // name the compiler has no definition for.
  const clearedFilter: NibrsPlan["filters"][number] = { kind: "attribute", op: "in", dimension: "offense.clearance_status", values: ["cleared"] };
  const sub = (m: Measure, extra: NibrsPlan["filters"] = []): NibrsPlan => ({ ...plan, measures: [{ ...m, filters: undefined }], filters: [...plan.filters, ...(m.filters ?? []), ...extra], transforms: [],
    groupings: [{ dimension: "time.month", unknown: "visible", absent: "show" }], statistics: [{ kind: "count", as: "n", measure: m.as }] });

  // The agencies counted: the one agency, or a state's or the nation's header agencies (state-sum.ts).
  const where = place.kind === "national" ? "the United States" : place.kind === "state" ? stateName(place.code) : place.label;
  const Where = place.kind === "national" ? "United States" : where;
  const year = Number(period.from.slice(0, 4));
  const header = place.kind === "agency" ? [] : deps.execute(agencyHeaderSql(target.root, universeStates(place), [year]));
  const oris = place.kind === "agency" ? [place.ori] : [...new Set(header.map((r) => String(r[0])))];
  if (!oris.length) return decline(`No agency in ${where} has a header in the data for ${when}.`);
  const withHeader = new Set(oris);

  // The monthly grid of the agencies (one agency, or a state's or the nation's), as state-sum.ts reads it: a month reported as zero is a
  // reported month, and an agency's every month is known or named.
  const compile = (p: NibrsPlan) => compilePlan(p, { kind: "absolute", ...period }, { ...target, agencies: oris });
  const cAll = compile(sub(all)), cCleared = compile(sub({ ...cleared, id: cleared.id.replace(/_cleared$/, "") }, [clearedFilter]));
  if (cAll.kind === "unsupported") return decline(NOT_YET, cAll.reason);
  if (cCleared.kind === "unsupported") return decline(NOT_YET, cCleared.reason);
  // The plan's own statements: the cleared grid's clearance statement belongs to a plan that filters by clearance, and this plan (the ratio of
  // two named measures) does not; the answer says nothing of the file's clearance rule (Jeff: "That's it").
  for (const s of cAll.query.statements) if (!statements.includes(s)) statements.push(s);
  const clearedSql = cCleared.query.sql;

  // Per agency: the months in the span, the months with crimes reported (VALUE), the months reported at all (VALUE or REPORTED_ZERO),
  // and the sum of the reported months.
  // (The same query as state-sum.ts's coverage read: ori, year, months, months reported, their sum, conflicts, months with crimes.)
  const perAgency = (sql: string) => new Map(deps.execute(`SELECT ori, CAST(substr(period, 1, 4) AS INTEGER) AS y, count(*) AS months,
      count(*) FILTER (WHERE n_status IN ('VALUE', 'REPORTED_ZERO')) AS rep,
      coalesce(sum(n) FILTER (WHERE n_status IN ('VALUE', 'REPORTED_ZERO')), 0) AS repsum,
      count(*) FILTER (WHERE n_status = 'EVIDENCE_CONFLICT') AS conflicts,
      count(*) FILTER (WHERE n_status = 'VALUE') AS val
    FROM (${sql}) GROUP BY ALL`).map((r) => [String(r[0]), { months: Number(r[2]), rep: Number(r[3]), sum: Number(r[4]), val: Number(r[6]) }]));
  const gAll = perAgency(cAll.query.sql), gCleared = perAgency(cCleared.query.sql);
  const span0 = monthsOf(period.from, period.to).length;

  if (place.kind === "agency") {
    // Every month reported: a month with no report is named, and no rate is given (P58).
    const a = gAll.get(place.ori), c = gCleared.get(place.ori);
    if (!a || a.rep < span0) {
      const missing = deps.execute(`SELECT ori, period, n, n_status FROM (${cAll.query.sql}) ORDER BY period`)
        .filter((r) => !["VALUE", "REPORTED_ZERO"].includes(String(r[3]))).map((r) => String(r[1]).slice(0, 7));
      const named = missing.length ? runs(missing) : when;
      return decline(`No clearance rate is given: no data is known for ${named}.`);
    }
    if (!c || c.rep < span0) return decline(`No clearance rate is given: no data is known for ${when}.`);
    if (!a.sum) return decline(`No clearance rate is given: no ${words} were reported in ${when}.`);
    return deliver(c.sum, a.sum, [`${Where}: ${rateOf(c.sum, a.sum)}% of ${words} reported in ${when} were cleared.`]);
  }

  // A state or the nation: the Consistent Reporting Agencies, one set for both figures.
  const set = oris.filter((o) => withHeader.has(o) && gAll.get(o)?.val === gAll.get(o)?.months && gAll.get(o)!.months === span0 && gCleared.get(o)?.rep === span0);
  if (!set.length) return decline(`No agency reported crimes in every month ${span}, so there are no Consistent Reporting Agencies for ${Where}.`);
  const den = set.reduce((n, o) => n + gAll.get(o)!.sum, 0), num = set.reduce((n, o) => n + gCleared.get(o)!.sum, 0);
  if (!den) return decline(`No clearance rate is given: no ${words} were reported in ${when}.`);
  return deliver(num, den, [`${Where}: ${rateOf(num, den)}% of ${words} reported in ${when} were cleared, counting only the ${fmt(set.length)} Consistent Reporting Agencies that reported every month ${span}.`]);

  function rateOf(n: number, d: number): string { return String(Math.round((1000 * n) / d) / 10); }
  function deliver(n: number, d: number, lines: string[]): ShadowOutcome {
    const value = Math.round((1000 * n) / d) / 10;
    const header0 = `${words[0].toUpperCase()}${words.slice(1)} cleared (%)`;
    const delivered = deliverTable(plan, null, { as: stat.as, header: header0 }, [{ key: null, value, status: "VALUE" }], lines, statements, deps.release.id, readings);
    if (delivered.contractProblems.length) return decline(NOT_YET, `answer contract: ${delivered.contractProblems.join("; ")}`);
    // Jeff's answer, whole: the sentence (with the Consistent Reporting Agencies line for a state or the nation) and the source.
    const text = [...lines, "Source: NIBRS."];
    return { kind: "answer", plan, period, sql: clearedSql, delivered: { ...delivered, text, headline: text[0] } };
  }
}
