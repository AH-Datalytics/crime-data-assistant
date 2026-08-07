/**
 * Guards the consolidated-agency registry against the two ways it can silently rot:
 *
 *  1. A registry row names an agency that does not exist in the data (a typo, or the
 *     FBI renaming an ORI), which would turn a working city into "no data".
 *  2. A registry row points at an agency that has itself stopped reporting, which is
 *     the original Louisville bug reappearing one level up.
 *
 * It also pins the display convention -- every tab shows the short alias -- and pins
 * the excluded cases so a future sweep cannot quietly wire in an unverified guess.
 */
import Database from "better-sqlite3";
import {
  CONSOLIDATED_AGENCIES, CONSOLIDATION_EXCLUSIONS,
  findConsolidatedAgency, consolidatedDisplayName, historicalAgencyTarget,
  consolidatedDisplayValue, normalizeConsolidatedDisplayRows,
  consolidationTargetSatisfied,
} from "../lib/agency-consolidations";
import { buildAgencyScorecard } from "../lib/agency-scorecard";

const DB_PATH = process.env.RTCI_DB_PATH || "crime_data.db";
const db = new Database(DB_PATH, { readonly: true });

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) return;
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
}

const maxYear = (db.prepare("SELECT MAX(year) AS year FROM historical_agency_crime").get() as { year: number }).year;

const agencyProbe = db.prepare(`
  SELECT ha.ori,
    MAX(CASE WHEN hac.violent IS NOT NULL OR hac.property IS NOT NULL THEN hac.year END) AS lastReal
  FROM historical_agency ha
  JOIN historical_agency_crime hac ON hac.ori = ha.ori
  WHERE ha.state = ? AND ha.agency = ? AND ha.type = ?
  GROUP BY ha.ori ORDER BY lastReal DESC LIMIT 1
`);

for (const entry of CONSOLIDATED_AGENCIES) {
  const label = `${entry.alias}, ${entry.state}`;
  const hit = agencyProbe.get(entry.state.toLowerCase(), entry.historicalAgency, entry.historicalType) as
    | { ori: string; lastReal: number | null } | undefined;

  check(`${label}: successor "${entry.historicalAgency}" [${entry.historicalType}] exists`, Boolean(hit),
    "no historical_agency row matches that name and type");
  if (!hit) continue;

  // The whole point of the registry is to land on an agency that still reports.
  check(`${label}: successor still reporting`, (hit.lastReal ?? 0) >= maxYear - 1,
    `lastReal=${hit.lastReal} vs data max ${maxYear}`);

  // Every known spelling must map to the same entry, so no tab can disagree.
  for (const alt of [entry.alias, entry.historicalAgency, entry.predecessor].filter(Boolean) as string[]) {
    check(`${label}: "${alt}" maps to the same entry`,
      findConsolidatedAgency(entry.state, alt)?.alias === entry.alias);
    check(`${label}: "${alt}" displays as the alias`,
      consolidatedDisplayName(entry.state, alt) === entry.alias,
      `got "${consolidatedDisplayName(entry.state, alt)}"`);
  }

  const target = historicalAgencyTarget(entry.state, entry.alias);
  check(`${label}: SQL target is the successor`,
    target.agency === entry.historicalAgency && target.type === entry.historicalType && target.ori === entry.historicalOri);
  check(`${label}: verified ORI matches the named survivor`, hit.ori === entry.historicalOri,
    `registry ${entry.historicalOri}, data ${hit.ori}`);
  for (const sourceLabel of entry.sourceDisplayNames ?? []) {
    check(`${label}: source label "${sourceLabel}" displays as the alias`,
      consolidatedDisplayValue(entry.state, sourceLabel) === entry.alias);
  }

  // A predecessor, where one exists, must be genuinely dead -- otherwise the rewrite
  // is discarding a live agency's data.
  if (entry.predecessor && entry.predecessor !== entry.historicalAgency) {
    const pred = agencyProbe.get(entry.state.toLowerCase(), entry.predecessor, "city") as { lastReal: number | null } | undefined;
    if (pred) {
      check(`${label}: predecessor "${entry.predecessor}" is dead`, (pred.lastReal ?? 0) < maxYear - 2,
        `predecessor still reports through ${pred.lastReal}`);
      if (entry.predecessorLastYear != null) {
        check(`${label}: documented predecessorLastYear matches the data`,
          pred.lastReal === entry.predecessorLastYear,
          `documented ${entry.predecessorLastYear}, data says ${pred.lastReal}`);
      }
    }
  }
}

