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
const CODE_SCHEMA_VERSION = "cube-code-0.1";
const OFFENSE_SCHEMA_VERSION = "cube-offense-0.1";
const WEAPON_SCHEMA_VERSION = "cube-weapon-0.1";

/** The per-offense-code cube (a separate product, schema cube-code-0.1): the codes its manifest lists and the file years it holds. */
export type CodeCube = { root: string; years: number[]; codes: Set<string>; /** Built from offense_codes_v2.json (Model, cube 3): every unit also has ethnicity. */ ethnicity?: boolean };
/**
 * The offense-and-incident cube (cube 1, schema cube-offense-0.1): one row per (ori, month, offense code, attribute, value) with the offenses and the distinct incidents of the cell;
 * the attributes it holds (incident_hour, location_type, clearance_type) come from its manifest, and `codes` are every code it was built for.
 */
export type OffenseCube = { root: string; years: number[]; codes: Set<string>; attributes: string[] };
/** The weapon cube (schema cube-weapon-0.1): the same cell shape as the offense cube, with the attributes weapon (an offense is in the cell of EACH of its weapon codes) and firearm (Y or N). */
export type WeaponCube = OffenseCube;
/** `root` and `years` are the crime-group cube (empty when only the code cube is set); `code` is the per-offense-code cube. */
export type CubeConfig = { root: string; years: number[]; /** on: answers read the cube; shadow: raw answers, the cube run beside them and compared (local and runner only). */ mode?: "on" | "shadow"; code?: CodeCube; /** The offense-and-incident cube (cube 1). */ offense?: OffenseCube; /** The weapon cube. */ weapon?: WeaponCube; /** The group cube is crime_groups_v4 (Model, cube 3): offender, victim and arrestee carry age, sex, race and ethnicity. */ groupV4?: boolean };

/** The groups the cube holds, by the offense-code list the plan's measure carries (the same lists the Model pins by hash). */
export const CUBE_GROUPS: Record<string, string[]> = {
  person_crimes: ["09A", "09B", "11A", "11B", "11C", "11D", "13A", "13B", "13C", "36A", "36B", "100", "64A", "64B"],
  violent_crime_fbi6: ["09A", "11A", "11B", "11C", "120", "13A"],
  property_crime: ["200", "220", "23A", "23B", "23C", "23D", "23E", "23F", "23G", "23H", "240"],
  against_property: ["120", "200", "210", "220", "23A", "23B", "23C", "23D", "23E", "23F", "23G", "23H", "240", "250", "26A", "26B", "26C", "26D", "26E", "26F", "26G", "270", "280", "290", "510"],
  // Group cube v2 (Model ce9e942) composites: each is ONE group of its codes, so a victim or offender linked to two of the codes counts once.
  // They overlap the groups above and each other: cells are never added across groups.
  homicide: ["09A", "09B"],
  rape: ["11A", "11B", "11C"],
  sex_offense: ["11A", "11B", "11C", "11D", "36A", "36B"],
  assault_offenses: ["13A", "13B", "13C"],
};
/** The groups file the Model builds the cube from: its version and the sha256 of crime_groups_v2.json at ce9e942. */
export const GROUPS_VERSION = "crime_groups_v2";
export const GROUPS_FILE_SHA256 = "b5cf4cf253bfecc27182dfc7d4788cd6b11a0ad9fdd65a14aa51000f83c58867";
/** Group cube v4 (cube 3): the same nine groups, more attributes (offender, victim, arrestee: age, sex, race, ethnicity); built only through nibrs_model.cube_products. */
export const GROUPS_VERSION_V4 = "crime_groups_v4";
export const GROUPS_FILE_SHA256_V4 = "0e8b27788f49dcf86412bbe1b9e9177bd072914d48a4a32a26acd5b4e68822b9";
/** Code cube v2 (cube 3): the 85 v1 codes unchanged, ethnicity added for every unit. */
export const CODE_VERSION_V2 = "offense_codes_v2";
export const CODE_FILE_SHA256_V2 = "446dc02c016fe8acecbda6d1cc623327afbf6b7e5fee9ffdca9e8bfc594b7a03";
/** Offense-and-incident cube v1 (cube 1): the file the Model builds it from. */
export const OFFENSE_VERSION_V1 = "offense_incident_v1";
export const OFFENSE_FILE_SHA256_V1 = "4eae648cdd1a4d7a0728c4dc01d85779a37cd986a524a45600d2ca19c608e74a";
const OFFENSE_ATTRIBUTES_V1 = ["incident_hour", "location_type", "clearance_type"];
/** Weapon cube v1: the file the Model builds it from (weapons from the canonical offense_weapon table). */
export const WEAPON_VERSION_V1 = "offense_weapon_v1";
export const WEAPON_FILE_SHA256_V1 = "c72d8aeb4fb2a7716f23c592b4e04aa004909a10ffa3aeea5fcdaf70de06660e";
const WEAPON_ATTRIBUTES_V1 = ["weapon", "firearm"];

