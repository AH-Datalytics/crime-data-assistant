/**
 * Wiring guards for Phase 3 chart capture, and for the chart-title leak the
 * capture work uncovered.
 *
 * THE LEAK: the response firewall (sseEvent / jsonResp) sanitized `explanation`
 * and `title` but never `chartConfig.title`, and ChartPanel renders
 * config.title. So a title carrying internal content was blanked to "Results"
 * in the header while the chart beside it still displayed the leaked text, on
 * every chart-bearing response across all four routes.
 *
 * Most of these are SOURCE-LEVEL assertions rather than behavioural ones. That
 * is deliberate: the defect class is "a chart-bearing path exists that nobody
 * wired up", which no unit test of a single function can catch. Reading the
 * routes is the only way to assert the invariant holds everywhere.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { sanitizeChartConfigTitle, containsInternalLeak } from "../lib/scaffold-helpers";
import { serializeChartConfigForLog, parseChartConfigLog } from "../lib/chart-config-log";
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

const ROUTES = {
  current: "app/api/query/route.ts",
  nibrs: "app/api/nibrs-query/route.ts",
  shr: "app/api/shr-query/route.ts",
  hate_crime: "app/api/hc-query/route.ts",
};
const src = Object.fromEntries(
  Object.entries(ROUTES).map(([k, p]) => [k, fs.readFileSync(path.join(__dirname, "..", p), "utf8")])
);

// A title that trips containsInternalLeak via the summary_* table pattern.
const LEAKING_TITLE = "Rows from summary_victim_state_monthly for Houston";

console.log("\n1. Chart titles are sanitized (the leak)");
{
  check("the sample title really does trip the leak detector", () => {
    assert.ok(containsInternalLeak(LEAKING_TITLE), "test fixture no longer trips containsInternalLeak");
  });

  check("a leaking chart title is replaced", () => {
    const out = sanitizeChartConfigTitle({ type: "line", title: LEAKING_TITLE });
    assert.strictEqual(out!.title, "Results");
  });

  check("a clean chart title is untouched, same object returned", () => {
    const clean = { type: "line", title: "Murders in Houston, 2010-2025" };
    const out = sanitizeChartConfigTitle(clean);
    assert.strictEqual(out, clean, "clean configs should not be reallocated");
  });

  check("null and undefined pass through", () => {
    assert.strictEqual(sanitizeChartConfigTitle(null), null);
    assert.strictEqual(sanitizeChartConfigTitle(undefined), undefined);
  });

  check("every route's response firewall sanitizes chartConfig", () => {
    for (const [name, text] of Object.entries(src)) {
      assert.ok(
        /payload\.chartConfig = sanitizeChartConfigTitle\(payload\.chartConfig\)/.test(text),
        `${name} does not sanitize chartConfig at egress`
      );
    }
  });

  check("the sanitize call sits inside the firewall, before the response is built", () => {
    for (const [name, text] of Object.entries(src)) {
      const sanitizeAt = text.indexOf("payload.chartConfig = sanitizeChartConfigTitle");
      const returnAt = text.search(/return (?:NextResponse\.json\((?:payload|finalized)|`data: \$\{JSON\.stringify\((?:payload|finalized))/);
      assert.ok(sanitizeAt > 0 && returnAt > 0, `${name}: could not locate firewall`);
      assert.ok(sanitizeAt < returnAt, `${name}: sanitization happens after the payload is returned`);
    }
  });
}

console.log("\n2. Final title corrections reach BOTH the response and the logged config");
{
  // SHR and hate crime build the chart before the narrative firewall and the
  // final alignTitleYearRange run, so the config held a stale title snapshot.
  for (const name of ["shr", "hate_crime"] as const) {
    check(`${name}: chart config is reassignable (let, not const)`, () => {
      assert.ok(
        /let chartConfig = applyChartCustomizations\(\{/.test(src[name]),
        `${name}: chartConfig is still const, so its title cannot be corrected`
      );
    });

    check(`${name}: title is synced after final processing, before log and return`, () => {
      const text = src[name];
      const syncAt = text.indexOf("chartConfig = { ...chartConfig, title: claude.title }");
      const finalTitleAt = text.indexOf('claude.title = finalNarrative.title || claude.title || "Results"');
      const logAt = text.indexOf("serializeChartConfigForLog(chartConfig, columns)");
      assert.ok(syncAt > 0, `${name}: no title sync found`);
      assert.ok(finalTitleAt > 0 && finalTitleAt < syncAt, `${name}: sync must come AFTER the final title is set`);
      assert.ok(logAt > syncAt, `${name}: the log captures the config before the sync`);
    });
  }

  check("syncing a corrected title changes what would be logged", () => {
    const built: ChartConfig = { type: "line", xAxis: "year", yAxis: ["murder"], title: "Murders in Houston, 2010-2024" };
    const finalTitle = "Murders in Houston, 2010-2025";
    const synced = { ...built, title: finalTitle };
    const before = parseChartConfigLog(serializeChartConfigForLog(built, ["year", "murder"]))!;
    const after = parseChartConfigLog(serializeChartConfigForLog(synced, ["year", "murder"]))!;
    assert.notStrictEqual(before.title, after.title);
    assert.strictEqual(after.title, finalTitle, "the logged title must be the finalized one");
  });
}

console.log("\n3. Every chart-bearing log path captures the config");
{
  // Named explicitly so removing any one of them fails loudly. Each entry is a
  // path that returns a chartConfig to the user.
  const expected: Array<{ route: keyof typeof ROUTES; label: string; needle: RegExp }> = [
    { route: "current", label: "model path", needle: /serializeChartConfigForLog\(chartConfig, columns\)/ },
    { route: "current", label: "indexed-state deterministic", needle: /serializeChartConfigForLog\(rows\.length > 0 \? indexedStatePlan\.chartConfig : null, columns\)/ },
    { route: "current", label: "multi-city trend deterministic", needle: /serializeChartConfigForLog\(rows\.length > 0 \? multiCityTrend\.chartConfig : null, columns\)/ },
    { route: "current", label: "historical city change deterministic", needle: /serializeChartConfigForLog\(rows\.length > 0 \? historicalCityChange\.chartConfig : null, columns\)/ },
    { route: "current", label: "metadata coverage", needle: /serializeChartConfigForLog\(metadata\.chartConfig/ },
    { route: "nibrs", label: "model path", needle: /serializeChartConfigForLog\(chartConfig, columns\)/ },
    { route: "nibrs", label: "deterministic path", needle: /serializeChartConfigForLog\(chartConfig, columns\)\s*\n?\s*\)/ },
    { route: "shr", label: "model path", needle: /serializeChartConfigForLog\(chartConfig, columns\)/ },
    { route: "hate_crime", label: "model path", needle: /serializeChartConfigForLog\(chartConfig, columns\)/ },
  ];

  for (const item of expected) {
    check(`${item.route}: ${item.label} captures the chart config`, () => {
      assert.ok(item.needle.test(src[item.route]), `no capture matching ${item.needle} in ${ROUTES[item.route]}`);
    });
  }

  check("nibrs deterministic path captures separately from the model path", () => {
    // Two distinct capture sites; the deterministic one was originally missing.
    const count = (src.nibrs.match(/serializeChartConfigForLog\(/g) || []).length;
    assert.ok(count >= 2, `expected at least 2 capture sites in the nibrs route, found ${count}`);
  });

  check("no route imports the serializer without using it", () => {
    for (const [name, text] of Object.entries(src)) {
      if (!text.includes('from "@/lib/chart-config-log"')) continue;
      assert.ok(
        (text.match(/serializeChartConfigForLog\(/g) || []).length > 0,
        `${name} imports the serializer but never calls it`
      );
    }
  });
}

console.log("\n4. Chart artifacts and browser receipts are wired end to end");
{
  for (const [name, text] of Object.entries(src)) {
    check(`${name}: chart responses attach a bounded audit artifact`, () => {
      assert.ok(text.includes("attachChartAuditToPayload"), `${name} does not attach chart audit artifacts`);
      assert.ok(text.includes("chartAuditRequestId"), `${name} does not create a stable chart request id`);
    });
  }
  for (const name of ["nibrs", "shr", "hate_crime"] as const) {
    check(name + ": final artifact capture follows response sanitization", () => {
      const text = src[name];
      const firewallStart = text.indexOf("function jsonResp");
      const sanitizeAt = text.indexOf("sanitizeChartConfigTitle(payload.chartConfig)", firewallStart);
      const captureAt = text.indexOf("attachChartAuditToPayload(payload", firewallStart);
      const responseAt = text.indexOf("NextResponse.json(finalized", firewallStart);
      assert.ok(firewallStart >= 0 && sanitizeAt > firewallStart, name + ": response firewall not found");
      assert.ok(captureAt > sanitizeAt, name + ": audit capture precedes final chart sanitization");
      assert.ok(responseAt > captureAt, name + ": response is built before final artifact capture");
    });
  }
  check("current: final artifact capture follows response normalization and sanitization", () => {
    const text = src.current;
    const firewallStart = text.indexOf("function sseEvent");
    const normalizeAt = text.indexOf("normalizeConsolidatedDisplayRows", firewallStart);
    const sanitizeAt = text.indexOf("sanitizeChartConfigTitle(payload.chartConfig)", firewallStart);
    const captureAt = text.indexOf("attachChartAuditToPayload(payload", firewallStart);
    const responseAt = text.indexOf("JSON.stringify(finalized)", firewallStart);
    assert.ok(normalizeAt > firewallStart && sanitizeAt > normalizeAt, "current: final transformations not found");
    assert.ok(captureAt > sanitizeAt, "current: audit capture precedes final chart sanitization");
    assert.ok(responseAt > captureAt, "current: SSE is serialized before final artifact capture");
  });
  check("current: the server-only audit source never reaches the browser", () => {
    const text = src.current;
    const firewallStart = text.indexOf("function sseEvent");
    const deleteAt = text.indexOf("delete payload.chartAuditSource", firewallStart);
    const responseAt = text.indexOf("JSON.stringify(finalized)", firewallStart);
    assert.ok(deleteAt > firewallStart && responseAt > deleteAt);
  });
  for (const component of ["components/ChartPanel.tsx", "components/NibrsChartPanel.tsx"]) {
    check(`${component}: sends a structural browser receipt`, () => {
      const text = fs.readFileSync(component, "utf8");
      assert.ok(text.includes("useChartRenderReceipt"));
      assert.ok(text.includes("requestId?: string"));
    });
  }
  check("receipt endpoint persists only validated receipts", () => {
    const text = fs.readFileSync("app/api/chart-render-receipt/route.ts", "utf8");
    assert.ok(text.includes("receiptSchema.safeParse"));
    assert.ok(text.includes("persistChartRenderReceipt"));
  });
}

console.log(`\n${process.exitCode ? "FAILURES present." : `All ${passed} chart-capture wiring checks passed.`}`);
