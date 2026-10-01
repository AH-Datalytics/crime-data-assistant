/**
 * Comma-separated FROM items (`FROM t1 a, t2 b`) are recognized by every check that reads table
 * references, not only by the ones that look right after FROM/JOIN.
 *
 * Before: the undeclared-alias guardrail refused a correct comma-joined query (GC-032's retained
 * youth-share SQL, 09-22 nine-case diagnosis), and the table/capability checks could not see a
 * comma-joined table at all. The shared helper `commaFromItems` feeds all of them, so:
 *   1. declared comma aliases are accepted, undeclared ones still refused;
 *   2. a comma-joined table is visible to the allowlist/capability table list;
 *   3. a comma-joined FORBIDDEN family is still forbidden, including its rollup form;
 *   4. the rollup router never rewrites half of a comma join (mixed grain);
 *   5. lineage traces a comma-joined source exactly as a JOIN-ed one;
 *   6. the period proof checks every counted comma-joined instance (Codex CMA1);
 *   7. a relation carried through a comma join is proved as through a JOIN; co-presence is not.
 */
import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";
import { findNibrsSqlIssues } from "../lib/sql-guardrails";
import { extractReferencedTables } from "../lib/table-allowlist";
import { validateSourceCapabilities } from "../lib/source-capabilities";
import { nibrsRollupTablesIn, routeNibrsRollupSql } from "../lib/nibrs-rollup-router";
import { buildQueryContract } from "../lib/query-contract";
import { analyzeSql } from "../lib/sql-lineage";
import { validateQueryContractSql } from "../lib/query-contract-validator";
import { sqlRestrictsColumnToValue, tablesWithUnrestrictedYear } from "../lib/sql-restriction";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) console.log(`  PASS  ${message}`);
  else { failures += 1; console.log(`  FAIL  ${message}`); }
}
const aliasFires = (sql: string) => findNibrsSqlIssues(sql).fired.includes("nibrs-undeclared-table-alias");
const findingsFor = (question: string, sql: string) => {
  const contract = buildQueryContract(question, "nibrs");
  if (!contract) throw new Error(`no contract for ${question}`);
  return validateSourceCapabilities({ question, source: "nibrs", contract, sql });
};

const GC032 =
  "WITH youth_offenders AS (SELECT SUM(d.offender_count) AS youth_count FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.age_group = 'Under 18' AND d.year BETWEEN 2021 AND 2025), total_offenders AS (SELECT SUM(d.offender_count) AS total_count FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.year BETWEEN 2021 AND 2025) SELECT ROUND(100.0 * y.youth_count / t.total_count, 1) AS youth_share_pct, y.youth_count, t.total_count FROM youth_offenders y, total_offenders t";

console.log("\n1 - declared comma aliases are accepted; undeclared ones are still refused");
for (const sql of [
  GC032,
  "SELECT a.x, b.y FROM t1 a, t2 b",
  "SELECT a.x, b.y FROM t1 AS a, t2 AS b",
  "SELECT a.x, b.y, c.z FROM t1 a, t2 b, t3 c",
  "SELECT a.x, s.n FROM t1 a, (SELECT COUNT(*) AS n FROM t2) s",
  "SELECT a.x, b.y, c.z FROM t1 a, t2 b JOIN t3 c ON b.id = c.id",
  "SELECT t1.x, t2.y FROM t1, t2",
  "SELECT a.x, b.y FROM t1 a, t2 b WHERE a.id = b.id",
  "SELECT a.x FROM t1 a WHERE a.id IN (SELECT b.id FROM t2 b, t3 c WHERE b.k = c.k AND c.z = 1)",
]) check(!aliasFires(sql), `accepted: ${sql.slice(0, 90)}`);
for (const sql of [
  "SELECT a.x, zz.y FROM t1 a",
  "SELECT a.x, b.y, zz.q FROM t1 a, t2 b",
  "SELECT a.x, zz.y FROM t1 a WHERE a.x IN (1, 2)",
  "SELECT a.x, b FROM t1 a WHERE b.y = 1",
  "SELECT a.x FROM t1 a WHERE a.x IN (1, 2) AND zz.y = 1",
  "SELECT a.x, COUNT(*) FROM t1 a GROUP BY a.x, zz.y",
  "SELECT a.x FROM t1 a ORDER BY a.x, zz.y",
  // If `IS DISTINCT FROM` were read as a FROM clause, `zz` after its comma would count as declared.
  "SELECT a.x, zz.y FROM t1 a WHERE (a.x IS DISTINCT FROM b, zz)",
  "SELECT a.x, zz.y FROM t1 a WHERE a.name = 'FROM t1 a, t2 zz'",
]) check(aliasFires(sql), `refused: ${sql.slice(0, 90)}`);

