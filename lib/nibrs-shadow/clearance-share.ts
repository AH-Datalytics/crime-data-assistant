/**
 * What share of a crime's clearances (or offenses) were of one clearance type, for a state or the nation (P203, Jeff 2026-11-21):
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
import { deliverTable, deliverTable2, fmt, periodWords } from "./deliver";
import { agencyLabel, agencyName, stateName } from "./places";
import { agencyHeaderSql, universeStates } from "./state-sum";
import { NOT_YET } from "./wording";
import type { ShadowDeps, ShadowOutcome } from "./answer";

type Decline = (explanation: string, detail?: string) => ShadowOutcome;
/** The city agencies of the place index (ORI to "Houston, Texas"), for a ranking of cities (deps.cityShare). */
const CITY_LABELS = new WeakMap<object, Map<string, string>>();
function cityLabels(deps: ShadowDeps): Map<string, string> {
  const hit = CITY_LABELS.get(deps.places);
  if (hit) return hit;
  const m = new Map<string, string>();
  for (const list of deps.places.byName.values()) for (const a of list) if (a.kind === "city") m.set(a.ori, agencyLabel(a));
  CITY_LABELS.set(deps.places, m);
  return m;
}
const cityAgencies = (deps: ShadowDeps) => cityLabels(deps);
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
  // Several years are a row for each year, never pooled (Jeff 2026-11-22: "Virginia share of rapes cleared by exception, 2022-2025"); by state stays one year.
  const fromYear = Number(period.from.slice(0, 4)), toYear = Number(period.to.slice(0, 4));
  const years = yearSet ? [...yearSet].sort((a, b) => a - b) : Array.from({ length: toYear - fromYear + 1 }, (_, i) => fromYear + i);
  const byState = !!spec.byState && place.kind === "national";
  if (spec.byState && !byState) return decline("This isn't available: a share by state for one state.");
  // Several years by state are a block for each year, each ranked on its own (Jeff 2026-11-22); part of a year is still declined.
  if (byState && years.length > 1 && !(period.from.endsWith("-01") && period.to.endsWith("-12"))) return decline("This isn't available: a share by state over part of a year. Ask for whole years or one year.");
  const year = years[0];
  const where = place.kind === "national" ? "the United States" : stateName(place.code);
  const when = periodWords(period.from, period.to);
  const crime = spec.measure.replace(/_/g, " ");
  const crimes = /y$/.test(crime) ? crime : `${crime}s`;
  const base = { ...plan.measures[0], id: plan.measures[0].id.replace(/_cleared$/, ""), as: plan.measures[0].as.replace(/_cleared$/, "") };

  // The agencies (those with a header in the place that year) and each one's state.
  const header = deps.execute(agencyHeaderSql(deps.target.root, universeStates(place), years));
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
  // An agency counts in a year it reported any month; a year's figures are that year's agencies' (never pooled across years).
  const inYears = new Set(years);
  const reported = new Set(both.filter((r) => r[0] === "c" && Number(r[4]) > 0 && inYears.has(Number(r[2]))).map((r) => `${r[1]}|${r[2]}`));
  type Bucket = { agencies: number; offenses: number; byType: Map<string, number> };
  const buckets = new Map<string, Bucket>();
  // One bucket for each state (one year), or for each year.
  // City ranking (deps.cityShare): one bucket for each city agency instead of each state.
  const cityOris = deps.cityShare && byState ? cityAgencies(deps) : null;
  const bucketOf = (ori: string, y: number) => {
    if (cityOris && !deps.cityShare!.all && !cityOris.has(ori)) return null;
    const k = cityOris ? `${ori}|${y}` : byState ? `${stateOf.get(ori) ?? ""}|${y}` : String(y);
    return buckets.get(k) ?? buckets.set(k, { agencies: 0, offenses: 0, byType: new Map() }).get(k)!;
  };
  for (const r of both.filter((x) => x[0] === "c")) if (reported.has(`${r[1]}|${r[2]}`) && oris.includes(String(r[1]))) { const b = bucketOf(String(r[1]), Number(r[2])); if (b) { b.agencies++; b.offenses += Number(r[5] ?? 0); } }
  for (const r of both.filter((x) => x[0] === "s")) if (reported.has(`${r[1]}|${r[2]}`)) { const b = bucketOf(String(r[1]), Number(r[2])); b?.byType.set(String(r[8]), (b.byType.get(String(r[8])) ?? 0) + Number(r[3] ?? 0)); }
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

  if (!byState && years.length > 1) {
    // A row for each year: the share, what it divides, and the agencies reporting that year; a year with nothing to divide is blank.
    const rowsY = years.map((y) => { const b = buckets.get(String(y)); const f = b && b.agencies ? figures(b) : null; return { y, b, f }; });
    if (!rowsY.some((r) => r.f)) return decline(`No agency in ${where} reported ${crimes} in ${when}.`);
    const lines = [`${where === "the United States" ? "United States" : where} Share of ${share} (%) by Year, ${years[0]}-${years[years.length - 1]}`,
      `Each share is ${spec.denominator === "clearances" ? `the ${crime} clearances that were ${words.ofClearances}, out of all ${crime} clearances` : `the ${crimes} ${words.ofOffenses}, out of all ${crimes} reported`}, in the agencies that reported that year; the years are not added together.`,
      "Includes all agencies."];
    const timeGrouping = { dimension: "time.year", unknown: "visible" as const, absent: "show" as const };
    const planY: NibrsPlan = { ...plan, groupings: plan.groupings.some((g) => g.dimension === "time.year") ? plan.groupings : [...plan.groupings, timeGrouping],
      statistics: [...plan.statistics, { kind: "count", as: "denominator", measure: base.as }, { kind: "agencies", as: "agencies", measure: base.as }] };
    const delivered = deliverTable(planY, { dimension: "time.year", header: "Year" }, { as: "share", header: "Share (%)" },
      rowsY.map((r) => ({ key: String(r.y), value: r.f?.value ?? null, status: r.f && r.f.value !== null ? "VALUE" : "UNAVAILABLE" })), lines, statements, deps.release.id, readings,
      [{ as: "denominator", header: denomWord, cells: rowsY.map((r) => ({ value: r.f?.denominator ?? null, status: r.f ? "VALUE" : "UNAVAILABLE" })) },
        { as: "agencies", header: "Agencies reporting", cells: rowsY.map((r) => ({ value: r.b?.agencies ?? null, status: r.b?.agencies ? "VALUE" : "UNAVAILABLE" })) }]);
    if (delivered.contractProblems.length) return decline(NOT_YET, `answer contract: ${delivered.contractProblems.join("; ")}`);
    const text = [...lines, "Source: NIBRS."];
    return { kind: "answer", plan: planY, period, sql: c.query.sql, delivered: { ...delivered, text, headline: text[0] } };
  }
  if (!byState) {
    const b = buckets.get(String(year));
    if (!b || !b.agencies) return decline(`No agency in ${where} reported crimes in ${when}.`);
    const f = figures(b);
    if (!f.denominator) return decline(`No share is given: no ${spec.denominator === "clearances" ? `${crime} clearances` : crimes} were reported in ${when}.`);
    const lines = [`In ${where} in ${when}, ${f.value}% ${phrase}, summed over the ${fmt(b.agencies)} agencies that reported.`, "Includes all agencies."];
    const delivered = deliverTable(plan, null, { as: "share", header: `${share} (%)` }, [{ key: null, value: f.value, status: "VALUE" }], lines, statements, deps.release.id, readings);
    if (delivered.contractProblems.length) return decline(NOT_YET, `answer contract: ${delivered.contractProblems.join("; ")}`);
    const text = [...lines, "Source: NIBRS."];
    return { kind: "answer", plan, period, sql: c.query.sql, delivered: { ...delivered, text, headline: text[0] } };
  }

  // Cities ranked by the share (deps.cityShare): the city agencies with at least N of the crime reported that year (the only bound when N is named), or the
  // cities of 250,000 or more (P128) when no N is named; the highest share first, one year.
  if (cityOris) {
    const cs = deps.cityShare!;
    const labels = cityLabels(deps);
    const noun = cs.all ? "Agency" : "City", nouns = cs.all ? "agencies" : "cities";
    const popOf = new Map(header.map((r) => [`${r[0]}|${r[1]}`, Number(r[2] ?? 0)]));
    // Each year its own ranking, never pooled (P203/P173; Jeff 2026-11-22): the agencies that reported that year, those with at least N of the crime
    // (the only bound when N is named), else the cities of 250,000 or more.
    type CRow = { y: number; ori: string; name: string; b: Bucket; f: ReturnType<typeof figures> };
    const sign = cs.direction === "bottom" ? 1 : -1;
    const shownAll: CRow[] = [];
    for (const y of years) {
      const kept: CRow[] = [...buckets.entries()].filter(([k, b]) => b.agencies && Number(k.split("|")[1]) === y).map(([k, b]) => { const ori = k.split("|")[0]; return { y, ori, name: labels.get(ori) ?? agencyName(deps.places, ori), b, f: figures(b) }; })
        .filter((r) => r.f.value !== null && (cs.minOffenses !== null ? r.b.offenses >= cs.minOffenses : (popOf.get(`${r.ori}|${y}`) ?? 0) >= 250000));
      kept.sort((a, z) => sign * ((a.f.value as number) - (z.f.value as number)) || z.b.offenses - a.b.offenses || a.name.localeCompare(z.name));
      shownAll.push(...(cs.limit !== null ? kept.slice(0, cs.limit) : kept));
    }
    if (!shownAll.length) return decline(cs.minOffenses !== null ? `No ${noun.toLowerCase()} had at least ${cs.minOffenses} ${crimes} in ${when}.` : `No city of 250,000 or more reported ${crimes} in ${when}.`);
    const multiY = years.length > 1;
    const floorTitle = cs.minOffenses !== null ? "" : ", Population 250,000 or More";
    const lines = [`Share of ${share} (%) by ${noun}${floorTitle}, ${multiY ? `${years[0]}-${years[years.length - 1]}` : year}`,
      `Each share is ${spec.denominator === "clearances" ? `the ${crime} clearances that were ${words.ofClearances}, out of all ${crime} clearances` : `the ${crimes} ${words.ofOffenses}, out of all ${crimes} reported`} by the ${noun.toLowerCase()}'s agency in ${multiY ? "that year" : when}; the ${nouns} are ranked from the ${cs.direction === "bottom" ? "lowest" : "highest"} share${multiY ? " within each year, and the years are not added together" : ""}${cs.limit !== null ? `, the first ${cs.limit} of each shown` : ""}.`,
      cs.minOffenses !== null ? `Only ${nouns} with at least ${cs.minOffenses} ${crimes} reported in ${multiY ? "that year" : year} are ranked.` : "No city size was named, so the cities of 250,000 or more are ranked.", ...(cs.note ? [cs.note] : []), "Includes all agencies."];
    const plan2: NibrsPlan = { ...plan, groupings: [...plan.groupings.map((g) => (g.dimension === "geo.state" ? { ...g, dimension: "geo.agency" } : g)), ...(multiY && !plan.groupings.some((g) => g.dimension === "time.year") ? [{ dimension: "time.year", unknown: "visible" as const, absent: "show" as const }] : [])],
      statistics: [...plan.statistics, { kind: "count" as const, as: "denominator", measure: base.as }] };
    const supportsC = [{ as: "denominator", header: denomWord, cells: shownAll.map((r) => ({ value: r.f.denominator, status: "VALUE" })) }];
    const delivered = multiY
      ? deliverTable2(plan2, { dimension: "geo.agency", header: noun }, { dimension: "time.year", header: "Year" }, { as: "share", header: "Share (%)" }, shownAll.map((r) => ({ k1: r.name, k2: String(r.y), value: r.f.value, status: "VALUE" })), lines, statements, deps.release.id, readings, supportsC)
      : deliverTable(plan2, { dimension: "geo.agency", header: noun }, { as: "share", header: "Share (%)" }, shownAll.map((r) => ({ key: r.name, value: r.f.value, status: "VALUE" })), lines, statements, deps.release.id, readings, supportsC);
    if (delivered.contractProblems.length) return decline(NOT_YET, `answer contract: ${delivered.contractProblems.join("; ")}`);
    const text = [...lines, "Source: NIBRS."];
    return { kind: "answer", plan: plan2, period, sql: c.query.sql, delivered: { ...delivered, text, headline: text[0] } };
  }

  // By state (Jeff 2026-11-22): the states with an agency that reported, ranked by the share, highest first (a state with no share, nothing to divide, last);
  // over several years a block for each year, each ranked on its own, never pooled.
  type Row = { state: string; y: number; b: Bucket; f: ReturnType<typeof figures> };
  let all: Row[] = [...buckets.entries()].filter(([k, b]) => b.agencies && k.split("|")[0]).map(([k, b]) => ({ state: k.split("|")[0], y: Number(k.split("|")[1]), b, f: figures(b) }));
  const lowestFirst = (spec as { rank?: { dir: string } }).rank?.dir === "bottom";
  all.sort((a, z) => a.y - z.y || (a.f.value === null ? 1 : 0) - (z.f.value === null ? 1 : 0) || (lowestFirst ? 1 : -1) * ((a.f.value ?? 0) - (z.f.value ?? 0)) || stateName(a.state).localeCompare(stateName(z.state)));
  // "Top 5 states": only the first n of each year's ranking are shown (the reader's rank.n).
  const topN = (spec as { rank?: { n?: number | null } }).rank?.n ?? null;
  if (topN !== null && topN > 0) { const seen = new Map<number, number>(); all = all.filter((r) => { const k = (seen.get(r.y) ?? 0) + 1; seen.set(r.y, k); return k <= topN; }); }
  if (!all.length) return decline(`No agency reported ${crimes} in ${when}.`);
  const multi = years.length > 1;
  const rankedBy = `${lowestFirst ? "ranked from the lowest share to the highest" : "ranked from the highest share to the lowest"}${topN !== null && topN > 0 ? `, the first ${topN}${multi ? " of each year" : ""} shown` : ""}`;
  const lines = [`Share of ${share} (%) by State, ${multi ? `${years[0]}-${years[years.length - 1]}` : year}`,
    `Each share is ${spec.denominator === "clearances" ? `the ${crime} clearances that were ${words.ofClearances}, out of all ${crime} clearances` : `the ${crimes} ${words.ofOffenses}, out of all ${crimes} reported`}, summed over the agencies that reported in ${multi ? "that year" : when}; the states are ${rankedBy}${multi ? " within each year, and the years are not added together" : ""}.`,
    "Includes all agencies."];
  const statusOf = (r: Row) => (r.f.value === null ? "UNAVAILABLE" : "VALUE");
  const stats = [...plan.statistics, { kind: "count" as const, as: "denominator", measure: base.as }, { kind: "agencies" as const, as: "agencies", measure: base.as }];
  const supports = [{ as: "denominator", header: denomWord, cells: all.map((r) => ({ value: r.f.denominator, status: "VALUE" })) },
    { as: "agencies", header: "Agencies reporting", cells: all.map((r) => ({ value: r.b.agencies, status: "VALUE" })) }];
  if (!multi) {
    const plan2: NibrsPlan = { ...plan, statistics: stats };
    const delivered = deliverTable(plan2, { dimension: "geo.state", header: "State" }, { as: "share", header: "Share (%)" }, all.map((r) => ({ key: stateName(r.state), value: r.f.value, status: statusOf(r) })), lines, statements, deps.release.id, readings, supports);
    if (delivered.contractProblems.length) return decline(NOT_YET, `answer contract: ${delivered.contractProblems.join("; ")}`);
    const text = [...lines, "Source: NIBRS."];
    return { kind: "answer", plan: plan2, period, sql: c.query.sql, delivered: { ...delivered, text, headline: text[0] } };
  }
  const plan2: NibrsPlan = { ...plan, statistics: stats, groupings: plan.groupings.some((g) => g.dimension === "time.year") ? plan.groupings : [...plan.groupings, { dimension: "time.year", unknown: "visible" as const, absent: "show" as const }] };
  const delivered = deliverTable2(plan2, { dimension: "geo.state", header: "State" }, { dimension: "time.year", header: "Year" }, { as: "share", header: "Share (%)" },
    all.map((r) => ({ k1: stateName(r.state), k2: String(r.y), value: r.f.value, status: statusOf(r) })), lines, statements, deps.release.id, readings, supports);
  if (delivered.contractProblems.length) return decline(NOT_YET, `answer contract: ${delivered.contractProblems.join("; ")}`);
  const text = [...lines, "Source: NIBRS."];
  return { kind: "answer", plan: plan2, period, sql: c.query.sql, delivered: { ...delivered, text, headline: text[0] } };
}
