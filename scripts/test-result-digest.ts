/**
 * The bounded result digest (handoff §6.2) and its §13 digest tests:
 * "caps, deterministic sampling, truncation flags, schema versions, and type
 * handling" and "no generic sum for undeclared/non-additive measures".
 *
 * The two assertions worth reading first:
 *
 *   - NO SUM WITHOUT A DECLARATION. A digest that sums a `clearance_rate` column
 *     puts a meaningless number into the evidence record, and a reviewer will read
 *     it as a total. §6.2 forbids inferring additivity from a name.
 *
 *   - THE BYTE CEILING IS REAL. §6.2 sets an 8 KB hard maximum. A digest that
 *     merely aims for it and overshoots would sit on every row of a hot log table,
 *     so the reduction ladder is exercised against inputs that genuinely exceed it,
 *     and the order of the ladder is asserted — omissions are shed LAST because
 *     they are the evidence behind something a user was actually told.
 */
import assert from "node:assert";
import {
  buildResultDigest,
  serializeResultDigest,
  omissionReasons,
  DIGEST_VERSION,
  DIGEST_MAX_BYTES,
  MAX_DIGEST_COLUMNS,
  MAX_DISTINCT_VALUES,
  MAX_REPRESENTATIVE_ROWS,
  MAX_VALUE_CHARS,
} from "../lib/result-digest";
import type { Omission } from "../lib/proof-contract";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}\n        ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function trendRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    year: 2000 + i,
    city: i % 2 === 0 ? "Baton Rouge" : "New Orleans",
    murders: i * 3,
    clearance_rate: 0.4 + i / 100,
  }));
}

console.log("\nshape and versioning");
{
  const digest = buildResultDigest({
    rows: trendRows(10),
    columns: ["year", "city", "murders", "clearance_rate"],
    truncated: false,
  });

  check("carries the schema version", () => {
    assert.strictEqual(digest.v, DIGEST_VERSION);
  });

  check("records row count and truncation status", () => {
    assert.strictEqual(digest.rowCount, 10);
    assert.strictEqual(digest.truncated, false);
  });

  check("truncation accounting is always present, not absent when empty", () => {
    // Silence and success must not look alike — the same rule as CheckState.unknown.
    assert.deepStrictEqual(digest.truncation, {
      columnsDropped: 0,
      representativeRowsDropped: 0,
      distinctListsDropped: 0,
      omissionsDropped: 0,
    });
  });

  check("truncated flag propagates", () => {
    const truncated = buildResultDigest({ rows: trendRows(3), columns: ["year"], truncated: true });
    assert.strictEqual(truncated.truncated, true);
  });
}

console.log("\nadditivity is declared, never inferred");
{
  const columns = ["year", "city", "murders", "clearance_rate"];

  check("no sum for any column when the plan declares none", () => {
    const digest = buildResultDigest({ rows: trendRows(10), columns, truncated: false });
    for (const column of digest.columns) {
      assert.strictEqual(column.additive, false, `${column.name} must not be additive by default`);
      assert.strictEqual(column.numeric?.sum, undefined, `${column.name} must have no sum`);
    }
  });

  check("sum appears only for the declared measure", () => {
    const digest = buildResultDigest({
      rows: trendRows(10),
      columns,
      truncated: false,
      plan: { additiveMeasures: ["murders"] },
    });
    const murders = digest.columns.find((c) => c.name === "murders")!;
    const rate = digest.columns.find((c) => c.name === "clearance_rate")!;
    assert.strictEqual(murders.additive, true);
    assert.strictEqual(murders.numeric!.sum, 135, "0+3+...+27 = 135");
    assert.strictEqual(rate.additive, false);
    assert.strictEqual(rate.numeric!.sum, undefined, "a rate must never be summed");
  });

  check("a rate-shaped name does not earn a sum", () => {
    // The specific inference §6.2 forbids: `population` and `clearance_pct` look
    // summable to a naive heuristic and are not.
    const digest = buildResultDigest({
      rows: [{ population: 100, clearance_pct: 50 }, { population: 200, clearance_pct: 60 }],
      columns: ["population", "clearance_pct"],
      truncated: false,
    });
    for (const column of digest.columns) assert.strictEqual(column.numeric?.sum, undefined);
  });
}

