/**
 * The gate on the Stage 2B decision machine.
 *
 * These are the properties that must hold BEFORE any policy is authored, because a defect here does
 * not produce a wrong answer -- it produces a wrong RECORD of a human decision, which is far harder
 * to notice later. The machine must not infer answers, must not hide omissions, must not silently
 * apply defaults, and must never turn a plain-language answer into technical policy that the person
 * did not see and approve.
 *
 * WHERE THESE ASSERTIONS POINT. The page's logic lives in `lib/stage2b-plain-language.js` and
 * `lib/stage2b-session.js`, is inlined verbatim into the workbook, and is imported here and CALLED.
 * That distinction is the lesson of this file: sixteen assertions about the page's text once passed
 * over a page that threw a SyntaxError on load, and a stale-session defect sat in the output of a
 * passing run because the check looked for a warning rather than for what happened next. Text
 * matching is used only where behaviour genuinely lives in the browser, and is labelled as such.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  CATALOG_MODULE_FILE, DECISIONS_VERSION, PLAIN_LANGUAGE_MODULE_FILE, SESSION_MODULE_FILE,
  buildWorkbookModel, decidableRegistry, loadCatalog, registryFingerprint, renderWorkbook,
  workbookFingerprint,
  type RegistryEntry,
} from "./generate-stage2b-workbook";
import { importDecisions } from "./import-stage2b-decisions";
import { generatePolicyFile, renderPolicyFile } from "./generate-capability-policy";
import {
  AUTHORED_FILE, GENERATED_POLICY_FILE, type AuthoredRecord, commitAuthoredRecord, derivePolicy,
  derivedEntryAuthorizes, entryDigest, loadGeneratedPolicy, readAuthoredRecord, recordDigest,
  recordShapeErrors, renderAuthoredRecord,
} from "../lib/stage2b-authored-record";
import {
  authorizationBlockers, authorizesApartFromIntegrity, capabilityAuthorizes, integrityIsExecutable,
  isYearBearingColumn, policyIsComplete, policyShapeErrors,
} from "../lib/capability-policy";
import { SWEEP_ONLY_IDS } from "../lib/sweep-only-capabilities";

const require = createRequire(import.meta.url);
/** The same files the page inlines. Imported, so these tests exercise behaviour rather than text. */
const { createStage2bSession } = require(SESSION_MODULE_FILE) as { createStage2bSession: (d: unknown, pl?: unknown) => any };
const { createStage2bPlainLanguage } = require(PLAIN_LANGUAGE_MODULE_FILE) as { createStage2bPlainLanguage: (c?: unknown) => any };
const CATALOG = loadCatalog();
const PL = createStage2bPlainLanguage(CATALOG);

const DATA_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const REGISTRY_FILE = path.join(DATA_DIR, "capability-registry.json");
const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<string, RegistryEntry>;
const DECIDABLE = decidableRegistry(registry);

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; }
  catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 6).join("\n        ")}`); }
}

/** What an answer is given against: the database structure AND the questions. */
const FINGERPRINT = workbookFingerprint(registry, CATALOG);
const model = buildWorkbookModel(registry);
/** A capability with a genuinely year-bearing column, so the recommended answer exists. */
const withYear = model.find((c) => c.coverageCandidates.some((o) => o.yearBearing))!;
const yearBasis = withYear.coverageCandidates.find((o) => o.yearBearing)!;
const withoutYear = model.find((c) => c.coverageCandidates.length > 0 && !c.coverageCandidates.some((o) => o.yearBearing))!;

/**
 * A session over a chosen derived-policy baseline.
 *
 * `entries` is the authored record that baseline came from, because the export has to name the
 * RECORD it was authored on top of and not only what the record derives. Tests that pass a policy
 * baseline without the record it came from would be exporting a baseline that claims the capability
 * was unanswered.
 */
function sessionFor(authored: Record<string, unknown> = {}, entries: AuthoredRecord = {} as AuthoredRecord) {
  return createStage2bSession({
    v: DECISIONS_VERSION, contractFingerprint: FINGERPRINT, capabilities: model, authored,
    entryDigests: Object.fromEntries(model.map((c) => [c.id, entryDigest(entries[c.id])])),
  }, PL);
}

/** The payload the page was actually handed, read back out of a rendered workbook. */
function embeddedData(html: string): Record<string, any> {
  const start = html.indexOf("const DATA = ") + "const DATA = ".length;
  return JSON.parse(html.slice(start, html.indexOf("\n/* Your answers live only")).trim().replace(/;$/, ""));
}

/**
 * A session over the REAL page's payload, produced by rendering the workbook from a record.
 *
 * THIS IS THE POINT OF THE HELPER. The seeding regression used to rebuild the payload by hand, and
 * so supplied the very field the generator got wrong: the page shipped an answer's full contract
 * fingerprint under a name the session compared against the catalog-only one, so in production
 * every restored confirmation looked re-worded and was dropped -- underneath a green test that had
 * handed the session two values it had made agree. Nothing here reconstructs what the page emits.
 */
function workbookSession(record: { docs: Record<string, unknown>; entries: AuthoredRecord }) {
  return createStage2bSession(embeddedData(renderWorkbook(registry, undefined, record)), PL);
}

/** A complete set of plain-language answers, as a person clicking through would produce. */
const answers = (cap = withYear, over: Record<string, unknown> = {}) => ({
  ...PL.blankAnswer(),
  coverage: cap.coverageCandidates.some((o: any) => o.yearBearing) ? "years" : "no-years",
  coverageReason: cap.coverageCandidates.some((o: any) => o.yearBearing) ? "" : "this lookup answers a directory question, not a time-series one",
  integrity: [PL.integrityScenarios(cap)[0].value],
  availability: "always",
  owner: PL.ownerOptions(cap)[0].value,
  evidence: "checked with the analyst who owns this pipeline and confirmed against the monthly runbook",
  ...over,
});

/** An export, produced the way the page produces one: answered, then the mapping confirmed. */
function exportWith(capId: string, human: Record<string, unknown>, confirmIt = true) {
  const S = sessionFor();
  S.update(capId, human);
  if (confirmIt) S.confirmMapping(capId);
  return S.serialize();
}

/** The empty authored record: nothing decided, nothing migrated. */
const EMPTY_RECORD = { docs: {} as Record<string, unknown>, entries: {} as AuthoredRecord };
const importInto = (raw: string, record = EMPTY_RECORD) => importDecisions(raw, registry, record);

/** A record in which one capability is already decided, produced exactly the way the importer does. */
function recordWith(capId: string, human: Record<string, unknown>) {
  const result = importDecisions(exportWith(capId, human), registry, EMPTY_RECORD);
  if (!result.ok) throw new Error("could not build the prior record: " + result.errors.join("; "));
  return { docs: result.docs, entries: result.entries, policy: result.policy };
}

/** A record holding one migrated legacy entry, as the one-time migration produced. */
const legacyRecord = (capId: string, policy: Record<string, unknown>) => ({
  docs: {} as Record<string, unknown>,
  entries: { [capId]: { kind: "legacy" as const, policy } } as AuthoredRecord,
});

/**
 * A catalog that covers exactly the ids given, for the tests that drive a SYNTHETIC registry.
 *
 * Real generation always uses the reviewed catalog; these tests are about the workbook's structure,
 * not about its descriptions, and they must not be able to weaken the coverage rule for real runs.
 */
const catalogCovering = (ids: string[]) => ({
  coverageAgainst: (registryIds: string[]) => ({
    missing: registryIds.filter((id) => !ids.includes(id)),
    extra: ids.filter((id) => !registryIds.includes(id)),
  }),
  fingerprint: () => "synthetic",
  ids: () => ids,
  entry: () => null,
  question: () => "a synthetic capability, described only for a structural test",
  processLabels: () => ["A synthetic update process"],
  scenarios: () => [{ value: "stale", label: "It stops being updated", prose: "It must not stop." }],
  PROCESSES: {},
  SCENARIOS: {},
});

// ---------------------------------------------------------------- 0. the page actually runs

check("the workbook's script parses, and its embedded data is valid JSON", () => {
  /**
   * The check every other assertion here presupposed and none of them made. Sixteen tests asserted
   * on the page's TEXT and all of them passed while the page threw a SyntaxError on load and
   * rendered nothing at all. An apostrophe inside a single-quoted string was enough.
   */
  const html = renderWorkbook(registry);
  const script = /<script>([\s\S]*)<\/script>/.exec(html);
  assert.ok(script, "the workbook has no script block");
  try { new Function(script![1]); }
  catch (error) { assert.fail(`the workbook's script does not parse, so the page renders nothing: ${(error as Error).message}`); }
  const start = html.indexOf("const DATA = ") + "const DATA = ".length;
  const embedded = html.slice(start, html.indexOf("\n/* Your answers live only")).trim().replace(/;$/, "");
  assert.strictEqual((JSON.parse(embedded) as { capabilities: unknown[] }).capabilities.length, Object.keys(DECIDABLE).length);
});

check("the page inlines both logic modules verbatim, so tested and shipped logic cannot diverge", () => {
  const html = renderWorkbook(registry);
  for (const file of [SESSION_MODULE_FILE, PLAIN_LANGUAGE_MODULE_FILE]) {
    const source = fs.readFileSync(file, "utf8");
    assert.ok(html.includes(source), `${path.basename(file)} is not inlined unchanged; the tests exercise a different copy`);
    assert.ok(!source.includes("</scr" + "ipt"), `${path.basename(file)} would close the script element it is inlined into`);
  }
});

// ---------------------------------------------------------------- 0b. the reviewed catalog