/** unit x group x attribute the cube is asked for (the pilot's matrix: offender age; victim age/sex/race; arrestee age). */
const ATTRIBUTES: Record<string, string[]> = { offender: ["age"], victim: ["age", "sex", "race"], arrestee: ["age"] };
const ATTRIBUTES_V4: Record<string, string[]> = { offender: ["age", "sex", "race", "ethnicity"], victim: ["age", "sex", "race", "ethnicity"], arrestee: ["age", "sex", "race", "ethnicity"] };
const VICTIM_GROUPS = new Set(["person_crimes", "violent_crime_fbi6", "property_crime", "against_property", "homicide", "rape", "sex_offense", "assault_offenses"]);

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
 * The cubes this process may read: NIBRS_CUBE=on|shadow with NIBRS_CUBE_ROOT (the crime-group cube) and/or NIBRS_CODE_CUBE_ROOT (the per-offense-code
 * cube), each a folder with manifest.json and canonical/cube/data_year=YYYY. `releaseRoot` is the canonical folder of the release being read: a cube
 * must have been built from exactly that release. A cube whose check fails is left out (its questions use the raw statements) and the reason is said
 * once on stderr; null when no cube is usable or the flag is off.
 */
export function cubeFromEnv(env: Record<string, string | undefined> = process.env, releaseRoot?: string): CubeConfig | null {
  const mode = env.NIBRS_CUBE === "on" || env.NIBRS_CUBE === "shadow" ? env.NIBRS_CUBE : null;
  const clean = (r: string | undefined) => (r ? r.replace(/\\/g, "/").replace(/\/+$/, "") : undefined);
  const setFile = clean(env.NIBRS_CUBE_SET), setSha = (env.NIBRS_CUBE_SET_SHA256 ?? "").trim().toLowerCase();
  const explicit = { group: clean(env.NIBRS_CUBE_ROOT), code: clean(env.NIBRS_CODE_CUBE_ROOT), offense: clean(env.NIBRS_OFFENSE_CUBE_ROOT), weapon: clean(env.NIBRS_WEAPON_CUBE_ROOT) };
  if (!mode || (!explicit.group && !explicit.code && !explicit.offense && !explicit.weapon && !setFile)) return null;
  // The manifests' own stamps are part of the key: a rebuilt cube is noticed, and nothing else is read twice.
  const stamp = (r: string | undefined) => { if (!r) return "-"; try { const st = fs.statSync(`${r}/manifest.json`); return `${st.mtimeMs}:${st.size}`; } catch { return "none"; } };
  const fileStamp = (f: string | undefined) => { if (!f) return "-"; try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return "none"; } };
  const key = `${mode}:${explicit.group}:${stamp(explicit.group)}:${explicit.code}:${stamp(explicit.code)}:${explicit.offense}:${stamp(explicit.offense)}:${explicit.weapon}:${stamp(explicit.weapon)}:${setFile}:${fileStamp(setFile)}:${setSha}:${releaseRoot ?? ""}`;
  if (cached && cached.key === key) return cached.cfg;
  let cfg: CubeConfig | null = null;
  try {
    const bad = (why: string) => { warnOnce(`${key}:${why}`, why); return null; };
    // A cube SET (the Model's monthly wrapper): one pinned manifest names every product's folder; an explicit root variable overrides its product.
    const set = setFile ? readCubeSet(setFile, setSha, releaseRoot, bad) : null;
    const groupRoot = explicit.group ?? set?.group, codeRoot = explicit.code ?? set?.code, offenseRoot = explicit.offense ?? set?.offense, weaponRoot = explicit.weapon ?? set?.weapon;
    const group = groupRoot ? readCube(groupRoot, "group", releaseRoot, bad) : null;
    const code = codeRoot ? readCube(codeRoot, "code", releaseRoot, bad) : null;
    const offense = offenseRoot ? readCube(offenseRoot, "offense", releaseRoot, bad) : null;
    const weapon = weaponRoot ? readCube(weaponRoot, "weapon", releaseRoot, bad) : null;
    if (group || code || offense || weapon) cfg = { root: group?.root ?? "", years: group?.years ?? [], mode, ...(group?.v4 ? { groupV4: true } : {}), ...(code ? { code: { root: code.root, years: code.years, codes: new Set(code.codes ?? []), ...(code.v2 ? { ethnicity: true } : {}) } } : {}),
      ...(offense ? { offense: { root: offense.root, years: offense.years, codes: new Set(offense.codes ?? []), attributes: offense.attributes ?? [] } } : {}),
      ...(weapon ? { weapon: { root: weapon.root, years: weapon.years, codes: new Set(weapon.codes ?? []), attributes: weapon.attributes ?? [] } } : {}) };
  } catch (e) { warnOnce(key, e instanceof Error ? e.message : String(e)); }
  cached = { key, cfg };
  return cfg;
}

