import fs from "node:fs";
import { shadowAnswer, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
const labels = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).labels as { id: string; kind: string; question: string }[];
const places = loadPlaceIndex();
const d = { places, release: { id: "test-release", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" }, target: { root: "/build", builtYears: [2017,2018,2019,2020,2021,2022,2023,2024,2025,2026] }, execute: () => [],
  shr: { root: "/shr", release: "shr-20261101-1", latestMonth: "2026-09", crosswalk: "cw" }, historical: { root: "/hist", release: "h", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1960 } } as unknown as ShadowDeps;
const out: Record<string, string> = {};
for (const l of labels) { if (l.kind !== "first") continue;
  let r: any; try { r = shadowAnswer(l.question, d); } catch (e) { r = { kind: "THROW", explanation: String(e).slice(0, 60) }; }
  out[l.id] = `${r.kind}|${r.reason ?? r.source ?? r.about ?? ""}|${(r.explanation ?? "").toString().slice(0, 100)}`; }
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 0));
console.log(Object.keys(out).length);
