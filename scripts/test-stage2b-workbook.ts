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
  DECISIONS_VERSION, PLAIN_LANGUAGE_MODULE_FILE, SESSION_MODULE_FILE, buildWorkbookModel,
  decidableRegistry, registryFingerprint, renderWorkbook, type RegistryEntry,
} from "./generate-stage2b-workbook";
import { importDecisions, writePolicy } from "./import-stage2b-decisions";
import {
  authorizationBlockers, capabilityAuthorizes, integrityIsExecutable, isYearBearingColumn,
  policyIsComplete, policyShapeErrors,
} from "../lib/capability-policy";
import { SWEEP_ONLY_IDS } from "../lib/sweep-only-capabilities";

const require = createRequire(import.meta.url);
/** The same files the page inlines. Imported, so these tests exercise behaviour rather than text. */
const { createStage2bSession } = require(SESSION_MODULE_FILE) as { createStage2bSession: (d: unknown, pl?: unknown) => any };
const { createStage2bPlainLanguage } = require(PLAIN_LANGUAGE_MODULE_FILE) as { createStage2bPlainLanguage: () => any };
const PL = createStage2bPlainLanguage();

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
const model = buildWorkbookModel(registry);
/** A capability with a genuinely year-bearing column, so the recommended answer exists. */
const withYear = model.find((c) => c.coverageCandidates.some((o) => o.yearBearing))!;
const yearBasis = withYear.coverageCandidates.find((o) => o.yearBearing)!;
const withoutYear = model.find((c) => c.coverageCandidates.length > 0 && !c.coverageCandidates.some((o) => o.yearBearing))!;

function sessionFor(authored: Record<string, unknown> = {}) {
  return createStage2bSession({ v: DECISIONS_VERSION, fingerprint: FINGERPRINT, capabilities: model, authored }, PL);
}

/** A complete set of plain-language answers, as a person clicking through would produce. */
const answers = (cap = withYear, over: Record<string, unknown> = {}) => ({
  ...PL.blankAnswer(),
  coverage: cap.coverageCandidates.some((o: any) => o.yearBearing) ? "years" : "no-years",
  coverageReason: cap.coverageCandidates.some((o: any) => o.yearBearing) ? "" : "this lookup answers a directory question, not a time-series one",
  integrity: ["stale"],
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

const importInto = (raw: string, policy: Record<string, unknown> = {}) => importDecisions(raw, registry, policy);

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
  assert.ok(/observed from the code/.test(html), "the page does not distinguish observation from decision");
  // The identifier and tables are in the disclosure, not in the question.
  const question = html.slice(html.indexOf("1. Can this answer tell which years"), html.indexOf("2. What would make"));
  assert.ok(!/cap\.id/.test(question), "the capability identifier is part of the coverage question itself");
});

// ---------------------------------------------------------------- 2. the translation is confirmed

check("the importer refuses a mapping that was never confirmed", () => {
  const result = importInto(exportWith(withYear.id, answers(), false));
  assert.strictEqual(result.ok, false, "an unconfirmed mapping was imported");
  assert.ok(!result.ok && result.errors.some((e) => /never confirmed/.test(e)), "the refusal must say what is missing");
});

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
  S.update(withYear.id, answers(withYear, { integrity: ["stale", "double"], integrityOther: "the county lookup goes missing" }));
  const proposed = S.proposal(withYear.id).proposed;
  assert.strictEqual(proposed.integrity.length, 3, "a chosen scenario or the free text was dropped");
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
  assert.deepStrictEqual(result.authored, [withYear.id], "a complete answer was not recorded");
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
  assert.ok(/no column this lookup reads is named like a year/.test(recommended.why), "the recommendation gives no basis");

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
  const existingPolicy = { [other.id]: { coverage: null, integrity: null, availability: null, receiptOwner: null, evidence: "prior" } };
  const result = importDecisions(exportWith(withYear.id, answers()), registry, existingPolicy);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  if (!result.ok) return;
  assert.ok(other.id in result.policy, "an entry the change set never mentioned was deleted by importing");
});

check("a change authored against a stale baseline is refused by name", () => {
  const theirs = { coverage: null, integrity: null, availability: null, receiptOwner: "someone else's answer", evidence: "theirs" };
  const result = importDecisions(exportWith(withYear.id, answers()), registry, { [withYear.id]: theirs });
  assert.strictEqual(result.ok, false, "an import overwrote an entry that changed underneath it");
  assert.ok(!result.ok && result.errors.some((e) => e.includes(withYear.id) && /changed since this session began/.test(e)));
});

check("withdrawal is a named act, never inferred from unanswered questions", () => {
  const authored = { coverage: null, integrity: null, availability: null, receiptOwner: "prior owner", evidence: "prior" };
  const S = sessionFor({ [withYear.id]: authored });
  assert.strictEqual(S.canWithdraw(withYear.id), true, "an authored capability is not withdrawable");
  assert.strictEqual(sessionFor().canWithdraw(withYear.id), false, "an unauthored capability offers withdrawal");
  S.withdraw(withYear.id);
  assert.deepStrictEqual(S.changeSet()[withYear.id], { operation: "withdraw" });
  const result = importDecisions(S.serialize(), registry, { [withYear.id]: authored });
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
  stale.fingerprint = "deadbeefdeadbeef";
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
  assert.ok(S.loadSession({ v: DECISIONS_VERSION, fingerprint: FINGERPRINT, decisions: {}, basedOn: {} }).ok);
  assert.deepStrictEqual(S.baselineFor(withYear.id), authored,
    "an empty load left the previous file's baseline in place, so the repository value was lost");
  assert.deepStrictEqual(S.changeSet(), {}, "a session reset to the repository value still reports changes");
});

check("a session written by a different version is refused rather than misread", () => {
  const result = sessionFor().loadSession({ v: DECISIONS_VERSION - 1, fingerprint: FINGERPRINT, decisions: {}, basedOn: {} });
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
  assert.deepStrictEqual(buildWorkbookModel(synthetic).map((c) => c.id).sort(),
    ["shr::t_solo::t_solo(year)", ...SWEEP_ONLY_IDS].sort());
  assert.ok(!renderWorkbook(synthetic).includes(Object.keys(registry)[0]),
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

check("the policy README documents the semantics that are actually enforced", () => {
  const doc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "capability-policy.json"), "utf8")) as any;
  const rules = (doc._README.rules as string[]).join(" ");
  assert.ok(/STATING ALL FOUR IS NOT ENOUGH TO AUTHORIZE/.test(rules), "the README implies four fields authorize");
  assert.ok(/no capability is authorization-eligible/.test(rules), "the README does not record that nothing is eligible");
  assert.ok(/DRAFT PROSE \(a string\) or BOUND/.test(doc._README.shapes.integrity), "the README types integrity as bare prose");
  assert.ok(!/asserts nothing whatever about integrity/.test(JSON.stringify(doc._README)),
    "the README carries the rejected 'eligibility asserts nothing about integrity' framing");
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
  const html = renderWorkbook(synthetic);
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