/** The product keys of a cube set and what the engine pins for each: the schema and the groups file the product must have been built from. */
const SET_PRODUCTS: Record<string, { key: "group" | "code" | "offense" | "weapon"; schema: string; groupsSha: string }> = {
  "group-v4": { key: "group", schema: SCHEMA_VERSION, groupsSha: GROUPS_FILE_SHA256_V4 },
  "code-v2": { key: "code", schema: CODE_SCHEMA_VERSION, groupsSha: CODE_FILE_SHA256_V2 },
  "offense-v1": { key: "offense", schema: OFFENSE_SCHEMA_VERSION, groupsSha: OFFENSE_FILE_SHA256_V1 },
  "weapon-v1": { key: "weapon", schema: WEAPON_SCHEMA_VERSION, groupsSha: WEAPON_FILE_SHA256_V1 },
};
const sha256File = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/**
 * A cube set (the Model's monthly wrapper, cube-set-<release id>-<attempt>.json): pinned by the sha256 of the set manifest file (NIBRS_CUBE_SET_SHA256), refused unless its READY file
 * (the same name with .READY.json) carries that hash and the set's release id, and the set says complete with no required product missing. Each product it lists is used only when
 * its folder (relative to the set file, never outside it) holds a manifest.json with the sha256 the set records, status ready, and the schema and groups file the engine pins for that
 * product key; a product that fails, or is absent, is left out with a one-line warning and its questions use the raw statements. A product key the engine does not know is ignored.
 * The set also records the release manifest it was built from: that must be the release being read. Each product's own manifest is then checked by readCube as for a single cube.
 */
function readCubeSet(file: string, expectedSha: string, releaseRoot: string | undefined, bad: (why: string) => null): Partial<Record<"group" | "code" | "offense" | "weapon", string>> | null {
  const label = "cube set";
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) return bad(`${label}: NIBRS_CUBE_SET needs NIBRS_CUBE_SET_SHA256, the sha256 of the set manifest`);
  if (!fs.existsSync(file)) return bad(`${label}: ${file} does not exist`);
  if (sha256File(file) !== expectedSha) return bad(`${label}: ${file} is not the pinned set (its sha256 is not NIBRS_CUBE_SET_SHA256)`);
  const m = JSON.parse(fs.readFileSync(file, "utf8")) as { set_version?: number; release_id?: string; release_manifest_sha256?: string; complete?: boolean; required_missing?: unknown;
    products?: Record<string, { folder?: string; manifest_sha256?: string; schema_version?: string; groups_file_sha256?: string; status?: string }> };
  if (m.set_version !== 1) return bad(`${label}: set_version ${m.set_version} is not 1`);
  if (m.complete !== true || !Array.isArray(m.required_missing) || m.required_missing.length) return bad(`${label}: the set is not complete`);
  const ready = file.replace(/\.json$/, ".READY.json");
  if (!fs.existsSync(ready)) return bad(`${label}: no READY file (${ready}): the set was never finished`);
  const r = JSON.parse(fs.readFileSync(ready, "utf8")) as { status?: string; set_manifest_sha256?: string; release_id?: string };
  if (r.status !== "ready" || String(r.set_manifest_sha256 ?? "").toLowerCase() !== expectedSha || r.release_id !== m.release_id) return bad(`${label}: the READY file does not match the set manifest`);
  if (!releaseRoot) return bad(`${label}: the release being read is not known`);
  const rm = `${releaseRoot.replace(/\\/g, "/").replace(/\/+$/, "")}/../manifest.json`;
  if (!fs.existsSync(rm)) return bad(`${label}: the release's manifest.json is not at ${rm}`);
  if (String(m.release_manifest_sha256 ?? "").toLowerCase() !== sha256File(rm)) return bad(`${label}: built from another release than the one being read`);
  const dir = file.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  const out: Partial<Record<"group" | "code" | "offense" | "weapon", string>> = {};
  for (const [name, spec] of Object.entries(SET_PRODUCTS)) {
    const p = m.products?.[name];
    if (!p) { bad(`${label}: product ${name} is not in the set: its questions use the raw statements`); continue; }
    const why = (x: string) => bad(`${label}: product ${name} left out: ${x}`);
    if (p.status !== "ready") { why(`status ${p.status}`); continue; }
    if (typeof p.folder !== "string" || !p.folder || /^([a-zA-Z]:|[\\/])/.test(p.folder) || p.folder.split(/[\\/]/).includes("..")) { why("its folder is not a relative path inside the set's folder"); continue; }
    const root = `${dir}/${p.folder.replace(/\\/g, "/")}`.replace(/\/+$/, "");
    if (!fs.existsSync(`${root}/manifest.json`)) { why("no manifest.json in its folder"); continue; }
    if (sha256File(`${root}/manifest.json`) !== String(p.manifest_sha256 ?? "").toLowerCase()) { why("its manifest.json is not the one the set records"); continue; }
    if (p.schema_version !== spec.schema || String(p.groups_file_sha256 ?? "").toLowerCase() !== spec.groupsSha) { why("not built from the schema and groups file the engine pins"); continue; }
    out[spec.key] = root;
  }
  return out;
}

