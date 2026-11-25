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
import { STATE_NAMES, type PlaceIndex } from "./places";

export const COVERAGE_SOURCE = "Source: FBI NIBRS.";
/** The one constant Jeff chose for definitions (2026-11-18). */
export const DEFINITIONS_LINK = "https://cde.ucr.cjis.gov/";

export type CoverageShape = "agencies" | "states" | "years" | "sources" | "definitions" | "scope" | "shootings";
/** `lookup`: a scope question that names an agency, a county or a state ("What agencies match Dallas County in Texas?"). `term`: the one term a definitions question names that has an FBI definition on hand. */
export type CoverageLookup = { kind: "agency" | "county" | "state"; name: string; state?: string | null };
export type CoverageQuestion = { shape: CoverageShape; state: string | null; from: number | null; to: number | null; byYear: boolean; lookup?: CoverageLookup | null; term?: CoverageTerm | null; program?: "srs" | "nibrs" | null; ucr?: boolean };
export type CoverageTerm = "simple assault" | "violent crime" | "domestic violence" | "personal weapons" | "srs";
export type CoverageAnswer = {
  kind: "coverage"; shape: CoverageShape; period: { from: string; to: string };
  meaning: { source: "nibrs"; places: unknown[]; filters: string[]; measures: { name: string; unit: string }[]; period: { from: string; to: string }; groupings: string[]; statistic: "count" };
  delivered: { table: ResultTable; text: string[] };
  read: { table: string; release: string };
};
export type CoverageRelease = { id: string; firstMonth: string; lastMonth: string };
export type CoverageDeps = { root: string; release: CoverageRelease; execute(sql: string): unknown[][]; crimeIndexYears?: { first: number; last: number } | null; places?: PlaceIndex; /** The Crime Index build's folder (agency_crime.parquet): agency counts come from it, never from the fixture index. */ crimeIndexRoot?: string | null };

/** The 50 states: DC, Puerto Rico and the territories do not count as states (Jeff 2026-11-25). */
const FIFTY = Object.keys(STATE_NAMES).filter((c) => c !== "DC");
/** The one answer to "where does the data come from" (Jeff 2026-11-25), word for word. */
export const SOURCES_SENTENCE = "The data comes from the FBI's Uniform Crime Report NIBRS, SHR and SRS programs as well as the Crime Index";
/** FBI definitions on hand, as Jeff gave them (2026-11-25). A term not listed keeps the link to the FBI's definitions. */
export const VIOLENT_NIBRS = "In NIBRS, violent crime is murder and nonnegligent manslaughter (09A), rape (11A, 11B and 11C), robbery (120) and aggravated assault (13A).";
export const FBI_DEFINITIONS: Record<CoverageTerm, { title: string; text: string; source: string }> = {
  "domestic violence": { title: "Domestic Violence (NIBRS)", source: "Source: FBI NIBRS.",
    text: "NIBRS has no domestic violence offense. Domestic violence is recorded through the victim-to-offender relationship codes (spouse, boyfriend or girlfriend, parent, child and other family). It is not the same as Family Offenses, Nonviolent (90F)." },
  "personal weapons": { title: "Personal Weapons (NIBRS Weapon Code 40)", source: "Source: FBI NIBRS.",
    text: "Personal weapons are NIBRS weapon code 40: hands, fists, feet and teeth." },
  "srs": { title: "SRS (Summary Reporting System)", source: "Source: FBI SRS.",
    text: "SRS is the Summary Reporting System, the FBI's older summary reporting program. It is a program, not an offense." },
  "simple assault": { title: "Simple Assault (NIBRS Offense 13B)", source: "Source: FBI NIBRS.",
    text: "Simple Assault: An unlawful physical attack by one person upon another where neither the offender displays a weapon, nor the victim suffers obvious severe or aggravated bodily injury involving apparent broken bones, loss of teeth, possible internal injury, severe laceration, or loss of consciousness." },
  "violent crime": { title: "Violent Crime", source: "Source: FBI SRS.",
    text: "In the FBI's Summary Reporting System (SRS), violent crime is murder and nonnegligent manslaughter, rape, robbery and aggravated assault." },
};
/** The FBI writes Nebraska as NB in agency lists (its ORI prefix too); every other state is its postal code. */
const postal = (code: string) => (code === "NB" ? "NE" : code);
const STATE_BY_NAME = new Map(Object.entries(STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]));