console.log("\n2 - a comma-joined table is visible to the table list");
{
  const tables = extractReferencedTables("SELECT a.x FROM summary_state_monthly a, summary_victim_demographics d WHERE a.state = d.state");
  check(tables.includes("summary_state_monthly") && tables.includes("summary_victim_demographics"), `both tables reported (${tables.join(", ")})`);
  check(extractReferencedTables(GC032).join(",") === "summary_offender_demographics", "CTE names in a comma list are not reported as tables");
  check(JSON.stringify(extractReferencedTables("SELECT * FROM t1 a, main.t2 b, rollup.state_summary_clearance_detail c").sort()) === JSON.stringify(["rollup", "t1", "t2"]),
    "schema prefixes follow the FROM/JOIN pattern: main dropped, rollup reported by schema");
  check(extractReferencedTables("SELECT a.x FROM t1 a, json_each(a.list) j").join(",") === "t1", "a table-valued builtin is not reported");
  check(extractReferencedTables("SELECT a, b FROM t1 WHERE x IN (1, 2) GROUP BY a, b ORDER BY a, b").join(",") === "t1",
    "commas in the select list, IN list, GROUP BY and ORDER BY are not FROM items");
  check(extractReferencedTables("SELECT 'FROM x, y' AS note FROM t1").join(",") === "t1", "a comma list inside a string literal is not read");
}

console.log("\n3 - a comma-joined forbidden family is still forbidden");
{
  const weaponQ = "How many murder victims were killed with a firearm in Florida in 2024?";
  const rule = "nibrs-weapon-person-crime-table";
  const has = (sql: string) => findingsFor(weaponQ, sql).some((f) => f.ruleId === rule);
  check(!has("SELECT COUNT(*) FROM summary_victim_weapon w WHERE w.state = 'FL'"), "control: the required table alone is clean");
  check(has("SELECT COUNT(*) FROM summary_victim_weapon w JOIN summary_victim_demographics d ON 1 = 1 WHERE w.state = 'FL'"), "control: JOIN-ed forbidden family fires");
  check(has("SELECT COUNT(*) FROM summary_victim_weapon w, summary_victim_demographics d WHERE w.state = 'FL'"), "comma-joined forbidden family fires");
  check(has("SELECT COUNT(*) FROM summary_victim_weapon w, summary_victim_demographics WHERE w.state = 'FL'"), "unqualified comma-joined forbidden family fires");
  check(has("SELECT COUNT(*) FROM summary_victim_weapon w, rollup.state_summary_victim_demographics d WHERE w.state = 'FL'"), "comma-joined forbidden family fires in its rollup form");
  check(JSON.stringify(nibrsRollupTablesIn("SELECT * FROM summary_victim_weapon w, rollup.national_summary_victim_demographics d")) ===
    JSON.stringify([{ table: "rollup.national_summary_victim_demographics", level: "national", sourceTable: "summary_victim_demographics" }]),
    "a comma-joined planner rollup is recognized with its family");
  check(nibrsRollupTablesIn("SELECT * FROM t1 a, rollup.state_summary_state_monthly b").length === 0, "a comma-joined rollup outside the nine sources still gets no family");
}

