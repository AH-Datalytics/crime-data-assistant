/**
 * The gate on the Stage 2B decision machine.
 *
 * These are the properties that must hold BEFORE any policy is authored through the workbook,
 * because a defect here does not produce a wrong answer -- it produces a wrong RECORD of a human
 * decision, which is far harder to notice later. The machine must not infer answers, must not hide
 * omissions, and must not silently apply defaults.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  DECISIONS_VERSION, buildWorkbookModel, registryFingerprint, renderWorkbook,
  type RegistryEntry,
} from "./generate-stage2b-workbook";
import { importDecisions, writePolicy } from "./import-stage2b-decisions";
import { capabilityAuthorizes, type UnvalidatedPolicy } from "../lib/capability-policy";

const DATA_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const REGISTRY_FILE = path.join(DATA_DIR, "capability-registry.json");
const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<string, RegistryEntry>;

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; }
  catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 6).join("\n        ")}`); }
}

const FINGERPRINT = registryFingerprint(registry);
const decisionsFile = (decisions: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ v: DECISIONS_VERSION, fingerprint: FINGERPRINT, decisions, ...overrides }, null, 2) + "\n";
const wellFormed = (table: string, yearColumn: string) => ({
  coverage: { table, yearColumn },
  integrity: ["the derived table must not outrun its upstream"],
  availability: { kind: "always" },
  receiptOwner: "scripts/import-shr.py",
  evidence: "cited from the importer that writes the table and the spec section requiring it",
});

/** A capability that actually reads a year column, so a valid basis exists to author. */
const withYear = buildWorkbookModel(registry).find((c) => c.coverageCandidates.length > 0)!;
assert.ok(withYear, "expected at least one capability reading a year column");

// ---------------------------------------------------------------- 0. the page actually runs

check("the workbook's script parses, and its embedded data is valid JSON", () => {
  /**
   * The check every other assertion here presupposed and none of them made. Sixteen tests asserted
   * on the page's TEXT -- that a phrase appeared, that a handler was bound in the right order -- and
   * all sixteen passed while the page threw a SyntaxError on load and rendered nothing at all. An
   * apostrophe inside a single-quoted string was enough ("this capability's columns"), and text
   * matching cannot see that.
   *
   * Parsed with `new Function`, which compiles without executing: no DOM is needed, and a page that
   * cannot compile can never render whatever the other tests found in its source.
   */
  const html = renderWorkbook(registry);
  const script = /<script>([\s\S]*)<\/script>/.exec(html);
  assert.ok(script, "the workbook has no script block");
  try {
    new Function(script![1]);
  } catch (error) {
    assert.fail(`the workbook's script does not parse, so the page renders nothing: ${(error as Error).message}`);
  }
  const start = html.indexOf("const DATA = ") + "const DATA = ".length;
  const embedded = html.slice(start, html.indexOf("\n/* Decisions live only")).trim().replace(/;$/, "");
  const data = JSON.parse(embedded) as { capabilities: unknown[] };
  assert.strictEqual(data.capabilities.length, Object.keys(registry).length);
});

// ---------------------------------------------------------------- 1. exactly once

check("every registry capability appears exactly once in the workbook", () => {
  const model = buildWorkbookModel(registry);
  const ids = model.map((c) => c.id);
  assert.deepStrictEqual([...ids].sort(), Object.keys(registry).sort(), "the workbook is not the registry");
  assert.strictEqual(new Set(ids).size, ids.length, "a capability appears more than once");
  // And the rendered page embeds each id, so the HTML cannot silently drop one the model held.
  const html = renderWorkbook(registry);
  for (const id of ids) {
    assert.ok(html.includes(JSON.stringify(id).slice(1, -1)), `${id} is missing from the rendered workbook`);
  }
});

check("the workbook has no capability list of its own to drift", () => {
  // Generated FROM the registry: a synthetic registry must produce a workbook of exactly that shape.
  const synthetic = { "shr::t_solo::t_solo(year)": {
    artifact: "shr", prepDependencies: [], emittedDependencies: ["t_solo"],
    requiredColumns: { t_solo: ["year"] }, flagKey: "PROOF_CAPABILITY_SHR_DEADBEEF",
    policy: null, authorizationEligible: false,
  } } as Record<string, RegistryEntry>;
  const model = buildWorkbookModel(synthetic);
  assert.deepStrictEqual(model.map((c) => c.id), ["shr::t_solo::t_solo(year)"]);
  assert.ok(!renderWorkbook(synthetic).includes(Object.keys(registry)[0]),
    "the workbook carried a capability from the real registry into a synthetic one");
});

