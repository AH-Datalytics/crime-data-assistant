import Database from "better-sqlite3";
import path from "node:path";

type HistRow = { ori: string; agency: string; state: string; year: number; murder: number | null };
type ShrIdentity = { ori: string; state: string; canonical_agency: string; first_year: number; last_year: number };
type ShrCount = { ori: string; year: number; victims: number };

const apply = process.argv.includes("--apply");
const shrPath = process.env.SHR_DB_PATH || path.join(process.cwd(), "shr.db");
const crimePath = process.env.CRIME_DATA_DB_PATH || process.env.RTCI_DB_PATH || path.join(process.cwd(), "crime_data.db");

function normalizeName(value: string): string {
  return value.toUpperCase()
    .replace(/\b(POLICE|DEPARTMENT|DEPT|SHERIFF|OFFICE|CITY|COUNTY|PARISH|BOROUGH)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function stateKey(value: string): string { return (value || "").toUpperCase(); }

const shr = new Database(shrPath, { readonly: !apply });
shr.pragma("busy_timeout = 30000");
shr.exec("ATTACH DATABASE '" + crimePath.replace(/'/g, "''") + "' AS crime_data");

const identities = shr.prepare(`
  SELECT ori, state, canonical_agency, first_year, last_year
  FROM main.shr_agency_identity
`).all() as ShrIdentity[];
const hist = shr.prepare(`
  SELECT ha.ori, ha.agency, upper(ha.state) AS state, hac.year, COALESCE(hac.murder, 0) AS murder
  FROM crime_data.historical_agency ha
  JOIN crime_data.historical_agency_crime hac ON hac.ori = ha.ori
  WHERE ha.ori IS NOT NULL AND ha.state IS NOT NULL
`).all() as HistRow[];
const shrCounts = shr.prepare(`
  SELECT i.ori, i.year, COUNT(v.id) AS victims
  FROM main.incidents i
  LEFT JOIN main.victims v ON v.incident_id = i.id
  WHERE i.homicide_type = 'Murder' AND i.ori IS NOT NULL
  GROUP BY i.ori, i.year
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
for (const row of shrCounts) shrByAgencyYear.set(`${row.ori.toUpperCase()}|${row.year}`, Number(row.victims || 0));

const rows: Array<[string, string, number, number | null, number | null, string, string, string]> = [];
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
  const histByYear = new Map(histRows.map((row) => [row.year, Number(row.murder || 0)]));
  const years = new Set<number>();
  for (const row of shrCounts) if (row.ori.toUpperCase() === identity.ori.toUpperCase()) years.add(row.year);
  for (const year of histByYear.keys()) years.add(year);
  for (const year of years) {
    const shrVictims = shrByAgencyYear.get(`${identity.ori.toUpperCase()}|${year}`) ?? 0;
    const retaMurders = selectedOri ? (histByYear.get(year) ?? 0) : null;
    const status = joinMethod === "ambiguous" || joinMethod === "unmatched"
      ? "join_unresolved"
      : year < 2021
        ? retaMurders && retaMurders > 0 && shrVictims === 0 ? "pre2021_gap_candidate" : retaMurders === 0 && shrVictims === 0 ? "pre2021_true_zero_candidate" : "pre2021_matched"
        : "post2020_transition_review";
    rows.push([identity.ori, state, year, retaMurders, shrVictims, joinMethod, year < 2021 ? "pre2021" : "post2020", status]);
  }
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
      join_method TEXT NOT NULL,
      era TEXT NOT NULL,
      comparison_status TEXT NOT NULL,
      PRIMARY KEY (shr_ori, year)
    );
    CREATE INDEX idx_shr_return_a_state_year ON shr_return_a_comparison(state, year);
    CREATE INDEX idx_shr_return_a_status ON shr_return_a_comparison(comparison_status);
  `);
  const insert = shr.prepare(`INSERT INTO main.shr_return_a_comparison VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  shr.transaction(() => { for (const row of rows) insert.run(...row); })();
}

console.log(JSON.stringify({ applied: apply, shrPath, crimePath, identities: identities.length, historicalRows: hist.length, shrCountRows: shrCounts.length, comparisonRows: rows.length, joinMethods: rows.reduce<Record<string, number>>((out, row) => { out[row[5]] = (out[row[5]] || 0) + 1; return out; }, {}) }));
shr.close();
