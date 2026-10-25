/**
 * Owner 2026-10-25 ("virginia murder clearances by exception by type in 2025"): the clearance-type breakdown narrowed
 * to exceptional clearances answers with the five exceptional types only, each a share of all exceptional clearances;
 * the unnarrowed breakdown is unchanged (arrest, the five types and "Not cleared", shares of all offenses).
 *   npx tsx scripts/test-nibrs-exceptional-by-type.ts
 */
import "./offline-evidence-guard";
import Database from "better-sqlite3";
import { compileNibrsSpec, type CompiledAnswer } from "../lib/nibrs-question-compiler";
import { matchNibrsType, type BreakdownSpec } from "../lib/nibrs-question-types";
import { accountNibrsRequest } from "../lib/nibrs-request-accounting";
import { nibrsUnboundParts } from "../lib/nibrs-legacy-binding";

let checks = 0;
let failures = 0;
function check(ok: boolean, label: string): void {
  checks += 1;
  if (!ok) { failures += 1; console.log(`  FAIL  ${label}`); } else if (!process.env.QUIET) console.log(`  PASS  ${label}`);
}

const db = new Database(":memory:");
db.exec(`
CREATE TABLE agencies (ori TEXT, year INT, state TEXT, city TEXT, agency_type TEXT, population INT, pop_group TEXT);
CREATE TABLE nibrs_agency_completeness (ori TEXT, year INT, months_reported INT, total_offenses INT);
CREATE TABLE summary_clearance_detail (year INT, state TEXT, ori TEXT, ucr_offense_code TEXT, cleared_by_arrest INT, cleared_A INT, cleared_B INT, cleared_C INT, cleared_D INT, cleared_E INT, total_offenses INT);
CREATE TABLE summary_state_monthly (state TEXT, year INT, month INT, ucr_offense_code TEXT, offense_count INT, cleared_count INT);
`);
db.prepare("INSERT INTO agencies VALUES ('VA0001', 2025, 'VA', 'RICHMOND', 'City', 230000, '1C')").run();
db.prepare("INSERT INTO nibrs_agency_completeness VALUES ('VA0001', 2025, 12, 500)").run();
// 100 murders: 60 by arrest, exceptional A=4, B=3, C=2, D=1, E=0 (10 exceptional), 30 not cleared.
db.prepare("INSERT INTO summary_clearance_detail VALUES (2025, 'VA', 'VA0001', '09A', 60, 4, 3, 2, 1, 0, 100)").run();
for (let m = 1; m <= 12; m += 1) db.prepare("INSERT INTO summary_state_monthly VALUES ('VA', 2025, ?, '09A', ?, 0)").run(m, m === 1 ? 100 : 0);

const ctx = { db, now: new Date(Date.UTC(2026, 9, 25)), cutoff: { year: 2025, month: 12 }, run: async (sql: string) => db.prepare(sql).all() as Record<string, unknown>[] };
const spec = (filters: string[]): BreakdownSpec => ({ type: "breakdown", measure: "murder", unit: null, filters, dim: "clearance-type", place: { kind: "state", name: "Virginia", code: "VA", label: "Virginia" }, period: { form: "year", year: 2025 } });
const rowsOf = (a: CompiledAnswer) => (a.kind === "answer" ? a.rows.map((r) => `${r.category}=${r.count}/${r.share}`) : [`decline: ${a.explanation}`]);

(async () => {
  const ex = await compileNibrsSpec(spec(["clearance:exceptional"]), ctx);
  const exRows = rowsOf(ex);
  check(ex.kind === "answer", `exceptional by type answers (${exRows.join("; ")})`);
  if (ex.kind === "answer") {
    check(ex.rows.length === 5 && !exRows.some((r) => /arrest|Not cleared/i.test(r)), "only the five exceptional types are shown");
    check(exRows.includes("Death of offender=4/40") && exRows.includes("Prosecution declined=3/30") && exRows.includes("In custody of another jurisdiction (includes extradition denied)=2/20"), "each share is of all exceptional clearances (4 of 10 = 40%)");
    check(/exceptional clearances by type/i.test(ex.title) && /Exceptional clearances only/.test(ex.explanation), `title and explanation say exceptional only (${ex.title})`);
  }
  // Codex EX-01: the owner's question end to end -- request accounting, type match, compile, delivery binding.
  const q = "virginia murder clearances by exception by type in 2025";
  const ledger = accountNibrsRequest(q);
  const decision = matchNibrsType(ledger);
  check(decision.kind === "spec", `the owner's question matches a type (${decision.kind})`);
  if (decision.kind === "spec") {
    const compiled = await compileNibrsSpec(decision.spec, ctx);
    check(compiled.kind === "answer" && compiled.rows.length === 5, `it compiles to the five exceptional types (${rowsOf(compiled).join("; ")})`);
    if (compiled.kind === "answer") {
      check((compiled.applied.filters ?? []).includes("clearance:exceptional"), "the narrowing is recorded as applied");
      const unbound = nibrsUnboundParts(ledger, compiled.applied, ctx.now);
      check(unbound.length === 0, `delivery binding accepts it: no unbound part (${unbound.map((p) => p.text).join(", ") || "none"})`);
    }
  }
  // Codex EX-02: all five category labels (C = FBI "In Custody of Other Jurisdiction", which includes extradition denied).
  if (ex.kind === "answer") check(JSON.stringify(ex.rows.map((r) => r.category).sort()) === JSON.stringify(["Death of offender", "In custody of another jurisdiction (includes extradition denied)", "Juvenile, no custody", "Prosecution declined", "Victim refused to cooperate"]), `the five exceptional labels (${ex.rows.map((r) => r.category).join(" | ")})`);
  const all = await compileNibrsSpec(spec([]), ctx);
  const allRows = rowsOf(all);
  check(all.kind === "answer" && all.rows.length === 7 && allRows.includes("Cleared by arrest=60/60") && allRows.includes("Not cleared=30/30"), `control: the unnarrowed breakdown is unchanged (${allRows.join("; ")})`);
  console.log(`\n${checks - failures}/${checks} passed`);
  if (failures > 0) process.exit(1);
})();
