/**
 * The gate on the Stage 2B decision machine.
 *
 * These are the properties that must hold BEFORE any policy is authored through the workbook,
 * because a defect here does not produce a wrong answer -- it produces a wrong RECORD of a human
 * decision, which is far harder to notice later. The machine must not infer answers, must not hide
 * omissions, and must not silently apply defaults.
 *
 * WHERE THESE ASSERTIONS POINT. The page's decision logic lives in `lib/stage2b-session.js`, is
 * inlined verbatim into the workbook, and is imported here and CALLED. That distinction is the whole
 * lesson of this file: sixteen assertions about the page's text once passed over a page that threw a
 * SyntaxError on load and rendered nothing, and a stale-session defect sat in the terminal output of
 * a passing run because the check looked for a warning rather than for what happened next. Text
 * matching is used only where behaviour genuinely lives in the browser, and is labelled as such.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  DECISIONS_VERSION, SESSION_MODULE_FILE, buildWorkbookModel, decidableRegistry, registryFingerprint,
  renderWorkbook, type RegistryEntry,
} from "./generate-stage2b-workbook";
import { importDecisions, writePolicy } from "./import-stage2b-decisions";
import { INTEGRITY_IS_ENFORCED, capabilityAuthorizes, isYearBearingColumn, type UnvalidatedPolicy } from "../lib/capability-policy";
import { SWEEP_ONLY_IDS } from "../lib/sweep-only-capabilities";

const require = createRequire(import.meta.url);
/** The same file the page inlines. Imported, so these tests exercise behaviour rather than text. */
const { createStage2bSession } = require(SESSION_MODULE_FILE) as {
  createStage2bSession: (data: unknown) => any;
};

