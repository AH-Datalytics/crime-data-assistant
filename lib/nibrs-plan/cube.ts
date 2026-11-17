/**
 * The cube read side (2026-11-17): a plan whose unit set is exactly one cube cell family is counted from the precomputed summary cube instead
 * of from the raw segment tables. Behind a flag (NIBRS_CUBE=on and NIBRS_CUBE_ROOT); off by default, and then nothing here runs.
 *
 * The cube (built by the Model, one parquet per file year: <root>/canonical/cube/data_year=YYYY/data.parquet, with <root>/manifest.json) has one row per
 * (ori, month_key, unit, source, crime_group, attribute, value) with n_distinct_units and n_distinct_incidents. The counting contract:
 * units add across agencies, months, attribute values and data_year partitions (never across overlapping groups); incidents add across
 * agencies, months and partitions of one cell family but NOT across attribute values, so a plan that merges cube values and also asks for
 * incidents is not served from the cube.
 *
 * `cubeUnits` returns null whenever the plan is not exactly a cube cell (another condition, another attribute, a group the cube does not
 * hold, a year without a cube partition): the caller then keeps the raw statements, so every answer is the one the raw path gives.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";

const SCHEMA_VERSION = "cube-0.1";

export type CubeConfig = { root: string; years: number[]; /** on: answers read the cube; shadow: raw answers, the cube run beside them and compared (local and runner only). */ mode?: "on" | "shadow" };

/** The groups the cube holds, by the offense-code list the plan's measure carries (the same lists the Model pins by hash). */
export const CUBE_GROUPS: Record<string, string[]> = {
  person_crimes: ["09A", "09B", "11A", "11B", "11C", "11D", "13A", "13B", "13C", "36A", "36B", "100", "64A", "64B"],
  violent_crime_fbi6: ["09A", "11A", "11B", "11C", "120", "13A"],
  property_crime: ["200", "220", "23A", "23B", "23C", "23D", "23E", "23F", "23G", "23H", "240"],
  against_property: ["120", "200", "210", "220", "23A", "23B", "23C", "23D", "23E", "23F", "23G", "23H", "240", "250", "26A", "26B", "26C", "26D", "26E", "26F", "26G", "270", "280", "290", "510"],
};

/** unit x group x attribute the cube is asked for (the pilot's matrix: offender age; victim age/sex/race; arrestee age). */
const ATTRIBUTES: Record<string, string[]> = { offender: ["age"], victim: ["age", "sex", "race"], arrestee: ["age"] };
const VICTIM_GROUPS = new Set(["person_crimes", "violent_crime_fbi6", "property_crime", "against_property"]);

/** The cube's age bins and the integer ages each holds (NN, NB and BB sit with 1-17, as in the engine's own binning). */
const CUBE_AGE_BINS: { value: string; from: number; to: number }[] = [
  { value: "Under 18", from: 1, to: 17 }, { value: "18-24", from: 18, to: 24 }, { value: "25-34", from: 25, to: 34 }, { value: "35-44", from: 35, to: 44 },
  { value: "45-54", from: 45, to: 54 }, { value: "55-64", from: 55, to: 64 }, { value: "65+", from: 65, to: 99 },
];

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

let cached: { key: string; cfg: CubeConfig | null } | null = null;
const warned = new Set<string>();
const warnOnce = (key: string, why: string) => { if (!warned.has(key)) { warned.add(key); console.error(`[nibrs-cube] cube not used (raw statements instead): ${why}`); } };

/** The sha256 the Model records for a group: the JSON (Python's default separators) of the sorted code list. */
export const listSha256 = (codes: string[]): string => createHash("sha256").update(`[${[...codes].sort().map((c) => JSON.stringify(c)).join(", ")}]`).digest("hex");

/**
 * The cube this process may read: NIBRS_CUBE=on|shadow and NIBRS_CUBE_ROOT naming the cube folder (manifest.json and canonical/cube/data_year=YYYY).
 * `releaseRoot` is the canonical folder of the release being read: the cube must have been built from exactly that release. Null (raw statements
 * everywhere) when the flag is off, the manifest is missing or unfinished, or any check fails; a failed check is said once on stderr.
 */
