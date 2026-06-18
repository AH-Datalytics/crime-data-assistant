import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

type CityRecord = {
  key: string;
  name: string;
  state: string;
  sources: Set<string>;
  dominancePopulation?: number;
  dominancePopulationYear?: number;
  dominancePopulationSource?: "current" | "historical";
};

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

const EXCLUDED_BARE_NAMES = new Set([
  "BALTIMORE",
  "BLACK",
  "KANSAS CITY",
  "MANY",
  "NEW YORK",
  "OTHER",
  "PORTLAND",
  "SAINT LOUIS",
  "ST LOUIS",
  "UNKNOWN",
  "WASHINGTON",
  "WARD",
  "WHITE",
]);

const CANONICAL_CITY_KEYS = new Map<string, { key: string; name: string }>([
  ["NC:CHARLOTTE MECKLENBURG", { key: "CHARLOTTE", name: "Charlotte" }],
  ["TN:METROPOLITAN NASHVILLE", { key: "NASHVILLE", name: "Nashville" }],
  ["NV:LAS VEGAS METROPOLITAN", { key: "LAS VEGAS", name: "Las Vegas" }],
  ["KY:LOUISVILLE METRO", { key: "LOUISVILLE", name: "Louisville" }],
]);

function argValue(name: string): string | null {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function main() {
  const dbPath = argValue("--db") || path.join(process.cwd(), "crime_data.db");
  const outPath = argValue("--out") || path.join(process.cwd(), "lib", "generated", "geo-cities.ts");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const cities = new Map<string, CityRecord>();

  try {
    loadCurrent(db, cities);
    loadHistorical(db, cities);
  } finally {
    db.close();
  }

  const entries = [...cities.values()]
    .filter((city) => city.key.length >= 3 && city.state in STATE_NAMES)
    .sort((a, b) => a.name.localeCompare(b.name) || a.state.localeCompare(b.state));

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, render(entries), "utf8");
  console.log(`Wrote ${outPath}`);
  console.log(`cities=${entries.length}`);
}

function loadCurrent(db: Database.Database, cities: Map<string, CityRecord>) {
  if (!tableExists(db, "agencies")) return;
  const hasPopulation = tableExists(db, "agency_population");
  const rows = db.prepare(hasPopulation ? `
    WITH latest_population AS (
      SELECT ori, MAX(year) AS year
      FROM agency_population
      WHERE population IS NOT NULL AND population > 0
      GROUP BY ori
    )
    SELECT a.agency, a.state, ap.population, ap.year AS population_year
    FROM agencies a
    LEFT JOIN latest_population lp ON lp.ori = a.ori
    LEFT JOIN agency_population ap ON ap.ori = lp.ori AND ap.year = lp.year
    WHERE a.agency IS NOT NULL AND a.state IS NOT NULL AND a.type = 'City'
  ` : `
    SELECT agency, state, NULL AS population, NULL AS population_year
    FROM agencies
    WHERE agency IS NOT NULL AND state IS NOT NULL AND type = 'City'
  `).all() as { agency: string; state: string; population: number | null; population_year: number | null }[];

  for (const row of rows) {
    addCity(cities, row.agency, row.state, "current", row.population, row.population_year);
  }
}

function loadHistorical(db: Database.Database, cities: Map<string, CityRecord>) {
  if (!tableExists(db, "historical_agency")) return;
  const hasPopulation = tableExists(db, "historical_agency_population");
  const rows = db.prepare(hasPopulation ? `
    WITH latest_population AS (
      SELECT ori, MAX(year) AS year
      FROM historical_agency_population
      WHERE population IS NOT NULL AND population > 0
      GROUP BY ori
    )
    SELECT ha.agency, ha.state, hap.population, hap.year AS population_year
    FROM historical_agency ha
    LEFT JOIN latest_population lp ON lp.ori = ha.ori
    LEFT JOIN historical_agency_population hap ON hap.ori = lp.ori AND hap.year = lp.year
    WHERE ha.agency IS NOT NULL AND ha.state IS NOT NULL AND lower(ha.type) = 'city'
  ` : `
    SELECT agency, state, NULL AS population, NULL AS population_year
    FROM historical_agency
    WHERE agency IS NOT NULL AND state IS NOT NULL AND lower(type) = 'city'
  `).all() as { agency: string; state: string; population: number | null; population_year: number | null }[];

  for (const row of rows) {
    addCity(cities, row.agency, row.state, "historical", row.population, row.population_year);
  }
}