function readCube(root: string, kind: "group" | "code" | "offense" | "weapon", releaseRoot: string | undefined, bad: (why: string) => null): { root: string; years: number[]; codes?: string[]; attributes?: string[]; v4?: boolean; v2?: boolean } | null {
  const label = kind === "code" ? "code cube" : kind === "offense" ? "offense cube" : kind === "weapon" ? "weapon cube" : "cube";
  // The manifest is written last: a folder without it is an unfinished build.
  const mf = `${root}/manifest.json`;
  if (!fs.existsSync(mf)) return bad(`${label}: no manifest.json (an unfinished build)`);
  const m = JSON.parse(fs.readFileSync(mf, "utf8")) as { schema_version?: string; source_manifest_sha256?: string; groups_version?: string; groups_file_sha256?: string; unit_attributes?: Record<string, unknown>; groups?: Record<string, { list_sha256?: string | null }>;
    never_add_across_codes?: unknown; reference_codes?: unknown; unlisted_codes?: unknown; product?: string; counting_contract?: unknown; years?: Record<string, unknown>; files?: Record<string, unknown> };
  const want = kind === "code" ? CODE_SCHEMA_VERSION : kind === "offense" ? OFFENSE_SCHEMA_VERSION : kind === "weapon" ? WEAPON_SCHEMA_VERSION : SCHEMA_VERSION;
  if (m.schema_version !== want) return bad(`${label}: schema_version ${m.schema_version} is not ${want}`);
  // Built from this very release: the cube records the sha256 of the release's own manifest.json.
  if (!releaseRoot) return bad(`${label}: the release being read is not known`);
  const rm = `${releaseRoot.replace(/\\/g, "/").replace(/\/+$/, "")}/../manifest.json`;
  if (!fs.existsSync(rm)) return bad(`${label}: the release's manifest.json is not at ${rm}`);
  const releaseSha = createHash("sha256").update(fs.readFileSync(rm)).digest("hex");
  if (String(m.source_manifest_sha256 ?? "").toLowerCase() !== releaseSha) return bad(`${label}: built from another release (source_manifest_sha256 ${String(m.source_manifest_sha256).slice(0, 12)} is not the sha256 ${releaseSha.slice(0, 12)} of ${rm})`);
  let codes: string[] | undefined;
  let attributes: string[] | undefined;
  let v4 = false, v2 = false;
  // A file that adds attributes must say so itself: every unit lists age_bin, sex, race and ethnicity in the manifest's unit_attributes.
  const listsAll = () => ["offender", "victim", "arrestee"].every((u) => { const l = m.unit_attributes?.[u]; return Array.isArray(l) && ["age_bin", "sex", "race", "ethnicity"].every((a) => l.includes(a)); });
  if (kind === "group") {
    // The groups file and the group code lists in the cube are the ones this engine counts with (v2: the four composite groups are in it).
    v4 = m.groups_version === GROUPS_VERSION_V4;
    if (m.groups_version !== GROUPS_VERSION && !v4) return bad(`${label}: groups_version ${m.groups_version} is not ${GROUPS_VERSION} or ${GROUPS_VERSION_V4}`);
    if (String(m.groups_file_sha256 ?? "").toLowerCase() !== (v4 ? GROUPS_FILE_SHA256_V4 : GROUPS_FILE_SHA256)) return bad(`${label}: groups_file_sha256 is not the engine's ${v4 ? "crime_groups_v4" : "crime_groups_v2"}.json`);
    if (v4 && !listsAll()) return bad(`${label}: the v4 manifest does not list age_bin, sex, race and ethnicity for every unit`);
    for (const [g, list] of Object.entries(CUBE_GROUPS)) if (String(m.groups?.[g]?.list_sha256 ?? "").toLowerCase() !== listSha256(list)) return bad(`${label}: the code list of ${g} differs from the engine's`);
  } else if (kind === "weapon") {
    // The weapon cube: its own schema, file hash, product stamp, the weapon and firearm attributes, the counting contract, and the codes it was built for.
    if (m.product !== "weapon") return bad(`${label}: the manifest is not a weapon product`);
    if (m.groups_version !== WEAPON_VERSION_V1) return bad(`${label}: groups_version ${m.groups_version} is not ${WEAPON_VERSION_V1}`);
    if (String(m.groups_file_sha256 ?? "").toLowerCase() !== WEAPON_FILE_SHA256_V1) return bad(`${label}: groups_file_sha256 is not the engine's offense_weapon_v1.json`);
    const ua = (m.unit_attributes as Record<string, unknown> | undefined)?.offense;
    if (!Array.isArray(ua) || !WEAPON_ATTRIBUTES_V1.every((a) => ua.includes(a))) return bad(`${label}: the manifest does not list ${WEAPON_ATTRIBUTES_V1.join(", ")} for the offense unit`);
    if (!(typeof m.counting_contract === "string" && m.counting_contract.trim() !== "")) return bad(`${label}: the manifest does not carry its counting_contract`);
    if (!Array.isArray(m.reference_codes) || !m.reference_codes.every((c) => typeof c === "string")) return bad(`${label}: the manifest names no reference_codes`);
    const extra = Array.isArray(m.unlisted_codes) && m.unlisted_codes.every((c) => typeof c === "string") ? (m.unlisted_codes as string[]) : [];
    codes = [...(m.reference_codes as string[]), ...extra];
    attributes = ua.map(String);
  } else if (kind === "offense") {
    // Cube 1: the file's version and hash, the product stamp, the attributes the manifest lists for the offense unit, and the codes it was built for (listed or found in the release).
    if (m.product !== "offense") return bad(`${label}: the manifest is not an offense product`);
    if (m.groups_version !== OFFENSE_VERSION_V1) return bad(`${label}: groups_version ${m.groups_version} is not ${OFFENSE_VERSION_V1}`);
    if (String(m.groups_file_sha256 ?? "").toLowerCase() !== OFFENSE_FILE_SHA256_V1) return bad(`${label}: groups_file_sha256 is not the engine's offense_incident_v1.json`);
    const ua = (m.unit_attributes as Record<string, unknown> | undefined)?.offense;
    if (!Array.isArray(ua) || !OFFENSE_ATTRIBUTES_V1.every((a) => ua.includes(a))) return bad(`${label}: the manifest does not list ${OFFENSE_ATTRIBUTES_V1.join(", ")} for the offense unit`);
    if (!(typeof m.counting_contract === "string" && m.counting_contract.trim() !== "")) return bad(`${label}: the manifest does not carry its counting_contract`);
    if (!Array.isArray(m.reference_codes) || !m.reference_codes.every((c) => typeof c === "string")) return bad(`${label}: the manifest names no reference_codes`);
    const extra = Array.isArray(m.unlisted_codes) && m.unlisted_codes.every((c) => typeof c === "string") ? (m.unlisted_codes as string[]) : [];
    codes = [...(m.reference_codes as string[]), ...extra];
    attributes = ua.map(String);
  } else {
    // Units are never added across codes: the manifest must say the cube is built that way, and it names the codes it holds.
    // The Model writes the rule as a sentence under this key (older local manifests: true). The key being there and not empty is the test.
    const rule = m.never_add_across_codes;
    if (!(rule === true || (typeof rule === "string" && rule.trim() !== ""))) return bad(`${label}: the manifest does not carry never_add_across_codes`);
    if (!Array.isArray(m.reference_codes) || !m.reference_codes.every((c) => typeof c === "string")) return bad(`${label}: the manifest names no reference_codes`);
    codes = m.reference_codes as string[];
    // Code cube v2 (ethnicity on every unit) is recognised by its file: version, sha256 and the manifest's own attribute lists. Older code cubes carry no stamp and keep age, sex, race.
    v2 = m.groups_version === CODE_VERSION_V2 && String(m.groups_file_sha256 ?? "").toLowerCase() === CODE_FILE_SHA256_V2 && listsAll();
  }
  // File keys as the manifest writes them, with either slash.
  const listed = new Set(Object.keys(m.files ?? {}).map((k) => k.replace(/\\/g, "/")));
  const years = Object.keys(m.years ?? {}).map(Number).filter((y) => Number.isInteger(y) && listed.has(`canonical/cube/data_year=${y}/data.parquet`)
    && fs.existsSync(`${root}/canonical/cube/data_year=${y}/data.parquet`)).sort((a, b) => a - b);
  return years.length ? { root, years, ...(codes ? { codes } : {}), ...(attributes ? { attributes } : {}), ...(v4 ? { v4 } : {}), ...(v2 ? { v2 } : {}) } : bad(`${label}: no data year of the manifest has its file`);
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
  /** Arrests for a Group B offense (the standalone Group B arrest reports: source B in the cube). */
  groupB?: boolean;
  /** The one grouping attribute (offender.age, victim.sex ...), with the plan's age bins when it is an age; none for a total. */
  attribute: { dimension: string; bins?: { label: string; from: number; to: number }[] } | null;
  /** The plan counts incidents beside the units. */
  wantsIncidents: boolean;
  /** Data years the raw statement would read; every one needs a cube partition. */
  years: number[];
  /** Any condition at all (filter, own condition, clearance, join): the cube holds none. */
  conditioned: boolean;
  /**
   * The ONE condition the cube can hold, and the plan has no other: the counted person's age between two years ("juvenile arrests", "offenders
   * under 18"; the plan's `between`, lo and hi inclusive, NN, NB and BB counting as under one year when lo is 0 or 1). The cube stores each age bin
   * as its own row, so the answer is those rows summed. `conditioned` is then false.
   */
  ageFilter?: { dimension: string; lo: number; hi: number };
};

