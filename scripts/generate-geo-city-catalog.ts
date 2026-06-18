import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

type CityRecord = {
  key: string;
  name: string;
  state: string;
  sources: Set<string>;
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
  const rows = db.prepare(`
    SELECT agency, state
    FROM agencies
    WHERE agency IS NOT NULL AND state IS NOT NULL AND type = 'City'
  `).all() as { agency: string; state: string }[];

  for (const row of rows) addCity(cities, row.agency, row.state, "current");
}

function loadHistorical(db: Database.Database, cities: Map<string, CityRecord>) {
  if (!tableExists(db, "historical_agency")) return;
  const rows = db.prepare(`
    SELECT agency, state
    FROM historical_agency
    WHERE agency IS NOT NULL AND state IS NOT NULL AND lower(type) = 'city'
  `).all() as { agency: string; state: string }[];

  for (const row of rows) addCity(cities, row.agency, row.state, "historical");
}

function addCity(cities: Map<string, CityRecord>, rawName: string, rawState: string, source: string) {
  const state = normalizeState(rawState);
  const key = normalizeKey(rawName);
  if (!key || !(state in STATE_NAMES)) return;
  const id = `${state}:${key}`;
  const existing = cities.get(id);
  if (existing) {
    existing.sources.add(source);
    return;
  }
  cities.set(id, {
    key,
    name: displayName(rawName, key),
    state,
    sources: new Set([source]),
  });
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
  lines.push("};");
  lines.push("");
  lines.push("export const GENERATED_GEO_CITIES: GeneratedGeoCity[] = [");
  for (const city of entries) {
    const aliases = cityAliases(city);
    lines.push(`  { id: ${JSON.stringify(`city:${city.state}:${slug(city.name)}`)}, name: ${JSON.stringify(city.name)}, state: ${JSON.stringify(city.state)}, aliases: ${JSON.stringify(aliases)}, sources: ${JSON.stringify([...city.sources].sort())} },`);
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
