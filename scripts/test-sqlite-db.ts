import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findExistingPaths } from "../lib/sqlite-db.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-db-test-"));
try {
  const target = path.join(dir, "crime_data.db");
  fs.writeFileSync(target, "test");

  const relativeTarget = path.relative(process.cwd(), target);
  assert.deepEqual(
    findExistingPaths(target, [relativeTarget]),
    [path.resolve(target)],
    "same file should be deduped when reached by absolute and relative paths"
  );

  const link = path.join(dir, "release-crime-data.db");
  try {
    fs.symlinkSync(target, link);
    assert.deepEqual(
      findExistingPaths(target, [link]),
      [path.resolve(target)],
      "shared DB and release symlink should be treated as one candidate"
    );
  } catch {
    // File symlink creation can be unavailable on Windows without Developer Mode.
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("sqlite-db tests passed");
