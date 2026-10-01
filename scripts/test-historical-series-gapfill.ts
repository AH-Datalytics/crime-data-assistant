#!/usr/bin/env npx tsx
/**
 * GC-048 — a Historical series that shows its gaps, and a zero that is never invented.
 *
 * THE REQUEST (frozen, v7): "show murders per capita for the city of St. Louis city and the City
 * of Chicago since 1950". Decision 4 requires interior missing years to be named as missing rather
 * than presented as zero.
 *
 * TWO CHANGES, ONE BATCH, because the first alone would leave a known false-zero path open:
 *
 *   1. `historical-missing-gap-fill`'s message. It told the model to fill the gaps and showed a
 *      skeleton with ellipses; the retry filled them with correlated scalar subqueries, which the
 *      lineage analyzer cannot trace, and the request died on
 *      `structural-returned-series-unresolved`. The message now carries the one constraint that
 *      rule enforces. It also stops asserting "for a single agency" about a two-agency query.
 *   2. The finished-rate zero fill. `COALESCE(ROUND(<rate>, 1), 0)` passed both existing
 *      detectors, which only recognize a bare measure column, and turns a year nobody reported
 *      into a rate of zero.
 *
 * THE RULES ARE NOT IN CONFLICT, and this suite is where that is kept true: the shape the message
 * prescribes fires no guardrail, enforces no contract rule, parses, and returns both agencies with
 * their own rates, a genuine recorded zero kept as zero, and every missing value NULL.
 *
 * EVIDENCE BOUNDARY. The two saved statements come from the retained capture. The recursive
 * recipe and the unsafe counterparts are written here and labelled as such — none is a model
 * output. The fixture is built from the repository's own Historical DDL with the reviewer's
 * values: two agencies at different rates, a year neither reported, a year one reported without a
 * population, and a genuine recorded zero. The guard below denies file-backed SQLite and the
 * network before any product module loads.
 */

import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";

import { readFileSync } from "fs";

import { runGuardrails } from "../lib/guardrails";
import { validateQueryContractSql, queryContractFailureMessage } from "../lib/query-contract-validator";
import { analyzeSql } from "../lib/sql-lineage";
import { applyResultDisclosures } from "../lib/result-disclosure";
import {
  BARE_MEASURE_ZERO_FILL,
  zeroFillsFinishedRate,
} from "../lib/historical-rate-zero-fill";

let checks = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  PASS  ${name}${detail ? "   " + detail : ""}`);
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? "   " + detail : ""}`); }
}

const QUESTION = "show murders per capita for the city of St. Louis city and the City of Chicago since 1950";

/* ── the two retained statements ─────────────────────────────────────────────────────── */
const CAPTURE = JSON.parse(readFileSync(
  "scripts/fixtures/retained-evidence/qualification-retained-cases.json", "utf8" /* retained input packaged 2026-09-30; source digest and extraction rule in scripts/fixtures/retained-evidence/MANIFEST.json */)) as {
    cases: Array<{ case: string; scored: { observed: { modelOutputs?: Array<{ text: string }> } } }>;
  };
