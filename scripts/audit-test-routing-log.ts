#!/usr/bin/env npx tsx
/**
 * Audit how /test Auto mode chooses a data source for each production query.
 *
 * This does not replay SQL. It runs the same deterministic source router used by
 * components/WorkspaceChatV2.tsx and grades the selected source against an
 * independent capability rubric.
 *
 * Usage:
 *   npx tsx scripts/audit-test-routing-log.ts
 *   npx tsx scripts/audit-test-routing-log.ts --file C:\Users\jeffm\Downloads\nibrs-query-log-2026-06-08.csv
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoRoute, isFollowUp, parseIntent, recommendTabs, type TabId } from "../lib/tab-suggest";

type LogRow = {
  id: number;
  ts: string;
  tab: TabId;
  question: string;
  sql: string;
  rows: number;
  error: string;
  ms: number;
};

type Expected = {
  primary: TabId[];
  acceptable: TabId[];
  clarity: "single_best" | "multiple_valid" | "unsupported_or_contextual";
  reason: string;
};

type ReplayLookup = {
  score?: string;
  rowCount?: number;
  issues?: string;
};

const DEFAULT_FILE = "C:\\Users\\jeffm\\Downloads\\nibrs-query-log-2026-06-08.csv";
const DEFAULT_REPLAY = "audit\\query-log-replay-2026-06-08T19-47-14-234Z.json";
const DEFAULT_OUT = "audit\\test-routing-source-workup-2026-06-08.csv";

const NIBRS_ONLY_OFFENSES = new Set([
  "carjacking", "vehicle_burglary", "theft_from_vehicle",
  "dui", "dwi", "trespass", "disorderly_conduct", "curfew",
  "liquor_law", "bad_checks", "peeping_tom", "runaway",
  "family_offense", "all_other_offenses",
  "drug_offense", "fraud", "embezzlement", "vandalism",
  "intimidation", "simple_assault", "kidnapping",
  "human_trafficking", "animal_cruelty", "extortion",
  "gambling", "prostitution", "pornography",
  "stolen_property", "weapon_law_violation",
  "identity_theft", "hacking",
]);

const HOMICIDE_OFFENSES = new Set(["murder", "homicide", "manslaughter", "killing", "nonnegligent_manslaughter"]);
const DETAIL_ATTRS = new Set([
  "weapon", "firearm", "victim_race", "victim_sex", "victim_age",
  "offender_demographics", "offender_race", "offender_sex", "offender_age",
  "arrest_demographics", "arrestee_race", "arrestee_sex", "arrestee_age",
  "relationship", "circumstance", "drug_type", "bias", "hate_crime",
  "location_type", "clearance_type", "time_of_day", "domestic_violence",
  "carjacking", "group_b_offenses", "incident_level",
]);

function parseArgs(argv: string[]) {
  const opts = { file: DEFAULT_FILE, replay: DEFAULT_REPLAY, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i] || "";
    if (arg === "--file") opts.file = next();
    else if (arg === "--replay") opts.replay = next();
    else if (arg === "--out") opts.out = next();
  }
  return opts;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter(r => r.some(c => c.trim()));
}

function loadRows(path: string): LogRow[] {
  const [header, ...records] = parseCsv(readFileSync(path, "utf8"));
  const index = new Map(header.map((name, i) => [name, i]));
  return records.map(record => ({
    id: Number(record[index.get("id")!]),
    ts: record[index.get("ts")!] || "",
    tab: normalizeTab(record[index.get("tab")!] || ""),
    question: record[index.get("question")!] || "",
    sql: record[index.get("sql")!] || "",
    rows: Number(record[index.get("rows")!] || 0),
    error: record[index.get("error")!] || "",
    ms: Number(record[index.get("ms")!] || 0),
  })).filter(row => row.id && row.question.trim());
}

function normalizeTab(tab: string): TabId {
  if (tab === "hc") return "hate_crime";
  if (tab === "current" || tab === "historical" || tab === "nibrs" || tab === "shr" || tab === "hate_crime") return tab;
  throw new Error(`Unsupported tab: ${tab}`);
}

function loadReplay(path: string): Map<number, ReplayLookup> {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { results?: Array<Record<string, unknown>> };
    const map = new Map<number, ReplayLookup>();
    for (const result of data.results || []) {
      const replay = result.replay as Record<string, unknown> | undefined;
      const issues = result.issues as unknown[] | undefined;
      map.set(Number(result.id), {
        score: String(result.score || ""),
        rowCount: Number(replay?.rowCount || 0),
        issues: (issues || []).map(String).join("; "),
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

function expectedSources(question: string): Expected {
  const q = question.toLowerCase();
  const intent = parseIntent(question);
  const attrs = new Set(intent.requiredAttributes);
  const offense = intent.offense;

  if (intent.unsupportedConcepts.length > 0 && /\b(conviction|sentenc|prison|dna|evidence|video|camera)\b/i.test(q)) {
    return {
      primary: ["historical", "nibrs"],
      acceptable: ["historical", "nibrs"],
      clarity: "unsupported_or_contextual",
      reason: `Unsupported concept (${intent.unsupportedConcepts.join(", ")}); source should route to a tab that can explain the limitation.`,
    };
  }

  if (/\b(hate crimes?|bias[- ]motivated|anti-(jewish|semit|black|white|asian|hispanic|latino|muslim|islamic|arab|sikh|hindu|gay|lesbian|lgbtq|transgender|bisexual)|antisemit|islamophob)\b/i.test(q)) {
    return { primary: ["hate_crime"], acceptable: ["hate_crime", "nibrs"], clarity: "single_best", reason: "Dedicated hate-crime/bias source is the best fit." };
  }

  if (/\b(shootings?|shot\b|gunshot|people\s+shot|gun\s+violence)\b/i.test(q)) {
    if (/\b(closest proxy|approximate|aggravated assault.{0,15}firearm)\b/i.test(q)) {
      return { primary: ["nibrs"], acceptable: ["nibrs"], clarity: "single_best", reason: "Firearm aggravated assault proxy belongs in NIBRS." };
    }
    return { primary: ["shr"], acceptable: ["shr"], clarity: "single_best", reason: "Shooting questions should route to SHR for fatal-shooting caveat/data." };
  }

  if (attrs.has("staffing")) {
    return { primary: ["historical"], acceptable: ["historical"], clarity: "single_best", reason: "Staffing/officer counts are Historical Library data." };
  }

  if (intent.geography.type === "county") {
    return { primary: ["historical"], acceptable: ["historical"], clarity: "single_best", reason: "County-level UCR geography is Historical Library." };
  }

  if (attrs.has("bias") || attrs.has("hate_crime")) {
    return { primary: ["hate_crime"], acceptable: ["hate_crime", "nibrs"], clarity: "single_best", reason: "Bias motivation is best handled by the Hate Crime source." };
  }

  if (attrs.has("clearance_type") || /\bexception(al|ally)?\b|\bcleared by arrest\b|\bprosecution declined\b/i.test(q)) {
    return { primary: ["nibrs"], acceptable: ["nibrs"], clarity: "single_best", reason: "Arrest-vs-exceptional clearance detail is NIBRS." };
  }

  if (offense && NIBRS_ONLY_OFFENSES.has(offense)) {
    return { primary: ["nibrs"], acceptable: ["nibrs"], clarity: "single_best", reason: `${offense.replace(/_/g, " ")} is NIBRS-specific.` };
  }

  if ([...attrs].some(a => ["location_type", "time_of_day", "drug_type", "arrest_demographics", "arrestee_race", "arrestee_sex", "arrestee_age", "group_b_offenses", "incident_level"].includes(a))) {
    return { primary: ["nibrs"], acceptable: ["nibrs"], clarity: "single_best", reason: "Incident/location/arrest/drug detail is NIBRS-only." };
  }

  if (offense && HOMICIDE_OFFENSES.has(offense) && [...attrs].some(a => ["relationship", "circumstance", "weapon", "firearm", "victim_race", "victim_sex", "victim_age", "offender_demographics", "offender_race", "offender_sex", "offender_age", "domestic_violence"].includes(a))) {
    return { primary: ["shr"], acceptable: ["shr", "nibrs"], clarity: "single_best", reason: "Detailed homicide attributes are best handled by SHR; NIBRS can be acceptable for recent incident detail." };
  }

  if ([...attrs].some(a => DETAIL_ATTRS.has(a))) {
    return { primary: ["nibrs"], acceptable: ["nibrs"], clarity: "single_best", reason: "Non-homicide detail/demographics require NIBRS." };
  }

  if (intent.measure === "clearance_rate") {
    if (intent.geography.type === "state" || intent.geography.type === "national" || (intent.timeRange.start !== null && intent.timeRange.start < 1991)) {
      return { primary: ["historical"], acceptable: ["historical"], clarity: "single_best", reason: "Broad/long-range clearance rates belong in Historical Library." };
    }
    return { primary: ["historical"], acceptable: ["historical", "nibrs"], clarity: "multiple_valid", reason: "Basic city/offense clearance rates can be Historical or NIBRS depending on desired detail." };
  }

  if (intent.granularity === "monthly") {
    return { primary: ["current"], acceptable: ["current", "nibrs"], clarity: "single_best", reason: "Recent monthly Part I trends are Current Trends unless NIBRS detail is requested." };
  }

  if (intent.timeRange.start !== null && intent.timeRange.start < 2017) {
    return { primary: ["historical"], acceptable: ["historical"], clarity: "single_best", reason: "Pre-2017/long-range Part I trends require Historical Library." };
  }

  if (intent.geography.type === "state" && intent.measure === "rate") {
    return { primary: ["historical"], acceptable: ["historical"], clarity: "single_best", reason: "State-level rates require Historical Library population/rate coverage." };
  }

  if (intent.measure === "ranking") {
    return { primary: ["historical"], acceptable: ["historical", "current"], clarity: "multiple_valid", reason: "Rankings are most complete in Historical; Current can be valid for recent sample-agency rankings." };
  }

  return { primary: ["historical"], acceptable: ["historical", "current"], clarity: "multiple_valid", reason: "Generic Part I queries can reasonably use Historical or Current depending on time/granularity." };
}

function gradeSource(chosen: TabId | "", routeConfidence: string, expected: Expected) {
  if (!chosen) {
    if (expected.primary.length > 0 && routeConfidence) {
      return { grade: "source_picker_ok", reason: `No source auto-submitted; picker shown. Top recommendation can be reviewed against expected ${expected.primary.join("|")}.` };
    }
    return { grade: "source_picker_ok", reason: "No automatic source; picker shown for ambiguous/contextual query." };
  }
  if (expected.primary.includes(chosen)) {
    return { grade: "correct_source", reason: `Auto-submitted ${chosen}, matching expected primary source.` };
  }
  if (expected.acceptable.includes(chosen)) {
    return { grade: "acceptable_source", reason: `Auto-submitted ${chosen}; not primary, but acceptable for this query.` };
  }
  return { grade: "wrong_auto_source", reason: `Auto-submitted ${chosen}; expected ${expected.primary.join("|")} (${routeConfidence} confidence).` };
}

function gradeLoggedTab(tab: TabId, expected: Expected): string {
  if (expected.primary.includes(tab)) return "logged_primary";
  if (expected.acceptable.includes(tab)) return "logged_acceptable";
  return "logged_wrong_or_suboptimal";
}

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = loadRows(opts.file).sort((a, b) => a.id - b.id);
  const replay = loadReplay(opts.replay);
  const headers = [
    "id", "timestamp", "question", "logged_tab",
    "test_action", "auto_submitted_source", "router_primary", "router_confidence", "router_reason", "router_alternatives",
    "source_grade", "source_grade_reason", "expected_primary_sources", "expected_acceptable_sources", "expected_reason",
    "logged_tab_grade", "is_followup_by_router", "intent_offense", "intent_measure", "intent_geo_type", "intent_time_start", "intent_time_end", "intent_granularity", "intent_required_attributes", "intent_unsupported_concepts",
    "original_rows", "original_error", "replay_score", "replay_rows", "replay_issues",
  ];

  const lines = [headers.join(",")];
  const counts = new Map<string, number>();

  for (const row of rows) {
    const route = autoRoute(row.question);
    const intent = parseIntent(row.question);
    const followUp = isFollowUp(row.question);
    const recs = recommendTabs(row.question);
    const expected = expectedSources(row.question);
    const autoSubmittedSource = route && route.confidence === "high" ? route.source : "";
    const testAction = autoSubmittedSource ? "auto_submitted" : "source_picker";
    const grade = gradeSource(autoSubmittedSource, route?.confidence || "", expected);
    const priorReplay = replay.get(row.id) || {};
    counts.set(grade.grade, (counts.get(grade.grade) || 0) + 1);

    lines.push([
      row.id,
      row.ts,
      row.question,
      row.tab,
      testAction,
      autoSubmittedSource,
      route?.source || "",
      route?.confidence || "",
      route?.reason || "",
      recs.map(r => `${r.tab}:${r.score}`).join("; "),
      grade.grade,
      grade.reason,
      expected.primary.join("|"),
      expected.acceptable.join("|"),
      expected.reason,
      gradeLoggedTab(row.tab, expected),
      followUp,
      intent.offense || "",
      intent.measure,
      intent.geography.type,
      intent.timeRange.start ?? "",
      intent.timeRange.end ?? "",
      intent.granularity,
      intent.requiredAttributes.join("|"),
      intent.unsupportedConcepts.join("|"),
      row.rows,
      row.error,
      priorReplay.score || "",
      priorReplay.rowCount ?? "",
      priorReplay.issues || "",
    ].map(csvEscape).join(","));
  }

  writeFileSync(opts.out, lines.join("\n"));
  console.log(`Wrote ${join(process.cwd(), opts.out)}`);
  console.log(Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])));
}

main();
