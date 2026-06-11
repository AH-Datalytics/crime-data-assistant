import Database from "better-sqlite3";
import path from "node:path";
import {
  buildStatePopulationRows,
  type HistoricalPopulationRow,
  type StatePopulationRow,
} from "../lib/state-population";

function argValue(name: string): string | null {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function defaultHistoricalPath(): string {
  return process.env.RTCI_DB_PATH || path.join(process.cwd(), "crime_data.db");
}

function defaultNibrsPath(): string {
  return process.env.NIBRS_DB_PATH || path.join(process.cwd(), "nibrs.db");
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table));
}

function loadHistoricalRows(db: Database.Database): HistoricalPopulationRow[] {
  if (!tableExists(db, "historical_state_national")) {
    throw new Error("historical_state_national table not found in historical database");
  }
  return db.prepare(`
    SELECT state, year, population
    FROM historical_state_national
    WHERE population IS NOT NULL AND population > 0
    ORDER BY state, year
  `).all() as HistoricalPopulationRow[];
}

function createTable(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS state_population;
    CREATE TABLE state_population (
      state TEXT NOT NULL,
      state_name TEXT NOT NULL,
      year INTEGER NOT NULL,
      population INTEGER NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (state, year)
    );
    CREATE INDEX IF NOT EXISTS idx_state_population_year
      ON state_population(year, state);
  `);
}

function insertRows(db: Database.Database, rows: StatePopulationRow[]): void {
  const insert = db.prepare(`
    INSERT INTO state_population (state, state_name, year, population, source)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(row.state, row.state_name, row.year, row.population, row.source);
  }
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const historicalPath = argValue("--historical") || defaultHistoricalPath();
  const nibrsPath = argValue("--nibrs") || defaultNibrsPath();
  const historical = new Database(historicalPath, { readonly: true, fileMustExist: true });
  const nibrs = new Database(nibrsPath, apply ? undefined : { readonly: true, fileMustExist: true });

  try {
    if (!tableExists(nibrs, "agencies")) {
      throw new Error(`No agencies table found in ${nibrsPath}`);
    }

    const rows = buildStatePopulationRows(loadHistoricalRows(historical));
    if (rows.length === 0) {
      throw new Error("No mappable state population rows found");
    }

    if (apply) {
      nibrs.transaction(() => {
        createTable(nibrs);
        insertRows(nibrs, rows);
      })();
    }

    const years = rows.map((row) => row.year);
    const states = new Set(rows.map((row) => row.state));
    const result = {
      applied: apply,
      historicalPath,
      nibrsPath,
      rows: rows.length,
      states: states.size,
      firstYear: Math.min(...years),
      lastYear: Math.max(...years),
      sample: rows.filter((row) => (row.state === "PA" || row.state === "US") && row.year === Math.max(...years)),
    };
    console.log(JSON.stringify(result, null, 2));
    if (!apply) {
      console.log("\nDry run only. Re-run with --apply to replace state_population in the NIBRS database.");
    }
  } finally {
    historical.close();
    nibrs.close();
  }
}

main();