/**
 * The cube age bins an age condition `between lo and hi` keeps, in whole bins, or null when the condition cuts a bin (ages 18 to 21: the cube's bin is
 * 18 to 24) and so cannot be read from the cube. The "Under 18" bin holds 1 to 17 and NN, NB, BB, exactly the plan's rule for a range starting at 0 or 1
 * (compile.ts personCond); a range starting at 2 to 17 would drop NN, NB and BB from it, so it is not a whole bin either.
 */
export function ageFilterBins(lo: number, hi: number): string[] | null {
  if (!(Number.isInteger(lo) && Number.isInteger(hi) && lo >= 0 && hi >= lo && hi <= 99)) return null;
  const start = lo <= 1 ? 0 : CUBE_AGE_BINS.findIndex((b, i) => i > 0 && b.from === lo);
  const end = CUBE_AGE_BINS.findIndex((b) => b.to === hi);
  if (start < 0 || end < start) return null;
  return CUBE_AGE_BINS.slice(start, end + 1).map((b) => b.value);
}

/**
 * The unit CTE for the cube: columns ori, ym, g0 (when grouped), w (units), wi (incidents); or null when the cube cannot serve the plan.
 * A code list that is one of the crime groups reads the crime-group cube; a single offense code (or, for arrests, any codes: an arrest has
 * one offense, so arrests add exactly across codes) reads the per-offense-code cube. Victims and offenders with several codes never do:
 * one unit sits under each of its codes, and the cube never adds across them.
 */