// Scorecards for the large consolidations must be current, not historical.
for (const alias of ["Louisville", "Las Vegas", "Charlotte", "Nashville"]) {
  const entry = CONSOLIDATED_AGENCIES.find((e) => e.alias === alias)!;
  const card = buildAgencyScorecard(db, `${alias}, ${entry.state} crime scorecard`);
  check(`${alias} scorecard is built`, Boolean(card) && (card?.rows.length ?? 0) === 9,
    card ? `rows=${card.rows.length}: ${card.explanation.slice(0, 90)}` : "no card");
  check(`${alias} scorecard year is recent`, (card?.year ?? 0) >= maxYear - 1,
    `year=${card?.year}`);
  check(`${alias} scorecard is labelled with the alias`,
    card?.agencyLabel === `${alias}, ${entry.state}`, `got "${card?.agencyLabel}"`);
}

// Louisville is the canonical regression: it must never answer from the 2003 ORI.
const louisville = buildAgencyScorecard(db, "Louisville, KY crime scorecard");
check("Louisville does not answer from the pre-merger 2003 ORI", louisville?.year !== 2003,
  `year=${louisville?.year}`);

// Santa Clara, CA is not a consolidation and must be untouched by the UT entry.
check("Santa Clara CA is not treated as consolidated", findConsolidatedAgency("CA", "Santa Clara") === undefined);
const scCa = buildAgencyScorecard(db, "Santa Clara, CA crime scorecard");
check("Santa Clara CA still builds a card", (scCa?.rows.length ?? 0) === 9, `rows=${scCa?.rows.length}`);

// Excluded cases must stay excluded until verified against an authoritative source.
check("Jacksonville FL is still excluded", findConsolidatedAgency("FL", "Jacksonville") === undefined);
check("exclusion list is intact", CONSOLIDATION_EXCLUSIONS.length === 2);

const displayRows = normalizeConsolidatedDisplayRows([
  { agency: "Bibb", state: "GA" },
  { canonical_agency: "Deer Lodge", state: "MT" },
  { city: "Santa Clara", state: "CA" },
]);
check("source display labels normalize by state", displayRows[0].agency === "Macon" && displayRows[1].canonical_agency === "Anaconda");
check("display normalization does not cross state boundaries", displayRows[2].city === "Santa Clara");

// ---------------------------------------------------------------------------------
// The successor guard: accept correct SQL, keep refusing the predecessor.
//
// Production regression -- the guard demanded the ORI literal, so
// `ha.agency = 'Louisville Metro' AND ha.state = 'ky'` (correct, joins to KY0568000)
// was refused with "I couldn't safely resolve Louisville, KY".
// ---------------------------------------------------------------------------------
{
  const lou = findConsolidatedAgency("KY", "Louisville")!;
  const macon = findConsolidatedAgency("GA", "Macon")!;

  check("successor selected by ORI literal is accepted",
    consolidationTargetSatisfied("SELECT 1 FROM historical_agency ha WHERE ha.ori = 'KY0568000'", lou));
  check("successor selected by name + state is accepted",
    consolidationTargetSatisfied(
      "SELECT hac.year, hac.murder FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori "
      + "WHERE ha.agency = 'Louisville Metro' AND ha.state = 'ky' AND ha.type = 'city'", lou));
  check("the dead predecessor name is still refused",
    !consolidationTargetSatisfied("SELECT 1 FROM historical_agency ha WHERE ha.agency = 'Louisville' AND ha.state = 'ky'", lou));
  check("successor name without a state predicate is refused",
    !consolidationTargetSatisfied("SELECT 1 FROM historical_agency ha WHERE ha.agency = 'Louisville Metro'", lou));
  // "Bibb County" is Macon's GA successor and also a real, unrelated AL agency.
  check("successor name in the wrong state is refused",
    !consolidationTargetSatisfied("SELECT 1 FROM historical_agency ha WHERE ha.agency = 'Bibb County' AND ha.state = 'al'", macon));
  check("successor name in the right state is accepted",
    consolidationTargetSatisfied("SELECT 1 FROM historical_agency ha WHERE ha.agency = 'Bibb County' AND ha.state = 'ga'", macon));
  check("an unrelated agency does not satisfy the target",
    !consolidationTargetSatisfied("SELECT 1 FROM historical_agency ha WHERE ha.agency = 'Tulsa' AND ha.state = 'ok'", lou));
}

db.close();
if (failures > 0) {
  console.error(`\n  test-agency-consolidations: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`  test-agency-consolidations: PASS (${CONSOLIDATED_AGENCIES.length} consolidations verified against data max year ${maxYear})`);
