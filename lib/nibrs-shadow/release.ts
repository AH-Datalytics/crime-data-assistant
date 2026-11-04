/**
 * The NIBRS release the shadow reads (scripts/fixtures/nibrs-shadow/release.json, built by
 * scripts/build-nibrs-shadow-release.py) and its months: from the build's first year through the month before the
 * release's month (Jeff 2026-11-03, latestShownMonth), keyed to the release date recorded with the build.
 */
import fs from "node:fs";
import path from "node:path";
import { latestShownMonth } from "../answer-contract/contract";

export type NibrsRelease = { id: string; firstMonth: string; lastMonth: string; released: string };
/**
 * `root`: the canonical build the answers read (its parent holds the build's manifest). Given, the release recorded must
 * be that build's, by its id and latest-year source SHA-256, or loading fails: a cutoff from one build is never applied to
 * another (Codex release review 01.1). Resolved from the working directory, as the routes resolve agencies.json.
 */
export function loadNibrsRelease(file = path.join(process.cwd(), "scripts/fixtures/nibrs-shadow/release.json"), root?: string): NibrsRelease {
  const r = JSON.parse(fs.readFileSync(file, "utf8")) as { release: string; first_year: number; latest_year: number; source_sha256: string; released: string };
  if (root) {
    const m = JSON.parse(fs.readFileSync(path.join(root, "..", "manifest.json"), "utf8")) as { release_id: string; years: Record<string, { source_sha256: string }> };
    const sha = m.years[String(r.latest_year)]?.source_sha256;
    if (m.release_id !== r.release || sha !== r.source_sha256)
      throw new Error(`release.json describes ${r.release} (${r.source_sha256}), but the build at ${root} is ${m.release_id} (${sha ?? "no " + r.latest_year + " file"}): rebuild it with scripts/build-nibrs-shadow-release.py`);
  }
  return { id: r.release, firstMonth: `${r.first_year}-01`, lastMonth: latestShownMonth(r.released), released: r.released };
}