// ---------------------------------------------------------------- 2. no invented capability

check("an invented capability cannot be imported", () => {
  const result = importDecisions(decisionsFile({
    "shr::invented::nothing(x)": wellFormed("incidents", "year"),
  }), registry);
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.errors.some((e) => /not a capability in the registry/.test(e)));
});

// ---------------------------------------------------------------- 3. undecided stays null

check("every unanswered field stays null and the capability stays ineligible", () => {
  const partial = {
    coverage: { table: withYear.coverageCandidates[0].table, yearColumn: withYear.coverageCandidates[0].yearColumn },
    integrity: null, availability: null, receiptOwner: null,
    evidence: "only the coverage basis has been decided so far, and that is a legitimate state",
  };
  const result = importDecisions(decisionsFile({ [withYear.id]: partial }), registry);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  const stored = result.policy[withYear.id] as Record<string, unknown>;
  assert.strictEqual(stored.integrity, null, "an unanswered field must stay null, not acquire a default");
  assert.strictEqual(stored.availability, null);
  assert.strictEqual(stored.receiptOwner, null);
  assert.deepStrictEqual(result.eligible, [], "a partly authored capability must not be eligible");
});

check("a capability nobody touched is absent entirely, not written as an empty shell", () => {
  const untouched = { coverage: null, integrity: null, availability: null, receiptOwner: null, evidence: "" };
  const result = importDecisions(decisionsFile({ [withYear.id]: untouched }), registry);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  assert.deepStrictEqual(result.authored, [], "an untouched capability must not be recorded as authored");
  assert.ok(!(withYear.id in result.policy));
});

// ---------------------------------------------------------------- 4. cluster confirmation

check("cluster application names every affected capability before confirming", () => {
  /**
   * The workbook applies to a cluster only from a list it has rendered and a confirmation the user
   * pressed. Asserted on the page source, because the behaviour lives in the browser: the affected
   * list is built before the dialog opens, and the apply handler is bound to the confirm button --
   * never to the "Apply to related capabilities…" button that opens it.
   */
  const html = renderWorkbook(registry);
  assert.ok(/id="affected"/.test(html), "there is no list of affected capabilities");
  assert.ok(/getElementById\("affected"\)\.innerHTML\s*=\s*targets\.map/.test(html),
    "the affected list is not built from the actual targets");
  assert.ok(/getElementById\("confirm"\)\.showModal\(\)/.test(html), "no confirmation is required");
  const applyHandler = html.slice(html.indexOf('getElementById("applyCluster").addEventListener'));
  assert.ok(/for \(const t of targets\)/.test(applyHandler), "the apply step does not iterate the named targets");
  assert.ok(html.indexOf('getElementById("affected").innerHTML') < html.indexOf('getElementById("applyCluster").addEventListener'),
    "the affected list must be rendered before anything can be applied");
});

// ---------------------------------------------------------------- 5. coverage options are real

check("coverage options are exactly the pairs the capability reads -- no more, no fewer", () => {
  /**
   * Both directions. "No more" keeps the workbook from offering a basis outside the contract; "no
   * fewer" matters because filtering the list by a name pattern would make that guess load-bearing --
   * a year column the pattern missed would be unselectable and the honest answer unreachable.
   */
  for (const capability of buildWorkbookModel(registry)) {
    const offered = capability.coverageCandidates.map((o) => `${o.table}.${o.yearColumn}`).sort();
    const readable = capability.reads
      .flatMap((table) => (capability.columns[table] ?? []).map((column) => `${table}.${column}`)).sort();
    assert.deepStrictEqual(offered, readable, `${capability.id}: offered options are not the pairs it reads`);
  }
});

check("year-bearing options are MARKED, never used to filter the list", () => {
  const model = buildWorkbookModel(registry);
  const withMixed = model.find((c) =>
    c.coverageCandidates.some((o) => o.yearBearing) && c.coverageCandidates.some((o) => !o.yearBearing));
  assert.ok(withMixed, "expected a capability reading both year and non-year columns");
  for (const candidate of withMixed!.coverageCandidates) {
    const expected = /(^|_)(year|yr)($|_)/i.test(candidate.yearColumn);
    assert.strictEqual(candidate.yearBearing, expected, `${candidate.yearColumn} is marked wrongly`);
  }
  // Marked ones sort first, so the likely answers are reachable without any being chosen.
  const marks = withMixed!.coverageCandidates.map((o) => o.yearBearing);
  assert.deepStrictEqual(marks, [...marks].sort((a, b) => Number(b) - Number(a)), "suggested options must sort first");
  assert.ok(renderWorkbook(registry).includes("suggested (year-bearing)"), "the mark must be visible to the reader");
});

