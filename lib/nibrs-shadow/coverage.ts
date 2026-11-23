/**
 * Questions about the data itself (Jeff 2026-11-18, group 3 of the 11-11 list): how many agencies reported, which states
 * are not represented, which years are covered, where the numbers come from, and where terms are defined. The first three
 * are computed from the canonical release's agency lists (agency_year: the FBI's agency list by year and state;
 * agency_month_status: REPORTED_CRIMES or REPORTED_ZERO means the agency reported that month), the same files the cubes and
 * the scorecard read. The last two are a plain pointer: written definitions are never given (Jeff: "nothing written out"),
 * only the link to the FBI Crime Data Explorer.
 *
 * An agency counts as reporting a year when it reported at least one month of it; the count of agencies that reported every
 * month is shown beside it.
 */
import type { ResultTable } from "../nibrs-plan/result";
import { fmt, monthName } from "./deliver";
import { STATE_NAMES } from "./places";

export const COVERAGE_SOURCE = "Source: FBI NIBRS.";
/** The one constant Jeff chose for definitions (2026-11-18). */
export const DEFINITIONS_LINK = "https://cde.ucr.cjis.gov/";

export type CoverageShape = "agencies" | "states" | "years" | "sources" | "definitions" | "scope";
/** `topic` is set on a "scope" question only: which fixed statement it gets. */
export type ScopeTopic = "country" | "shootings" | "place";
export type CoverageQuestion = { shape: CoverageShape; state: string | null; from: number | null; to: number | null; byYear: boolean; topic?: ScopeTopic };
export type CoverageAnswer = {
  kind: "coverage"; shape: CoverageShape; period: { from: string; to: string };
  meaning: { source: "nibrs"; places: unknown[]; filters: string[]; measures: { name: string; unit: string }[]; period: { from: string; to: string }; groupings: string[]; statistic: "count" };
  delivered: { table: ResultTable; text: string[] };
  read: { table: string; release: string };
};
export type CoverageRelease = { id: string; firstMonth: string; lastMonth: string };
export type CoverageDeps = { root: string; release: CoverageRelease; execute(sql: string): unknown[][]; crimeIndexYears?: { first: number; last: number } | null };

/** Jeff 2026-11-14: the shootings ask, as the user reads it (also the answer to "do you track shootings"). */
export const SHOOTING_STATEMENT = "We don't track non-fatal shootings. You can choose firearm murders or aggravated assault involving a firearm (NIBRS).";
/** The statements of the "scope" shape: fixed words, no count and no agency list behind them. */
const SCOPE_TEXT: Record<ScopeTopic, { title: string; lines: string[] }> = {
  country: { title: "Where the Data Covers", lines: ["The data covers the United States."] },
  shootings: { title: "Shootings Data", lines: [SHOOTING_STATEMENT] },
  place: { title: "Data for a Place", lines: ["Name a crime, a place and a period to see its figures, for example \"murders in New York City in 2024\"."] },
};

/** Other places the FBI's list holds beside the states and the District of Columbia. */
const OTHER_PLACES: Record<string, string> = { GM: "Guam", PR: "Puerto Rico", VI: "U.S. Virgin Islands", CZ: "Canal Zone", MP: "Northern Mariana Islands", AS: "American Samoa" };
/** The FBI writes Nebraska as NB in agency lists (its ORI prefix too); every other state is its postal code. */
const postal = (code: string) => (code === "NB" ? "NE" : code);
const STATE_BY_NAME =new Map(Object.entries(STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]));

/** A state named in the question, as its code (longest name first, so "West Virginia" is never "Virginia"). */
function stateIn(q: string): string | null {
  const t = q.toLowerCase();
  for (const name of [...STATE_BY_NAME.keys()].sort((a, b) => b.length - a.length)) if (new RegExp(`\\b${name}\\b`).test(t)) return STATE_BY_NAME.get(name)!;
  return null;
}

const NOT_REPORTING = String.raw`(?:not\s+(?:represented|included|covered|in\s+(?:the\s+|this\s+)?data(?:\s*set)?)|aren'?t\s+(?:represented|included|covered|in\s+(?:the\s+|this\s+)?data(?:\s*set)?)|(?:are|is)\s+missing|have\s+no\s+(?:nibrs\s+)?data|without\s+(?:nibrs\s+)?data|missing\s+from)`;
const DEFINED = /\bhow\s+(?:is|are|do\s+you\s+define|does\s+(?:nibrs|the\s+fbi|ucr)\s+define)\b.*\bdef[ia]n\w*\b|\bwhat\s+(?:is|are)\s+(?:the\s+)?def[ia]n\w+\s+of\b|\bdef[ia]nitions?\s+(?:of|please)\b|\bwhat\s+(?:is|are)\s+defined\s+as\b|\bwhat\s+(?:counts\s+as|constitutes)\b/i;