console.log("\n4 - the rollup router never rewrites half of a comma join");
{
  const mixed = routeNibrsRollupSql("SELECT SUM(w.count) FROM summary_victim_weapon w, summary_victim_demographics d WHERE w.state = 'FL' AND d.state = 'FL'", true);
  check(!mixed.routed && mixed.reason === "comma-joined-source" && !/rollup\./.test(mixed.sql), `two comma-joined sources stay on base tables (${mixed.reason})`);
  const second = routeNibrsRollupSql("SELECT COUNT(*) FROM t1 a, summary_victim_weapon w WHERE w.state = 'FL'", true);
  check(!second.routed && !/rollup\./.test(second.sql), "a source named only after a comma is not claimed as routed");
  const cte = routeNibrsRollupSql(GC032, true);
  check(cte.routed && cte.sourceTable === "summary_offender_demographics" && (cte.sql.match(/rollup\.state_summary_offender_demographics/g) ?? []).length === 2,
    `GC-032 still routes both CTE reads to the state rollup (${cte.reason})`);
  const plain = routeNibrsRollupSql("SELECT SUM(count) FROM summary_victim_weapon WHERE state = 'FL'", true);
  check(plain.routed && plain.reason === "state-rollup", "control: a plain single-source statement still routes");
}

console.log("\n5 - lineage traces a comma-joined source exactly as a JOIN-ed one");
{
  const summarize = (sql: string) => analyzeSql(sql).items.map((i) => ({ alias: i.alias, resolved: i.resolved, refs: i.refs.map((r) => `${r.table}.${r.column}`) }));
  const comma = summarize(GC032);
  const joined = summarize(GC032.replace("FROM youth_offenders y, total_offenders t", "FROM youth_offenders y JOIN total_offenders t ON 1 = 1"));
  check(comma.every((i) => i.resolved) && JSON.stringify(comma) === JSON.stringify(joined), "GC-032's returned values resolve to the same source columns in comma and JOIN form");
  const undeclared = summarize(GC032.replace("y.youth_count, t.total_count FROM", "zz.youth_count, t.total_count FROM"));
  check(undeclared.some((i) => !i.resolved), "a value read through an undeclared alias stays unresolved");
  const wrong = analyzeSql("SELECT SUM(s.offense_count) AS n FROM agencies a, summary_state_monthly s WHERE a.state = s.state");
  check(wrong.items[0].resolved && wrong.items[0].refs.some((r) => r.table === "summary_state_monthly") && wrong.baseTables.includes("summary_state_monthly"),
    "a comma-joined table is the traced source of its columns, so table-meaning checks judge it");
}