check("the catalog covers the registry exactly, and generation fails when it does not", () => {
  /**
   * A capability arriving without a reviewed description used to inherit a paraphrase of its table
   * names -- which is how the NIBRS agency lookup, state list and year-coverage check all came to
   * read "answered from the agencies". A missing entry is a thing to write, not to fall back from.
   */
  const coverage = CATALOG.coverageAgainst(model.map((c) => c.id));
  assert.deepStrictEqual(coverage.missing, [], "capabilities with no reviewed description");
  assert.deepStrictEqual(coverage.extra, [], "catalog entries for capabilities that no longer exist");
  assert.strictEqual(CATALOG.ids().length, model.length, "the catalog and the registry differ in size");

  // Losing a capability fails generation rather than producing a workbook with a hole in it.
  const shrunk = JSON.parse(JSON.stringify(registry)) as Record<string, RegistryEntry>;
  delete shrunk[Object.keys(shrunk)[0]];
  assert.throws(() => renderWorkbook(shrunk), /does not match the registry/,
    "removing a capability still produced a workbook");
  // And gaining one does too.
  const grown = JSON.parse(JSON.stringify(registry)) as Record<string, RegistryEntry>;
  grown["shr::t_new::t_new(year)"] = {
    artifact: "shr", prepDependencies: [], emittedDependencies: ["t_new"],
    requiredColumns: { t_new: ["year"] }, flagKey: "PROOF_CAPABILITY_SHR_DEADBEEF",
    policy: null, authorizationEligible: false,
  };
  assert.throws(() => renderWorkbook(grown), /MISSING from lib\/stage2b-capability-catalog\.js/,
    "a new capability was given a workbook page with no reviewed description");
});

check("every capability is described distinctly, in terms of what it answers", () => {
  const questions = new Map<string, string[]>();
  for (const cap of model) {
    const q = PL.describeQuestion(cap);
    assert.ok(!/NO DESCRIPTION/.test(q), `${cap.id} has no reviewed description`);
    assert.ok(q.length > 25, `${cap.id}: the description is too short to distinguish anything`);
    questions.set(q, [...(questions.get(q) ?? []), cap.id]);
  }
  for (const [q, ids] of questions) {
    assert.strictEqual(ids.length, 1, `${ids.length} capabilities share one description: "${q}"\n  ${ids.join("\n  ")}`);
  }
  // The three that used to collide are now told apart.
  const collided = model.filter((c) => c.artifact === "nibrs" && c.reads.length === 1 && c.reads[0] === "agencies");
  assert.ok(collided.length >= 3, "expected the NIBRS agencies capabilities that previously shared a description");
  const distinct = new Set(collided.map((c) => PL.describeQuestion(c)));
  assert.strictEqual(distinct.size, collided.length, "the NIBRS agencies capabilities still share a description");
  for (const cap of collided) {
    assert.ok(!/answered from the/.test(PL.describeQuestion(cap)), "the description is still a paraphrase of table names");
  }
});

check("owner choices are narrowed to the processes that could own this capability", () => {
  /**
   * Every crime_data capability used to offer all three update processes, so the only way to pick
   * was to open the technical details -- which defeats the layer.
   */
  const artifactWide = new Map<string, Set<string>>();
  for (const cap of model) {
    const named = PL.ownerOptions(cap).filter((o: any) => o.value !== "other" && o.value !== PL.UNSURE);
    assert.ok(named.length >= 1, `${cap.id}: offers no update process at all`);
    assert.ok(named.length <= 2, `${cap.id}: offers ${named.length} processes, which is a menu rather than a choice`);
    for (const o of named) {
      assert.ok(!/\.(py|ts|js|sql)$/.test(o.value), `${cap.id}: offers the filename ${o.value}`);
    }
    const set = artifactWide.get(cap.artifact) ?? new Set<string>();
    named.forEach((o: any) => set.add(o.value));
    artifactWide.set(cap.artifact, set);
  }
  // crime_data has three processes overall; no single capability may offer all of them.
  assert.strictEqual(artifactWide.get("crime_data")!.size, 3, "expected three crime_data processes across the artifact");
  for (const cap of model.filter((c) => c.artifact === "crime_data")) {
    const named = PL.ownerOptions(cap).filter((o: any) => o.value !== "other" && o.value !== PL.UNSURE);
    assert.ok(named.length < 3, `${cap.id}: still offers every process for its data source`);
  }
  // "Something else" and "I'm not sure" remain everywhere, so narrowing never traps anyone.
  for (const cap of model) {
    const values = PL.ownerOptions(cap).map((o: any) => o.value);
    assert.ok(values.includes("other") && values.includes(PL.UNSURE), `${cap.id}: narrowing removed the escape hatches`);
  }
});

check("the failure scenarios offered are the ones that fit this data", () => {
  const perCapability = new Map<string, string>();
  for (const cap of model) {
    const scenarios = PL.integrityScenarios(cap);
    assert.ok(scenarios.length >= 2, `${cap.id}: offers too few scenarios to be a real question`);
    for (const s of scenarios) {
      assert.ok(s.label && s.prose, `${cap.id}: a scenario is missing its wording`);
      assert.ok(!/\b(table|column|ori|schema)\b/i.test(s.label), `${cap.id}: scenario label is technical: ${s.label}`);
    }
    perCapability.set(cap.id, scenarios.map((s: any) => s.value).sort().join(","));
  }
  // Not one generic set repeated everywhere.
  assert.ok(new Set([...perCapability.values()]).size >= 8,
    "the same handful of scenarios is offered almost everywhere, so they are not capability-relevant");
  // A county-crosswalk capability is asked about unmatched agencies; a year-coverage one is not.
  const crosswalk = model.find((c) => c.reads.includes("agency_county_crosswalk"))!;
  assert.ok(PL.integrityScenarios(crosswalk).some((s: any) => s.value === "crosswalk"),
    "a county lookup is not asked about agencies that cannot be matched to a county");
});

check("what the person answered survives into a checked-in record, and reopens with it", () => {
  /**
   * The policy file holds the technical result; on its own it loses the question. Regenerating the
   * workbook opened every card blank even where policy existed, so the reasoning behind a decision
   * survived only in whatever export file happened to still be on someone's disk.
   */
  const human = answers();
  const result = importInto(exportWith(withYear.id, human));
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  const recorded = result.entries[withYear.id] as { kind: string; human: Record<string, unknown>; confirmed: string };
  assert.ok(recorded, "the answer was not recorded anywhere durable");
  assert.strictEqual(recorded.kind, "decided", "a confirmed answer was not recorded as a decision");
  assert.strictEqual(recorded.human.coverage, human.coverage, "the recorded answer is not the one given");
  assert.strictEqual(recorded.human.evidence, human.evidence, "the reasoning was dropped");
  assert.ok(recorded.confirmed, "the confirmation provenance was dropped");

  /**
   * Reopening the REAL page restores it, and does NOT report it as an unsaved change.
   *
   * Driven through `renderWorkbook`, because this is exactly where a reconstructed payload lied:
   * the old version of this test built the seed itself and made the two fingerprints agree, while
   * the page emitted one under a name the session compared against a different value entirely.
   */
  const prior = { docs: result.docs, entries: result.entries };
  const reopened = workbookSession(prior);
  assert.strictEqual(reopened.human(withYear.id).coverage, human.coverage, "the reopened workbook lost the answer");
  assert.strictEqual(reopened.isMappingConfirmed(withYear.id), true,
    "the page dropped a confirmation nothing had invalidated, so every returning author is asked to "
    + "re-confirm work they already confirmed");
  assert.strictEqual(reopened.needsReconfirmation(withYear.id), false,
    "the page says the question was re-worded when it was not");
  assert.deepStrictEqual(reopened.changeSet(), {}, "a restored answer is reported as an unsaved change");
  assert.strictEqual(reopened.isDirty(), false);

  // A capability nobody answered still opens blank: restoring must never invent an answer.
  const other = model.find((c) => c.id !== withYear.id)!;
  assert.strictEqual(reopened.human(other.id).coverage, null, "an unanswered capability was seeded with something");

  // Editing a restored answer is a change again.
  reopened.update(withYear.id, { evidence: "a revised note that changes what was recorded here materially" });
  assert.deepStrictEqual(Object.keys(reopened.changeSet()), [withYear.id], "editing a restored answer is not a change");

  /**
   * And if the CONTRACT has moved since, the answer comes back but the confirmation does not, and
   * the entry stops producing policy. A confirmation approves one translation of one question as it
   * was worded; once any of that changes it approves something nobody read, so the policy it used
   * to derive must stand down until a person confirms the wording that exists now.
   */
  const stale = JSON.parse(JSON.stringify(result.entries)) as AuthoredRecord;
  (stale[withYear.id] as { contractFingerprint: string }).contractFingerprint = "an-older-contract";

  const derivedFromStale = derivePolicy(stale, model, PL, FINGERPRINT);
  assert.deepStrictEqual(derivedFromStale.expired, [withYear.id],
    "a confirmation given under a contract that no longer exists was not stood down");
  assert.ok(!(withYear.id in derivedFromStale.policy),
    "an expired confirmation still derived policy, so re-wording a question leaves the old decision active");
  assert.deepStrictEqual(derivedFromStale.errors, [],
    "an expired confirmation was refused as a contradiction, which would take the whole record down with it");

  const rewordedPage = renderWorkbook(registry, undefined, { docs: result.docs, entries: stale });
  assert.ok(!(withYear.id in embeddedData(rewordedPage).authored),
    "the page still shows policy derived from a confirmation that has expired");
  const reworded = createStage2bSession(embeddedData(rewordedPage), PL);
  assert.strictEqual(reworded.human(withYear.id).coverage, human.coverage, "a re-worded question lost the answer too");
  assert.strictEqual(reworded.isMappingConfirmed(withYear.id), false, "a confirmation survived a re-worded question");
  assert.strictEqual(reworded.needsReconfirmation(withYear.id), true, "the page is not told to ask again");
  assert.ok(withYear.id in reworded.changeSet(), "a re-worded answer is not offered for re-confirmation on export");
  assert.ok(/re-worded since/.test(renderWorkbook(registry)), "the page never explains why it is asking again");

  // Withdrawing removes the durable record too, not just the policy.
  const W = sessionFor({ [withYear.id]: result.policy[withYear.id] as Record<string, unknown> }, result.entries);
  W.withdraw(withYear.id);
  const removed = importDecisions(W.serialize(), registry, prior);
  assert.ok(removed.ok && !(withYear.id in (removed as any).entries),
    "withdrawing removed the policy but left the answer record behind");
});