/**
 * The question about the data the words ask, or null (the question is a figure, a place and a period, or something else).
 * `hasMeasure` / `hasPlace`: whether the reader finds a crime, or a place other than a state, in it ("how many agencies reported
 * murders in Texas in 2024" is a figure with its own reading; "how many murders occurred in Colorado" is not a coverage question).
 */
export function readCoverage(question: string, hasMeasure: boolean, hasPlace: boolean): CoverageQuestion | null {
  const t = question.trim();
  const one = (shape: CoverageShape, extra: Partial<CoverageQuestion> = {}): CoverageQuestion => {
    const years = t.match(/\b(?:19|20)\d{2}\b/g) ?? [];
    const y = years.length === 1 ? Number(years[0]) : null;
    return { shape, state: stateIn(t), from: y, to: y, byYear: !y, ...extra };
  };
  // Where the numbers come from.
  if (/^\s*sources?\s*[?.!]*\s*$/i.test(t)
    || /\bwhere\s+(?:is|does|do|did|are|can\s+i\s+find)\s+(?:this|that|the|these|those|your)\s+(?:data(?:\s*set)?|numbers|figures|information|stats|statistics)\s+(?:come\s+from|(?:been\s+)?(?:taken|sourced|coming)\b|from\b)/i.test(t)
    || /\bwhat\s+(?:is|are)\s+(?:the\s+|your\s+)?sources?\b(?:\s+(?:of|for)\s+(?:this|the|your)\s+(?:data(?:\s*set)?|numbers|figures))?\s*[?.!]*\s*$/i.test(t)
    || /\bwhere\s+(?:is|does)\s+(?:this|the)\s+data\s+(?:come\s+from|taken\s+from)/i.test(t))
    return one("sources");
  // Where a term is defined: one plain question about the term, nothing else asked with it.
  // A question about how a definition changed ("any legal change of the definition of robbery historically") is not a plain definition: a link
  // does not say whether it changed, so it keeps its old reading.
  const ABOUT_CHANGE = /\b(?:chang\w*|histor\w*|legal(?:ly)?|over\s+time|evolv\w*|used\s+to|revis\w*|updat\w*|amend\w*|ever)\b/i;
  if (DEFINED.test(t) && !ABOUT_CHANGE.test(t) && !hasPlace && (t.match(/\?/g) ?? []).length <= 1 && !/\b(?:and|also)\s+(?:show|give|can|how\s+many)\b|\bcan\s+you\s+show\b/i.test(t) && t.split(/\s+/).length <= 16)
    return one("definitions");
  // Whether the data has a thing: a country, shootings, or "any data" for a place. A short plain ask with no crime counted and no year.
  const bare = t.replace(/[?.!\s]+$/, "");
  const scope = (topic: ScopeTopic, state: string | null = null) => one("scope", { topic, state, from: null, to: null, byYear: false });
  if (/^which\s+countr(?:y|ies)\s+(?:do\s+you\s+|does\s+(?:this|the)\s+\w+\s+)?(?:cover|include|have)$/i.test(bare)) return scope("country");
  if (/\bshootings?\b/i.test(bare) && !/\d/.test(bare) && bare.split(/\s+/).length <= 10
    && /^(?:(?:do|does)\s+(?:you|we)\s+(?:have|track)\b|do\s+we\s+have\s+any\s+dataset\s+that\s+can\s+do\b)/i.test(bare)) return scope("shootings");
  if (!/\d/.test(bare) && bare.split(/\s+/).length <= 9
    && /^(?:do\s+you\s+have\s+(?:any\s+)?data|is\s+there\s+(?:any\s+)?data)\s+(?:specific\s+)?(?:for|to|in)\s+[a-z][a-z .'-]*$/i.test(bare)) return scope("place", stateIn(bare));
  if (hasMeasure || hasPlace) return null;
  // Agencies reporting.
  if (/\bhow\s+many\s+(?:law\s+enforcement\s+)?agen\w*\s+(?:have\s+|has\s+)?(?:reported|report|reporting|submit\w*|send\w*|contribut\w*|participat\w*|are\s+(?:in|included)|in\s+(?:the|this)\s+data)\b/i.test(t))
    return one("agencies");
  // States not represented.
  if (new RegExp(String.raw`\b(?:which|what)\s+states?\b[^?]*\b${NOT_REPORTING}`, "i").test(t)) return one("states", { state: null });
  // Years covered.
  if (/\b(?:what|which)\s+years\b[^?]*\b(?:cover\w*|available|included|in\s+(?:the|this)\s+data(?:\s*set)?)\b/i.test(t)
    || /\bhow\s+far\s+back\s+(?:does|do|is|are)\s+(?:the|this|your)\s+data\b/i.test(t))
    return one("years", { state: null, from: null, to: null, byYear: false });
  return null;
}

const ams = (root: string) => `read_parquet('${root.replace(/'/g, "''")}/agency_month_status/data_year=*/data.parquet', hive_partitioning = true)`;
const ay = (root: string) => `read_parquet('${root.replace(/'/g, "''")}/agency_year/**/*.parquet', hive_partitioning = 1)`;
const REPORTED = "status IN ('REPORTED_CRIMES', 'REPORTED_ZERO')";
const years = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const lastYearOf = (r: CoverageRelease) => Number(r.lastMonth.slice(0, 4));
const firstYearOf = (r: CoverageRelease) => Number(r.firstMonth.slice(0, 4));
const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0] ?? "");
const stat = (as: string, header: string) => ({ binding: { kind: "statistic" as const, as }, header });
/** A column of words (names, links): a grouping, so no chart is offered for it. */
const txt = (dimension: string, header: string) => ({ binding: { kind: "grouping" as const, dimension }, header });

