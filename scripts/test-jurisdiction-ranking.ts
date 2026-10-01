/*
 * GC-057 — "What jurisdictions had the highest murder rates in 2024?" ranked as reporting
 * jurisdictions, not cities (Codex design ruling 2026-09-26).
 *
 * The saved run answered it pre-model through the owned Current city-ranking family, which added
 * `am.type = 'City'` because the entity noun mapped "jurisdictions" to the city level. These checks
 * hold the repair to the ruling:
 *   - the entity level is PRODUCED by the noun and carried to the builder; a request naming both
 *     levels declines instead of picking one;
 *   - Current jurisdiction rankings drop the type filter, return ORI and agency type, keep same-named
 *     agencies separate and distinctly labelled, and order a rate by its exact ratio;
 *   - existing eligibility, the rate's population > 0 and the stated 20-row limit are unchanged;
 *   - city rankings are byte-identical to before (pinned to the approved run's delivered SQL);
 *   - NIBRS jurisdiction rankings are an owned limitation (option B): declined at recognition, on the
 *     follow-up path too, and refused by the builder if constructed by hand.
 * Delivered answers through the real routes: audit/phase3-gc057-2026-09-26/delivery-witness.cjs.
 * Disposable in-memory fixture; every agency is SYNTHETIC.
 */
import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { recognizeCityRanking, type CityRankingRequest } from "../lib/city-ranking";
import { buildCityRanking } from "../lib/city-ranking-builder";
import { cityRankingFollowupUnavailable, planNibrsCityRanking } from "../lib/city-ranking-nibrs";
import { deterministicPlanRefusal } from "../lib/deterministic-plan-guard";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) console.log(`  PASS  ${message}`);
  else { failures += 1; console.log(`  FAIL  ${message}`); }
}

const GC057 = "What jurisdictions had the highest murder rates in 2024?";
const CUTOFF = { year: 2025, month: 12, observed: true };
const ranking = (q: string, source: "current" | "nibrs") => {
  const r = recognizeCityRanking(q, source);
  return r && r.kind === "ranking" ? r : null;
};

console.log("\n1 - the entity level is produced by the noun and carried");
{
  const j = ranking(GC057, "current");
  check(j?.entityLevel === "jurisdiction", "GC-057's \"jurisdictions\" produces the jurisdiction level");
  check(j?.origins.some((o) => o.field === "entityLevel" && o.from === "production" && o.detail === "jurisdiction") === true,
    "and the origin records it as produced, not defaulted");
  for (const q of ["What cities had the highest murder rates in 2024?", "What towns had the highest murder rates in 2024?"]) {
    check(ranking(q, "current")?.entityLevel === "city", `city level unchanged: "${q}"`);
  }
  for (const q of ["top 10 cities jurisdictions by murder rate in 2024", "cities, jurisdictions with the highest murder rates in 2024"]) {
    const r = recognizeCityRanking(q, "current");
    check(r?.kind === "unsupported" && r.reason === "entity-level-conflict", `both levels named: declined, not guessed ("${q}")`);
  }
  check(recognizeCityRanking("What was the highest murder rate in Chicago's jurisdiction in 2024?", "current")?.kind !== "ranking",
    "a named place with \"jurisdiction\" is not built as a ranking");
}

