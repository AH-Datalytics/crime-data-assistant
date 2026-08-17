/**
 * County identity must resolve the same way against the database we run today and the one
 * the rebuild produces.
 *
 * The rebuilt tables keep the names `geographies.csv` states, so every predicate of the form
 * `ha.agency = 'Cook County'` stops matching. Resolution now goes county -> ORI through
 * `agency_county_crosswalk`, which the rebuild does not touch, so the same question reaches
 * the same agency on both. That is the property under test: not "the new database works", but
 * "both do, identically", because the application has to be safe to deploy before the data
 * changes and after.
 *
 * Point REBUILT_DB at a rebuilt database carrying agency_county_crosswalk to exercise the
 * second half; without it the current-database assertions still run.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { CONSOLIDATED_AGENCIES } from "../lib/agency-consolidations";
import {
  countyKeyFromDisplayName,
  historicalCountyAgencyPredicate,
  historicalCountywidePredicate,
  historicalCountyLabel,
  resolveHistoricalCountyAgency,
} from "../lib/historical-county-identity";

let failures = 0;
let checks = 0;

function assert(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  FAIL  ${message}`);
  }
}

function openReadonly(file: string | undefined): Database.Database | null {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return new Database(file, { readonly: true });
  } catch {
    return null;
  }
}

const CURRENT_DB = process.env.RTCI_DB_PATH
  || path.join(process.cwd(), "crime_data.db");
const REBUILT_DB = process.env.HISTORICAL_REBUILD_DB_PATH;

// ── the key itself ──────────────────────────────────────────────────────────────────
console.log("county key normalization");
assert(countyKeyFromDisplayName("Cook County") === "COOK", "Cook County -> COOK");
assert(countyKeyFromDisplayName("Jefferson Parish") === "JEFFERSON", "Jefferson Parish -> JEFFERSON");
// The old helper left the full stop in and produced ST. LOUIS, which matched nothing.
assert(countyKeyFromDisplayName("St. Louis County") === "ST LOUIS", "St. Louis County -> ST LOUIS");
assert(countyKeyFromDisplayName("Saint Louis County") === "ST LOUIS", "Saint Louis County -> ST LOUIS");
assert(countyKeyFromDisplayName("Duval") === "DUVAL", "a bare county name is already a key");
assert(countyKeyFromDisplayName("Anchorage Municipality") === "ANCHORAGE", "municipality is dropped");

type Expectation = {
  label: string;
  state: string;
  county: string;
  /** The ORI the question must reach, on both databases. */
  ori: string;
  /** A city sharing the name that must never be selected. */
  notOri?: string;
  /**
   * Set where the current database cannot resolve the county and the rebuilt one can, with
   * the reason. Asserted rather than skipped: a difference between the two databases is
   * exactly what a transition has to know about.
   */
  currentlyAmbiguous?: { oris: string[]; because: string };
};

// Every case the handoff names, plus the traps around them.
const EXPECTATIONS: Expectation[] = [
  { label: "Cook County, IL", state: "IL", county: "Cook County", ori: "IL0160000" },
  { label: "Maricopa County, AZ", state: "AZ", county: "Maricopa County", ori: "AZ0070000", notOri: "AZ0111700" },
  { label: "Orleans Parish, LA", state: "LA", county: "Orleans Parish", ori: "LA0360000" },
  { label: "Jefferson Parish, LA", state: "LA", county: "Jefferson Parish", ori: "LA0260000" },
  // The importer called this "Jacksonville County". Florida has no such county; the agency is
  // the Jacksonville Sheriff's Office and the county is Duval.
  { label: "Duval County, FL", state: "FL", county: "Duval County", ori: "FL0160000", notOri: "FL0160200" },
  // Its own name is descriptive, so asking for the county still has to reach it.
  { label: "Riley County, KS", state: "KS", county: "Riley County", ori: "KS0810000" },
  { label: "Bibb County, GA", state: "GA", county: "Bibb County", ori: "GA0110000", notOri: "GA1060300" },
  {
    label: "St. Louis County, MO",
    state: "MO",
    county: "St. Louis County",
    ori: "MO0950000",
    notOri: "MOSPD0000",
    currentlyAmbiguous: {
      oris: ["MO0950000", "MO0956800"],
      because: "the current database types MO0956800 'St. Louis' as a county; it is the city, "
        + "and the rebuilt directory types it city",
    },
  },
];

