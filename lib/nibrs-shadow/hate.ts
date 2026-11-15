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
import { firstNeeded, monthRange, rollingSums } from "./rolling";

export const HATE_FIRST_YEAR = 1991;
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
const MODERN_FROM: Record<string, number> = { "14": 2013, "16": 2013, "28": 2015, "29": 2015, "31": 2015, "33": 2015, "43": 2013, "61": 2013, "62": 2012, "71": 2013, "72": 2012,
  "81": 2015, "82": 2015, "83": 2015, "84": 2015, "85": 2015, "51": 1997, "52": 1997 };

export type HatePlace = { kind: "agency"; ori: string; label: string } | { kind: "state"; code: string } | { kind: "national" };
export type HateQuestion = {
  place: HatePlace; /** Months inclusive, cut to the data's first year and last complete month. */ from: string; to: string;
  grain: "total" | "year" | "month" | "rolling"; window?: number; bias: { code: string; name: string } | null;
  /** The first year asked when it was before the data start (the answer says so). */ askedFrom?: string;
  /** Said when the span asked reached past the last complete month. */ cutAt?: string;
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
export function hateQuestionOf(plan: NibrsPlan, period: { from: string; to: string }, build: HateBuild): HateQuestion | { why: string } {
  if (plan.measures.length !== 1 || !/\.hate_crime$/.test(plan.measures[0].id)) return { why: "not a hate crime count" };
  const stats = plan.statistics.map((s) => s.kind);
  if (!(stats.length === 1 && stats[0] === "count")) return { why: "a rate or another statistic" };
  const roll = plan.transforms.filter((t) => t.kind === "rolling");
  if (plan.transforms.length > roll.length || roll.length > 1) return { why: "a change or a ranking" };
  if (plan.geography.places.length !== 1) return { why: "several places" };
  const p = plan.geography.places[0];
  const place: HatePlace | null = p.kind === "national" ? { kind: "national" } : p.kind === "state" ? { kind: "state", code: p.code }
    : p.kind === "agency" ? { kind: "agency", ori: p.ori, label: p.label } : null;
  if (!place) return { why: "a county or a set of agencies" };
  const time = plan.groupings.filter((g) => g.dimension.startsWith("time."));
  const cats = plan.groupings.filter((g) => !g.dimension.startsWith("time."));
  if (cats.length || time.length > 1 || time.some((g) => g.dimension !== "time.year" && g.dimension !== "time.month")) return { why: "this breakdown" };
  if (plan.filters.length > 1) return { why: "several conditions" };
  let bias: HateQuestion["bias"] = null;
  const f = plan.filters[0];
  if (f) {
    const w = f.kind === "exists" && !f.negate && f.entity === "offense_bias" && f.where.length === 1 && f.where[0].kind === "attribute" && f.where[0].dimension === "offense_bias.bias" && f.where[0].op === "in"
      ? f.where[0] : null;
    const code = w && w.values?.length === 1 ? String(w.values[0]) : null;
    if (!code || !BIAS_NAMES[code]) return { why: "a bias this source does not name" };
    bias = { code, name: BIAS_NAMES[code] };
  }
  const first = `${HATE_FIRST_YEAR}-01`;
  const to = period.to > build.latestMonth ? build.latestMonth : period.to;
  if (to < first) return { why: "before the data start" };
  if (period.from > build.latestMonth) return { why: "after the latest month" };
  const from = period.from < first ? first : period.from;
  if (bias && MODERN_FROM[bias.code] && Number(from.slice(0, 4)) < MODERN_FROM[bias.code]) return { why: "a bias whose meaning changed in the years asked" };
  const grain = roll.length ? "rolling" : time[0]?.dimension === "time.month" ? "month" : time[0]?.dimension === "time.year" ? "year" : "total";
  const window = roll.length ? (roll[0] as { months: number }).months : undefined;
  return { place, from, to, grain, ...(window ? { window } : {}), bias,
    ...(period.from < first ? { askedFrom: period.from.slice(0, 4) } : {}), ...(period.to > to ? { cutAt: to } : {}) };
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const table = (b: HateBuild) => `read_parquet(${q(`${b.root}/hate_crime_incident/data.parquet`)})`;

/** One row per month (or year, or total) of the incidents in the span: the distinct ORI + incident number. */
export function hateSql(hq: HateQuestion, build: HateBuild, from = hq.from): string {
  const place = hq.place.kind === "agency" ? `ori = ${q(hq.place.ori)}` : hq.place.kind === "state" ? `state = ${q(hq.place.code)}` : "TRUE";
  const bias = hq.bias ? ` AND bias_code = ${q(hq.bias.code)}` : "";
  const ymExpr = "year(incident_date) * 100 + month(incident_date)";
  const lo = Number(from.slice(0, 4)) * 100 + Number(from.slice(5, 7)), hi = Number(hq.to.slice(0, 4)) * 100 + Number(hq.to.slice(5, 7));
  const key = hq.grain === "year" ? "year(incident_date)" : hq.grain === "month" || hq.grain === "rolling" ? ymExpr : null;
  return `SELECT ${key ? `${key} AS k, ` : ""}count(DISTINCT ori || '|' || incident_number) AS n FROM ${table(build)} WHERE ${place}${bias} AND ${ymExpr} BETWEEN ${lo} AND ${hi}`
    + `${key ? " GROUP BY k ORDER BY k" : ""}`;
}

const ucFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ym2 = (v: number) => `${Math.floor(v / 100)}-${String(v % 100).padStart(2, "0")}`;

export function answerHate(hq: HateQuestion, build: HateBuild, execute: (sql: string) => unknown[][]): HateAnswer | HateDecline {
  const where = hq.place.kind === "agency" ? hq.place.label : hq.place.kind === "state" ? stateName(hq.place.code) : "the United States";
  const what = hq.bias ? `${hq.bias.name} hate crimes` : "hate crimes";
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
    text.push(/^\d{4}$/.test(span) ? `${head}: ${fmt(n)} in ${where} in ${span}.` : `${head}: ${fmt(n)} in ${where}, ${span}.`);
  } else if (hq.grain === "year") {
    const got = new Map(execute(hateSql(hq, build)).map((r) => [Number(r[0]), Number(r[1])]));
    columns.push({ binding: { kind: "grouping", dimension: "time.year" }, header: "Year" }, { binding: { kind: "statistic", as: "count" }, header: head });
    for (let y = fromY; y <= toY; y++) rows.push([String(y), got.get(y) ?? 0]);
    text.push(`${head} in ${where} by year, ${span}.`);
  } else {
    const start = hq.grain === "rolling" ? firstNeeded(hq.from, hq.window!) : hq.from;
    const got = new Map(execute(hateSql(hq, build, start)).map((r) => [ym2(Number(r[0])), Number(r[1])]));
    const cells = monthRange(start, hq.to).map((ym) => ({ ym, value: ym < `${HATE_FIRST_YEAR}-01` ? null : got.get(ym) ?? 0 }));
    if (hq.grain === "month") {
      columns.push({ binding: { kind: "grouping", dimension: "time.month" }, header: "Month" }, { binding: { kind: "statistic", as: "count" }, header: head });
      for (const c of cells) rows.push([c.ym, c.value]);
      text.push(`${head} in ${where} by month, ${span}.`);
    } else {
      // A window is complete from the data's first month on; the first months of 1991 have none and are not shown (no blank rows, no
      // gap sentence: the start line says where the data begin). Months with no row are 0 here, as the reporting caveat says.
      const roll = rollingSums(cells, hq.window!, hq.from, hq.to).filter((r) => r.value !== null);
      columns.push({ binding: { kind: "grouping", dimension: "time.month" }, header: "Month" }, { binding: { kind: "statistic", as: "count" }, header: `${head}, rolling ${hq.window} months` });
      for (const r of roll) rows.push([r.ym, r.value]);
      text.push(`${head} in ${where}, rolling ${hq.window} months, ${span}.`);
    }
  }
  text.push(HATE_REPORTING_CAVEAT);
  if (hq.askedFrom) text.push(`Hate crime data here start in ${HATE_FIRST_YEAR}, so ${hq.askedFrom} through ${HATE_FIRST_YEAR - 1} aren't included.`);
  // The data's last complete month ends the answer when it is not a December: the year (or span) asked may reach past it.
  if (hq.to === build.latestMonth && !hq.to.endsWith("-12")) {
    const [y, m, d] = build.latestDate.split("-").map(Number);
    const day = `${monthName(`${y}-${String(m).padStart(2, "0")}`).split(" ")[0]} ${d}, ${y}`;
    text.push(`Hate crime data here run through ${day}, so the answer ends with ${monthName(hq.to)}, the last complete month.`);
  }
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

/** The postal state of an ORI, for a place named by agency (kept for callers that need it). */
export const hateStateOfOri = (ori: string) => ORI_STATE[ori.slice(0, 2)] ?? ori.slice(0, 2);
