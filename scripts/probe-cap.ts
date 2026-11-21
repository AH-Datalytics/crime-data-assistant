import fs from "node:fs";
import { shadowAnswer, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
const places = loadPlaceIndex();
const base = { places, release: { id: "test-release", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" },
  target: { root: "/build", builtYears: [2017,2018,2019,2020,2021,2022,2023,2024,2025,2026] }, execute: () => [] } as unknown as ShadowDeps;
const d = { ...base, shr: { root: "/shr", release: "shr-20261101-1", latestMonth: "2026-09", crosswalk: "cw" }, historical: { root: "/hist", release: "h", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1960 } } as unknown as ShadowDeps;
for (const q of fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean)) {
  let r: any; try { r = shadowAnswer(q, d); } catch (e) { r = { kind: "THROW", explanation: String(e) }; }
  console.log(`${r.kind} ${r.reason ?? r.source ?? r.about ?? ""} | ${((r.detail ?? "") + " " + (r.explanation ?? "")).toString().slice(0, 260)} | ${q}`);
}
