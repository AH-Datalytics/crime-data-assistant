import assert from "node:assert/strict";
import fs from "node:fs";

const routes = [
  "app/api/query/route.ts",
  "app/api/nibrs-query/route.ts",
  "app/api/shr-query/route.ts",
  "app/api/hc-query/route.ts",
];

for (const file of routes) {
  const source = fs.readFileSync(file, "utf8");
  assert.match(source, /sanitizeUserFacingNarrative/, `${file} must import/use the egress sanitizer`);
  assert.match(source, /applyResultDisclosures/, `${file} must disclose results`);
}

const streaming = fs.readFileSync("app/api/query/route.ts", "utf8");
const sseStart = streaming.indexOf("function sseEvent");
const sseBody = streaming.slice(sseStart, streaming.indexOf("function ", sseStart + 1));
assert.ok(sseStart >= 0 && sseBody.includes("sanitizeUserFacingNarrative"), "SSE serializer must sanitize narratives");
assert.match(streaming, /payload\.explanation\s*=\s*safe\.explanation/);
assert.match(streaming, /payload\.title\s*=\s*safe\.title/);

for (const file of routes.slice(1)) {
  const source = fs.readFileSync(file, "utf8");
  const wrapper = source.indexOf("function jsonResp");
  const sanitizer = source.indexOf("sanitizeUserFacingNarrative", wrapper);
  assert.ok(wrapper >= 0 && sanitizer > wrapper, `${file} JSON response wrapper must sanitize narratives`);
  const disclosure = source.indexOf("applyResultDisclosures");
  const finalSanitizer = source.lastIndexOf("sanitizeUserFacingNarrative");
  assert.ok(disclosure >= 0 && finalSanitizer > disclosure, `${file} result path must sanitize after disclosure`);
  assert.match(source, /internal-leak-firewall-result/, `${file} must tag result-path firewall events`);
  assert.ok(source.includes("console.warn") && source.includes("internal-leak-firewall"), `${file} must log result-path firewall events`);
}

// Guardrail tags must survive the query route's post-generation validation
// reassignment, and every final result log must classify contract tags against
// the SQL that actually ran.
assert.doesNotMatch(
  streaming,
  /firedGuardrails\s*=\s*guardrailResult\.fired\s*;/,
  "query route must not discard tags collected before post-generation validation",
);
assert.match(
  streaming,
  /firedGuardrails\s*=\s*mergeGuardrailTags\(firedGuardrails,\s*guardrailResult\.fired\)/,
  "query route must merge post-generation guardrails",
);
for (const file of routes) {
  const source = fs.readFileSync(file, "utf8");
  const finalizationCount = (source.match(/finalizeGuardrailTags\(/g) || []).length;
  assert.ok(finalizationCount >= 1, `${file} must finalize guardrail tags before final logging`);
}

const shrRoute = fs.readFileSync("app/api/shr-query/route.ts", "utf8");
assert.match(shrRoute, /const followupCities = shootingCityIntents\(guardrailQuestion\)/,
  "SHR must resolve named cities for initial questions and follow-ups");
assert.doesNotMatch(shrRoute, /followupTransform \? shootingCityIntents\(guardrailQuestion\) : \[\]/,
  "SHR initial questions must not bypass verified ORI resolution");
// National chart metadata must use the latest source month/year, not the
// requested display start year (7845 exposed the old year >= 2018 behavior).
assert.match(streaming, /SELECT agency_count as cnt, year, month FROM national_monthly/,
  "national chart metadata must read the latest source period");
assert.match(streaming, /ORDER BY year DESC, month DESC/,
  "national chart metadata must order by the latest source period");
assert.match(streaming, /latestPopulationYear/,
  "national population metadata must use the latest source year");
assert.match(streaming, /FROM agency_monthly am[\s\S]*WHERE am.year = \? AND am.month = \?/,
  "national population metadata must use agencies reporting in the latest month");
// Title alignment must run BEFORE the chart config is built, or the rendered
// chart title keeps the model's stale year range (production hate-crime bug).
const chartBuilder: Record<string, string> = {
  "app/api/query/route.ts": "buildChartConfig",
  "app/api/nibrs-query/route.ts": "buildNibrsChartConfig",
  "app/api/hc-query/route.ts": "applyChartCustomizations",
};
for (const [file, builder] of Object.entries(chartBuilder)) {
  const source = fs.readFileSync(file, "utf8");
  const align = source.indexOf("alignTitleYearRange(claude.title");
  // Main model-path chart build is the LAST occurrence (nibrs also has an
  // earlier deterministic-path build that returns before the title step).
  const chart = source.lastIndexOf(builder + "(");
  assert.ok(align >= 0, `${file} must align the title year range`);
  assert.ok(chart >= 0 && align < chart, `${file} must align the title BEFORE building the main-path chart (${builder})`);
  if (file === "app/api/nibrs-query/route.ts") {
    /*
     * EACH CHART'S OWN TITLE, not "some alignment happened earlier in the file".
     *
     * Two versions of this check have now been wrong in opposite directions. The first pinned one
     * alignment line against the FIRST `buildNibrsChartConfig(`, which held only while there was a
     * single deterministic path; adding the owned yearly-clearance path ahead of it failed a route
     * that aligns correctly. My replacement then asked only whether ANY alignment preceded a chart
     * build -- so the owned path's alignment licensed the later deterministic chart, and deleting
     * the deterministic alignment still passed. That is exactly the regression this exists to catch.
     *
     * So the title each chart is actually given is read out of the call and matched to its own
     * alignment. A plan passed by name (`buildNibrsChartConfig(deterministicQuery, ...)`) needs
     * `deterministicQuery.title = alignTitleYearRange(`; a plan passed as an object literal with
     * `title: ownedTitle` needs `ownedTitle` bound from `alignTitleYearRange(`. An argument shape
     * this cannot read fails rather than passing quietly.
     */
    const charts = [...source.matchAll(/buildNibrsChartConfig\(/g)].map((match) => match.index ?? -1);
    assert.ok(charts.length > 0, "NIBRS must build charts");
    for (const chartAt of charts) {
      const call = source.slice(chartAt, chartAt + 400);
      const before = source.slice(0, chartAt);
      const named = call.match(/buildNibrsChartConfig\(\s*([A-Za-z_$][\w$]*)\s*,/);
      const literal = call.match(/buildNibrsChartConfig\(\s*\{[\s\S]*?\btitle:\s*([A-Za-z_$][\w$]*)/);
      if (named) {
        const plan = named[1];
        assert.ok(
          new RegExp(`\\b${plan}\\.title\\s*=\\s*alignTitleYearRange\\(`).test(before),
          `NIBRS chart at ${chartAt} is given ${plan}, whose title is never aligned before it`);
      } else if (literal) {
        const title = literal[1];
        assert.ok(
          new RegExp(`\\b(?:const|let|var)\\s+${title}\\s*=\\s*alignTitleYearRange\\(`).test(before),
          `NIBRS chart at ${chartAt} is given ${title}, which is not bound from alignTitleYearRange`);
      } else {
        assert.fail(`NIBRS chart at ${chartAt} passes a title this check cannot read: ${call.slice(0, 120)}`);
      }
    }
  }
}

console.log("route egress contract tests: passed");