export function cubeFromEnv(env: Record<string, string | undefined> = process.env, releaseRoot?: string): CubeConfig | null {
  const mode = env.NIBRS_CUBE === "on" || env.NIBRS_CUBE === "shadow" ? env.NIBRS_CUBE : null;
  if (!mode || !env.NIBRS_CUBE_ROOT) return null;
  const root = env.NIBRS_CUBE_ROOT.replace(/\\/g, "/").replace(/\/+$/, "");
  // The manifest's own stamp is part of the key: a rebuilt cube is noticed, and nothing else is read twice.
  let stamp = "none";
  try { const st = fs.statSync(`${root}/manifest.json`); stamp = `${st.mtimeMs}:${st.size}`; } catch { /* no manifest: the check below says so */ }
  const key = `${mode}:${root}:${releaseRoot ?? ""}:${stamp}`;
  if (cached && cached.key === key) return cached.cfg;
  let cfg: CubeConfig | null = null;
  try {
    const bad = (why: string) => { warnOnce(key, why); return null; };
    cfg = readCube(root, mode, releaseRoot, bad);
  } catch (e) { warnOnce(key, e instanceof Error ? e.message : String(e)); }
  cached = { key, cfg };
  return cfg;
}

function readCube(root: string, mode: "on" | "shadow", releaseRoot: string | undefined, bad: (why: string) => null): CubeConfig | null {
  // The manifest is written last: a folder without it is an unfinished build.
  const mf = `${root}/manifest.json`;
  if (!fs.existsSync(mf)) return bad("no manifest.json (an unfinished build)");
  const m = JSON.parse(fs.readFileSync(mf, "utf8")) as { schema_version?: string; source_manifest_sha256?: string; groups?: Record<string, { list_sha256?: string | null }>;
    years?: Record<string, unknown>; files?: Record<string, unknown> };
  if (m.schema_version !== SCHEMA_VERSION) return bad(`schema_version ${m.schema_version} is not ${SCHEMA_VERSION}`);
  // Built from this very release: the cube records the sha256 of the release's own manifest.json.
  if (!releaseRoot) return bad("the release being read is not known");
  const rm = `${releaseRoot.replace(/\\/g, "/").replace(/\/+$/, "")}/../manifest.json`;
  if (!fs.existsSync(rm)) return bad(`the release's manifest.json is not at ${rm}`);
  const releaseSha = createHash("sha256").update(fs.readFileSync(rm)).digest("hex");
  if (String(m.source_manifest_sha256 ?? "").toLowerCase() !== releaseSha) return bad(`the cube was built from another release (source_manifest_sha256 ${String(m.source_manifest_sha256).slice(0, 12)} is not the sha256 ${releaseSha.slice(0, 12)} of ${rm})`);
  // The group code lists in the cube are the ones this engine counts with.
  for (const [g, codes] of Object.entries(CUBE_GROUPS)) if (String(m.groups?.[g]?.list_sha256 ?? "").toLowerCase() !== listSha256(codes)) return bad(`the code list of ${g} differs from the engine's`);
  // File keys as the manifest writes them, with either slash.
  const listed = new Set(Object.keys(m.files ?? {}).map((k) => k.replace(/\\/g, "/")));
  const years = Object.keys(m.years ?? {}).map(Number).filter((y) => Number.isInteger(y) && listed.has(`canonical/cube/data_year=${y}/data.parquet`)
    && fs.existsSync(`${root}/canonical/cube/data_year=${y}/data.parquet`)).sort((a, b) => a - b);
  return years.length ? { root, years, mode } : bad("no data year of the manifest has its file");
}

/** The plan's age bins as a map from each cube age value to the plan's label; null when the plan's bins cut across a cube bin. */
export function ageMapping(bins: { label: string; from: number; to: number }[]): { map: Record<string, string>; merges: boolean } | null {
  const labelOf = (n: number) => bins.find((b) => b.from <= n && n <= b.to)?.label ?? "Outside the groups";
  // The cube lumps every integer outside 1-99 (0, 100 and up) with the non-numeric codes: a plan bin that reaches them cannot be served.
  if (bins.some((b) => b.from <= 0 || b.to >= 100)) return null;
  const map: Record<string, string> = { Unknown: "Unknown", "Outside the groups": "Outside the groups" };
  for (const c of CUBE_AGE_BINS) {
    const labels = new Set<string>();
    for (let n = c.from; n <= c.to; n++) labels.add(labelOf(n));
    if (labels.size !== 1) return null;
    map[c.value] = [...labels][0];
  }
  const targets = Object.values(map);
  return { map, merges: new Set(targets).size !== targets.length };
}

export type CubeAsk = {
  cfg: CubeConfig;
  /** The measure id's kind and its offense codes ("offenders", ["09A", ...]); "arrests.all_crime" has no codes. */
  kind: "offenders" | "victims" | "arrests";
  codes: string[] | null;
  allCrimeArrests: boolean;
  /** The one grouping attribute (offender.age, victim.sex ...), with the plan's age bins when it is an age; none for a total. */
  attribute: { dimension: string; bins?: { label: string; from: number; to: number }[] } | null;
  /** The plan counts incidents beside the units. */
  wantsIncidents: boolean;
  /** Data years the raw statement would read; every one needs a cube partition. */
  years: number[];
  /** Any condition at all (filter, own condition, clearance, join): the cube holds none. */
  conditioned: boolean;
};