check("a basis outside the contract is refused at import even if the page emitted it", () => {
  const stray = { ...wellFormed("incidents", "year"), coverage: { table: "unrelated_table", yearColumn: "year" } };
  const result = importDecisions(decisionsFile({ [withYear.id]: stray }), registry);
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.errors.some((e) => /coverage basis/.test(e)),
    "the importer must re-check the basis rather than trust the workbook");
});

check("\"no year dimension\" is recorded as a decision, not as an undecided null", () => {
  const decided = {
    coverage: "none", integrity: ["the directory count must match the agency roster"],
    availability: { kind: "always" }, receiptOwner: "scripts/import-shr.py",
    evidence: "an agency directory count has no year dimension to bound, which is a decision not an omission",
  };
  const result = importDecisions(decisionsFile({ [withYear.id]: decided }), registry);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  const stored = result.policy[withYear.id] as UnvalidatedPolicy;
  assert.strictEqual(stored.coverage, null, "\"none\" normalizes to a null basis");
  // ...and it does NOT authorize, because capabilityAuthorizes requires every field non-null.
  assert.deepStrictEqual(result.eligible, [],
    "a capability with no year dimension still cannot authorize until Stage 2B decides what would replace coverage");
});

// ---------------------------------------------------------------- 6. round trip

check("export and re-import round-trip byte-identically", () => {
  const decisions: Record<string, unknown> = {};
  for (const id of Object.keys(registry).sort()) {
    decisions[id] = { coverage: null, integrity: null, availability: null, receiptOwner: null, evidence: "" };
  }
  const basis = withYear.coverageCandidates[0];
  decisions[withYear.id] = wellFormed(basis.table, basis.yearColumn);
  const exported = decisionsFile(decisions);
  const first = importDecisions(exported, registry);
  assert.ok(first.ok, JSON.stringify(!first.ok && first.errors));
  if (!first.ok) return;
  const second = importDecisions(exported, registry);
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.deepStrictEqual(second.policy, first.policy, "importing the same export twice must produce the same policy");
  assert.strictEqual(writePolicy(first.policy), writePolicy(second.policy), "the written file must be byte-identical");
});

// ---------------------------------------------------------------- 7. staleness

check("a registry structure change invalidates an existing export", () => {
  const basis = withYear.coverageCandidates[0];
  const exported = decisionsFile({ [withYear.id]: wellFormed(basis.table, basis.yearColumn) });
  // A structural change: one more required column on a table this capability reads.
  const moved = JSON.parse(JSON.stringify(registry)) as Record<string, RegistryEntry>;
  moved[withYear.id].requiredColumns[basis.table] = [...moved[withYear.id].requiredColumns[basis.table], "an_added_column"];
  assert.notStrictEqual(registryFingerprint(moved), FINGERPRINT, "the fingerprint must move with the structure");
  const result = importDecisions(exported, moved);
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.errors.some((e) => /regenerate the workbook/.test(e)));
});

check("authoring policy does not change the fingerprint, so a session survives its own import", () => {
  // Only STRUCTURE is fingerprinted. If policy fed it, importing a session's decisions would
  // invalidate the very file that produced them.
  const authoredRegistry = JSON.parse(JSON.stringify(registry)) as Record<string, RegistryEntry>;
  authoredRegistry[withYear.id].policy = wellFormed("incidents", "year");
  authoredRegistry[withYear.id].authorizationEligible = true;
  assert.strictEqual(registryFingerprint(authoredRegistry), FINGERPRINT);
});

// ---------------------------------------------------------------- 8. no activation

