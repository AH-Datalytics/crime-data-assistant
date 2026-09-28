/**
 * Increment 5 — source adapters for population-peer selection.
 *
 * The architecture decision (Batch 1 review §4) is a deterministic query path: the adapter
 * obtains eligible population candidates for the resolved subject and period, the pure
 * peer core selects them, the deterministic query reads the SELECTED identities, and the
 * disclosure is generated from the actual selected set.
 *
 * Selection deliberately does NOT happen in SQL any more. A `LIMIT n` over an ordered
 * candidate pool picks peers the product cannot then name, and Decision 16 requires every
 * peer named and the real band stated. Selecting in TypeScript makes the chosen set a
 * value the disclosure and the verification can both read.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PeerCandidate } from "./peer-comparison";

export interface PeerCandidateQuery {
  /** Population year the candidates are drawn from. */
  year: number;
  /** The subject's ORI, always excluded from its own peer pool. */
  excludeOri: string;
  /** Subject population, used to order the pool by closeness. */
  population: number;
  /** How many candidates to consider before selection. */
  poolSize?: number;
}

/** Structural: any better-sqlite3-like handle. Kept loose so routes can pass their own. */
type MinimalDb = { prepare: (sql: string) => { all: (...params: any[]) => unknown[] } };

/**
 * NIBRS candidates: city police agencies with a positive population in the reference
 * year, ordered by closeness to the subject. Population alone — no region, no crime
 * volume, no reporting quality, because Decision 16 selects on population alone.
 */
export function fetchNibrsPeerCandidates(db: MinimalDb, q: PeerCandidateQuery): PeerCandidate[] {
  const rows = db.prepare(`
    SELECT a.ori,
           COALESCE(NULLIF(a.city, ''), a.ori) AS agency,
           a.state,
           a.population
    FROM agencies a
    WHERE a.year = ?
      AND a.agency_type = 'City'
      AND a.population > 0
      AND a.ori <> ?
    ORDER BY ABS(a.population - ?), a.ori
    LIMIT ?
  `).all(q.year, q.excludeOri, q.population, q.poolSize ?? 100) as {
    ori: string; agency: string; state: string; population: number;
  }[];
  return rows.map(r => ({ ori: r.ori, agency: r.agency, state: r.state, population: Number(r.population) }));
}

/**
 * Historical candidates: agencies with a population for the reference year in the
 * historical tables. Same rule, different source of truth.
 */
export function fetchHistoricalPeerCandidates(db: MinimalDb, q: PeerCandidateQuery): PeerCandidate[] {
  const rows = db.prepare(`
    SELECT ha.ori,
           ha.agency,
           ha.state,
           hap.population
    FROM historical_agency_population hap
    JOIN historical_agency ha ON ha.ori = hap.ori
    WHERE hap.year = ?
      AND hap.population > 0
      AND ha.ori <> ?
      AND LOWER(ha.type) = 'city'
    ORDER BY ABS(hap.population - ?), ha.ori
    LIMIT ?
  `).all(q.year, q.excludeOri, q.population, q.poolSize ?? 100) as {
    ori: string; agency: string; state: string; population: number;
  }[];
  return rows.map(r => ({ ori: r.ori, agency: r.agency, state: (r.state || "").toUpperCase(), population: Number(r.population) }));
}

/** Injectable candidate source, so a route-level test needs no live database. */
export type PeerCandidateSource = (q: PeerCandidateQuery) => PeerCandidate[];

/**
 * The honest limitation returned when peers cannot be established. Decision 16 would
 * rather say why than pick a set the reader cannot check.
 */
export function peerEvidenceUnavailable(subject: string, reason: string): string {
  return `I can't build a like-for-like comparison for ${subject}: ${reason}. ` +
    `Ask for a specific set of agencies by name and I'll compare those.`;
}

/**
 * Resolve a Historical subject's ORI and population for the most recent year we have.
 * Returns null when either cannot be established — the caller then returns an honest
 * limitation rather than sizing a peer group from a guess.
 */
export function resolveHistoricalSubjectPopulation(
  db: MinimalDb,
  name: string,
  state: string,
): { ori: string; population: number; year: number } | null {
  // Identity, not a substring guess. The previous LIKE '%name%' could resolve
  // "Allegheny" to a county agency, or a city to whichever row sorted first. We match the
  // agency name exactly (case-insensitively), restrict to the city agency kind, and
  // REFUSE when more than one identity matches — an honest limitation beats a confident
  // wrong ORI. This uses the existing historical_agency identity/kind mapping rather than
  // starting a universal identity migration.
  const rows = db.prepare(`
    SELECT DISTINCT ha.ori
    FROM historical_agency ha
    WHERE UPPER(ha.agency) = UPPER(?)
      AND UPPER(ha.state) = UPPER(?)
      AND LOWER(ha.type) = 'city'
  `).all(name, state) as { ori: string }[];
  if (rows.length !== 1) return null;   // unresolved or ambiguous
  const ori = rows[0].ori;

  // The most recent year with a population for that identity — the reference year the
  // peer band is sized on.
  const pop = db.prepare(`
    SELECT year, population
    FROM historical_agency_population
    WHERE ori = ? AND population > 0
    ORDER BY year DESC
    LIMIT 1
  `).all(ori) as { year: number; population: number }[];
  if (pop.length === 0) return null;
  return { ori, population: Number(pop[0].population), year: Number(pop[0].year) };
}