export function answerCoverage(cq: CoverageQuestion, d: CoverageDeps): CoverageAnswer {
  const firstY = firstYearOf(d.release), lastY = lastYearOf(d.release), lastM = Number(d.release.lastMonth.slice(5, 7));
  // An answer with no period of its own (a pointer, a year outside the data) carries the release's span.
  const span0 = { from: d.release.firstMonth, to: d.release.lastMonth };
  const meaning = (name: string, period: { from: string; to: string } | null, groupings: string[], places: unknown[] = []) =>
    ({ source: "nibrs" as const, places, filters: [], measures: [{ name, unit: "agency" }], period: period ?? span0, groupings, statistic: "count" as const });
  const read = { table: "agency_year + agency_month_status", release: d.release.id };

  if (cq.shape === "agencies") {
    const [a, b] = cq.from ? [cq.from, cq.to!] : [firstY, lastY];
    if (a < firstY || b > lastY) {
      // A year outside the release: said, with the years held.
      const text = [`${a} Agencies Reporting NIBRS Data`, `This data covers ${firstY} through ${lastY}, so ${a} is not included.`, COVERAGE_SOURCE];
      return { kind: "coverage", shape: "agencies", period: span0, meaning: meaning("agencies reporting", null, []), delivered: { table: { columns: [stat("agencies", "Agencies reporting")], rows: [] }, text }, read };
    }
    const place = cq.state ? STATE_NAMES[cq.state] : "United States";
    const stateFilter = cq.state ? `WHERE data_year BETWEEN ${a} AND ${b} AND state_abbr IN ('${cq.state}'${cq.state === "NE" ? ", 'NB'" : ""})` : `WHERE data_year BETWEEN ${a} AND ${b}`;
    const rows = d.execute(`WITH s AS (SELECT DISTINCT data_year, ori FROM ${ay(d.root)} ${stateFilter}), `
      + `r AS (SELECT data_year, ori, count(DISTINCT month) AS m FROM ${ams(d.root)} WHERE ${REPORTED} AND data_year BETWEEN ${a} AND ${b} GROUP BY 1, 2) `
      + `SELECT s.data_year, count(*), count(r.ori), count(*) FILTER (WHERE r.m >= CASE WHEN s.data_year = ${lastY} THEN ${lastM} ELSE 12 END) `
      + `FROM s LEFT JOIN r ON r.ori = s.ori AND r.data_year = s.data_year GROUP BY 1 ORDER BY 1`);
    const byYear = new Map(rows.map((r) => [Number(r[0]), { listed: Number(r[1]), any: Number(r[2]), all: Number(r[3]) }]));
    const ys = years(a, b).filter((y) => byYear.has(y));
    const header = (y: number) => (y === lastY && lastM < 12 ? `Agencies reporting every month so far` : `Agencies reporting all 12 months`);
    const where = place;
    const text: string[] = [];
    if (ys.length === 1) {
      const y = ys[0], c = byYear.get(y)!;
      const everyMonth = y === lastY && lastM < 12 ? `every month from January through ${monthName(d.release.lastMonth).split(" ")[0]}` : "all 12 months";
      text.push(`${y} Agencies Reporting NIBRS Data, ${where}`,
        `${fmt(c.any)} of the ${fmt(c.listed)} agencies in the FBI's agency list${cq.state ? ` for ${place}` : ""} reported at least one month in ${y}.`,
        `${fmt(c.all)} of them reported ${everyMonth}.`,
        "An agency reports a month when it sends crime counts or says it had none.", COVERAGE_SOURCE);
      return { kind: "coverage", shape: "agencies", period: { from: `${y}-01`, to: `${y}-12` }, meaning: meaning("agencies reporting", { from: `${y}-01`, to: `${y}-12` }, [], [cq.state ?? "national"]),
        delivered: { table: { columns: [stat("any", "Agencies reporting"), stat("all", header(y)), stat("listed", "Agencies in the FBI's list")], rows: [[c.any, c.all, c.listed]] }, text }, read };
    }
    text.push(`${a} to ${b} Agencies Reporting NIBRS Data by Year, ${where}`,
      `Each year shows the agencies in the FBI's agency list${cq.state ? ` for ${place}` : ""} that reported at least one month, and how many reported every month.`,
      "An agency reports a month when it sends crime counts or says it had none.",
      ...(b === lastY && lastM < 12 ? [`${lastY} runs through ${monthName(d.release.lastMonth)}, so "every month" means January through ${monthName(d.release.lastMonth).split(" ")[0]}.`] : []), COVERAGE_SOURCE);
    return { kind: "coverage", shape: "agencies", period: { from: `${a}-01`, to: `${b}-12` }, meaning: meaning("agencies reporting", { from: `${a}-01`, to: `${b}-12` }, ["year"], [cq.state ?? "national"]),
      delivered: { table: { columns: [{ binding: { kind: "grouping", dimension: "time.year" }, header: "Year" }, stat("any", "Agencies reporting"), stat("all", "Agencies reporting every month"), stat("listed", "Agencies in the FBI's list")],
        rows: ys.map((y) => { const c = byYear.get(y)!; return [String(y), c.any, c.all, c.listed]; }) }, text }, read };
  }

  if (cq.shape === "states") {
    // The latest full year ends the table; a year named is shown alone.
    const lastFull = lastM === 12 ? lastY : lastY - 1;
    const [a, b] = cq.from ? [cq.from, cq.to!] : [firstY, lastFull];
    if (a < firstY || b > lastY) {
      const text = [`${a} States With No NIBRS Data`, `This data covers ${firstY} through ${lastY}, so ${a} is not included.`, COVERAGE_SOURCE];
      return { kind: "coverage", shape: "states", period: span0, meaning: meaning("states with no data", null, []), delivered: { table: { columns: [stat("states", "States with no data")], rows: [] }, text }, read };
    }
    const have = d.execute(`WITH s AS (SELECT DISTINCT data_year, ori, state_abbr FROM ${ay(d.root)} WHERE data_year BETWEEN ${a} AND ${b}), `
      + `r AS (SELECT DISTINCT data_year, ori FROM ${ams(d.root)} WHERE ${REPORTED} AND data_year BETWEEN ${a} AND ${b}) `
      + `SELECT DISTINCT s.data_year, s.state_abbr FROM s JOIN r ON r.ori = s.ori AND r.data_year = s.data_year`);
    const listed = d.execute(`SELECT DISTINCT data_year, state_abbr FROM ${ay(d.root)} WHERE data_year BETWEEN ${a} AND ${b}`);
    const reporting = new Map<number, Set<string>>(), inList = new Map<number, Set<string>>();
    for (const [y, s] of have) { if (!reporting.has(Number(y))) reporting.set(Number(y), new Set()); reporting.get(Number(y))!.add(postal(String(s))); }
    for (const [y, s] of listed) { if (!inList.has(Number(y))) inList.set(Number(y), new Set()); inList.get(Number(y))!.add(postal(String(s))); }
    const ys = years(a, b);
    const rows = ys.map((y) => {
      const got = reporting.get(y) ?? new Set<string>();
      const states = Object.keys(STATE_NAMES).filter((c) => !got.has(c)).map((c) => STATE_NAMES[c]).sort();
      const others = [...(inList.get(y) ?? [])].filter((c) => OTHER_PLACES[c] && !got.has(c)).map((c) => OTHER_PLACES[c]).sort();
      return { y, states, others };
    });
    const last = rows[rows.length - 1];
    const span = a === b ? String(a) : `${a} to ${b}`;
    const text = [`${a === b ? `${a} ` : ""}States With No NIBRS Data${a === b ? "" : ` by Year, ${span}`}`,
      "A state is listed in a year when none of its agencies reported any month.",
      last.states.length ? `In ${last.y} ${last.states.length > 1 ? `the states with no data are ${list(last.states)}` : `the one state with no data is ${last.states[0]}`}.` : `In ${last.y} every state and the District of Columbia has reporting agencies.`,
      ...(last.others.length ? [`${list(last.others.map((n) => (n === "U.S. Virgin Islands" ? "the U.S. Virgin Islands" : n)))} ${last.others.length > 1 ? "have" : "has"} no reporting agencies in ${last.y}.`] : []), COVERAGE_SOURCE];
    return { kind: "coverage", shape: "states", period: { from: `${a}-01`, to: `${b}-12` }, meaning: meaning("states with no data", { from: `${a}-01`, to: `${b}-12` }, ["year"]),
      delivered: { table: { columns: [{ binding: { kind: "grouping", dimension: "time.year" }, header: "Year" }, txt("coverage.states", "States with no data"), txt("coverage.others", "Other places with no data")],
        rows: rows.map((r) => [String(r.y), r.states.length ? r.states.join(", ") : "None", r.others.length ? r.others.join(", ") : "None"]) }, text }, read };
  }

  if (cq.shape === "years") {
    const ci = d.crimeIndexYears;
    const rows: (string | number | null)[][] = [["FBI NIBRS", monthName(d.release.firstMonth), monthName(d.release.lastMonth)]];
    const text = ["Years Covered by the Data", `NIBRS data runs from ${monthName(d.release.firstMonth)} through ${monthName(d.release.lastMonth)}.`];
    if (ci) { rows.push(["Crime Index", String(ci.first), String(ci.last)]); text.push(`Crime Index counts for a place and year run from ${ci.first} through ${ci.last}.`); }
    text.push(COVERAGE_SOURCE);
    return { kind: "coverage", shape: "years", period: { from: d.release.firstMonth, to: d.release.lastMonth }, meaning: meaning("years covered", { from: d.release.firstMonth, to: d.release.lastMonth }, []),
      delivered: { table: { columns: [txt("coverage.source", "Source"), txt("coverage.from", "From"), txt("coverage.through", "Through")], rows }, text }, read };
  }

  if (cq.shape === "sources") {
    const ci = d.crimeIndexYears;
    const text = ["Where the Numbers Come From",
      `Counts and rates for a place and year${ci ? `, ${ci.first} to ${ci.last},` : ""} come from Crime Index.`,
      `Victims, offenders, weapons, arrests and clearances by month, ${monthName(d.release.firstMonth)} to ${monthName(d.release.lastMonth)}, come from the FBI's NIBRS.`,
      "Homicide Reports come from the FBI's Supplementary Homicide Reports.",
      "Hate crimes come from FBI Hate Crime Statistics.",
      "Each answer ends with a Source line naming the one it used."];
    return { kind: "coverage", shape: "sources", period: span0, meaning: meaning("sources", null, []),
      delivered: { table: { columns: [txt("coverage.source", "Source"), txt("coverage.for", "Used for")], rows: [
        ["Crime Index", "Counts and rates for a place and year"], ["FBI NIBRS", "Victims, offenders, weapons, arrests and clearances by month"],
        ["FBI Supplementary Homicide Reports", "Homicide Reports"], ["FBI Hate Crime Statistics", "Hate crimes"]] }, text }, read };
  }

  if (cq.shape === "scope") {
    const sc = SCOPE_TEXT[cq.topic ?? "place"];
    return { kind: "coverage", shape: "scope", period: span0, meaning: meaning("scope", null, []),
      delivered: { table: { columns: [txt("coverage.statement", "Answer")], rows: [[sc.lines[0]]] }, text: [sc.title, ...sc.lines, COVERAGE_SOURCE] }, read };
  }

  const text = [`The FBI Crime Data Explorer defines these terms: ${DEFINITIONS_LINK}`, "Source: FBI Crime Data Explorer."];
  return { kind: "coverage", shape: "definitions", period: span0, meaning: meaning("definitions", null, []),
    delivered: { table: { columns: [txt("coverage.link", "Where the FBI defines these terms")], rows: [[DEFINITIONS_LINK]] }, text }, read };
}
