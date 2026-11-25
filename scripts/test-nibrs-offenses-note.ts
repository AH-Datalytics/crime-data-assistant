/*
 * Owner decision (Jeff, 2026-11-23): a person crime answered by location or hour of day counts OFFENSES (NIBRS keeps those
 * figures by offense only), and the answer says so. Text only. The sentence appears for person crimes from the offense
 * location / hour tables, and not for property crimes or for weapon (a victim table) answers.
 */
import "./offline-evidence-guard";
import Database from "better-sqlite3";
import { compileNibrsSpec, OFFENSES_NOT_VICTIMS_NOTE, type CompiledAnswer } from "../lib/nibrs-question-compiler";
import type { BreakdownSpec } from "../lib/nibrs-question-types";

let checks = 0;
let failures = 0;
function check(ok: boolean, label: string): void {
  checks += 1;
  if (!ok) { failures += 1; console.log(`  FAIL  ${label}`); } else if (!process.env.QUIET) console.log(`  PASS  ${label}`);
}

const db = new Database(":memory:");
db.exec(`
CREATE TABLE agencies (ori TEXT, year INT, state TEXT, city TEXT, agency_type TEXT, population INT);
CREATE TABLE nibrs_agency_completeness (ori TEXT, year INT, months_reported INT, total_offenses INT);
CREATE TABLE summary_offense_location (ori TEXT, year INT, state TEXT, ucr_offense_code TEXT, location_type TEXT, offense_count INT);
CREATE TABLE summary_offense_hour (state TEXT, year INT, ucr_offense_code TEXT, incident_hour INT, offense_count INT);
`);
db.prepare("INSERT INTO agencies VALUES ('AA001', 2024, 'AA', 'Aville', 'City', 100000)").run();
db.prepare("INSERT INTO nibrs_agency_completeness VALUES ('AA001', 2024, 12, 100)").run();
for (const code of ["09A", "220"]) {
  db.prepare("INSERT INTO summary_offense_location VALUES ('AA001', 2024, 'AA', ?, '20', 7)").run(code);
  db.prepare("INSERT INTO summary_offense_hour VALUES ('AA', 2024, ?, 3, 5)").run(code);
}
const ctx = { db, now: new Date(Date.UTC(2026, 10, 23)), cutoff: { year: 2025, month: 12 }, run: async (sql: string) => db.prepare(sql).all() as Record<string, unknown>[] };
const spec = (measure: string, dim: string): BreakdownSpec => ({ type: "breakdown", measure, unit: "offenses", filters: [], dim, place: { kind: "state", name: "Aland", code: "AA", label: "Aland" }, period: { form: "year", year: 2024 } });
const text = (a: CompiledAnswer) => (a.kind === "answer" ? a.explanation : `decline: ${a.explanation}`);

void (async () => {
  const murderLoc = await compileNibrsSpec(spec("murder", "location"), ctx);
  check(text(murderLoc).includes(OFFENSES_NOT_VICTIMS_NOTE), `person crime by location carries the sentence (${text(murderLoc).slice(0, 160)})`);
  const murderHour = await compileNibrsSpec(spec("murder", "hour"), ctx);
  check(text(murderHour).includes(OFFENSES_NOT_VICTIMS_NOTE), `person crime by hour carries the sentence (${text(murderHour).slice(0, 160)})`);
  const burgLoc = await compileNibrsSpec(spec("burglary", "location"), ctx);
  check(!text(burgLoc).includes(OFFENSES_NOT_VICTIMS_NOTE), "a property crime by location does not");
  check(OFFENSES_NOT_VICTIMS_NOTE === "These count offenses, not victims: NIBRS keeps location and time-of-day figures by offense.", "the sentence is the agreed text");
  console.log(`\n${checks - failures}/${checks} passed`);
  if (failures > 0) process.exit(1);
})();
