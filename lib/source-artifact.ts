import type { SourceId } from "./proof-contract";

/**
 * The artifact a source's data actually lives in.
 *
 * `current` and `historical` are two tabs over ONE artifact (`crime_data.db`), which is why
 * capability ids are keyed on the artifact rather than on the tab: two tabs cannot have different
 * structural health for the same table.
 *
 * Kept separate from the generated inventory so a hand-written mapping never ends up inside a
 * generated file, and exported so nothing has to re-derive it inline.
 */
export function artifactOf(source: SourceId | "crime_data"): string {
  return source === "current" || source === "historical" || source === "crime_data" ? "crime_data" : source;
}
