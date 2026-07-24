import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectNibrsRollupAvailability } from "../lib/nibrs-rollup-router";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nibrs-rollup-freshness-"));
const source = path.join(directory, "nibrs.db");
const rollup = path.join(directory, "nibrs_rollups.db");
const sourceGeneration = path.join(directory, "nibrs_source.generation");
const previous = {
  source: process.env.NIBRS_DB_PATH,
  rollup: process.env.NIBRS_ROLLUP_DB_PATH,
  generation: process.env.NIBRS_SOURCE_GENERATION_PATH,
};

try {
  fs.writeFileSync(source, "source");
  fs.writeFileSync(rollup, "rollup");
  fs.writeFileSync(sourceGeneration, "generation-1\n");
  fs.writeFileSync(`${rollup}.generation`, "generation-1\n");
  const now = Date.now();
  fs.utimesSync(source, new Date(now - 60_000), new Date(now - 60_000));
  fs.utimesSync(rollup, new Date(now), new Date(now));
  process.env.NIBRS_DB_PATH = source;
  process.env.NIBRS_ROLLUP_DB_PATH = rollup;
  process.env.NIBRS_SOURCE_GENERATION_PATH = sourceGeneration;

  assert.equal(inspectNibrsRollupAvailability().reason, "rollup-current");

  fs.utimesSync(source, new Date(now + 60_000), new Date(now + 60_000));
  assert.equal(inspectNibrsRollupAvailability().reason, "source-newer-than-rollup");

  fs.utimesSync(source, new Date(now - 60_000), new Date(now - 60_000));
  fs.writeFileSync(sourceGeneration, "generation-2\n");
  assert.equal(inspectNibrsRollupAvailability().reason, "generation-mismatch");

  fs.writeFileSync(`${rollup}.generation`, "generation-2\n");
  assert.equal(inspectNibrsRollupAvailability().reason, "rollup-current");
  fs.rmSync(`${rollup}.generation`);
  assert.equal(inspectNibrsRollupAvailability().reason, "generation-missing");
} finally {
  for (const [key, value] of Object.entries(previous)) {
    const envName = key === "source" ? "NIBRS_DB_PATH" : key === "rollup" ? "NIBRS_ROLLUP_DB_PATH" : "NIBRS_SOURCE_GENERATION_PATH";
    if (value === undefined) delete process.env[envName];
    else process.env[envName] = value;
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log("nibrs rollup freshness tests passed");
