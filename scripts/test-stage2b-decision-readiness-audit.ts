import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(__dirname, "..");
const doc = fs.readFileSync(
  path.join(root, "docs", "superpowers", "2026-08-16-stage2b-decision-readiness-audit.md"),
  "utf8",
);
const registry = JSON.parse(fs.readFileSync(
  path.join(root, "scripts", "fixtures", "operation-taxonomy", "capability-registry.json"),
  "utf8",
)) as Record<string, { authorizationEligible: boolean }>;
const require = createRequire(import.meta.url);
const { stage2bCapabilityCatalog } = require(path.join(root, "lib", "stage2b-capability-catalog.js"));
const catalog = stage2bCapabilityCatalog();

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

const exactSource = (source: string): string => {
  if (source.startsWith("Current Trends")) return "Current Trends";
  if (source.startsWith("Historical Library")) return "Historical Library";
  if (source.startsWith("NIBRS")) return "NIBRS";
  if (source.startsWith("Homicide Reports")) return "Homicide Reports";
  if (source === "Hate crime records") return "Hate Crime";
  throw new Error(`unrecognized product source: ${source}`);
};

const entries = catalog.ids().map((id: string) => ({ id, ...catalog.entry(id) }));
const expected = {
  "Current Trends": { capabilities: 7, year: 3, noYear: 4, tags: 18 },
  "Historical Library": { capabilities: 9, year: 5, noYear: 4, tags: 24 },
  "Hate Crime": { capabilities: 4, year: 1, noYear: 3, tags: 9 },
  NIBRS: { capabilities: 27, year: 23, noYear: 4, tags: 77 },
  "Homicide Reports": { capabilities: 5, year: 2, noYear: 3, tags: 12 },
};

check("all 52 capabilities are covered exactly once", () => {
  assert.equal(entries.length, 52);
  assert.equal(new Set(entries.map((entry: { id: string }) => entry.id)).size, 52);
  assert.equal(Object.keys(registry).length + 1, 52);
  const missing = entries
    .map((entry: { id: string }) => entry.id)
    .filter((id: string) => !(id in registry) && id !== "crime_data::national_monthly::sweep");
  assert.deepEqual(missing, []);
});

check("source totals in the evidence table match the live catalog", () => {
  const actual: Record<string, { capabilities: number; year: number; noYear: number; tags: number }> = {};
  for (const entry of entries) {
    const source = exactSource(entry.source);
    actual[source] ??= { capabilities: 0, year: 0, noYear: 0, tags: 0 };
    actual[source].capabilities += 1;
    actual[source][entry.year.recommend === "yes" ? "year" : "noYear"] += 1;
    actual[source].tags += entry.integrity.length;
  }
  assert.deepEqual(actual, expected);
  for (const [source, count] of Object.entries(expected)) {
    assert.match(doc, new RegExp(`\\| ${source} \\| ${count.capabilities} \\| ${count.year} \\| ${count.noYear} \\| ${count.tags} \\| 0 \\|`));
  }
});

check("the audit does not turn structural facts into human choices", () => {
  assert.match(doc, /no decision-ready human policy questions/i);
  assert.match(doc, /Structural engineering fact/);
  assert.match(doc, /Undefined engineering check/);
  assert.match(doc, /Source and build fact/);
  assert.match(doc, /Runbook fact/);
});

check("the existing verified-answer-only behavior is preserved", () => {
  assert.match(doc, /unknown or failed condition blocks factual delivery/i);
  assert.match(doc, /must not be independently changed to “warn” or “no special handling”/i);
  assert.ok(Object.values(registry).every((entry) => entry.authorizationEligible === false));
});

check("the 97 figure is explicitly retired", () => {
  assert.match(doc, /There were never 97 human policy questions/);
  assert.match(doc, /23 year-carrying tables, one shared no-year rule, 33 artifact\/table owner pairs, and 40 emitted-table integrity sets/);
});

check("only exact product names appear in the audit", () => {
  assert.doesNotMatch(doc, /recent-trends/i);
  for (const name of Object.keys(expected)) assert.match(doc, new RegExp(name));
});

console.log(`\n${passed}/6 checks passed`);
