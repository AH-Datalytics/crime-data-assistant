/**
 * Agencies under two IDs in the Crime Index files (crimeindex-ori-crosswalk.json; loop 2 finding 3 and the historical scan of 2026-11-22).
 * The same table is copied into the blind checker's folder, so both read each agency under one ID:
 *   current           every row of `id` in current_final and current_crime is read as `same_as`;
 *   historical_crime  in agency_crime each ID owns the years in `owns`: a year's row is kept only from its owner, then read as `same_as`,
 *                     so the agency has exactly one row a year and nothing is counted twice.
 * An ID asked for is mapped the same way (`canonicalOri`).
 */
import CROSSWALK from "./crimeindex-ori-crosswalk.json";

type Pair = { files: string; agency: string; same_as: string; id?: string; owns?: { id: string; from: number; to: number }[] };
const PAIRS = CROSSWALK.pairs as Pair[];
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

let CURRENT = new Map(PAIRS.filter((p) => p.files === "current").map((p) => [p.id!, p.same_as]));
let HISTORICAL = PAIRS.filter((p) => p.files === "historical_crime");
let HIST_IDS = new Map(HISTORICAL.flatMap((p) => p.owns!.map((o) => [o.id, p.same_as] as [string, string])));

/** Tests whose stub executors read the SQL text (agency IDs, "year BETWEEN") turn the table off; its own test checks it on. */
export function crosswalkOffForTests(): void {
  CURRENT = new Map();
  HISTORICAL = [];
  HIST_IDS = new Map();
}

/** The ID an agency is read under in a file, for an ID asked for. */
export function canonicalOri(ori: string, file: "current" | "historical_crime" = "current"): string {
  return (file === "current" ? CURRENT.get(ori) : HIST_IDS.get(ori)) ?? ori;
}

/** A Crime Index current file (current_final or current_crime) as a table whose rows carry each agency's one ID. */
export function currentTableSql(root: string, table: "current_final" | "current_crime"): string {
  const src = `read_parquet(${q(`${root}/${table}.parquet`)})`;
  if (!CURRENT.size) return src;
  return `(SELECT * REPLACE (CASE ori ${[...CURRENT].map(([id, as]) => `WHEN ${q(id)} THEN ${q(as)}`).join(" ")} ELSE ori END AS ori) FROM ${src})`;
}

/** agency_crime as a table with each crosswalked agency's rows kept from the ID that owns each year, all read as one ID. */
export function agencyCrimeSql(root: string): string {
  const src = `read_parquet(${q(`${root}/agency_crime.parquet`)})`;
  if (!HISTORICAL.length) return src;
  const owned = HISTORICAL.flatMap((p) => p.owns!.map((o) => `(ori = ${q(o.id)} AND year BETWEEN ${o.from} AND ${o.to})`));
  const ids = [...HIST_IDS.keys()].map(q).join(", ");
  return `(SELECT * REPLACE (CASE ori ${[...HIST_IDS].map(([id, as]) => `WHEN ${q(id)} THEN ${q(as)}`).join(" ")} ELSE ori END AS ori) FROM ${src} `
    + `WHERE ori IS NULL OR ori NOT IN (${ids}) OR ${owned.join(" OR ")})`;
}
