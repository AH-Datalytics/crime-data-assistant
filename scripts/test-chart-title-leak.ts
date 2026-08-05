/**
 * Regression tests for the chart-title leak.
 *
 * THE DEFECT: the response firewall (sseEvent in the current/historical route,
 * jsonResp in nibrs/shr/hate-crime) sanitized `explanation` and `title` but never
 * `chartConfig.title` -- and ChartPanel renders config.title. So when
 * sanitizeUserFacingNarrative blanked a leaking title to "Results", the chart
 * beside it still displayed the internal text. Every chart-bearing response on
 * all four routes was affected.
 *
 * A second path produced the same symptom without any firewall involvement: SHR
 * and hate crime built the chart config BEFORE the final title processing, so its
 * title was a stale snapshot that could disagree with the response title.
 *
 * Several assertions read the route source rather than calling a function. That
 * is deliberate: the defect class is "a response path exists that the firewall
 * does not cover", which no unit test of a single helper can catch.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { sanitizeChartConfigTitle, containsInternalLeak, sanitizeUserFacingNarrative } from "../lib/scaffold-helpers";

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

/** Trips containsInternalLeak via the summary_* table pattern. */
const LEAKING_TITLE = "Rows from summary_victim_state_monthly for Houston";

console.log("\n1. The helper sanitizes a leaking chart title");
{
  check("the fixture actually trips the leak detector", () => {
    assert.ok(containsInternalLeak(LEAKING_TITLE), "fixture no longer trips containsInternalLeak");
  });

  check("a leaking title is replaced with Results", () => {
    assert.strictEqual(sanitizeChartConfigTitle({ type: "line", title: LEAKING_TITLE })!.title, "Results");
  });

  check("other leak shapes are caught too", () => {
    for (const title of ["[SYSTEM: retry with year filter]", "SELECT year FROM agency_monthly", "ROUND(count / population)", "chartConfig for the result"]) {
      assert.strictEqual(
        sanitizeChartConfigTitle({ type: "line", title })!.title,
        "Results",
        `not sanitized: ${title}`
      );
    }
  });

  check("a clean title is untouched and the same object is returned", () => {
    const clean = { type: "line", title: "Murders in Houston, 2010-2025" };
    assert.strictEqual(sanitizeChartConfigTitle(clean), clean, "clean configs must not be reallocated");
  });

  check("non-objects and empty values pass through safely", () => {
    assert.strictEqual(sanitizeChartConfigTitle(null), null);
    assert.strictEqual(sanitizeChartConfigTitle(undefined), undefined);
    assert.doesNotThrow(() => sanitizeChartConfigTitle({ type: "line" } as { title?: unknown }));
  });

  check("the header and the chart now agree when a title leaks", () => {
    // This is the actual user-visible bug: the two disagreed.
    const sanitizedHeader = sanitizeUserFacingNarrative("some explanation", LEAKING_TITLE).title;
    const sanitizedChart = sanitizeChartConfigTitle({ type: "line", title: LEAKING_TITLE })!.title;
    assert.strictEqual(sanitizedHeader, "Results");
    assert.strictEqual(sanitizedChart, "Results");
    assert.strictEqual(sanitizedHeader, sanitizedChart, "header and chart title must agree");
  });
}

console.log("\n2. Every route's response firewall covers chartConfig");
{
  check("all four firewalls sanitize chartConfig", () => {
    for (const [name, text] of Object.entries(src)) {
      assert.ok(
        /payload\.chartConfig = sanitizeChartConfigTitle\(payload\.chartConfig\)/.test(text),
        `${name} does not sanitize chartConfig at egress`
      );
    }
  });

  check("sanitization precedes the response being emitted", () => {
    for (const [name, text] of Object.entries(src)) {
      const sanitizeAt = text.indexOf("payload.chartConfig = sanitizeChartConfigTitle");
      const emitAt = text.search(/return (?:NextResponse\.json\(payload|`data: \$\{JSON\.stringify\(payload)/);
      assert.ok(sanitizeAt > 0 && emitAt > 0, `${name}: could not locate the firewall`);
      assert.ok(sanitizeAt < emitAt, `${name}: sanitization runs after the payload is emitted`);
    }
  });

  check("it sits with the existing title sanitization, not somewhere unrelated", () => {
    for (const [name, text] of Object.entries(src)) {
      const titleAt = text.indexOf("payload.title = safe.title;");
      const chartAt = text.indexOf("payload.chartConfig = sanitizeChartConfigTitle");
      assert.ok(titleAt > 0, `${name}: existing title sanitization not found`);
      assert.ok(chartAt > titleAt && chartAt - titleAt < 400, `${name}: chart sanitization is not adjacent to the title sanitization`);
    }
  });
}

console.log("\n3. SHR and hate crime sync the chart title to the finalized title");
{
  for (const name of ["shr", "hate_crime"] as const) {
    check(`${name}: chartConfig is reassignable (let, not const)`, () => {
      assert.ok(
        /let chartConfig = applyChartCustomizations\(\{/.test(src[name]),
        `${name}: still const, so the title cannot be corrected`
      );
    });

    check(`${name}: the sync runs after the final title is set`, () => {
      const text = src[name];
      const finalTitleAt = text.indexOf('claude.title = finalNarrative.title || claude.title || "Results"');
      const syncAt = text.indexOf("chartConfig = { ...chartConfig, title: claude.title }");
      assert.ok(finalTitleAt > 0, `${name}: final title assignment not found`);
      assert.ok(syncAt > 0, `${name}: no title sync found`);
      assert.ok(finalTitleAt < syncAt, `${name}: sync must come AFTER the final title is set`);
    });

    check(`${name}: the sync runs before the response is returned`, () => {
      const text = src[name];
      const syncAt = text.indexOf("chartConfig = { ...chartConfig, title: claude.title }");
      const returnAt = text.indexOf("return jsonResp({", syncAt);
      assert.ok(returnAt > syncAt, `${name}: no response return found after the sync`);
    });
  }

  check("a corrected title propagates to the config", () => {
    let chartConfig: { type: string; title: string } | null = { type: "line", title: "Murders in Houston, 2010-2024" };
    const finalTitle = "Murders in Houston, 2010-2025";
    if (chartConfig && finalTitle && chartConfig.title !== finalTitle) {
      chartConfig = { ...chartConfig, title: finalTitle };
    }
    assert.strictEqual(chartConfig!.title, finalTitle);
  });
}

console.log(`\n${process.exitCode ? "FAILURES present." : `All ${passed} chart-title leak checks passed.`}`);
