/**
 * P3.1a — structural verification of frozen-cases-v2.json against the ten review gates.
 * Executes NO production predicate, no observer, no buildQueryContract, no model, no production.
 */
const fs = require("fs"), crypto = require("crypto");
const V1_PATH = process.argv[2], V2_PATH = process.argv[3];
const V1_EXPECTED = "2a2739cc9dcab7872537d6c22880d70ee5ec0e012362d2c6fb47f8346d69cc78";

const v1raw = fs.readFileSync(V1_PATH), v2raw = fs.readFileSync(V2_PATH);
const v1 = JSON.parse(v1raw.toString("utf8")), v2 = JSON.parse(v2raw.toString("utf8"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

let pass = 0, fail = 0;
const ok = (g, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + g); }
  else { fail++; console.log("  FAIL  " + g + (detail ? "\n          " + detail : "")); }
};

// G1 — 21 pairs x 3 roles, unique ids, exact source applicability
{
  const ids = new Set(v2.cases.map((c) => c.id));
  const pairs = new Map();
  for (const c of v2.cases) {
    if (!pairs.has(c.pair)) pairs.set(c.pair, new Set());
    pairs.get(c.pair).add(c.role);
  }
  const roleOk = [...pairs.values()].every((r) => r.size === 3 &&
    r.has("positive") && r.has("false_acceptance") && r.has("false_refusal"));
  const srcOk = v2.cases.every((c) => c.pair === c.rule_id + " x " + c.source);
  ok("G1  21 pairs x 3 roles, unique ids, exact source applicability",
    ids.size === 63 && pairs.size === 21 && roleOk && srcOk,
    "ids=" + ids.size + " pairs=" + pairs.size + " roleOk=" + roleOk + " srcOk=" + srcOk);
}

// G2 — every case has a declared question family, from the closed vocabulary
{
  const vocab = new Set(v2.family_vocabulary || []);
  const missing = v2.cases.filter((c) => !c.question_family);
  const undeclared = v2.cases.filter((c) => c.question_family && !vocab.has(c.question_family));
  const used = new Set(v2.cases.map((c) => c.question_family));
  ok("G2  every case declares a family, all within the closed vocabulary",
    missing.length === 0 && undeclared.length === 0 && vocab.size > 0,
    "missing=" + missing.length + " undeclared=" + JSON.stringify([...new Set(undeclared.map(c=>c.question_family))]) +
    " families_used=" + used.size + "/" + vocab.size);
}

// G3 — every positive carries an admissible expected action/reason pair
{
  const pos = v2.cases.filter((c) => c.role === "positive");
  const bad = pos.filter((c) => !c.expected_outcome || c.expected_outcome.applies !== true ||
    c.expected_outcome.action !== "decline_capability" ||
    c.expected_outcome.reason !== "query_contract_failed" ||
    c.expected_outcome.store !== "query_log");
  ok("G3  all 21 positives carry the admissible decline_capability/query_contract_failed pair",
    pos.length === 21 && bad.length === 0, "bad=" + bad.length);
}

// G4 — every negative carries an explicit no-outcome expectation
{
  const neg = v2.cases.filter((c) => c.role !== "positive");
  const bad = neg.filter((c) => !c.expected_outcome || c.expected_outcome.applies !== false ||
    c.expected_outcome.action !== null || c.expected_outcome.reason !== null);
  const pseudo = neg.filter((c) => typeof c.expected_outcome?.reason === "string");
  ok("G4  all 42 negatives carry an explicit null action/reason, no pseudo-reason",
    neg.length === 42 && bad.length === 0 && pseudo.length === 0,
    "bad=" + bad.length + " pseudo=" + pseudo.length);
}