console.log("\n2 - Current jurisdiction SQL: no type filter, identity returned, exact rate order");
const j = ranking(GC057, "current")!;
const built = buildCityRanking(j, CUTOFF)!;
{
  check(!/am\.type\s*=/.test(built.sql), "no agency-type filter");
  check(/SELECT am\.ori AS ori, am\.agency AS jurisdiction, am\.state AS state, am\.type AS agency_type/.test(built.sql), "ORI and agency type are returned");
  check(/GROUP BY am\.ori,/.test(built.sql), "grouped by ORI, so equal names are never merged");
  check(/ORDER BY SUM\(am\.count\) \* 1\.0 \/ ap\.population DESC, am\.ori LIMIT 20$/.test(built.sql), "a rate orders by the exact ratio, then ORI; LIMIT 20");
  check(/ap\.population > 0/.test(built.sql), "the rate keeps its population > 0 denominator guard");
  check(built.entityColumn === "jurisdiction_label" && built.entityLabel === "Reporting jurisdiction", "the plan names the distinct label column for the chart");
  check(built.title === "Reporting jurisdictions by Murder Rate per 100,000, 2024", `title: "${built.title}"`);
  check(deterministicPlanRefusal({ question: GC057, source: "current", sql: built.sql }) === null,
    "the route's structural plan guard accepts it unchanged (no validation was weakened)");
  const text = built.caveats.join(" ");
  check(/reporting jurisdictions in the Current source's sample/.test(text) && /not a complete city total/.test(text) && /same name are listed separately/.test(text),
    "caveat: source-sample jurisdictions, one agency per row, not city totals, same names separate");
  check(/month each jurisdiction has records/.test(text) && /Ranking result limit: 20 rows\./.test(text) && !/\bcities\b/.test(text),
    "month-span caveat and limit in jurisdiction wording; never \"cities\"");

  const db = new Database(":memory:");
  db.exec(`CREATE TABLE agency_monthly (ori TEXT, agency TEXT, state TEXT, type TEXT, year INTEGER, month INTEGER, offense TEXT, count INTEGER);
    CREATE TABLE agency_population (ori TEXT, year INTEGER, population INTEGER);`);
  const am = db.prepare("INSERT INTO agency_monthly VALUES (?,?,?,?,2024,?,'Murder',?)");
  const ap = db.prepare("INSERT INTO agency_population VALUES (?,2024,?)");
  const put = (ori: string, agency: string, state: string, type: string, murders: number, population: number | null) => {
    for (let m = 1; m <= 12; m++) am.run(ori, agency, state, type, m, Math.floor(murders / 12) + (m <= murders % 12 ? 1 : 0));
    if (population !== null) ap.run(ori, population);
  };
  put("XX9000100", "Synthetic County Sheriff", "AL", "County", 90, 100000);
  put("XX9000200", "Birmingham", "AL", "City", 139, 195418);
  put("WY9000100", "Riverton", "WY", "City", 6, 10000);
  put("WY9000200", "Riverton", "WY", "County", 3, 10000);
  put("XX9000400", "Close Rate B", "OH", "City", 10001, 100000000);
  put("XX9000500", "Close Rate A", "OH", "City", 5002, 50000000);
  put("XX9000700", "Unpopulated Agency", "NV", "County", 400, null);
  // Same name, state and type; only the ORI differs (the Riverton pair differs by type, so it cannot catch a name merge).
  put("XX9000800", "Springdale", "AR", "City", 5, 10000);
  put("XX9000900", "Springdale", "AR", "City", 2, 10000);
  const rows = db.prepare(built.sql).all() as Record<string, unknown>[];
  const oris = rows.map((r) => r.ori);
  check(oris[0] === "XX9000100", "the county agency outranks the cities");
  const riverton = rows.filter((r) => r.jurisdiction === "Riverton");
  check(riverton.length === 2 && new Set(riverton.map((r) => r.jurisdiction_label)).size === 2,
    `same-named agencies stay separate with distinct labels (${riverton.map((r) => r.jurisdiction_label).join(" / ")})`);
  const springdale = rows.filter((r) => r.jurisdiction === "Springdale");
  check(springdale.length === 2 && springdale.map((r) => r.rate_per_100k).join() === "50,20" && new Set(springdale.map((r) => r.jurisdiction_label)).size === 2,
    "same name, state and type: two rows, told apart only by the ORI in the label");
  const a = oris.indexOf("XX9000500"); const b = oris.indexOf("XX9000400");
  check(rows[a].rate_per_100k === rows[b].rate_per_100k && a < b, "equal rounded rates (10.00): the exact ratio puts A above B although B's ORI sorts first");
  check(!oris.includes("XX9000700"), "no population row: not in a rate ranking");

  const count = buildCityRanking(ranking("What jurisdictions had the most murders in 2024?", "current")!, CUTOFF)!;
  const countRows = db.prepare(count.sql).all() as Record<string, unknown>[];
  check(!/agency_population/.test(count.sql) && countRows.some((r) => r.ori === "XX9000700"), "a count ranking keeps the agency without population");
  const floor = buildCityRanking(ranking("What jurisdictions with at least 100000 people had the highest murder rates in 2024?", "current")!, CUTOFF)!;
  check(/ap\.population >= 100000/.test(floor.sql) && floor.caveats.includes("Limited to reporting jurisdictions with a population of at least 100,000, as requested."),
    "a stated population floor is applied and described in jurisdiction wording");
  db.close();
}

console.log("\n3 - city rankings are unchanged");
{
  const saved = JSON.parse(readFileSync("scripts/fixtures/retained-evidence/gc057-completed-case.json", "utf8") /* retained input packaged 2026-09-30; source digest and extraction rule in scripts/fixtures/retained-evidence/MANIFEST.json */)
    .find((r: { case: string }) => r.case === "GC-057").scored.observed.sql;
  const city = buildCityRanking(ranking("What cities had the highest murder rates in 2024?", "current")!, CUTOFF)!;
  check(city.sql === saved, "the city SQL is byte-identical to the SQL the approved run delivered for GC-057 (then routed as city)");
  check(city.title === "Cities by Murder Rate per 100,000, 2024" && city.entityColumn === "city" && city.entityLabel === "City", "city title and chart axis unchanged");
}

console.log("\n4 - NIBRS jurisdictions: owned limitation, never a substituted city ranking");
{
  const r = recognizeCityRanking(GC057, "nibrs");
  check(r?.kind === "unsupported" && r.reason === "jurisdiction-unavailable-nibrs"
    && /reliably labelled ranking of all reporting jurisdictions in NIBRS/.test(r.explanation) && /rank city agencies if you ask/.test(r.explanation),
    "recognition declines with the limitation and offers the narrower city ranking");
  const plan = planNibrsCityRanking(GC057, CUTOFF);
  check(plan?.kind === "unavailable", "the adapter returns the owned unavailable plan (no SQL, no model fallback)");
  check(cityRankingFollowupUnavailable(GC057)?.explanation === (r as { explanation: string }).explanation, "the follow-up path carries the same reason");
  const forged: CityRankingRequest = { ...ranking("What cities had the highest murder rates in 2024?", "nibrs")!, entityLevel: "jurisdiction" };
  let threw = false;
  try { buildCityRanking(forged, CUTOFF); } catch { threw = true; }
  check(threw, "a hand-built NIBRS jurisdiction request is refused by the builder, not turned into city SQL");
  const cities = planNibrsCityRanking("What cities had the highest murder rates in 2024?", CUTOFF);
  check(cities?.kind === "deterministic" && /a\.agency_type = 'City'/.test(cities.query.sql), "explicit NIBRS city rankings still build as before");
}

console.log(`\n${checks - failures}/${checks} passed; offline guard: ${deniedDatabaseOpens().length} denied database opens, ${deniedNetworkCalls().length} network calls`);
if (failures > 0) process.exit(1);
