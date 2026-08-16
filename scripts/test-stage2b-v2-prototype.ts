import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "docs", "superpowers", "stage2b-interview-v2-prototype.html"), "utf8");
const check = (name: string, run: () => void): void => { run(); console.log(`PASS ${name}`); };

check("the page gives one clear status", () => {
  assert.match(html, /You do not need to do anything right now/);
  assert.match(html, /Stage 2B is paused/);
});
check("the page says why", () => assert.match(html, /questions that the system was not ready to ask/));
check("the page says what happens next", () => {
  assert.match(html, /Engineering will work out why data can be missing/);
  assert.match(html, /only if there is a real choice that only you can make/);
});
check("there are no answer or export controls", () => {
  assert.doesNotMatch(html, /<(?:input|button|textarea|select)\b/i);
  assert.doesNotMatch(html, /Export answers|policy owner/i);
});
check("the page contains no internal vocabulary", () => assert.doesNotMatch(html, /capabilit|integrity|coverage|receipt|artifact|recent-trends/i));

console.log("stage2b pause page: 5 passed, 0 failed");