export function cubeUnits(a: CubeAsk): { sql: string } | null {
  if (a.conditioned) return null;
  const unit = a.kind === "offenders" ? "offender" : a.kind === "victims" ? "victim" : "arrestee";
  // Which cube, which rows.
  let cube: { root: string; years: number[] };
  let rows: string; // the crime_group / offense_code condition
  let source = "source = 'A'";
  const codes = a.codes ?? [];
  if (a.allCrimeArrests) {
    if (unit !== "arrestee" || a.groupB) return null;
    cube = a.cfg; rows = "crime_group = 'all_crime'"; source = "source IN ('A', 'B')";
  } else {
    const set = new Set(codes);
    const hit = a.groupB ? undefined : Object.entries(CUBE_GROUPS).find(([, c]) => c.length === set.size && c.every((x) => set.has(x)));
    if (hit && a.cfg.years.length) {
      if (unit === "victim" && !VICTIM_GROUPS.has(hit[0])) return null;
      cube = a.cfg; rows = `crime_group = ${q(hit[0])}`;
    } else {
      const cc = a.cfg.code;
      if (!cc || !codes.length || !codes.every((c) => cc.codes.has(c))) return null;
      if (unit !== "arrestee" && codes.length !== 1) return null; // never add victims or offenders across codes
      if (codes.length > 1 && a.wantsIncidents) return null;
      cube = cc; rows = codes.length === 1 ? `offense_code = ${q(codes[0])}` : `offense_code IN (${codes.map(q).join(", ")})`;
      if (a.groupB) source = "source = 'B'";
    }
  }
  if (!a.years.length || !a.years.every((y) => cube.years.includes(y))) return null;
  const isCodeCube = cube === a.cfg.code;
  if (!isCodeCube && a.groupB) return null;
  let value = "'none'";
  let attrName = "none";
  let merges = false;
  let inBins = "";
  if (a.ageFilter) {
    // One age condition and no second split: the rows of the bins it keeps, summed (a person has one age, so units add across the bins; incidents
    // never add across attribute values, so several bins are served only as units).
    if (a.attribute) return null;
    const [owner, name] = a.ageFilter.dimension.split(".");
    if (name !== "age" || !(owner === unit || (a.groupB && owner === "group_b_arrest"))) return null;
    const bins = ageFilterBins(a.ageFilter.lo, a.ageFilter.hi);
    if (!bins || (bins.length > 1 && a.wantsIncidents)) return null;
    attrName = "age_bin";
    inBins = ` AND value IN (${bins.map(q).join(", ")})`;
  }
  if (a.attribute) {
    const [owner, name] = a.attribute.dimension.split(".");
    const owned = owner === (a.groupB ? "group_b_arrest" : unit);
    // The engine calls an offender with sequence 00 (no offender known) Unknown in every attribute, whatever its sex or race fields hold (17,517 such
    // rows in 2024, all New York). A code cube built at Model commit 064661b or later maps sequence 00 to blank for offender sex and race too, as it
    // always did for age, so the three attributes are read from it for every unit. A cube built before that commit must not be pointed at here.
    const allowed = isCodeCube ? (a.cfg.code?.ethnicity ? ["age", "sex", "race", "ethnicity"] : ["age", "sex", "race"]) : (a.cfg.groupV4 ? ATTRIBUTES_V4[unit] : ATTRIBUTES[unit]);
    if (!owned || !allowed?.includes(name)) return null;
    if (name === "age") {
      if (!a.attribute.bins) return null;
      const m = ageMapping(a.attribute.bins);
      if (!m) return null;
      merges = m.merges;
      attrName = "age_bin";
      value = `CASE value ${Object.entries(m.map).map(([k, v]) => `WHEN ${q(k)} THEN ${q(v)}`).join(" ")} ELSE 'Outside the groups' END`;
    } else {
      // The engine calls a missing or blank sex, race or ethnicity "U"; the cube keeps the raw codes and calls them "(blank)".
      attrName = name;
      value = `CASE WHEN value = '(blank)' THEN 'U' ELSE value END`;
      merges = true; // "(blank)" and a real "U" become one category
    }
  }
  if (merges && a.wantsIncidents) return null;
  const files = a.years.map((y) => q(`${cube.root}/canonical/cube/data_year=${y}/data.parquet`)).join(", ");
  const sql = `SELECT ori, month_key AS ym${a.attribute ? `, ${value} AS g0` : ""}, CAST(SUM(n_distinct_units) AS BIGINT) AS w, CAST(SUM(n_distinct_incidents) AS BIGINT) AS wi
      FROM read_parquet([${files}], hive_partitioning = true)
      WHERE unit = ${q(unit)} AND ${source} AND ${rows} AND attribute = ${q(attrName)}${inBins}
      GROUP BY ALL`;
  return { sql };
}