/** A state named in the question, as its code (longest name first, so "West Virginia" is never "Virginia"). */
function stateIn(q: string): string | null {
  const t = q.toLowerCase();
  for (const name of [...STATE_BY_NAME.keys()].sort((a, b) => b.length - a.length)) if (new RegExp(`\\b${name}\\b`).test(t)) return STATE_BY_NAME.get(name)!;
  return null;
}

const NOT_REPORTING = String.raw`(?:not\s+(?:represented|included|covered|in\s+(?:the\s+|this\s+)?data(?:\s*set)?)|aren'?t\s+(?:represented|included|covered|in\s+(?:the\s+|this\s+)?data(?:\s*set)?)|(?:are|is)\s+missing|have\s+no\s+(?:nibrs\s+)?data|without\s+(?:nibrs\s+)?data|missing\s+from)`;
/** The agency, county or state a scope question names ("agency name for Nashville", "match Dallas County in Texas", "cities represented in Pennsylvania"). */
function lookupIn(t: string): CoverageLookup | null {
  const county = /\bagencies\s+match\s+(.+?)\s+county\b/i.exec(t);
  if (county) return { kind: "county", name: county[1].trim(), state: stateIn(t) };
  const agency = /\bagency\s+name\s+for\s+(.+?)\s+in\s+(?:the\s+)?(?:data|dataset)\b/i.exec(t);
  if (agency) return { kind: "agency", name: agency[1].trim(), state: stateIn(t) };
  const st = /\bwhich\s+(?:cities|agencies)\b/i.test(t) ? stateIn(t) : null;
  return st ? { kind: "state", name: st } : null;
}
/** The one term a definitions question names that has a definition on hand (a violent crime question that names SRS asks for violent crime). */
function termIn(t: string): CoverageTerm | null {
  if (/\bsimple\s+assault\b/i.test(t)) return "simple assault";
  if (/\bviolent\s+crime\b/i.test(t)) return "violent crime";
  if (/\bdomestic\s+violence\b|\bDV\b/.test(t)) return "domestic violence";
  if (/\bpersonal\s+weapons?\b/i.test(t)) return "personal weapons";
  if (/\bsrs\b/i.test(t)) return "srs";
  return null;
}
const DEFINED =/\bhow\s+(?:is|are|do\s+you\s+define|does\s+(?:nibrs|the\s+fbi|ucr)\s+define)\b.*\bdef[ia]n\w*\b|\bwhat\s+(?:is|are)\s+(?:the\s+)?def[ia]n\w+\s+of\b|\bdef[ia]nitions?\s+(?:of|please)\b|\bwhat\s+(?:is|are)\s+defined\s+as\b|\bwhat\s+(?:counts\s+as|constitutes)\b/i;

