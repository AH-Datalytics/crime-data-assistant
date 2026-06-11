#!/usr/bin/env npx tsx
import fs from "node:fs";
import Database from "better-sqlite3";

const PROMPT_PATH = "lib/nibrs-claude.ts";

type Example = {
  line: number;
  sql: string;
  skipped?: string;
};

const MANUAL_SCHEMA: Record<string, string[]> = {
  agencies: [
    "ori", "year", "state_code", "state", "city", "pop_group",
    "country_division", "covered_flag", "agency_indicator",
    "agency_type", "population",
  ],
  incidents: [
    "year", "state", "ori", "incident_num", "incident_date",
    "report_date_indicator", "incident_hour", "total_offense_segments",
    "total_victim_segments", "total_offender_segments",
    "total_arrestee_segments", "cleared_exceptionally", "clearance_date",
    "cargo_theft",
  ],
  offenses: [
    "year", "state", "ori", "incident_num", "incident_date",
    "ucr_offense_code", "attempted_completed", "offender_suspected_of_using_1",
    "offender_suspected_of_using_2", "offender_suspected_of_using_3",
    "location_type", "num_premises_entered", "method_of_entry",
    "type_criminal_activity_1", "type_criminal_activity_2",
    "type_criminal_activity_3", "type_weapon_1", "type_weapon_2",
    "type_weapon_3", "bias_motivation",
  ],
  property: [
    "year", "state", "ori", "incident_num", "incident_date",
    "type_property_loss", "property_description", "value", "date_recovered",
    "num_stolen_motor_vehicles", "num_recovered_motor_vehicles",
    "suspected_drug_type_1", "suspected_drug_type_2", "suspected_drug_type_3",
  ],
  victims: [
    "year", "state", "ori", "incident_num", "incident_date",
    "victim_sequence", "victim_type", "age", "sex", "race", "ethnicity",
    "resident_status", "aggravated_assault_homicide_1",
    "aggravated_assault_homicide_2", "additional_justifiable_homicide",
    "injury_type_1", "injury_type_2", "injury_type_3", "injury_type_4",
    "injury_type_5", "offender_number_1", "offender_number_2",
    "offender_number_3", "relationship_1", "relationship_2",
    "relationship_3", "connected_offense_1", "connected_offense_2",
    "connected_offense_3", "connected_offense_4", "connected_offense_5",
    "connected_offense_6", "connected_offense_7",
  ],
  offenders: [
    "year", "state", "ori", "incident_num", "incident_date",
    "offender_sequence", "age", "sex", "race", "ethnicity",
  ],
  arrestees: [
    "year", "state", "ori", "incident_num", "incident_date",
    "arrestee_sequence", "arrest_number", "arrest_date", "arrest_type",
    "multiple_indicator", "ucr_arrest_offense", "arrestee_weapon_1",
    "arrestee_weapon_2", "age", "sex", "race", "ethnicity",
    "resident_status", "disposition_under_18",
  ],
  nibrs_offense_codes: ["code", "offense_name", "category"],
  nibrs_clearance_codes: ["code", "description", "detail"],
  nibrs_location_types: ["code", "description"],
  nibrs_property_descriptions: ["code", "description"],
  nibrs_weapon_codes: ["code", "description"],
  nibrs_race_codes: ["code", "description"],
  nibrs_ethnicity_codes: ["code", "description"],
  nibrs_pop_groups: ["code", "description"],
  agency_reporting_gaps: ["ori", "year", "city", "state", "population", "months_reported", "expected_months", "gap_type", "severity"],
  nibrs_national_coverage: ["year", "coverage_pct"],
  cde_agency_totals: ["ori", "year", "state", "city", "total_offenses"],
  state_population: ["state", "state_name", "year", "population", "source"],
};

const SAME_AS_SCHEMA: Record<string, string[]> = {
  summary_arrestee_demographics: [
    "ori", "year", "ucr_arrest_offense", "weapon_category", "race", "sex",
    "age_group", "ethnicity", "arrestee_count", "state",
  ],
  summary_drug_arrests: [
    "ori", "year", "state", "ucr_arrest_offense", "drug_category", "race",
    "sex", "age_group", "arrest_count",
  ],
  summary_homicide_victim: ["year", "victim_race", "victim_sex", "victim_age_group", "victim_count"],
  summary_homicide_offender: ["year", "offender_race", "offender_sex", "offender_age_group", "offender_count"],
  summary_homicide_victim_offender: ["year", "victim_race", "offender_race", "victim_count"],
  summary_carjacking_clearance: [
    "ori", "year", "month", "state", "total_offenses", "total_cleared",
    "city", "population", "agency_type",
  ],
  summary_carjacking_victim_demographics: [
    "ori", "year", "weapon_category", "race", "sex", "age_group", "state",
    "victim_count",
  ],
  summary_carjacking_offender_demographics: [
    "ori", "year", "weapon_category", "race", "sex", "age_group", "state",
    "offender_count",
  ],
  summary_carjacking_arrestee_demographics: [
    "ori", "year", "weapon_category", "race", "sex", "age_group", "state",
    "arrestee_count",
  ],
};

