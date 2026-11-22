/**
 * What each source besides NIBRS adds to the engine's dependencies in the service. Each builder reads its source's own manifest the way the scorecard and the
 * preview route do, and throws a plain sentence when the folder is not what the engine needs, so the core can report it and keep the other sources answering.
 */
import { currentBuildAt } from "../nibrs-shadow/current";
import { historicalBuildAt } from "../nibrs-shadow/historical";
import type { SourceBuilder } from "./core";

/** Crime Index - Historical and Crime Index - Current: one folder, one manifest. Both tabs need it whole: a build without either is refused rather than half served. */
export const crimeIndexBuilder: SourceBuilder = (root, { execute }) => {
  let historical;
  try { historical = historicalBuildAt(root); } catch (e) { throw new Error(`the Crime Index manifest in ${root} is not readable for Historical: ${e instanceof Error ? e.message : String(e)}`); }
  if (!historical) throw new Error(`there is no Crime Index manifest.json in ${root}`);
  let current;
  try { current = currentBuildAt(root, execute as (sql: string) => unknown[][]); } catch (e) { throw new Error(`the Crime Index current tables in ${root} could not be read: ${e instanceof Error ? e.message : String(e)}`); }
  if (!current) throw new Error(`the Crime Index manifest in ${root} lists no current_crime table`);
  return { deps: { historical, current }, releases: { historical: historical.release, current: current.release } };
};