/** Do you (or we) track, have, count or record shootings, or is there a dataset that does them. */
const SHOOTINGS_CAPABILITY = /^\s*(?:do|does|can|could)\s+(?:you|we|they|i|this\s+(?:site|tool|app))\s+(?:have|track|count|record|show|cover|report|do)\b[^?]*\bshootings?\b|\b(?:any|what)\s+(?:dataset|data\s*set|data|source)s?\b[^?]*\bshootings?\b/i;
const POLICE_WORDS = /\b(?:police|officers?|cops?|sheriffs?|deput(?:y|ies)|troopers?|law\s+enforcement)\b/i;

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
    return one("sources", { ucr: /\bucr\b/i.test(t) });
  // Where a term is defined: one plain question about the term, nothing else asked with it.
  // A question about how a definition changed ("any legal change of the definition of robbery historically") is not a plain definition: a link
  // does not say whether it changed, so it keeps its old reading.
  const ABOUT_CHANGE = /\b(?:chang\w*|histor\w*|legal(?:ly)?|over\s+time|evolv\w*|used\s+to|revis\w*|updat\w*|amend\w*|ever)\b/i;
  if (DEFINED.test(t) && !ABOUT_CHANGE.test(t) && !hasPlace && (t.match(/\?/g) ?? []).length <= 1 && !/\b(?:and|also)\s+(?:show|give|can|how\s+many)\b|\bcan\s+you\s+show\b/i.test(t) && t.split(/\s+/).length <= 16)
    return one("definitions", { term: termIn(t), program: /\b(?:srs|summary\s+reporting|crime\s+index)\b/i.test(t) ? "srs" : /\bnibrs\b/i.test(t) ? "nibrs" : null });
  // P292: which country, which cities or which agencies are covered: one coverage sentence.
  if (!hasMeasure && (/\bwhich\s+countr(?:y|ies)\b[^?]*\b(?:cover\w*|include\w*|have)\b/i.test(t)
    || /\bwhich\s+(?:cities|agencies)\s+are\s+(?:represented|covered|included)\b/i.test(t)
    || /\bwhich\s+(?:cities|agencies)\s+(?:report|reports|submit|contribute)\w*\b(?:\s+(?:monthly|each\s+month))?/i.test(t)
    || /\bwhat\s+agencies\s+match\b/i.test(t) || /\bagencies\s+table\b/i.test(t)))
    return one("scope", { state: null, from: null, to: null, byYear: false, lookup: lookupIn(t) });
  // P312 (Jeff 2026-11-25, labels QL-ct-9ac9544851, QL-hist-a02cdb1065, QL-ct-6c0cceecde): "do you track shootings?" is a yes/no question about the data, answered, never declined.
  if (!hasPlace && SHOOTINGS_CAPABILITY.test(t) && !POLICE_WORDS.test(t)) return one("shootings", { state: null, from: null, to: null, byYear: false });
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

