import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { classifyShrAnnualCoverage, type ShrComparisonStatus } from "../lib/shr-annual-coverage";

type HistRow = { ori: string; agency: string; state: string; year: number; murder: number | null };
type ShrIdentity = { ori: string; state: string; canonical_agency: string; first_year: number; last_year: number };
type ShrCount = { ori: string; state: string; year: number; victims: number; months_with_records: number };

const apply = process.argv.includes("--apply");
const shrPath = process.env.SHR_DB_PATH || path.join(process.cwd(), "shr.db");
const crimePath = process.env.CRIME_DATA_DB_PATH || process.env.RTCI_DB_PATH || path.join(process.cwd(), "crime_data.db");
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] || "") : null;
if (apply && !outputPath) throw new Error("--apply requires --output PATH; the source SHR database is never modified in place.");
if (apply && (/^\/opt\/nibrs(?:\/|$)/.test(path.resolve(shrPath)) || /^\/opt\/nibrs(?:\/|$)/.test(outputPath!))) {
  throw new Error("Coverage artifacts must be built off-VPS, not under /opt/nibrs.");
}
const buildPath = apply ? outputPath! : shrPath;
if (apply) {
  if (path.resolve(shrPath) === buildPath) throw new Error("--output must differ from SHR_DB_PATH.");
  fs.copyFileSync(shrPath, buildPath);
}