check("nothing in the decision machine can set a flag or activate anything", () => {
  const html = renderWorkbook(registry);
  for (const forbidden of ["PROOF_MODE", "PROOF_KILL_SWITCH", "authorizationEligible", "process.env"]) {
    assert.ok(!html.includes(forbidden), `the workbook references ${forbidden}, which it has no business touching`);
  }
  assert.ok(!/PROOF_CAPABILITY_[A-Z_]+_[A-F0-9]{8}/.test(html.replace(/"flagKey":"[^"]*"/g, "")),
    "the workbook exposes a capability flag name outside the embedded snapshot");
  // The page's only output is a download; it has no network or storage reach.
  for (const forbidden of ["fetch(", "XMLHttpRequest", "localStorage", "sessionStorage", "navigator.sendBeacon"]) {
    assert.ok(!html.includes(forbidden), `the workbook uses ${forbidden}; it must be inert and local`);
  }
  const importer = fs.readFileSync(path.join(process.cwd(), "scripts", "import-stage2b-decisions.ts"), "utf8");
  assert.ok(!/PROOF_CAPABILITY|PROOF_MODE|flagKey/.test(importer),
    "the importer touches flags; authoring policy makes a capability eligible, which is not enabling it");
});

check("the importer is the only thing that can write the policy source", () => {
  const html = renderWorkbook(registry);
  assert.ok(!html.includes("capability-policy.json"),
    "the workbook names the policy source; it must produce a download that a checked-in importer validates");
  assert.ok(/download = "stage2b-policy-decisions.json"/.test(html), "the workbook must export to a file");
});

// ---------------------------------------------------------------- suggestions are not answers

check("no candidate is pre-selected, and every suggestion is labelled as one", () => {
  /**
   * The property that keeps this a decision machine rather than an inference machine. With no
   * authored policy, every question must open on "Undecided" -- a workbook that pre-picked the
   * single plausible candidate would launder a guess into the record as a human decision.
   */
  const blankRegistry = JSON.parse(JSON.stringify(registry)) as Record<string, RegistryEntry>;
  for (const id of Object.keys(blankRegistry)) blankRegistry[id].policy = null;
  const html = renderWorkbook(blankRegistry);
  /**
   * Asserted on the TEMPLATE and the embedded state, not on rendered markup. The options are built
   * in the browser, so a server-side search for `<option value="0" selected>` could never match --
   * it passed while a mutation pre-selecting the first candidate ran unnoticed.
   */
  /**
   * The embedded prior decisions may only be ones already authored in the policy source -- that is
   * the resume feature. What it must never do is pre-fill a capability nobody has decided. (An
   * earlier version of this assertion demanded the map be empty, which was simply false: the policy
   * file legitimately holds one authored entry, and blanking the REGISTRY's policy does not blank
   * the file the map is read from.)
   */
  const embedded = JSON.parse(html.slice(html.indexOf("const DATA = ") + "const DATA = ".length,
    html.indexOf("\n/* Decisions live only")).trim().replace(/;$/, "")) as { authored: Record<string, unknown> };
  const policySource = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "capability-policy.json"), "utf8")) as Record<string, unknown>;
  for (const id of Object.keys(embedded.authored)) {
    assert.ok(id in policySource, `${id} is pre-filled in the workbook but authored nowhere`);
  }
  const selectedCondition = /'<option value="'\+i\+'"'\+\(([^)]*)\?/.exec(html);
  assert.ok(selectedCondition, "the coverage option template is not in the expected form");
  assert.ok(/d\.coverage/.test(selectedCondition![1]),
    "an option is selected by something other than the stored decision, so the page chooses for the user");
  assert.ok(!/i\s*===\s*0/.test(selectedCondition![1]), "the first candidate is pre-selected");
  assert.ok(html.includes("— Undecided —"), "undecided must be an offered state");
  assert.ok(/<b>Candidates<\/b>/.test(html) && /a place to look, not an answer/.test(html),
    "suggestions must be labelled as suggestions");
  // Whitespace-insensitive: the rule is a sentence in a wrapped docblock, and a literal match would
  // fail on a line break rather than on a missing rule.
  const generatorText = fs.readFileSync(path.join(process.cwd(), "scripts", "generate-stage2b-workbook.ts"), "utf8")
    .replace(/\s*\n\s*\*?\s*/g, " ");
  assert.ok(/never pre-selected/.test(generatorText) && /It does not decide anything/.test(generatorText),
    "the generator must state the no-inference rule it is bound by");
});

check("owner candidates are evidence from a filename search, never a claim of ownership", () => {
  for (const capability of buildWorkbookModel(registry)) {
    for (const candidate of capability.ownerCandidates) {
      assert.ok(fs.existsSync(path.join(process.cwd(), "scripts", candidate)),
        `${capability.id}: offers ${candidate}, which does not exist`);
    }
  }
  const html = renderWorkbook(registry);
  assert.ok(/Scripts mentioning every table this reads/.test(html), "owner candidates must be framed as a search result");
});

console.log(`\nstage2b workbook: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
