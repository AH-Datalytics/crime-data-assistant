import Database from "better-sqlite3";
import path from "path";
import { getManagedDb } from "./sqlite-db";

const state = {
  db: null as Database.Database | null,
  failed: false,
  path: null as string | null,
  mtimeMs: null as number | null,
};

export function getShrDb(): Database.Database | null {
  return getManagedDb(state, {
    envVar: "SHR_DB_PATH",
    label: "shr.db",
    candidates: [
      "/opt/nibrs/shr.db",
      path.join(process.cwd(), "..", "shr.db"),
      path.join(process.cwd(), "shr.db"),
    ],
    pragmas: [
      ["cache_size", -32000],
      ["mmap_size", 134217728],
      ["temp_store", "MEMORY"],
    ],
  });
}
