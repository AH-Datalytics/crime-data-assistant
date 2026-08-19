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
  CARD_MODULE_FILE, CATALOG_MODULE_FILE, DECISIONS_VERSION, PLAIN_LANGUAGE_MODULE_FILE, SESSION_MODULE_FILE,
  WORKBOOK_FILE, buildWorkbookModel, decidableRegistry, loadCatalog, registryFingerprint,
  renderWorkbook, workbookFingerprint,
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
  authorizationBlockers, authorizesApartFromIntegrity, capabilityAuthorizes, coverageBasisErrors,
  integrityIsExecutable, isYearBearingColumn, policyIsComplete, policyShapeErrors,
} from "../lib/capability-policy";
import { SWEEP_ONLY_IDS } from "../lib/sweep-only-capabilities";

const require = createRequire(import.meta.url);
/** The same files the page inlines. Imported, so these tests exercise behaviour rather than text. */
const { createStage2bSession } = require(SESSION_MODULE_FILE) as { createStage2bSession: (d: unknown, pl?: unknown) => any };
const { createStage2bPlainLanguage } = require(PLAIN_LANGUAGE_MODULE_FILE) as { createStage2bPlainLanguage: (c?: unknown) => any };
const { createStage2bCard } = require(CARD_MODULE_FILE) as { createStage2bCard: (pl: unknown) => any };
const CATALOG = loadCatalog();
const PL = createStage2bPlainLanguage(CATALOG);
const CARD = createStage2bCard(PL);

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
/**
 * A question that reads EXACTLY ONE dated field, so its basis settles automatically.
 *
 * "Some dated field" is not enough any more: twenty-three questions read several, and for those
 * nothing is chosen at all. A fixture with more than one would put most of this file on the
 * engineering-follow-up path and stop exercising the resolved one.
 */
const withYear = model.find((c) => c.coverageCandidates.filter((o) => o.yearBearing).length === 1)!;
const yearBasis = withYear.coverageCandidates.find((o) => o.yearBearing)!;
/**
 * A question where a year genuinely matters and there is nothing dated to read.
 *
 * The engineering-follow-up fixture: the human judgment is "yes" -- homicides happen on a date --
 * while the answer itself carries no date. Selected by both properties, so it cannot drift into
 * being a capability where "no" was simply the right answer.
 */
const withoutYear = model.find((c) => !c.coverageCandidates.some((o) => o.yearBearing)
  && (CATALOG.yearAdvice(c.id) || {}).recommend === "yes")!;

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

/**
 * The card a person actually reads, as markup, for one capability.
 *
 * The whole reason the card is a module. Asserting "does the deciding path avoid database
 * language?" over the finished page is impossible -- the page inlines its own source code, so every
 * search hits a comment or an identifier. Here the card is called, and what comes back is only what
 * would be displayed.
 */
function renderedCard(cap: { id: string }, session: any = sessionFor()) {
  return CARD.primary(cap, session, "1 of " + model.length) + CARD.summaryPanel(cap, session);
}
/**
 * The deciding path with the collapsed disclosure removed.
 *
 * The disclosure is where tables and columns are allowed to live; everything left is what a person
 * has to read in order to answer, and it is held to a vocabulary they can follow.
 */
function primarySurface(cap: { id: string }, session: any = sessionFor()) {
  return renderedCard(cap, session).replace(/<details class="technical">[\s\S]*?<\/details>/g, "");
}
/** Visible text only: markup, attribute values and entities stripped. What a reader sees. */
function visibleText(markup: string) {
  return markup.replace(/<[^>]*>/g, " ").replace(/&mdash;/g, "—").replace(/&middot;/g, "·")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
}

/** A complete set of plain-language answers, as a person clicking through would produce. */
const answers = (cap = withYear, over: Record<string, unknown> = {}) => ({
  ...PL.blankAnswer(),
  /** "Yes" only where something dated can actually be read; otherwise the honest answer resolves. */
  coverage: PL.automaticYearBasis(cap) ? "years" : "no-years",
  /** Every listed problem answered, all with the one response the policy can express today. */
  trust: Object.fromEntries(PL.trustScenarios(cap).map((s: any) => [s.value, "refuse"])),
  availability: "always",
  owner: PL.responsibilityOptions(cap)[0].value,
  /** Deliberately EMPTY: notes are optional, and a complete answer must not need them. */
  notes: "",
  ...over,
});
/** All listed problems set to one response. Used where the action itself is what is being tested. */
const allTrust = (cap: { id: string }, action: string) =>
  Object.fromEntries(PL.trustScenarios(cap).map((s: any) => [s.value, action]));

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
  example: () => "a synthetic asking of it",
  source: () => "A synthetic data source",
  yearAdvice: () => ({ recommend: "no", why: "a synthetic reason, for a structural test" }),
  yearBasis: () => null,
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
    const named = PL.responsibilityOptions(cap).filter((o: any) => !["other", "not-ours", PL.UNSURE].includes(o.value));
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
    const named = PL.responsibilityOptions(cap).filter((o: any) => !["other", "not-ours", PL.UNSURE].includes(o.value));
    assert.ok(named.length < 3, `${cap.id}: still offers every process for its data source`);
  }
  // "Something else" and "I'm not sure" remain everywhere, so narrowing never traps anyone.
  for (const cap of model) {
    const values = PL.responsibilityOptions(cap).map((o: any) => o.value);
    assert.ok(values.includes("other") && values.includes(PL.UNSURE), `${cap.id}: narrowing removed the escape hatches`);
  }
});

check("the failure scenarios offered are the ones that fit this data", () => {
  const perCapability = new Map<string, string>();
  for (const cap of model) {
    const scenarios = PL.trustScenarios(cap);
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
  assert.ok(PL.trustScenarios(crosswalk).some((s: any) => s.value === "crosswalk"),
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
    ["a question heading", "1. Should the chatbot be able to say “we don’t have that year”?",
      "1. Should the chatbot be able to say “we do not have that year”?"],
    ["the judgment a question asks for", "Is it normal for this data to be missing sometimes?",
      "Is it usual for this data to be missing sometimes?"],
    ["what an answer is said to control", "Whether missing data is reported as a fault, or as an answer we simply do not have.",
      "Whether missing data is reported as a fault, or as an answer we do not have."],
    ["what an answer is said to do", "Missing data should be treated as a problem that needs attention.",
      "Missing data should be treated as a problem that needs attention within a day."],
    ["an option label", "Yes — year matters for this answer.",
      "Yes — the year matters for this answer."],
    ["a label on the plain-language summary", 'availability: "If it is missing"', 'availability: "When it is missing"'],
  ];

  /**
   * The per-capability wording lives in the reviewed catalog, so it is mutated at ITS source. The
   * example and the recommendation's reason are both read before deciding, so both are identity.
   */
  const realCatalogSource = fs.readFileSync(CATALOG_MODULE_FILE, "utf8");
  const catalogFrom = (source: string) =>
    (new Function(source + "\nreturn stage2bCapabilityCatalog;")() as () => any)();
  const catalogCases: [string, string, string][] = [
    ["the example someone might ask", "Is Chicago in the recent crime trends data?",
      "Is Chicago in the recent crime-trends data?"],
    ["a recommendation's reason", "This answer matches a department name to an agency record.",
      "This answer maps a department name to an agency record."],
  ];
  for (const [what, from, to] of catalogCases) {
    assert.ok(realCatalogSource.includes(from), `this test is stale: the catalog no longer contains ${what}`);
    const mutatedCatalog = catalogFrom(realCatalogSource.replace(from, to));
    assert.notStrictEqual(
      workbookFingerprint(registry, mutatedCatalog, {
        plainLanguage: createStage2bPlainLanguage(mutatedCatalog), translationSource: realSource }),
      FINGERPRINT, `changing ${what} left every confirmation valid`);
  }
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
    "1. Should the chatbot be able to say “we don’t have that year”?",
    "1. Should the chatbot be able to say “we do not have that year”?"));
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
  const generator = fs.readFileSync(path.join(process.cwd(), "scripts", "generate-stage2b-workbook.ts"), "utf8");
  const wording = PL.questions();
  const card = renderedCard(withYear);
  for (const [where, text] of [
    ["year heading", wording.year.heading],
    ["trust heading", wording.trust.heading],
    ["availability heading", wording.availability.heading],
    ["responsibility heading", wording.responsibility.heading],
    ["notes heading", wording.notes.heading],
    ["summary heading", wording.summary.heading],
    ["what-is-being-decided heading", wording.card.decisionHeading],
    ["what-this-answers heading", wording.card.answersHeading],
  ] as [string, string][]) {
    assert.ok(html.includes(text), `the ${where} in the contract does not appear on the page`);
    /**
     * Asserted against the GENERATOR's own source, not the finished page. The page legitimately
     * contains every one of these strings -- it inlines the module that defines them -- so a search
     * over the page cannot tell "read from the contract" from "typed into the template". Only the
     * template can be checked for having its own copy.
     */
    assert.ok(!generator.includes(text), `the page template hard-codes the ${where} instead of reading it from the contract`);
  }
  for (const heading of [wording.year.heading, wording.trust.heading, wording.summary.heading]) {
    assert.ok(card.includes(heading), `the ${heading} is not on the card a person reads`);
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

  // It is stamped with BOTH inputs it is a function of, and refused when either no longer matches.
  const raw = JSON.parse(fs.readFileSync(GENERATED_POLICY_FILE, "utf8")) as Record<string, unknown>;
  assert.deepStrictEqual(raw._generatedFrom, { record: recordDigest(AUTHORED_FILE), contract: FINGERPRINT },
    "the generated policy is not stamped with both the record and the contract it was derived under");
  assert.ok(/DO NOT EDIT BY HAND/.test(JSON.stringify(raw._README)), "the generated file does not say it is generated");
  assert.doesNotThrow(() => loadGeneratedPolicy(FINGERPRINT), "the canonical loader refuses the current pair");
});

