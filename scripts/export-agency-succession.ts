/**
 * Export data/reference/agency_succession.csv from CONSOLIDATED_AGENCIES (lib/agency-consolidations.ts).
 * One row per merged agency, plus one row per deliberate exclusion.
 * Usage: tsx scripts/export-agency-succession.ts [out.csv]
 */
import { writeFileSync } from "node:fs";
import { CONSOLIDATED_AGENCIES, CONSOLIDATION_EXCLUSIONS } from "../lib/agency-consolidations";

export const SUCCESSION_HEADER = ["state", "alias", "rule", "successor_ori9", "successor_shr_ori7", "predecessor_name",
  "predecessor_shr_ori7", "predecessor_last_year", "survivor_agency", "survivor_type", "display_names", "evidence_note"];

function cell(v: unknown): string {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function successionRows(): string[][] {
  const rows: string[][] = CONSOLIDATED_AGENCIES.map((e) => [
    e.state, e.alias, "merge", e.nibrsOri ?? e.historicalOri, e.shrOri ?? "", e.predecessor ?? "", e.shrPredecessorOri ?? "",
    e.predecessorLastYear === undefined ? "" : String(e.predecessorLastYear), e.historicalAgency, e.historicalType,
    (e.sourceDisplayNames ?? []).join("|"), e.note,
  ]);
  for (const ex of CONSOLIDATION_EXCLUSIONS) {
    const i = ex.lastIndexOf(", ");
    rows.push([ex.slice(i + 2), ex.slice(0, i), "exclude", "", "", "", "", "", "", "", "", "Looks like a merger but is not; do not rewrite."]);
  }
  return rows.sort((a, b) => (a[0] + "|" + a[1] + "|" + a[2]).localeCompare(b[0] + "|" + b[1] + "|" + b[2]));
}

export function successionCsv(): string {
  return [SUCCESSION_HEADER, ...successionRows()].map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

if (process.argv[1] && /export-agency-succession/.test(process.argv[1])) {
  const out = process.argv[2] ?? "data/reference/agency_succession.csv";
  writeFileSync(out, successionCsv(), "utf8");
  console.log(`${successionRows().length} rows -> ${out}`);
}
