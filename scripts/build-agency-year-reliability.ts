/**
 * Build the agency_year_reliability table: every city and county agency-year judged by the SAME
 * shared evaluator the scorecard uses (lib/agency-reliability.ts), materialized so the
 * ordinary Historical answer path can caveat unreliable figures without recomputing.
 *
 * Usage:
 *   npx tsx scripts/build-agency-year-reliability.ts [--db path] [--dry-run]
 *
 * Design constraints, from the Codex review of the disclosure plan:
 *   - Atomic: builds into a staging table, validates, then swaps inside one
 *     transaction. A failed refresh leaves the previous table intact, never an empty
 *     one -- this table gates user-facing caveats, and an empty table silently turns
 *     them all off.
 *   - Acceptance-gated: the sweep itself covers city AND county agencies, but the gate
 *     checks only the city own-history slice over the two most recent years, which must
 *     reproduce EXACTLY the independently verified count (878 as of 2026-08-06 data).
 *     County and RTCI findings are additional and reported separately; the gate applies
 *     only to the slice that was independently verified.
 *   - Versioned: rows carry the algorithm version, so a threshold change is
 *     distinguishable from a data change.
 *
 * The sweep bulk-loads and calls the shared PURE decision functions -- it must never
 * reimplement thresholds. If you are editing a threshold here, you are in the wrong
 * file: they live in lib/agency-reliability.ts, shared with the scorecard.
 */
import Database from "better-sqlite3";
import {
  evaluateOwnHistory, evaluateRtciCrosscheck,
  HISTORY_LOOKBACK_YEARS, MURDER_RATIO_LOOKBACK_YEARS, RTCI_CROSSCHECK_MIN_COUNT,
  RELIABILITY_ALGORITHM_VERSION, RELIABILITY_OFFENSES,
  type ReliabilityFinding,
} from "../lib/agency-reliability";
import { consolidatedRtciAgency } from "../lib/agency-consolidations";

/**
 * The independently verified own-history count for city agencies, two newest years.
 *
 * This is a HARD equality gate, and that is the right shape for a MANUAL rebuild: any
 * drift means either a threshold change or a data change, and both demand fresh human
 * verification before caveats reach users.
 *
 * It must NOT be carried unchanged into an automated refresh. A new data year moves this
 * number legitimately, so an unattended job would either hard-fail on every refresh or
 * tempt whoever is on call to bump the literal without re-verifying -- which drains the
 * gate of the only thing that makes it worth having. Automation needs an actual
 * re-verification step, or a tolerance band that alerts instead of silently passing.
 */
const ACCEPTANCE_OWN_HISTORY_RECENT = 878;

const args = process.argv.slice(2);
const dbPath = args.includes("--db") ? args[args.indexOf("--db") + 1] : (process.env.RTCI_DB_PATH || "crime_data.db");
const dryRun = args.includes("--dry-run");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

console.log(`[reliability] building against ${dbPath} (algorithm ${RELIABILITY_ALGORITHM_VERSION})${dryRun ? " DRY RUN" : ""}`);

// ---- Bulk load ---------------------------------------------------------------------

// City AND county agencies: county scorecards represent the single lead county
// agency (never a countywide crosswalk sum), so county-years need the same judgment.
const agencies = db.prepare(`
  SELECT ori, agency, state, type FROM historical_agency WHERE type IN ('city', 'county')
`).all() as { ori: string; agency: string; state: string; type: "city" | "county" }[];
const oriType = new Map(agencies.map((a) => [a.ori, a.type]));

const crimeRows = db.prepare(`
  SELECT hac.ori, hac.year, hac.population, hac.murder, hac.rape, hac.robbery, hac.assault,
         hac.burglary, hac.theft, hac.motor_vehicle_theft
  FROM historical_agency_crime hac
  JOIN historical_agency ha ON ha.ori = hac.ori
  WHERE ha.type IN ('city', 'county')
`).all() as (Record<string, number | null> & { ori: string; year: number })[];

