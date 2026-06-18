import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

type SourceName = "current" | "historical" | "county_crosswalk";
type PlaceType = "city" | "county";

type PlaceRecord = {
  key: string;
  label: string;
  state: string;
  type: PlaceType;
  source: SourceName;
  count: number;
};

type Collision = {
  key: string;
  label: string;
  states: string[];
  cityStates: string[];
  countyStates: string[];
  records: PlaceRecord[];
};

function argValue(name: string): string | null {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function defaultDbPath(): string {
  return process.env.RTCI_DB_PATH || path.join(process.cwd(), "crime_data.db");
}

function defaultOutPath(): string {
  return path.join(process.cwd(), "docs", "geo-collision-audit-2026-06-18.md");
}

function defaultCatalogPath(): string {
  return path.join(process.cwd(), "lib", "generated", "ambiguous-counties.ts");
}

function normalizeState(value: string): string {
  const state = value.trim().toUpperCase();
  if (state === "NB") return "NE";
  if (state === "GM") return "GU";
  return state;
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table)
  );
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => /^(of|and|the|de|la)$/i.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeKey(value: string): string {
  return value
    .replace(/\b(county|parish|borough)\b/ig, " ")
    .replace(/\b(city|township|town|village)\b/ig, " ")
    .replace(/\b(police|department|dept|sheriff'?s?|office)\b/ig, " ")
    .replace(/\bst\.?\b/ig, "saint")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function displayFromKey(key: string): string {
  return titleCase(key.replace(/\bSAINT\b/g, "ST"));
}

function addRecord(records: Map<string, PlaceRecord>, record: Omit<PlaceRecord, "count">): void {
  if (!record.key || !record.state || record.key.length < 3) return;
  const id = [record.key, record.state, record.type, record.source].join("|");
  const existing = records.get(id);
  if (existing) {
    existing.count += 1;
    return;
  }
  records.set(id, { ...record, count: 1 });
}

function loadCurrent(db: Database.Database, records: Map<string, PlaceRecord>): void {
  if (!tableExists(db, "agencies")) return;
  const rows = db.prepare(`
    SELECT agency, state, type
    FROM agencies
    WHERE agency IS NOT NULL AND state IS NOT NULL AND type IN ('City', 'County')
  `).all() as { agency: string; state: string; type: string }[];

  for (const row of rows) {
    const type = row.type.toLowerCase() === "county" ? "county" : "city";
    const key = normalizeKey(row.agency);
    addRecord(records, {
      key,
      label: type === "county" ? `${displayFromKey(key)} County` : displayFromKey(key),
      state: normalizeState(row.state),
      type,
      source: "current",
    });
  }
}

function loadHistorical(db: Database.Database, records: Map<string, PlaceRecord>): void {
  if (!tableExists(db, "historical_agency")) return;
  const rows = db.prepare(`
    SELECT agency, state, type
    FROM historical_agency
    WHERE agency IS NOT NULL AND state IS NOT NULL AND lower(type) IN ('city', 'county')
  `).all() as { agency: string; state: string; type: string }[];

  for (const row of rows) {
    const type = row.type.toLowerCase() === "county" ? "county" : "city";
    const key = normalizeKey(row.agency);
    addRecord(records, {
      key,
      label: type === "county" ? `${displayFromKey(key)} County` : displayFromKey(key),
      state: normalizeState(row.state),
      type,
      source: "historical",
    });
  }
}

function loadCountyCrosswalk(db: Database.Database, records: Map<string, PlaceRecord>): void {
  if (!tableExists(db, "agency_county_crosswalk")) return;
  const rows = db.prepare(`
    SELECT county_key, county_name, state, COUNT(*) AS n
    FROM agency_county_crosswalk
    WHERE county_key IS NOT NULL AND county_key <> '' AND state IS NOT NULL
    GROUP BY county_key, county_name, state
  `).all() as { county_key: string; county_name: string | null; state: string; n: number }[];

  for (const row of rows) {
    const key = normalizeKey(row.county_key);
    addRecord(records, {
      key,
      label: `${titleCase(row.county_name || row.county_key)} County`,
      state: normalizeState(row.state),
      type: "county",
      source: "county_crosswalk",
    });
  }
}

function groupByKey(records: PlaceRecord[]): Map<string, PlaceRecord[]> {
  const grouped = new Map<string, PlaceRecord[]>();
  for (const record of records) {
    const rows = grouped.get(record.key) || [];
    rows.push(record);
    grouped.set(record.key, rows);
  }
  return grouped;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function collisionFromRecords(key: string, records: PlaceRecord[]): Collision {
  const cityStates = uniqueSorted(records.filter((r) => r.type === "city").map((r) => r.state));
  const countyStates = uniqueSorted(records.filter((r) => r.type === "county").map((r) => r.state));
  return {
    key,
    label: displayFromKey(key),
    states: uniqueSorted(records.map((r) => r.state)),
    cityStates,
    countyStates,
    records: records.sort((a, b) => `${a.state}:${a.type}:${a.source}`.localeCompare(`${b.state}:${b.type}:${b.source}`)),
  };
}

function findCityCountySameState(grouped: Map<string, PlaceRecord[]>): Collision[] {
  const collisions: Collision[] = [];
  for (const [key, records] of grouped) {
    const cityStates = new Set(records.filter((r) => r.type === "city").map((r) => r.state));
    const countyStates = new Set(records.filter((r) => r.type === "county").map((r) => r.state));
    const shared = [...cityStates].filter((state) => countyStates.has(state));
    if (shared.length > 0) {
      collisions.push(collisionFromRecords(key, records.filter((r) => shared.includes(r.state))));
    }
  }
  return collisions.sort((a, b) => a.label.localeCompare(b.label));
}

function findMultiStateCities(grouped: Map<string, PlaceRecord[]>): Collision[] {
  const collisions: Collision[] = [];
  for (const [key, records] of grouped) {
    const cityRecords = records.filter((r) => r.type === "city");
    const states = uniqueSorted(cityRecords.map((r) => r.state));
    if (states.length > 1) collisions.push(collisionFromRecords(key, cityRecords));
  }
  return collisions.sort((a, b) => b.states.length - a.states.length || a.label.localeCompare(b.label));
}

function findMultiStateCounties(grouped: Map<string, PlaceRecord[]>): Collision[] {
  const collisions: Collision[] = [];
  for (const [key, records] of grouped) {
    const countyRecords = records.filter((r) => r.type === "county");
    const states = uniqueSorted(countyRecords.map((r) => r.state));
    if (states.length > 1) collisions.push(collisionFromRecords(key, countyRecords));
  }
  return collisions.sort((a, b) => b.states.length - a.states.length || a.label.localeCompare(b.label));
}

function recordSummary(records: PlaceRecord[]): string {
  return records
    .map((r) => `${r.type}/${r.source}/${r.state}${r.count > 1 ? ` x${r.count}` : ""}`)
    .join("; ");
}

function tableRows(collisions: Collision[], limit: number): string[] {
  return collisions.slice(0, limit).map((collision) => {
    const cityStates = collision.cityStates.length ? collision.cityStates.join(", ") : "-";
    const countyStates = collision.countyStates.length ? collision.countyStates.join(", ") : "-";
    return `| ${collision.label} | ${cityStates} | ${countyStates} | ${recordSummary(collision.records)} |`;
  });
}

function renderReport(opts: {
  dbPath: string;
  totalRecords: number;
  cityCountySameState: Collision[];
  multiStateCities: Collision[];
  multiStateCounties: Collision[];
}): string {
  const lines: string[] = [];
  lines.push("# Geo Collision Audit - 2026-06-18");
  lines.push("");
  lines.push("Generated by `npx tsx scripts/audit-geo-collisions.ts`.");
  lines.push("");
  lines.push(`- Database: \`${opts.dbPath}\``);
  lines.push(`- Normalized place records: ${opts.totalRecords.toLocaleString()}`);
  lines.push(`- City/county same-state collisions: ${opts.cityCountySameState.length.toLocaleString()}`);
  lines.push(`- Multi-state city-name collisions: ${opts.multiStateCities.length.toLocaleString()}`);
  lines.push(`- Multi-state county-name collisions: ${opts.multiStateCounties.length.toLocaleString()}`);
  lines.push("");
  lines.push("## Promotion Guidance");
  lines.push("");
  lines.push("- Safe to consider now: explicit county prompts without a state when the county name appears in multiple states.");
  lines.push("- Needs review before blocking: bare city names that appear in multiple states, because some are overwhelmingly canonical in normal usage.");
  lines.push("- Needs review before blocking: city/county same-state names, because wording like `Baltimore city` and `Baltimore County` must remain accepted while bare `Baltimore` may need a finite-choice prompt.");
  lines.push("- Do not use this report for fuzzy matching; it is exact normalized-name evidence only.");
  lines.push("");

  const sections: [string, Collision[], number][] = [
    ["City And County Same State", opts.cityCountySameState, 80],
    ["Multi-State Cities", opts.multiStateCities, 80],
    ["Multi-State Counties", opts.multiStateCounties, 120],
  ];

  for (const [title, collisions, limit] of sections) {
    lines.push(`## ${title}`);
    lines.push("");
    lines.push("| Place | City States | County States | Evidence |");
    lines.push("| --- | --- | --- | --- |");
    lines.push(...tableRows(collisions, limit));
    if (collisions.length > limit) {
      lines.push(`| ... | ... | ... | ${collisions.length - limit} more omitted from report view |`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function renderCountyCatalog(collisions: Collision[]): string {
  const entries = collisions.map((collision) => ({
    name: collision.label,
    states: collision.countyStates,
  }));
  const lines: string[] = [];
  lines.push("// Generated by `npx tsx scripts/audit-geo-collisions.ts`.");
  lines.push("// Multi-state county names only; city collisions remain review-only.");
  lines.push("");
  lines.push("export type AmbiguousCountyCatalogEntry = {");
  lines.push("  name: string;");
  lines.push("  states: string[];");
  lines.push("};");
  lines.push("");
  lines.push("export const GENERATED_AMBIGUOUS_COUNTIES: AmbiguousCountyCatalogEntry[] = [");
  for (const entry of entries) {
    lines.push(`  { name: ${JSON.stringify(entry.name)}, states: ${JSON.stringify(entry.states)} },`);
  }
  lines.push("];");
  lines.push("");
  return `${lines.join("\n")}`;
}

function main(): void {
  const dbPath = argValue("--db") || defaultDbPath();
  const outPath = argValue("--out") || defaultOutPath();
  const catalogPath = argValue("--catalog") || defaultCatalogPath();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const records = new Map<string, PlaceRecord>();

  try {
    loadCurrent(db, records);
    loadHistorical(db, records);
    loadCountyCrosswalk(db, records);

    const grouped = groupByKey([...records.values()]);
    const cityCountySameState = findCityCountySameState(grouped);
    const multiStateCities = findMultiStateCities(grouped);
    const multiStateCounties = findMultiStateCounties(grouped);

    const report = renderReport({
      dbPath,
      totalRecords: records.size,
      cityCountySameState,
      multiStateCities,
      multiStateCounties,
    });

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, report, "utf8");
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    fs.writeFileSync(catalogPath, renderCountyCatalog(multiStateCounties), "utf8");
    console.log(`Wrote ${outPath}`);
    console.log(`Wrote ${catalogPath}`);
    console.log(`city/county same-state: ${cityCountySameState.length}`);
    console.log(`multi-state cities: ${multiStateCities.length}`);
    console.log(`multi-state counties: ${multiStateCounties.length}`);
  } finally {
    db.close();
  }
}

main();