function savedSql(index: number): string {
  const raw = (CAPTURE.cases.find((c) => c.case === "GC-048")!.scored.observed.modelOutputs ?? [])[index].text;
  return (JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")) as { sql: string }).sql;
}
const SAVED_PLAIN = savedSql(0);
const SAVED_CORRELATED = savedSql(1);

/* ── the supported recipe, written here and labelled ─────────────────────────────────── */
const SUPPORTED_RECIPE = `
WITH RECURSIVE years AS (
  SELECT 1950 AS year
  UNION ALL
  SELECT year + 1 FROM years WHERE year < 2025
)
SELECT y.year AS year,
  ROUND(SUM(CASE WHEN ha.ori = 'MOSPD0000' THEN hac.murder END) * 100000.0
        / NULLIF(MAX(CASE WHEN ha.ori = 'MOSPD0000' THEN hap.population END), 0), 1) AS st_louis,
  ROUND(SUM(CASE WHEN ha.ori = 'ILCPD0000' THEN hac.murder END) * 100000.0
        / NULLIF(MAX(CASE WHEN ha.ori = 'ILCPD0000' THEN hap.population END), 0), 1) AS chicago
FROM years y
LEFT JOIN historical_agency_crime hac ON hac.year = y.year AND hac.ori IN ('MOSPD0000','ILCPD0000')
LEFT JOIN historical_agency ha ON ha.ori = hac.ori
LEFT JOIN historical_agency_population hap ON hap.ori = hac.ori AND hap.year = hac.year
GROUP BY y.year
ORDER BY y.year
LIMIT 1000`.trim();

/** UNSAFE A: the bare-column zero fill the existing detectors were written for. */
const UNSAFE_BARE_COLUMN = SUPPORTED_RECIPE.replace(/THEN hac\.murder END/g, "THEN COALESCE(hac.murder, 0) END");

/** UNSAFE B: the same lie one level up — the finished rate itself is zero-filled. */
const UNSAFE_FINISHED_RATE = SUPPORTED_RECIPE
  .replace(/ROUND\(SUM\(CASE WHEN ha\.ori = 'MOSPD0000'[\s\S]*?, 1\) AS st_louis/,
    "COALESCE(ROUND(SUM(CASE WHEN ha.ori = 'MOSPD0000' THEN hac.murder END) * 100000.0"
    + " / NULLIF(MAX(CASE WHEN ha.ori = 'MOSPD0000' THEN hap.population END), 0), 1), 0) AS st_louis")
  .replace(/ROUND\(SUM\(CASE WHEN ha\.ori = 'ILCPD0000'[\s\S]*?, 1\) AS chicago/,
    "COALESCE(ROUND(SUM(CASE WHEN ha.ori = 'ILCPD0000' THEN hac.murder END) * 100000.0"
    + " / NULLIF(MAX(CASE WHEN ha.ori = 'ILCPD0000' THEN hap.population END), 0), 1), 0) AS chicago");

/* ── the fixture, with the reviewer's values ─────────────────────────────────────────── */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3") as new (f: string) => {
  exec: (s: string) => void;
  prepare: (s: string) => { run: (...a: unknown[]) => void; all: () => Record<string, unknown>[] };
};
const ddl = readFileSync("scripts/fixtures/operation-taxonomy/crime_data.ddl.sql", "utf8");
const table = (name: string) => {
  const from = ddl.slice(ddl.indexOf(`CREATE TABLE ${name} `));
  return from.slice(0, from.indexOf(";") + 1);
};
const db = new Database(":memory:");
for (const name of ["historical_agency", "historical_agency_crime", "historical_agency_population"]) {
  db.exec(table(name));
}
for (const [ori, agency, state] of [
  ["MOSPD0000", "St. Louis", "mo"], ["ILCPD0000", "Chicago", "il"], ["TXHPD0000", "Houston", "tx"],
] as Array<[string, string, string]>) {
  db.prepare("INSERT INTO historical_agency (ori, agency, state, type) VALUES (?,?,?,?)").run(ori, agency, state, "city");
}
const MISSING_FOR_ALL = 1972;      // nobody reported, including the spine agency
const CHICAGO_MISSING = 1971;      // Chicago reported no crime
const CHICAGO_NO_POP = 1973;       // Chicago reported crime with no population
const STL_TRUE_ZERO = 1974;        // St. Louis genuinely recorded zero murders
{
  const crime = db.prepare("INSERT INTO historical_agency_crime (ori, year, population, murder) VALUES (?,?,?,?)");
  const pop = db.prepare("INSERT INTO historical_agency_population (ori, year, population) VALUES (?,?,?)");
  for (let year = 1970; year <= 1974; year++) {
    if (year !== MISSING_FOR_ALL) crime.run("TXHPD0000", year, 1_000_000, 100);
    pop.run("TXHPD0000", year, 1_000_000);
    if (year !== MISSING_FOR_ALL) {
      crime.run("MOSPD0000", year, 600_000, year === STL_TRUE_ZERO ? 0 : 60);   // rate 10, or a true zero
      pop.run("MOSPD0000", year, 600_000);
    }
    if (year !== MISSING_FOR_ALL && year !== CHICAGO_MISSING) {
      crime.run("ILCPD0000", year, 3_000_000, 900);                             // rate 30
      if (year !== CHICAGO_NO_POP) pop.run("ILCPD0000", year, 3_000_000);
    }
  }
}

const inWindow = (rows: Record<string, unknown>[]) =>
  rows.filter((r) => Number(r.year) >= 1970 && Number(r.year) <= 1974);
function run(sql: string) {
  const guard = runGuardrails({ question: QUESTION, sql, tab: "historical" } as never) as unknown as { fired?: string[] };
  const contract = validateQueryContractSql({ question: QUESTION, source: "historical", sql });
  let parsed = false;
  try { parsed = Boolean((analyzeSql(sql) as { parsed?: boolean }).parsed); } catch { parsed = false; }
  let rows: Record<string, unknown>[] | null = null;
  try { rows = inWindow(db.prepare(sql).all()); } catch { rows = null; }
  return { fired: guard.fired ?? [], contract, parsed, rows };
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 0 — ISOLATION
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 0  the guard ===");
{
  let denied = false;
  try { new (require("better-sqlite3") as new (f: string) => unknown)("crime_data.db"); } catch { denied = true; }
  check("a file-backed database open is refused in this process", denied);
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 1 — THE TWO SAVED STATEMENTS KEEP THEIR RULINGS
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 1  the retained statements ===");
{
  const plain = run(SAVED_PLAIN);
  check("saved 1 still fires the gap-fill guard", plain.fired.includes("historical-missing-gap-fill"),
    JSON.stringify(plain.fired));
  check("  and it really does drop the year nobody reported",
    Boolean(plain.rows) && !plain.rows!.some((r) => Number(r.year) === MISSING_FOR_ALL),
    JSON.stringify(plain.rows?.map((r) => r.year)));

  const correlated = run(SAVED_CORRELATED);
  check("saved 2 keeps its structural rejection",
    correlated.contract.enforced.includes("structural-returned-series-unresolved"),
    JSON.stringify(correlated.contract.enforced));
  check("  because its returned columns cannot be traced, not because it recurses", !correlated.parsed);
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 2 — THE SUPPORTED RECIPE PASSES BOTH RULES AND ANSWERS
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 2  the shape the message now prescribes ===");
{
  const r = run(SUPPORTED_RECIPE);
  check("no guardrail fires", r.fired.length === 0, JSON.stringify(r.fired));
  check("the contract enforces nothing", r.contract.enforced.length === 0
    && queryContractFailureMessage(r.contract) === null, JSON.stringify(r.contract.enforced));
  check("the lineage analyzer traces it — recursion is not the blocker", r.parsed);
  const by = (year: number) => r.rows?.find((x) => Number(x.year) === year);
  check("both agencies keep their own rate", by(1970)?.st_louis === 10 && by(1970)?.chicago === 30,
    JSON.stringify(by(1970)));
  check("a year nobody reported is present and NULL for both",
    by(MISSING_FOR_ALL) !== undefined
    && by(MISSING_FOR_ALL)!.st_louis === null && by(MISSING_FOR_ALL)!.chicago === null);
  check("a year one agency missed is NULL for that agency only",
    by(CHICAGO_MISSING)?.st_louis === 10 && by(CHICAGO_MISSING)?.chicago === null);
  check("a missing population denominator stays NULL rather than becoming a rate",
    by(CHICAGO_NO_POP)?.chicago === null && by(CHICAGO_NO_POP)?.st_louis === 10);
  check("a genuine recorded zero stays zero", by(STL_TRUE_ZERO)?.st_louis === 0,
    JSON.stringify(by(STL_TRUE_ZERO)));
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 3 — THE MESSAGE ITSELF
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 3  what the retry is now told ===");
{
  // The retry instruction the route would actually send, read out of the guardrail result rather
  // than out of the source: this is the string the model receives.
  const result = runGuardrails({ question: QUESTION, sql: SAVED_PLAIN, tab: "historical" } as never) as unknown as
    { fired: string[]; issues: string[] };
  check("the gap-fill guardrail is what produced this instruction",
    result.fired.includes("historical-missing-gap-fill"), JSON.stringify(result.fired));
  const message = result.issues.join("\n\n");
  check("it no longer asserts the query is for a single agency", !/single agency/i.test(message));
  check("it prescribes the recursive year spine", /RECURSIVE|UNION ALL\s+SELECT\s+year\s*\+\s*1/i.test(message));
  check("it prescribes the LEFT JOIN and the grouped conditional aggregate",
    /LEFT JOIN/i.test(message) && /SUM\(CASE WHEN/i.test(message) && /GROUP BY/i.test(message));
  check("it says the returned measures must be traceable to the joined tables",
    /traceab|trace each|from the joined/i.test(message));
  check("it warns off the correlated scalar subquery that failed", /correlated|subquer/i.test(message));
  check("it does not bake the request's own years into reusable guidance",
    !/\b1950\b/.test(message) && !/\b2025\b/.test(message));
  check("it still says missing values stay NULL rather than zero",
    /NULL/i.test(message) && /zero|0\b/i.test(message));
  check("it does not claim this is the only valid SQL",
    /one supported|a supported|for example|such as/i.test(message));
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 4 — THE ZERO THAT MUST NEVER BE INVENTED
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 4  zero fill, at the column and at the finished rate ===");
{
  const bare = run(UNSAFE_BARE_COLUMN);
  check("UNSAFE A: the existing bare-column detector still fires",
    bare.fired.includes("historical-rate-zero-fill"), JSON.stringify(bare.fired));
  check("  and the contract still enforces it",
    bare.contract.enforced.includes("historical-rate-null-gaps"), JSON.stringify(bare.contract.enforced));

  const finished = run(UNSAFE_FINISHED_RATE);
  check("UNSAFE B: the finished-rate zero fill is now caught by the guardrail",
    finished.fired.includes("historical-rate-zero-fill"), JSON.stringify(finished.fired));
  check("  and by the contract, so a retry cannot bring it back",
    finished.contract.enforced.includes("historical-rate-null-gaps")
    && queryContractFailureMessage(finished.contract) !== null,
    JSON.stringify(finished.contract.enforced));
  check("  it is the shape that actually fabricates a zero",
    Boolean(finished.rows)
    && finished.rows!.find((r) => Number(r.year) === CHICAGO_MISSING)?.chicago === 0
    && finished.rows!.find((r) => Number(r.year) === MISSING_FOR_ALL)?.chicago === 0,
    JSON.stringify(finished.rows?.slice(0, 3)));

  check("the detector reads the finished rate directly", zeroFillsFinishedRate(UNSAFE_FINISHED_RATE));
  check("  and the IFNULL spelling of the same thing",
    zeroFillsFinishedRate(UNSAFE_FINISHED_RATE.replace(/COALESCE/g, "IFNULL")));
  check("  the bare-column pattern is unchanged and still its own control",
    BARE_MEASURE_ZERO_FILL.test("COALESCE(hac.murder, 0)") && !BARE_MEASURE_ZERO_FILL.test(UNSAFE_FINISHED_RATE));

  console.log("\n  and what it must not catch:");
  check("the supported recipe is not a zero fill", !zeroFillsFinishedRate(SUPPORTED_RECIPE));
  check("NULLIF on the denominator is not a zero fill",
    !zeroFillsFinishedRate("SELECT SUM(murder) * 100000.0 / NULLIF(SUM(population), 0) FROM historical_agency_crime"));
  check("coalescing a COUNT in a question that is not a rate is untouched",
    !zeroFillsFinishedRate("SELECT COALESCE(SUM(hac.murder), 0) AS murders FROM historical_agency_crime hac"));
  check("a rate question that coalesces a non-rate column is untouched",
    !zeroFillsFinishedRate("SELECT ROUND(SUM(murder) * 100000.0 / SUM(population), 1) AS rate, COALESCE(agency, 'unknown') AS who FROM historical_agency_crime"));
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 5 — RETRY, REPEAT, AND THE SUPPORTED ANSWER THROUGH DELIVERY
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 5  the enforcement boundary, and the answer that gets through ===");
{
  // A controlled model reply carrying the bad statement, then the SAME bad statement again.
  const first = validateQueryContractSql({ question: QUESTION, source: "historical", sql: UNSAFE_FINISHED_RATE });
  const repeated = validateQueryContractSql({ question: QUESTION, source: "historical", sql: UNSAFE_FINISHED_RATE });
  check("the first bad reply produces a retry issue", first.retryIssues.length > 0);
  check("the repeated bad reply is refused rather than delivered",
    queryContractFailureMessage(repeated) !== null
    && /couldn't build a reliable query/i.test(queryContractFailureMessage(repeated)!));

  // The corrected reply reaches delivery with its columns, values and gaps intact.
  const corrected = run(SUPPORTED_RECIPE);
  check("the corrected reply has nothing left to enforce",
    queryContractFailureMessage(corrected.contract) === null);
  const delivered = applyResultDisclosures({
    explanation: "Murders per 100,000 residents for St. Louis and Chicago, by year. Years with no reported data are left blank.",
    question: QUESTION, sql: SUPPORTED_RECIPE, rows: corrected.rows ?? [], tab: "historical",
  });
  check("it is delivered as an answer, not the second-failure template",
    !/couldn't build a reliable query/i.test(delivered) && delivered.length > 0, delivered.slice(0, 58));
  check("both agency columns survive delivery",
    Object.keys(corrected.rows?.[0] ?? {}).includes("st_louis")
    && Object.keys(corrected.rows?.[0] ?? {}).includes("chicago"));
  check("and the gaps survive it too",
    corrected.rows!.find((r) => Number(r.year) === MISSING_FOR_ALL)?.st_louis === null);
}

/* ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("");
console.log(`  isolation: ${deniedDatabaseOpens().length} file-backed database opens denied, `
  + `${deniedNetworkCalls().length} network calls denied`);
console.log(failures.length === 0
  ? `ALL CHECKS PASSED  (${checks})`
  : `FAILURES: ${failures.length} of ${checks} -> ${failures.join(" | ")}`);
process.exit(failures.length === 0 ? 0 : 1);
