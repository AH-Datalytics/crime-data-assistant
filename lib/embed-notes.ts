import type { ChartMeta } from "@/lib/types";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "116,958,827" -> "117.0 million"; below a million, the whole number. */
function people(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} million` : n.toLocaleString("en-US");
}

/**
 * Owner 2026-10-26: a chart states under it "Sample of N agencies covering N population." and "<year> covers data
 * from <month> to <month>.", so a copied or saved image (or an embedded chart), which carries no answer text, keeps
 * them. Only from the answer's own chart metadata; nothing when it carries none.
 */
export function chartNotes(meta: ChartMeta | null | undefined): string[] {
  if (!meta) return [];
  const notes: string[] = [];
  if (typeof meta.sampleAgencies === "number" && meta.sampleAgencies > 0) {
    const agencies = `${meta.sampleAgencies.toLocaleString("en-US")} ${meta.sampleAgencies === 1 ? "agency" : "agencies"}`;
    notes.push(typeof meta.samplePopulation === "number" && meta.samplePopulation > 0
      ? `Sample of ${agencies} covering ${people(meta.samplePopulation)} population.`
      : `Sample of ${agencies}.`);
  }
  const p = meta.partialYear;
  if (p && Number.isInteger(p.year) && p.from >= 1 && p.to <= 12 && p.from <= p.to) {
    notes.push(p.from === p.to ? `${p.year} covers data from ${MONTHS[p.to - 1]} only.` : `${p.year} covers data from ${MONTHS[p.from - 1]} to ${MONTHS[p.to - 1]}.`);
  }
  return notes;
}