check("the workbook a person opens is the workbook this suite exercises", () => {
  /**
   * Everything asserted here is asserted about `renderWorkbook()`. The file someone actually opens
   * is a checked-in artifact of it, and nothing tied the two together: a change to the generator,
   * the catalog or the inlined logic left a stale page on disk that every test above would still
   * pass. The page is the product; a green suite over a page nobody is running is the exact shape
   * of defect this file exists to stop.
   */
  assert.strictEqual(fs.readFileSync(WORKBOOK_FILE, "utf8"), renderWorkbook(),
    `${path.relative(process.cwd(), WORKBOOK_FILE)} is not what the generator emits, so the page being `
    + "opened is not the page these tests exercise. Run: npx tsx scripts/generate-stage2b-workbook.ts");
});

check("no consumer silently trusts a policy that lags its source", () => {
  /**
   * A generated file that quietly falls behind is the two-record defect again, just slower to
   * notice. Every reader goes through the loader, and the loader fails closed.
   */
  const stale = path.join(DATA_DIR, "policy-stale-probe.json");
  const current = JSON.parse(fs.readFileSync(GENERATED_POLICY_FILE, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(stale, JSON.stringify(
    { ...current, _generatedFrom: { record: "0000000000000000", contract: FINGERPRINT } }, null, 2));
  try {
    assert.throws(() => loadGeneratedPolicy(FINGERPRINT, stale), /generated from a different version/,
      "a policy stamped with the wrong source was accepted");
    assert.throws(() => loadGeneratedPolicy(FINGERPRINT, path.join(DATA_DIR, "absent-policy.json")), /has not been generated/,
      "a missing generated policy was tolerated");
    // A stamp of the old shape names only one input and cannot pin the file; it is refused, not read.
    fs.writeFileSync(stale, JSON.stringify({ ...current, _generatedFrom: recordDigest(AUTHORED_FILE) }, null, 2));
    assert.throws(() => loadGeneratedPolicy(FINGERPRINT, stale), /different version/,
      "a policy stamped the old way, with the record alone, was accepted");
  } finally { fs.rmSync(stale, { force: true }); }

  // The consumers read through it rather than opening the file themselves.
  for (const file of ["scripts/generate-source-health-inventory.ts", "scripts/test-operation-taxonomy.ts"]) {
    const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert.ok(/loadGeneratedPolicy/.test(text), `${file} does not read policy through the canonical loader`);
    assert.ok(!/readFileSync\([^)]*capability-policy\.json/.test(text),
      `${file} opens the generated policy directly, so it can be handed a stale one`);
  }
});

check("a generated policy is refused when the CONTRACT moves, even though the record has not", () => {
  /**
   * Policy is a function of the record AND the contract: a decided entry stands down when the
   * wording it was confirmed against changes. The freshness stamp named only the record, so
   * re-wording a question without touching `capability-answers.json` left the old generated file
   * looking current -- its record digest still matched -- and the loader kept handing out policy
   * whose confirmation had expired. That is the gap this closes.
   *
   * The contract here moves because a REAL question is re-worded in the production module, not
   * because a digest was substituted; a fabricated fingerprint would only prove the loader compares
   * the two strings it is handed.
   */
  const realSource = fs.readFileSync(PLAIN_LANGUAGE_MODULE_FILE, "utf8");
  const heading = "1. Should the chatbot be able to say “we don’t have that year”?";
  assert.ok(realSource.includes(heading), "this test is stale: the module no longer asks that question");
  const rewordedSource = realSource.replace(heading, "1. Should the chatbot be able to say “we do not have that year”?");
  const plFrom = (source: string) =>
    (new Function(source + "\nreturn createStage2bPlainLanguage;")() as (c: unknown) => any)(CATALOG);
  const movedContract = workbookFingerprint(registry, CATALOG,
    { plainLanguage: plFrom(rewordedSource), translationSource: rewordedSource });
  assert.notStrictEqual(movedContract, FINGERPRINT, "re-wording a real question did not move the contract");

  /**
   * A record with a confirmed decision, and the policy it derived under the contract of the day.
   * Under the moved contract that same record derives NOTHING for it, so the generated file below
   * is stale in its CONTENT -- not merely in its stamp.
   */
  const prior = recordWith(withYear.id, answers());
  const underOld = derivePolicy(prior.entries, model, PL, FINGERPRINT);
  assert.ok(withYear.id in underOld.policy, "the fixture did not derive policy under the current contract");
  const underNew = derivePolicy(prior.entries, model, PL, movedContract);
  assert.deepStrictEqual(underNew.expired, [withYear.id], "the confirmation did not expire with the wording");
  assert.ok(!(withYear.id in underNew.policy),
    "this fixture cannot show anything: the entry derives the same policy under both contracts");

  /** The record on disk is untouched, so its digest still matches. Only the contract has moved. */
  const probe = path.join(DATA_DIR, "policy-contract-probe.json");
  const recordStamp = recordDigest(AUTHORED_FILE);
  fs.writeFileSync(probe, renderPolicyFile(underOld.policy, { record: recordStamp, contract: FINGERPRINT }));
  try {
    assert.strictEqual(
      (JSON.parse(fs.readFileSync(probe, "utf8")) as { _generatedFrom: { record: string } })._generatedFrom.record,
      recordStamp, "the probe does not carry the current record digest, so the record half would refuse it anyway");
    assert.throws(() => loadGeneratedPolicy(movedContract, probe), /different decision contract/,
      "a generated policy from before the re-wording was accepted, so an expired confirmation stayed active");
    // And it is the CONTRACT that refuses it: under the contract it was generated for, it still loads.
    assert.doesNotThrow(() => loadGeneratedPolicy(FINGERPRINT, probe),
      "the probe is refused for some reason other than the contract, so this proves nothing");
  } finally { fs.rmSync(probe, { force: true }); }

  // Every consumer passes a contract rather than assuming one, and they all get it from one place.
  for (const file of ["scripts/generate-source-health-inventory.ts", "scripts/test-operation-taxonomy.ts"]) {
    const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert.ok(/loadGeneratedPolicy\(currentContractFingerprint\(\)/.test(text),
      `${file} reads the generated policy without checking it against the contract in force`);
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

/**
 * The words the deciding path may not use.
 *
 * Not a style rule. Each of these names a thing in the system rather than a thing in the world, and
 * a person who does not already know the system cannot act on any of them. They stay legal inside
 * the collapsed disclosure, where they describe what the code does rather than what is being asked.
 */
const IMPLEMENTATION_WORDS = ["capability", "coverage basis", "integrity rule", "artifact",
  "table", "column", "schema", "validator", "authorization", "receipt owner", "mapping", "lookup"];

/**
 * "Policy" is the exception, and only in the governance sense.
 *
 * It was on the banned list because "capability policy" is an artifact in this system. But the word
 * is also the correct one for what the person is doing: they ARE the policy owner, and telling them
 * so is the point of the question -- "You are setting the policy; this is not a test with a
 * predetermined correct answer." Banning it outright would force a vaguer word onto the one
 * sentence that establishes whose judgment this is. So it is allowed in exactly two phrasings, and
 * every other use is still a defect.
 */
const SANCTIONED_POLICY_PHRASES = ["setting the policy", "as the policy owner"];

check("the deciding path never uses implementation language, on any of the questions", () => {
  for (const cap of model) {
    const text = visibleText(primarySurface(cap)).toLowerCase();
    for (const word of IMPLEMENTATION_WORDS) {
      const at = text.indexOf(word);
      assert.strictEqual(at, -1,
        `${cap.id}: the deciding path says "${word}" — ...${text.slice(Math.max(0, at - 60), at + 60)}...`);
    }
    // "Policy" only where it names the reader's authority, never the artifact.
    let scan = text;
    for (const phrase of SANCTIONED_POLICY_PHRASES) scan = scan.split(phrase).join("");
    const stray = scan.indexOf("policy");
    assert.strictEqual(stray, -1,
      `${cap.id}: the deciding path says "policy" outside the sanctioned phrasings — `
      + `...${scan.slice(Math.max(0, stray - 60), stray + 60)}...`);
  }
  // The page's own chrome is on that path too: its buttons, filters, warnings and dialogs.
  const chrome = JSON.stringify(PL.questions().page).toLowerCase();
  for (const word of IMPLEMENTATION_WORDS) {
    assert.ok(!chrome.includes(word), `the page's own controls say "${word}"`);
  }
  /**
   * Including anything the SESSION hands the page to display. The copy dialog was built from a
   * sentence the session returned -- "the same tables" -- which is how the one string on the
   * deciding path that did not come from the contract was also the one still naming the database.
   */
  const plan = sessionFor().clusterPlan(withYear.id);
  const scopes = PL.questions().page.cluster.scope;
  assert.ok(scopes[plan.scope], `the copy dialog has no wording for scope ${JSON.stringify(plan.scope)}`);
  for (const text of Object.values(scopes) as string[]) {
    for (const word of IMPLEMENTATION_WORDS) {
      assert.ok(!text.toLowerCase().includes(word), `the copy dialog says "${word}"`);
    }
  }

  /**
   * AND WITH SOMETHING ALREADY RECORDED, which is where this first went wrong.
   *
   * Rendering every card over an empty baseline proved nothing about the one case that matters:
   * a value carried over from before the workbook existed, written in whatever words its author
   * used. The checked-in record holds exactly one, and its text reads "this capability is
   * unavailable in production ... the builder decides at runtime". The summary pasted it straight
   * onto the deciding path, and only the browser saw it. A kept value is now described, not quoted.
   */
  const { entries: real } = readAuthoredRecord();
  const carried = Object.keys(real).filter((id) => model.some((c) => c.id === id));
  assert.ok(carried.length > 0, "this test is stale: nothing is recorded, so nothing can be carried over");
  for (const id of carried) {
    const cap = model.find((c) => c.id === id)!;
    const seeded = workbookSession({ docs: {}, entries: real });
    const text = visibleText(
      (CARD.primary(cap, seeded, "1 of 52") + CARD.summaryPanel(cap, seeded))
        .replace(/<details class="technical">[\s\S]*?<\/details>/g, "")).toLowerCase();
    for (const word of IMPLEMENTATION_WORDS) {
      assert.ok(!text.includes(word),
        `${id}: a value recorded earlier puts "${word}" on the deciding path — ...`
        + `${text.slice(Math.max(0, text.indexOf(word) - 60), text.indexOf(word) + 60)}...`);
    }
    // It is not hidden, though: the wording that was used is still one disclosure away.
    assert.ok(visibleText(CARD.technical(cap, seeded)).length > 0,
      `${id}: the recorded wording is not readable anywhere`);
  }
  // And the words ARE allowed where they belong, or the rule would just be pushing them off-screen.
  const disclosure = visibleText(CARD.technical(withYear, sessionFor())).toLowerCase();
  assert.ok(IMPLEMENTATION_WORDS.some((w) => disclosure.includes(w)),
    "the technical disclosure names nothing technical, so the split is not real");
});

check("every card says WHICH DATA it is about, before it asks anything", () => {
  /**
   * The first thing the pilot had to do was ask whether a county question belonged to the Current
   * Trends tab or somewhere else -- because the card never said. It was readable only as
   * `crime_data` inside the collapsed disclosure, which is not an answer to that question and is
   * not on the deciding path anyway.
   *
   * Every one of the four decisions depends on it. Who is responsible for hate crime records is
   * not who is responsible for the recent trends sample. What can go wrong differs. Whether years
   * apply differs. A person cannot answer any of them without knowing which data they are looking
   * at, so the card states it first.
   */
  const sources = new Set<string>();
  for (const cap of model) {
    const source = CATALOG.source(cap.id);
    assert.ok(source && source.length > 8, `${cap.id}: does not say which data it is about`);
    assert.ok(!IMPLEMENTATION_WORDS.some((w) => source.toLowerCase().includes(w)),
      `${cap.id}: names its data in implementation language: ${source}`);
    assert.notStrictEqual(source, cap.artifact, `${cap.id}: names the artifact instead of the data`);
    sources.add(source);

    const text = visibleText(primarySurface(cap));
    assert.ok(text.includes(`${PL.questions().card.sourceLabel} ${source}`),
      `${cap.id}: the card does not say which data this is`);
    /** Before the question, and long before anything is asked. */
    assert.ok(text.indexOf(source) < text.indexOf(PL.describeQuestion(cap)),
      `${cap.id}: the reader is asked what this answers before being told which data it is`);
    assert.ok(text.indexOf(source) < text.indexOf(PL.questions().year.heading),
      `${cap.id}: the first decision comes before the reader knows which data it is about`);
  }
  /**
   * And the sources genuinely distinguish. Two questions reading the same county lookup in
   * different data are different decisions, and naming them both "crime_data" hid exactly that.
   */
  assert.ok(sources.size >= 4, `only ${sources.size} distinct data sources are named across 52 questions`);
  const counties = model.filter((c) => c.reads.some((t) => t.includes("crosswalk")));
  assert.ok(counties.length >= 5, "this test is stale: the county questions are gone");
  assert.ok(new Set(counties.map((c) => CATALOG.source(c.id))).size >= 4,
    "the county questions do not say which data each one is about, so they read as duplicates");
});

check("every card states what it helps answer, with a realistic example", () => {
  for (const cap of model) {
    const text = visibleText(primarySurface(cap));
    assert.ok(text.includes(PL.questions().card.answersHeading),
      `${cap.id}: the card never says what question it helps answer`);
    const example = CATALOG.example(cap.id);
    assert.ok(example && example.length > 15, `${cap.id}: has no realistic example`);
    assert.ok(text.includes(example), `${cap.id}: the example is not shown`);
    /** Something a person would actually say: a question, or an instruction like "Show me ...". */
    assert.ok(/\?$/.test(example.trim()) || /^(Show|List|Tell|Give) /.test(example.trim()),
      `${cap.id}: the example is not phrased as someone asking: ${example}`);
    assert.ok(!IMPLEMENTATION_WORDS.some((w) => example.toLowerCase().includes(w)),
      `${cap.id}: the example is written in implementation language: ${example}`);
    assert.ok(text.indexOf(PL.describeQuestion(cap)) < text.indexOf(PL.questions().year.heading),
      `${cap.id}: the first question comes before the reader is told what this is about`);
  }
});

check("every choice says what it causes, and every question says what is being decided", () => {
  for (const cap of model) {
    const text = visibleText(primarySurface(cap));
    for (const set of [PL.yearOptions(cap), PL.availabilityOptions()]) {
      for (const o of set) {
        assert.ok(o.consequence && o.consequence.length > 25,
          `${cap.id}: the option "${o.label}" has no plain-language consequence`);
        assert.ok(text.includes(o.consequence), `${cap.id}: the consequence of "${o.label}" is not shown`);
      }
    }
    /**
     * Both halves, on every question, in that order.
     *
     * One label used to carry both, and what it actually described was the mechanism -- leaving the
     * reader to infer what they knew that the system did not. The judgment is the thing only they
     * can supply; the control is what happens as a result. Confusing them is how someone ends up
     * answering a question about the software rather than about crime data.
     */
    const Q = PL.questions();
    for (const section of [Q.year, Q.trust, Q.availability, Q.responsibility]) {
      assert.ok(text.includes(`${Q.card.judgmentHeading} ${section.judgment}`),
        `${cap.id}: a question never says what judgment is being asked of the reader`);
      assert.ok(text.includes(`${Q.card.controlsHeading} ${section.controls}`),
        `${cap.id}: a question never says what the answer controls`);
      assert.ok(text.indexOf(section.judgment) < text.indexOf(section.controls),
        `${cap.id}: what it controls is stated before what the reader is being asked`);
      /** The judgment must be a question put to a person, not a description of the machine. */
      assert.ok(/\?$/.test(section.judgment.trim()),
        `${cap.id}: the judgment is phrased as a statement rather than a question: ${section.judgment}`);
      assert.ok(!/chatbot|system|record/i.test(section.judgment),
        `${cap.id}: the judgment describes the software rather than asking about the data: ${section.judgment}`);
    }
    // "I'm not sure" is offered on every question, and says it changes nothing.
    assert.ok(text.includes(PL.questions().year.options.unsure.consequence),
      `${cap.id}: nothing tells the reader what "I'm not sure" does`);
  }
});

check("a question that is a list recommends that the year does not matter, for a human reason", () => {
  /**
   * The concrete case the redesign was asked for. A directory does not become a time series because
   * something dated happens to sit beside it, so the recommendation has to come from what the
   * question IS -- and it has to say why in words that can be disagreed with.
   */
  const directory = model.find((c) => /which agency record does a department name refer to/i.test(PL.describeQuestion(c)))!;
  assert.ok(directory, "this test is stale: the name-to-record question is gone");
  const advice = CATALOG.yearAdvice(directory.id);
  assert.strictEqual(advice.recommend, "no", "a name lookup is recommended as though it were a yearly statistic");
  assert.ok(/matches a department name to an agency record/.test(advice.why),
    "the reason is not about what this question is");
  /**
   * And it draws the boundary that made the old wording contradictory. "Which agencies exist in the
   * long FBI series?" reads as a question about history -- did Tulsa PD exist in 1995? -- which
   * makes "the year does not matter" look wrong. Resolving a name to a record and reporting who
   * took part in a given year are different questions, and only the first is asked here.
   */
  assert.ok(/does not answer whether that agency reported data in a particular year/.test(advice.why),
    "the reason does not separate identity from participation, so recommending 'no' still looks contradictory");
  assert.ok(!/column|table|year-bearing|dated/i.test(advice.why),
    `the reason explains the data's shape rather than the question: ${advice.why}`);

  const text = visibleText(primarySurface(directory));
  assert.ok(text.includes(`${PL.questions().card.recommendationLabel}: No.`),
    "the recommendation does not read as an answer to the question asked");
  assert.ok(text.includes(advice.why), "the recommendation appears without its reason");

  /**
   * And it is genuinely a judgment, not a readout of the data: a directory whose data DOES carry
   * something dated is still recommended "no". Recommending from the columns would flip it.
   */
  const datedDirectory = model.find((c) => CATALOG.yearAdvice(c.id).recommend === "no"
    && c.coverageCandidates.some((o) => o.yearBearing));
  assert.ok(datedDirectory,
    "this test is stale: no question recommends 'no' while carrying something dated, so the two cannot be told apart");
});

check("nothing is authored, and nothing is eligible, however the workbook is used", () => {
  /**
   * The standing property for the whole of Stage 2B. The redesign changed what people read; it must
   * not have changed what the machine can switch on, which is still nothing.
   */
  const { entries } = readAuthoredRecord();
  const authored = Object.entries(entries).filter(([, e]) => e.kind !== "legacy");
  assert.deepStrictEqual(authored, [], "policy has been authored into the checked-in record");

  // Even a complete, confirmed answer to every question authorizes nothing.
  const S = sessionFor();
  for (const cap of model) { S.update(cap.id, answers(cap)); S.confirmMapping(cap.id); }
  const result = importInto(S.serialize());
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  assert.deepStrictEqual(result.eligible, [],
    `answering every question made ${result.eligible.length} capability(ies) authorization-eligible`);
  assert.strictEqual(integrityIsExecutable(["anything a person could write"]), false,
    "an integrity rule became executable, which is what eligibility waits on");
});

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
  /**
   * The human answer cannot carry a database choice AT ALL any more.
   *
   * It used to hold one, and the page asked for it: pick a column, and justify the pick if its name
   * did not look like a year. That is not a judgment the person whose decision this is can make,
   * and asking them for it turned a question about crime data into a quiz about schemas. What to
   * read is worked out here; where it cannot be, that is engineering's to close.
   */
  const blank = PL.blankAnswer();
  assert.deepStrictEqual(Object.keys(blank).sort(),
    ["availability", "availabilityWhen", "coverage", "notes", "owner", "ownerOther",
      "trust", "trustOther", "trustOtherAction"],
    "the human answer carries a field that is not one of the four questions and their follow-ups");
  for (const key of Object.keys(blank)) {
    assert.ok(!/column|table|basis/i.test(key), `the human answer still carries ${key}`);
  }
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
  assert.ok(PL.yearOptions(withYear).some((o: any) => o.value === PL.UNSURE), "coverage has no unsure option");
  assert.ok(PL.availabilityOptions().some((o: any) => o.value === PL.UNSURE), "availability has no unsure option");
  assert.ok(PL.responsibilityOptions(withYear).some((o: any) => o.value === PL.UNSURE), "receipt owner has no unsure option");
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

  // And the summary a person reads says which answers are being kept rather than set.
  const K = sessionFor({ [withYear.id]: existingDerived }, prior.entries);
  K.update(withYear.id, {
    ...PL.blankAnswer(), coverage: PL.UNSURE, availability: PL.UNSURE, owner: PL.UNSURE, integrityUnsure: true,
    evidence: "nobody here knows yet; recorded so the open question is visible rather than assumed",
  });
  const shown = visibleText(CARD.summaryPanel(withYear, K));
  assert.ok(shown.includes(PL.questions().summary.keptDetail),
    `the summary never says an answer is being kept rather than set: ${shown}`);
  assert.ok(!shown.includes(String(existingDerived.receiptOwner)),
    "the summary quotes the value that was already recorded instead of describing it");
});

check("the year question promises only what the protection delivers", () => {
  /**
   * The check compares a requested year against the first and last it has and nothing else, so with
   * 2020 and 2022 present and 2021 absent, a request for 2021 passes. Asking someone to authorise
   * gap detection that does not exist is worse than not asking: they would rely on it.
   */
  const yearsOption = PL.yearOptions(withYear).find((o: any) => o.value === "years");
  assert.ok(yearsOption, "there is no option for an answer where the year matters");
  assert.ok(/refuse years earlier than the first available year or later than the last available year/
    .test(yearsOption.consequence), "the consequence does not say what protection is actually applied");
  assert.ok(/does not detect a missing year inside that range/.test(yearsOption.consequence),
    "the consequence does not disclose that a gap inside the range is undetected");
  assert.ok(!/years this data does not cover|which year each record belongs to/.test(yearsOption.consequence + yearsOption.label),
    "the overpromising wording survives");

  // And a person reading the card is told both halves, on the deciding path.
  const surface = visibleText(primarySurface(withYear));
  assert.ok(surface.includes("refuse years earlier than the first available year"),
    "the card never says what the protection does");
  assert.ok(surface.includes("does not detect a missing year inside that range"),
    "the card never discloses the limitation");

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
    assert.deepStrictEqual(h.trust, {}, `${cap.id}: a problem opens with a response already chosen`);
    assert.strictEqual(h.trustOtherAction, null, `${cap.id}: the custom problem opens pre-answered`);
    assert.ok(PL.yearOptions(cap).some((o: any) => o.recommended), `${cap.id}: no option is marked recommended`);
  }
  assert.strictEqual(S.counts().complete, 0, "a lookup counts as finished before anyone answered anything");

  /**
   * On the card, the recommendation is its OWN block with its own reason, and nothing is checked.
   *
   * Fusing it onto the option label ("No — this question is not about a particular year
   * recommended") reads as one label, which makes advice look like part of the choice. And a
   * `checked` attribute anywhere on an untouched card would be the workbook answering for someone.
   */
  const label = PL.questions().card.recommendationLabel;
  for (const cap of model) {
    const surface = renderedCard(cap);
    /** On the INPUT elements, not anywhere in the text: the evidence hint says "checked the ...". */
    assert.ok(!/<input[^>]*\schecked/.test(surface), `${cap.id}: an option is pre-checked before anyone chose one`);
    const advice = CATALOG.yearAdvice(cap.id);
    const text = visibleText(surface);
    assert.ok(text.includes(`${label}: ${advice.recommend === "yes" ? "Yes" : "No"}.`),
      `${cap.id}: the recommendation is not shown as its own statement`);
    assert.ok(text.includes(advice.why), `${cap.id}: the recommendation is shown without its reason`);
    const option = PL.yearOptions(cap).find((o: any) => o.recommended);
    assert.ok(option, `${cap.id}: no option carries the recommendation`);
    assert.ok(!/recommend/i.test(option.label), `${cap.id}: the recommendation is fused into the option label`);
  }
});

check("the summary repaints as you type, so a fixed problem re-enables confirmation", () => {
  /**
   * Found by driving the real page, not by any assertion here. The panel was part of the card,
   * which is only rebuilt when a radio changes -- so typing the missing sentence cleared the problem
   * while the confirm button stayed greyed out, with no way to press it and nothing saying why.
   * Repainting only the panel also keeps the cursor where the person is typing.
   */
  const html = renderWorkbook(registry);
  assert.ok(/<div id="summary"><\/div>/.test(html), "the summary is not its own repaintable region");
  const save = html.slice(html.indexOf("const save = () => {"), html.indexOf("/* Radios re-render"));
  assert.ok(/renderSummary\(\);/.test(save), "typing does not repaint the summary, so its button state goes stale");
  const renderSummary = html.slice(html.indexOf("const renderSummary = () => {"), html.indexOf("const save = () => {"));
  assert.ok(/addEventListener\("click"/.test(renderSummary), "the repainted panel loses its confirm handler");

  // The button's enabled state is derived from the answers NOW, not from when the card was built.
  const S = sessionFor();
  assert.ok(/disabled/.test(CARD.summaryPanel(withYear, S)), "an unanswered question offers confirmation");
  S.update(withYear.id, answers(withYear, { availability: "sometimes", availabilityWhen: "" }));
  assert.ok(/disabled/.test(CARD.summaryPanel(withYear, S)), "a question with something missing offers confirmation");
  S.update(withYear.id, { availabilityWhen: "only some states send this, so it is missing for the rest" });
  assert.ok(!/disabled/.test(CARD.summaryPanel(withYear, S)),
    "supplying the missing sentence did not re-enable confirmation");
});

check("the technical detail is present, optional, and never needed to answer anything", () => {
  const surface = renderedCard(withYear);
  assert.ok(/<details class="technical"><summary>Technical details<\/summary>/.test(surface),
    "the technical detail is not behind a marked disclosure");
  const technical = /<details class="technical">[\s\S]*?<\/details>/.exec(surface);
  assert.ok(technical, "the disclosure is not one element, so the two surfaces cannot be told apart");
  const inside = visibleText(technical![0]);
  assert.ok(inside.includes(withYear.id), "the identifier is not in the disclosure");
  assert.ok(inside.includes(PL.questions().card.technicalNote),
    "the disclosure does not say that nothing in it is the reader's to decide");

  // And the identifier, the tables and the columns appear NOWHERE else.
  const outside = visibleText(primarySurface(withYear));
  assert.ok(!outside.includes(withYear.id), "the identifier is part of the deciding path");
  for (const table of withYear.reads) {
    assert.ok(!outside.includes(table), `the deciding path names ${table}`);
  }
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
  const described = "the set of agencies covering a parish changes without anyone noticing";
  S.update(withYear.id, answers(withYear, {
    trust: allTrust(withYear, "refuse"), trustOther: described, trustOtherAction: "refuse" }));
  const proposed = S.proposal(withYear.id).proposed;
  assert.strictEqual(proposed.integrity.length, PL.trustScenarios(withYear).length + 1,
    "a listed problem or the one the person described was dropped");
  assert.ok(proposed.integrity.every((r: unknown) => typeof r === "string"), "a rule was recorded as something other than prose");
  assert.ok(proposed.integrity.some((r: string) => r.includes(described)), "the person's own words were lost");
  const surface = visibleText(primarySurface(withYear));
  assert.ok(!/boundTo/.test(renderedCard(withYear)), "the card asks the reader for a binding");
  assert.ok(surface.includes("These checks have not been implemented yet, so this records a requirement"
    + " and does not activate anything."),
    "the card implies these rules will be executed");
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

// ---------------------------------------------------------------- 4. the year question

check("saying the year matters, where nothing dated can be read, is engineering's follow-up", () => {
  /**
   * The person is not asked to solve this and is not blamed for it. Two county answers genuinely
   * have nothing dated to read; the honest thing is to record the human judgment -- a year DOES
   * matter for homicides -- and hand the technical gap to engineering, fail-closed in the meantime.
   *
   * The old design did the opposite: it demanded the person pick a column and then justify the
   * pick, which is a question only engineering can answer, asked of the one person whose judgment
   * was actually needed.
   */
  assert.ok(withoutYear, "this test is stale: every capability now has something dated to read");
  assert.strictEqual(CATALOG.yearAdvice(withoutYear.id).recommend, "yes",
    "this fixture cannot show anything: the recommendation is not that a year matters");

  const S = sessionFor();
  S.update(withoutYear.id, answers(withoutYear, { coverage: "years" }));
  const p = S.proposal(withoutYear.id);
  assert.deepStrictEqual(p.followUps, ["coverage"], "the gap was not recorded as engineering's follow-up");
  assert.strictEqual(p.merged.coverage, null, "a basis was invented where there is nothing dated to read");

  // It is NOT presented as something the person left undone, or must fix.
  assert.deepStrictEqual(S.problems(withoutYear.id), [],
    "the person is asked to fix a gap that is not theirs to fix");
  assert.strictEqual(S.isComplete(withoutYear.id), false, "an answer with no basis counted as finished");

  // And the card says so, in those terms.
  const shown = visibleText(CARD.summaryPanel(withoutYear, S));
  assert.ok(shown.includes(PL.questions().card.followUpHeading), "the card never says this is with engineering");
  assert.ok(shown.includes("Working out what it should read is an engineering job, not yours."),
    `the card does not tell the reader this is not theirs to solve: ${shown}`);

  // Fail-closed: recorded, and authorizing nothing.
  S.confirmMapping(withoutYear.id);
  const result = importInto(S.serialize());
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  assert.deepStrictEqual(result.eligible, [], "an unresolved year basis switched something on");
});

check("where an answer reads several dates, none is guessed", () => {
  /**
   * THE HIDDEN GUESS. The translation used to take whichever dated field it met first, which is a
   * choice wearing a lookup's clothes. Twenty-three of the fifty-two questions read more than one.
   * On a consistent-reporter question that meant bounding the answer by the END OF THE SPAN a
   * department reported over -- `nibrs_consistent_reporters.end_year` -- instead of the year the
   * counts belong to. The person would have confirmed a confident decision derived from the wrong
   * data, and neither the page nor the record would have named the field it came from.
   */
  const spanned = model.find((c) => c.reads.includes("nibrs_consistent_reporters")
    && c.reads.some((t) => t.startsWith("summary_")))!;
  assert.ok(spanned, "this test is stale: no question reads a reported span alongside dated counts");
  const dated = spanned.coverageCandidates.filter((o) => o.yearBearing).map((o) => `${o.table}.${o.yearColumn}`);
  assert.ok(dated.includes("nibrs_consistent_reporters.start_year")
    && dated.includes("nibrs_consistent_reporters.end_year"),
    `this fixture cannot show anything: it has no start/end span — ${dated.join(", ")}`);
  assert.ok(dated.some((d) => /^summary_.*\.year$/.test(d)),
    `this fixture cannot show anything: it has no fact-table year — ${dated.join(", ")}`);
  assert.ok(dated.length > 1, "this fixture is not ambiguous");

  // Nothing is chosen, and the reason given is that there are several, not that there are none.
  assert.strictEqual(PL.automaticYearBasis(spanned), null, "a basis was guessed from several candidates");
  assert.strictEqual(PL.yearBasisStatus(spanned).status, "ambiguous", "the ambiguity is reported as something else");

  const S = sessionFor();
  S.update(spanned.id, answers(spanned, { coverage: "years" }));
  const p = S.proposal(spanned.id);
  assert.strictEqual(p.merged.coverage, null, "a basis was written from an unreviewed guess");
  assert.deepStrictEqual(p.followUps, ["coverage"], "the ambiguity was not recorded as engineering's follow-up");
  assert.strictEqual(p.followUpReason, "ambiguous", "the follow-up does not say WHY it is outstanding");

  /** The specific wrong answer this defect produced, named so a regression cannot re-introduce it. */
  assert.notDeepStrictEqual(p.merged.coverage,
    { kind: "column", table: "nibrs_consistent_reporters", yearColumn: "end_year" },
    "the answer is bounded by the end of a reporting span rather than the year its counts belong to");

  // The person is told what is outstanding, is not asked to settle it, and nothing is switched on.
  assert.deepStrictEqual(S.problems(spanned.id), [], "the person is asked to settle a technical question");
  const shown = visibleText(CARD.summaryPanel(spanned, S));
  assert.ok(shown.includes("This answer reads more than one date, and which of them it should be"
    + " bounded by has not been reviewed."), `the card does not say what is outstanding: ${shown}`);
  assert.ok(shown.includes("nothing will be guessed in the meantime"), "the card does not promise not to guess");
  for (const word of IMPLEMENTATION_WORDS) {
    assert.ok(!shown.toLowerCase().includes(word), `the follow-up wording says "${word}"`);
  }
  S.confirmMapping(spanned.id);
  const result = importInto(S.serialize());
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  assert.deepStrictEqual(result.eligible, [], "an unsettled basis switched something on");
  assert.strictEqual((result.policy[spanned.id] as { coverage: unknown }).coverage, null,
    "an unsettled basis was written into the record as a decision");

  /**
   * And a basis someone HAS reviewed is used. Asserted through the same path with a catalog that
   * declares one, so the mechanism is exercised rather than merely present -- no entry declares one
   * today, and a capability that can never resolve would make the escape hatch untestable.
   */
  const declared = spanned.coverageCandidates.find((o) => o.yearBearing
    && /^summary_/.test(o.table) && o.yearColumn === "year")!;
  const reviewedCatalog = Object.assign(Object.create(null), CATALOG, {
    yearBasis: (id: string) => (id === spanned.id ? { table: declared.table, yearColumn: declared.yearColumn } : null),
  });
  const reviewedPL = createStage2bPlainLanguage(reviewedCatalog);
  assert.strictEqual(reviewedPL.yearBasisStatus(spanned).status, "reviewed",
    "a reviewed basis is not honoured, so the ambiguity can never be resolved");
  assert.deepStrictEqual(reviewedPL.proposeMapping(spanned, answers(spanned, { coverage: "years" })).proposed.coverage,
    { kind: "column", table: declared.table, yearColumn: declared.yearColumn },
    "a reviewed basis was not used");

  // Nothing declares one today, so nothing in the checked-in record can be resolved by this path.
  for (const cap of model) {
    assert.strictEqual(CATALOG.yearBasis(cap.id), null,
      `${cap.id}: a basis has been written into the catalog without an engineering review`);
  }
});

check("where an answer reads exactly one date, it is chosen without asking anyone", () => {
  /**
   * The positive half. Fail-closed must not mean fail-always: where there is nothing to choose
   * between, the basis is settled automatically and the person answers only the question that is
   * theirs.
   */
  const single = model.find((c) => c.coverageCandidates.filter((o) => o.yearBearing).length === 1)!;
  assert.ok(single, "this test is stale: no question reads exactly one dated field");
  const only = single.coverageCandidates.find((o) => o.yearBearing)!;
  assert.strictEqual(PL.yearBasisStatus(single).status, "unambiguous", "an unambiguous basis is reported otherwise");

  const S = sessionFor();
  S.update(single.id, answers(single, { coverage: "years" }));
  const p = S.proposal(single.id);
  assert.deepStrictEqual(p.merged.coverage, { kind: "column", table: only.table, yearColumn: only.yearColumn },
    "the one available basis was not used");
  assert.deepStrictEqual(p.followUps, [], "an unambiguous basis was sent to engineering anyway");
  assert.deepStrictEqual(p.unresolved, [], "an unambiguous basis left the year question unresolved");
  assert.deepStrictEqual(S.problems(single.id), [], "an unambiguous question still asks for something");
  assert.ok(S.confirmMapping(single.id), "a fully answered, unambiguous question could not be confirmed");
  assert.strictEqual(S.isComplete(single.id), true, "a fully answered, unambiguous question cannot be finished");

  // And what the person reads is the protection, not the field it was worked out from.
  const shown = visibleText(CARD.summaryPanel(single, S));
  assert.ok(shown.includes("If someone asks about a year outside what this data covers"),
    "the summary does not say what the protection does");
  assert.ok(!shown.includes(only.yearColumn) || only.yearColumn === "year",
    "the summary names the field rather than the behaviour");
});

// ------------------------------------------- 4b. every problem gets a response, and it survives

check("every listed problem needs exactly one explicit response", () => {
  /**
   * The checkboxes could not tell "leave this alone" from "nobody has looked at it", because both
   * were an untouched box. Now an absent response is unanswered and says so, and a response is one
   * of four -- never two, never inferred.
   */
  const S = sessionFor();
  const scenarios = PL.trustScenarios(withYear);
  assert.ok(scenarios.length >= 2, "this fixture cannot show anything: it lists fewer than two problems");

  // Nothing chosen: unanswered, and NOT read as "no special handling".
  S.update(withYear.id, answers(withYear, { trust: {} }));
  assert.ok(S.proposal(withYear.id).unanswered.includes("integrity"), "an untouched problem was read as a decision");
  assert.deepStrictEqual(S.trustRows(withYear.id).map((r: any) => r.action), scenarios.map(() => null),
    "an untouched problem carries a response nobody chose");

  // Answering all but one is still unanswered — a partial set is not a decision.
  const partial: Record<string, string> = {};
  for (const s of scenarios.slice(1)) partial[s.value] = "refuse";
  S.update(withYear.id, { trust: partial });
  assert.ok(S.proposal(withYear.id).unanswered.includes("integrity"),
    "leaving one problem unanswered still counted as a complete response");

  // One response per problem, and only ever one.
  S.update(withYear.id, { trust: allTrust(withYear, "refuse") });
  assert.deepStrictEqual(S.proposal(withYear.id).unanswered, [], "a full set of responses still counted as unanswered");
  for (const row of S.trustRows(withYear.id)) {
    assert.ok(["refuse", "warn", "none", "unsure"].includes(row.action), `${row.value}: not one of the four responses`);
  }
  // Every response is offered, each with what it causes.
  const offered = PL.trustActions();
  assert.deepStrictEqual(offered.map((a: any) => a.value), ["refuse", "warn", "none", "unsure"]);
  for (const a of offered) assert.ok(a.consequence.length > 25, `${a.value} is offered with no consequence`);
});

check("different problems may get different responses, and all four survive a round trip", () => {
  /**
   * Export, import, and reopen the REAL page. A response that survives in memory but is flattened
   * on the way to the record would be the same class of defect as the checkbox: the record would
   * not say what the person decided.
   */
  /** Its own fixture: three problems are needed to give three different responses. */
  const varying = model.find((c) => PL.trustScenarios(c).length >= 3 && PL.automaticYearBasis(c))
    ?? model.find((c) => PL.trustScenarios(c).length >= 3)!;
  assert.ok(varying, "this test is stale: no question lists three problems");
  const scenarios = PL.trustScenarios(varying);
  const varied: Record<string, string> = {};
  varied[scenarios[0].value] = "refuse";
  varied[scenarios[1].value] = "warn";
  varied[scenarios[2].value] = "none";
  const described = "a parish gains a brand-new department mid-year";

  const S = sessionFor();
  S.update(varying.id, answers(varying, {
    trust: varied, trustOther: described, trustOtherAction: "unsure" }));
  // "I'm not sure" anywhere keeps the whole section unfinished.
  assert.ok(S.proposal(varying.id).unanswered.includes("integrity"),
    "an \"I'm not sure\" response was treated as decided");

  S.update(varying.id, { trustOtherAction: "refuse" });
  assert.deepStrictEqual(S.proposal(varying.id).unanswered, [], "a fully answered section still counted as unanswered");
  S.confirmMapping(varying.id);
  const imported = importInto(S.serialize());
  assert.ok(imported.ok, JSON.stringify(!imported.ok && imported.errors));
  if (!imported.ok) return;

  const stored = (imported.entries[varying.id] as unknown as { human: Record<string, any> }).human;
  assert.deepStrictEqual(stored.trust, varied, "the per-problem responses did not survive the import");
  assert.strictEqual(stored.trustOther, described, "the problem the person described was lost");
  assert.strictEqual(stored.trustOtherAction, "refuse", "the response to their own problem was lost");

  // And reopening the real page restores every one of them.
  const reopened = workbookSession({ docs: imported.docs, entries: imported.entries });
  const rows = reopened.trustRows(varying.id);
  assert.strictEqual(rows.find((r: any) => r.value === scenarios[0].value).action, "refuse");
  assert.strictEqual(rows.find((r: any) => r.value === scenarios[1].value).action, "warn");
  assert.strictEqual(rows.find((r: any) => r.value === scenarios[2].value).action, "none");
  const custom = rows.find((r: any) => r.custom);
  assert.ok(custom, "the problem the person described did not reopen");
  assert.strictEqual(custom.label, described, "their wording was not restored");
  assert.strictEqual(custom.action, "refuse", "their response to it was not restored");
});

check("a response the system cannot carry out is recorded, named, and authorizes nothing", () => {
  /**
   * "Warn" and a deliberate "no special handling" are decisions. Neither can be expressed as a rule
   * today, and neither may be quietly turned into one -- writing a refusal rule for a person who
   * asked for a warning would record the opposite of what they said.
   */
  for (const [action, marker] of [["warn", "warning behaviour"], ["none", "deliberate no-special-handling"]] as [string, string][]) {
    const S = sessionFor();
    S.update(withYear.id, answers(withYear, { trust: allTrust(withYear, action) }));
    const p = S.proposal(withYear.id);
    assert.deepStrictEqual(p.unanswered, [], `${action}: a decision was reported as unanswered`);
    assert.ok(p.followUps.includes("integrity"), `${action}: no engineering follow-up was raised`);
    assert.strictEqual(p.merged.integrity, null, `${action}: it was turned into a rule that means something else`);

    const shown = visibleText(CARD.summaryPanel(withYear, S));
    assert.ok(shown.includes(marker), `${action}: the summary does not name what is outstanding — ${shown}`);
    assert.ok(shown.includes(PL.questions().card.followUpHeading), `${action}: it is not shown as engineering's`);

    S.confirmMapping(withYear.id);
    const imported = importInto(S.serialize());
    assert.ok(imported.ok, `${action}: ${JSON.stringify(!imported.ok && imported.errors)}`);
    if (!imported.ok) return;
    assert.deepStrictEqual(imported.eligible, [], `${action}: an unimplemented response switched something on`);
    assert.strictEqual((imported.policy[withYear.id] as { integrity: unknown }).integrity, null,
      `${action}: a rule was invented in the record`);
    assert.deepStrictEqual(
      (imported.entries[withYear.id] as unknown as { human: { trust: unknown } }).human.trust,
      allTrust(withYear, action), `${action}: the human answer was not recorded as given`);
  }
});

check("an explicit \"no special handling\" is never mistaken for an unanswered field", () => {
  /**
   * The precise defect of the old control: an untouched box and a deliberate "this needs nothing"
   * were the same state. They are now different in the answer, in the counts, and on the page.
   */
  const blank = sessionFor();
  blank.update(withYear.id, answers(withYear, { trust: {} }));
  const decided = sessionFor();
  decided.update(withYear.id, answers(withYear, { trust: allTrust(withYear, "none") }));

  assert.ok(blank.proposal(withYear.id).unanswered.includes("integrity"), "an untouched section is not unanswered");
  assert.ok(!decided.proposal(withYear.id).unanswered.includes("integrity"),
    "a deliberate \"no special handling\" was counted as unanswered");
  assert.strictEqual(blank.counts().integrity, decided.counts().integrity + 1,
    "the counters cannot tell a decision from an untouched control");

  const blankText = visibleText(CARD.summaryPanel(withYear, blank));
  const decidedText = visibleText(CARD.summaryPanel(withYear, decided));
  assert.ok(blankText.includes(PL.questions().summary.unanswered), "an untouched section does not read as undecided");
  assert.ok(decidedText.includes("No special handling is required when"),
    `a deliberate decision does not read as one: ${decidedText}`);
  assert.ok(!decidedText.includes(PL.questions().summary.unanswered),
    "a deliberate decision still reads as undecided");
});

check("\"nobody here\" is a position the question can express, not a sentence typed into a box", () => {
  /**
   * Found in the first capability of the pilot. The honest answer to "who should be contacted?" for
   * data other organisations submit is "nobody here -- they are responsible, not us", and there was
   * no way to say it: it had to go through "Something else", where the record then stored it as
   * though it named someone to chase. A real position with no control is a control that records the
   * wrong decision.
   */
  const values = PL.responsibilityOptions(withYear).map((o: any) => o.value);
  assert.ok(values.includes("not-ours"), "there is still no way to say nobody here is responsible");
  assert.ok(values.includes("other") && values.includes(PL.UNSURE), "the escape hatches were removed");

  const S = sessionFor();
  S.update(withYear.id, answers(withYear, { owner: "not-ours" }));
  const p = S.proposal(withYear.id);
  assert.deepStrictEqual(p.unanswered, [], "a deliberate \"nobody here\" was counted as unanswered");
  assert.deepStrictEqual(S.problems(withYear.id), [], "it demanded a name anyway");
  assert.strictEqual(p.merged.receiptOwner, PL.questions().responsibility.notOursOwner,
    "the record does not say what was actually decided");

  // It reads as a decision about responsibility, not as somebody to contact.
  const shown = visibleText(CARD.summaryPanel(withYear, S));
  assert.ok(shown.includes("Nobody here is responsible for chasing this"),
    `the summary does not state the decision: ${shown}`);
  assert.ok(!/investigate No internal owner/.test(shown),
    "the summary reads the decision as though it named a process to investigate");

  // And it survives the round trip.
  S.confirmMapping(withYear.id);
  const imported = importInto(S.serialize());
  assert.ok(imported.ok, JSON.stringify(!imported.ok && imported.errors));
  if (!imported.ok) return;
  assert.strictEqual(
    (imported.entries[withYear.id] as unknown as { human: { owner: string } }).human.owner, "not-ours",
    "the position did not survive the import");
  assert.deepStrictEqual(imported.eligible, [], "recording who is responsible switched something on");
});

check("what to do about stale data is phrased as something you can actually do", () => {
  /**
   * "The historical FBI series load should be contacted" -- a load cannot be contacted. The answer
   * to "who do I go to" is a process to investigate, and the sentence now says that.
   */
  const S = sessionFor();
  const process = PL.responsibilityOptions(withYear)[0].value;
  S.update(withYear.id, answers(withYear, { owner: process }));
  const shown = visibleText(CARD.summaryPanel(withYear, S));
  assert.ok(shown.includes(`If this goes missing or becomes outdated, investigate ${process}.`),
    `the summary does not say what to do: ${shown}`);
  assert.ok(!/should be contacted/.test(shown), "a process is still described as something to contact");
  // The label reads inside a sentence rather than starting one.
  for (const cap of model) {
    for (const option of PL.responsibilityOptions(cap)) {
      if (["other", "not-ours", PL.UNSURE].includes(option.value)) continue;
      assert.ok(/^the /.test(option.value),
        `${cap.id}: "${option.value}" does not read inside a sentence`);
    }
  }
});

check("optional notes are optional: empty blocks nothing, and nothing is invented to fill them", () => {
  /**
   * It used to demand twenty characters saying how the person knew their own decision was right.
   * That is a demand for proof aimed at the authority itself, and it blocked good decisions from
   * being recorded. Empty notes must reach the record, the confirmation and the import untouched.
   */
  const S = sessionFor();
  S.update(withYear.id, answers(withYear, { notes: "" }));
  assert.deepStrictEqual(S.problems(withYear.id), [], "an empty note blocked completion");
  assert.ok(S.confirmMapping(withYear.id), "an empty note blocked confirmation");
  const imported = importInto(S.serialize());
  assert.ok(imported.ok, JSON.stringify(!imported.ok && imported.errors));
  if (!imported.ok) return;
  assert.strictEqual((imported.policy[withYear.id] as { evidence: string }).evidence, "",
    "something was written into the record that nobody supplied");
  assert.deepStrictEqual(policyShapeErrors(imported.policy[withYear.id] as never), [],
    "an empty note makes the recorded policy malformed");
  assert.strictEqual(policyIsComplete(imported.policy[withYear.id] as never), true,
    "an empty note leaves the policy incomplete, so it could never become eligible");

  // Nothing anywhere asks the expert to prove their judgment, or claims it was corroborated.
  for (const cap of model) {
    const text = visibleText(primarySurface(cap)).toLowerCase();
    for (const phrase of ["how do you know", "how you know", "what are you basing", "evidence",
      "verified", "proven", "cite"]) {
      assert.ok(!text.includes(phrase), `${cap.id}: the deciding path says "${phrase}"`);
    }
  }
  const record = JSON.stringify(imported.entries).toLowerCase();
  for (const claim of ["verified", "confirmed with", "corroborat"]) {
    assert.ok(!record.includes(claim), `the record asserts "${claim}" when nobody supplied it`);
  }
  // A note that IS written is carried verbatim, and still claims nothing.
  const N = sessionFor();
  const note = "the parish boundary changed in 2021, which is why this is worth revisiting";
  N.update(withYear.id, answers(withYear, { notes: note }));
  assert.strictEqual(N.proposal(withYear.id).merged.evidence, note, "the note was rewritten on its way to the record");
});

check("\"not about a particular year\" is recorded as a decision, with no reason demanded", () => {
  /**
   * It used to make the person type a justification for choosing the honest answer. Answering "no"
   * is a decision, not an exception needing an excuse; what gets recorded is the decision itself.
   */
  const S = sessionFor();
  S.update(withYear.id, answers(withYear, { coverage: "no-years" }));
  assert.deepStrictEqual(S.problems(withYear.id), [], "the honest answer was refused until a reason was typed");
  const proposed = S.proposal(withYear.id).proposed;
  assert.deepStrictEqual(proposed.coverage, { kind: "none", reason: PL.questions().year.noneReason });
  assert.ok(/Answered in the workbook/.test(proposed.coverage.reason),
    "the recorded reason claims something the person did not say");
  S.confirmMapping(withYear.id);
  const result = importInto(S.serialize());
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  assert.notStrictEqual((result.policy[withYear.id] as any).coverage, null, "a decided no-year answer was stored as undecided");
});

check("a basis outside what the answer reads is refused, wherever it came from", () => {
  /**
   * The page can no longer emit one -- the basis is chosen from what the capability reads -- so this
   * guards the layer below: a hand edit, a migration, or a future writer. Asserted directly on the
   * predicate, because there is no longer a workbook path that can reach it.
   */
  const declared = withYear.reads.map((name) => ({ name, requiredColumns: withYear.columns[name] ?? [] }));
  const stray = { coverage: { kind: "column", table: "unrelated_table", yearColumn: "year" },
    integrity: ["a sentence a person wrote"], availability: { kind: "always" }, receiptOwner: "someone",
    evidence: "an entry naming a table this answer does not read" };
  assert.ok(coverageBasisErrors(stray, declared).some((e) => /is not one the capability reads/.test(e)),
    "a basis naming something the answer does not read was accepted");
  assert.strictEqual(capabilityAuthorizes(stray, declared), false, "it authorized anyway");

  // And the human answer has no way to carry one, so the page cannot produce this at all.
  const exported = JSON.parse(exportWith(withYear.id, answers()));
  assert.ok(!("coverageColumn" in exported.decisions[withYear.id].human),
    "the export still carries a database choice made by the person");
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
   * Two materially different answers can produce byte-identical policy. Someone who describes when
   * the data is legitimately missing and THEN decides it should always be there leaves that
   * sentence behind in their answer, where it is part of what they said and no part of the mapping.
   * Comparing the derived policy saw no conflict at all, so the second import overwrote the first
   * person's words while every technical field stayed the same.
   */
  const base = recordWith(withYear.id, answers(withYear, {
    availability: "always", availabilityWhen: "an earlier draft: only some states send this" }));
  const start = { docs: base.docs, entries: base.entries };

  const A = workbookSession(start);
  assert.ok(A.update(withYear.id, { availabilityWhen: "session A: I checked, and it is always sent" }),
    "editing what the person wrote was not treated as a change to the answer");
  const afterA = importDecisions(A.serialize(), registry, start);
  assert.ok(afterA.ok, JSON.stringify(!afterA.ok && afterA.errors));
  if (!afterA.ok) return;
  assert.deepStrictEqual(afterA.policy[withYear.id], base.policy[withYear.id],
    "this fixture cannot show anything: the two answers derive different policy, which the old check would catch");
  assert.match((afterA.entries[withYear.id] as unknown as { human: { availabilityWhen: string } }).human.availabilityWhen, /session A/,
    "the first session's answer was not recorded");

  const B = workbookSession(start);
  B.update(withYear.id, { availabilityWhen: "session B: nobody asked me, I assumed it is always there" });
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
  const wording = PL.questions().withdraw;
  const withdrawable = renderedCard(withYear, sessionFor({ [withYear.id]: prior.policy[withYear.id] as Record<string, unknown> }, prior.entries));
  assert.ok(visibleText(withdrawable).includes(wording.button), "the card never offers removal");
  assert.ok(visibleText(withdrawable).includes(wording.heading), "removal is offered without saying what it removes");
  assert.ok(new RegExp("confirm\\(Q\\.withdraw\\.confirm").test(html), "removal is not confirmed");
  assert.ok(/not the same as leaving the/.test(wording.confirmDetail),
    "the confirmation does not say what removal is not the same as");
  assert.ok(/Q\.withdraw\.confirmDetail/.test(html), "the page does not show that part of the confirmation");
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
  /**
   * Asserted on the CONTRACT, not on the page's bytes. The warning is set from it at runtime, and
   * the module builds the sentence by concatenation, so searching the page for a contiguous phrase
   * tests how the source happens to wrap rather than what a reader is told.
   */
  assert.ok(PL.questions().page.unsavedWarning.includes("Export every few answers"),
    "the page never suggests exporting periodically");
  assert.ok(html.includes("unsavedWarning"), "the page never renders the unsaved-work warning");
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

check("the response-completeness audit describes the responses that are actually offered", () => {
  /**
   * A document claiming a question covers every reasonable answer is worth nothing if it drifts
   * from the question. This ties the two together: every response the audit lists must exist, and
   * every response that exists must be in the audit.
   */
  const audit = fs.readFileSync(path.join(process.cwd(), "docs", "superpowers",
    "2026-08-15-stage2b-response-completeness.md"), "utf8");
  for (const heading of [PL.questions().year.heading, PL.questions().trust.heading,
    PL.questions().availability.heading, PL.questions().responsibility.heading]) {
    const asked = heading.replace(/^\d+\.\s*/, "");
    assert.ok(audit.includes(asked), `the audit does not cover the question "${asked}"`);
  }
  for (const value of ["years", "no-years", "unsure"]) {
    assert.ok(audit.includes("`" + value + "`"), `the audit does not name the year response ${value}`);
  }
  for (const a of PL.trustActions()) {
    assert.ok(audit.includes("`" + a.value + "`"), `the audit does not name the response ${a.value}`);
  }
  for (const value of ["always", "sometimes"]) {
    assert.ok(audit.includes("`" + value + "`"), `the audit does not name the availability response ${value}`);
  }
  for (const value of ["not-ours", "other"]) {
    assert.ok(audit.includes("`" + value + "`"), `the audit does not name the responsibility response ${value}`);
  }
  /**
   * The audit must describe what the questions actually offer, including the position the pilot
   * found missing. If `not-ours` is ever removed, this fails rather than leaving a document that
   * claims a coverage the interface no longer has.
   */
  assert.ok(PL.responsibilityOptions(withYear).some((o: any) => o.value === "not-ours"),
    "the audit claims a position the question no longer offers");
  assert.ok(/nobody here/i.test(audit), "the audit does not describe the nobody-here position");
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
  for (const option of PL.responsibilityOptions(withYear)) {
    assert.ok(!/\.(py|ts|js|sql)$/.test(option.value), `the owner question offers the filename ${option.value}`);
  }
});

console.log(`\nstage2b workbook: ${passed} passed, ${failed} failed`);
// Every check here catches its own assertion, so without this the script printed its failures
// and exited zero -- the suite reported success while a check was failing, which is the one
// thing a suite must never do.
process.exit(failed > 0 ? 1 : 0);
