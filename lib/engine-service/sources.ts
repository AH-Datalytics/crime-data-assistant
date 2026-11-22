/**
 * What each source besides NIBRS adds to the engine's dependencies in the service. Each builder reads its source's own manifest the way the scorecard and the
 * preview route do, and throws a plain sentence when the folder is not what the engine needs, so the core can report it and keep the other sources answering.
 */
import { currentBuildAt } from "../nibrs-shadow/current";
import { hateBuildAt } from "../nibrs-shadow/hate";
import { historicalBuildAt } from "../nibrs-shadow/historical";
import { shrBuildAt } from "../nibrs-shadow/shr";
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

/** Homicide Reports: the folder's manifest.json holds the "shr" release key. A folder without it, or with a malformed key, is refused with the reason. */
export const shrBuilder: SourceBuilder = (root) => {
  let shr;
  try { shr = shrBuildAt(root); } catch (e) { throw new Error(e instanceof Error ? e.message : String(e)); }
  if (!shr) throw new Error(`there is no Homicide Reports manifest.json in ${root}`);
  return { deps: { shr }, releases: { shr: shr.release } };
};

/** Hate crime: the export folder holds release.json and hate_crime_incident/data.parquet. A folder missing either, or with a release.json that fails its checks, is refused with the reason. */
export const hateBuilder: SourceBuilder = (root) => {
  let hate;
  try { hate = hateBuildAt(root); } catch (e) { throw new Error(e instanceof Error ? e.message : String(e)); }
  if (!hate) throw new Error(`there is no hate crime export (release.json and hate_crime_incident/data.parquet) in ${root}`);
  return { deps: { hate }, releases: { hate_crime: hate.release } };
};