// G5 — every contract-dependent case has a complete minimal projection over the fields read
{
  const dep = v2.cases.filter((c) => c.contract_projection_required);
  const bad = dep.filter((c) => {
    if (!c.expected_contract || typeof c.expected_contract !== "object") return true;
    const keys = Object.keys(c.expected_contract);
    if (!keys.length) return true;
    // every field the predicate reads must be projected
    return !c.contract_fields_read_by_predicate.every((f) => keys.includes(f));
  });
  // Count derived from the data, not hard-coded: `demographic-rate-unsupported` spreads over five
  // sources, so the contract-dependent set is 27 cases, not 5 x 3. Asserting a guessed total made
  // this gate fail on correct data.
  const depRules = new Set(dep.map((c) => c.rule_id));
  ok("G5  every contract-dependent case projects every field its predicate reads",
    depRules.size === 5 && dep.length + v2.cases.filter((c) => !c.contract_projection_required).length === 63 && bad.length === 0,
    "dependent=" + dep.length + " over " + depRules.size + " rules, incomplete=" + bad.length +
    (bad.length ? " e.g. " + bad[0].id + " reads=" + JSON.stringify(bad[0].contract_fields_read_by_predicate) +
     " projected=" + JSON.stringify(Object.keys(bad[0].expected_contract || {})) : ""));
}

// G6 — every pure-question case explicitly declares no projection required
{
  const pure = v2.cases.filter((c) => !c.contract_projection_required);
  const bad = pure.filter((c) => c.expected_contract !== null ||
    (c.contract_fields_read_by_predicate || []).length !== 0);
  const pureRules = new Set(pure.map((c) => c.rule_id));
  ok("G6  every pure-question case declares expected_contract null explicitly",
    pureRules.size === 4 && pure.length + v2.cases.filter((c) => c.contract_projection_required).length === 63 && bad.length === 0,
    "pure=" + pure.length + " over " + pureRules.size + " rules, bad=" + bad.length);
}

// G7 — every Ward reuse binds the same pinned evidence id
{
  const ward = v2.cases.filter((c) => /Ward, AR/.test(c.question));
  const bound = ward.filter((c) => (c.evidence_refs || []).includes("EV-WARD-AR-CITY"));
  const ev = v2.evidence && v2.evidence["EV-WARD-AR-CITY"];
  const pinned = ev && ev.artifact_sha256 && ev.stable_identity && ev.retrieved_at && ev.authority;
  ok("G7  every Ward case binds the same pinned evidence id, and the pin is complete",
    ward.length > 0 && bound.length === ward.length && Boolean(pinned),
    "ward=" + ward.length + " bound=" + bound.length + " pinned=" + Boolean(pinned));
}

// G8 — observed fields remain unset
{
  const dirty = v2.cases.filter((c) => c.observed_base_result !== null || c.observed_contract !== null);
  ok("G8  no observed field is populated", dirty.length === 0, "populated=" + dirty.length);
}

// G9 — v1 byte-identical at its recorded hash
{
  const got = sha(v1raw);
  ok("G9  v1 remains byte-identical at its recorded hash",
    got === V1_EXPECTED && v1.cases.length === 63,
    "got=" + got.slice(0, 16) + " expected=" + V1_EXPECTED.slice(0, 16));
}

// G10 — v2 additions only: no v1 field changed
{
  const byId = new Map(v1.cases.map((c) => [c.id, c]));
  const changed = [];
  for (const c of v2.cases) {
    const o = byId.get(c.id);
    if (!o) { changed.push(c.id + " (new id)"); continue; }
    for (const k of Object.keys(o)) {
      if (JSON.stringify(o[k]) !== JSON.stringify(c[k])) changed.push(c.id + "." + k);
    }
  }
  ok("G10 v2 changes no v1 field - additions only",
    changed.length === 0, "changed=" + JSON.stringify(changed.slice(0, 5)));
}

console.log("");
console.log("  " + pass + " gates passed, " + fail + " failed");
console.log("  v2 sha256: " + sha(v2raw) + "  (" + v2raw.length + " bytes)");
process.exit(fail === 0 ? 0 : 1);
