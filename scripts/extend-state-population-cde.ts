/**
 * Extend state_population with recent years from the FBI CDE API.
 *
 * The base table is built from historical_state_national (FBI CIUS estimates),
 * which lags the current year by 1-2 years. Rate queries for 2025/2026 return
 * empty results because the INNER JOIN to state_population finds no rows
 * (query-audit-2026-07-03, F26). This script fills the gap using the same
 * population figures the FBI CDE itself uses for rate calculations
 * (populations.population in the summarized counts API).
 *
 * FBI applies its current population estimate to all in-progress years, so
 * 2025 and 2026 will carry the same figure until FBI publishes year-specific
 * estimates; re-running this script refreshes them (INSERT OR REPLACE, but
 * never overwrites rows from the historical source).
 *
 * Usage:
 *   npx tsx scripts/extend-state-population-cde.ts --db=shr.db --db=/opt/nibrs/db/nibrs.db --apply
 *
 * Dry-run (no --apply) fetches and prints what would be written.
 * Run by the monthly importers after each data import.
 */
import Database from "better-sqlite3";
import { STATE_NAME_TO_ABBR, type StatePopulationRow } from "../lib/state-population";

const CDE_BASE = "https://cde.ucr.cjis.gov/LATEST";
const SOURCE = "FBI CDE API populations.population";
const CONCURRENCY = 5;
const RETRIES = 3;

function argValues(name: string): string[] {
  const prefix = `${name}=`;
  return process.argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
}

async function fetchWithRetry(url: string): Promise<any> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  throw new Error(`CDE fetch failed after ${RETRIES} attempts: ${url}: ${lastError}`);
}

/** populations.population["Mississippi"]["01-2025"] → { 2025: n, 2026: n } */
function yearlyPopulation(monthly: Record<string, number> | undefined, years: number[]): Map<number, number> {
  const result = new Map<number, number>();
  if (!monthly) return result;
  for (const year of years) {
    const values = Object.entries(monthly)
      .filter(([key, value]) => key.endsWith(`-${year}`) && Number.isFinite(value) && value > 0)
      .map(([, value]) => value);
    if (values.length > 0) result.set(year, Math.round(values.reduce((a, b) => a + b, 0) / values.length));
  }
  return result;
}

async function fetchStateRows(years: number[]): Promise<StatePopulationRow[]> {
  const from = `01-${Math.min(...years)}`;
  const to = `12-${Math.max(...years)}`;
  const states = Object.entries(STATE_NAME_TO_ABBR).filter(([, abbr]) => abbr !== "US");
  const rows: StatePopulationRow[] = [];
  const nationalSamples = new Map<number, number>();

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < states.length) {
      const [stateName, abbr] = states[cursor++];
      const data = await fetchWithRetry(
        `${CDE_BASE}/summarized/state/${abbr}/HOM?from=${from}&to=${to}&type=counts`
      );
      const population = data?.populations?.population ?? {};
      const stateKey = Object.keys(population).find((key) => key !== "United States");
      for (const [year, value] of yearlyPopulation(stateKey ? population[stateKey] : undefined, years)) {
        rows.push({ state: abbr, state_name: stateName, year, population: value, source: SOURCE });
      }
      for (const [year, value] of yearlyPopulation(population["United States"], years)) {
        if (!nationalSamples.has(year)) nationalSamples.set(year, value);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  for (const [year, value] of nationalSamples) {
    rows.push({ state: "US", state_name: "United States", year, population: value, source: SOURCE });
  }
  return rows.sort((a, b) => a.state.localeCompare(b.state) || a.year - b.year);
}

function missingYears(db: Database.Database): number[] {
  const currentYear = new Date().getFullYear();
  const { maxYear } = db
    .prepare("SELECT MAX(year) AS maxYear FROM state_population WHERE source NOT LIKE 'FBI CDE API%'")
    .get() as { maxYear: number | null };
  if (!maxYear) throw new Error("state_population is empty — run build-shr-state-population.ts first");
  const years: number[] = [];
  for (let year = maxYear + 1; year <= currentYear; year++) years.push(year);
  return years;
}

function applyRows(db: Database.Database, rows: StatePopulationRow[]): number {
  // Never overwrite year-specific historical estimates; only add/refresh CDE-sourced rows.
  const upsert = db.prepare(`
    INSERT INTO state_population (state, state_name, year, population, source)
    VALUES (@state, @state_name, @year, @population, @source)
    ON CONFLICT (state, year) DO UPDATE SET
      population = excluded.population, source = excluded.source
      WHERE state_population.source LIKE 'FBI CDE API%'
  `);
  let written = 0;
  db.transaction(() => {
    for (const row of rows) written += upsert.run(row).changes;
  })();
  return written;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const dbPaths = argValues("--db");
  if (dbPaths.length === 0) {
    throw new Error("Pass at least one --db=<path> (a database containing state_population)");
  }

  // Determine the year gap from the first DB; all targets get the same rows.
  const probe = new Database(dbPaths[0], { readonly: true, fileMustExist: true });
  const years = missingYears(probe);
  probe.close();
  if (years.length === 0) {
    console.log(JSON.stringify({ applied: false, message: "state_population is already current" }));
    return;
  }

  const rows = await fetchStateRows(years);
  const expected = years.length * Object.keys(STATE_NAME_TO_ABBR).length;
  if (rows.length < expected * 0.9) {
    throw new Error(`Only fetched ${rows.length}/${expected} rows from CDE — aborting, nothing written`);
  }

  const results: Record<string, number> = {};
  for (const dbPath of dbPaths) {
    const db = new Database(dbPath, apply ? undefined : { readonly: true, fileMustExist: true });
    try {
      results[dbPath] = apply ? applyRows(db, rows) : 0;
    } finally {
      db.close();
    }
  }

  console.log(JSON.stringify({
    applied: apply,
    years,
    fetchedRows: rows.length,
    writtenPerDb: results,
    sample: rows.filter((row) => row.state === "MS" || row.state === "US"),
  }, null, 2));
  if (!apply) console.log("\nDry run only. Re-run with --apply to write these rows.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
