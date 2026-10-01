/**
 * The catalog's uniqueness claims must match the schema.
 *
 * `uniqueKeys` is what authorizes "this relation emits the key at most once", and that authorizes a
 * murder count. It is an engineering fact about the database, so it cannot be allowed to drift from
 * the database: if an importer or migration ever drops the constraint, this test fails rather than
 * the validator silently continuing to trust a key that no longer identifies a row.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { TABLE_SEMANTICS } from "../lib/table-semantics";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${(error as Error).message}`); }
}

const DDL = path.join(__dirname, "fixtures", "operation-taxonomy", "shr.ddl.sql");

/** Columns SQLite reports as the primary key of a table, in key order. */
function primaryKeyOf(db: Database.Database, table: string): string[] {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[];
  return info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name.toLowerCase());
}

check("every catalogued unique key is a real primary key in the SHR schema", () => {
  const db = new Database(":memory:");
  db.exec(readFileSync(DDL, "utf8"));

  const claimed = TABLE_SEMANTICS.filter((e) => e.source === "shr" && e.uniqueKeys?.length);
  assert.ok(claimed.length > 0, "no SHR uniqueness claims found -- the catalog lost its keys");

  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((r) => r.name.toLowerCase()));

  for (const entry of claimed) {
    assert.ok(tables.has(entry.table.toLowerCase()),
      `${entry.table} claims a unique key but is not in the schema fixture`);
    const pk = primaryKeyOf(db, entry.table);
    for (const key of entry.uniqueKeys!) {
      assert.ok(pk.includes(key.toLowerCase()),
        `${entry.table}.${key} is claimed unique, but the schema's primary key is [${pk.join(", ")}]`);
    }
    // A composite primary key does not make either column individually unique.
    assert.strictEqual(pk.length, 1,
      `${entry.table} has a composite primary key [${pk.join(", ")}]; single-column uniqueness is not implied`);
  }
  db.close();
});

check("the tables this licence depends on still declare their key", () => {
  // Named explicitly: the SHR murder licence is built on exactly these two, and a silent removal
  // from the catalog would make the previous check vacuous rather than failing.
  const required = [["incidents", "id"], ["victims", "id"]] as const;
  for (const [table, column] of required) {
    const entry = TABLE_SEMANTICS.find((e) => e.source === "shr" && e.table === table);
    assert.ok(entry, `shr.${table} is missing from the catalog`);
    assert.ok(entry!.uniqueKeys?.some((k) => k.toLowerCase() === column),
      `shr.${table} no longer claims ${column} as a unique key`);
  }
});

console.log(`\nschema/catalog agreement: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
