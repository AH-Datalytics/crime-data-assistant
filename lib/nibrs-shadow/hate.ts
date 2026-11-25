/**
 * Hate crimes in the shadow: counts of hate crime incidents read from the parquet export of the hate crime database
 * (scripts/export-hate-crime-parquet.py), never from NIBRS offense records and never from the live hate_crime.db
 * (Jeff 2026-11-15: "hate crimes should only come from hate crimes data").
 *
 * Counting: an incident is counted once however many offenses or biases it holds (distinct ORI + incident number, the
 * FBI's own incident count); by month or year it is placed by its incident date. The bias is the FBI's code of the
 * offense row, decoded by the export from bias_code and the data year (scripts/hate_crime_bias.py), never from a stored
 * label. Hate crime reporting is voluntary and a month with no row is a month with no reported incident, never proof of none
 * (the database's own mandatory caveat is said).
 */
import fs from "node:fs";
import path from "node:path";
import type { ResultTable } from "../nibrs-plan/result";
import type { NibrsPlan } from "../nibrs-plan/plan";
import { fmt, monthName, periodWords } from "./deliver";
import { stateName } from "./places";
import { agencySubject, seriesTitle } from "./headline";
import { CONSOLIDATED_AGENCIES } from "../agency-consolidations";
import { firstNeeded, monthRange, rollingSums } from "./rolling";

export const HATE_FIRST_YEAR = 1991;
/** "1980 isn't included" for one year, "1960 through 1990 aren't included" for several (Jeff 2026-11-15). */
export const notIncluded = (fromYear: number, toYear: number) => (fromYear === toYear ? `${fromYear} isn't included` : `${fromYear} through ${toYear} aren't included`);
export const HATE_SOURCE = "Source: FBI Hate Crime Statistics.";
/** The caveat on reporting, in the shorter words Jeff approved (2026-11-15); the database's own caveat text is longer and is not used. */
export const HATE_REPORTING_CAVEAT = "Hate crime reporting is voluntary. Many agencies report zero hate crimes, which reflects non-reporting, not an absence of hate crimes.";

/** Where the export is: its release id, the first and latest incident dates and the last complete month. */
export type HateBuild = { root: string; release: string; firstDate: string; latestDate: string; latestMonth: string };

/** The export at `root` (the folder holding release.json and hate_crime_incident/data.parquet); no root, no build. */
export function hateBuildAt(root: string | undefined): HateBuild | undefined {
  if (!root) return undefined;
  const file = path.join(root, "release.json");
  const data = path.join(root, "hate_crime_incident", "data.parquet");
  if (!fs.existsSync(file) || !fs.existsSync(data)) return undefined;
  const r = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  if (typeof r.source_sha256 !== "string" || typeof r.rows !== "number" || typeof r.first_incident_date !== "string" || typeof r.latest_incident_date !== "string"
    || r.rows_whose_stored_label_differs !== 0)
    throw new Error(`${file}: release.json must hold source_sha256, rows, first and latest incident dates, and no stored label that differs from the decoder`);
  const latest = r.latest_incident_date;
  const d = new Date(`${latest}T00:00:00Z`);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  // A month is complete only when the latest date is its last day; otherwise the month before.
  const ymOf = (x: Date) => `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`;
  const latestMonth = d.getUTCDate() === lastDay ? ymOf(d) : ymOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)));
  return { root: root.replace(/\\/g, "/"), release: `hate-${r.source_sha256.slice(0, 8)}-${r.rows}`, firstDate: r.first_incident_date, latestDate: latest, latestMonth };
}

