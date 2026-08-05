/**
 * Phase 3 safety tests for chart capture.
 *
 * The capture writes to the hot path -- every answered query -- so the
 * properties that matter are not "does it work" but "can it hurt anything":
 * can it leak internal content, can it bloat a row, can it break logging, and
 * can it change what the user sees.
 */
import assert from "node:assert";
import {
  serializeChartConfigForLog,
  parseChartConfigLog,
  CHART_CONFIG_LOG_MAX_CHARS,
  CHART_CONFIG_MAX_SERIES,
} from "../lib/chart-config-log";
import type { ChartConfig } from "../lib/types";

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

const baseConfig: ChartConfig = {
  type: "line",
  xAxis: "year",
  yAxis: ["murder", "robbery"],
  title: "Murders and robberies in Houston, 2010-2025",
};

console.log("\n1. No internal content can leak (allowlist, not filter)");
{
  check("fields outside the allowlist are dropped", () => {
    // Everything here is the kind of thing that must never reach query_log.
    const contaminated = {
      ...baseConfig,
      systemPrompt: "You are a SQL generator. Tables: victims, offenses...",
      prompt: "internal reasoning text",
      schema: "CREATE TABLE victims (...)",
      sql: "SELECT * FROM victims",
      rawModelResponse: "{\"sql\": \"...\"}",
      apiKey: "sk-should-never-appear",
      internalNotes: "guardrail retry #2",
    } as unknown as ChartConfig;

    const encoded = serializeChartConfigForLog(contaminated, ["year", "murder", "robbery"]);
    assert.ok(encoded, "should serialize");
    for (const forbidden of ["systemPrompt", "CREATE TABLE", "SELECT *", "sk-should-never-appear", "internal reasoning", "guardrail retry", "rawModelResponse", "schema"]) {
      assert.ok(!encoded!.includes(forbidden), `leaked "${forbidden}" into: ${encoded}`);
    }
  });

  check("only the documented keys are present", () => {
    const encoded = serializeChartConfigForLog(baseConfig, ["year", "murder", "robbery"]);
    const parsed = JSON.parse(encoded!);
    const allowed = new Set([
      "type", "title", "xAxis", "yAxis", "seriesCount", "columns", "columnCount",
      "xAxisLabel", "yAxisLabel", "yAxisMin", "yAxisMax", "annotationCount", "truncated",
    ]);
    for (const key of Object.keys(parsed)) {
      assert.ok(allowed.has(key), `unexpected key "${key}" in payload`);
    }
  });

  check("annotation bodies are never stored, only a count", () => {
    const withAnnotations = {
      ...baseConfig,
      annotations: [
        { label: "SENSITIVE internal note", x: 2015 },
        { label: "another", x: 2020 },
      ],
    } as unknown as ChartConfig;
    const encoded = serializeChartConfigForLog(withAnnotations, ["year", "murder"]);
    assert.ok(!encoded!.includes("SENSITIVE"), `annotation body leaked: ${encoded}`);
    assert.strictEqual(parseChartConfigLog(encoded)!.annotationCount, 2);
  });
}

console.log("\n2. Bounded size");
{
  check("a pathological config stays under the cap", () => {
    const huge: ChartConfig = {
      ...baseConfig,
      title: "T".repeat(10000),
      yAxis: Array.from({ length: 500 }, (_, i) => `series_with_a_long_name_${i}`),
    };
    const encoded = serializeChartConfigForLog(huge, Array.from({ length: 500 }, (_, i) => `column_${i}`));
    assert.ok(encoded, "should still produce something");
    assert.ok(encoded!.length <= CHART_CONFIG_LOG_MAX_CHARS, `length ${encoded!.length} exceeds cap`);
  });

  check("series list is capped but the true count is preserved", () => {
    const many: ChartConfig = { ...baseConfig, yAxis: Array.from({ length: 100 }, (_, i) => `s${i}`) };
    const parsed = parseChartConfigLog(serializeChartConfigForLog(many, ["year"]))!;
    assert.strictEqual(parsed.seriesCount, 100, "true count must survive");
    assert.ok(parsed.yAxis.length <= CHART_CONFIG_MAX_SERIES, `stored ${parsed.yAxis.length} series`);
    assert.strictEqual(parsed.truncated, true, "truncation must be flagged");
  });

  check("truncation is flagged so detectors never read it as the real shape", () => {
    const parsed = parseChartConfigLog(serializeChartConfigForLog(baseConfig, ["year", "murder", "robbery"]))!;
    assert.strictEqual(parsed.truncated, undefined, "a normal config must not be flagged truncated");
  });
}

console.log("\n3. Fails open -- never breaks logging");
{
  check("null and undefined return null", () => {
    assert.strictEqual(serializeChartConfigForLog(null), null);
    assert.strictEqual(serializeChartConfigForLog(undefined), null);
  });

  check("a throwing getter returns null instead of propagating", () => {
    const hostile = {
      type: "line",
      xAxis: "year",
      get title(): string { throw new Error("boom"); },
      yAxis: ["x"],
    } as unknown as ChartConfig;
    assert.doesNotThrow(() => serializeChartConfigForLog(hostile));
    assert.strictEqual(serializeChartConfigForLog(hostile), null);
  });

  check("circular references return null rather than throwing", () => {
    const circular: Record<string, unknown> = { type: "line", xAxis: "year", yAxis: ["x"], title: "t" };
    circular.self = circular;
    assert.doesNotThrow(() => serializeChartConfigForLog(circular as unknown as ChartConfig));
  });

  check("garbage field types degrade instead of throwing", () => {
    const weird = { type: 42, xAxis: null, yAxis: "not-an-array", title: {} } as unknown as ChartConfig;
    const encoded = serializeChartConfigForLog(weird, null as unknown as string[]);
    assert.ok(encoded !== undefined);
    if (encoded) {
      const parsed = parseChartConfigLog(encoded)!;
      assert.strictEqual(parsed.yAxis.length, 0);
      assert.strictEqual(parsed.type, "none");
    }
  });

  check("parse of malformed stored JSON returns null", () => {
    assert.strictEqual(parseChartConfigLog("{not json"), null);
    assert.strictEqual(parseChartConfigLog(""), null);
    assert.strictEqual(parseChartConfigLog(null), null);
  });
}

console.log("\n4. Detector inputs are actually usable");
{
  check("axes and result columns are both recoverable", () => {
    const parsed = parseChartConfigLog(serializeChartConfigForLog(baseConfig, ["year", "murder", "robbery"]))!;
    assert.strictEqual(parsed.xAxis, "year");
    assert.deepStrictEqual(parsed.yAxis, ["murder", "robbery"]);
    assert.deepStrictEqual(parsed.columns, ["year", "murder", "robbery"]);
    assert.ok(parsed.title.includes("2010-2025"), "title must survive for year-mismatch detection");
  });

  check("a chart referencing a column the query never returned is detectable", () => {
    const parsed = parseChartConfigLog(
      serializeChartConfigForLog({ ...baseConfig, yAxis: ["murder", "phantom_column"] }, ["year", "murder"])
    )!;
    const missing = parsed.yAxis.filter((s) => !parsed.columns.includes(s));
    assert.deepStrictEqual(missing, ["phantom_column"]);
  });
}

console.log(`\n${process.exitCode ? "FAILURES present." : `All ${passed} chart-config serializer checks passed.`}`);