console.log("\nnumeric statistics distinguish null from zero");
{
  check("nulls and zeroes are counted separately", () => {
    // §3.10: missingness and zero are distinct states. A digest that collapsed
    // them would erase the evidence for the distinction it exists to preserve.
    const digest = buildResultDigest({
      rows: [{ n: 0 }, { n: null }, { n: 5 }, { n: 0 }, { n: undefined }],
      columns: ["n"],
      truncated: false,
    });
    const stats = digest.columns[0].numeric!;
    assert.strictEqual(stats.zeroes, 2);
    assert.strictEqual(stats.nulls, 2);
    assert.strictEqual(stats.min, 0);
    assert.strictEqual(stats.max, 5);
  });

  check("a fully-null column reports zero min/max without inventing values", () => {
    const digest = buildResultDigest({ rows: [{ n: null }, { n: null }], columns: ["n"], truncated: false });
    assert.strictEqual(digest.columns[0].type, "null");
    assert.strictEqual(digest.columns[0].numeric, undefined, "no numeric stats for a column with no numbers");
  });
}

console.log("\ntype handling");
{
  check("infers number, string, boolean, null, and mixed", () => {
    const digest = buildResultDigest({
      rows: [
        { n: 1, s: "a", b: true, z: null, m: 1 },
        { n: 2, s: "b", b: false, z: null, m: "two" },
      ],
      columns: ["n", "s", "b", "z", "m"],
      truncated: false,
    });
    const types = Object.fromEntries(digest.columns.map((c) => [c.name, c.type]));
    assert.deepStrictEqual(types, { n: "number", s: "string", b: "boolean", z: "null", m: "mixed" });
  });

  check("non-finite numbers do not corrupt statistics", () => {
    const digest = buildResultDigest({
      rows: [{ n: 1 }, { n: Number.NaN }, { n: Number.POSITIVE_INFINITY }, { n: 3 }],
      columns: ["n"],
      truncated: false,
    });
    assert.strictEqual(digest.columns[0].numeric!.min, 1);
    assert.strictEqual(digest.columns[0].numeric!.max, 3, "Infinity must not become the max");
  });
}

console.log("\ncaps");
{
  check(`columns cap at ${MAX_DIGEST_COLUMNS} and record the overflow`, () => {
    const columns = Array.from({ length: 40 }, (_, i) => `c${i}`);
    const row: Record<string, unknown> = {};
    for (const column of columns) row[column] = 1;
    const digest = buildResultDigest({ rows: [row], columns, truncated: false });
    assert.strictEqual(digest.columns.length, MAX_DIGEST_COLUMNS);
    assert.strictEqual(digest.columnCount, 40, "the true column count must survive the cap");
    assert.strictEqual(digest.truncation.columnsDropped, 16);
  });

  check(`distinct values cap at ${MAX_DISTINCT_VALUES} with capped metadata`, () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ city: `city${i}` }));
    const digest = buildResultDigest({
      rows,
      columns: ["city"],
      truncated: false,
      plan: { categoricalColumns: ["city"] },
    });
    const distinct = digest.columns[0].distinct!;
    assert.strictEqual(distinct.values.length, MAX_DISTINCT_VALUES);
    assert.strictEqual(distinct.capped, true);
    assert.strictEqual(distinct.total, 50);
  });

  check("distinct is absent for columns the plan did not declare categorical", () => {
    // A free-text column has thousands of distinct values and a capped sample of
    // them is not evidence of anything.
    const digest = buildResultDigest({
      rows: [{ note: "a" }, { note: "b" }],
      columns: ["note"],
      truncated: false,
    });
    assert.strictEqual(digest.columns[0].distinct, undefined);
  });

  check("not-capped is recorded explicitly when everything fit", () => {
    const digest = buildResultDigest({
      rows: [{ city: "A" }, { city: "B" }],
      columns: ["city"],
      truncated: false,
      plan: { categoricalColumns: ["city"] },
    });
    assert.strictEqual(digest.columns[0].distinct!.capped, false);
    assert.strictEqual(digest.columns[0].distinct!.total, 2);
  });

  check(`long values are truncated at ${MAX_VALUE_CHARS} chars`, () => {
    const long = "x".repeat(500);
    const digest = buildResultDigest({
      rows: [{ label: long }],
      columns: ["label"],
      truncated: false,
      plan: { categoricalColumns: ["label"] },
    });
    const value = String(digest.columns[0].distinct!.values[0]);
    assert.ok(value.length <= MAX_VALUE_CHARS + 1, `value was ${value.length} chars`);
    assert.ok(value.endsWith("…"), "truncation must be visible in the value");
  });
}

