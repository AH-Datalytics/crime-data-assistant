/**
 * What share of a crime's clearances (or offenses) were of one clearance type, for a state or the nation (P195, Jeff 2026-11-21):
 *
 *   "give me the share of all rape clearances that were prosecution declined in 2025"   a share of the clearances
 *   "what share of murders were cleared by exception in 2025"                           a share of the offenses
 *   "... by state"                                                                      a row for each state
 *
 * The figures are the clearance-by-type sums (state-sum.ts's grid, P171): the offenses of the agencies that reported, by clearance type,
 * each agency counting the months it reported. A clearance is an arrest or an exceptional clearance (A to E); a share of the clearances
 * divides by those, a share of the offenses divides by every offense (not cleared included).
 */
import type { NibrsPlan } from "../nibrs-plan/plan";
import { compilePlan, NO_CATEGORY } from "../nibrs-plan/compile";
import type { AnswerStatement } from "../nibrs-plan/result";
import type { ShareSpec } from "../nibrs-question-types";
import { postalState } from "../nibrs-plan/state-codes";
import { deliverTable, fmt, periodWords } from "./deliver";
import { stateName } from "./places";
import { agencyHeaderSql, universeStates } from "./state-sum";
import { NOT_YET } from "./wording";
import type { ShadowDeps, ShadowOutcome } from "./answer";

type Decline = (explanation: string, detail?: string) => ShadowOutcome;
const EXCEPTIONAL = ["A", "B", "C", "D", "E"];
/** The clearance types a filter names, and the words for them (as a share of offenses, of clearances, and as a title). */
const TYPE_WORDS: Record<string, { types: string[]; ofOffenses: string; ofClearances: string; title: string }> = {
  "clearance:arrest": { types: ["arrest"], ofOffenses: "cleared by arrest", ofClearances: "by arrest", title: "Cleared by Arrest" },
  "clearance:exceptional": { types: EXCEPTIONAL, ofOffenses: "cleared by exceptional means", ofClearances: "by exceptional means", title: "Cleared by Exceptional Means" },
  "clearance:A": { types: ["A"], ofOffenses: "cleared because the offender died", ofClearances: "death of the offender", title: "Death of the Offender" },
  "clearance:B": { types: ["B"], ofOffenses: "cleared because prosecution was declined", ofClearances: "prosecution declined", title: "Prosecution Declined" },
  "clearance:C": { types: ["C"], ofOffenses: "cleared because the offender was in custody of another jurisdiction", ofClearances: "in custody of another jurisdiction", title: "In Custody of Another Jurisdiction" },
  "clearance:D": { types: ["D"], ofOffenses: "cleared because the victim refused to cooperate", ofClearances: "victim refused to cooperate", title: "Victim Refused to Cooperate" },
  "clearance:E": { types: ["E"], ofOffenses: "cleared with a juvenile and no custody", ofClearances: "juvenile, no custody", title: "Juvenile, No Custody" },
};