const byOri = new Map<string, Map<number, Record<string, number | null>>>();
for (const row of crimeRows) {
  if (!byOri.has(row.ori)) byOri.set(row.ori, new Map());
  byOri.get(row.ori)!.set(row.year, row);
}

// RTCI 12-month totals keyed AGENCY|STATE|year -> offense -> count. The historical
// agency's RTCI name goes through the consolidation registry, exactly as the
// scorecard's lookup does.
const rtciRows = db.prepare(`
  SELECT a.agency AS agency, upper(a.state) AS state, a.type AS rtciType, am.year AS year, am.offense AS offense,
         SUM(am.count) AS n, COUNT(DISTINCT am.month) AS months
  FROM agency_monthly am
  JOIN agencies a ON a.ori = am.ori
  WHERE a.type IN ('City', 'County')
  GROUP BY a.agency, upper(a.state), a.type, am.year, am.offense
  HAVING months = 12
`).all() as { agency: string; state: string; rtciType: string; year: number; offense: string; n: number }[];

const rtciByKey = new Map<string, Map<string, number>>();
for (const row of rtciRows) {
  const key = `${row.agency}|${row.state}|${row.rtciType}|${row.year}`;
  if (!rtciByKey.has(key)) rtciByKey.set(key, new Map());
  rtciByKey.get(key)!.set(row.offense, row.n);
}

const datasetMax = (db.prepare("SELECT MAX(year) AS y FROM historical_agency_crime").get() as { y: number }).y;
console.log(`[reliability] ${agencies.length} city+county agencies, ${crimeRows.length} agency-year rows, RTCI keys ${rtciByKey.size}, data max ${datasetMax}`);

// ---- Sweep -------------------------------------------------------------------------

type StagedRow = {
  ori: string; year: number; kind: string; source: string;
  columns_json: string; evidence_json: string;
};
const staged: StagedRow[] = [];

for (const agency of agencies) {
  const years = byOri.get(agency.ori);
  if (!years) continue;
  const rtciAgency = consolidatedRtciAgency(agency.state.toUpperCase(), agency.agency);
  const stateUpper = agency.state.toUpperCase();

  for (const [year, row] of years) {
    // Own history: the shared evaluator applies its own per-offence gates.
    const priors: Record<string, number | null>[] = [];
    for (let y = year - HISTORY_LOOKBACK_YEARS; y <= year - 1; y++) {
      const prior = years.get(y);
      if (prior) priors.push(prior);
    }
    const findings: ReliabilityFinding[] = evaluateOwnHistory(row, priors);

    // RTCI cross-check where a full 12-month year exists for this agency.
    const rtciType = agency.type === "county" ? "County" : "City";
    const monthly = rtciByKey.get(`${rtciAgency}|${stateUpper}|${rtciType}|${year}`);
    if (monthly && monthly.size > 0) {
      const priorRatios: number[] = [];
      for (let y = year - MURDER_RATIO_LOOKBACK_YEARS; y <= year - 1; y++) {
        const annual = years.get(y)?.murder;
        const reported = rtciByKey.get(`${rtciAgency}|${stateUpper}|${rtciType}|${y}`)?.get("Murder");
        if (annual == null || reported == null || reported < RTCI_CROSSCHECK_MIN_COUNT) continue;
        priorRatios.push(annual / reported);
      }
      findings.push(...evaluateRtciCrosscheck(row, monthly, priorRatios));
    }

    for (const finding of findings) {
      staged.push({
        ori: agency.ori, year, kind: finding.kind, source: finding.source,
        columns_json: JSON.stringify(finding.columns),
        evidence_json: JSON.stringify(finding.evidence.map((e) => ({
          column: e.column, current: e.current, reference: Math.round(e.reference * 100) / 100,
          ratio: Math.round(e.ratio * 1000) / 1000,
        }))),
      });
    }
  }
}

// ---- Validation gates ----------------------------------------------------------------