function addCity(
  cities: Map<string, CityRecord>,
  rawName: string,
  rawState: string,
  source: "current" | "historical",
  population: number | null = null,
  populationYear: number | null = null
) {
  const state = normalizeState(rawState);
  const rawKey = normalizeKey(rawName);
  const canonical = canonicalCity(rawKey, state);
  const key = canonical.key;
  if (!key || !(state in STATE_NAMES)) return;
  const id = `${state}:${key}`;
  const existing = cities.get(id);
  if (existing) {
    existing.sources.add(source);
    applyDominancePopulation(existing, source, population, populationYear);
    return;
  }
  const record: CityRecord = {
    key,
    name: canonical.name ?? displayName(rawName, key),
    state,
    sources: new Set([source]),
  };
  applyDominancePopulation(record, source, population, populationYear);
  cities.set(id, record);
}

function canonicalCity(rawKey: string, state: string): { key: string; name?: string } {
  return CANONICAL_CITY_KEYS.get(`${state}:${rawKey}`) ?? { key: rawKey };
}

function applyDominancePopulation(
  city: CityRecord,
  source: "current" | "historical",
  population: number | null,
  populationYear: number | null
) {
  if (!population || !populationYear || population <= 0) return;
  if (city.dominancePopulationSource === "historical" && source !== "historical") return;
  if (
    source === "historical" && city.dominancePopulationSource !== "historical" ||
    !city.dominancePopulationYear ||
    populationYear > city.dominancePopulationYear ||
    (populationYear === city.dominancePopulationYear && population > (city.dominancePopulation ?? 0))
  ) {
    city.dominancePopulation = population;
    city.dominancePopulationYear = populationYear;
    city.dominancePopulationSource = source;
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table)
  );
}

function normalizeState(value: string): string {
  const state = value.trim().toUpperCase();
  if (state === "NB") return "NE";
  return state;
}

function normalizeKey(value: string): string {
  return value
    .replace(/\b(police|department|dept|sheriff'?s?|office)\b/ig, " ")
    .replace(/\bst\.?\b/ig, "saint")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

const STATE_NAME_KEYS = new Set(Object.values(STATE_NAMES).map(normalizeKey));

function displayName(rawName: string, key: string): string {
  const cleaned = rawName
    .replace(/\b(police|department|dept|sheriff'?s?|office)\b/ig, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/[a-z]/.test(cleaned) && cleaned.length <= 40) return cleaned;
  return titleCase(key.replace(/\bSAINT\b/g, "Saint"));
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => /^(of|and|the|de|la)$/i.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function render(entries: CityRecord[]): string {
  const lines: string[] = [];
  lines.push("// Generated by `npx tsx scripts/generate-geo-city-catalog.ts`.");
  lines.push("// Shadow resolver city coverage from Current + Historical city agency rows.");
  lines.push("");
  lines.push("export type GeneratedGeoCity = {");
  lines.push("  id: string;");
  lines.push("  name: string;");
  lines.push("  state: string;");
  lines.push("  aliases: string[];");
  lines.push("  sources: string[];");
  lines.push("  dominancePopulation?: number;");
  lines.push("  dominancePopulationYear?: number;");
  lines.push("  dominancePopulationSource?: \"current\" | \"historical\";");
  lines.push("};");
  lines.push("");
  lines.push("export const GENERATED_GEO_CITIES: GeneratedGeoCity[] = [");
  for (const city of entries) {
    const aliases = cityAliases(city);
    const fields = [
      `id: ${JSON.stringify(`city:${city.state}:${slug(city.name)}`)}`,
      `name: ${JSON.stringify(city.name)}`,
      `state: ${JSON.stringify(city.state)}`,
      `aliases: ${JSON.stringify(aliases)}`,
      `sources: ${JSON.stringify([...city.sources].sort())}`,
    ];
    if (city.dominancePopulation && city.dominancePopulationYear && city.dominancePopulationSource) {
      fields.push(`dominancePopulation: ${city.dominancePopulation}`);
      fields.push(`dominancePopulationYear: ${city.dominancePopulationYear}`);
      fields.push(`dominancePopulationSource: ${JSON.stringify(city.dominancePopulationSource)}`);
    }
    lines.push(`  { ${fields.join(", ")} },`);
  }
  lines.push("];");
  lines.push("");
  return `${lines.join("\n")}`;
}

function cityAliases(city: CityRecord): string[] {
  const stateName = STATE_NAMES[city.state];
  const aliases = [
    `${city.name}, ${city.state}`,
    `${city.name} ${city.state}`,
    `${city.name}, ${stateName}`,
    `${city.name} ${stateName}`,
  ];
  if (!isExcludedBareAlias(city.key)) aliases.unshift(city.name);
  return Array.from(new Set(aliases));
}

function isExcludedBareAlias(key: string): boolean {
  return EXCLUDED_BARE_NAMES.has(key) || STATE_NAME_KEYS.has(key);
}

main();
