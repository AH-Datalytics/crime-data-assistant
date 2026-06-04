import Database from "better-sqlite3";
import path from "path";
import { getManagedDb } from "./sqlite-db";

const state = {
  db: null as Database.Database | null,
  failed: false,
  path: null as string | null,
  mtimeMs: null as number | null,
};

export function getHateCrimeDb(): Database.Database | null {
  return getManagedDb(state, {
    envVar: "HATE_CRIME_DB_PATH",
    label: "hate_crime.db",
    candidates: [
      path.join(process.cwd(), "data", "hate-crime", "hate_crime.db"),
      path.join(process.cwd(), "hate_crime.db"),
    ],
    pragmas: [
      ["cache_size", -32000],
      ["mmap_size", 134217728],
      ["temp_store", "MEMORY"],
    ],
  });
}
