/**
 * Clearance by type for several named agencies (P194, Jeff 2026-11-21): one table, a row for each agency, never added together.
 *
 *   columns   the crime's offenses (P66's unit), cleared by arrest, cleared by exceptional means (the five exceptional types together),
 *             and not cleared
 *   rows      the agencies in the order the question names them; an agency with no reported month is a blank row, never zeros
 *   counted   each agency's reported months (a month reported as zero crimes counts), as for one agency (P64, P66, P67)
 *
 * One grid evaluation of the named agencies (compile.ts), read as state-sum.ts reads a state's: the months each reported, and each
 * agency's sum by clearance type.
 */
import type { NibrsPlan } from "../nibrs-plan/plan";
import { compilePlan, NO_CATEGORY } from "../nibrs-plan/compile";
import { ANSWER_STATEMENTS, type AnswerStatement } from "../nibrs-plan/result";
import { deliverTable, measureWords, periodWords } from "./deliver";
import { periodTitle, titleCase } from "./titles";
import { titleTimeframe } from "./headline";
import { NOT_YET } from "./wording";
import type { ShadowDeps, ShadowOutcome } from "./answer";

type Decline = (explanation: string, detail?: string) => ShadowOutcome;
const EXCEPTIONAL = ["A", "B", "C", "D", "E"];
const list = (xs: string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(", ");
const andList = (xs: string[]) => (xs.length > 2 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join(" and "));

export function answerClearanceTypePlaces(plan: NibrsPlan, period: { from: string; to: string }, deps: ShadowDeps, statements: AnswerStatement[],
  readings: string[], decline: Decline): ShadowOutcome {
  const agencies = plan.geography.places.flatMap((p) => (p.kind === "agency" ? [{ ori: p.ori, label: p.label }] : []));
  const m = plan.measures[0];
  if (plan.filters.some((f) => f.kind === "attribute" && f.dimension.startsWith("offense.clearance_")))
    return decline("This isn't available: clearance by type for several agencies with a clearance condition. Ask for each agency, or without the condition.");
  if (agencies.length < 2 || agencies.length !== plan.geography.places.length || plan.measures.length !== 1 || plan.groupings.some((g) => g.dimension !== "geo.place" && g.dimension !== "offense.clearance_type")
    || plan.transforms.length)
    return decline("This isn't available: this form of clearance for several agencies.");
  if (period.from.slice(0, 4) !== period.to.slice(0, 4)) return decline("This isn't available: clearance by type for several agencies over several years. Ask for one year.");
  const oris = agencies.map((a) => a.ori);
  const sub: NibrsPlan = { ...plan, measures: [{ ...m, filters: undefined }], filters: [...plan.filters, ...(m.filters ?? [])], transforms: [],
    groupings: [{ dimension: "time.month", unknown: "visible", absent: "show" }, { dimension: "offense.clearance_type", unknown: "visible", absent: "show" }],
    statistics: [{ kind: "count", as: "n", measure: m.as }] };
  const c = compilePlan(sub, { kind: "absolute", ...period }, { ...deps.target, agencies: oris });
  if (c.kind === "unsupported") return decline(NOT_YET, c.reason);
  // (The table shows the types as columns, so the plan has no clearance grouping and the two clearance statements are said below as lines.)
  // The months each agency reported and its sums by clearance type (the grid is evaluated once).
  const both = deps.execute(`WITH g AS MATERIALIZED (${c.query.sql}),
    m AS (SELECT ori, period, any_value(n_status) AS n_status, any_value(den) AS n FROM g GROUP BY ori, period),
    cov AS (SELECT ori, CAST(substr(period, 1, 4) AS INTEGER) AS y, count(*) AS months,
      count(*) FILTER (WHERE n_status IN ('VALUE', 'REPORTED_ZERO')) AS rep,
      coalesce(sum(n) FILTER (WHERE n_status IN ('VALUE', 'REPORTED_ZERO')), 0) AS repsum,
      count(*) FILTER (WHERE n_status = 'EVIDENCE_CONFLICT') AS conflicts,
      count(*) FILTER (WHERE n_status = 'VALUE') AS val FROM m GROUP BY ALL),
    cat AS (SELECT ori, CAST(substr(period, 1, 4) AS INTEGER) AS y, g0, sum(n) AS n FROM g
      WHERE n_status IN ('VALUE', 'REPORTED_ZERO') AND g0 IS DISTINCT FROM '${NO_CATEGORY}' GROUP BY ALL)
    SELECT 'c' AS part, ori, y, CAST(months AS BIGINT) AS a, CAST(rep AS BIGINT) AS b, CAST(repsum AS BIGINT) AS c, CAST(conflicts AS BIGINT) AS d, CAST(val AS BIGINT) AS e, CAST(NULL AS VARCHAR) AS g0, CAST(NULL AS BIGINT) AS ni FROM cov
    UNION ALL SELECT 's', ori, y, CAST(n AS BIGINT), NULL, NULL, NULL, NULL, g0, CAST(NULL AS BIGINT) FROM cat`);
  const cov = new Map<string, { months: number; rep: number; sum: number; conflicts: number }>();
  for (const r of both.filter((x) => x[0] === "c")) cov.set(String(r[1]), { months: Number(r[3]), rep: Number(r[4]), sum: Number(r[5]), conflicts: Number(r[6]) });
  const cats = new Map<string, Map<string, number>>();
  for (const r of both.filter((x) => x[0] === "s")) {
    const by = cats.get(String(r[1])) ?? cats.set(String(r[1]), new Map()).get(String(r[1]))!;
    by.set(String(r[8]), (by.get(String(r[8])) ?? 0) + Number(r[3] ?? 0));
  }
  const status = (ori: string) => { const a = cov.get(ori); return a && a.rep > 0 ? "VALUE" : "UNAVAILABLE"; };
  const cell = (ori: string, f: (by: Map<string, number>) => number) => (status(ori) === "VALUE" ? { value: f(cats.get(ori) ?? new Map()), status: "VALUE" } : { value: null, status: "UNAVAILABLE" });
  const rows = agencies.map((a) => ({ key: a.label, value: status(a.ori) === "VALUE" ? cov.get(a.ori)!.sum : null, status: status(a.ori) }));
  const what = measureWords(plan);
  const When = titleTimeframe(periodTitle(period, periodWords));
  const when = periodWords(period.from, period.to);
  const none = agencies.filter((a) => status(a.ori) !== "VALUE").map((a) => a.label);
  const partial = agencies.filter((a) => { const x = cov.get(a.ori); return x && x.rep > 0 && x.rep < x.months; });
  const lines = [`${titleCase(what)} by Agency and Clearance Type, ${When}`,
    `Each row is one agency, and the agencies are not added together. Counts are the offenses in the months each agency reported in ${when}.`];
  if (partial.length) lines.push(`${partial.length === 1 ? "This agency" : "These agencies"} reported only some months: ${partial.map((a) => `${a.label} (${cov.get(a.ori)!.rep} of ${cov.get(a.ori)!.months})`).join("; ")}.`);
  if (none.length) lines.push(`No data is available for ${andList(none)} in ${when}.`);
  lines.push(ANSWER_STATEMENTS.clearance_as_of_file, ANSWER_STATEMENTS.clearance_arrest_first);
  const plan2: NibrsPlan = { ...plan, groupings: [{ dimension: "geo.place", unknown: "visible", absent: "show" }],
    statistics: [{ kind: "count", as: "n", measure: m.as }, { kind: "count", as: "arrest", measure: m.as }, { kind: "count", as: "exceptional", measure: m.as }, { kind: "count", as: "none", measure: m.as }] };
  const delivered = deliverTable(plan2, { dimension: "geo.place", header: "Agency" }, { as: "n", header: `${what[0].toUpperCase()}${what.slice(1)}` }, rows, lines, statements, deps.release.id, readings,
    [{ as: "arrest", header: "Cleared by arrest", cells: agencies.map((a) => cell(a.ori, (by) => by.get("arrest") ?? 0)) },
      { as: "exceptional", header: "Cleared by exceptional means", cells: agencies.map((a) => cell(a.ori, (by) => EXCEPTIONAL.reduce((n, k) => n + (by.get(k) ?? 0), 0))) },
      { as: "none", header: "Not cleared", cells: agencies.map((a) => cell(a.ori, (by) => by.get("none") ?? 0)) }]);
  if (delivered.contractProblems.length) return decline(NOT_YET, `answer contract: ${delivered.contractProblems.join("; ")}`);
  const text = [...lines, "Source: NIBRS."];
  void list;
  return { kind: "answer", plan: plan2, period, sql: c.query.sql, delivered: { ...delivered, text, headline: text[0] } };
}
