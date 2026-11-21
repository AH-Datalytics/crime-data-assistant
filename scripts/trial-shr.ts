import fs from "node:fs";
import { shadowAnswer, shadowFollowUp, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
const rows = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as [string, string, string, string, string | null][];
const places = loadPlaceIndex();
const d = { places, release: { id: "test-release", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" }, target: { root: "/build", builtYears: [2017,2018,2019,2020,2021,2022,2023,2024,2025,2026] }, execute: () => [],
  shr: { root: "/shr", release: "shr-20261101-1", latestMonth: "2026-09", crosswalk: "cw" }, historical: { root: "/hist", release: "h", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1960 } } as unknown as ShadowDeps;
let n = 0, reached = 0;
for (const [shape, id, , q, prev] of rows) {
  if (prev) continue;
  let r: any; try { r = shadowAnswer(q, d); } catch (e) { r = { kind: "THROW", explanation: String(e) }; }
  const ok = r.kind === "shr" || r.kind === "answer" || (r.kind === "decline" && /filed no Homicide Reports/.test(r.explanation ?? ""));
  n++; if (ok) reached++;
  console.log(`${ok ? "REACH" : "miss "} ${shape} | ${id} | ${r.kind} ${(r.explanation ?? r.about ?? "").toString().slice(0, 80)} | ${q.slice(0, 80)}`);
}
console.log(`reached ${reached}/${n}`);