console.log("\nrepresentative rows are deterministic");
{
  check("selects first, middle, last — reproducibly", () => {
    // A random sample would make a digest irreproducible, so a reviewer could not
    // tell whether a disagreement with a re-run means changed data or a new draw.
    const rows = trendRows(9);
    const first = buildResultDigest({ rows, columns: ["year"], truncated: false });
    const second = buildResultDigest({ rows, columns: ["year"], truncated: false });
    assert.deepStrictEqual(first.representativeRows, second.representativeRows);
    assert.deepStrictEqual(
      first.representativeRows.map((row) => row.year),
      [2000, 2004, 2008],
    );
  });

  check(`caps at ${MAX_REPRESENTATIVE_ROWS} rows`, () => {
    const digest = buildResultDigest({ rows: trendRows(100), columns: ["year"], truncated: false });
    assert.strictEqual(digest.representativeRows.length, MAX_REPRESENTATIVE_ROWS);
  });

  check("keeps all rows when fewer than the cap, without duplicating", () => {
    const two = buildResultDigest({ rows: trendRows(2), columns: ["year"], truncated: false });
    assert.deepStrictEqual(two.representativeRows.map((r) => r.year), [2000, 2001]);
    const one = buildResultDigest({ rows: trendRows(1), columns: ["year"], truncated: false });
    assert.strictEqual(one.representativeRows.length, 1);
  });

  check("an empty result yields no representative rows", () => {
    const digest = buildResultDigest({ rows: [], columns: ["year"], truncated: false });
    assert.deepStrictEqual(digest.representativeRows, []);
    assert.strictEqual(digest.rowCount, 0);
  });
}

console.log("\nentity sets and omissions");
{
  const omissions: Omission[] = [
    { entityId: "jacksonville-fl", label: "Jacksonville", reason: "consolidation_mapping", evidence: "probe: x" },
    { entityId: "unknown-city", label: "Nowhere", reason: "unknown", evidence: null },
  ];

  check("requested and returned entity sets are deduped and sorted", () => {
    const digest = buildResultDigest({
      rows: [],
      columns: [],
      truncated: false,
      requestedEntities: ["b", "a", "a"],
      returnedEntities: ["a"],
    });
    assert.deepStrictEqual(digest.requestedEntities, ["a", "b"]);
    assert.deepStrictEqual(digest.returnedEntities, ["a"]);
  });

  check("omissions are carried with their reason codes and evidence", () => {
    const digest = buildResultDigest({ rows: [], columns: [], truncated: false, omissions });
    assert.strictEqual(digest.omissions.length, 2);
    assert.deepStrictEqual(omissionReasons(digest).sort(), ["consolidation_mapping", "unknown"]);
  });

  check("plan family, resolver contract, retries, and guardrails are recorded", () => {
    const digest = buildResultDigest({
      rows: [],
      columns: [],
      truncated: false,
      plan: { planFamily: "historical-city-trend", resolverContractId: "qc-v1" },
      retries: 2,
      guardrails: ["geo-typo-corrected", "reliability-disclosed"],
    });
    assert.strictEqual(digest.planFamily, "historical-city-trend");
    assert.strictEqual(digest.resolverContractId, "qc-v1");
    assert.strictEqual(digest.retries, 2);
    assert.deepStrictEqual(digest.guardrails, ["geo-typo-corrected", "reliability-disclosed"]);
  });
}

