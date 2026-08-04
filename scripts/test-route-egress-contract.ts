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
    const deterministicAlign = source.indexOf("deterministicQuery.title = alignTitleYearRange(");
    const deterministicChart = source.indexOf("buildNibrsChartConfig(");
    assert.ok(deterministicAlign >= 0 && deterministicChart >= 0 && deterministicAlign < deterministicChart, "NIBRS deterministic title must align before its chart is built");
  }
}

console.log("route egress contract tests: passed");
