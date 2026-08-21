/**
 * The SHR conditional murder-victim licence, proved from AST facts.
 *
 * Every negative case names THE PROPERTY expected to refuse it. That matters more than the count:
 * three times in this workstream a negative passed for an incidental reason, and a test that passes
 * for the wrong reason is indistinguishable from one that passes for the right one until the
 * incidental reason moves.
 *
 * Cases are generated across alias form, identifier quoting, whitespace, redundant parentheses and
 * clause order, so no complete SQL string is special-cased.
 */
import assert from "node:assert";
import { analyzeSqlFacts, keyMultiplicity, MAX_SQL_LENGTH } from "../lib/sql-facts";
import { proveShrMurderLicence } from "../lib/shr-murder-licence";
import { tableSemantics } from "../lib/table-semantics";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${(error as Error).message}`); }
}

const proved = (sql: string) => proveShrMurderLicence(sql).proved;
const refusal = (sql: string) => {
  const v = proveShrMurderLicence(sql);
  return v.proved ? null : v.reason;
};

const JOINED = "FROM victims v JOIN incidents i ON v.incident_id = i.id";

console.log("\n-- accepted families --");

const ACCEPTED: [string, string][] = [
  ["direct count with the relationship and the murder filter",
    `SELECT COUNT(v.id) AS m ${JOINED} WHERE i.homicide_type = 'Murder' AND v.state = 'CA'`],
  ["COUNT(*) on the joined result, the prompt's own form",
    `SELECT COUNT(*) AS m ${JOINED} WHERE i.homicide_type = 'Murder' AND v.state = 'CA'`],
  ["reversed equality",
    `SELECT COUNT(v.id) AS m ${JOINED} WHERE 'Murder' = i.homicide_type AND v.state = 'CA'`],
  ["singleton IN",
    `SELECT COUNT(v.id) AS m ${JOINED} WHERE i.homicide_type IN ('Murder') AND v.state = 'CA'`],
  ["redundant parentheses around both conjuncts",
    "SELECT COUNT(v.id) AS m FROM victims v JOIN incidents i ON (v.incident_id = i.id) "
    + "WHERE (i.homicide_type = 'Murder') AND v.state = 'CA'"],
  ["the join written the other way round",
    `SELECT COUNT(v.id) AS m FROM incidents i JOIN victims v ON i.id = v.incident_id WHERE i.homicide_type = 'Murder'`],
  ["the murder filter carried on the ON of an inner join",
    "SELECT COUNT(v.id) AS m FROM victims v JOIN incidents i "
    + "ON v.incident_id = i.id AND i.homicide_type = 'Murder' WHERE v.state = 'CA'"],
  ["logged query 157/159: a bracketed place-alias OR beside the murder filter",
    `SELECT i.year, COUNT(v.id) AS m ${JOINED} WHERE i.homicide_type = 'Murder' AND i.year >= 2022 `
    + "AND (i.agency = 'New York' OR i.agency = 'New York City') GROUP BY i.year"],
  ["the count computed inside a CTE and selected outside",
    `WITH c AS (SELECT i.year AS y, COUNT(v.id) AS m ${JOINED} `
    + "WHERE i.homicide_type = 'Murder' GROUP BY i.year) SELECT y, m FROM c ORDER BY y"],
  ["a restricted identity-key CTE joined to the counted rows",
    "WITH m AS (SELECT id FROM incidents WHERE homicide_type = 'Murder') "
    + "SELECT COUNT(v.id) AS n FROM victims v JOIN m ON m.id = v.incident_id WHERE v.state = 'CA'"],
  ["the same key projected under an alias",
    "WITH m AS (SELECT id AS incident_key FROM incidents WHERE homicide_type = 'Murder') "
    + "SELECT COUNT(v.id) AS n FROM victims v JOIN m ON m.incident_key = v.incident_id"],
  ["a stored measure rather than a row count is not this licence's business",
    `SELECT SUM(v.age_num) AS total ${JOINED} WHERE v.state = 'CA'`],
  ["a query that never counts victims is not engaged",
    "SELECT COUNT(*) AS n FROM incidents i WHERE i.homicide_type = 'Murder'"],
  // A windowed count is a value computed per row, not the count the answer reports.
  ["a windowed count is not the answer's row count",
    "SELECT v.id, COUNT(*) OVER () AS running FROM victims v"],
  // Positive control for literal binding: an unrelated 'Murder' literal must not change a verdict
  // that is already proved on its own evidence.
  ["an unrelated 'Murder' literal alongside a genuinely proved count",
    `SELECT COUNT(v.id) AS m, 'Murder' AS label ${JOINED} WHERE i.homicide_type = 'Murder'`],
  // Positive control for arm isolation: EVERY arm proves itself.
  ["a compound where both arms prove themselves",
    `SELECT COUNT(v.id) AS m ${JOINED} WHERE i.homicide_type = 'Murder' AND i.state = 'CA' `
    + `UNION ALL SELECT COUNT(v.id) AS m ${JOINED} WHERE i.homicide_type = 'Murder' AND i.state = 'TX'`],
  ["a compound arm returning a non-victim value need not prove this licence",
    `SELECT COUNT(v.id) AS m ${JOINED} WHERE i.homicide_type = 'Murder' `
    + "UNION ALL SELECT COUNT(*) AS m FROM incidents i WHERE i.homicide_type = 'Murder'"],
  // Positive controls for reachability: dead SQL is not this licence's business.
  ["an unused victim-count CTE does not engage the licence",
    "WITH dead AS (SELECT COUNT(v.id) AS n FROM victims v) "
    + "SELECT i.year FROM incidents i WHERE i.homicide_type = 'Murder'"],
  ["a nested chain of unused CTEs does not engage the licence",
    "WITH a AS (SELECT COUNT(v.id) AS n FROM victims v), b AS (SELECT n FROM a) "
    + "SELECT i.year FROM incidents i"],
];

for (const [name, sql] of ACCEPTED) {
  check(name, () => assert.ok(proved(sql), `refused: ${refusal(sql)}`));
}

check("accepted shapes survive alias, quoting, whitespace and clause-order variation", () => {
  // Generated rather than enumerated: a rule that only recognises one spelling is a rule about
  // spelling. Every variant below is the SAME proof obligation.
  const variants: string[] = [];
  for (const [va, ia] of [["v", "i"], ["vic", "inc"], ["a", "b"]] as const) {
    for (const quote of [(s: string) => s, (s: string) => `"${s}"`] as const) {
      for (const gap of ["  ", "\n  ", "\t"] as const) {
        variants.push(
          `SELECT${gap}COUNT(${va}.id) AS m FROM ${quote("victims")} ${va}${gap}`
          + `JOIN ${quote("incidents")} ${ia} ON ${va}.incident_id = ${ia}.id${gap}`
          + `WHERE ${ia}.homicide_type = 'Murder'`);
        variants.push(
          `SELECT${gap}COUNT(${va}.id) AS m FROM ${quote("incidents")} ${ia}${gap}`
          + `JOIN ${quote("victims")} ${va} ON ${ia}.id = ${va}.incident_id AND ${ia}.homicide_type = 'Murder'`);
      }
    }
  }
  assert.ok(variants.length >= 36, `expected a real spread, got ${variants.length}`);
  const rejected = variants.filter((sql) => !proved(sql));
  assert.deepStrictEqual(rejected, [], `${rejected.length} of ${variants.length} variants refused`);
});

console.log("\n-- refused: each mapped to the property that must refuse it --");

const REFUSED: [string, string, string][] = [
  // property                              name                                    sql
  ["row count survives the CTE boundary", "the wrapped unqualified count",
    "WITH c AS (SELECT COUNT(v.id) AS m FROM victims v) SELECT m FROM c"],
  ["row count survives the CTE boundary", "a wrapped COUNT(*)",
    "WITH c AS (SELECT COUNT(*) AS m FROM victims v) SELECT m FROM c"],
  ["the murder predicate must restrict the counted rows", "no filter at all",
    `SELECT COUNT(v.id) AS m ${JOINED} WHERE v.state = 'CA'`],
  ["the relationship must be the real key", "CROSS JOIN relates nothing",
    "SELECT COUNT(v.id) AS m FROM victims v CROSS JOIN incidents i WHERE i.homicide_type = 'Murder'"],
  ["the relationship must be the real key", "ON 1=1 relates nothing",
    "SELECT COUNT(v.id) AS m FROM victims v JOIN incidents i ON 1=1 WHERE i.homicide_type = 'Murder'"],
  ["the relationship must be the real key", "a comma join relates nothing",
    "SELECT COUNT(v.id) AS m FROM victims v, incidents i WHERE i.homicide_type = 'Murder'"],
  ["the relationship must be the real key", "joined on the wrong column",
    "SELECT COUNT(v.id) AS m FROM victims v JOIN incidents i ON v.incident_id = i.year "
    + "WHERE i.homicide_type = 'Murder'"],
  ["an outer join's ON restricts nothing", "LEFT JOIN preserves unmatched victims",
    "SELECT COUNT(v.id) AS m FROM victims v LEFT JOIN incidents i "
    + "ON v.incident_id = i.id AND i.homicide_type = 'Murder' WHERE v.state = 'CA'"],
  ["the predicate must be a top-level conjunct", "buried in an always-true CASE",
    `SELECT COUNT(v.id) AS m ${JOINED} `
    + "WHERE CASE WHEN i.homicide_type = 'Murder' THEN 1 ELSE 1 END = 1 AND v.state = 'CA'"],
  ["the join equality must be a top-level conjunct", "the relationship buried in a CASE",
    "SELECT COUNT(v.id) AS m FROM victims v JOIN incidents i "
    + "ON CASE WHEN v.incident_id = i.id THEN 1 ELSE 1 END = 1 WHERE i.homicide_type = 'Murder'"],
  ["a disjunction can widen an equality", "a top-level broadening OR",
    `SELECT COUNT(v.id) AS m ${JOINED} WHERE i.homicide_type = 'Murder' OR v.state = 'CA'`],
  ["a multi-value IN is broader than the licence", "IN ('Murder','Manslaughter')",
    `SELECT COUNT(v.id) AS m ${JOINED} WHERE i.homicide_type IN ('Murder', 'Manslaughter')`],
  ["a subquery restricts only itself", "the predicate confined to a subquery",
    `SELECT COUNT(v.id) AS m ${JOINED} `
    + "WHERE i.year IN (SELECT year FROM incidents WHERE homicide_type = 'Murder')"],
  ["the predicate must be owned by incidents", "attributed to the victims table",
    "SELECT COUNT(v.id) AS m FROM victims v WHERE v.homicide_type = 'Murder'"],
  // The relationship IS established here; only the predicate's OWNER is wrong. Without this the
  // owner check is never the deciding property.
  ["the predicate must be owned by incidents", "the filter names victims while incidents is joined",
    `SELECT COUNT(v.id) AS m ${JOINED} WHERE v.homicide_type = 'Murder'`],
  ["an unqualified column is ambiguous with two tables in scope", "the filter column left unqualified",
    `SELECT COUNT(v.id) AS m ${JOINED} WHERE homicide_type = 'Murder'`],
  ["only a referenced CTE can restrict", "an unused decorative CTE",
    "WITH m AS (SELECT x.id FROM victims x JOIN incidents i ON x.incident_id = i.id "
    + `WHERE i.homicide_type = 'Murder') SELECT COUNT(v.id) AS n ${JOINED} WHERE v.state = 'CA'`],
  ["the CTE key must be emitted at most once", "compound arms repeat the key",
    "WITH m AS (SELECT id FROM incidents WHERE homicide_type = 'Murder' "
    + "UNION ALL SELECT id FROM incidents WHERE homicide_type = 'Murder') "
    + "SELECT COUNT(v.id) AS n FROM victims v JOIN m ON m.id = v.incident_id"],
  ["the CTE key must be emitted at most once", "the CTE joins victims and repeats per victim",
    "WITH m AS (SELECT i.id FROM incidents i JOIN victims x ON x.incident_id = i.id "
    + "WHERE i.homicide_type = 'Murder') SELECT COUNT(v.id) AS n FROM victims v JOIN m ON m.id = v.incident_id"],
  ["the CTE key must be emitted at most once", "the CTE comma-joins and repeats the key",
    "WITH m AS (SELECT i.id FROM incidents i, victims x WHERE i.homicide_type = 'Murder') "
    + "SELECT COUNT(v.id) AS n FROM victims v JOIN m ON m.id = v.incident_id"],
  ["the CTE key must be emitted at most once", "a grouped CTE is not proved unique",
    "WITH m AS (SELECT id FROM incidents WHERE homicide_type = 'Murder' GROUP BY id) "
    + "SELECT COUNT(v.id) AS n FROM victims v JOIN m ON m.id = v.incident_id"],
  ["the CTE key must be emitted at most once", "a windowed CTE is not proved unique",
    "WITH m AS (SELECT id, ROW_NUMBER() OVER (ORDER BY year) AS rn FROM incidents "
    + "WHERE homicide_type = 'Murder') SELECT COUNT(v.id) AS n FROM victims v JOIN m ON m.id = v.incident_id"],
  ["a key identity is not an aggregate of a key", "MIN(id) AS id",
    "WITH m AS (SELECT MIN(id) AS id FROM incidents WHERE homicide_type = 'Murder') "
    + "SELECT COUNT(v.id) AS n FROM victims v JOIN m ON m.id = v.incident_id"],
  ["a key identity is not a transformation of a key", "id + 1 AS id",
    "WITH m AS (SELECT id + 1 AS id FROM incidents WHERE homicide_type = 'Murder') "
    + "SELECT COUNT(v.id) AS n FROM victims v JOIN m ON m.id = v.incident_id"],
  ["a key identity is not a literal", "a literal standing in for the key",
    "WITH m AS (SELECT 1 AS id FROM incidents WHERE homicide_type = 'Murder') "
    + "SELECT COUNT(v.id) AS n FROM victims v JOIN m ON m.id = v.incident_id"],
  ["a key identity is not a CASE", "a CASE standing in for the key",
    "WITH m AS (SELECT CASE WHEN id THEN id ELSE 0 END AS id FROM incidents "
    + "WHERE homicide_type = 'Murder') SELECT COUNT(v.id) AS n FROM victims v JOIN m ON m.id = v.incident_id"],
  ["an outer-joined CTE preserves unmatched victims", "the CTE is LEFT JOINed",
    "WITH m AS (SELECT id FROM incidents WHERE homicide_type = 'Murder') "
    + "SELECT COUNT(v.id) AS n FROM victims v LEFT JOIN m ON m.id = v.incident_id"],
  ["an outer-joined CTE preserves unmatched victims", "LEFT JOINed with the key equality in WHERE",
    "WITH m AS (SELECT id FROM incidents WHERE homicide_type = 'Murder') "
    + "SELECT COUNT(v.id) AS n FROM victims v LEFT JOIN m ON 1=1 WHERE m.id = v.incident_id"],
  ["the CTE must restrict the filter table", "a CTE restricting the wrong table",
    "WITH m AS (SELECT id FROM victims WHERE homicide_type = 'Murder') "
    + "SELECT COUNT(v.id) AS n FROM victims v JOIN m ON m.id = v.id"],
  ["the CTE must be joined on the projected key", "joined on nothing",
    "WITH m AS (SELECT id FROM incidents WHERE homicide_type = 'Murder') "
    + "SELECT COUNT(v.id) AS n FROM victims v JOIN m ON 1=1"],
  ["unparseable input fails closed", "SQL the parser cannot read",
    "SELECT COUNT(v.id) AS m FROM victims v WHERE ((("],

  // The literal must be read from the other side of the PROVED predicate. A statement-wide text
  // search for 'Murder' authorized both of these while the actual filter said Manslaughter.
  ["the literal is bound to the proved predicate", "'Murder' appears only as an unrelated alias",
    `SELECT COUNT(v.id) AS m, 'Murder' AS label ${JOINED} WHERE i.homicide_type = 'Manslaughter'`],
  ["the literal is bound to the proved predicate", "'Murder' appears only in an unrelated predicate",
    `SELECT COUNT(v.id) AS m ${JOINED} WHERE i.homicide_type = 'Manslaughter' AND i.agency = 'Murder'`],
  ["the literal is bound to the proved predicate", "a reversed comparison to the wrong literal",
    `SELECT COUNT(v.id) AS m ${JOINED} WHERE 'Manslaughter' = i.homicide_type AND i.agency = 'Murder'`],
  ["the literal is bound to the proved predicate", "a singleton IN of the wrong literal",
    `SELECT COUNT(v.id) AS m ${JOINED} WHERE i.homicide_type IN ('Manslaughter') AND i.agency = 'Murder'`],

  // Authorization evidence must never be pooled across compound arms: one arm supplying the join
  // while another supplies the predicate proves nothing about either.
  ["every arm proves itself", "join in arm 1, murder predicate in arm 2",
    `SELECT COUNT(v.id) AS m ${JOINED} WHERE i.homicide_type = 'Manslaughter' `
    + "UNION ALL SELECT COUNT(v.id) AS m FROM victims v JOIN incidents i ON 1 = 1 "
    + "WHERE i.homicide_type = 'Murder'"],
  ["every arm proves itself", "the inverse cross-arm arrangement",
    "SELECT COUNT(v.id) AS m FROM victims v JOIN incidents i ON 1 = 1 WHERE i.homicide_type = 'Murder' "
    + `UNION ALL SELECT COUNT(v.id) AS m ${JOINED} WHERE i.homicide_type = 'Manslaughter'`],
  ["every arm proves itself", "one proved arm beside one unproved victim count",
    `SELECT COUNT(v.id) AS m ${JOINED} WHERE i.homicide_type = 'Murder' `
    + "UNION ALL SELECT COUNT(v.id) AS m FROM victims v"],

  // Reachability cuts both ways: the same CTE that is ignored when dead must refuse when used.
  ["a reachable unsafe CTE still refuses", "the victim-count CTE is selected from",
    "WITH used AS (SELECT COUNT(v.id) AS n FROM victims v) SELECT n FROM used"],
  ["a reachable unsafe CTE still refuses", "reached through a nested chain",
    "WITH a AS (SELECT COUNT(v.id) AS n FROM victims v), b AS (SELECT n FROM a) SELECT n FROM b"],
];

for (const [property, name, sql] of REFUSED) {
  check(`${name}  [${property}]`, () => {
    const reason = refusal(sql);
    assert.ok(reason !== null, "accepted, but this shape cannot prove the licence");
  });
}

console.log("\n-- fail-closed boundaries --");

check("SQL over the length cap is refused before parsing", () => {
  const long = `SELECT COUNT(v.id) AS m ${JOINED} WHERE i.homicide_type = 'Murder' AND (`
    + Array.from({ length: 4000 }, (_, n) => `v.state = 'S${n}'`).join(" OR ") + ")";
  assert.ok(long.length > MAX_SQL_LENGTH, `fixture is only ${long.length} chars`);
  const facts = analyzeSqlFacts(long);
  assert.strictEqual(facts.parsed, false);
  assert.match((facts as { reason: string }).reason, /exceeds 20000 characters/);
  assert.ok(!proved(long), "over-length SQL must not prove the licence");
});

check("a parser exception never escapes", () => {
  for (const nasty of ["", "   ", "((((", "SELECT", "DROP TABLE victims", "not sql at all",
    "SELECT * FROM t WHERE " + "NOT ".repeat(500) + "x"]) {
    assert.doesNotThrow(() => analyzeSqlFacts(nasty), `threw on: ${nasty.slice(0, 24)}`);
    assert.doesNotThrow(() => proveShrMurderLicence(nasty), `threw on: ${nasty.slice(0, 24)}`);
  }
});

check("an unreadable statement yields unknown, never a silent pass", () => {
  const facts = analyzeSqlFacts("this is not a select statement");
  assert.strictEqual(facts.parsed, false);
});

console.log("\n-- fact model --");

check("a CTE output keeps what it is, rather than collapsing to a column", () => {
  const facts = analyzeSqlFacts(
    "WITH m AS (SELECT id, MIN(id) AS lo, id + 1 AS bumped, COUNT(*) AS n, 'x' AS label "
    + "FROM incidents) SELECT id, lo, bumped, n, label FROM m");
  assert.ok(facts.parsed, "should parse");
  const cte = (facts as Extract<typeof facts, { parsed: true }>).relations.get("m")!;
  assert.strictEqual(cte.outputs.get("id")!.kind, "column");
  assert.strictEqual(cte.outputs.get("lo")!.kind, "aggregate");
  assert.strictEqual(cte.outputs.get("bumped")!.kind, "derived");
  assert.strictEqual(cte.outputs.get("n")!.kind, "rowcount");
  assert.strictEqual(cte.outputs.get("label")!.kind, "literal");
});

check("a literal fact carries its decoded value", () => {
  const facts = analyzeSqlFacts("SELECT 'Murder' AS a, 42 AS b FROM incidents");
  assert.ok(facts.parsed);
  const outputs = (facts as Extract<typeof facts, { parsed: true }>).outer.outputs;
  const a = outputs.get("a")!;
  const b = outputs.get("b")!;
  assert.strictEqual(a.kind, "literal");
  assert.strictEqual(a.kind === "literal" ? a.value : null, "Murder",
    "the value is part of the fact, so no caller has to read the statement text");
  assert.strictEqual(b.kind === "literal" ? Number(b.value) : null, 42);
});

check("every compound arm keeps its own fact scope", () => {
  const facts = analyzeSqlFacts(
    "SELECT COUNT(v.id) AS m FROM victims v JOIN incidents i ON v.incident_id = i.id "
    + "WHERE i.homicide_type = 'Manslaughter' "
    + "UNION ALL SELECT COUNT(v.id) AS m FROM victims v JOIN incidents i ON 1 = 1 "
    + "WHERE i.homicide_type = 'Murder'");
  assert.ok(facts.parsed);
  const outer = (facts as Extract<typeof facts, { parsed: true }>).outer;
  assert.strictEqual(outer.armScopes.length, 2, "two arms, two scopes");
  const [first, second] = outer.armScopes;
  // Each arm holds only its own evidence; neither can borrow the other's.
  assert.ok(first.predicates.length > 0 && second.predicates.length > 0);
  const literalsOf = (rel: typeof first) => rel.predicates
    .flatMap((p) => [p.left, p.right])
    .filter((f) => f && f.kind === "literal")
    .map((f) => (f as { value: unknown }).value);
  assert.ok(literalsOf(first).includes("Manslaughter"), "arm 1 owns its predicate");
  assert.ok(!literalsOf(first).includes("Murder"), "arm 1 must not see arm 2's predicate");
  assert.ok(literalsOf(second).includes("Murder"), "arm 2 owns its predicate");
});

check("sources are instances, so comma joins and self-joins cannot collapse", () => {
  const facts = analyzeSqlFacts("SELECT 1 FROM incidents a, incidents b JOIN victims v ON v.incident_id = a.id");
  assert.ok(facts.parsed);
  const outer = (facts as Extract<typeof facts, { parsed: true }>).outer;
  assert.strictEqual(outer.sources.length, 3, "three source instances");
  assert.deepStrictEqual(outer.sources.map((s) => s.alias), ["a", "b", "v"]);
});

check("compound arms merge by position and by kind, not by value", () => {
  const same = analyzeSqlFacts(
    "SELECT 'Chicago' AS city, COUNT(*) AS n FROM incidents "
    + "UNION ALL SELECT 'Houston' AS city, COUNT(*) AS n FROM incidents");
  assert.ok(same.parsed);
  const rel = (same as Extract<typeof same, { parsed: true }>).outer;
  assert.strictEqual(rel.outputs.get("city")!.kind, "literal", "two labels are still a label");

  const conflicting = analyzeSqlFacts(
    "SELECT id AS k FROM incidents UNION ALL SELECT COUNT(*) AS k FROM incidents");
  assert.ok(conflicting.parsed);
  const conflict = (conflicting as Extract<typeof conflicting, { parsed: true }>).outer;
  assert.strictEqual(conflict.outputs.get("k")!.kind, "unknown", "a column and a count disagree");
});

check("multiplicity is proved only for a plain unique-key projection", () => {
  const keys = (table: string) => tableSemantics("shr", table)?.uniqueKeys ?? [];
  const rel = (sql: string, name: string) => {
    const f = analyzeSqlFacts(sql);
    assert.ok(f.parsed, `did not parse: ${sql}`);
    return (f as Extract<typeof f, { parsed: true }>).relations.get(name)!;
  };
  assert.strictEqual(
    keyMultiplicity(rel("WITH m AS (SELECT id FROM incidents) SELECT 1 FROM m", "m"), "id", keys),
    "at_most_one");
  assert.strictEqual(
    keyMultiplicity(rel("WITH m AS (SELECT year FROM incidents) SELECT 1 FROM m", "m"), "year", keys),
    "may_repeat", "a non-key column is not unique");
  assert.strictEqual(
    keyMultiplicity(rel("WITH m AS (SELECT id FROM incidents UNION ALL SELECT id FROM incidents) SELECT 1 FROM m", "m"), "id", keys),
    "may_repeat", "compound arms can repeat");
  assert.strictEqual(
    keyMultiplicity(rel("WITH m AS (SELECT i.id FROM incidents i JOIN victims v ON v.incident_id = i.id) SELECT 1 FROM m", "m"), "id", keys),
    "may_repeat", "a join can repeat the left side");
  assert.strictEqual(
    keyMultiplicity(rel("WITH m AS (SELECT id FROM incidents GROUP BY id) SELECT 1 FROM m", "m"), "id", keys),
    "unknown", "grouping is not proved");
});

console.log(`\nSHR murder licence: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