/**
 * Offenses and incidents of one or more offense codes, from the offense-and-incident cube (cube 1). The cube holds one row per (ori, month, offense code, attribute, value) with
 * `n_distinct_units` (offenses: the engine's offense unit, ori + incident + code + occurrence key) and `n_distinct_incidents`. Offenses add across codes, ORIs, months and the
 * values of one attribute. Distinct incidents add across ORIs and months within ONE code, and across the values of incident_hour and clearance_type (an incident has one of each);
 * never across codes and never across location_type values (an incident with offenses at two locations is in both cells).
 *
 * Served: a total, or one grouping (the incident's hour in the plan's bins, the offense's location_type, the incident's clearance type, method or status), with no condition of any
 * kind. An incident count (`entity: "incident"`, or incidents beside the offenses) needs one code. Null otherwise: the caller keeps the raw statements.
 */
export type OffenseAsk = {
  cfg: CubeConfig;
  /** The counted entity: offenses (units are offense segments) or incidents (units are incidents with an offense of the codes). */
  entity: "offense" | "incident";
  codes: string[];
  attribute: { dimension: string; bins?: { label: string; from: number; to: number }[] } | null;
  wantsIncidents: boolean;
  years: number[];
  conditioned: boolean;
};
export function cubeOffenseUnits(a: OffenseAsk): { sql: string } | null {
  const cube = a.cfg.offense;
  if (!cube || a.conditioned || !a.codes.length) return null;
  if (!a.codes.every((c) => cube.codes.has(c))) return null;
  if (!a.years.length || !a.years.every((y) => cube.years.includes(y))) return null;
  const one = a.codes.length === 1;
  // Distinct incidents never add across codes.
  if ((a.entity === "incident" || a.wantsIncidents) && !one) return null;
  let attrName = "none", value = "''";
  if (a.attribute) {
    const d = a.attribute.dimension;
    const hasIncidentAttr = (n: string) => cube.attributes.includes(n);
    if (d === "incident.hour") {
      if (!a.attribute.bins || !hasIncidentAttr("incident_hour")) return null;
      // The cube's hour is '00' to '23' or Unknown; the plan's bins label the hours they hold, any hour outside them is Unknown (as the raw statement does).
      const labelOf = (h: number) => a.attribute!.bins!.find((b) => b.from <= h && h <= b.to)?.label ?? "Unknown";
      const cases = Array.from({ length: 24 }, (_, h) => `WHEN ${q(String(h).padStart(2, "0"))} THEN ${q(labelOf(h))}`).join(" ");
      attrName = "incident_hour"; value = `CASE value ${cases} ELSE 'Unknown' END`;
    } else if (d === "offense.location_type") {
      // The offense's own raw location code; a blank is "(blank)" in the cube and a missing value in the raw statement. A location is never merged, so incidents are exact per value.
      if (a.entity !== "offense" || a.attribute.bins || !hasIncidentAttr("location_type")) return null;
      attrName = "location_type"; value = `CASE WHEN value = '(blank)' THEN NULL ELSE value END`;
    } else if (d === "offense.clearance_type" || d === "offense.clearance_method" || d === "offense.clearance_status") {
      if (a.attribute.bins || !hasIncidentAttr("clearance_type")) return null;
      attrName = "clearance_type";
      value = d === "offense.clearance_type" ? "value"
        : d === "offense.clearance_method" ? "CASE value WHEN 'arrest' THEN 'arrest' WHEN 'none' THEN 'none' ELSE 'exceptional' END"
        : "CASE value WHEN 'none' THEN 'none' ELSE 'cleared' END";
    } else return null;
  }
  // Incident hour and clearance values are one per incident, so merging them is exact for incidents as well as offenses.
  const files = a.years.map((y) => q(`${cube.root}/canonical/cube/data_year=${y}/data.parquet`)).join(", ");
  const rows = one ? `offense_code = ${q(a.codes[0])}` : `offense_code IN (${a.codes.map(q).join(", ")})`;
  // An incident count is the cell's distinct incidents (one code only); an offense count is the cell's offenses, with the incidents beside it only for one code.
  const w = a.entity === "incident" ? "n_distinct_incidents" : "n_distinct_units";
  const wi = one ? "n_distinct_incidents" : "CAST(NULL AS BIGINT)";
  const sql = `SELECT ori, month_key AS ym${a.attribute ? `, ${value} AS g0` : ""}, CAST(SUM(${w}) AS BIGINT) AS w, ${one ? `CAST(SUM(${wi}) AS BIGINT)` : "CAST(NULL AS BIGINT)"} AS wi
      FROM read_parquet([${files}], hive_partitioning = true)
      WHERE unit = 'offense' AND source = 'A' AND ${rows} AND attribute = ${q(attrName)}
      GROUP BY ALL`;
  return { sql };
}