console.log("\n6 - CMA1: every counted comma-joined instance proves its own year");
{
  const q = "How many rapes were cleared by arrest in Illinois in 2025?";
  const RULE = "contract-single-year-temporal-scope";
  const periodFires = (sql: string) => validateQueryContractSql({ question: q, source: "nibrs", sql }).enforced.includes(RULE);
  const SCD = "summary_clearance_detail";
  const J = "a.ori = b.ori AND a.ucr_offense_code = b.ucr_offense_code";
  const TAIL = "a.year = 2025 AND b.state = 'IL' AND b.ucr_offense_code = '11A'";
  const PLAIN = `SELECT SUM(cleared_by_arrest) AS c FROM ${SCD} WHERE state = 'IL' AND ucr_offense_code = '11A'`;
  const SUM_B = "SELECT SUM(b.cleared_by_arrest) AS rapes_cleared_by_arrest";
  check(periodFires(`${SUM_B} FROM ${SCD} a JOIN ${SCD} b ON ${J} WHERE ${TAIL}`), "control: JOIN-ed second instance without its own year is refused");
  check(!periodFires(`${SUM_B} FROM ${SCD} a JOIN ${SCD} b ON ${J} WHERE ${TAIL} AND b.year = 2025`), "control: JOIN-ed second instance pinned to 2025 passes");
  check(periodFires(`${SUM_B} FROM ${SCD} a, ${SCD} b WHERE ${J} AND ${TAIL}`), "comma-joined second instance without its own year is refused (Codex CMA1)");
  check(!periodFires(`${SUM_B} FROM ${SCD} a, ${SCD} b WHERE ${J} AND ${TAIL} AND b.year = 2025`), "comma-joined second instance pinned to 2025 passes");
  check(periodFires(`${SUM_B} FROM ${SCD} a, ${SCD} b WHERE ${J} AND ${TAIL} AND a.year = 2025`), "pinning the first instance twice does not vouch for the second");
  check(periodFires(`${SUM_B} FROM ${SCD} a, "${SCD}" b WHERE ${J} AND ${TAIL}`), "a quoted comma-joined instance is still an instance");
  check(periodFires(`SELECT SUM(${SCD}.cleared_by_arrest) AS n FROM ${SCD} a JOIN agencies g ON g.ori = a.ori, ${SCD} WHERE a.ori = ${SCD}.ori AND a.year = 2025 AND ${SCD}.state = 'IL'`),
    "an instance comma-joined after a JOIN is seen and refused without its year");
  check(periodFires(`WITH y AS (${PLAIN} AND year = 2025), t AS (${PLAIN}) SELECT t.c AS rapes_cleared_by_arrest FROM y, t`), "a CTE read only through a comma has its filters checked");
  check(!periodFires(`WITH y AS (${PLAIN} AND year = 2025), t AS (${PLAIN} AND year = 2025) SELECT t.c AS rapes_cleared_by_arrest FROM y, t`), "the same CTEs, both pinned, pass");
  check(extractReferencedTables(`SELECT 1 FROM t1 a JOIN t2 b ON a.id = b.id, t3 c`).sort().join(",") === "t1,t2,t3", "the table list sees a comma item after a JOIN");
  check(!aliasFires("SELECT a.x, s.n FROM t1 a, (SELECT id, COUNT(*) AS n FROM t2 GROUP BY id) s JOIN t3 c ON (c.id = s.id)"),
    "a comma subquery's alias is read from its own closing paren, not a later JOIN's ON");
  check(aliasFires("SELECT a.x, zz.y FROM t1 a JOIN t2 b ON a.id = b.id, t3 c"), "an undeclared alias after a JOIN-then-comma list is still refused");
}

console.log("\n7 - a relation carried through a comma join is proved as through a JOIN, and co-presence still is not");
{
  // SHR victims take their period and their murder filter from incidents, through v.incident_id = i.id.
  const VICTIMS = [{ table: "victims", periodFrom: { table: "incidents", column: "incident_id", foreignColumn: "id" } }];
  const IDS = new Set(["id", "incident_id"]);
  const openYear = (sql: string) => tablesWithUnrestrictedYear(sql, 2025, VICTIMS, IDS);
  const OPTS = { countedTable: "victims", filterTable: "incidents", join: { countedColumn: "incident_id", filterColumn: "id" } };
  const murder = (sql: string) => sqlRestrictsColumnToValue(sql, "homicide_type", "Murder", OPTS);
  const JOINED = "SELECT COUNT(*) AS n FROM victims v JOIN incidents i ON v.incident_id = i.id WHERE i.year = 2025 AND i.homicide_type = 'Murder'";
  const COMMA = "SELECT COUNT(*) AS n FROM victims v, incidents i WHERE v.incident_id = i.id AND i.year = 2025 AND i.homicide_type = 'Murder'";
  const COMMA_REVERSED = "SELECT COUNT(*) AS n FROM incidents i, victims v WHERE v.incident_id = i.id AND i.year = 2025 AND i.homicide_type = 'Murder'";
  const COPRESENT = "SELECT COUNT(*) AS n FROM victims v, incidents i WHERE i.year = 2025 AND i.homicide_type = 'Murder'";
  check(openYear(JOINED).length === 0 && murder(JOINED), "control: the JOIN form proves the year and the murder filter through the relation");
  check(openYear(COMMA).length === 0 && murder(COMMA), "the comma form proves both the same way");
  check(openYear(COMMA_REVERSED).length === 0 && murder(COMMA_REVERSED), "with the counted table second in the comma list too");
  check(openYear(COPRESENT).join(",") === "victims" && !murder(COPRESENT), "comma co-presence without the relation proves neither");
}

console.log(`\n${checks - failures}/${checks} passed; offline guard: ${deniedDatabaseOpens().length} denied database opens, ${deniedNetworkCalls().length} network calls`);
if (failures > 0) process.exit(1);
