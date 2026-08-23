/**
 * Fixture databases built from the COMMITTED DDL, so the harness runs in a clean clone.
 *
 * WHY THIS EXISTS. `npm test` cannot run in a fresh clone: 0 databases are tracked (deliberately --
 * and that must stay 0), so every command that reaches SQLite is either working against whatever
 * stale file happens to sit on that developer's disk, or failing for a reason unrelated to the code.
 * Neither is a test result.
 *
 * WHAT IT IS NOT. It is not a new mechanism. `scripts/test-operation-taxonomy.ts` already builds real
 * SQLite databases from these same `.ddl.sql` files -- this generalises that `open(name, ddl,
 * transform)` pattern so every command can use it, rather than one test owning the only copy.
 *
 * WHY NO PRODUCTION CHANGE IS NEEDED. `resolveDbPath(envVar, candidates)` in lib/sqlite-db.ts already
 * prefers its env-var argument over every built-in candidate, so pointing the six variables at
 * fixtures is sufficient. Nothing in lib/ is modified by this increment; `lib/sqlite-db.ts`
 * specifically is out of scope by ruling 2 of the round-2 review.
 *
 * THE SEED PROFILE, AND WHY "NON-EMPTY" IS NOT A GLOBAL RULE. A schema-only database is a legitimate
 * fixture for a test whose subject IS missing data. It is a vacuous pass for a test that asserts a
 * value. Worse, "non-empty" is not sufficient either: test-current-indexed-state-deterministic.ts
 * guards its only equality with `if (base[column] !== null)`, so a 2017 row whose indexed columns are
 * all NULL passes while asserting nothing. Sufficiency is therefore declared PER TEST, in the tier
 * manifest, and can demand non-null values rather than merely rows.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..", "..");
const DDL_DIR = path.join(REPO, "scripts", "fixtures", "operation-taxonomy");

/**
 * The six databases, each keyed by the env var that redirects it.
 *
 * `file` is the fixture's filename; it deliberately does NOT mirror the production filename, so a
 * fixture can never be mistaken for a real database in a listing or a log line.
 */
const DATABASES = {
  rtci: { envVar: "RTCI_DB_PATH", ddl: "crime_data.ddl.sql", file: "fixture-rtci.db" },
  nibrs: { envVar: "NIBRS_DB_PATH", ddl: "nibrs.ddl.sql", file: "fixture-nibrs.db" },
  rollup: { envVar: "NIBRS_ROLLUP_DB_PATH", ddl: "rollup.ddl.sql", file: "fixture-rollup.db" },
  shr: { envVar: "SHR_DB_PATH", ddl: "shr.ddl.sql", file: "fixture-shr.db" },
  query_log: { envVar: "QUERY_LOG_DB_PATH", ddl: "query_log.ddl.sql", file: "fixture-query-log.db" },
  hate_crime: { envVar: "HATE_CRIME_DB_PATH", ddl: "hc.ddl.sql", file: "fixture-hate-crime.db" },
};

const DATABASE_NAMES = Object.keys(DATABASES);

function ddlPath(name) {
  const spec = DATABASES[name];
  if (!spec) throw new Error(`unknown fixture database: ${name}`);
  return path.join(DDL_DIR, spec.ddl);
}

/** Every table the committed DDL creates, in declaration order. */
function tablesInDdl(name) {
  const source = fs.readFileSync(ddlPath(name), "utf8");
  const tables = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([A-Za-z0-9_]+)/gi;
  let m;
  while ((m = re.exec(source)) !== null) tables.push(m[1]);
  return tables;
}

/**
 * Create one fixture database from its committed DDL.
 *
 * `seed` is `{tableName: [rowObject, ...]}`. Columns come from the row objects' own keys, so a seed
 * cannot silently drift from the DDL: a wrong column name is an immediate SQLite error rather than a
 * row that lands somewhere unexpected.
 */
function buildDatabase(name, dir, seed) {
  const Database = require("better-sqlite3");
  const spec = DATABASES[name];
  if (!spec) throw new Error(`unknown fixture database: ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, spec.file);
  fs.rmSync(file, { force: true });
  // WAL leaves -wal/-shm siblings behind; a stale pair from an earlier run would be read back.
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });

  const db = new Database(file);
  try {
    db.exec(fs.readFileSync(ddlPath(name), "utf8"));
    for (const [table, rows] of Object.entries(seed || {})) {
      if (!rows || rows.length === 0) continue;
      const columns = Object.keys(rows[0]);
      const statement = db.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
      );
      const insertAll = db.transaction((batch) => {
        for (const row of batch) {
          const shape = Object.keys(row).join(",");
          if (shape !== columns.join(",")) {
            throw new Error(`seed rows for ${table} have differing columns: ${shape}`);
          }
          statement.run(columns.map((c) => row[c]));
        }
      });
      insertAll(rows);
    }
  } finally {
    db.close();
  }
  return file;
}

/** Build every database a test declares. Returns `{name: absolutePath}`. */
function buildFixtures(dir, names, seeds) {
  const built = {};
  for (const name of names || DATABASE_NAMES) {
    built[name] = buildDatabase(name, dir, (seeds || {})[name]);
  }
  return built;
}

/**
 * The env-var overrides that point production resolution at these fixtures.
 *
 * EVERY variable is set, not only the ones a test declares. A test that reaches an undeclared
 * database would otherwise fall through to `resolveDbPath`'s built-in candidates and silently read a
 * real file from the developer's disk -- passing for the wrong reason, which is the failure mode this
 * whole increment exists to remove. Undeclared reach shows up as a fixture with no rows, which fails
 * loudly, instead of as a stale local database, which does not.
 */
function fixtureEnv(dir) {
  const env = {};
  for (const [name, spec] of Object.entries(DATABASES)) {
    env[spec.envVar] = path.join(dir, spec.file);
  }
  return env;
}

module.exports = { DATABASES, DATABASE_NAMES, buildDatabase, buildFixtures, fixtureEnv, tablesInDdl, ddlPath };