check("the fingerprint covers everything a person reads, and the translation itself", () => {
  /**
   * A confirmation attaches to one translation of one question AS IT WAS WORDED. While the identity
   * covered only database structure and the per-capability catalog, a shared question heading, an
   * option's stated consequence, or `proposeMapping` itself could all change without invalidating a
   * single confirmation -- so an approval could end up attached to something nobody read.
   *
   * Every case below mutates a REAL contract field taken from the production modules. Substituting a
   * fake digest would only prove that workbookFingerprint consumes the digest it is handed.
   */
  const realSource = fs.readFileSync(PLAIN_LANGUAGE_MODULE_FILE, "utf8");
  /**
   * Rebuild the translation module FROM SOURCE, so a mutation changes the real thing rather than a
   * wrapper around it. Overriding an exported method is not enough: `contractFor` calls the module's
   * own internals, so a spread-over copy would leave the contract untouched and the test would pass
   * while proving nothing.
   */
  const plFrom = (source: string) =>
    (new Function(source + "\nreturn createStage2bPlainLanguage;")() as (c: unknown) => any)(CATALOG);
  const fingerprintOf = (source: string, translationSource = realSource) =>
    workbookFingerprint(registry, CATALOG, { plainLanguage: plFrom(source), translationSource });

  assert.strictEqual(fingerprintOf(realSource), FINGERPRINT, "the contract is not reproducible from the real module");

  /**
   * Each case edits a REAL string in the production module and holds the translation digest at its
   * true value, so only the wording differs. That isolates it: the fingerprint has to move because
   * what the person READS changed, not merely because the file's bytes did.
   */
  const wordingCases: [string, string, string][] = [
    ["a question heading", "1. Do we know the first and last year this data covers?",
      "1. Can we tell the first and last year this data covers?"],
    ["a question hint", "Some data is legitimately missing sometimes.",
      "Some data is legitimately missing now and then."],
    ["what an answer is said to do", "If it ever goes missing, that gets treated as a problem worth flagging.",
      "If it ever goes missing, that gets treated as a problem worth flagging and reported weekly."],
    ["an option label", "Yes — we know the first and last year it covers",
      "Yes — we know the earliest and latest year it covers"],
    ["the label on the recorded summary", 'coverage: "Years"', 'coverage: "Year range"'],
  ];
  for (const [what, from, to] of wordingCases) {
    assert.ok(realSource.includes(from), `this test is stale: the module no longer contains ${what}`);
    const mutated = realSource.replace(from, to);
    assert.notStrictEqual(mutated, realSource, `${what} did not actually change`);
    assert.notStrictEqual(fingerprintOf(mutated), FINGERPRINT,
      `changing ${what} left every confirmation valid`);
  }

  // The per-capability catalog is covered too, by a real question rather than a substituted digest.
  const realCatalogQuestion = CATALOG.question(withYear.id);
  assert.ok(realCatalogQuestion, "this test is stale: the capability has no catalogued question");
  const rewordedCatalog = { ...CATALOG, fingerprint: () => CATALOG.fingerprint(),
    question: (id: string) => (id === withYear.id ? realCatalogQuestion + " (revised)" : CATALOG.question(id)) };
  assert.notStrictEqual(
    workbookFingerprint(registry, rewordedCatalog, { plainLanguage: createStage2bPlainLanguage(rewordedCatalog), translationSource: realSource }),
    FINGERPRINT, "re-wording a capability's own question left every confirmation valid");

  // And the translation itself, holding every displayed word constant.
  const changedTranslation = realSource.replace(
    'proposed.availability = { kind: "always" };',
    'proposed.availability = { kind: "always" }; /* the rule changed */');
  assert.notStrictEqual(changedTranslation, realSource, "the translation source did not actually change");
  assert.notStrictEqual(workbookFingerprint(registry, CATALOG, { plainLanguage: PL, translationSource: changedTranslation }),
    FINGERPRINT, "changing how an answer becomes policy left every confirmation valid");

  // Structure still moves it, so the original guard is intact.
  const moved = JSON.parse(JSON.stringify(registry)) as Record<string, RegistryEntry>;
  moved[withYear.id].requiredColumns[yearBasis.table] = [...moved[withYear.id].requiredColumns[yearBasis.table], "an_added_column"];
  assert.notStrictEqual(workbookFingerprint(moved, CATALOG), FINGERPRINT, "a structural change left the fingerprint untouched");

  // And a session authored against any other contract does not load.
  const S = sessionFor();
  const otherContract = JSON.parse(exportWith(withYear.id, answers()));
  otherContract.contractFingerprint = fingerprintOf(realSource.replace(
    "1. Do we know the first and last year this data covers?",
    "1. Can we tell the first and last year this data covers?"));
  const refused = S.loadSession(otherContract);
  assert.strictEqual(refused.ok, false, "a session authored against different wording loaded");
  assert.ok(refused.stale, "it was not refused as stale");

  // A pre-catalog export is refused by version rather than accepted on an older fingerprint.
  assert.ok(DECISIONS_VERSION >= 5, "the version was not raised when the fingerprint changed meaning");
  const old = JSON.parse(exportWith(withYear.id, answers()));
  old.v = DECISIONS_VERSION - 1;
  assert.strictEqual(importInto(JSON.stringify(old)).ok, false, "a version-3 export was still accepted");
});

check("the page reads its shared wording from the contract, not from its own template", () => {
  /**
   * If the page kept its own copy of a heading, the fingerprint would cover a string nobody reads
   * and miss the one they do.
   */
  const html = renderWorkbook(registry);
  const wording = PL.questions();
  for (const [where, text] of [
    ["coverage heading", wording.coverage.heading],
    ["integrity heading", wording.integrity.heading],
    ["availability heading", wording.availability.heading],
    ["owner heading", wording.owner.heading],
    ["evidence heading", wording.evidence.heading],
    ["mapping heading", wording.mapping.heading],
  ] as [string, string][]) {
    assert.ok(html.includes(text), `the ${where} in the contract does not appear on the page`);
    assert.ok(!new RegExp("<h3>" + text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "</h3>").test(html),
      `the page hard-codes the ${where} instead of reading it from the contract`);
  }
  assert.ok(/const Q = PL\.questions\(\);/.test(html), "the page does not take its wording from the contract");
});

check("there is ONE authored source, and policy is derived from it", () => {
  /**
   * The redesign, asserted as a property. The same decision used to live in two authoritative files
   * written one after the other, and every review found another way for them to disagree: a crash
   * between the writes, an orphaned answer, an update that kept its id and passed a key-only check.
   * Policy is not stored independently any more, so it cannot disagree with the answers.
   */
  const generated = generatePolicyFile();
  assert.deepStrictEqual(generated.errors, [], "the checked-in record does not derive");
  assert.strictEqual(fs.readFileSync(GENERATED_POLICY_FILE, "utf8"), generated.text,
    "capability-policy.json is not byte-identical to what the generator emits; it has been hand-edited "
    + "or is stale. Run: npx tsx scripts/generate-capability-policy.ts");

  // It is stamped with the record it came from, and refused when that no longer matches.
  const raw = JSON.parse(fs.readFileSync(GENERATED_POLICY_FILE, "utf8")) as Record<string, unknown>;
  assert.strictEqual(raw._generatedFrom, recordDigest(AUTHORED_FILE), "the generated policy is not stamped with its source");
  assert.ok(/DO NOT EDIT BY HAND/.test(JSON.stringify(raw._README)), "the generated file does not say it is generated");
  assert.doesNotThrow(() => loadGeneratedPolicy(), "the canonical loader refuses the current pair");
});