const SQL_START = /^\s{2,}(SELECT|WITH)\b/i;
const SQL_CONTINUATION = /^\s{2,}((SELECT|WITH|FROM|JOIN|LEFT|INNER|WHERE|AND|OR|GROUP|ORDER|HAVING|LIMIT|UNION|CASE|WHEN|ELSE|END|ROUND|SUM|COUNT|MAX|MIN|AVG|CAST|NULLIF|COALESCE|EXISTS|ROW_NUMBER)\b|\(|\)|[a-z_]+\.)/i;
const PROSE_HEADING = /^\s{2,}[A-Z][A-Za-z0-9 ,/+()-]+:\s*$/;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function parseDocumentedSchema(source: string): Record<string, string[]> {
  const schema: Record<string, string[]> = {};
  let currentTable = "";

  for (const line of source.split(/\r?\n/)) {
    const heading = line.match(/^###\s+([a-zA-Z0-9_]+)/);
    if (heading) currentTable = heading[1];

    const columns = line.match(/-\s+COLUMNS:\s+(.+)$/);
    if (!columns || !currentTable) continue;

    const names = columns[1]
      .split(",")
      .map((part) => part.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\b/)?.[1])
      .filter((name): name is string => Boolean(name));
    if (names.length > 0) schema[currentTable] = unique([...(schema[currentTable] || []), ...names]);
  }

  for (const [table, columns] of Object.entries(MANUAL_SCHEMA)) {
    schema[table] = unique([...(schema[table] || []), ...columns]);
  }
  for (const [table, columns] of Object.entries(SAME_AS_SCHEMA)) {
    schema[table] = unique([...(schema[table] || []), ...columns]);
  }

  return schema;
}

function extractExamples(source: string): Example[] {
  const lines = source.split(/\r?\n/);
  const examples: Example[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!SQL_START.test(lines[i])) continue;

    const previousNonBlank = lines.slice(0, i).findLast((line) => line.trim());
    if (previousNonBlank?.trim().endsWith("(")) continue;

    const startLine = i + 1;
    const block: string[] = [lines[i].trim()];
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (!line.trim()) break;
      if (PROSE_HEADING.test(line)) break;
      if (!SQL_CONTINUATION.test(line)) break;
      block.push(line.trim());
      j++;
    }

    const sql = block.join(" ").replace(/\s+/g, " ").replace(/;$/, "");
    examples.push({ line: startLine, sql });
  }

  return examples;
}

function shouldSkip(sql: string): string | null {
  if (/\.\.\.|\[[^\]]+\]|\$\{/.test(sql)) return "placeholder";
  if (/FROM\s+\(\s*\.\.\.\s*\)/i.test(sql)) return "placeholder subquery";
  if (/→|chartHint|yAxis|xAxis/i.test(sql)) return "chart metadata";
  if (/SELECT\s+code,\s*offense_name,\s*category\s+FROM\s+nibrs_offense_codes/i.test(sql)) return null;
  if (!/\bFROM\b/i.test(sql)) return "not a query";
  return null;
}

function createSchemaDb(schema: Record<string, string[]>): Database.Database {
  const db = new Database(":memory:");
  for (const [table, columns] of Object.entries(schema)) {
    const ddl = columns.length > 0
      ? columns.map((column) => `"${column}"`).join(", ")
      : '"id"';
    db.exec(`CREATE TABLE "${table}" (${ddl});`);
  }
  return db;
}

function validateExamples(examples: Example[], schema: Record<string, string[]>): { passed: number; skipped: number; failures: string[] } {
  const db = createSchemaDb(schema);
  let passed = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (const example of examples) {
    const skipReason = shouldSkip(example.sql);
    if (skipReason) {
      skipped++;
      continue;
    }

    if (/\bGROUP\s+BY\b[\s\S]*\bGROUP\s+BY\b/i.test(example.sql) && !/\bWITH\b|\bSELECT\b[\s\S]*\(\s*SELECT\b/i.test(example.sql)) {
      failures.push(`line ${example.line}: duplicate GROUP BY in one SELECT\n  ${example.sql}`);
      continue;
    }

    try {
      db.prepare(`EXPLAIN QUERY PLAN ${example.sql}`).all();
      passed++;
    } catch (error) {
      failures.push(`line ${example.line}: ${(error as Error).message}\n  ${example.sql}`);
    }
  }

  db.close();
  return { passed, skipped, failures };
}

const source = fs.readFileSync(PROMPT_PATH, "utf8");
const schema = parseDocumentedSchema(source);
const examples = extractExamples(source);
const result = validateExamples(examples, schema);

for (const failure of result.failures) {
  console.error(failure);
}

console.log(`NIBRS prompt SQL examples: ${result.passed} validated, ${result.skipped} skipped, ${result.failures.length} failed`);
if (result.failures.length > 0) process.exit(1);