const DATA_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const REGISTRY_FILE = path.join(DATA_DIR, "capability-registry.json");
const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<string, RegistryEntry>;
const DECIDABLE = decidableRegistry(registry);

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; }
  catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 6).join("\n        ")}`); }
}

const FINGERPRINT = registryFingerprint(registry);

/**
 * An export as the page writes one: a change set plus the baseline each entry was authored against.
 * `basedOn` defaults to "there was no entry", which pairs with the empty policy the tests import
 * into, so a test that does not care about concurrency does not have to model it.
 */
const decisionsFile = (
  decisions: Record<string, unknown>,
  basedOn?: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => JSON.stringify({
  v: DECISIONS_VERSION,
  fingerprint: FINGERPRINT,
  decisions,
  basedOn: basedOn ?? Object.fromEntries(Object.keys(decisions).map((id) => [id, null])),
  ...overrides,
}, null, 2) + "\n";

/** Imports against an EMPTY policy file unless a test supplies one, so tests do not share state. */
const importInto = (raw: string, policy: Record<string, unknown> = {}) => importDecisions(raw, registry, policy);

const wellFormed = (table: string, yearColumn: string) => ({
  coverage: { kind: "column", table, yearColumn },
  integrity: ["the derived table must not outrun its upstream"],
  availability: { kind: "always" },
  receiptOwner: "scripts/import-shr.py",
  evidence: "cited from the importer that writes the table and the spec section requiring it",
});

const model = buildWorkbookModel(registry);
/** A capability with a genuinely year-bearing column, so a valid basis exists that needs no excuse. */
const withYear = model.find((c) => c.coverageCandidates.some((o) => o.yearBearing))!;
const yearBasis = withYear.coverageCandidates.find((o) => o.yearBearing)!;
assert.ok(withYear, "expected at least one capability reading a year column");

/** DATA as the page embeds it, so the session under test is the session that ships. */
function sessionFor(authored: Record<string, unknown> = {}) {
  return createStage2bSession({
    v: DECISIONS_VERSION, fingerprint: FINGERPRINT, capabilities: model, authored,
  });
}

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
  assert.strictEqual(data.capabilities.length, Object.keys(DECIDABLE).length);
});

check("the page inlines the session module verbatim, so tested and shipped logic cannot diverge", () => {
  const source = fs.readFileSync(SESSION_MODULE_FILE, "utf8");
  assert.ok(renderWorkbook(registry).includes(source),
    "the workbook does not contain lib/stage2b-session.js unchanged; the tests would be exercising a different copy");
  assert.ok(!source.includes("</scr" + "ipt"), "the session module would close the script element it is inlined into");
});

// ---------------------------------------------------------------- 1. exactly once

check("every decidable capability appears exactly once in the workbook", () => {
  const ids = model.map((c) => c.id);
  assert.deepStrictEqual([...ids].sort(), Object.keys(DECIDABLE).sort(), "the workbook is not the decidable registry");
  assert.strictEqual(new Set(ids).size, ids.length, "a capability appears more than once");
  const html = renderWorkbook(registry);
  for (const id of ids) {
    assert.ok(html.includes(JSON.stringify(id).slice(1, -1)), `${id} is missing from the rendered workbook`);
  }
});

check("the sweep-only capability is asked about and can be answered", () => {
  /**
   * It reaches no deterministic operation, so it cannot come from the derived catalog -- and while
   * it was a private constant inside the inventory generator, the workbook never asked about it and
   * the importer refused it as "not a capability in the registry". A capability that could be
   * neither decided nor declined.
   */
  assert.ok(SWEEP_ONLY_IDS.length > 0, "there is no sweep-only capability to carry");
  for (const id of SWEEP_ONLY_IDS) {
    const capability = model.find((c) => c.id === id);
    assert.ok(capability, `${id} is missing from the workbook`);
    assert.ok(capability!.coverageCandidates.length > 0, `${id} offers no coverage basis to choose`);
    const basis = capability!.coverageCandidates.find((o) => o.yearBearing) ?? capability!.coverageCandidates[0];
    const result = importInto(decisionsFile({ [id]: wellFormed(basis.table, basis.yearColumn) }));
    assert.ok(result.ok, `the importer refuses the sweep-only capability: ${JSON.stringify(!result.ok && result.errors)}`);
  }
});

check("the workbook has no capability list of its own to drift", () => {
  const synthetic = { "shr::t_solo::t_solo(year)": {
    artifact: "shr", prepDependencies: [], emittedDependencies: ["t_solo"],
    requiredColumns: { t_solo: ["year"] }, flagKey: "PROOF_CAPABILITY_SHR_DEADBEEF",
    policy: null, authorizationEligible: false,
  } } as Record<string, RegistryEntry>;
  const ids = buildWorkbookModel(synthetic).map((c) => c.id);
  assert.deepStrictEqual(ids.sort(), ["shr::t_solo::t_solo(year)", ...SWEEP_ONLY_IDS].sort(),
    "the workbook is not the synthetic registry plus the sweep-only capabilities");
  assert.ok(!renderWorkbook(synthetic).includes(Object.keys(registry)[0]),
    "the workbook carried a capability from the real registry into a synthetic one");
});

// ---------------------------------------------------------------- 2. no invented capability

check("an invented capability cannot be imported", () => {
  const result = importInto(decisionsFile({
    "shr::invented::nothing(x)": wellFormed("incidents", "year"),
  }));
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.errors.some((e) => /not a capability in the registry/.test(e)));
});

// ---------------------------------------------------------------- 3. undecided stays null

check("every unanswered field stays null and the capability stays ineligible", () => {
  const partial = {
    coverage: { kind: "column", table: yearBasis.table, yearColumn: yearBasis.yearColumn },
    integrity: null, availability: null, receiptOwner: null,
    evidence: "only the coverage basis has been decided so far, and that is a legitimate state",
  };
  const result = importInto(decisionsFile({ [withYear.id]: partial }));
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
  const result = importInto(decisionsFile({ [withYear.id]: untouched }));
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  assert.deepStrictEqual(result.authored, [], "an untouched capability must not be recorded as authored");
  assert.ok(!(withYear.id in result.policy));
});

// ---------------------------------------------------------------- 4. cluster application

check("cluster application names every affected capability, and what it costs them", () => {
  const clustered = model.find((c) => c.tableCluster.length > 0);
  assert.ok(clustered, "expected a capability sharing its table set with another");
  const S = sessionFor();
  const basis = clustered!.coverageCandidates.find((o) => o.yearBearing) ?? clustered!.coverageCandidates[0];
  S.update(clustered!.id, wellFormed(basis.table, basis.yearColumn));
  const plan = S.clusterPlan(clustered!.id);
  assert.deepStrictEqual(plan.detail.map((d: any) => d.id).sort(), [...clustered!.tableCluster].sort(),
    "the plan does not name exactly the capabilities it would change");
  assert.ok(plan.fields.length > 0, "a decided capability must have fields to copy");
  // Applying changes only the named ones.
  const before = JSON.stringify(S.decisions);
  const applied = S.applyCluster(clustered!.id);
  for (const id of applied.changed) assert.ok(plan.targets.includes(id), `${id} changed but was never named`);
  assert.notStrictEqual(JSON.stringify(S.decisions), before, "the apply step changed nothing at all");
});

check("evidence is replaced wherever cluster-applied fields change", () => {
  /**
   * Evidence describes the VALUES it was written for. Keeping a target's own citation beside fields
   * that have just been overwritten leaves a sentence describing values that are no longer there --
   * which reads, later, exactly like someone having checked.
   */
  const clustered = model.find((c) => c.tableCluster.length > 0)!;
  const target = clustered.tableCluster[0];
  const S = sessionFor();
  const basis = clustered.coverageCandidates.find((o) => o.yearBearing) ?? clustered.coverageCandidates[0];
  S.update(clustered.id, wellFormed(basis.table, basis.yearColumn));
  S.update(target, {
    availability: { kind: "conditional", condition: "only when the crosswalk is present" },
    evidence: "an ORIGINAL citation that describes the conditional availability authored here",
  });
  const plan = S.clusterPlan(clustered.id);
  const entry = plan.detail.find((d: any) => d.id === target);
  assert.ok(entry.evidenceReplaced, "the plan does not warn that this capability's evidence will be replaced");
  S.applyCluster(clustered.id);
  assert.notStrictEqual(S.decisions[target].evidence, "an ORIGINAL citation that describes the conditional availability authored here",
    "the target kept evidence describing values that were just overwritten");
  assert.strictEqual(S.decisions[target].evidence, S.decisions[clustered.id].evidence,
    "a changed target must carry the evidence of the values it now holds");
});

// ---------------------------------------------------------------- 5. coverage

check("coverage options are exactly the pairs the capability reads -- no more, no fewer", () => {
  for (const capability of model) {
    const offered = capability.coverageCandidates.map((o) => `${o.table}.${o.yearColumn}`).sort();
    const readable = capability.reads
      .flatMap((table) => (capability.columns[table] ?? []).map((column) => `${table}.${column}`)).sort();
    assert.deepStrictEqual(offered, readable, `${capability.id}: offered options are not the pairs it reads`);
  }
});

check("year-bearing options are MARKED, never used to filter the list", () => {
  const withMixed = model.find((c) =>
    c.coverageCandidates.some((o) => o.yearBearing) && c.coverageCandidates.some((o) => !o.yearBearing));
  assert.ok(withMixed, "expected a capability reading both year and non-year columns");
  for (const candidate of withMixed!.coverageCandidates) {
    assert.strictEqual(candidate.yearBearing, isYearBearingColumn(candidate.yearColumn), `${candidate.yearColumn} is marked wrongly`);
  }
  const marks = withMixed!.coverageCandidates.map((o) => o.yearBearing);
  assert.deepStrictEqual(marks, [...marks].sort((a, b) => Number(b) - Number(a)), "suggested options must sort first");
  assert.ok(renderWorkbook(registry).includes("suggested (year-bearing)"), "the mark must be visible to the reader");
});

check("an unmarked column stays selectable but costs a justification", () => {
  /**
   * Both halves matter. The naming heuristic must never block the honest answer -- a year column it
   * fails to recognise would otherwise be unreachable -- but `agencies.national_sample` must not
   * become a coverage basis through one casual click either. It was authored in a browser in exactly
   * that way, on a capability whose own page said no column there looked year-bearing, and reached
   * authorization-eligible with no friction whatever.
   */
  const mixed = model.find((c) =>
    c.coverageCandidates.some((o) => o.yearBearing) && c.coverageCandidates.some((o) => !o.yearBearing))!;
  const unmarked = mixed.coverageCandidates.find((o) => !o.yearBearing)!;
  const S = sessionFor();

  const basis = { kind: "column", table: unmarked.table, yearColumn: unmarked.yearColumn };
  assert.strictEqual(S.coverageNeedsJustification(mixed.id, basis), true, "an unmarked column must ask why");
  assert.ok(S.coverageProblem(mixed.id, basis), "an unjustified unmarked basis must be reported as a problem");
  assert.strictEqual(S.coverageProblem(mixed.id, { ...basis, justification: "the column stores an ISO date" }), null,
    "a justified unmarked basis is legitimate and must be accepted");

  const marked = mixed.coverageCandidates.find((o) => o.yearBearing)!;
  assert.strictEqual(S.coverageNeedsJustification(mixed.id, { kind: "column", table: marked.table, yearColumn: marked.yearColumn }), false,
    "a year-bearing column must not demand an excuse");

  // Enforced at the BOUNDARY too: the page is a convenience, the importer is the guarantee.
  const unjustified = { ...wellFormed(unmarked.table, unmarked.yearColumn), coverage: basis };
  const refused = importInto(decisionsFile({ [mixed.id]: unjustified }));
  assert.strictEqual(refused.ok, false, "the importer accepted an unmarked basis with no justification");
  assert.ok(!refused.ok && refused.errors.some((e) => /year-bearing/.test(e)));

  const justified = { ...unjustified, coverage: { ...basis, justification: "the column stores an ISO date whose prefix is the year" } };
  const accepted = importInto(decisionsFile({ [mixed.id]: justified }));
  assert.ok(accepted.ok, `a justified unmarked basis must import: ${JSON.stringify(!accepted.ok && accepted.errors)}`);
});

check("a basis outside the contract is refused at import even if the page emitted it", () => {
  const stray = { ...wellFormed("incidents", "year"), coverage: { kind: "column", table: "unrelated_table", yearColumn: "year" } };
  const result = importInto(decisionsFile({ [withYear.id]: stray }));
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.errors.some((e) => /coverage basis/.test(e)),
    "the importer must re-check the basis rather than trust the workbook");
});

check("\"no year dimension\" is recorded as a decision, not collapsed to an undecided null", () => {
  /**
   * It was written as the string "none" and normalised to null on import, so a considered answer
   * became indistinguishable from never having been asked: the capability read as undecided forever
   * and the reasoning was discarded at the boundary.
   */
  const decided = {
    coverage: { kind: "none", reason: "a directory count has no year dimension to bound" },
    integrity: ["the directory count must match the agency roster"],
    availability: { kind: "always" }, receiptOwner: "scripts/import-shr.py",
    evidence: "an agency directory count has no year dimension to bound, which is a decision not an omission",
  };
  const result = importInto(decisionsFile({ [withYear.id]: decided }));
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  const stored = result.policy[withYear.id] as UnvalidatedPolicy;
  assert.notStrictEqual(stored.coverage, null, "a decided no-year-dimension must not be stored as null");
  assert.deepStrictEqual(stored.coverage, decided.coverage, "the decision and its reason must survive the import");
  assert.deepStrictEqual(result.eligible, [withYear.id],
    "a capability whose coverage question is answered -- including answered as 'no year dimension' -- may be eligible");

  const reasonless = { ...decided, coverage: { kind: "none" } };
  const refused = importInto(decisionsFile({ [withYear.id]: reasonless }));
  assert.strictEqual(refused.ok, false, "no-year-dimension without a reason is an assertion, not a decision");
});

check("a derived hint cannot ride into the policy file beside the decision", () => {
  /**
   * The generator leaked `yearBearing` -- an OBSERVATION about a column's name -- into the exported
   * coverage object, and the importer wrote it to the policy file, where it sat beside the authored
   * decision looking equally authoritative and went stale the moment the taxonomy was regenerated.
   * Refused rather than stripped: stripping would hide the next leak instead of failing on it.
   */
  const leaked = {
    ...wellFormed(yearBasis.table, yearBasis.yearColumn),
    coverage: { kind: "column", table: yearBasis.table, yearColumn: yearBasis.yearColumn, yearBearing: false },
  };
  const result = importInto(decisionsFile({ [withYear.id]: leaked }));
  assert.strictEqual(result.ok, false, "an unknown coverage key was accepted");
  assert.ok(!result.ok && result.errors.some((e) => /yearBearing/.test(e)), "the refusal must name the offending key");

  // And the page does not emit it in the first place.
  const S = sessionFor();
  S.update(withYear.id, wellFormed(yearBasis.table, yearBasis.yearColumn));
  const exported = JSON.parse(S.serialize()) as { decisions: Record<string, any> };
  assert.deepStrictEqual(Object.keys(exported.decisions[withYear.id].coverage).sort(), ["kind", "table", "yearColumn"],
    "the page exported a coverage object carrying more than the decision");
});

// ---------------------------------------------------------------- 6. export is a change set

check("the export carries only what this session changed", () => {
  /**
   * A full snapshot was not merely verbose. The importer rebuilds the file from what it receives, so
   * every omitted entry was a DELETED entry -- and a snapshot taken before someone else's import
   * silently reverted their work on entries this session never touched.
   */
  const S = sessionFor();
  assert.deepStrictEqual(S.changeSet(), {}, "an untouched session must export nothing");
  S.update(withYear.id, wellFormed(yearBasis.table, yearBasis.yearColumn));
  const changed = S.changeSet();
  assert.deepStrictEqual(Object.keys(changed), [withYear.id], "the change set is not exactly what changed");
  const exported = JSON.parse(S.serialize());
  assert.deepStrictEqual(Object.keys(exported.decisions), [withYear.id]);
  assert.ok(withYear.id in exported.basedOn, "a change must record the baseline it was authored against");
});

check("importing a change set preserves capabilities it does not mention", () => {
  const other = model.find((c) => c.id !== withYear.id)!;
  const existingPolicy = { [other.id]: wellFormed("incidents", "year") };
  const result = importDecisions(
    decisionsFile({ [withYear.id]: wellFormed(yearBasis.table, yearBasis.yearColumn) }),
    registry, existingPolicy);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  assert.ok(other.id in result.policy, "an entry the change set never mentioned was deleted by importing");
  assert.deepStrictEqual(result.policy[other.id], existingPolicy[other.id], "an untouched entry was modified");
});

check("a change authored against a stale baseline is refused by name", () => {
  /**
   * Optimistic concurrency. Two people, or one person and an older tab, authoring the same
   * capability must not resolve by last-writer-wins in silence.
   */
  const mine = wellFormed(yearBasis.table, yearBasis.yearColumn);
  const theirs = { ...wellFormed(yearBasis.table, yearBasis.yearColumn), receiptOwner: "scripts/someone-elses-importer.py" };
  // I began with no entry; the file now holds theirs.
  const result = importDecisions(decisionsFile({ [withYear.id]: mine }, { [withYear.id]: null }),
    registry, { [withYear.id]: theirs });
  assert.strictEqual(result.ok, false, "an import overwrote an entry that changed underneath it");
  assert.ok(!result.ok && result.errors.some((e) => e.includes(withYear.id) && /changed since this session began/.test(e)),
    "the refusal must name the capability that moved");

  // Same change, correct baseline: accepted.
  const fine = importDecisions(decisionsFile({ [withYear.id]: mine }, { [withYear.id]: theirs }),
    registry, { [withYear.id]: theirs });
  assert.ok(fine.ok, `a change authored against the current value must merge: ${JSON.stringify(!fine.ok && fine.errors)}`);
});

check("export and re-import round-trip byte-identically", () => {
  const exported = decisionsFile({ [withYear.id]: wellFormed(yearBasis.table, yearBasis.yearColumn) });
  const first = importInto(exported);
  const second = importInto(exported);
  assert.ok(first.ok && second.ok, JSON.stringify(!first.ok && first.errors));
  if (!first.ok || !second.ok) return;
  assert.deepStrictEqual(second.policy, first.policy, "importing the same export twice must produce the same policy");
  assert.strictEqual(writePolicy(first.policy), writePolicy(second.policy), "the written file must be byte-identical");
});

// ---------------------------------------------------------------- 7. staleness

check("a registry structure change invalidates an existing export", () => {
  const exported = decisionsFile({ [withYear.id]: wellFormed(yearBasis.table, yearBasis.yearColumn) });
  const moved = JSON.parse(JSON.stringify(registry)) as Record<string, RegistryEntry>;
  moved[withYear.id].requiredColumns[yearBasis.table] = [...moved[withYear.id].requiredColumns[yearBasis.table], "an_added_column"];
  assert.notStrictEqual(registryFingerprint(moved), FINGERPRINT, "the fingerprint must move with the structure");
  const result = importDecisions(exported, moved, {});
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.errors.some((e) => /regenerate the workbook/.test(e)));
});

check("a stale session cannot be laundered through the page into a fresh fingerprint", () => {
  /**
   * The defect this file previously could not see. Loading a fingerprint-mismatched file WARNED and
   * then copied its decisions anyway; the next export stamped them with the CURRENT fingerprint, so
   * answers to questions that no longer exist arrived at the importer looking freshly authored. The
   * old test asserted the warning text appeared -- which it did, in the same run where the counter
   * moved from 0/51 to 1/51 behind it.
   */
  const S = sessionFor();
  const stale = {
    v: DECISIONS_VERSION,
    fingerprint: "deadbeefdeadbeef",
    decisions: { [withYear.id]: wellFormed(yearBasis.table, yearBasis.yearColumn) },
    basedOn: { [withYear.id]: null },
  };
  const result = S.loadSession(stale);
  assert.strictEqual(result.ok, false, "a stale session must not load");
  assert.ok(result.stale && /different registry structure/.test(result.reason), "the refusal must say why");
  assert.deepStrictEqual(S.changeSet(), {},
    "the stale decisions were copied into the session and would be re-exported under the current fingerprint");
  assert.strictEqual(S.decisions[withYear.id].coverage, null, "a stale answer reached the live session");
  assert.strictEqual(S.isDirty(), false, "refusing a load must not leave the session dirty");
});

check("a session with a matching fingerprint loads, and adopts the baseline it was authored against", () => {
  const S = sessionFor();
  const loaded = S.loadSession({
    v: DECISIONS_VERSION, fingerprint: FINGERPRINT,
    decisions: { [withYear.id]: wellFormed(yearBasis.table, yearBasis.yearColumn) },
    basedOn: { [withYear.id]: null },
  });
  assert.ok(loaded.ok, "a current session must load");
  assert.strictEqual(loaded.applied, 1);
  assert.deepStrictEqual(S.decisions[withYear.id].coverage, { kind: "column", table: yearBasis.table, yearColumn: yearBasis.yearColumn });
  assert.strictEqual(S.isDirty(), false, "a freshly loaded session has nothing unsaved");
  assert.deepStrictEqual(Object.keys(S.changeSet()), [withYear.id], "loaded work must still be exportable");
});

check("a session written by a different version is refused rather than misread", () => {
  const S = sessionFor();
  const result = S.loadSession({ v: DECISIONS_VERSION - 1, fingerprint: FINGERPRINT, decisions: {}, basedOn: {} });
  assert.strictEqual(result.ok, false);
  assert.ok(/version/.test(result.reason));
});

check("authoring policy does not change the fingerprint, so a session survives its own import", () => {
  const authoredRegistry = JSON.parse(JSON.stringify(registry)) as Record<string, RegistryEntry>;
  authoredRegistry[withYear.id].policy = wellFormed("incidents", "year");
  authoredRegistry[withYear.id].authorizationEligible = true;
  assert.strictEqual(registryFingerprint(authoredRegistry), FINGERPRINT);
});

// ---------------------------------------------------------------- 8. unsaved work

check("the session tracks unsaved work, and is clean after exporting or loading", () => {
  /**
   * Ninety-seven decisions live in one tab's memory. Nothing warned before a close discarded them,
   * and the guard has to be conditional: one that always fires is one people learn to dismiss.
   */
  const S = sessionFor();
  assert.strictEqual(S.isDirty(), false, "a fresh session has nothing to lose");
  S.update(withYear.id, wellFormed(yearBasis.table, yearBasis.yearColumn));
  assert.strictEqual(S.isDirty(), true, "an authored decision is unsaved work");
  S.serialize(); S.markClean();
  assert.strictEqual(S.isDirty(), false, "exporting saves the work");
  S.update(withYear.id, { evidence: "a revised citation that changes what is recorded here materially" });
  assert.strictEqual(S.isDirty(), true, "editing after an export is unsaved again");
});

check("re-applying the values already held is not unsaved work", () => {
  // Rendering a card writes its own values back; that must not raise the guard.
  const S = sessionFor();
  const values = wellFormed(yearBasis.table, yearBasis.yearColumn);
  S.update(withYear.id, values);
  S.markClean();
  S.update(withYear.id, JSON.parse(JSON.stringify(values)));
  assert.strictEqual(S.isDirty(), false, "writing back identical values marked the session dirty");
});

check("the page guards the close only when there is something to lose", () => {
  // Text, because beforeunload is genuinely the browser's: the CONDITION is what is asserted.
  const html = renderWorkbook(registry);
  const handler = /addEventListener\("beforeunload"[\s\S]{0,320}/.exec(html);
  assert.ok(handler, "the page does not guard against losing unexported work");
  assert.ok(/if \(!S\.isDirty\(\)\) return;/.test(handler![0]), "the guard is unconditional, so it will be dismissed by habit");
  assert.ok(/preventDefault/.test(handler![0]), "the guard does not actually stop the unload");
  assert.ok(/Export whenever you have done a few/.test(html), "the page never suggests exporting periodically");
});

// ---------------------------------------------------------------- 9. no activation

check("nothing in the decision machine can set a flag or activate anything", () => {
  const html = renderWorkbook(registry);
  for (const forbidden of ["PROOF_MODE", "PROOF_KILL_SWITCH", "authorizationEligible", "process.env"]) {
    assert.ok(!html.includes(forbidden), `the workbook references ${forbidden}, which it has no business touching`);
  }
  assert.ok(!/PROOF_CAPABILITY_[A-Z_]+_[A-F0-9]{8}/.test(html.replace(/"flagKey":"[^"]*"/g, "")),
    "the workbook exposes a capability flag name outside the embedded snapshot");
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

check("integrity rules are recorded but authorize nothing about integrity", () => {
  /**
   * An integrity rule is a sentence a person wrote. Nothing parses it, executes it, or checks data
   * against it -- so an eligible capability must not be read as one whose integrity is checked.
   */
  assert.strictEqual(INTEGRITY_IS_ENFORCED, false, "something claims integrity rules are enforced");
  const html = renderWorkbook(registry);
  assert.ok(/Recorded, not enforced/.test(html), "the page does not tell the author that integrity is unenforced");
  const policyDoc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "capability-policy.json"), "utf8")) as any;
  assert.ok(/RECORDED, NOT ENFORCED/.test(policyDoc._README.shapes.integrity),
    "the policy file does not record that its integrity rules are unenforced");
  // Nothing turns a rule into SQL or a check.
  for (const file of ["lib/source-health.ts", "lib/capability-policy.ts"]) {
    const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert.ok(!/policy\??\.integrity\s*\.(map|forEach|some|every)\s*\(/.test(text),
      `${file} iterates integrity rules as though it executed them`);
  }
});

// ---------------------------------------------------------------- 10. suggestions are not answers

check("no candidate is pre-selected, and every suggestion is labelled as one", () => {
  const blankRegistry = JSON.parse(JSON.stringify(registry)) as Record<string, RegistryEntry>;
  for (const id of Object.keys(blankRegistry)) blankRegistry[id].policy = null;
  const html = renderWorkbook(blankRegistry);

  // Behaviour: with nothing authored, every field of every capability opens undecided.
  const S = sessionFor();
  for (const capability of model) {
    const d = S.decisions[capability.id];
    assert.deepStrictEqual(S.undecidedFields(d).sort(), [...S.FIELDS].sort(),
      `${capability.id} opens with a field already answered`);
  }
  const counts = S.counts();
  assert.strictEqual(counts.complete, 0, "a capability counts as complete before anyone decided anything");

  /**
   * The embedded prior decisions may only be ones already authored in the policy source -- that is
   * the resume feature. What it must never do is pre-fill a capability nobody has decided.
   */
  const embedded = JSON.parse(html.slice(html.indexOf("const DATA = ") + "const DATA = ".length,
    html.indexOf("\n/* Decisions live only")).trim().replace(/;$/, "")) as { authored: Record<string, unknown> };
  const policySource = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "capability-policy.json"), "utf8")) as Record<string, unknown>;
  for (const id of Object.keys(embedded.authored)) {
    assert.ok(id in policySource, `${id} is pre-filled in the workbook but authored nowhere`);
  }

  /**
   * Selection is driven by the stored decision, not by position. Asserted on the template because
   * the options are built in the browser: a server-side search for `<option value="0" selected>`
   * could never match, and passed while a mutation pre-selecting the first candidate ran unnoticed.
   */
  const optionTemplate = /'<option value="'\+i\+'"'\+\(([^)]*)\?/.exec(html);
  assert.ok(optionTemplate, "the coverage option template is not in the expected form");
  assert.ok(/selectedIndex/.test(optionTemplate![1]),
    "an option is selected by something other than the stored decision, so the page chooses for the user");
  const selectedIndexDecl = /const selectedIndex = ([\s\S]*?);\n/.exec(html);
  assert.ok(selectedIndexDecl && /cov\b/.test(selectedIndexDecl[1]),
    "the selected option is not derived from the authored coverage");
  assert.ok(!/\bi\s*===\s*0\b/.test(optionTemplate![1]), "the first candidate is pre-selected");
  assert.ok(html.includes("— Undecided —"), "undecided must be an offered state");
  assert.ok(/<b>Candidates<\/b>/.test(html) && /a place to look, not an answer/.test(html),
    "suggestions must be labelled as suggestions");
  const generatorText = fs.readFileSync(path.join(process.cwd(), "scripts", "generate-stage2b-workbook.ts"), "utf8")
    .replace(/\s*\n\s*\*?\s*/g, " ");
  assert.ok(/never pre-selected/.test(generatorText) && /It does not decide anything/.test(generatorText),
    "the generator must state the no-inference rule it is bound by");
});

check("owner candidates are evidence from a filename search, never a claim of ownership", () => {
  for (const capability of model) {
    for (const candidate of capability.ownerCandidates) {
      assert.ok(fs.existsSync(path.join(process.cwd(), "scripts", candidate)),
        `${capability.id}: offers ${candidate}, which does not exist`);
    }
  }
  assert.ok(/Scripts mentioning every table this reads/.test(renderWorkbook(registry)),
    "owner candidates must be framed as a search result");
});

// ---------------------------------------------------------------- 11. the embedding boundary

check("embedded content cannot end the script element or the statement it sits in", () => {
  /**
   * A capability id, a condition or a piece of evidence containing `</script>` closes the block from
   * inside its own string literal and spills the rest of the payload onto the page as markup. U+2028
   * and U+2029 are line terminators to a JavaScript parser but not to JSON, so they end the
   * statement mid-string. Escaped at the boundary, because that is where the hazard is.
   */
  const hostile = "t_x" + "</scr" + "ipt><b>" + String.fromCharCode(0x2028) + String.fromCharCode(0x2029);
  const synthetic = { [`shr::${hostile}::${hostile}(year)`]: {
    artifact: "shr", prepDependencies: [], emittedDependencies: [hostile],
    requiredColumns: { [hostile]: ["year"] }, flagKey: "PROOF_CAPABILITY_SHR_DEADBEEF",
    policy: null, authorizationEligible: false,
  } } as Record<string, RegistryEntry>;

  const html = renderWorkbook(synthetic);
  // A browser ends the element at the FIRST closing tag, so that is what must be parsed.
  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script, "no script block survived");
  try { new Function(script![1]); }
  catch (error) { assert.fail(`hostile content broke the page: ${(error as Error).message}`); }
  const embedded = JSON.parse(script![1].slice(script![1].indexOf("const DATA = ") + "const DATA = ".length,
    script![1].indexOf("\n/* Decisions live only")).trim().replace(/;$/, "")) as { capabilities: { id: string }[] };
  assert.ok(embedded.capabilities.some((c) => c.id.includes(hostile)),
    "the hostile id did not survive the escaping intact, so escaping corrupted the data");
});

console.log(`\nstage2b workbook: ${passed} passed, ${failed} failed`);