check("no consumer silently trusts a policy that lags its source", () => {
  /**
   * A generated file that quietly falls behind is the two-record defect again, just slower to
   * notice. Every reader goes through the loader, and the loader fails closed.
   */
  const stale = path.join(DATA_DIR, "policy-stale-probe.json");
  const current = JSON.parse(fs.readFileSync(GENERATED_POLICY_FILE, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(stale, JSON.stringify({ ...current, _generatedFrom: "0000000000000000" }, null, 2));
  try {
    assert.throws(() => loadGeneratedPolicy(stale), /generated from a different version/,
      "a policy stamped with the wrong source was accepted");
    assert.throws(() => loadGeneratedPolicy(path.join(DATA_DIR, "absent-policy.json")), /has not been generated/,
      "a missing generated policy was tolerated");
  } finally { fs.rmSync(stale, { force: true }); }

  // The consumers read through it rather than opening the file themselves.
  for (const file of ["scripts/generate-source-health-inventory.ts", "scripts/test-operation-taxonomy.ts"]) {
    const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert.ok(/loadGeneratedPolicy/.test(text), `${file} does not read policy through the canonical loader`);
    assert.ok(!/readFileSync\([^)]*capability-policy\.json/.test(text),
      `${file} opens the generated policy directly, so it can be handed a stale one`);
  }
});

check("the authored record is a closed union, and the importer can never write a legacy entry", () => {
  const { entries } = readAuthoredRecord();
  assert.deepStrictEqual(recordShapeErrors(entries), [], "the checked-in record is malformed");
  for (const [id, entry] of Object.entries(entries)) {
    assert.ok(["decided", "open", "legacy"].includes(entry.kind), `${id}: unknown entry kind`);
  }
  // Malformed variants are refused rather than coerced.
  for (const [what, entry] of [
    ["a decided entry with no confirmation", { kind: "decided", human: {}, preserved: {}, contractFingerprint: "x" }],
    ["an open entry carrying a confirmation", { kind: "open", human: {}, contractFingerprint: "x", confirmed: "y" }],
    ["a legacy entry carrying a human answer", { kind: "legacy", policy: {}, human: {} }],
    ["an entry of no known kind", { kind: "invented", human: {} }],
  ] as [string, unknown][]) {
    assert.ok(recordShapeErrors({ "shr::incidents::incidents(year)": entry } as AuthoredRecord).length > 0,
      `${what} was accepted`);
  }
  // Nothing in the importer can produce one.
  const importer = fs.readFileSync(path.join(process.cwd(), "scripts", "import-stage2b-decisions.ts"), "utf8");
  assert.ok(!/kind:\s*"legacy"/.test(importer), "the importer can create a legacy entry");
  assert.ok(/kind:\s*"decided"/.test(importer) && /kind:\s*"open"/.test(importer),
    "the importer does not write the two kinds it is allowed to");
});

check("a migrated legacy entry authorizes nothing, whatever it contains", () => {
  /**
   * It has no human answer and no confirmation behind it, so it cannot be read as a decision anyone
   * made through the questions. Structural: the shared predicate refuses it, so no consumer has to
   * remember the rule.
   */
  const declared = withYear.reads.map((name) => ({ name, requiredColumns: withYear.columns[name] ?? [] }));
  const complete = {
    coverage: { kind: "column", table: yearBasis.table, yearColumn: yearBasis.yearColumn },
    integrity: [{ rule: "r", boundTo: "checks/x.sql" }],
    availability: { kind: "always" }, receiptOwner: "someone",
    evidence: "a complete-looking entry migrated from before the workbook existed",
  };
  assert.strictEqual(derivedEntryAuthorizes({ ...complete, origin: "legacy" }, declared), false,
    "a legacy entry authorized");
  assert.strictEqual(capabilityAuthorizes({ ...complete, origin: "legacy" }, declared), false,
    "the shared predicate let a legacy entry authorize");
  /**
   * Asserted on the predicate WITHOUT the integrity gate in front of it. Nothing can authorize
   * today, so a check on `capabilityAuthorizes` alone cannot tell a working legacy refusal from a
   * missing one -- both return false. This is the assertion that still means something on the day
   * integrity bindings exist.
   */
  assert.strictEqual(authorizesApartFromIntegrity(complete, declared), true,
    "this fixture cannot show anything: it would not authorize even without the legacy marker");
  assert.strictEqual(authorizesApartFromIntegrity({ ...complete, origin: "legacy" }, declared), false,
    "the migrated-legacy refusal is not what stops this entry; it is only the integrity gate");
  assert.ok(authorizationBlockers({ ...complete, origin: "legacy" }, declared).some((b) => /migrated/.test(b)),
    "the blocker does not name why");
  // And derivation marks them, so the mark cannot be lost between record and policy.
  const derived = derivePolicy(legacyRecord(withYear.id, complete).entries, model, PL, FINGERPRINT);
  assert.strictEqual((derived.policy[withYear.id] as Record<string, unknown>).origin, "legacy",
    "derivation dropped the legacy marker");
});

check("a confirmation that does not match the re-derivation derives nothing", () => {
  /**
   * The importer checks this before writing, so a record on disk always agrees -- which means the
   * derivation's own check is never exercised by an ordinary import, and a regression that only
   * imports cannot see it. A record can also arrive by hand edit, merge, or a future writer.
   */
  const prior = recordWith(withYear.id, answers());
  const tampered = JSON.parse(JSON.stringify(prior.entries)) as AuthoredRecord;
  (tampered[withYear.id] as { confirmed: string }).confirmed = "0000dead";
  const derived = derivePolicy(tampered, model, PL, FINGERPRINT);
  assert.ok(derived.errors.some((e) => /given for a different mapping/.test(e)),
    "a confirmation for some other mapping was accepted as policy");
  assert.ok(!(withYear.id in derived.policy), "the mis-confirmed entry still produced policy");

  // And an entry whose human answer was edited after confirmation derives nothing either.
  const edited = JSON.parse(JSON.stringify(prior.entries)) as AuthoredRecord;
  (edited[withYear.id] as { human: Record<string, unknown> }).human.availability = "sometimes";
  (edited[withYear.id] as { human: Record<string, unknown> }).human.availabilityWhen = "after the annual load";
  const afterEdit = derivePolicy(edited, model, PL, FINGERPRINT);
  assert.ok(afterEdit.errors.length > 0, "an answer edited after confirmation still derived policy");
});

check("an unconfirmed answer is recorded but derives no policy", () => {
  const result = importInto(exportWith(withYear.id, answers(), false));
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  assert.deepStrictEqual(result.open, [withYear.id], "an unconfirmed answer was not recorded as work in progress");
  assert.deepStrictEqual(result.decided, [], "an unconfirmed answer was recorded as a decision");
  assert.ok(!(withYear.id in result.policy), "an unconfirmed answer derived policy");
  assert.strictEqual((result.entries[withYear.id] as { kind: string }).kind, "open");
});

check("the recorded mapping is audit evidence only, and must equal re-derivation", () => {
  const prior = recordWith(withYear.id, answers());
  const tampered = JSON.parse(JSON.stringify(prior.entries)) as AuthoredRecord;
  (tampered[withYear.id] as { mapping: Record<string, unknown> }).mapping.receiptOwner = "a value nobody chose";
  const derived = derivePolicy(tampered, model, PL, FINGERPRINT);
  assert.ok(derived.errors.some((e) => /disagrees with itself/.test(e)),
    "a mapping snapshot that contradicts the answer was accepted as policy");
  assert.ok(!(withYear.id in derived.policy), "the contradicted entry still produced policy");
});

check("an interruption at any persistence boundary leaves the record wholly old or wholly new", () => {
  /**
   * One file, one rename. The point of the redesign: there is no window in which half a decision is
   * committed, because there is no second file to be out of step with.
   */
  const probe = path.join(DATA_DIR, "record-fault-probe.json");
  const staged = `${probe}.staged`;
  const OLD = renderAuthoredRecord({ _note: "before" }, {} as AuthoredRecord);
  const NEW = renderAuthoredRecord({ _note: "after" }, {} as AuthoredRecord);
  try {
    for (const failAt of ["before-write", "after-write", "after-rename", undefined] as const) {
      fs.writeFileSync(probe, OLD);
      fs.rmSync(staged, { force: true });
      let threw = false;
      try { commitAuthoredRecord(NEW, { file: probe, failAt }); } catch { threw = true; }
      const after = fs.readFileSync(probe, "utf8");
      assert.ok(after === OLD || after === NEW,
        `failing at ${String(failAt)} left the record neither wholly old nor wholly new`);
      assert.ok(JSON.parse(after), `failing at ${String(failAt)} left the record unparseable`);
      if (failAt === "before-write" || failAt === "after-write") {
        assert.strictEqual(after, OLD, `failing at ${String(failAt)} committed a partial write`);
        assert.ok(threw, "the injected failure did not surface");
      } else {
        assert.strictEqual(after, NEW, `${String(failAt)} did not commit the new record`);
      }
    }
  } finally { fs.rmSync(probe, { force: true }); fs.rmSync(staged, { force: true }); }

  // And the importer commits through that one path, writing nothing else.
  const importer = fs.readFileSync(path.join(process.cwd(), "scripts", "import-stage2b-decisions.ts"), "utf8");
  const cli = importer.slice(importer.indexOf("if (process.argv[1]"));
  assert.ok(/commitAuthoredRecord\(/.test(cli), "the importer does not commit through the atomic path");
  assert.ok(!/writeFileSync\(AUTHORED_FILE/.test(importer), "the importer writes the authored file directly");
});

// ---------------------------------------------------------------- 1. the human-facing surface

check("no technical field is required to answer any question", () => {
  /**
   * The property that makes this usable by the person whose decision it actually is. Every question
   * is answerable from the plain-language controls alone: no table, no column, no filename, no
   * binding. The technical surface exists, but only as optional detail.
   */
  for (const cap of model) {
    const S = sessionFor();
    S.update(cap.id, answers(cap));
    const p = S.proposal(cap.id);
    assert.deepStrictEqual(p.unresolved, [],
      `${cap.id}: plain-language answers alone left ${p.unresolved.join(", ")} unresolved`);
    assert.deepStrictEqual(S.problems(cap.id), [],
      `${cap.id}: plain-language answers alone produced ${S.problems(cap.id).join("; ")}`);
    // And the mapping they produce is valid policy at the boundary.
    assert.ok(S.confirmMapping(cap.id), `${cap.id}: a complete answer could not be confirmed`);
    const result = importInto(S.serialize());
    assert.ok(result.ok, `${cap.id}: ${JSON.stringify(!result.ok && result.errors)}`);
  }
  // The human answer never carries a column unless someone opens the technical disclosure.
  assert.strictEqual(PL.blankAnswer().coverageColumn, null, "a column is pre-set before anyone chose one");
});

check("every question offers \"I'm not sure\", and it fails closed", () => {
  const S = sessionFor();
  S.update(withYear.id, {
    ...PL.blankAnswer(),
    coverage: PL.UNSURE, availability: PL.UNSURE, owner: PL.UNSURE, integrityUnsure: true,
    evidence: "nobody here knows yet; recorded so the open question is visible rather than assumed",
  });
  const p = S.proposal(withYear.id);
  assert.deepStrictEqual([...p.unresolved].sort(), ["availability", "coverage", "integrity", "receiptOwner"],
    "an unsure answer resolved into technical policy");
  for (const field of ["coverage", "integrity", "availability", "receiptOwner"]) {
    assert.strictEqual((p.proposed as Record<string, unknown>)[field], null, `${field} acquired a value from "not sure"`);
  }
  // It is still a recorded answer, not an absence: it exports, and it authorizes nothing.
  S.confirmMapping(withYear.id);
  const result = importInto(S.serialize());
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  assert.deepStrictEqual(result.eligible, [], "an unsure answer produced an authorised capability");
  assert.ok(withYear.id in result.policy, "an unsure answer was discarded rather than recorded as open");

  // Every question offers it.
  assert.ok(PL.coverageOptions(withYear).some((o: any) => o.value === PL.UNSURE), "coverage has no unsure option");
  assert.ok(PL.availabilityOptions().some((o: any) => o.value === PL.UNSURE), "availability has no unsure option");
  assert.ok(PL.ownerOptions(withYear).some((o: any) => o.value === PL.UNSURE), "receipt owner has no unsure option");
  assert.ok(/I\\u2019m not sure|I'm not sure/.test(renderWorkbook(registry)), "the page never offers 'I'm not sure' for integrity");
});

check("an unresolved answer never erases an existing decision", () => {
  /**
   * The human controls start blank even where policy already exists, so answering "I'm not sure"
   * and citing evidence produced four nulls -- and the importer wrote them over a complete existing
   * entry and returned success. A decided capability became undecided with no withdrawal and
   * nothing named. Removing a decision is the separate, confirmed act at the bottom of the page.
   */
  const prior = recordWith(withYear.id, answers());
  const existingDerived = prior.policy[withYear.id] as Record<string, unknown>;
  const S = sessionFor({ [withYear.id]: existingDerived }, prior.entries);
  S.update(withYear.id, {
    ...PL.blankAnswer(), coverage: PL.UNSURE, availability: PL.UNSURE, owner: PL.UNSURE, integrityUnsure: true,
    evidence: "nobody here knows yet; recorded so the open question is visible rather than assumed",
  });

  const p = S.proposal(withYear.id);
  assert.deepStrictEqual([...p.preserved].sort(), ["availability", "coverage", "integrity", "receiptOwner"],
    "an unresolved answer did not preserve the existing decision");
  for (const field of ["coverage", "integrity", "availability", "receiptOwner"]) {
    assert.deepStrictEqual((p.merged as Record<string, unknown>)[field], existingDerived[field],
      `${field} was about to be erased by an unresolved answer`);
  }

  S.confirmMapping(withYear.id);
  const result = importDecisions(S.serialize(), registry, prior);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  const stored = result.policy[withYear.id] as Record<string, unknown>;
  for (const field of ["coverage", "integrity", "availability", "receiptOwner"]) {
    assert.deepStrictEqual(stored[field], existingDerived[field],
      `${field} was erased at import by an unresolved answer`);
  }
  // Withdrawal is still the way to remove one, and it still works.
  const W = sessionFor({ [withYear.id]: existingDerived }, prior.entries);
  W.withdraw(withYear.id);
  const removed = importDecisions(W.serialize(), registry, prior);
  assert.ok(removed.ok && !(withYear.id in removed.policy), "the named withdrawal no longer removes anything");

  // And the page says which fields are being kept rather than set.
  const html = renderWorkbook(registry);
  assert.ok(/kept from what was already recorded/.test(html), "the page never says a field is being kept");
  assert.ok(/leaving a question open never/.test(html), "the page does not tell the reader that open questions are safe");
});

check("the coverage question promises only what the check delivers", () => {
  /**
   * The question said the system could notice "years this data does not cover". The check compares
   * the requested years against MIN and MAX and nothing else, so with rows for 2020 and 2022 and
   * none for 2021, a request for 2021 passes. Asking a policy owner to authorise gap detection that
   * does not exist is worse than not asking: they would rely on it.
   */
  const yearsOption = PL.coverageOptions(withYear).find((o: any) => o.value === "years");
  assert.ok(yearsOption, "there is no option for a lookup that records years");
  assert.ok(/first and last year/.test(yearsOption.label), "the label still promises general coverage");
  assert.ok(/missing in between/.test(yearsOption.consequence),
    "the consequence does not disclose that a gap inside the range is undetected");
  assert.ok(!/years this data does not cover|which year each record belongs to/.test(yearsOption.consequence + yearsOption.label),
    "the overpromising wording survives");

  const html = renderWorkbook(registry);
  assert.ok(/Do we know the first and last year this data covers\?/.test(html), "the page still asks the wider question");
  // Contiguous fragment: the page builds this sentence by concatenation, so the source is split.
  assert.ok(/not notice a year missing in between/.test(html), "the page does not disclose the limitation");

  // The limitation is recorded at the check itself, where the next reader of the code will meet it.
  const runtime = fs.readFileSync(path.join(process.cwd(), "lib", "source-health.ts"), "utf8");
  assert.ok(/BOUNDS ONLY/.test(runtime), "coverageFor does not record what it cannot see");
});

check("a recommendation is shown but never pre-selected", () => {
  /**
   * The property that keeps this a decision machine rather than an inference machine. A workbook
   * that pre-picked the single plausible answer would launder a guess into the record as a human
   * decision -- and the person would have no way to tell which answers were theirs.
   */
  const S = sessionFor();
  for (const cap of model) {
    const h = S.human(cap.id);
    assert.strictEqual(h.coverage, null, `${cap.id}: coverage opens pre-answered`);
    assert.strictEqual(h.availability, null, `${cap.id}: availability opens pre-answered`);
    assert.strictEqual(h.owner, null, `${cap.id}: receipt owner opens pre-answered`);
    assert.deepStrictEqual(h.integrity, [], `${cap.id}: integrity opens pre-answered`);
    assert.ok(PL.coverageOptions(cap).some((o: any) => o.recommended), `${cap.id}: no option is marked recommended`);
  }
  assert.strictEqual(S.counts().complete, 0, "a lookup counts as finished before anyone answered anything");

  // In the rendered page, "recommended" is a label; `checked` appears only where a stored answer is.
  const html = renderWorkbook(registry);
  assert.ok(/recommended<\/span>/.test(html), "the recommendation is never shown to the reader");
  for (const [question, stored] of [["cov", "h.coverage"], ["avail", "h.availability"], ["owner", "h.owner"]] as [string, string][]) {
    const template = new RegExp('name="' + question + '"[^\\n]*?\\(' + stored.replace(".", "\\.") + '===o\\.value\\?');
    assert.ok(template.test(html),
      `the ${question} option is checked by something other than the stored answer, so the page chooses for the user`);
  }
});

check("the mapping panel repaints as you type, so a fixed problem re-enables confirmation", () => {
  /**
   * Found by driving the real page, not by any assertion here. The panel was part of the card,
   * which is only rebuilt when a radio changes -- so typing the missing reason cleared the problem
   * while the confirm button stayed greyed out, with no way to press it and nothing saying why.
   * Repainting only the panel also keeps the cursor where the person is typing.
   */
  const html = renderWorkbook(registry);
  assert.ok(/<div id="mapping"><\/div>/.test(html), "the mapping panel is not its own repaintable region");
  const save = html.slice(html.indexOf("const save = () => {"), html.indexOf("/* Radios re-render"));
  assert.ok(/renderMapping\(\);/.test(save), "typing does not repaint the mapping panel, so its button state goes stale");
  const renderMapping = html.slice(html.indexOf("const renderMapping = () => {"), html.indexOf("const save = () => {"));
  assert.ok(/addEventListener\("click"/.test(renderMapping), "the repainted panel loses its confirm handler");
  // The button's enabled state is derived from the problems, not from when the card was last built.
  assert.ok(/answered && !problems\.length \? '' : ' disabled'/.test(html),
    "the confirm button is enabled by something other than the current state of the answers");
});

check("the technical detail is present, optional, and marked as observed rather than decided", () => {
  const html = renderWorkbook(registry);
  assert.ok(/<details><summary>Technical details<\/summary>/.test(html), "the technical detail is not behind a disclosure");
  assert.ok(/Why this is recommended/.test(html), "the recommendation's basis is not disclosed");
  assert.ok(/what the code/.test(html) && /not up for decision/.test(html),
    "the page does not distinguish what the code does from what is being decided");
  // The identifier and tables are in the disclosure, not in the question.
  const question = html.slice(html.indexOf("1. Can this answer tell which years"), html.indexOf("2. What would make"));
  assert.ok(!/cap\.id/.test(question), "the capability identifier is part of the coverage question itself");
});

// ---------------------------------------------------------------- 2. the translation is confirmed

check("the importer refuses a confirmation that has gone stale", () => {
  /**
   * The person confirmed one translation; the answer then changed, so the export carries an
   * approval of a mapping that is no longer the one in the file. A boolean confirmation would have
   * travelled with the edit and hidden exactly this.
   */
  const S = sessionFor();
  S.update(withYear.id, answers());
  S.confirmMapping(withYear.id);
  assert.strictEqual(S.isMappingConfirmed(withYear.id), true);
  S.update(withYear.id, { availability: "sometimes", availabilityWhen: "only after the annual load" });
  assert.strictEqual(S.isMappingConfirmed(withYear.id), false, "the confirmation survived a change to the answer");

  // Force the stale pairing into a file the way a hand edit or an older page could.
  const stale = JSON.parse(exportWith(withYear.id, answers()));
  stale.decisions[withYear.id].human.availability = "sometimes";
  stale.decisions[withYear.id].human.availabilityWhen = "only after the annual load";
  const result = importInto(JSON.stringify(stale));
  assert.strictEqual(result.ok, false, "a stale confirmation was accepted");
  assert.ok(!result.ok && result.errors.some((e) => /stale|not what this answer produces/.test(e)));

  /**
   * Isolated, because the case above also fails the re-derivation check and so proves nothing about
   * this one: here the answer and the mapping agree, and ONLY the confirmation is for a different
   * mapping. Removing the staleness check left the whole suite green until this was added.
   */
  const onlyConfirmationWrong = JSON.parse(exportWith(withYear.id, answers()));
  onlyConfirmationWrong.decisions[withYear.id].mappingConfirmed = "0000dead";
  const isolated = importInto(JSON.stringify(onlyConfirmationWrong));
  assert.strictEqual(isolated.ok, false, "a confirmation of some other mapping was accepted");
  assert.ok(!isolated.ok && isolated.errors.some((e) => /stale/.test(e)), "the refusal must say the approval is stale");
});

check("the importer re-derives the mapping and refuses one the answer does not produce", () => {
  /**
   * Trusting the file's `proposed` block would let a page -- or a hand edit -- ship policy the
   * person never saw beside the question they answered, which is the one thing a human-facing
   * workbook must not be able to do.
   */
  const tampered = JSON.parse(exportWith(withYear.id, answers()));
  tampered.decisions[withYear.id].proposed.receiptOwner = "a process nobody chose";
  const result = importInto(JSON.stringify(tampered));
  assert.strictEqual(result.ok, false, "the importer trusted the file's technical mapping");
  assert.ok(!result.ok && result.errors.some((e) => /not what this answer produces/.test(e)));
});

check("an export carries the human answer AND the mapping, never one without the other", () => {
  const exported = JSON.parse(exportWith(withYear.id, answers())) as any;
  const entry = exported.decisions[withYear.id];
  assert.ok(entry.human, "the export drops the answer the person actually gave");
  assert.ok(entry.proposed, "the export drops the technical mapping");
  assert.ok(entry.mappingConfirmed, "the export drops the confirmation");
  assert.strictEqual(entry.human.coverage, "years", "the human answer is not recorded in the person's terms");
  assert.strictEqual(entry.proposed.coverage.kind, "column", "the mapping is not recorded in technical terms");

  const withoutHuman = JSON.parse(exportWith(withYear.id, answers()));
  delete withoutHuman.decisions[withYear.id].human;
  const result = importInto(JSON.stringify(withoutHuman));
  assert.strictEqual(result.ok, false, "an entry with no human answer was imported");
  assert.ok(!result.ok && result.errors.some((e) => /no human answer/.test(e)));
});

check("draft integrity prose is preserved, and no binding is ever asked for", () => {
  const S = sessionFor();
  const own = PL.integrityScenarios(withYear).map((s: any) => s.value).slice(0, 2);
  S.update(withYear.id, answers(withYear, { integrity: own, integrityOther: "the county lookup goes missing" }));
  const proposed = S.proposal(withYear.id).proposed;
  assert.strictEqual(proposed.integrity.length, own.length + 1, "a chosen scenario or the free text was dropped");
  assert.ok(proposed.integrity.every((r: unknown) => typeof r === "string"), "a rule was recorded as something other than prose");
  assert.ok(proposed.integrity.some((r: string) => /county lookup goes missing/.test(r)), "the person's own words were lost");
  const html = renderWorkbook(registry);
  assert.ok(!/boundTo/.test(html), "the page asks the reader for a binding");
  assert.ok(/nothing here builds an automatic check/.test(html), "the page implies these rules will be executed");
});

// ---------------------------------------------------------------- 3. eligibility stays closed

check("unbound integrity prose blocks eligibility, however complete the rest of the entry is", () => {
  const declared = withYear.reads.map((name) => ({ name, requiredColumns: withYear.columns[name] ?? [] }));
  const drafted = { coverage: { kind: "column", table: yearBasis.table, yearColumn: yearBasis.yearColumn },
    integrity: ["a sentence a person wrote"], availability: { kind: "always" }, receiptOwner: "The monthly crime-trends update",
    evidence: "cited from the runbook and confirmed with the analyst who owns the pipeline" };
  assert.strictEqual(policyIsComplete(drafted), true, "a prose entry is still a well-formed, complete draft");
  assert.strictEqual(capabilityAuthorizes(drafted, declared), false, "unbound integrity prose authorized");
  const bound = { ...drafted, integrity: [{ rule: "r", boundTo: "banana" }] };
  assert.strictEqual(capabilityAuthorizes(bound, declared), false, "boundTo: \"banana\" authorized");
  for (const shape of [null, [], ["prose"], [{ rule: "r", boundTo: "checks/real.sql" }], "anything"]) {
    assert.strictEqual(integrityIsExecutable(shape), false, `${JSON.stringify(shape)} was treated as executable`);
  }
  assert.ok(authorizationBlockers(drafted, declared).some((b) => /no integrity rule can be executed/.test(b)));

  const runtime = fs.readFileSync(path.join(process.cwd(), "lib", "source-health.ts"), "utf8");
  assert.ok(!/if \(!policyIsComplete\(/.test(runtime), "the runtime gates on a weaker predicate than the registry pin");
  assert.ok(/capabilityAuthorizes\(spec\.policy/.test(runtime), "the runtime does not gate on capabilityAuthorizes");

  const inventory = fs.readFileSync(path.join(process.cwd(), "lib", "source-health-inventory.ts"), "utf8");
  assert.ok(!/authorizationEligible: true/.test(inventory), "a capability is pinned eligible while nothing is executable");
  assert.ok(/Authorization-eligible: 0\./.test(inventory), "the inventory header claims an eligible capability");
});

check("a full set of answers records policy and still authorizes nothing", () => {
  const result = importInto(exportWith(withYear.id, answers()));
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  assert.deepStrictEqual(result.decided, [withYear.id], "a complete answer was not recorded");
  assert.deepStrictEqual(result.eligible, [], "a complete answer switched a capability on");
  const stored = result.policy[withYear.id] as Record<string, unknown>;
  assert.deepStrictEqual(stored.coverage, { kind: "column", table: yearBasis.table, yearColumn: yearBasis.yearColumn });
  assert.deepStrictEqual(stored.availability, { kind: "always" });
});

// ---------------------------------------------------------------- 4. coverage

check("a lookup with no year-like column recommends the honest answer, and can still name a column", () => {
  const options = PL.coverageOptions(withoutYear);
  const recommended = options.find((o: any) => o.recommended);
  assert.strictEqual(recommended.value, "no-years", "a lookup with no year column recommends bounding it by one anyway");
  assert.ok(/none of the columns this uses looks like a year/i.test(recommended.why), "the recommendation gives no basis");

  // The honest answer stays reachable: the naming heuristic must not make a real year column unusable.
  const S = sessionFor();
  const column = withoutYear.coverageCandidates[0];
  S.update(withoutYear.id, answers(withoutYear, {
    coverage: "years", coverageColumn: { table: column.table, yearColumn: column.yearColumn }, coverageReason: "",
  }));
  assert.ok(S.problems(withoutYear.id).some((p: string) => /not named like a year/.test(p)),
    "an unmarked column was accepted with no reason given");
  S.update(withoutYear.id, { coverageReason: "this column stores an ISO date whose first four characters are the year" });
  assert.deepStrictEqual(S.problems(withoutYear.id), [], "a justified unmarked column is still refused");
  const proposed = S.proposal(withoutYear.id).proposed;
  assert.strictEqual(proposed.coverage.justification, "this column stores an ISO date whose first four characters are the year");
});

check("\"not about a time period\" is recorded as a decision with its reason", () => {
  const S = sessionFor();
  S.update(withYear.id, answers(withYear, { coverage: "no-years", coverageReason: "" }));
  assert.ok(S.problems(withYear.id).some((p: string) => /not about a time period/.test(p)), "a reasonless answer was accepted");
  S.update(withYear.id, { coverageReason: "this is a directory count with no time dimension to bound" });
  const proposed = S.proposal(withYear.id).proposed;
  assert.deepStrictEqual(proposed.coverage, { kind: "none", reason: "this is a directory count with no time dimension to bound" });
  S.confirmMapping(withYear.id);
  const result = importInto(S.serialize());
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  assert.notStrictEqual((result.policy[withYear.id] as any).coverage, null, "a decided no-year answer was stored as undecided");
});

check("a basis outside the contract is refused at import even if the page emitted it", () => {
  const tampered = JSON.parse(exportWith(withYear.id, answers()));
  tampered.decisions[withYear.id].human.coverageColumn = { table: "unrelated_table", yearColumn: "year" };
  const result = importInto(JSON.stringify(tampered));
  assert.strictEqual(result.ok, false, "a basis outside the contract was accepted");
});

// ---------------------------------------------------------------- 5. export, merge, withdrawal

check("the export carries only what this session changed", () => {
  const S = sessionFor();
  assert.deepStrictEqual(S.changeSet(), {}, "an untouched session exports something");
  S.update(withYear.id, answers());
  assert.deepStrictEqual(Object.keys(S.changeSet()), [withYear.id], "the change set is not exactly what changed");
  assert.ok(withYear.id in JSON.parse(S.serialize()).basedOn, "a change records no baseline");
});

check("importing a change set preserves capabilities it does not mention", () => {
  const other = model.find((c) => c.id !== withYear.id)!;
  const prior = recordWith(other.id, answers(other));
  const result = importDecisions(exportWith(withYear.id, answers()), registry, prior);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  assert.ok(other.id in result.policy, "an entry the change set never mentioned was deleted by importing");
});

check("a change authored against a stale baseline is refused by name", () => {
  const theirs = recordWith(withYear.id, answers(withYear, {
    evidence: "someone else answered this first, against a different understanding of the pipeline",
  }));
  const result = importDecisions(exportWith(withYear.id, answers()), registry, theirs);
  assert.strictEqual(result.ok, false, "an import overwrote an entry that changed underneath it");
  assert.ok(!result.ok && result.errors.some((e) => e.includes(withYear.id) && /changed since this session began/.test(e)));
});

check("two sessions cannot silently overwrite each other's answer on an unconfirmed capability", () => {
  /**
   * The conflict check compared what the record DERIVES. An unconfirmed answer derives nothing, so
   * two people who opened the workbook on the same open capability both compared equal to null, and
   * the second import replaced the first's authoritative human answer with no conflict raised, no
   * warning printed, and nothing in the output to notice afterwards.
   */
  const opened = importInto(exportWith(withYear.id, answers(), false));
  assert.ok(opened.ok, JSON.stringify(!opened.ok && opened.errors));
  if (!opened.ok) return;
  assert.strictEqual((opened.entries[withYear.id] as { kind: string }).kind, "open",
    "this fixture cannot show anything: the entry is not an unconfirmed one");
  const start = { docs: opened.docs, entries: opened.entries };

  /**
   * Two people open the SAME page, answer differently, and neither confirms. Both answers derive
   * no policy, which is precisely what made them indistinguishable: leave one of them confirmed
   * and the derived baseline moves, so the older check would have caught it and this would prove
   * nothing about the new one.
   */
  const A = workbookSession(start);
  A.update(withYear.id, answers(withYear, { evidence: "session A: confirmed with the analyst who runs the monthly load" }));
  const B = workbookSession(start);
  B.update(withYear.id, answers(withYear, { evidence: "session B: read the runbook, and never spoke to anyone about it" }));

  const first = importDecisions(A.serialize(), registry, start);
  assert.ok(first.ok, JSON.stringify(!first.ok && first.errors));
  if (!first.ok) return;
  assert.deepStrictEqual(first.open, [withYear.id], "the fixture stopped being an unconfirmed answer");
  assert.strictEqual(first.policy[withYear.id], undefined,
    "this fixture cannot show anything: the answer derives policy, so the derived baseline would move");
  const landed = { docs: first.docs, entries: first.entries };
  const second = importDecisions(B.serialize(), registry, landed);
  assert.strictEqual(second.ok, false, "the second session silently replaced the first session's answer");
  assert.ok(!second.ok && second.errors.some((e) => e.includes(withYear.id) && /changed since this session began/.test(e)),
    "the refusal does not name the capability whose answer would have been lost");
  assert.match((first.entries[withYear.id] as unknown as { human: { evidence: string } }).human.evidence, /session A/,
    "the first session's answer is not what the record holds");

  /**
   * And it cannot be laundered by loading the stale file into a page generated afterwards. If the
   * load adopted the current baseline, re-exporting would present the same overwrite as a clean
   * import -- which is how the stale-session defect worked the last time.
   */
  const later = workbookSession(landed);
  assert.ok(later.loadSession(JSON.parse(B.serialize())).ok, "the stale session did not load");
  assert.strictEqual(later.recordBaselineFor(withYear.id), B.recordBaselineFor(withYear.id),
    "loading refreshed the baseline to the current record, so re-exporting would hide the conflict");
  assert.strictEqual(importDecisions(later.serialize(), registry, landed).ok, false,
    "a stale session was laundered through the page into a clean import");
});

check("a second session cannot overwrite an answer that happens to derive the same policy", () => {
  /**
   * Two materially different answers can produce byte-identical policy: the reason someone gives
   * for a coverage basis is part of what they said and is not part of the mapping when the column
   * is named like a year. Comparing the derived policy saw no conflict at all, so the second import
   * overwrote the first person's stated reasoning while every technical field stayed the same.
   */
  const base = recordWith(withYear.id, answers(withYear, { coverageReason: "the pipeline owner named this column" }));
  const start = { docs: base.docs, entries: base.entries };

  const A = workbookSession(start);
  assert.ok(A.update(withYear.id, { coverageReason: "session A: the runbook names this column as the load key" }),
    "editing the reason was not treated as a change to the answer");
  const afterA = importDecisions(A.serialize(), registry, start);
  assert.ok(afterA.ok, JSON.stringify(!afterA.ok && afterA.errors));
  if (!afterA.ok) return;
  assert.deepStrictEqual(afterA.policy[withYear.id], base.policy[withYear.id],
    "this fixture cannot show anything: the two answers derive different policy, which the old check would catch");
  assert.match((afterA.entries[withYear.id] as unknown as { human: { coverageReason: string } }).human.coverageReason, /session A/,
    "the first session's answer was not recorded");

  const B = workbookSession(start);
  B.update(withYear.id, { coverageReason: "session B: I picked it because it was the only one offered" });
  const second = importDecisions(B.serialize(), registry, { docs: afterA.docs, entries: afterA.entries });
  assert.strictEqual(second.ok, false, "a second answer overwrote the first because the policy they derive is identical");
  assert.ok(!second.ok && second.errors.some((e) => e.includes(withYear.id) && /changed since this session began/.test(e)),
    "the refusal does not name the capability whose answer would have been lost");
});

check("withdrawal is a named act, never inferred from unanswered questions", () => {
  const prior = recordWith(withYear.id, answers());
  const S = sessionFor({ [withYear.id]: prior.policy[withYear.id] as Record<string, unknown> }, prior.entries);
  assert.strictEqual(S.canWithdraw(withYear.id), true, "an authored capability is not withdrawable");
  assert.strictEqual(sessionFor().canWithdraw(withYear.id), false, "an unauthored capability offers withdrawal");
  S.withdraw(withYear.id);
  assert.deepStrictEqual(S.changeSet()[withYear.id], { operation: "withdraw" });
  const result = importDecisions(S.serialize(), registry, prior);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  assert.deepStrictEqual(result.cleared, [withYear.id]);
  assert.ok(!(withYear.id in result.policy), "the withdrawn entry survived");

  const html = renderWorkbook(registry);
  assert.ok(/Remove the recorded policy/.test(html), "the page never offers removal");
  assert.ok(/confirm\("Remove the recorded policy/.test(html), "removal is not confirmed");
});

// ---------------------------------------------------------------- 6. sessions

check("a stale session cannot be laundered through the page into a fresh fingerprint", () => {
  const S = sessionFor();
  const stale = JSON.parse(exportWith(withYear.id, answers()));
  stale.contractFingerprint = "deadbeefdeadbeef";
  const result = S.loadSession(stale);
  assert.strictEqual(result.ok, false, "a stale session loaded");
  assert.ok(result.stale && /different registry structure/.test(result.reason));
  assert.deepStrictEqual(S.changeSet(), {}, "the stale answers were copied in and would be re-exported as current");
  assert.strictEqual(S.isDirty(), false, "refusing a load left the session dirty");
});

check("loading replaces the session, and will not silently absorb unsaved work", () => {
  const other = model.find((c) => c.id !== withYear.id)!;
  const S = sessionFor();
  S.update(other.id, answers(other));
  const file = JSON.parse(exportWith(withYear.id, answers()));
  const refused = S.loadSession(file);
  assert.strictEqual(refused.ok, false, "loading over unsaved work happened without asking");
  assert.ok(refused.needsConfirmation, "the refusal is not a confirmable one");
  assert.ok(other.id in S.changeSet(), "the refused load discarded the work it was warning about");
  assert.ok(S.loadSession(file, { discardUnsaved: true }).ok, "confirming did not let the load proceed");
  assert.deepStrictEqual(Object.keys(S.changeSet()), [withYear.id], "work from before the load survived, now marked saved");
  assert.strictEqual(S.isDirty(), false);
});

check("successive loads cannot restore a baseline from an earlier one", () => {
  const authored = { coverage: null, integrity: null, availability: null, receiptOwner: "repository value", evidence: "repo" };
  const S = sessionFor({ [withYear.id]: authored });
  const older = { ...authored, receiptOwner: "an older value" };
  const first = JSON.parse(exportWith(withYear.id, answers()));
  first.basedOn[withYear.id] = older;
  assert.ok(S.loadSession(first).ok);
  assert.strictEqual(S.baselineFor(withYear.id).receiptOwner, "an older value", "the load did not adopt the file's baseline");
  assert.ok(S.loadSession({ v: DECISIONS_VERSION, contractFingerprint: FINGERPRINT, decisions: {}, basedOn: {}, basedOnEntry: {} }).ok);
  assert.deepStrictEqual(S.baselineFor(withYear.id), authored,
    "an empty load left the previous file's baseline in place, so the repository value was lost");
  assert.deepStrictEqual(S.changeSet(), {}, "a session reset to the repository value still reports changes");
});

check("a session written by a different version is refused rather than misread", () => {
  const result = sessionFor().loadSession({ v: DECISIONS_VERSION - 1, contractFingerprint: FINGERPRINT, decisions: {}, basedOn: {}, basedOnEntry: {} });
  assert.strictEqual(result.ok, false);
  assert.ok(/version/.test(result.reason));
});

check("the page tracks unsaved work and guards the close only when there is something to lose", () => {
  const S = sessionFor();
  assert.strictEqual(S.isDirty(), false);
  S.update(withYear.id, answers());
  assert.strictEqual(S.isDirty(), true, "an answer is not unsaved work");
  S.serialize(); S.markClean();
  assert.strictEqual(S.isDirty(), false, "exporting did not save the work");
  const html = renderWorkbook(registry);
  const handler = /addEventListener\("beforeunload"[\s\S]{0,320}/.exec(html);
  assert.ok(handler && /if \(!S\.isDirty\(\)\) return;/.test(handler[0]), "the close guard is unconditional or missing");
  assert.ok(/Export every few answers/.test(html), "the page never suggests exporting periodically");
});

// ---------------------------------------------------------------- 7. the capability set

check("every decidable capability appears exactly once, sweep-only included", () => {
  const ids = model.map((c) => c.id);
  assert.deepStrictEqual([...ids].sort(), Object.keys(DECIDABLE).sort(), "the workbook is not the decidable registry");
  assert.strictEqual(new Set(ids).size, ids.length, "a capability appears more than once");
  for (const id of SWEEP_ONLY_IDS) {
    const cap = model.find((c) => c.id === id);
    assert.ok(cap, `${id} is missing from the workbook`);
    const S = sessionFor();
    S.update(id, answers(cap!));
    S.confirmMapping(id);
    assert.ok(importInto(S.serialize()).ok, `${id} cannot be answered and imported`);
  }
});

check("an authored sweep-only capability reaches the runtime inventory", () => {
  const generator = fs.readFileSync(path.join(process.cwd(), "scripts", "generate-source-health-inventory.ts"), "utf8");
  const sweepRender = /for \(const sweep of SWEEP_ONLY_SPECS\)[\s\S]{0,400}?\n  \}/.exec(generator);
  assert.ok(sweepRender, "the sweep-only rendering loop is not in the expected form");
  assert.ok(!/,\s*null\)\);/.test(sweepRender![0]), "sweep-only capabilities are still rendered with a hardcoded null policy");
  assert.ok(/authoredPolicy\[sweep\.capabilityId\]/.test(sweepRender![0]), "they do not read the authored policy source");
  for (const [what, pattern] of [["authored", /const authored =[\s\S]{0,240}?SWEEP_ONLY_SPECS/],
    ["eligible", /const eligibleCount =[\s\S]{0,320}?SWEEP_ONLY_SPECS/]] as [string, RegExp][]) {
    assert.ok(pattern.test(generator), `the ${what} count excludes sweep-only capabilities`);
  }
  const inventory = fs.readFileSync(path.join(process.cwd(), "lib", "source-health-inventory.ts"), "utf8");
  const header = /Capabilities: (\d+) \((\d+) operation-backed \+ (\d+) sweep-only\)/.exec(inventory);
  assert.ok(header && Number(header[1]) === Number(header[2]) + Number(header[3]), "the header's counts do not add up");
  assert.strictEqual(Number(header![1]), Object.keys(DECIDABLE).length, "the inventory and the workbook disagree");
});

check("the workbook has no capability list of its own to drift", () => {
  const synthetic = { "shr::t_solo::t_solo(year)": {
    artifact: "shr", prepDependencies: [], emittedDependencies: ["t_solo"],
    requiredColumns: { t_solo: ["year"] }, flagKey: "PROOF_CAPABILITY_SHR_DEADBEEF",
    policy: null, authorizationEligible: false,
  } } as Record<string, RegistryEntry>;
  const ids = buildWorkbookModel(synthetic).map((c) => c.id);
  assert.deepStrictEqual([...ids].sort(), ["shr::t_solo::t_solo(year)", ...SWEEP_ONLY_IDS].sort());
  /**
   * Asserted on the EMBEDDED capability list, not on the whole page: the reviewed catalog is
   * inlined verbatim and legitimately names every real capability, so a substring search over the
   * page would fail for the wrong reason.
   */
  const html = renderWorkbook(synthetic, catalogCovering(ids));
  const embedded = JSON.parse(html.slice(html.indexOf("const DATA = ") + "const DATA = ".length,
    html.indexOf("\n/* Your answers live only")).trim().replace(/;$/, "")) as { capabilities: { id: string }[] };
  assert.deepStrictEqual(embedded.capabilities.map((c) => c.id).sort(), [...ids].sort(),
    "the workbook carried a capability from the real registry into a synthetic one");
});

check("an invented capability cannot be imported", () => {
  const exported = JSON.parse(exportWith(withYear.id, answers()));
  exported.decisions["shr::invented::nothing(x)"] = exported.decisions[withYear.id];
  exported.basedOn["shr::invented::nothing(x)"] = null;
  const result = importInto(JSON.stringify(exported));
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.errors.some((e) => /not a capability in the registry/.test(e)));
});

// ---------------------------------------------------------------- 8. no activation

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
  assert.ok(!html.includes("capability-policy.json"), "the workbook names the policy source it must not touch");
  assert.ok(/download = "stage2b-policy-decisions.json"/.test(html), "the workbook must export to a file");
  const importer = fs.readFileSync(path.join(process.cwd(), "scripts", "import-stage2b-decisions.ts"), "utf8");
  assert.ok(!/PROOF_CAPABILITY|PROOF_MODE|flagKey/.test(importer), "the importer touches flags");
});

check("exact keys are enforced at every level", () => {
  const declared = withYear.reads.map((name) => ({ name, requiredColumns: withYear.columns[name] ?? [] }));
  const base = { coverage: { kind: "column", table: yearBasis.table, yearColumn: yearBasis.yearColumn },
    integrity: ["a rule"], availability: { kind: "always" }, receiptOwner: "owner",
    evidence: "cited from the runbook and confirmed with the analyst who owns it" };
  for (const [what, policy] of [
    ["availability variant", { ...base, availability: { kind: "always", observedAvailable: true } }],
    ["coverage", { ...base, coverage: { ...base.coverage, yearBearing: false } }],
    ["top-level decision", { ...base, derivedFrom: "an observation that is not a decision" }],
  ] as [string, Record<string, unknown>][]) {
    assert.ok(policyShapeErrors(policy).length > 0, `${what}: an unknown key produced no shape error`);
    assert.strictEqual(capabilityAuthorizes(policy, declared), false, `${what}: an unknown key still authorized`);
  }
  // And an unknown key on the change-set entry itself is refused.
  const exported = JSON.parse(exportWith(withYear.id, answers()));
  exported.decisions[withYear.id].smuggled = true;
  const result = importInto(JSON.stringify(exported));
  assert.strictEqual(result.ok, false, "an unknown entry key was accepted");
});

// ---------------------------------------------------------------- 9. the documents

check("the authored record documents what it is, and the generated file says it is generated", () => {
  const record = JSON.parse(fs.readFileSync(AUTHORED_FILE, "utf8")) as any;
  const readme = JSON.stringify(record._README);
  assert.ok(/THE ONE AUTHORED SOURCE/.test(readme), "the record does not say it is the authored source");
  assert.ok(/DERIVED from this file/.test(readme), "the record does not say policy is derived from it");
  assert.ok(/atomic rename/.test(readme), "the record does not record how it is written");
  for (const kind of ["decided", "open", "legacy"]) {
    assert.ok(record._README.entry_kinds[kind], `the record does not document its "${kind}" entries`);
  }
  assert.ok(/authorizes nothing/.test(record._README.entry_kinds.legacy), "legacy entries are not documented as non-authorizing");
  assert.ok(/No capability is authorization-eligible/.test(readme), "the record does not record that nothing is eligible");

  const generated = JSON.parse(fs.readFileSync(GENERATED_POLICY_FILE, "utf8")) as any;
  assert.ok(/DO NOT EDIT BY HAND/.test(JSON.stringify(generated._README)), "the generated file does not warn against editing");
  assert.ok(/capability-answers\.json/.test(JSON.stringify(generated._README)), "the generated file does not name its source");
});

check("the authoritative plan documents the shape that is actually enforced", () => {
  const plan = fs.readFileSync(path.join(process.cwd(), "docs", "superpowers", "plans",
    "2026-08-13-stage2-source-health-registry.md"), "utf8");
  assert.ok(!/coverage: \{ table: string; yearColumn: string \} \| null/.test(plan), "the plan keeps the obsolete coverage shape");
  assert.ok(/kind: "none"; reason: string/.test(plan), "the plan lacks the no-year-dimension variant");
  assert.ok(/boundTo: string/.test(plan) && /NEITHER AUTHORIZES TODAY/.test(plan), "the plan misstates integrity's authority");
  assert.ok(/coverage\.kind === "none"/.test(plan), "the plan's evaluator ignores the no-year-dimension answer");
});

// ---------------------------------------------------------------- 10. the embedding boundary

check("embedded content cannot end the script element or the statement it sits in", () => {
  const hostile = "t_x" + "</scr" + "ipt><b>" + String.fromCharCode(0x2028) + String.fromCharCode(0x2029);
  const synthetic = { [`shr::${hostile}::${hostile}(year)`]: {
    artifact: "shr", prepDependencies: [], emittedDependencies: [hostile],
    requiredColumns: { [hostile]: ["year"] }, flagKey: "PROOF_CAPABILITY_SHR_DEADBEEF",
    policy: null, authorizationEligible: false,
  } } as Record<string, RegistryEntry>;
  const html = renderWorkbook(synthetic, catalogCovering(buildWorkbookModel(synthetic).map((c) => c.id)));
  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script, "no script block survived");
  try { new Function(script![1]); }
  catch (error) { assert.fail(`hostile content broke the page: ${(error as Error).message}`); }
  const embedded = JSON.parse(script![1].slice(script![1].indexOf("const DATA = ") + "const DATA = ".length,
    script![1].indexOf("\n/* Your answers live only")).trim().replace(/;$/, "")) as { capabilities: { id: string }[] };
  assert.ok(embedded.capabilities.some((c) => c.id.includes(hostile)), "escaping corrupted the data it protected");
});

check("owner candidates are evidence from a filename search, never presented as the answer", () => {
  for (const capability of model) {
    for (const candidate of capability.ownerCandidates) {
      assert.ok(fs.existsSync(path.join(process.cwd(), "scripts", candidate)),
        `${capability.id}: offers ${candidate}, which does not exist`);
    }
  }
  const html = renderWorkbook(registry);
  assert.ok(/a filename search, not an answer/.test(html), "filenames are not framed as a search result");
  // The owner question itself offers processes, not filenames.
  for (const option of PL.ownerOptions(withYear)) {
    assert.ok(!/\.(py|ts|js|sql)$/.test(option.value), `the owner question offers the filename ${option.value}`);
  }
});

console.log(`\nstage2b workbook: ${passed} passed, ${failed} failed`);
