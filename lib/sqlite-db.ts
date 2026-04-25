import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

type PragmaValue = string | number;

type OpenOptions = {
  envVar?: string;
  candidates: string[];
  readonly?: boolean;
  pragmas?: [string, PragmaValue][];
  label: string;
};

type ManagedDb = {
  db: Database.Database | null;
  failed: boolean;
  path: string | null;
  mtimeMs: number | null;
};

function fileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

export function resolveDbPath(envVar: string | undefined, candidates: string[]): string | null {
  const ordered = [
    envVar,
    ...candidates,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of ordered) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
  }

  return ordered.length > 0 ? path.resolve(ordered[0]) : null;
}

export function getManagedDb(state: ManagedDb, opts: OpenOptions): Database.Database | null {
  const resolvedPath = resolveDbPath(process.env[opts.envVar || ""], opts.candidates);
  if (!resolvedPath) {
    state.failed = true;
    return null;
  }

  const currentMtime = fileMtimeMs(resolvedPath);
  if (currentMtime == null) {
    state.failed = true;
    return null;
  }

  const shouldReopen =
    !state.db ||
    state.failed ||
    state.path !== resolvedPath ||
    state.mtimeMs !== currentMtime;

  if (!shouldReopen) return state.db;

  if (state.db) {
    try {
      state.db.close();
    } catch {
      // Ignore close failures during swap-over.
    }
  }

  try {
    const db = new Database(resolvedPath, { readonly: opts.readonly ?? true });
    for (const [pragma, value] of opts.pragmas || []) {
      db.pragma(`${pragma} = ${value}`);
    }
    state.db = db;
    state.failed = false;
    state.path = resolvedPath;
    state.mtimeMs = currentMtime;
    console.log(`[db] Opened ${opts.label}: ${resolvedPath}`);
    return db;
  } catch {
    state.db = null;
    state.failed = true;
    state.path = resolvedPath;
    state.mtimeMs = currentMtime;
    return null;
  }
}