/**
 * Offenses with a weapon, from the weapon cube. The cube holds, per (ori, month, offense code), the offenses and distinct incidents by `weapon` (the trimmed code of each of the
 * offense's weapon rows; an offense with two codes is in both cells, no weapon is "(blank)") and by `firearm` (Y when any code is 11 to 15, else N). Weapon values never add, so
 * a count is served only as ONE cell: the plan's weapon grouping (each value its own category, categories overlap) or a weapon filter that is exactly one cell (the firearm list,
 * or one two-character code). Offenses add across codes within a cell; incidents only for one code. Any other condition, a second split, or a filter with several weapon values
 * that is not the firearm list stays raw.
 */
export type WeaponAsk = {
  cfg: CubeConfig;
  codes: string[];
  /** The plan groups by the offense's weapon (offense_weapon.weapon, each value counted). */
  grouping: boolean;
  /** The plan's one condition: the offense has a weapon among these values (from-spec's weapon filter: "firearm" is the ten values 11, 11A ... 15, 15A). */
  weaponFilter: string[] | null;
  wantsIncidents: boolean;
  years: number[];
  /** Any other condition, a grouping other than the weapon, or a second one. */
  conditioned: boolean;
};
const FIREARM_VALUES = ["11", "11A", "12", "12A", "13", "13A", "14", "14A", "15", "15A"];
export function cubeWeaponUnits(a: WeaponAsk): { sql: string; totalSql?: string } | null {
  const cube = a.cfg.weapon;
  if (!cube || a.conditioned || !a.codes.length) return null;
  if (!a.codes.every((c) => cube.codes.has(c))) return null;
  if (!a.years.length || !a.years.every((y) => cube.years.includes(y))) return null;
  if (a.wantsIncidents && a.codes.length !== 1) return null; // distinct incidents never add across codes
  if (a.grouping === !!a.weaponFilter) return null; // exactly one of: the weapon grouping, the weapon filter
  let attrName = "weapon", cond = "", g0 = "";
  if (a.grouping) {
    if (!cube.attributes.includes("weapon")) return null;
    g0 = ", CASE WHEN value = '(blank)' THEN NULL ELSE value END AS g0";
  } else {
    const vals = [...new Set(a.weaponFilter!)];
    if (vals.length === FIREARM_VALUES.length && FIREARM_VALUES.every((v) => vals.includes(v))) {
      if (!cube.attributes.includes("firearm")) return null;
      attrName = "firearm"; cond = " AND value = 'Y'";
    } else if (vals.length === 1 && /^[0-9A-Za-z]{2}$/.test(vals[0]) && cube.attributes.includes("weapon")) {
      cond = ` AND value = ${q(vals[0])}`; // one two-character code, whatever its automatic flag (the raw statement tests the weapon column alone)
    } else return null;
  }
  const files = a.years.map((y) => q(`${cube.root}/canonical/cube/data_year=${y}/data.parquet`)).join(", ");
  const rows = a.codes.length === 1 ? `offense_code = ${q(a.codes[0])}` : `offense_code IN (${a.codes.map(q).join(", ")})`;
  const sql = `SELECT ori, month_key AS ym${g0}, CAST(SUM(n_distinct_units) AS BIGINT) AS w, ${a.codes.length === 1 ? "CAST(SUM(n_distinct_incidents) AS BIGINT)" : "CAST(NULL AS BIGINT)"} AS wi
      FROM read_parquet([${files}], hive_partitioning = true)
      WHERE unit = 'offense' AND source = 'A' AND ${rows} AND attribute = ${q(attrName)}${cond}
      GROUP BY ALL`;
  // A weapon grouping overlaps (an offense with two weapons is in two categories): the month's own total and every share's denominator is the DISTINCT offenses, which is the cube's
  // "none" row of the same codes, not the sum of the categories.
  if (!a.grouping) return { sql };
  const totalSql = `SELECT ori, month_key AS ym, CAST(SUM(n_distinct_units) AS BIGINT) AS w, ${a.codes.length === 1 ? "CAST(SUM(n_distinct_incidents) AS BIGINT)" : "CAST(NULL AS BIGINT)"} AS wi
      FROM read_parquet([${files}], hive_partitioning = true)
      WHERE unit = 'offense' AND source = 'A' AND ${rows} AND attribute = 'none'
      GROUP BY ALL`;
  return { sql, totalSql };
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
/**
 * The statement with any shadow comment taken out wherever it sits. Some callers wrap a plan statement in a larger one (`WITH g AS MATERIALIZED (${sql}) ...`),
 * which puts the shadow block inside the text instead of at its start; the comment is only carried text there, so what runs is what is left.
 */
export function withoutShadowComment(sql: string): string {
  const open = sql.indexOf(SHADOW_OPEN);
  if (open < 0) return sql;
  const end = sql.indexOf(SHADOW_CLOSE, open);
  return end < 0 ? sql : sql.slice(0, open) + sql.slice(end + SHADOW_CLOSE.length);
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