const distinct = (rows: StagedRow[]) => new Set(rows.map((r) => `${r.ori}|${r.year}`)).size;
const ownRecent = staged.filter((r) => r.source === "own-history" && r.year >= datasetMax - 1 && oriType.get(r.ori) === "city");
const countyRecent = staged.filter((r) => r.year >= datasetMax - 1 && oriType.get(r.ori) === "county");
const rtci = staged.filter((r) => r.source === "rtci-crosscheck");
const recentAll = staged.filter((r) => r.year >= datasetMax - 1);

console.log(`\n[reliability] finding rows staged: ${staged.length}`);
console.log(`[reliability] own-history distinct city agency-years, ${datasetMax - 1}-${datasetMax}: ${distinct(ownRecent)} (acceptance: ${ACCEPTANCE_OWN_HISTORY_RECENT})`);
console.log(`[reliability] rtci-crosscheck distinct agency-years, all years: ${distinct(rtci)}`);
console.log(`[reliability] COUNTY distinct agency-years, ${datasetMax - 1}-${datasetMax}: ${distinct(countyRecent)} (reported separately; the 878 gate is city-only)`);
console.log(`[reliability] combined distinct agency-years, ${datasetMax - 1}-${datasetMax}: ${distinct(recentAll)}`);

console.log("\n[reliability] findings by decade (distinct agency-years):");
const byDecade = new Map<number, Set<string>>();
for (const r of staged) {
  const decade = Math.floor(r.year / 10) * 10;
  if (!byDecade.has(decade)) byDecade.set(decade, new Set());
  byDecade.get(decade)!.add(`${r.ori}|${r.year}`);
}
for (const [decade, set] of [...byDecade.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${decade}s: ${set.size}`);
}

if (staged.length === 0) {
  console.error("[reliability] REFUSING: zero findings staged -- that means a broken sweep, not clean data.");
  process.exit(1);
}
if (distinct(ownRecent) !== ACCEPTANCE_OWN_HISTORY_RECENT) {
  console.error(`[reliability] ACCEPTANCE FAILED: own-history recent count ${distinct(ownRecent)} != ${ACCEPTANCE_OWN_HISTORY_RECENT}.`);
  console.error("[reliability] If the underlying data legitimately changed, re-verify the new count independently and update ACCEPTANCE_OWN_HISTORY_RECENT.");
  process.exit(1);
}

if (dryRun) {
  console.log("\n[reliability] dry run: table untouched.");
  db.close();
  process.exit(0);
}

// ---- Atomic swap -----------------------------------------------------------------------

db.exec("DROP TABLE IF EXISTS agency_year_reliability_staging");
db.exec(`
  CREATE TABLE agency_year_reliability_staging (
    ori TEXT NOT NULL,
    year INTEGER NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    columns_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    PRIMARY KEY (ori, year, kind, source)
  )
`);
const generatedAt = new Date().toISOString();
const insert = db.prepare(`
  INSERT OR REPLACE INTO agency_year_reliability_staging
  (ori, year, kind, source, columns_json, evidence_json, algorithm_version, generated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertAll = db.transaction((rows: StagedRow[]) => {
  for (const r of rows) insert.run(r.ori, r.year, r.kind, r.source, r.columns_json, r.evidence_json, RELIABILITY_ALGORITHM_VERSION, generatedAt);
});
insertAll(staged);

const stagedCount = (db.prepare("SELECT COUNT(*) AS n FROM agency_year_reliability_staging").get() as { n: number }).n;
if (stagedCount === 0) {
  console.error("[reliability] REFUSING swap: staging table is empty after insert.");
  process.exit(1);
}

const swap = db.transaction(() => {
  db.exec("DROP TABLE IF EXISTS agency_year_reliability");
  db.exec("ALTER TABLE agency_year_reliability_staging RENAME TO agency_year_reliability");
  db.exec("CREATE INDEX IF NOT EXISTS idx_agency_year_reliability_ori ON agency_year_reliability (ori, year)");
});
swap();

console.log(`\n[reliability] swapped in ${stagedCount} rows as agency_year_reliability (generated_at ${generatedAt}).`);
console.log(`[reliability] offense column universe: ${RELIABILITY_OFFENSES.map((o) => o.column).join(", ")}`);
db.close();