/** The FBI's names for the bias codes (the decoder's modern names); a code whose meaning changed is declined before its change. */
export const BIAS_NAMES: Record<string, string> = {
  "11": "Anti-White", "12": "Anti-Black or African American", "13": "Anti-American Indian or Alaska Native", "14": "Anti-Asian",
  "15": "Anti-Multiple Races, Group", "16": "Anti-Native Hawaiian or Other Pacific Islander", "21": "Anti-Jewish", "22": "Anti-Catholic", "23": "Anti-Protestant",
  "24": "Anti-Islamic (Muslim)", "25": "Anti-Other Religion", "26": "Anti-Multiple Religions, Group", "27": "Anti-Atheism/Agnosticism", "28": "Anti-Church of Jesus Christ",
  "29": "Anti-Jehovah's Witness", "31": "Anti-Arab", "32": "Anti-Hispanic or Latino", "33": "Anti-Other Race/Ethnicity/Ancestry", "41": "Anti-Gay (Male)",
  "42": "Anti-Lesbian (Female)", "43": "Anti-Lesbian, Gay, Bisexual, or Transgender (Mixed Group)", "44": "Anti-Heterosexual", "45": "Anti-Bisexual",
  "51": "Anti-Physical Disability", "52": "Anti-Mental Disability", "61": "Anti-Male", "62": "Anti-Female", "71": "Anti-Transgender", "72": "Anti-Gender Non-Conforming",
  "81": "Anti-Eastern Orthodox (Russian, Greek, Other)", "82": "Anti-Other Christian", "83": "Anti-Buddhist", "84": "Anti-Hindu", "85": "Anti-Sikh",
};
/** The first data year a code has its modern meaning (the decoder's reference): before it the name differs or is unconfirmed. */
const LGBTQ_CODES = ["41", "42", "43", "45", "71", "72"];
const MODERN_FROM: Record<string, number> = { "14": 2013, "16": 2013, "28": 2015, "29": 2015, "31": 2015, "33": 2015, "43": 2013, "lgbtq": 2013, "61": 2013, "62": 2012, "71": 2013, "72": 2012,
  "81": 2015, "82": 2015, "83": 2015, "84": 2015, "85": 2015, "51": 1997, "52": 1997 };

export type HatePlace = { kind: "agency"; ori: string; label: string } | { kind: "state"; code: string } | { kind: "national" };
export type HateQuestion = {
  place: HatePlace; /** Months inclusive, cut to the data's first year and last complete month. */ from: string; to: string;
  grain: "total" | "year" | "month" | "rolling"; window?: number; bias: { code: string; name: string; codes?: string[]; note?: string } | null;
  /**
   * Several biases named ("anti-Islamic and anti-Jewish hate crimes over time"; H1, 2026-11-21): one column each, every column the
   * incidents with that bias; an incident with two of them is in both columns, which are never added. `bias` is null then.
   */
  biases?: { code: string; name: string; codes?: string[]; note?: string }[];
  /**
   * H2/H3 (Jeff 2026-11-21): one row per bias (the decoder's names) or per location (the CDE names), the incidents with it, largest first;
   * an incident with several is in each row (said in one line); no share. "Location not confirmed" is its own row, last.
   */
  breakdown?: "bias" | "location";
  /** H4 (Jeff 2026-11-21): incidents with any offense at a school; incidents whose location is not confirmed are not counted (said). */
  location?: "school";
  /** The first year asked when it was before the data start (the answer says so). */ askedFrom?: string;
  /** A bias whose current meaning begins after the data start: the every-year span starts there, and the answer says so. */ modernFrom?: { year: number; biases: { name: string; year: number }[] };
  /** Said when the span asked reached past the last complete month. */ cutAt?: string;
  /** No range was named for a series: every year the data have is shown, and the answer says so. */ allYears?: boolean;
  /** "Getting worse", "going up" (Jeff 2026-11-24): a sentence says which way the last two full years went; no opinion on "worse". */ direction?: boolean;
};
export type HateAnswer = {
  kind: "hate"; question: HateQuestion; period: { from: string; to: string };
  meaning: { source: "hate_crime"; places: unknown[]; filters: string[]; measures: { name: string; unit: string }[]; period: { from: string; to: string }; groupings: string[]; statistic: "count" };
  delivered: { table: ResultTable; text: string[] };
  read: { table: string; release: string };
};
export type HateDecline = { kind: "hate-decline"; explanation: string };

const ORI_STATE: Record<string, string> = { NB: "NE", GM: "GU" };

/**
 * The hate crime question a NIBRS plan asks, or why this source can't answer it as asked (the caller declines). One place
 * (an agency, a state or the nation), the hate crime count (any unit: it is always incidents), optionally one named bias,
 * as a total, by year or month, or as a rolling window of months; no rate, share, change or breakdown yet.
 */