// Counties served by both a sheriff's office and a county police department. Today both carry
// the same rewritten name and `LIMIT 1` picks one; the resolver must report the choice instead.
const AMBIGUOUS: { label: string; state: string; county: string; oris: string[] }[] = [
  { label: "Chatham County, GA", state: "GA", county: "Chatham County", oris: ["GA0250000", "GA0250100"] },
  { label: "Baltimore County, MD", state: "MD", county: "Baltimore County", oris: ["MD0030000", "MD0030100"] },
];

function exercise(db: Database.Database, side: string): void {
  console.log(`\nresolution against the ${side} database`);

  for (const expectation of EXPECTATIONS) {
    const known = side === "current" ? expectation.currentlyAmbiguous : undefined;
    const resolved = resolveHistoricalCountyAgency(db, expectation.state, expectation.county);
    const rows = db.prepare(`
      SELECT ha.ori AS ori FROM historical_agency ha
      WHERE ${historicalCountyAgencyPredicate(expectation.state, expectation.county)}
    `).all() as { ori: string }[];

    if (known) {
      // Reported, not guessed. The resolver must surface the collision the current database
      // carries rather than pick the county agency and look correct by luck.
      assert(
        resolved.status === "ambiguous",
        `${side}: ${expectation.label} is reported ambiguous because ${known.because} (got ${resolved.status})`
      );
      const got = rows.map((row) => row.ori).sort();
      assert(
        JSON.stringify(got) === JSON.stringify([...known.oris].sort()),
        `${side}: ${expectation.label} names exactly the colliding ORIs (got ${got.join(", ")})`
      );
      assert(
        got.includes(expectation.ori),
        `${side}: ${expectation.label} still includes the real county agency ${expectation.ori}`
      );
    } else {
      assert(
        resolved.status === "resolved" && resolved.agency.ori === expectation.ori,
        `${side}: ${expectation.label} resolves to ${expectation.ori} ` +
          `(got ${resolved.status === "resolved" ? resolved.agency.ori : resolved.status})`
      );
      // The generated SQL, not just the lookup: this is what actually reaches the database.
      assert(
        rows.length === 1 && rows[0].ori === expectation.ori,
        `${side}: the county-agency predicate for ${expectation.label} selects exactly ${expectation.ori} ` +
          `(got ${rows.map((r) => r.ori).join(", ") || "nothing"})`
      );
    }

    if (expectation.notOri) {
      assert(
        !rows.some((row) => row.ori === expectation.notOri),
        `${side}: ${expectation.label} must not select the same-named city ${expectation.notOri}`
      );
    }
  }

  for (const entry of AMBIGUOUS) {
    const resolved = resolveHistoricalCountyAgency(db, entry.state, entry.county);
    assert(
      resolved.status === "ambiguous" && resolved.agencies.length === entry.oris.length,
      `${side}: ${entry.label} is reported as ambiguous rather than silently picked ` +
        `(got ${resolved.status})`
    );
    if (resolved.status === "ambiguous") {
      const got = resolved.agencies.map((a) => a.ori).sort();
      assert(
        JSON.stringify(got) === JSON.stringify([...entry.oris].sort()),
        `${side}: ${entry.label} names both agencies (got ${got.join(", ")})`
      );
    }
  }

  // Scope: the county's own agency is one agency; the countywide total is many. Turning one
  // into the other silently is the failure the county-scope clarifier exists to prevent.
  for (const entry of [{ state: "IL", county: "Cook County" }, { state: "LA", county: "Orleans Parish" }]) {
    const single = db.prepare(
      `SELECT COUNT(*) AS n FROM historical_agency ha WHERE ${historicalCountyAgencyPredicate(entry.state, entry.county)}`
    ).get() as { n: number };
    const wide = db.prepare(
      `SELECT COUNT(*) AS n FROM historical_agency ha WHERE ${historicalCountywidePredicate(entry.state, entry.county)}`
    ).get() as { n: number };
    assert(single.n >= 1, `${side}: ${entry.county} has a county agency`);
    assert(wide.n > single.n, `${side}: ${entry.county} countywide covers more agencies than the county agency alone (${wide.n} vs ${single.n})`);
  }

  // The label the user reads must not follow the database's spelling.
  const cook = resolveHistoricalCountyAgency(db, "IL", "Cook County");
  if (cook.status === "resolved") {
    assert(historicalCountyLabel(cook.agency) === "Cook County", `${side}: Cook is labelled "Cook County"`);
  }
  const orleans = resolveHistoricalCountyAgency(db, "LA", "Orleans Parish");
  if (orleans.status === "resolved") {
    assert(historicalCountyLabel(orleans.agency) === "Orleans Parish", `${side}: Louisiana reads Parish`);
  }
  const duval = resolveHistoricalCountyAgency(db, "FL", "Duval County");
  if (duval.status === "resolved") {
    // Its own name says which agency this is; the county label would hide it.
    assert(
      historicalCountyLabel(duval.agency) === duval.agency.agency,
      `${side}: an agency with a descriptive name keeps it (${historicalCountyLabel(duval.agency)})`
    );
  }

  // Consolidation entries must resolve by ORI, with their stored name descriptive only.
  // Six of the fifteen carry a county-style `historicalAgency` -- "Bibb County",
  // "Butte-Silver Bow County", "Riley County" -- which the rebuilt directory does not spell
  // that way. If any code path ever used that string as a predicate it would break; the ORI
  // is the same in both databases, so this is what every path must key on.
  for (const entry of CONSOLIDATED_AGENCIES) {
    const byOri = db.prepare(
      "SELECT ori, agency FROM historical_agency WHERE ori = ?"
    ).all(entry.historicalOri) as { ori: string; agency: string }[];
    assert(
      byOri.length === 1,
      `${side}: consolidation ${entry.alias} resolves by ORI ${entry.historicalOri} (got ${byOri.length} rows)`
    );
  }
  // And name it: on the rebuilt database the stored name genuinely differs, which is the
  // whole reason the ORI has to be authoritative.
  const countyStyle = CONSOLIDATED_AGENCIES.filter((entry) => entry.historicalType === "county");
  assert(countyStyle.length >= 6, `${side}: the county-typed consolidation entries are present`);
  const nameMismatches = countyStyle.filter((entry) => {
    const row = db.prepare("SELECT agency FROM historical_agency WHERE ori = ?").get(entry.historicalOri) as
      | { agency: string }
      | undefined;
    return !row || row.agency !== entry.historicalAgency;
  });
  if (side === "rebuilt") {
    assert(
      nameMismatches.length > 0,
      "rebuilt: at least one consolidation's stored name differs from the database, proving " +
        "the name cannot be the predicate"
    );
  }

  // A real query shape, end to end.
  const murders = db.prepare(`
    SELECT hac.year AS year, hac.murder AS murder
    FROM historical_agency_crime hac
    JOIN historical_agency ha ON ha.ori = hac.ori
    WHERE ${historicalCountyAgencyPredicate("IL", "Cook County")} AND hac.year = 2020
  `).all() as { year: number; murder: number | null }[];
  assert(murders.length === 1, `${side}: a Cook County count query returns one row (got ${murders.length})`);
}

const current = openReadonly(CURRENT_DB);
if (current) {
  exercise(current, "current");
  current.close();
} else {
  console.log(`\n(skipped current database: ${CURRENT_DB} not readable)`);
}

const rebuilt = openReadonly(REBUILT_DB);
if (rebuilt) {
  exercise(rebuilt, "rebuilt");
  rebuilt.close();
} else {
  console.log("\n(skipped rebuilt database: set HISTORICAL_REBUILD_DB_PATH to exercise it)");
}

console.log(`\n${checks - failures}/${checks} county identity checks passed`);
if (failures > 0) {
  console.error(`${failures} county identity check(s) failed`);
  process.exit(1);
}
console.log("historical county identity tests passed");