/** The agencies a scope lookup names, from the agency name list (every ORI in the build) and the agency index (Crime Index). */
function lookupAnswer(lk: CoverageLookup, d: CoverageDeps): { rows: string[][]; text: string[] } | null {
  const pl = d.places!;
  const orif = (code: string) => (code === "NE" ? "NB" : code);
  const typeOf = (ori: string, idx?: { kind: string }) => (idx ? (idx.kind === "county" ? "County" : "City") : /^..\d{3}0000$/.test(ori) ? "County" : "Agency");
  const index = new Map<string, { kind: string; sources?: string[]; state: string }>();
  for (const xs of pl.byName.values()) for (const a of xs) index.set(a.ori, a);
  const key = (x: string) => x.toLowerCase().replace(/\s+(county|parish)$/, "").trim();
  const qs = (x: string) => `'${x.replace(/'/g, "''")}'`;
  const acFile = d.crimeIndexRoot ? `read_parquet(${qs(`${d.crimeIndexRoot}/agency_crime.parquet`)})` : null;
  /** Which of these ORIs have Crime Index counts: from the build's agency_crime table when it is on hand (the fixture index only when it is not). */
  let liveCi: Set<string> | null = null;
  const ciLive = (oris: string[]) => {
    if (!acFile || !oris.length) return;
    liveCi = new Set(d.execute(`SELECT DISTINCT ori FROM ${acFile} WHERE ori IN (${oris.map(qs).join(", ")})`).map((r) => String(r[0])));
  };
  const row = (ori: string): string[] => {
    const i = index.get(ori);
    const inCi = liveCi ? liveCi.has(ori) : !!i?.sources?.includes("crime_index");
    const src = inCi ? "FBI NIBRS and Crime Index" : "FBI NIBRS";
    return [ori, pl.names.get(ori) ?? "", postal(ori.slice(0, 2)), typeOf(ori, i), src];
  };
  const byPrefix = (prefix: string) => [...pl.names.keys()].filter((o) => o.startsWith(prefix)).sort();
  if (lk.kind === "agency") {
    const n = key(lk.name);
    const hits = [...pl.names.entries()].filter(([o, nm]) => nm.toLowerCase().includes(n) && (!lk.state || postal(o.slice(0, 2)) === lk.state)).map(([o]) => o).sort().slice(0, 20);
    const named = (index.size ? [...index.values()] : []).filter((a: any) => key(a.name) === n && (!lk.state || a.state === lk.state)).map((a: any) => a.ori);
    const oris = [...new Set([...named, ...hits])];
    if (!oris.length) return null;
    ciLive(oris);
    const rows = oris.map(row);
    return { rows, text: [`Agencies Named ${lk.name} in the Data`, ...rows.map((r) => `${r[0]}: ${r[1]}, ${STATE_NAMES[r[2]] ?? r[2]} (${r[4]}).`), COVERAGE_SOURCE] };
  }
  if (lk.kind === "county") {
    const n = key(lk.name);
    const cty = [...index.values()].filter((a: any) => a.kind === "county" && key(a.name) === n && (!lk.state || a.state === lk.state)) as any[];
    if (!cty.length) return null;
    const prefix = cty[0].ori.slice(0, 5);
    // The ORI prefix is the county's own code, but a city agency can carry another prefix (Dallas Police is TXDPD0000, not TX057...):
    // an agency also belongs to the county its NIBRS batch header names as primary (FIPS county, ordinal 1), the rule the county-wide sums use.
    const stc = orif(cty[0].state);
    const byFips = d.execute(`WITH f AS (SELECT data_year, ori, fips_county FROM read_parquet(${qs(`${d.root}/agency_fips_county/**/*.parquet`)}, hive_partitioning = 1) WHERE ordinal = 1), `
      + `y AS (SELECT max(data_year) AS y FROM f), k AS (SELECT fips_county FROM f WHERE ori = ${qs(cty[0].ori)} AND data_year = (SELECT y FROM y)) `
      + `SELECT DISTINCT f.ori FROM f JOIN k USING (fips_county) WHERE f.data_year = (SELECT y FROM y) AND f.ori LIKE ${qs(`${stc}%`)}`).map((r) => String(r[0]));
    const oris = byPrefix(prefix);
    const all = [...new Set([cty[0].ori, ...oris, ...byFips.filter((o) => pl.names.has(o))])].sort();
    ciLive(all);
    const rows = all.map(row);
    const st = STATE_NAMES[cty[0].state] ?? cty[0].state;
    return { rows, text: [`Agencies in ${lk.name} County, ${st}`, `${rows.length} agencies are in the county: those with the county code ${prefix} and those whose NIBRS records name it as their primary county. ${cty[0].ori} is the county agency.`, ...rows.map((r) => `${r[0]}: ${r[1]} (${r[3]}).`), COVERAGE_SOURCE] };
  }
  const code = lk.name;
  const st = STATE_NAMES[code] ?? code;
  const nibrsNamed = byPrefix(orif(code));
  const sql = d.execute(`SELECT count(DISTINCT ori) FROM ${ay(d.root)} WHERE state_abbr IN ('${orif(code)}', '${code}')`);
  const nibrs = Number(sql[0]?.[0]) > 0 ? Number(sql[0][0]) : nibrsNamed.length;
  // Crime Index agencies are counted from the build's agency_crime table (the release the answers read), not from the fixture index.
  const live = acFile ? d.execute(`SELECT count(DISTINCT ori), count(DISTINCT CASE WHEN type = 'city' THEN ori END) FROM ${acFile} WHERE state IN (${qs(orif(code))}, ${qs(code)})`)[0] : null;
  const ci = live ? Number(live[0]) : null, cities = live ? Number(live[1]) : null;
  const rows = [["FBI NIBRS agency list", String(nibrs)], ...(ci === null ? [] : [["Crime Index", String(ci)]])];
  const ciText = ci === null ? "" : ` and ${fmt(ci)} with Crime Index counts; ${fmt(cities!)} of the agencies in the index are cities`;
  return { rows, text: [`Agencies in ${st}`, `${st} has ${fmt(nibrs)} agencies in the FBI's NIBRS agency list${ciText}.`, "Name a city to see its agency and the years it reports.", COVERAGE_SOURCE] };
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
    const reporting = new Map<number, Set<string>>();
    for (const [y, s] of have) { if (!reporting.has(Number(y))) reporting.set(Number(y), new Set()); reporting.get(Number(y))!.add(postal(String(s))); }
    const ys = years(a, b);
    const rows = ys.map((y) => {
      const got = reporting.get(y) ?? new Set<string>();
      const states = FIFTY.filter((c) => !got.has(c)).map((c) => STATE_NAMES[c]).sort();
      return { y, states };
    });
    const last = rows[rows.length - 1];
    const span = a === b ? String(a) : `${a} to ${b}`;
    const text = [`${a === b ? `${a} ` : ""}States With No NIBRS Data${a === b ? "" : ` by Year, ${span}`}`,
      "A state is listed in a year when none of its agencies reported any month.",
      last.states.length ? `In ${last.y} ${last.states.length > 1 ? `the states with no data are ${list(last.states)}` : `the one state with no data is ${last.states[0]}`}.` : `In ${last.y} every one of the 50 states has reporting agencies.`, COVERAGE_SOURCE];
    return { kind: "coverage", shape: "states", period: { from: `${a}-01`, to: `${b}-12` }, meaning: meaning("states with no data", { from: `${a}-01`, to: `${b}-12` }, ["year"]),
      delivered: { table: { columns: [{ binding: { kind: "grouping", dimension: "time.year" }, header: "Year" }, txt("coverage.states", "States with no data")],
        rows: rows.map((r) => [String(r.y), r.states.length ? r.states.join(", ") : "None"]) }, text }, read };
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

  if (cq.shape === "scope") {
    const sentence = `Current Trends covers United States agencies that report monthly, ${firstY} to present; ask about a city to see if it is included.`;
    const lk = cq.lookup && d.places ? lookupAnswer(cq.lookup, d) : null;
    if (lk) {
      const cols = lk.rows[0]?.length === 5 ? [txt("coverage.ori", "ORI"), txt("coverage.agency", "Agency"), txt("coverage.state", "State"), txt("coverage.kind", "Type"), txt("coverage.sources", "Sources")] : [txt("coverage.source", "Source"), txt("coverage.agencies", "Agencies")];
      return { kind: "coverage", shape: "scope", period: span0, meaning: meaning("coverage", null, []), delivered: { table: { columns: cols, rows: lk.rows }, text: lk.text }, read };
    }
    return { kind: "coverage", shape: "scope", period: span0, meaning: meaning("coverage", null, []),
      delivered: { table: { columns: [txt("coverage.scope", "Coverage")], rows: [[sentence]] }, text: [sentence] }, read };
  }

  if (cq.shape === "shootings") {
    const text = ["Shootings in the Data",
      "No, not as a count of shootings: NIBRS doesn't count shootings as a category.",
      "For fatal shootings, the Homicide Reports tab has firearm homicides.",
      "The closest NIBRS figure is aggravated assault with a firearm, which also includes brandishing, pistol-whipping and threats, not only people who were shot.", COVERAGE_SOURCE];
    return { kind: "coverage", shape: "shootings", period: span0, meaning: meaning("shootings", null, []),
      delivered: { table: { columns: [txt("coverage.shootings", "Shootings")], rows: text.slice(1, 4).map((s) => [s]) }, text }, read };
  }

  if (cq.shape === "sources") {
    const text = [cq.ucr ? `Yes. ${SOURCES_SENTENCE}` : SOURCES_SENTENCE];
    return { kind: "coverage", shape: "sources", period: span0, meaning: meaning("sources", null, []),
      delivered: { table: { columns: [txt("coverage.source", "Source")], rows: [[SOURCES_SENTENCE]] }, text }, read };
  }

  if (cq.term) {
    const f = FBI_DEFINITIONS[cq.term];
    // Violent crime has two definitions: the program the question names picks one; none named gives both, each labeled (Jeff 2026-11-25).
    const parts = cq.term === "violent crime" ? (cq.program === "nibrs" ? [VIOLENT_NIBRS] : cq.program === "srs" ? [f.text] : [f.text, VIOLENT_NIBRS]) : [f.text];
    const source = cq.term === "violent crime" ? (cq.program === "nibrs" ? "Source: FBI NIBRS." : cq.program === "srs" ? f.source : "Source: FBI SRS and NIBRS.") : f.source;
    return { kind: "coverage", shape: "definitions", period: span0, meaning: meaning("definitions", null, []),
      delivered: { table: { columns: [txt("coverage.definition", f.title)], rows: parts.map((p) => [p]) }, text: [f.title, ...parts, source] }, read };
  }

  const text = [`The FBI Crime Data Explorer defines these terms: ${DEFINITIONS_LINK}`, "Source: FBI Crime Data Explorer."];
  return { kind: "coverage", shape: "definitions", period: span0, meaning: meaning("definitions", null, []),
    delivered: { table: { columns: [txt("coverage.link", "Where the FBI defines these terms")], rows: [[DEFINITIONS_LINK]] }, text }, read };
}