export function modernFromNote(m: { year: number; biases: { name: string; year: number }[] }): string {
  const same = m.biases.every((b) => b.year === m.year);
  if (same) return `${m.biases.map((b) => b.name).join(" and ")} is shown from ${m.year}, when the bias category took its current meaning.`;
  return `${m.biases.map((b) => `${b.name} took its current meaning in ${b.year}`).join(" and ")}, so the years are shown from ${m.year}.`;
}
export function hateQuestionOf(plan: NibrsPlan, period: { from: string; to: string }, build: HateBuild, allYears = false): HateQuestion | { why: string } {
  if (plan.measures.length !== 1 || !/\.hate_crime$/.test(plan.measures[0].id)) return { why: "not a hate crime count" };
  const stats = plan.statistics.map((s) => s.kind);
  // A breakdown's share column is not given (Jeff 2026-11-21: the rows overlap); its count is.
  const catDims = plan.groupings.filter((g) => !g.dimension.startsWith("time.")).map((g) => g.dimension);
  const breakdown = catDims.length === 1 && catDims[0] === "offense_bias.bias" ? "bias" as const : catDims.length === 1 && catDims[0] === "offense.location_type" ? "location" as const : undefined;
  if (!(stats.length === 1 && stats[0] === "count") && !(breakdown && stats.length === 2 && stats[0] === "count" && stats[1] === "share")) return { why: "a rate or another statistic" };
  const roll = plan.transforms.filter((t) => t.kind === "rolling");
  if (plan.transforms.length > roll.length || roll.length > 1) return { why: "a change or a ranking" };
  if (plan.geography.places.length !== 1) return { why: "several places" };
  const p = plan.geography.places[0];
  const place: HatePlace | null = p.kind === "national" ? { kind: "national" } : p.kind === "state" ? { kind: "state", code: p.code }
    : p.kind === "agency" ? { kind: "agency", ori: p.ori, label: p.label } : null;
  if (!place) return { why: "a county or a set of agencies" };
  if (place.kind === "agency" && CONSOLIDATED_AGENCIES.some((c) => c.predecessor && (c.historicalOri === place.ori || c.nibrsOri === place.ori))) return { why: "an agency whose ORI changed" };
  const time = plan.groupings.filter((g) => g.dimension.startsWith("time."));
  const cats = plan.groupings.filter((g) => !g.dimension.startsWith("time."));
  if ((cats.length && !breakdown) || time.length > 1 || time.some((g) => g.dimension !== "time.year" && g.dimension !== "time.month")) return { why: "this breakdown" };
  if (breakdown && (roll.length || time.some((g) => g.dimension === "time.month"))) return { why: "this breakdown by month" };
  // A location named: schools only (School/College before 2010, Elementary/Secondary, College/University; the reader's codes 22, 52, 53).
  const locs = plan.filters.filter((f) => f.kind === "attribute" && f.dimension === "offense.location_type");
  if (locs.length > 1 || locs.some((f) => f.kind !== "attribute" || f.op !== "in" || !(f.values ?? []).length || !(f.values ?? []).every((v) => SCHOOL_CODES.includes(String(v)))))
    return { why: "a location this source does not group" };
  const location = locs.length ? "school" as const : undefined;
  if (location && breakdown === "location") return { why: "this breakdown" };
  // One named bias per filter: the reader writes each bias named as its own filter ("anti-Islamic and anti-Jewish").
  const biasOf = (f: NibrsPlan["filters"][number]): { code: string; name: string; codes?: string[] } | null => {
    const w = f.kind === "exists" && !f.negate && f.entity === "offense_bias" && f.where.length === 1 && f.where[0].kind === "attribute" && f.where[0].dimension === "offense_bias.bias" && f.where[0].op === "in"
      ? f.where[0] : null;
    // The anti-LGBTQ group: every sexual-orientation and gender-identity bias except anti-heterosexual (44); an incident counts once.
    if (w && w.values?.length === LGBTQ_CODES.length && LGBTQ_CODES.every((c) => w.values!.map(String).includes(c))) return { code: "lgbtq", name: "Anti-LGBTQ", codes: LGBTQ_CODES };
    const code = w && w.values?.length === 1 ? String(w.values[0]) : null;
    return code && BIAS_NAMES[code] ? { code, name: BIAS_NAMES[code] } : null;
  };
  const named = plan.filters.filter((f) => !locs.includes(f)).map(biasOf);
  if (named.some((b) => !b)) return plan.filters.length > 1 ? { why: "several conditions" } : { why: "a bias this source does not name" };
  const all = named as { code: string; name: string; codes?: string[] }[];
  if (new Set(all.map((b) => b.code)).size !== all.length || all.length > 5) return { why: "several conditions" };
  if (all.length > 1 && roll.length) return { why: "several biases with a rolling window" };
  if (all.length > 1 && (breakdown || location)) return { why: "several conditions" };
  const bias: HateQuestion["bias"] = all.length === 1 ? all[0] : null;
  const first = `${HATE_FIRST_YEAR}-01`;
  const to = period.to > build.latestMonth ? build.latestMonth : period.to;
  if (to < first) return { why: "before the data start" };
  if (period.from > build.latestMonth) return { why: "after the latest month" };
  let from = period.from < first ? first : period.from;
  // No range named: every year the data have for the bias, starting where its current meaning begins (said), not declined for the earlier years.
  let modernFrom: HateQuestion["modernFrom"];
  if (allYears && !roll.length) {
    const late = all.filter((b) => MODERN_FROM[b.code] && Number(from.slice(0, 4)) < MODERN_FROM[b.code]);
    if (late.length) { const year = Math.max(...late.map((b) => MODERN_FROM[b.code])); from = `${year}-01`; modernFrom = { year, biases: late.map((b) => ({ name: b.name, year: MODERN_FROM[b.code] })) }; }
  }
  const grain = roll.length ? "rolling" : time[0]?.dimension === "time.month" ? "month" : time[0]?.dimension === "time.year" ? "year" : "total";
  const window = roll.length ? (roll[0] as { months: number }).months : undefined;
  const readFrom = window ? firstNeeded(from, window) : from;
  // Jeff 2026-11-24: a bias whose FBI code was split or renamed is matched, not declined, where the older group maps cleanly
  // (14: Asian/Pacific Islander before 2013, then 14 + 16; 43: Anti-Homosexual before 2013). Other changed codes keep the guard.
  const early = Number(readFrom.slice(0, 4));
  const adjust = (b: { code: string; name: string; codes?: string[]; note?: string }) => {
    if (b.code === "14" && early < 2013) return { code: "14", codes: ["14", "16"], name: "Anti-Asian or Pacific Islander", note: "The FBI combined Asian and Pacific Islander bias before 2013." };
    if (b.code === "43" && early < 2013) return { ...b, note: "Before 2013 this bias was recorded as Anti-Homosexual (Gay and Lesbian)." };
    return b;
  };
  const adj = all.map(adjust);
  if (adj.some((b) => !("note" in b) && MODERN_FROM[b.code] && early < MODERN_FROM[b.code])) return { why: "a bias whose meaning changed in the years asked" };
  const bias2: HateQuestion["bias"] = adj.length === 1 ? adj[0] : null;
  return { place, from, to, grain, ...(window ? { window } : {}), bias: bias2, ...(adj.length > 1 ? { biases: adj } : {}), ...(breakdown ? { breakdown } : {}), ...(location ? { location } : {}),
    ...(period.from < first ? { askedFrom: period.from.slice(0, 4) } : {}), ...(period.to > to ? { cutAt: to } : {}), ...(modernFrom ? { modernFrom } : {}) };
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const table = (b: HateBuild) => `read_parquet(${q(`${b.root}/hate_crime_incident/data.parquet`)})`;

/** One row per month (or year, or total) of the incidents in the span: the distinct ORI + incident number. */
/** The reader's school location codes (NIBRS 22 before 2010; 52 and 53 after) and the hate crime data's names for them (the CDE's). */
export const SCHOOL_CODES = ["22", "52", "53"];
export const SCHOOL_LOCATIONS = ["School/College", "School-College/University", "School-Elementary/Secondary"];
export const LOCATION_NOT_CONFIRMED = "Location not confirmed";
/** The rows a question reads: its place, bias, school and months. */
function hateWhere(hq: HateQuestion, from: string): string {
  const place = hq.place.kind === "agency" ? `ori = ${q(hq.place.ori)}` : hq.place.kind === "state" ? `state = ${q(hq.place.code)}` : "TRUE";
  const bias = hq.bias ? ` AND ${biasCond(hq.bias)}` : "";
  const school = hq.location === "school" ? ` AND location IN (${SCHOOL_LOCATIONS.map(q).join(", ")})` : "";
  const ymExpr = "year(incident_date) * 100 + month(incident_date)";
  const lo = Number(from.slice(0, 4)) * 100 + Number(from.slice(5, 7)), hi = Number(hq.to.slice(0, 4)) * 100 + Number(hq.to.slice(5, 7));
  return `${place}${bias}${school} AND ${ymExpr} BETWEEN ${lo} AND ${hi}`;
}
/** The bias test: one code as `bias_code = x`, several as IN. */
const biasCond = (b: { code: string; codes?: string[] }) => (b.codes && b.codes.length > 1 ? `bias_code IN (${b.codes.map(q).join(", ")})` : `bias_code = ${q(b.code)}`);
const INCIDENT = "count(DISTINCT year || '|' || ori || '|' || incident_number)";
/** H2/H3: the incidents per bias (the decoder's name) or location (the CDE name), by year when asked. */
export function hateBreakdownSql(hq: HateQuestion, build: HateBuild): string {
  const cat = hq.breakdown === "bias" ? "bias_label" : "location";
  const key = hq.grain === "year" ? "year(incident_date) AS k, " : "";
  return `SELECT ${key}${cat} AS c, ${INCIDENT} AS n FROM ${table(build)} WHERE ${hateWhere(hq, hq.from)} GROUP BY ${key ? "k, " : ""}c`;
}
/** H4: the incidents in the question's place, bias and months whose location is not confirmed and that have no school row. */
export function hateUnconfirmedSql(hq: HateQuestion, build: HateBuild): string {
  const all = hateWhere({ ...hq, location: undefined }, hq.from);
  return `SELECT count(*) FROM (SELECT year, ori, incident_number FROM ${table(build)} WHERE ${all} GROUP BY year, ori, incident_number`
    + ` HAVING bool_or(location = ${q(LOCATION_NOT_CONFIRMED)}) AND NOT bool_or(location IN (${SCHOOL_LOCATIONS.map(q).join(", ")})))`;
}
export function hateSql(hq: HateQuestion, build: HateBuild, from = hq.from): string {
  const place = hq.place.kind === "agency" ? `ori = ${q(hq.place.ori)}` : hq.place.kind === "state" ? `state = ${q(hq.place.code)}` : "TRUE";
  const bias = hq.bias ? ` AND ${biasCond(hq.bias)}` : "";
  const school = hq.location === "school" ? ` AND location IN (${SCHOOL_LOCATIONS.map(q).join(", ")})` : "";
  const ymExpr = "year(incident_date) * 100 + month(incident_date)";
  const lo = Number(from.slice(0, 4)) * 100 + Number(from.slice(5, 7)), hi = Number(hq.to.slice(0, 4)) * 100 + Number(hq.to.slice(5, 7));
  const key = hq.grain === "year" ? "year(incident_date)" : hq.grain === "month" || hq.grain === "rolling" ? ymExpr : null;
  return `SELECT ${key ? `${key} AS k, ` : ""}count(DISTINCT year || '|' || ori || '|' || incident_number) AS n FROM ${table(build)} WHERE ${place}${bias}${school} AND ${ymExpr} BETWEEN ${lo} AND ${hi}`
    + `${key ? " GROUP BY k ORDER BY k" : ""}`;
}

const ucFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ym2 = (v: number) => `${Math.floor(v / 100)}-${String(v % 100).padStart(2, "0")}`;

export function answerHate(hq: HateQuestion, build: HateBuild, execute: (sql: string) => unknown[][]): HateAnswer | HateDecline {
  if (hq.biases && hq.biases.length > 1) return answerHateBiases(hq, hq.biases, build, execute);
  if (hq.breakdown) return answerHateBreakdown(hq, build, execute);
  const where = hq.place.kind === "agency" ? hq.place.label : hq.place.kind === "state" ? stateName(hq.place.code) : "the United States";
  const what = `${hq.bias ? `${hq.bias.name} hate crimes` : "hate crimes"}${hq.location === "school" ? " at schools" : ""}`;
  const who = hq.place.kind === "agency" ? agencySubject(hq.place.label).text : hq.place.kind === "state" ? stateName(hq.place.code) : "The United States";
  const span = periodWords(hq.from, hq.to);
  const fromY = Number(hq.from.slice(0, 4)), toY = Number(hq.to.slice(0, 4));
  const columns: ResultTable["columns"] = [];
  const rows: (string | number | null)[][] = [];
  const notes: string[] = [];
  const text: string[] = [];
  const head = ucFirst(what);
  if (hq.grain === "total") {
    const n = Number(execute(hateSql(hq, build))[0]?.[0] ?? 0);
    columns.push({ binding: { kind: "statistic", as: "count" }, header: head });
    rows.push([n]);
    text.push(`${who} had ${fmt(n)} ${what[0].toLowerCase()}${what.slice(1)} in ${span}.`);
  } else if (hq.grain === "year") {
    const got = new Map(execute(hateSql(hq, build)).map((r) => [Number(r[0]), Number(r[1])]));
    columns.push({ binding: { kind: "grouping", dimension: "time.year" }, header: "Year" }, { binding: { kind: "statistic", as: "count" }, header: head });
    for (let y = fromY; y <= toY; y++) rows.push([String(y), got.get(y) ?? 0]);
    text.push(seriesTitle(span, what, "Year", where));
    if (hq.direction && !hq.bias) {
      const lastFull = hq.to.endsWith("-12") ? toY : toY - 1;
      // Both years must be whole inside the span: a first year that starts after January is partial and is not compared.
      if (lastFull - 1 > fromY || (lastFull - 1 === fromY && hq.from.endsWith("-01"))) {
        const a = got.get(lastFull - 1) ?? 0, b = got.get(lastFull) ?? 0;
        text.push(b > a ? `Incidents rose from ${fmt(a)} in ${lastFull - 1} to ${fmt(b)} in ${lastFull}.` : b < a ? `Incidents fell from ${fmt(a)} in ${lastFull - 1} to ${fmt(b)} in ${lastFull}.` : `Incidents were ${fmt(b)} in both ${lastFull - 1} and ${lastFull}.`);
      }
    }
  } else {
    const start = hq.grain === "rolling" ? firstNeeded(hq.from, hq.window!) : hq.from;
    const got = new Map(execute(hateSql(hq, build, start)).map((r) => [ym2(Number(r[0])), Number(r[1])]));
    const cells = monthRange(start, hq.to).map((ym) => ({ ym, value: ym < `${HATE_FIRST_YEAR}-01` ? null : got.get(ym) ?? 0 }));
    if (hq.grain === "month") {
      columns.push({ binding: { kind: "grouping", dimension: "time.month" }, header: "Month" }, { binding: { kind: "statistic", as: "count" }, header: head });
      for (const c of cells) rows.push([c.ym, c.value]);
      text.push(seriesTitle(span, what, "Month", where));
    } else {
      // A window is complete from the data's first month on; the first months of 1991 have none and are not shown (no blank rows, no
      // gap sentence: the start line says where the data begin). Months with no row are 0 here, as the reporting caveat says.
      const roll = rollingSums(cells, hq.window!, hq.from, hq.to).filter((r) => r.value !== null);
      columns.push({ binding: { kind: "grouping", dimension: "time.month" }, header: "Month" }, { binding: { kind: "statistic", as: "count" }, header: `${head}, rolling ${hq.window} months` });
      for (const r of roll) rows.push([r.ym, r.value]);
      text.push(seriesTitle(span, `${what}, Rolling ${hq.window}-Month Totals`, "Month", where));
    }
  }
  text.push(HATE_REPORTING_CAVEAT);
  if (hq.allYears) text.push(`No years were given, so every year in the data is shown: ${fromY} through ${toY}.`);
  if (hq.modernFrom) text.push(`${modernFromNote(hq.modernFrom)}`);
  if (hq.askedFrom) text.push(`Hate crime data by bias starts in ${HATE_FIRST_YEAR}.`);
  if (hq.bias?.note) notes.push(hq.bias.note);
  // The data's last complete month ends the answer when it is not a December: the year (or span) asked may reach past it.
  if (hq.to === build.latestMonth && build.latestDate.slice(0, 7) > hq.to) {
    const [y, m, d] = build.latestDate.split("-").map(Number);
    const day = `${monthName(`${y}-${String(m).padStart(2, "0")}`).split(" ")[0]} ${d}, ${y}`;
    text.push(`Hate crime data here run through ${day}, so the answer ends with ${monthName(hq.to)}, the last complete month.`);
  }
  if (hq.location === "school") text.push(...schoolLines(hq, build, execute));
  text.push(...notes, HATE_SOURCE);
  const period = { from: hq.from, to: hq.to };
  return {
    kind: "hate", question: hq, period,
    meaning: { source: "hate_crime", places: [hq.place], filters: hq.bias ? [hq.bias.name] : [], measures: [{ name: "hate_crime", unit: "incident" }], period,
      groupings: hq.grain === "total" ? [] : [hq.grain === "year" ? "year" : "month"], statistic: "count" },
    delivered: { table: { columns, rows }, text },
    read: { table: "hate_crime_incident", release: build.release },
  };
}

/** "A, B and C". */
const andList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
/** The line under several biases side by side (H1). */
export const HATE_BIASES_OVERLAP = "An incident with more than one of these biases is counted in each column.";
/**
 * H1: several biases side by side. Each bias is answered on its own (the same question with that one bias), and the columns are put
 * together by period: one column per bias, never added. The lines are the first bias's (they are the same for every bias: the caveat,
 * the years and the latest month), with the overlap line.
 */
function answerHateBiases(hq: HateQuestion, biases: { code: string; name: string; codes?: string[]; note?: string }[], build: HateBuild, execute: (sql: string) => unknown[][]): HateAnswer | HateDecline {
  const each = biases.map((b) => answerHate({ ...hq, bias: b, biases: undefined }, build, execute));
  const bad = each.find((a): a is HateDecline => a.kind === "hate-decline");
  if (bad) return bad;
  const answers = each as HateAnswer[];
  const first = answers[0];
  const where = hq.place.kind === "agency" ? hq.place.label : hq.place.kind === "state" ? stateName(hq.place.code) : "the United States";
  const who = hq.place.kind === "agency" ? agencySubject(hq.place.label).text : hq.place.kind === "state" ? stateName(hq.place.code) : "The United States";
  const what = `${andList(biases.map((b) => b.name))} hate crimes`;
  const span = periodWords(hq.from, hq.to);
  const statCol = (a: HateAnswer) => a.delivered.table.columns.findIndex((c) => c.binding.kind === "statistic");
  const columns: ResultTable["columns"] = [...first.delivered.table.columns.filter((c) => c.binding.kind === "grouping"),
    ...biases.map((b, i) => ({ binding: { kind: "statistic" as const, as: `bias_${b.code}` }, header: answers[i].delivered.table.columns[statCol(answers[i])].header }))];
  const rows = first.delivered.table.rows.map((r, i) => [...r.slice(0, statCol(first)), ...answers.map((a) => a.delivered.table.rows[i][statCol(a)])]);
  // In a sentence a bias's name starts lower case, as for one bias ("857 anti-Hispanic or Latino hate crimes").
  const counts = hq.grain === "total" ? answers.map((a, i) => `${fmt(Number(a.delivered.table.rows[0][0]))} ${biases[i].name[0].toLowerCase()}${biases[i].name.slice(1)} hate crimes`) : [];
  const head = hq.grain === "total" ? `${who} had ${andList(counts)} in ${span}.` : seriesTitle(span, what, hq.grain === "year" ? "Year" : "Month", where);
  // Every bias's own note (a renamed or combined code) is said, once, not only the first bias's.
  const biasNotes = [...new Set(biases.map((b) => b.note).filter((n): n is string => !!n))];
  const lines = first.delivered.text.slice(1).filter((t) => t !== HATE_SOURCE && !biasNotes.includes(t));
  return {
    ...first, question: hq,
    meaning: { ...first.meaning, filters: biases.map((b) => b.name) },
    delivered: { table: { columns, rows }, text: [head, ...lines, ...biasNotes, HATE_BIASES_OVERLAP, HATE_SOURCE] },
  };
}

/** H4: what counts as a school, and how many incidents with no confirmed location are left out. */
export const SCHOOL_LINE = "Schools are School/College (before 2010), School-Elementary/Secondary and School-College/University.";
function schoolLines(hq: HateQuestion, build: HateBuild, execute: (sql: string) => unknown[][]): string[] {
  const n = Number(execute(hateUnconfirmedSql(hq, build))[0]?.[0] ?? 0);
  return [SCHOOL_LINE, ...(n > 0 ? [`${fmt(n)} hate crime${n === 1 ? "" : "s"} in ${periodWords(hq.from, hq.to)} ${n === 1 ? "has" : "have"} no confirmed location and ${n === 1 ? "is" : "are"} not counted.`] : [])];
}
/**
 * H2/H3: one row per bias or location, the incidents with it, largest first ("Location not confirmed" and no location last); by year,
 * the rows of each year. An incident with several is in each row: one line says so, with the total of the period (no share column).
 */
function answerHateBreakdown(hq: HateQuestion, build: HateBuild, execute: (sql: string) => unknown[][]): HateAnswer | HateDecline {
  const where = hq.place.kind === "agency" ? hq.place.label : hq.place.kind === "state" ? stateName(hq.place.code) : "the United States";
  const what = hq.bias ? `${hq.bias.name} hate crimes` : "hate crimes";
  const span = periodWords(hq.from, hq.to);
  const yearly = hq.grain === "year";
  const name = hq.breakdown === "bias" ? "Bias" : "Location";
  const last = (c: string) => (c === LOCATION_NOT_CONFIRMED || c === "Not recorded" ? 1 : 0);
  const got = execute(hateBreakdownSql(hq, build)).map((r) => (yearly ? { k: String(r[0]), c: r[1] === null || r[1] === undefined || String(r[1]).trim() === "" ? "Not recorded" : String(r[1]), n: Number(r[2]) }
    : { k: "", c: r[0] === null || r[0] === undefined || String(r[0]).trim() === "" ? "Not recorded" : String(r[0]), n: Number(r[1]) }));
  got.sort((a, b) => a.k.localeCompare(b.k) || last(a.c) - last(b.c) || b.n - a.n || a.c.localeCompare(b.c));
  const columns: ResultTable["columns"] = [...(yearly ? [{ binding: { kind: "grouping" as const, dimension: "time.year" }, header: "Year", ordered: true as const }] : []),
    { binding: { kind: "grouping", dimension: hq.breakdown === "bias" ? "offense_bias.bias" : "offense.location_type" }, header: name, exclusive: false },
    { binding: { kind: "statistic", as: "count" }, header: ucFirst(what) }];
  const rows = got.map((g) => [...(yearly ? [g.k] : []), g.c, g.n] as (string | number | null)[]);
  const total = yearly ? null : Number(execute(hateSql({ ...hq, breakdown: undefined, grain: "total" }, build))[0]?.[0] ?? 0);
  const each = hq.breakdown === "bias" ? "An incident with more than one bias is counted under each" : "An incident at more than one location is counted under each";
  const overlap = yearly ? `${each}, so a year's rows can add to more than its hate crimes.` : `${each}, so the rows add to more than ${fmt(total!)} hate crimes.`;
  const text = [seriesTitle(span, what, yearly ? `Year and ${name}` : name, where), HATE_REPORTING_CAVEAT, overlap];
  // Jeff 2026-11-24 ("most common bias"): one sentence names the top bias (the first row; a tie names each).
  if (hq.breakdown === "bias" && !yearly && !hq.bias && got.length && got[0].c !== "Not recorded" && got[0].n > 0) {
    const tops = got.filter((g) => g.n === got[0].n && g.c !== "Not recorded").map((g) => g.c);
    text.splice(1, 0, tops.length === 1 ? `${tops[0]} is the most common bias, with ${fmt(got[0].n)} hate crimes.` : `${tops.join(" and ")} are tied as the most common bias, with ${fmt(got[0].n)} hate crimes each.`);
  }
  if (hq.allYears) text.push(`No years were given, so every year in the data is shown: ${hq.from.slice(0, 4)} through ${hq.to.slice(0, 4)}.`);
  if (hq.modernFrom) text.push(`${modernFromNote(hq.modernFrom)}`);
  if (hq.askedFrom) text.push(`Hate crime data by bias starts in ${HATE_FIRST_YEAR}.`);
  text.push(HATE_SOURCE);
  const period = { from: hq.from, to: hq.to };
  return {
    kind: "hate", question: hq, period,
    meaning: { source: "hate_crime", places: [hq.place], filters: hq.bias ? [hq.bias.name] : [], measures: [{ name: "hate_crime", unit: "incident" }], period,
      groupings: [...(yearly ? ["year"] : []), hq.breakdown!], statistic: "count" },
    delivered: { table: { columns, rows }, text },
    read: { table: "hate_crime_incident", release: build.release },
  };
}

/** The name a place goes by in a table's Place column. */
export const hatePlaceLabel = (p: HatePlace): string => (p.kind === "agency" ? p.label : p.kind === "state" ? stateName(p.code) : "United States");
/**
 * Several places asked together ("anti-Black hate crimes in New York versus Texas in 2024"): each place is answered on its own (the same
 * question with that one place) and the answers are put in one table with a Place column. Places are never added together; an incident
 * is counted once, in its own place. The lines are the first place's (the caveat, the years, the latest month), and the title names every place.
 */
export function combineHatePlaces(hqs: HateQuestion[], build: HateBuild, execute: (sql: string) => unknown[][]): HateAnswer | HateDecline {
  const each = hqs.map((q) => answerHate(q, build, execute));
  const bad = each.find((a): a is HateDecline => a.kind === "hate-decline");
  if (bad) return bad;
  const answers = each as HateAnswer[];
  const first = answers[0];
  const labels = hqs.map((q) => hatePlaceLabel(q.place));
  const placeCol: ResultTable["columns"][number] = { binding: { kind: "grouping", dimension: "geo.place" }, header: "Place" };
  const columns = [placeCol, ...first.delivered.table.columns];
  const rows = answers.flatMap((a, i) => a.delivered.table.rows.map((r) => [labels[i], ...r]));
  // Each place's own sentence leads (its own figures); a line every place shares is said once, a line only some places have is said with its place.
  const head = answers.map((a) => a.delivered.text[0]).join(" ");
  const tail = answers.map((a) => a.delivered.text.slice(1).filter((t) => t !== HATE_SOURCE));
  // A count of incidents left out is that place's own, so it always names its place; any other line every place shares is said once.
  const own = (t: string) => /not counted/.test(t) || !tail.every((o) => o.includes(t));
  const lines: string[] = [];
  tail.forEach((ts, i) => ts.forEach((t) => {
    const line = own(t) ? `${labels[i]}: ${t}` : t;
    if (!lines.includes(line)) lines.push(line);
  }));
  return {
    ...first,
    meaning: { ...first.meaning, places: hqs.map((q) => q.place), groupings: ["place", ...first.meaning.groupings] },
    delivered: { table: { columns, rows }, text: [head, ...lines, HATE_SOURCE] },
  };
}

/** The postal state of an ORI, for a place named by agency (kept for callers that need it). */
export const hateStateOfOri = (ori: string) => ORI_STATE[ori.slice(0, 2)] ?? ori.slice(0, 2);
