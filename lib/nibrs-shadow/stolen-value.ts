/**
 * The value of stolen property: total, average and median, for one agency or one state, by year and by property type (Jeff 2026-11-24, option A, rule 1):
 *
 *   "total value of stolen property in Denver in 2025"
 *   "average value of stolen property by property type in Denver 2025"
 *   "median value of shoplifted goods per year since 2021"
 *
 * The figures are the NIBRS property segments of the place with the loss type "stolen" (7), one row for each property description of an incident.
 * The total adds every record. The average and the median leave out the records with no value (a $0 or blank value is "unknown", not a
 * worthless thing), and the answer says how many were left out. Shoplifting is the offense 23C: the incidents that had one.
 */
import type { NibrsPlan } from "../nibrs-plan/plan";
import type { AnswerStatement } from "../nibrs-plan/result";
import { deliverTable, fmt, periodWords } from "./deliver";
import { stateName } from "./places";
import { NOT_YET } from "./wording";
import type { ShadowDeps, ShadowOutcome } from "./answer";

type Decline = (explanation: string, detail?: string) => ShadowOutcome;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** The 2-digit NIBRS property description codes (the table's own words, as in lib/nibrs-claude.ts). */
export const PROPERTY_NAMES: Record<string, string> = {
  "01": "Aircraft", "02": "Alcohol", "03": "Automobiles", "04": "Bicycles", "05": "Buses", "06": "Clothes and Furs", "07": "Computer Hardware and Software",
  "08": "Consumable Goods", "09": "Credit and Debit Cards", "10": "Drugs and Narcotics", "11": "Drug Equipment", "12": "Farm Equipment", "13": "Firearms",
  "14": "Gambling Equipment", "15": "Industrial Equipment", "16": "Household Goods", "17": "Jewelry and Precious Metals", "18": "Livestock", "19": "Merchandise",
  "20": "Money", "21": "Negotiable Instruments", "22": "Non-Negotiable Instruments", "23": "Office Equipment", "24": "Other Motor Vehicles", "25": "Purses and Wallets",
  "26": "Radios, TVs and VCRs", "27": "Recordings", "28": "Recreational Vehicles", "29": "Structures, Single Dwelling", "30": "Structures, Other Residence",
  "31": "Structures, Other Commercial", "32": "Structures, Other Industrial", "33": "Structures, Public", "34": "Structures, Storage", "35": "Structures, Other",
  "36": "Tools", "37": "Trucks", "38": "Vehicle Parts", "39": "Watercraft", "41": "Aircraft Parts and Accessories", "42": "Artistic Supplies and Accessories",
  "43": "Building Materials", "44": "Camping, Hunting and Fishing Equipment", "45": "Chemicals", "46": "Collections and Collectibles", "47": "Crops",
  "48": "Documents", "49": "Explosives", "59": "Firearm Accessories", "64": "Fuel", "65": "Identity Documents", "66": "Identity, Intangible",
  "67": "Law Enforcement Equipment", "68": "Lawn, Yard and Garden Equipment", "69": "Logging Equipment", "70": "Medical Equipment", "71": "Metals (Non-Precious)",
  "72": "Musical Instruments", "73": "Pets", "74": "Photographic and Optical Equipment", "75": "Portable Electronic Communications", "76": "Recreational and Sports Equipment",
  "77": "Other", "78": "Trailers", "79": "Watercraft Equipment, Parts and Accessories", "80": "Weapons, Other", "88": "Pending Inventory", "99": "Special",
};
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** True when the plan is a question about the value of stolen property (the plan layer's property value measure). */
export const isStolenValue = (plan: NibrsPlan) => plan.measures.some((m) => m.id === "property.property_value");

export function answerStolenValue(plan: NibrsPlan, main: "total_value" | "average_value" | "median_value", period: { from: string; to: string }, yearSet: number[] | null,
  deps: ShadowDeps, statements: AnswerStatement[], readings: string[], decline: Decline, percentiles = false): ShadowOutcome {
  const place = plan.geography.places[0];
  if (!place || plan.geography.places.length !== 1 || (place.kind !== "agency" && place.kind !== "state" && place.kind !== "national"))
    return decline("This isn't available: the value of stolen property for this kind of place. Name one city, agency or state.");
  // An open range ("since 2021", "from 2015") ends at the latest data month and starts where the data starts: the whole years it holds.
  const lastMonth = deps.release.lastMonth;
  const openEnd = !yearSet && !period.to.endsWith("-12") && period.to >= lastMonth;
  if (!(period.from.endsWith("-01") && (period.to.endsWith("-12") || openEnd)) && !yearSet) return decline("This isn't available: the value of stolen property for part of a year. Ask for whole years.");
  const fromYear = Number(period.from.slice(0, 4)), toYear = Number(period.to.slice(0, 4)) - (openEnd ? 1 : 0);
  const built = new Set(deps.target.builtYears);
  let years = yearSet ? [...yearSet].sort((a, b) => a - b) : Array.from({ length: toYear - fromYear + 1 }, (_, i) => fromYear + i);
  const trimmed: string[] = [];
  if (!yearSet) {
    const firstBuilt = Math.min(...built);
    const early = years.filter((y) => y < firstBuilt);
    if (early.length && years.length > early.length) { years = years.filter((y) => y >= firstBuilt); trimmed.push(`The data starts in ${firstBuilt}, so ${early.length === 1 ? early[0] : `${early[0]} to ${early[early.length - 1]}`} is not shown.`); }
    if (openEnd) trimmed.push(`${Number(period.to.slice(0, 4))} is not shown: the data covers only part of it.`);
  }
  const missing = years.filter((y) => !built.has(y));
  if (missing.length || !years.length) return decline(`No data is built for ${missing.join(", ") || "those years"}.`);
  const byType = plan.groupings.some((g) => g.dimension === "property.description");
  if (byType && years.length > 1) return decline("This isn't available: the value of stolen property by property type over several years. Ask for one year.");
  const isShop = (f: NibrsPlan["filters"][number]) => f.kind === "exists" && f.entity === "offense" && f.where.length === 1
    && ((w) => w.kind === "attribute" && w.dimension === "offense.offense" && w.values?.length === 1 && w.values[0] === "23C")(f.where[0]);
  const shop = plan.filters.some(isShop);
  // Only the stolen loss type (7) is answered; recovered, seized or damaged property has its own values and is not swapped for it.
  const isStolenLoss = (f: NibrsPlan["filters"][number]) => f.kind === "attribute" && f.dimension === "property.loss_type" && f.values?.length === 1 && String(f.values[0]) === "7";
  const other = plan.filters.filter((f) => !(isShop(f) || isStolenLoss(f)));
  if (other.length) return decline(NOT_YET, "stolen value: a condition this answer does not apply");
  // One measure only: the value of the property. A second measure (motor vehicles, a count of crimes) is not answered by a single figure.
  // (The average's own record count, property_value_segments, is the one companion measure.)
  if (plan.measures.some((m) => m.id !== "property.property_value" && m.id !== "property.property_value_segments"))
    return decline("This isn't available: the value of stolen property together with another count. Ask for them one at a time.");

  const where = place.kind === "agency" ? place.label : place.kind === "state" ? stateName(place.code) : "the United States";
  const when = periodWords(`${years[0]}-01`, `${years[years.length - 1]}-12`);
  const stolen = shop ? "shoplifted goods" : "stolen property";
  const parts = years.map((y) => `${q(`${deps.target.root}/property/data_year=${y}/data.parquet`)}`);
  const offenseParts = years.map((y) => `${q(`${deps.target.root}/offense/data_year=${y}/data.parquet`)}`);
  const scope = place.kind === "national" ? "TRUE" : place.kind === "agency" ? `p.ori = ${q(place.ori)}` : `p.ori IN (SELECT ori FROM read_parquet(${q(`${deps.target.root}/agency/data.parquet`)}) WHERE state = ${q(place.code)})`;
  const shopCond = shop ? ` AND EXISTS (SELECT 1 FROM read_parquet([${offenseParts.join(", ")}], hive_partitioning = true) o WHERE o.data_year = p.data_year AND o.ori = p.ori AND o.incident_num = p.incident_num AND o.offense_code = '23C')` : "";
  // A range with no yearly breakdown asked for is one figure over the whole period, not one per year.
  const byYear =plan.groupings.some((g) => g.dimension.startsWith("time.")) && !byType;
  const sql = `WITH v AS (SELECT ${byYear || years.length === 1 ? "p.data_year" : String(years[0])} AS y, p.property_description AS d, try_cast(p.value AS BIGINT) AS v
      FROM read_parquet([${parts.join(", ")}], hive_partitioning = true) p
      WHERE p.loss_type = '7' AND ${scope}${shopCond})
    SELECT y, ${byType ? "d" : "NULL"} AS d, CAST(count(*) AS BIGINT) AS records, CAST(coalesce(sum(v), 0) AS BIGINT) AS total,
      CAST(count(*) FILTER (WHERE coalesce(v, 0) <= 0) AS BIGINT) AS left_out,
      CAST(avg(v) FILTER (WHERE v > 0) AS DOUBLE) AS average, CAST(median(v) FILTER (WHERE v > 0) AS DOUBLE) AS median,
      CAST(quantile_cont(v, 0.1) FILTER (WHERE v > 0) AS DOUBLE) AS p10, CAST(quantile_cont(v, 0.25) FILTER (WHERE v > 0) AS DOUBLE) AS p25,
      CAST(quantile_cont(v, 0.75) FILTER (WHERE v > 0) AS DOUBLE) AS p75, CAST(quantile_cont(v, 0.9) FILTER (WHERE v > 0) AS DOUBLE) AS p90
    FROM v GROUP BY ALL ORDER BY y, ${byType ? "total DESC, d" : "y"}`;
  const got = deps.execute(sql) ?? [];
  type R = { y: number; d: string | null; records: number; total: number; leftOut: number; average: number | null; median: number | null; p: (number | null)[] };
  const rows: R[] = got.map((r) => ({ y: Number(r[0]), d: r[1] === null ? null : String(r[1]), records: Number(r[2]), total: Number(r[3]), leftOut: Number(r[4]),
    average: r[5] === null || r[5] === undefined ? null : Number(r[5]), median: r[6] === null || r[6] === undefined ? null : Number(r[6]),
    p: [7, 8, 9, 10].map((i) => (r[i] === null || r[i] === undefined ? null : Number(r[i]))) }));
  if (!rows.length) return decline(`No property was recorded as stolen ${shop ? "in shoplifting incidents " : ""}for ${where} in ${when}.`);

  const grouping = byType ? { dimension: "property.description", header: "Property type" } : byYear && years.length > 1 ? { dimension: "time.year", header: "Year" } : null;
  const label = (r: R) => (byType ? (PROPERTY_NAMES[r.d ?? ""] ?? `Code ${r.d}`) : String(r.y));
  const stat = main === "average_value" ? { as: "average", header: "Average Value ($)" } : main === "median_value" ? { as: "median", header: "Median Value ($)" } : { as: "total", header: "Total Value ($)" };
  const val = (r: R) => (main === "average_value" ? r.average : main === "median_value" ? r.median : r.total);
  const all: Support[] = [
    { as: "total", header: "Total Value ($)", cells: rows.map((r) => ({ value: r.total, status: "VALUE" })) },
    { as: "average", header: "Average Value ($)", cells: rows.map((r) => ({ value: r.average === null ? null : Math.round(r.average), status: r.average === null ? "UNAVAILABLE" : "VALUE" })) },
    { as: "median", header: "Median Value ($)", cells: rows.map((r) => ({ value: r.median === null ? null : Math.round(r.median), status: r.median === null ? "UNAVAILABLE" : "VALUE" })) },
    { as: "records", header: "Property records", cells: rows.map((r) => ({ value: r.records, status: "VALUE" })) },
    { as: "left_out", header: "Records with no value", cells: rows.map((r) => ({ value: r.leftOut, status: "VALUE" })) },
  ];
  const pct: Support[] = percentiles ? [["p10", "10th Percentile Value ($)", 0], ["p25", "25th Percentile Value ($)", 1], ["p75", "75th Percentile Value ($)", 2], ["p90", "90th Percentile Value ($)", 3]]
    .map(([as, header, i]) => ({ as: as as string, header: header as string, cells: rows.map((r) => { const x = r.p[i as number]; return { value: x === null ? null : Math.round(x), status: x === null ? "UNAVAILABLE" : "VALUE" }; }) })) : [];
  const supports = [...pct, ...all].filter((s) => s.as !== stat.as);
  const plan2: NibrsPlan = { ...plan, filters: plan.filters, statistics: [stat, ...supports].map((s) => ({ kind: "count" as const, as: s.as, measure: plan.measures[0].as })),
    groupings: grouping ? [{ dimension: grouping.dimension, unknown: "visible" as const, absent: "show" as const }] : [] };
  const leftOutTotal = rows.reduce((n, r) => n + r.leftOut, 0);
  const wording = main === "average_value" ? "average" : main === "median_value" ? "median" : "total";
  const noun = (n: number) => `${fmt(n)} ${n === 1 ? "record" : "records"}`;
  const lines: string[] = [];
  if (!grouping) {
    const r = rows[0];
    const v = val(r);
    lines.push(v === null ? `No ${wording} value of ${stolen} is given for ${where} in ${when}: every one of the ${noun(r.records)} has no value recorded.`
      : `The ${wording} value of ${stolen} in ${where} in ${when} was ${money(v)}${main === "total_value" ? `, over ${noun(r.records)}` : ` per record, over ${noun(r.records - r.leftOut)} with a value`}.`);
  } else lines.push(`${wording[0].toUpperCase()}${wording.slice(1)} Value of ${stolen[0].toUpperCase()}${stolen.slice(1)} by ${grouping.header}, ${where}, ${when}`);
  lines.push(main === "total_value" ? "The total adds every record, including those with no value recorded."
    : `The ${wording} leaves out ${noun(leftOutTotal)} with a $0 or blank value (value not known); the total includes them.`);
  if (main === "total_value" && leftOutTotal) lines.push(`${noun(leftOutTotal)} had a $0 or blank value.`);
  if (percentiles) lines.push("The 10th, 25th, 50th (median), 75th and 90th percentiles are of the records with a value.");
  lines.push(...trimmed, "Counts each property record of an incident that was recorded as stolen.", "Includes all agencies.");
  const delivered = deliverTable(plan2, grouping, stat, rows.map((r) => ({ key: grouping ? label(r) : null, value: val(r) === null ? null : Math.round(val(r) as number), status: val(r) === null ? "UNAVAILABLE" : "VALUE" })),
    lines, statements, deps.release.id, readings, supports);
  if (delivered.contractProblems.length) return decline(NOT_YET, `answer contract: ${delivered.contractProblems.join("; ")}`);
  const text = [...lines, "Source: NIBRS."];
  return { kind: "answer", plan: plan2, period, sql, delivered: { ...delivered, text, headline: text[0] } };
}
type Support = { as: string; header: string; cells: { value: number | string | null; status: string }[] };
