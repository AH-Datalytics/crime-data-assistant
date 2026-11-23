import fs from "node:fs";
import { shadowAnswer, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
const shapes = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as Record<string, [string, string, string, string | null][]>;
const places = loadPlaceIndex();
const base: ShadowDeps = { places, release: { id: "test-release", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" },
  target: { root: "/build", builtYears: [2017,2018,2019,2020,2021,2022,2023,2024,2025,2026], arrestYears: [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] }, execute: () => [] } as ShadowDeps;
const withShr = { ...base, shr: { root: "/shr", release: "shr-20261101-1", latestMonth: "2026-09", crosswalk: "cw" }, historical: { root: "/hist", release: "h", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1960 } } as unknown as ShadowDeps;
const out: string[] = [];
for (const [shape, items] of Object.entries(shapes)) for (const [id, src, q, prev] of items) {
  if (prev) continue;
  let r: any; try { r = shadowAnswer(q, withShr); } catch (e) { r = { kind: "THROW", explanation: String(e) }; }
  out.push([shape, id, src, r.kind, r.reason ?? r.source ?? r.about ?? "", (r.explanation ?? r.question ?? "").toString().slice(0, 110), q.slice(0, 80)].join(" | "));
}
console.log(out.join("\n"));