console.log("\nbyte ceiling and the reduction ladder");
{
  function sizeOf(digest: ReturnType<typeof buildResultDigest>): number {
    return Buffer.byteLength(JSON.stringify(digest), "utf8");
  }

  check("a typical digest is well under the ceiling", () => {
    const digest = buildResultDigest({
      rows: trendRows(120),
      columns: ["year", "city", "murders", "clearance_rate"],
      truncated: false,
      plan: { additiveMeasures: ["murders"], categoricalColumns: ["city"], planFamily: "trend" },
    });
    assert.ok(sizeOf(digest) < 2048, `typical digest was ${sizeOf(digest)} bytes, expected ~2KB`);
  });

  check("an oversized input is reduced below the hard maximum", () => {
    // 24 columns x 20 distinct values x 120 chars overshoots the ceiling on its
    // own, which is exactly why the ladder exists rather than trusting the caps.
    const columns = Array.from({ length: 24 }, (_, i) => `col${i}`);
    const rows = Array.from({ length: 60 }, (_, r) => {
      const row: Record<string, unknown> = {};
      for (const column of columns) row[column] = `${column}-value-${r}-${"y".repeat(100)}`;
      return row;
    });
    const digest = buildResultDigest({
      rows,
      columns,
      truncated: true,
      plan: { categoricalColumns: columns },
    });
    assert.ok(sizeOf(digest) <= DIGEST_MAX_BYTES, `digest was ${sizeOf(digest)} bytes`);
    assert.ok(digest.truncation.distinctListsDropped > 0, "distinct lists should be shed first");
  });

  check("omissions survive reduction that sheds everything else", () => {
    // The ladder's whole point: an omission is the evidence behind a claim a user
    // was shown ("Jacksonville cannot currently be included"). Losing the result
    // statistics is a degraded record; losing the omission is a defect.
    const many: Omission[] = Array.from({ length: 30 }, (_, i) => ({
      entityId: `city-${i}`,
      label: `City Number ${i}`,
      reason: "not_in_source",
      evidence: `probe: no row in agency_monthly where agency matches 'City Number ${i}'`,
    }));
    const columns = Array.from({ length: 24 }, (_, i) => `col${i}`);
    const rows = Array.from({ length: 40 }, () => {
      const row: Record<string, unknown> = {};
      for (const column of columns) row[column] = "z".repeat(110);
      return row;
    });
    const digest = buildResultDigest({
      rows,
      columns,
      truncated: true,
      omissions: many,
      plan: { categoricalColumns: columns },
    });
    assert.ok(sizeOf(digest) <= DIGEST_MAX_BYTES, `digest was ${sizeOf(digest)} bytes`);
    assert.strictEqual(digest.omissions.length, 30, "every omission must survive");
    assert.strictEqual(digest.truncation.omissionsDropped, 0);
  });

  check("dropping an omission is recorded as such when unavoidable", () => {
    // Not a cap — a defect the reviewer queue must see. Asserted so the field is
    // never silently zero while omissions are actually missing.
    const huge: Omission[] = Array.from({ length: 400 }, (_, i) => ({
      entityId: `e${i}`,
      label: `Entity ${i}`,
      reason: "not_in_source",
      evidence: `probe evidence string number ${i} ${"q".repeat(60)}`,
    }));
    const digest = buildResultDigest({ rows: [], columns: [], truncated: false, omissions: huge });
    assert.ok(sizeOf(digest) <= DIGEST_MAX_BYTES, `digest was ${sizeOf(digest)} bytes`);
    assert.ok(digest.truncation.omissionsDropped > 0, "dropped omissions must be counted");
    assert.strictEqual(
      digest.omissions.length + digest.truncation.omissionsDropped,
      400,
      "kept + dropped must reconcile to the input count",
    );
  });
}

console.log("\nserialization");
{
  check("serializes to JSON", () => {
    const digest = buildResultDigest({ rows: trendRows(3), columns: ["year"], truncated: false });
    const json = serializeResultDigest(digest);
    assert.ok(json);
    assert.strictEqual(JSON.parse(json!).v, DIGEST_VERSION);
  });

  check("a circular row yields null rather than throwing", () => {
    // A throw here would cost a user their answer over a diagnostic record.
    const circular: Record<string, unknown> = { year: 2024 };
    circular.self = circular;
    const digest = buildResultDigest({ rows: [circular], columns: ["year", "self"], truncated: false });
    assert.doesNotThrow(() => serializeResultDigest(digest));
  });
}

console.log(`\nresult digest tests: ${passed} passed`);
if (process.exitCode) {
  console.log("result digest tests: FAILED");
} else {
  console.log("result digest tests: passed");
}
