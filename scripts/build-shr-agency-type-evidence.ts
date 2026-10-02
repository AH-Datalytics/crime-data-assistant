/**
 * Builds the SHR agency-type evidence the approved classification policy reads (lib/shr-agency-classification.ts).
 *
 * WRITES only `shr_agency_type_binding`, `shr_agency_type_evidence` and the agency/year classification
 * (`shr_agency_year_class` + `shr_agency_year_class_meta`, lib/shr-agency-year-class.ts) in shr.db, dropped and
 * rebuilt in ONE transaction (a failure leaves the previous tables). The classification is the existing
 * period-bound classifier's decision for every (ori, state, year) in `incidents`, materialized from the evidence
 * just written -- not a second algorithm. It does NOT write `incidents` -- no `agency_type` fill,
 * so no legacy or name-default label is copied anywhere -- and it opens nibrs.db READ-ONLY.
 *
 * For each distinct SHR (ori, state) in `incidents`, the NIBRS agencies whose 9-character ORI begins with the
 * SHR ORI are looked up (never constructed). Each one with at least one row in the SHR state is a candidate,
 * and ALL its agency-year rows are copied with their year, their own recorded state and their type. Nothing
 * is decided here: which candidate applies, and whether its evidence is consistent, is decided per ranking
 * year by lib/shr-agency-classification.ts, from the rows up to that year only.
 *
 *   SHR_DB_PATH=<shr.db> NIBRS_DB_PATH=<nibrs.db> tsx scripts/build-shr-agency-type-evidence.ts [--apply]
 *
 * Without --apply it reads both databases and prints what it would write, writing nothing.
 */
import Database from "better-sqlite3";
import path from "node:path";
import { SHR_TYPE_BINDING_TABLE, SHR_TYPE_EVIDENCE_DDL, SHR_TYPE_EVIDENCE_TABLE, SHR_TYPE_SOURCE } from "../lib/shr-agency-classification";
import { computeYearClassRows, writeYearClass } from "../lib/shr-agency-year-class";

const shrPath = process.env.SHR_DB_PATH || path.join(process.cwd(), "shr.db");
const nibrsPath = process.env.NIBRS_DB_PATH || path.join(process.cwd(), "nibrs.db");

function main(): void {
  const apply = process.argv.includes("--apply");
  const nibrs = new Database(nibrsPath, { readonly: true, fileMustExist: true });
  const shr = new Database(shrPath, apply ? { fileMustExist: true } : { readonly: true, fileMustExist: true });
  try {
    const agencies = shr.prepare(
      "SELECT DISTINCT ori, state FROM incidents WHERE ori IS NOT NULL AND ori <> '' AND state IS NOT NULL AND state <> '' ORDER BY ori, state",
    ).all() as { ori: string; state: string }[];
    // Every NIBRS agency-year whose 9-character ORI begins with the SHR ORI, WITH ITS OWN STATE (Codex SC-1):
    // the ORI index (PRIMARY KEY (ori, year)) serves the prefix range; the upper bound sorts after every ORI character.
    const prefixRows = nibrs.prepare(
      "SELECT ori, year, COALESCE(state, '') AS state, COALESCE(agency_type, '') AS agency_type FROM agencies" +
      " WHERE ori >= ? AND ori < ? AND length(ori) = 9 ORDER BY ori, year");

    const bindings: { ori: string; state: string; candidate_oris: string }[] = [];
    const evidence: { ori: string; state: string; nibrs_ori: string; year: number; nibrs_state: string; agency_type: string }[] = [];
    for (const a of agencies) {
      const rows = prefixRows.all(a.ori, `${a.ori}ÿ`) as { ori: string; year: number; state: string; agency_type: string }[];
      // A candidate is a prefix ORI with at least one row in the SHR agency's state. All of its rows are kept, each
      // with the state NIBRS recorded for it, so a row from another state is evidence of inconsistency, never of type.
      const candidates = [...new Set(rows.filter((r) => r.state === a.state).map((r) => r.ori))];
      bindings.push({ ori: a.ori, state: a.state, candidate_oris: JSON.stringify(candidates) });
      for (const r of rows) {
        if (candidates.includes(r.ori)) evidence.push({ ori: a.ori, state: a.state, nibrs_ori: r.ori, year: r.year, nibrs_state: r.state, agency_type: r.agency_type });
      }
    }
    const summary = {
      applied: apply,
      agencies: agencies.length,
      withOneCandidate: bindings.filter((b) => JSON.parse(b.candidate_oris).length === 1).length,
      withSeveralCandidates: bindings.filter((b) => JSON.parse(b.candidate_oris).length > 1).length,
      withNoCandidate: bindings.filter((b) => JSON.parse(b.candidate_oris).length === 0).length,
      evidenceRows: evidence.length,
      otherStateRows: evidence.filter((e) => e.nibrs_state !== e.state).length,
    };
    let classSummary: Record<string, number> | null = null;
    if (apply) {
      const builtAt = new Date().toISOString();
      shr.transaction(() => {
        shr.exec(`DROP TABLE IF EXISTS ${SHR_TYPE_EVIDENCE_TABLE}; DROP TABLE IF EXISTS ${SHR_TYPE_BINDING_TABLE};`);
        shr.exec(SHR_TYPE_EVIDENCE_DDL);
        const b = shr.prepare(`INSERT INTO ${SHR_TYPE_BINDING_TABLE} (ori, state, candidate_oris, built_at) VALUES (?, ?, ?, ?)`);
        for (const r of bindings) b.run(r.ori, r.state, r.candidate_oris, builtAt);
        const e = shr.prepare(`INSERT INTO ${SHR_TYPE_EVIDENCE_TABLE} (ori, state, nibrs_ori, year, nibrs_state, agency_type, source) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        for (const r of evidence) e.run(r.ori, r.state, r.nibrs_ori, r.year, r.nibrs_state, r.agency_type, SHR_TYPE_SOURCE);
        // The agency/year classification, from the evidence just written, in the same transaction.
        const classRows = computeYearClassRows(shr);
        writeYearClass(shr, classRows, builtAt);
        classSummary = { agencyYears: classRows.length, eligible: 0, ineligible: 0, unresolved: 0 };
        for (const c of classRows) classSummary[c.membership] += 1;
      })();
    }
    console.log(JSON.stringify(classSummary ? { ...summary, classification: classSummary } : summary));
    if (!apply) console.log("Dry run only. Re-run with --apply to write these tables.");
  } finally {
    shr.close();
    nibrs.close();
  }
}

main();