export function answerClearanceShare(plan: NibrsPlan, spec: ShareSpec, period: { from: string; to: string }, yearSet: number[] | null, deps: ShadowDeps,
  statements: AnswerStatement[], readings: string[], decline: Decline): ShadowOutcome {
  const place = plan.geography.places[0];
  const words = TYPE_WORDS[spec.subset[0]];
  if (!words || (place.kind !== "state" && place.kind !== "national") || plan.measures.length < 1)
    return decline("This isn't available: this share of clearances.");
  if (yearSet || period.from.slice(0, 4) !== period.to.slice(0, 4)) return decline("This isn't available: a share of clearances over several years. Ask for one year.");
  const byState = !!spec.byState && place.kind === "national";
  if (spec.byState && !byState) return decline("This isn't available: a share by state for one state.");
  const year = Number(period.from.slice(0, 4));
  const where = place.kind === "national" ? "the United States" : stateName(place.code);
  const when = periodWords(period.from, period.to);
  const crime = spec.measure.replace(/_/g, " ");
  const crimes = /y$/.test(crime) ? crime : `${crime}s`;
  const base = { ...plan.measures[0], id: plan.measures[0].id.replace(/_cleared$/, ""), as: plan.measures[0].as.replace(/_cleared$/, "") };

  // The agencies (those with a header in the place that year) and each one's state.
  const header = deps.execute(agencyHeaderSql(deps.target.root, universeStates(place), [year]));
  const oris = [...new Set(header.map((r) => String(r[0])))];
  if (!oris.length) return decline(`No agency in ${where} has a header in the data for ${when}.`);
  const stateOf = new Map(header.map((r) => [String(r[0]), postalState(String(r[3]))]));
  const sub: NibrsPlan = { ...plan, measures: [{ ...base, filters: undefined }], filters: [], transforms: [],
    groupings: [{ dimension: "time.month", unknown: "visible", absent: "show" }, { dimension: "offense.clearance_type", unknown: "visible", absent: "show" }],
    statistics: [{ kind: "count", as: "n", measure: base.as }] };
  const c = compilePlan(sub, { kind: "absolute", ...period }, { ...deps.target, agencies: oris });
  if (c.kind === "unsupported") return decline(NOT_YET, c.reason);
  for (const s of c.query.statements) if (!statements.includes(s)) statements.push(s);
  // Each agency's months reported and its sum by clearance type (the grid is evaluated once).
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
  const reported = new Set(both.filter((r) => r[0] === "c" && Number(r[4]) > 0).map((r) => String(r[1])));
  type Bucket = { agencies: number; offenses: number; byType: Map<string, number> };
  const buckets = new Map<string, Bucket>();
  const bucketOf = (ori: string) => { const k = byState ? stateOf.get(ori) ?? "" : ""; return buckets.get(k) ?? buckets.set(k, { agencies: 0, offenses: 0, byType: new Map() }).get(k)!; };
  for (const r of both.filter((x) => x[0] === "c")) if (reported.has(String(r[1])) && oris.includes(String(r[1]))) { const b = bucketOf(String(r[1])); b.agencies++; b.offenses += Number(r[5] ?? 0); }
  for (const r of both.filter((x) => x[0] === "s")) if (reported.has(String(r[1]))) { const b = bucketOf(String(r[1])); b.byType.set(String(r[8]), (b.byType.get(String(r[8])) ?? 0) + Number(r[3] ?? 0)); }
  const figures = (b: Bucket) => {
    const sum = (ks: string[]) => ks.reduce((n, k) => n + (b.byType.get(k) ?? 0), 0);
    const cleared = sum(["arrest", ...EXCEPTIONAL]);
    const denominator = spec.denominator === "clearances" ? cleared : b.offenses;
    const part = sum(words.types);
    return { part, denominator, value: denominator ? Math.round((1000 * part) / denominator) / 10 : null };
  };
  const Crime = `${crimes[0].toUpperCase()}${crimes.slice(1)}`;
  const share = spec.denominator === "clearances" ? `${Crime} Clearances That Were ${words.title}` : `${Crime} ${words.title}`;
  const phrase = spec.denominator === "clearances" ? `of the ${crime} clearances were ${words.ofClearances}` : `of the ${crimes} reported were ${words.ofOffenses}`;
  const denomWord = spec.denominator === "clearances" ? "Clearances" : "Offenses";

  if (!byState) {
    const b = buckets.get("");
    if (!b || !b.agencies) return decline(`No agency in ${where} reported crimes in ${when}.`);
    const f = figures(b);
    if (!f.denominator) return decline(`No share is given: no ${spec.denominator === "clearances" ? `${crime} clearances` : crimes} were reported in ${when}.`);
    const lines = [`In ${where} in ${when}, ${f.value}% ${phrase}, summed over the ${fmt(b.agencies)} agencies that reported.`, "Includes all agencies."];
    const delivered = deliverTable(plan, null, { as: "share", header: `${share} (%)` }, [{ key: null, value: f.value, status: "VALUE" }], lines, statements, deps.release.id, readings);
    if (delivered.contractProblems.length) return decline(NOT_YET, `answer contract: ${delivered.contractProblems.join("; ")}`);
    const text = [...lines, "Source: NIBRS."];
    return { kind: "answer", plan, period, sql: c.query.sql, delivered: { ...delivered, text, headline: text[0] } };
  }

  // By state: a row for each state with an agency that reported, in alphabetical order; a state with no share (nothing to divide) is blank.
  const states = [...buckets.entries()].filter(([k, b]) => k && b.agencies).sort((a, b) => stateName(a[0]).localeCompare(stateName(b[0])));
  if (!states.length) return decline(`No agency reported ${crimes} in ${when}.`);
  const rows = states.map(([k, b]) => { const f = figures(b); return { key: stateName(k), value: f.value, status: f.value === null ? "UNAVAILABLE" : "VALUE" }; });
  const lines = [`Share of ${share} (%) by State, ${year}`,
    `Each share is ${spec.denominator === "clearances" ? `the ${crime} clearances that were ${words.ofClearances}, out of all ${crime} clearances` : `the ${crimes} ${words.ofOffenses}, out of all ${crimes} reported`}, summed over the agencies that reported in ${when}.`,
    "Includes all agencies."];
  const plan2: NibrsPlan = { ...plan, statistics: [...plan.statistics, { kind: "count", as: "denominator", measure: base.as }, { kind: "agencies", as: "agencies", measure: base.as }] };
  const delivered = deliverTable(plan2, { dimension: "geo.state", header: "State" }, { as: "share", header: "Share (%)" }, rows, lines, statements, deps.release.id, readings,
    [{ as: "denominator", header: denomWord, cells: states.map(([, b]) => ({ value: figures(b).denominator, status: "VALUE" })) },
      { as: "agencies", header: "Agencies reporting", cells: states.map(([, b]) => ({ value: b.agencies, status: "VALUE" })) }]);
  if (delivered.contractProblems.length) return decline(NOT_YET, `answer contract: ${delivered.contractProblems.join("; ")}`);
  const text = [...lines, "Source: NIBRS."];
  return { kind: "answer", plan: plan2, period, sql: c.query.sql, delivered: { ...delivered, text, headline: text[0] } };
}
