/**
 * The NIBRS release the shadow reads (scripts/fixtures/nibrs-shadow/release.json, built by
 * scripts/build-nibrs-shadow-release.py) and its months: from the build's first year through the month before the
 * release's month (Jeff 2026-11-03, latestShownMonth), keyed to the release date recorded with the build.
 */
import fs from "node:fs";
import path from "node:path";
import { latestShownMonth } from "../answer-contract/contract";

export type NibrsRelease = { id: string; firstMonth: string; lastMonth: string; released: string };
// Resolved from the working directory, as the routes resolve agencies.json (a Next bundle has no source __dirname).
export function loadNibrsRelease(file = path.join(process.cwd(), "scripts/fixtures/nibrs-shadow/release.json")): NibrsRelease {
  const r = JSON.parse(fs.readFileSync(file, "utf8")) as { release: string; first_year: number; released: string };
  return { id: r.release, firstMonth: `${r.first_year}-01`, lastMonth: latestShownMonth(r.released), released: r.released };
}