/** The unit CTE for the cube: columns ori, ym, g0 (when grouped), w (units), wi (incidents); or null when the cube cannot serve the plan. */
export function cubeUnits(a: CubeAsk): { sql: string } | null {
  if (a.conditioned) return null;
  if (!a.years.length || !a.years.every((y) => a.cfg.years.includes(y))) return null;
  const unit = a.kind === "offenders" ? "offender" : a.kind === "victims" ? "victim" : "arrestee";
  let group: string;
  if (a.allCrimeArrests) group = "all_crime";
  else {
    const set = new Set(a.codes ?? []);
    const hit = Object.entries(CUBE_GROUPS).find(([, c]) => c.length === set.size && c.every((x) => set.has(x)));
    if (!hit) return null;
    group = hit[0];
    if (unit === "victim" && !VICTIM_GROUPS.has(group)) return null;
  }
  if (unit === "offender" && a.allCrimeArrests) return null;
  let value = "'none'";
  let attrName = "none";
  let merges = false;
  if (a.attribute) {
    const [owner, name] = a.attribute.dimension.split(".");
    const owned = owner === (unit === "arrestee" ? "arrestee" : unit);
    if (!owned || !ATTRIBUTES[unit]?.includes(name)) return null;
    if (name === "age") {
      if (!a.attribute.bins) return null;
      const m = ageMapping(a.attribute.bins);
      if (!m) return null;
      merges = m.merges;
      attrName = "age_bin";
      value = `CASE value ${Object.entries(m.map).map(([k, v]) => `WHEN ${q(k)} THEN ${q(v)}`).join(" ")} ELSE 'Outside the groups' END`;
    } else {
      // The engine calls a missing or blank sex or race "U"; the cube keeps the raw codes and calls them "(blank)".
      attrName = name;
      value = `CASE WHEN value = '(blank)' THEN 'U' ELSE value END`;
      merges = true; // "(blank)" and a real "U" become one category
    }
  }
  if (merges && a.wantsIncidents) return null;
  const files = a.years.map((y) => q(`${a.cfg.root}/canonical/cube/data_year=${y}/data.parquet`)).join(", ");
  const sources = unit === "arrestee" && a.allCrimeArrests ? "source IN ('A', 'B')" : "source = 'A'";
  const sql = `SELECT ori, month_key AS ym${a.attribute ? `, ${value} AS g0` : ""}, CAST(SUM(n_distinct_units) AS BIGINT) AS w, CAST(SUM(n_distinct_incidents) AS BIGINT) AS wi
      FROM read_parquet([${files}], hive_partitioning = true)
      WHERE unit = ${q(unit)} AND ${sources} AND crime_group = ${q(group)} AND attribute = ${q(attrName)}
      GROUP BY ALL`;
  return { sql };
}

/**
 * Shadow mode: the statement the engine runs is the raw one, led by a comment that carries the cube's statement. The executor
 * (`runShadow`, lib/nibrs-shadow/duckdb.ts) runs both, writes a line to NIBRS_CUBE_LOG when their rows differ, and returns the raw rows.
 */
const SHADOW_OPEN = "/* NIBRS_CUBE_SHADOW\n";
const SHADOW_CLOSE = "\nNIBRS_CUBE_SHADOW_END */\n";
export const shadowSql = (raw: string, cube: string): string => `${SHADOW_OPEN}${cube.replace(/\*\//g, "* /")}${SHADOW_CLOSE}${raw}`;
export function splitShadow(sql: string): { raw: string; cube: string } | null {
  if (!sql.startsWith(SHADOW_OPEN)) return null;
  const end = sql.indexOf(SHADOW_CLOSE);
  return end < 0 ? null : { cube: sql.slice(SHADOW_OPEN.length, end), raw: sql.slice(end + SHADOW_CLOSE.length) };
}
/** Run a shadowed statement: raw rows come back; a difference or a failure of the cube side is logged, never thrown. */
export function runShadow(sql: string, run: (s: string) => unknown[][], log: (line: string) => void): unknown[][] | null {
  const sh = splitShadow(sql);
  if (!sh) return null;
  const rows = run(sh.raw);
  try {
    const got = run(sh.cube);
    if (JSON.stringify(got) !== JSON.stringify(rows)) log(JSON.stringify({ kind: "mismatch", rawRows: rows.length, cubeRows: got.length, raw: sh.raw.slice(0, 400), cube: sh.cube.slice(0, 400) }));
  } catch (e) { log(JSON.stringify({ kind: "cube-error", error: e instanceof Error ? e.message.slice(0, 500) : String(e), cube: sh.cube.slice(0, 400) })); }
  return rows;
}
