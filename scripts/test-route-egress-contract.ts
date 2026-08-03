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
}

console.log("route egress contract tests: passed");
