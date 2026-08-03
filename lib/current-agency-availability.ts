import type Database from "better-sqlite3";
import { resolveGeoPlaces } from "./geo-place-resolver";

export type VerifiedCurrentAgency = {
  agency: string;
  state: string;
  type: string;
  dataRows: number;
};

/** Verify a named city has actual Current Trends rows before any refusal. */
export function findVerifiedCurrentAgency(question: string, db: Database.Database): VerifiedCurrentAgency | null {
  const resolution = resolveGeoPlaces(question);
  for (const mention of resolution.mentions) {
    if (mention.requiresClarification) continue;
    for (const candidate of mention.candidates) {
      if (candidate.kind !== "city" || !candidate.state) continue;
      try {
        const rows = db.prepare(`
          SELECT a.agency, a.state, a.type, COUNT(*) AS dataRows
          FROM agencies a
          JOIN agency_monthly am ON am.ori = a.ori
          WHERE upper(a.agency) = upper(?)
            AND upper(a.state) = upper(?)
            AND lower(a.type) = 'city'
          GROUP BY a.agency, a.state, a.type
          HAVING COUNT(*) > 0
          LIMIT 2
        `).all(candidate.name, candidate.state) as VerifiedCurrentAgency[];
        if (rows.length === 1) return rows[0];
      } catch {
        return null;
      }
    }
  }
  return null;
}