function normalizeName(value: string): string {
  return value.toUpperCase()
    .replace(/\b(POLICE|DEPARTMENT|DEPT|SHERIFF|OFFICE|CITY|COUNTY|PARISH|BOROUGH)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function stateKey(value: string): string { return (value || "").toUpperCase(); }

const shr = new Database(buildPath, { readonly: !apply });
shr.pragma("busy_timeout = 30000");
shr.exec("ATTACH DATABASE '" + crimePath.replace(/'/g, "''") + "' AS crime_data");

const identities = shr.prepare(`
  SELECT ori, state, canonical_agency, first_year, last_year
  FROM main.shr_agency_identity
`).all() as ShrIdentity[];
const hist = shr.prepare(`
  SELECT ha.ori, ha.agency, upper(ha.state) AS state, hac.year, hac.murder AS murder
  FROM crime_data.historical_agency ha
  JOIN crime_data.historical_agency_crime hac ON hac.ori = ha.ori
  WHERE ha.ori IS NOT NULL AND ha.state IS NOT NULL
`).all() as HistRow[];
const shrCounts = shr.prepare(`
  SELECT i.ori, upper(i.state) AS state, i.year,
         COUNT(CASE WHEN i.homicide_type = 'Murder' THEN v.id END) AS victims,
         COUNT(DISTINCT i.month) AS months_with_records
  FROM main.incidents i
  LEFT JOIN main.victims v ON v.incident_id = i.id
  WHERE i.ori IS NOT NULL
  GROUP BY i.ori, upper(i.state), i.year
`).all() as ShrCount[];

const histByPrefix = new Map<string, HistRow[]>();
const histByName = new Map<string, HistRow[]>();
for (const row of hist) {
  const prefixKey = `${stateKey(row.state)}|${row.ori.toUpperCase().slice(0, 7)}`;
  const nameKey = `${stateKey(row.state)}|${normalizeName(row.agency)}`;
  (histByPrefix.get(prefixKey) || (histByPrefix.set(prefixKey, []), histByPrefix.get(prefixKey)!)).push(row);
  (histByName.get(nameKey) || (histByName.set(nameKey, []), histByName.get(nameKey)!)).push(row);
}
const shrByAgencyYear = new Map<string, number>();
const monthsByAgencyYear = new Map<string, number>();
const shrYearsByAgency = new Map<string, Set<number>>();
for (const row of shrCounts) {
  const agencyKey = `${row.state}|${row.ori.toUpperCase()}`;
  shrByAgencyYear.set(`${agencyKey}|${row.year}`, Number(row.victims || 0));
  monthsByAgencyYear.set(`${agencyKey}|${row.year}`, Number(row.months_with_records || 0));
  (shrYearsByAgency.get(agencyKey) || (shrYearsByAgency.set(agencyKey, new Set()), shrYearsByAgency.get(agencyKey)!)).add(row.year);
}

const hasPrevious = Boolean(shr.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shr_return_a_comparison'").get());
const previousRows = hasPrevious
  ? shr.prepare("SELECT shr_ori, state, year, comparison_status FROM shr_return_a_comparison").all() as Array<{ shr_ori: string; state: string; year: number; comparison_status: string }>
  : [];
const previousByKey = new Map(previousRows.map((row) => [`${row.state}|${row.shr_ori}|${row.year}`, row.comparison_status]));
const buildTs = Date.now();
type BuildRow = {
  shrOri: string; state: string; year: number; retaMurders: number | null; shrVictims: number;
  monthsWithRecords: number; joinMethod: string; era: string; comparisonStatus: ShrComparisonStatus;
  displayValue: number | null; displayStatus: string; caveatCode: string | null;
  comparisonConflict: number; presentationChanged: number; classificationChanged: number; buildTs: number;
};
const rows: BuildRow[] = [];
for (const identity of identities) {
  const state = stateKey(identity.state);
  const prefix = histByPrefix.get(`${state}|${identity.ori.toUpperCase().slice(0, 7)}`) || [];
  const nameCandidates = histByName.get(`${state}|${normalizeName(identity.canonical_agency)}`) || [];
  const distinctOris = [...new Set((prefix.length ? prefix : nameCandidates).map((row) => row.ori))];
  const joinMethod = prefix.length === 1 || distinctOris.length === 1
    ? (prefix.length ? "ori_prefix_7_to_9" : "state_name_fallback")
    : prefix.length > 1 || nameCandidates.length > 1 ? "ambiguous" : "unmatched";
  const selectedOri = distinctOris.length === 1 ? distinctOris[0] : null;
  const histRows = selectedOri ? (prefix.length ? prefix : nameCandidates).filter((row) => row.ori === selectedOri) : [];
  const histByYear = new Map(histRows.map((row) => [row.year, row.murder]));
  const years = new Set<number>();
  for (const year of shrYearsByAgency.get(`${state}|${identity.ori.toUpperCase()}`) || []) years.add(year);
  for (const year of histByYear.keys()) years.add(year);
  for (const year of years) {
    const shrVictims = shrByAgencyYear.get(`${state}|${identity.ori.toUpperCase()}|${year}`) ?? 0;
    const rawRetaMurders = selectedOri ? (histByYear.get(year) ?? null) : null;
    const retaMurders = rawRetaMurders != null && rawRetaMurders >= 0 ? rawRetaMurders : null;
    const status: ShrComparisonStatus = joinMethod === "ambiguous" || joinMethod === "unmatched"
      ? "join_unresolved"
      : retaMurders === null
        ? "reta_unreported"
      : year < 2021
        ? retaMurders && retaMurders > 0 && shrVictims === 0 ? "pre2021_gap_candidate" : retaMurders === 0 && shrVictims === 0 ? "pre2021_true_zero_candidate" : "pre2021_matched"
        : "post2020_transition_review";
    const decision = classifyShrAnnualCoverage({ retaMurders, shrVictims, comparisonStatus: status, joinMethod });
    const key = `${state}|${identity.ori}|${year}`;
    rows.push({
      shrOri: identity.ori, state, year, retaMurders, shrVictims,
      monthsWithRecords: monthsByAgencyYear.get(key) ?? 0,
      joinMethod, era: year < 2021 ? "pre2021" : "post2020",
      comparisonStatus: decision.normalizedComparisonStatus,
      displayValue: decision.displayValue, displayStatus: decision.displayStatus,
      caveatCode: decision.caveatCode,
      comparisonConflict: decision.comparisonConflict ? 1 : 0,
      presentationChanged: decision.presentationChanged ? 1 : 0,
      classificationChanged: previousByKey.get(key) !== decision.normalizedComparisonStatus ? 1 : 0,
      buildTs,
    });
  }
}

const positiveCountsHidden = rows.filter((row) => row.shrVictims > 0 && row.displayValue == null).length;
const invalidDisplayedZeroes = rows.filter((row) => row.displayValue === 0 && row.displayStatus !== "validated_zero").length;
const unmatchedZeroRows = rows.filter((row) => row.shrVictims === 0 && row.comparisonStatus === "pre2021_matched").length;
if (positiveCountsHidden || invalidDisplayedZeroes || unmatchedZeroRows) {
  throw new Error(`Coverage invariants failed: positive_hidden=${positiveCountsHidden}, invalid_zero=${invalidDisplayedZeroes}, zero_matched=${unmatchedZeroRows}`);
}

if (apply) {
  shr.exec(`
    DROP TABLE IF EXISTS main.shr_return_a_comparison;
    CREATE TABLE main.shr_return_a_comparison (
      shr_ori TEXT NOT NULL,
      state TEXT NOT NULL,
      year INTEGER NOT NULL,
      reta_murders INTEGER,
      shr_victims INTEGER NOT NULL,
      months_with_records INTEGER NOT NULL,
      join_method TEXT NOT NULL,
      era TEXT NOT NULL,
      comparison_status TEXT NOT NULL,
      display_value INTEGER,
      display_status TEXT NOT NULL,
      caveat_code TEXT,
      comparison_conflict INTEGER NOT NULL,
      presentation_changed INTEGER NOT NULL,
      classification_changed INTEGER NOT NULL,
      classification_build_ts INTEGER NOT NULL,
      PRIMARY KEY (shr_ori, state, year)
    );
    CREATE INDEX idx_shr_return_a_state_year ON shr_return_a_comparison(state, year);
    CREATE INDEX idx_shr_return_a_status ON shr_return_a_comparison(comparison_status);
    CREATE INDEX idx_shr_return_a_display_status ON shr_return_a_comparison(display_status);
  `);
  const insert = shr.prepare(`INSERT INTO main.shr_return_a_comparison VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  shr.transaction(() => { for (const row of rows) insert.run(
    row.shrOri, row.state, row.year, row.retaMurders, row.shrVictims, row.monthsWithRecords,
    row.joinMethod, row.era, row.comparisonStatus, row.displayValue, row.displayStatus,
    row.caveatCode, row.comparisonConflict, row.presentationChanged, row.classificationChanged, row.buildTs,
  ); })();
}

console.log(JSON.stringify({
  applied: apply, shrPath, buildPath, crimePath, identities: identities.length,
  historicalRows: hist.length, shrCountRows: shrCounts.length, comparisonRows: rows.length,
  comparisonStatuses: rows.reduce<Record<string, number>>((out, row) => { out[row.comparisonStatus] = (out[row.comparisonStatus] || 0) + 1; return out; }, {}),
  displayStatuses: rows.reduce<Record<string, number>>((out, row) => { out[row.displayStatus] = (out[row.displayStatus] || 0) + 1; return out; }, {}),
  positiveCountsHidden, invalidDisplayedZeroes, unmatchedZeroRows,
}));
shr.close();
