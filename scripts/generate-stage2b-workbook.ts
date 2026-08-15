/**
 * Generates the Stage 2B policy workbook: a self-contained local HTML file for authoring capability
 * policy by hand.
 *
 * Run: `npx tsx scripts/generate-stage2b-workbook.ts`
 *
 * WHAT THIS IS NOT. It does not decide anything. Every value it shows beside a question is a
 * CANDIDATE derived from the registry or from a filename search, labelled as such, and never
 * pre-selected -- because policy is the one part of this system an observation cannot supply, and a
 * workbook that guessed would launder a guess into the record as a decision.
 *
 * The workbook is generated FROM the registry and embeds a snapshot of it, so there is no second
 * hand-maintained capability list to drift. It runs from the filesystem with no server, no database,
 * no credentials and no network. It cannot write to the repository and cannot enable anything: the
 * only thing it produces is a downloaded JSON file, which a separate checked-in importer validates
 * before any policy source changes.
 *
 * The page's decision logic is NOT written here. It lives in `lib/stage2b-session.js` and is inlined
 * verbatim, so the regression suite can call it instead of matching its text -- the distinction that
 * let a page which threw on load pass sixteen assertions about its own source.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isYearBearingColumn } from "../lib/capability-policy";
import { decidableCapabilities } from "../lib/sweep-only-capabilities";
import {
  type AuthoredRecord, derivePolicy, entryDigest, readAuthoredRecord, recordShapeErrors,
} from "../lib/stage2b-authored-record";

const DATA_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const REGISTRY_FILE = path.join(DATA_DIR, "capability-registry.json");
const POLICY_FILE = path.join(DATA_DIR, "capability-policy.json");
/** The durable record of what people were asked and answered, written by the importer. */
const ANSWERS_FILE = path.join(DATA_DIR, "capability-answers.json");
export const SESSION_MODULE_FILE = path.join(process.cwd(), "lib", "stage2b-session.js");
export const PLAIN_LANGUAGE_MODULE_FILE = path.join(process.cwd(), "lib", "stage2b-plain-language.js");
export const CATALOG_MODULE_FILE = path.join(process.cwd(), "lib", "stage2b-capability-catalog.js");
export const WORKBOOK_FILE = path.join(process.cwd(), "docs", "superpowers", "stage2b-policy-workbook.html");

/**
 * 5: ONE fingerprint, named `contractFingerprint` from the record through the page to the importer,
 * and a per-entry baseline (`basedOnEntry`) naming the authored record rather than what it derives.
 * Version 4 carried two differently-computed fingerprints under two names and no record baseline,
 * so a v4 file cannot be read safely here and is refused by version.
 *
 * 4 was: the fingerprint an export is checked against covers the QUESTIONS as well as the database
 * structure.
 *
 * 3 was: plain-language questions, with an entry carrying the HUMAN answer, the technical mapping
 * it proposes, and a confirmation of that exact mapping.
 */
export const DECISIONS_VERSION = 5;

export type RegistryEntry = {
  artifact: string;
  prepDependencies: string[];
  emittedDependencies: string[];
  requiredColumns: Record<string, string[]>;
  flagKey: string;
  policy: Record<string, unknown> | null;
  authorizationEligible: boolean;
};

/**
 * Every capability the workbook asks about: the derived registry plus the sweep-only ones.
 *
 * Merged in ONE place, used by the generator and the importer alike. The sweep-only capability is
 * real, needs the same four decisions as any other, and reaches no deterministic operation -- so
 * while it was private to the inventory generator the workbook never asked about it and the
 * importer refused it as unknown. Both now see the same question set, which also means both compute
 * the same fingerprint over it.
 */
export function decidableRegistry(registry: Record<string, RegistryEntry>): Record<string, RegistryEntry> {
  return decidableCapabilities(registry) as Record<string, RegistryEntry>;
}

/**
 * Identifies the STRUCTURE the decisions were made against.
 *
 * Only the structural fields, deliberately: authoring policy changes `policy` and
 * `authorizationEligible` in the registry, and if those fed the fingerprint then importing a
 * session's own decisions would invalidate the file that produced them. A change to tables, columns
 * or artifacts is what makes an export stale, because the questions themselves would have changed.
 */
/**
 * What an answer was given AGAINST: the database structure and the questions alike.
 *
 * The structural fingerprint alone was not identity enough. A reworded question, a changed failure
 * scenario or a narrowed set of process choices moved nothing in it, so an old session loaded
 * cleanly and its confirmation survived under wording the person never read -- a confirmation
 * attached to a question they did not answer.
 */
export type DecisionContractParts = {
  catalog: { fingerprint: () => string };
  plainLanguage?: any;
  translationSource?: string;
};

/**
 * EVERYTHING a person reads before deciding, plus the logic that turns their answer into policy.
 *
 * The registry fingerprint covers database structure. The catalog covers the per-capability
 * question. Neither covered the shared question headings and hints, the option labels and their
 * stated consequences, or `proposeMapping`/`mergeWithExisting` themselves -- so a question could be
 * re-worded, an option's consequence rewritten, or the translation changed outright, and every
 * existing confirmation would survive. A confirmation approves one translation of one question as
 * it was worded; all three of those are part of that, so all three are in the identity.
 */
export function decisionContract(
  registry: Record<string, RegistryEntry>,
  parts: DecisionContractParts,
): string {
  const pl = parts.plainLanguage ?? loadPlainLanguage(parts.catalog);
  const translation = parts.translationSource ?? fs.readFileSync(PLAIN_LANGUAGE_MODULE_FILE, "utf8");
  return JSON.stringify({
    structure: registryFingerprint(registry),
    catalog: parts.catalog.fingerprint(),
    shared: pl.questions(),
    displayed: buildWorkbookModel(registry).map((cap: WorkbookCapability) => pl.contractFor(cap)),
    /**
     * The translation logic by CONTENT. A change to how an answer becomes policy changes what the
     * person's confirmation means, even when every word on the page is identical.
     */
    translation: createHash("sha256").update(translation).digest("hex").slice(0, 16),
  });
}

export function workbookFingerprint(
  registry: Record<string, RegistryEntry>,
  catalog: { fingerprint: () => string },
  parts: Omit<DecisionContractParts, "catalog"> = {},
): string {
  return createHash("sha256")
    .update(decisionContract(registry, { catalog, ...parts }))
    .digest("hex").slice(0, 16);
}

/**
 * The contract in force, from the checked-in registry and catalog.
 *
 * One place computes it, so a consumer asking "is this generated policy current?" cannot answer
 * with a contract of its own construction. Every reader of the generated policy passes this.
 */
export function currentContractFingerprint(): string {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<string, RegistryEntry>;
  return workbookFingerprint(registry, loadCatalog());
}

/** The translation module, loaded from the same file the page inlines. */
export function loadPlainLanguage(catalog: unknown): any {
  const req = createRequire(import.meta.url);
  const { createStage2bPlainLanguage } = req(PLAIN_LANGUAGE_MODULE_FILE) as {
    createStage2bPlainLanguage: (c: unknown) => any;
  };
  return createStage2bPlainLanguage(catalog);
}

export function registryFingerprint(registry: Record<string, RegistryEntry>): string {
  const full = decidableRegistry(registry);
  const structural = Object.keys(full).sort().map((id) => ({
    id,
    artifact: full[id].artifact,
    emittedDependencies: [...full[id].emittedDependencies].sort(),
    prepDependencies: [...full[id].prepDependencies].sort(),
    requiredColumns: Object.fromEntries(
      Object.keys(full[id].requiredColumns).sort().map((t) => [t, [...full[id].requiredColumns[t]].sort()]),
    ),
  }));
  return createHash("sha256").update(JSON.stringify(structural)).digest("hex").slice(0, 16);
}

export type WorkbookCapability = {
  id: string;
  artifact: string;
  reads: string[];
  prepares: string[];
  columns: Record<string, string[]>;
  /**
   * EVERY table/column pair the capability reads, with the year-bearing ones marked.
   *
   * All of them are offered, not just the ones matching a name pattern: filtering by the pattern
   * made that guess load-bearing, because a year column it failed to recognise would have been
   * unselectable and the honest answer unreachable. The mark is a suggestion; the list is complete.
   * Choosing an unmarked one is allowed and costs a justification.
   */
  coverageCandidates: { table: string; yearColumn: string; yearBearing: boolean }[];
  /** Other capabilities over the same emitted table set, and over the same artifact. */
  tableCluster: string[];
  artifactCluster: string[];
  /** Scripts whose text mentions every emitted table. EVIDENCE, not an answer. */
  ownerCandidates: string[];
  /** True when a table the capability reads is absent from some artifact in production. */
  conditionalHint: string | null;
  existingPolicy: Record<string, unknown> | null;
};

/** The reviewed catalog, loaded from the same file the page inlines. */
export function loadCatalog(): any {
  const req = createRequire(import.meta.url);
  const { stage2bCapabilityCatalog } = req(CATALOG_MODULE_FILE) as { stage2bCapabilityCatalog: () => any };
  return stage2bCapabilityCatalog();
}

/** Scripts that mention every one of these tables -- a place to look, not an owner. */
function ownerCandidates(tables: string[], scriptIndex: { file: string; text: string }[]): string[] {
  if (tables.length === 0) return [];
  return scriptIndex
    .filter((entry) => tables.every((table) => entry.text.includes(table.replace(/^rollup\./, ""))))
    .map((entry) => entry.file)
    .sort()
    .slice(0, 6);
}

/**
 * Read once per process. Each render scans every script for every capability's tables, so re-reading
 * the directory per call made the regression suite take longer than the rest of `npm test` combined.
 */
let scriptIndexCache: { file: string; text: string }[] | null = null;
function readScriptIndex(): { file: string; text: string }[] {
  if (scriptIndexCache) return scriptIndexCache;
  scriptIndexCache = readScriptIndexUncached();
  return scriptIndexCache;
}

function readScriptIndexUncached(): { file: string; text: string }[] {
  const dir = path.join(process.cwd(), "scripts");
  return fs.readdirSync(dir)
    .filter((file) => /\.(ts|js|py|sql)$/.test(file) && !file.startsWith("test-"))
    .sort()
    .map((file) => {
      try { return { file, text: fs.readFileSync(path.join(dir, file), "utf8") }; }
      catch { return { file, text: "" }; }
    });
}

export function buildWorkbookModel(registryInput: Record<string, RegistryEntry>): WorkbookCapability[] {
  const registry = decidableRegistry(registryInput);
  const scriptIndex = readScriptIndex();
  const byTableSet = new Map<string, string[]>();
  for (const id of Object.keys(registry).sort()) {
    const key = [...registry[id].emittedDependencies].sort().join("+");
    byTableSet.set(key, [...(byTableSet.get(key) ?? []), id]);
  }
  const byArtifact = new Map<string, string[]>();
  for (const id of Object.keys(registry).sort()) {
    const artifact = registry[id].artifact;
    byArtifact.set(artifact, [...(byArtifact.get(artifact) ?? []), id]);
  }

  return Object.keys(registry).sort().map((id) => {
    const entry = registry[id];
    const tableSetKey = [...entry.emittedDependencies].sort().join("+");
    const coverageCandidates: { table: string; yearColumn: string; yearBearing: boolean }[] = [];
    for (const table of [...entry.emittedDependencies].sort()) {
      for (const column of [...(entry.requiredColumns[table] ?? [])].sort()) {
        coverageCandidates.push({ table, yearColumn: column, yearBearing: isYearBearingColumn(column) });
      }
    }
    // Year-bearing first, so the likely answers are at the top without any being pre-selected.
    coverageCandidates.sort((a, b) => Number(b.yearBearing) - Number(a.yearBearing));
    return {
      id,
      artifact: entry.artifact,
      reads: [...entry.emittedDependencies].sort(),
      prepares: [...entry.prepDependencies].sort(),
      columns: Object.fromEntries(
        Object.keys(entry.requiredColumns).sort().map((t) => [t, [...entry.requiredColumns[t]].sort()]),
      ),
      coverageCandidates,
      tableCluster: (byTableSet.get(tableSetKey) ?? []).filter((other) => other !== id),
      artifactCluster: (byArtifact.get(entry.artifact) ?? []).filter((other) => other !== id),
      ownerCandidates: ownerCandidates(entry.emittedDependencies, scriptIndex),
      conditionalHint: entry.emittedDependencies.includes("agency_county_crosswalk")
        ? "agency_county_crosswalk is absent from production hate_crime.db; availability may be conditional"
        : entry.emittedDependencies.some((t) => t.startsWith("rollup."))
          ? "reads a rollup.* table, which is a separately configured artifact"
          : null,
      existingPolicy: entry.policy,
    };
  });
}

/** Plain-language summary. Describes the CONTRACT; it does not interpret intent. */
function describe(capability: WorkbookCapability): string {
  const reads = capability.reads.join(", ") || "no tables";
  const prep = capability.prepares.length ? ` It also reads ${capability.prepares.join(", ")} while deciding what to build.` : "";
  return `Reads ${reads} from the ${capability.artifact} artifact.${prep}`;
}

/**
 * Embeds JSON inside a <script> element without letting its CONTENT end the element.
 *
 * `</script>` anywhere in a capability id, a condition or a piece of evidence closes the block from
 * inside the string literal, and the rest of the payload lands on the page as markup. U+2028 and
 * U+2029 are line terminators to a JavaScript parser but not to JSON, so they end the statement
 * mid-string. Escaping is at the boundary because that is where the hazard is; nothing upstream has
 * to remember.
 */
function embedJson(value: unknown): string {
  const LINE_SEPARATOR = String.fromCharCode(0x2028);
  const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
  return JSON.stringify(value, null, 1)
    .split("<").join("\\u003c")
    .split(LINE_SEPARATOR).join("\\u2028")
    .split(PARAGRAPH_SEPARATOR).join("\\u2029");
}
/**
 * `catalogOverride` exists for tests that drive a SYNTHETIC registry. Real generation always uses
 * the reviewed catalog and refuses to write a workbook that does not match it.
 */
export function renderWorkbook(
  registryOverride?: Record<string, RegistryEntry>,
  catalogOverride?: { coverageAgainst: (ids: string[]) => { missing: string[]; extra: string[] }; fingerprint: () => string },
  /**
   * `recordOverride` exists so the regression can drive a REAL page built from a chosen record,
   * instead of hand-assembling the payload the page would have been given. Every seeding defect
   * this file has had survived a test that reconstructed the payload: the reconstruction supplied
   * the value the page got wrong. Real generation always reads the checked-in record.
   */
  recordOverride?: { docs: Record<string, unknown>; entries: AuthoredRecord },
): string {
  const registryInput = registryOverride
    ?? (JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<string, RegistryEntry>);
  const model = buildWorkbookModel(registryInput);
  const catalog = catalogOverride ?? loadCatalog();
  /** ONE identity, under ONE name, from here to the page to the importer. */
  const contractFingerprint = workbookFingerprint(registryInput, catalog as { fingerprint: () => string });
  /**
   * Seeded from the ONE authored record: what it derives, and the answers behind it.
   *
   * The page used to read the policy file and a separate answers file, which is how it could show a
   * decision whose question had been lost, or an answer whose policy had been overwritten. There is
   * one source now, so the two cannot disagree.
   */
  const record = recordOverride ?? readAuthoredRecord();
  const recordShape = recordShapeErrors(record.entries);
  if (recordShape.length) {
    throw new Error(["the authored record is malformed, so no workbook was written.",
      ...recordShape.map((problem) => `  ${problem}`)].join("\n"));
  }
  const derived = derivePolicy(record.entries, model, loadPlainLanguage(catalog), contractFingerprint);
  if (derived.errors.length) {
    throw new Error(["the authored record does not derive, so no workbook was written.",
      ...derived.errors.map((problem) => `  ${problem}`)].join("\n"));
  }
  const authored = derived.policy;
  const answers = Object.fromEntries(Object.entries(record.entries)
    .filter(([, entry]) => entry.kind === "decided" || entry.kind === "open")
    .map(([id, entry]) => [id, {
      human: (entry as { human: Record<string, unknown> }).human,
      mappingConfirmed: entry.kind === "decided" ? entry.confirmed : null,
      /**
       * The contract the answer was given against, under the SAME name the record and the importer
       * use. It was carried here as `catalogFingerprint` and compared against the catalog-only
       * digest, which is a different value -- so every restored confirmation looked re-worded and
       * was dropped, every time, in production. Two names for one identity is how that hid.
       */
      contractFingerprint: (entry as { contractFingerprint: string }).contractFingerprint,
    }]));

  /**
   * What the AUTHORED ENTRY was when this page was generated, per capability.
   *
   * The export carries these back so the importer can refuse a session that began before someone
   * else's answer landed. The derived policy cannot do that job: an unconfirmed answer derives
   * nothing, so two people editing the same open capability both look like they started from the
   * same emptiness.
   */
  const entryDigests = Object.fromEntries(model.map((cap) => [cap.id, entryDigest(record.entries[cap.id])]));

  const payload = embedJson({
    v: DECISIONS_VERSION, contractFingerprint, capabilities: model, authored, answers, entryDigests,
  });
  /**
   * Inlined VERBATIM, not re-implemented. The suite imports the same files and asserts the page
   * contains them unchanged, so there is exactly one copy of this logic and no way for the tested
   * copy and the shipped copy to disagree. The importer loads the plain-language module too, so the
   * translation the person confirms is the translation the boundary re-derives.
   */
  const catalogSource = fs.readFileSync(CATALOG_MODULE_FILE, "utf8");
  const plainLanguageSource = fs.readFileSync(PLAIN_LANGUAGE_MODULE_FILE, "utf8");
  const sessionSource = fs.readFileSync(SESSION_MODULE_FILE, "utf8");

  /**
   * The catalog must cover the registry EXACTLY, or no workbook is produced.
   *
   * A capability that arrived without a reviewed description would otherwise be handed a paraphrase
   * of its table names -- which is how three different NIBRS capabilities came to share one
   * description, and how every crime_data capability came to offer all three update processes. A
   * missing entry is a thing to write, not a thing to fall back from.
   */
  const coverage = catalog.coverageAgainst(model.map((c) => c.id));
  if (coverage.missing.length || coverage.extra.length) {
    const lines = [
      "the reviewed capability catalog does not match the registry, so no workbook was written.",
      ...coverage.missing.map((id: string) => `  MISSING from lib/stage2b-capability-catalog.js: ${id}`),
      ...coverage.extra.map((id: string) => `  NO LONGER in the registry, remove it: ${id}`),
      "Each entry needs the question it answers, the update processes that could own it, and the",
      "failure scenarios worth asking about for that data.",
    ];
    throw new Error(lines.join("\n"));
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>Stage 2B policy workbook</title>
<style>
:root{--ink:#16181d;--dim:#5b6172;--line:#d8dbe3;--bg:#fbfbfd;--card:#fff;--warn:#8a5a00;--warnbg:#fff6e5;--ok:#1c6b4a;--okbg:#e9f4ee;--sug:#4a5878;--sugbg:#eef1f7;--alert:#8c2f1d;--alertbg:#fdefec}
*{box-sizing:border-box}
body{margin:0;font:15.5px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--line);padding:10px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;z-index:5}
header b{font-size:14px}
.counts{color:var(--dim);font-size:13px;display:flex;gap:14px;flex-wrap:wrap}
main{max-width:820px;margin:0 auto;padding:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:20px 22px;margin-bottom:16px}
h2{font-size:19px;line-height:1.4;margin:0 0 10px;font-weight:600}
.q{border-top:1px solid var(--line);padding:16px 0}
.q h3{font-size:15px;margin:0 0 4px}
.q .hint{font-size:13.5px;color:var(--dim);margin:0 0 10px}
label.opt{display:block;border:1px solid var(--line);border-radius:6px;padding:9px 12px;margin:6px 0;cursor:pointer}
label.opt:hover{background:#f7f8fb}
label.opt input{margin-right:9px}
label.opt .why{display:block;font-size:13px;color:var(--dim);margin:3px 0 0 24px}
.tag{display:inline-block;font-size:11px;background:var(--okbg);color:var(--ok);border-radius:999px;padding:1px 8px;margin-left:6px;font-weight:600}
input[type=text],textarea{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:5px;font:inherit;background:#fff;margin-top:6px}
textarea{min-height:58px;resize:vertical}
details{margin:8px 0;font-size:13.5px}
details summary{cursor:pointer;color:var(--sug)}
details .body{background:var(--sugbg);border-left:3px solid var(--sug);padding:9px 12px;margin-top:6px;border-radius:0 4px 4px 0;color:#39435c}
.observed{font-size:12.5px;color:var(--dim);font-style:italic}
.mapping{background:var(--sugbg);border:1px solid #d3d9e6;border-radius:7px;padding:13px 15px;margin-top:6px}
.mapping dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:13.5px}
.mapping dt{color:var(--dim)}
.mapping dd{margin:0}
.warn{background:var(--warnbg);border-left:3px solid var(--warn);padding:9px 12px;margin:10px 0;font-size:13.5px;color:var(--warn);border-radius:0 4px 4px 0}
.alert{background:var(--alertbg);border-left:3px solid var(--alert);padding:9px 12px;margin:10px 0;font-size:13.5px;color:var(--alert);border-radius:0 4px 4px 0}
.good{background:var(--okbg);border-left:3px solid var(--ok);padding:9px 12px;margin:10px 0;font-size:13.5px;color:var(--ok);border-radius:0 4px 4px 0}
button{font:inherit;padding:8px 14px;border:1px solid var(--line);background:#fff;border-radius:6px;cursor:pointer}
button.primary{background:var(--ink);color:#fff;border-color:var(--ink)}
button:disabled{opacity:.45;cursor:not-allowed}
.nav{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
#dirty{font-size:12.5px;font-weight:600;padding:3px 9px;border-radius:999px}
#dirty.unsaved{background:var(--warnbg);color:var(--warn)}
#dirty.saved{background:var(--okbg);color:var(--ok)}
ul.affected{margin:8px 0 0;padding-left:20px;font-size:12.5px;max-height:190px;overflow:auto}
dialog{border:1px solid var(--line);border-radius:9px;padding:20px;max-width:640px}
code{font:12px ui-monospace,Menlo,monospace;background:#f2f3f7;padding:1px 4px;border-radius:3px;word-break:break-all}
</style></head><body>
<header>
 <b>Stage 2B policy workbook</b>
 <span id="dirty" class="saved">Nothing to save yet</span>
 <span class="counts" id="counts"></span>
 <span style="flex:1"></span>
 <select id="filter" style="width:auto;padding:6px 8px;border:1px solid var(--line);border-radius:5px">
  <option value="all">All lookups</option>
  <option value="unanswered">Not yet answered</option>
  <option value="unconfirmed">Answered, mapping not confirmed</option>
  <option value="problems">Needs something fixed</option>
  <option value="conditional">Possibly sometimes-unavailable</option>
 </select>
 <button id="import">Load a saved session</button>
 <button class="primary" id="export">Export answers</button>
 <input type="file" id="file" accept="application/json" hidden/>
</header>
<main>
 <div class="alert" id="staleness" hidden></div>
 <div class="warn">Your answers live only in this tab until you press <b>Export answers</b>. Nothing here
  changes any system, switches anything on, or reaches the internet. Export every few answers — a closed
  tab or a browser crash takes unexported work with it.</div>
 <div id="card"></div>
 <div class="nav">
  <button id="prev">Previous</button>
  <button id="next">Next</button>
  <button class="primary" id="nextUnanswered">Next unanswered</button>
  <button id="cluster">Copy these answers to similar lookups…</button>
 </div>
</main>
<dialog id="confirm">
 <h3>Copy to similar lookups</h3>
 <p id="confirmIntro"></p>
 <p style="font-size:13px;color:#5b6172">Every lookup that would change is named below. Each one keeps its
  own technical mapping, which you will need to review and confirm separately. Nothing is copied until you confirm.</p>
 <ul class="affected" id="affected"></ul>
 <div class="nav"><button id="cancelCluster">Cancel</button><button class="primary" id="applyCluster">Copy to these</button></div>
</dialog>
<script>
const DATA = ${payload};
/* Your answers live only in this page's memory until you press Export. Nothing here can reach the
   repository, a database, or any switch: the sole output is a downloaded file. */

${catalogSource}

${plainLanguageSource}

${sessionSource}

const PL = createStage2bPlainLanguage(stage2bCapabilityCatalog());
/* Shared wording comes from the contract the fingerprint covers, never from this template. */
const Q = PL.questions();
const S = createStage2bSession(DATA, PL);
let index = 0;

function esc(s){ return String(s).replace(/[&<>"]/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }

function matches(cap){
  const f = document.getElementById("filter").value;
  if (f === "all") return true;
  if (f === "unanswered") return !PL.isAnswered(S.human(cap.id));
  if (f === "unconfirmed") return PL.isAnswered(S.human(cap.id)) && !S.isMappingConfirmed(cap.id);
  if (f === "problems") return S.problems(cap.id).length > 0;
  if (f === "conditional") return !!cap.conditionalHint;
  return true;
}
function visible(){ const v = DATA.capabilities.filter(matches); return v.length ? v : DATA.capabilities; }

function status(){
  const c = S.counts();
  document.getElementById("counts").innerHTML =
    '<span>Finished: <b>'+c.complete+'</b>/'+DATA.capabilities.length+'</span>'+
    '<span>Awaiting confirmation: <b>'+c.unconfirmed+'</b></span>'+
    (c.problems?'<span>Needs fixing: <b>'+c.problems+'</b></span>':'');
  const badge = document.getElementById("dirty");
  const changed = Object.keys(S.changeSet()).length;
  if (S.isDirty()){ badge.className = "unsaved"; badge.textContent = "Unsaved — export to keep your answers"; }
  else { badge.className = "saved"; badge.textContent = changed ? "Saved: "+changed+" exported" : "Nothing to save yet"; }
}

/* Renders the technical policy these answers WOULD produce. Shown, never applied unconfirmed. */
function mappingPanel(cap){
  const p = S.proposal(cap.id), m = p.merged;
  /* Kept-not-set is marked, because a field shown blank would describe a different outcome. */
  const kept = (field) => p.preserved.indexOf(field) >= 0
    ? ' <b style="color:#8a5a00">— kept from what was already recorded; your answer left this open</b>' : '';
  const line = (label, value, field) => '<dt>'+label+'</dt><dd>'+value+(field?kept(field):'')+'</dd>';
  const rows = [
    line(Q.mapping.labels.coverage, m.coverage === null ? '<i>left open</i>'
      : m.coverage.kind === 'none' ? 'not about a time period — ' + esc(m.coverage.reason)
      : 'first and last year read from <code>'+esc(m.coverage.table+'.'+m.coverage.yearColumn)+'</code>', 'coverage'),
    line(Q.mapping.labels.integrity, m.integrity === null ? '<i>left open</i>'
      : '<ul style="margin:0;padding-left:16px">'+m.integrity.map((r)=>'<li>'+esc(r)+'</li>').join('')+'</ul>', 'integrity'),
    line(Q.mapping.labels.availability, m.availability === null ? '<i>left open</i>'
      : m.availability.kind === 'always' ? 'yes, always expected'
      : 'not always — ' + esc(m.availability.condition), 'availability'),
    line(Q.mapping.labels.receiptOwner, m.receiptOwner === null ? '<i>left open</i>' : esc(m.receiptOwner), 'receiptOwner'),
  ].join('');
  const confirmed = S.isMappingConfirmed(cap.id);
  const answered = PL.isAnswered(S.human(cap.id));
  const problems = S.problems(cap.id);
  return '<div class="q"><h3>'+esc(Q.mapping.heading)+'</h3>'+
    '<p class="hint">'+esc(Q.mapping.hint)+'</p>'+
    '<div class="mapping"><dl>'+rows+'</dl></div>'+
    (problems.length ? '<div class="alert">Before this can be confirmed: '+problems.map(esc).join('; ')+'</div>' : '')+
    (p.unresolved.length ? '<div class="warn">Left open: '+p.unresolved.map((f)=>esc(({coverage:'the years question',integrity:'what going wrong looks like',availability:'whether it is always there',receiptOwner:'who keeps it up to date'})[f]||f)).join(', ')+
      '. That is a legitimate place to stop — it is recorded as undecided, and this lookup stays switched off.'+
      (p.preserved.length ? ' Anything already recorded for those is kept as it was: leaving a question open never'
        + ' deletes an existing decision. Removing one is the separate action at the bottom of this page.' : '')+
      '</div>' : '')+
    (S.needsReconfirmation(cap.id) ? '<div class="warn">You confirmed this before, but the question has been'+
      ' re-worded since. Your answer is still here — please read the wording above and confirm it again.</div>' : '')+
    (confirmed ? '<div class="good">Confirmed. This wording is what your export will carry.</div>'
      : '<button class="primary" id="confirmMapping"'+(answered && !problems.length ? '' : ' disabled')+'>'+esc(Q.mapping.confirmLabel)+'</button>')+
    '</div>';
}

function render(){
  const list = visible();
  if (index >= list.length) index = 0;
  const cap = list[index], h = S.human(cap.id);

  const covOpts = PL.coverageOptions(cap).map((o) =>
    '<label class="opt"><input type="radio" name="cov" value="'+esc(o.value)+'"'+(h.coverage===o.value?' checked':'')+'/>'+
      esc(o.label)+(o.recommended?'<span class="tag">recommended</span>':'')+
      '<span class="why">'+esc(o.consequence)+'</span></label>').join('');
  const covWhy = PL.coverageOptions(cap).map((o)=>'<li><b>'+esc(o.label)+'</b> — '+esc(o.why)+'</li>').join('');
  const scenarios = PL.integrityScenarios(cap).map((s) =>
    '<label class="opt"><input type="checkbox" name="integ" value="'+esc(s.value)+'"'+
      ((h.integrity||[]).indexOf(s.value)>=0?' checked':'')+'/>'+esc(s.label)+'</label>').join('');
  const availOpts = PL.availabilityOptions().map((o) =>
    '<label class="opt"><input type="radio" name="avail" value="'+esc(o.value)+'"'+(h.availability===o.value?' checked':'')+'/>'+
      esc(o.label)+'<span class="why">'+esc(o.consequence)+'</span></label>').join('');
  const ownerOpts = PL.ownerOptions(cap).map((o) =>
    '<label class="opt"><input type="radio" name="owner" value="'+esc(o.value)+'"'+(h.owner===o.value?' checked':'')+'/>'+
      esc(o.label)+'</label>').join('');

  document.getElementById("card").innerHTML =
  '<div class="card">'+
   '<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap">'+
     '<h2>'+esc(PL.describeQuestion(cap))+'</h2>'+
     '<span class="observed">'+(index+1)+' of '+list.length+'</span></div>'+
   '<p class="observed">That summary comes from the names used in the data, so read it as a rough'+
     ' description rather than an exact one. Everything under "Technical details" is what the code'+
     ' actually does — it is not up for decision. The four questions below are.</p>'+
   '<details><summary>Technical details</summary><div class="body">'+
     'Identifier <code>'+esc(cap.id)+'</code><br/>Data source <code>'+esc(cap.artifact)+'</code><br/>'+
     'Reads '+cap.reads.map((t)=>'<code>'+esc(t)+'</code>').join(' ')+
     '<br/>Columns: '+Object.keys(cap.columns).map((t)=>esc(t)+' ('+cap.columns[t].map(esc).join(', ')+')').join(' · ')+
     (cap.ownerCandidates.length?'<br/>Scripts mentioning every one of these tables (a filename search, not an answer): '+
       cap.ownerCandidates.map((o)=>'<code>'+esc(o)+'</code>').join(' '):'')+
   '</div></details>'+
   (cap.conditionalHint?'<div class="warn">Observed: '+esc(cap.conditionalHint)+'</div>':'')+

   '<div class="q"><h3>'+esc(Q.coverage.heading)+'</h3>'+
    '<p class="hint">'+esc(Q.coverage.hint)+'</p>'+covOpts+
    '<details><summary>Why this is recommended</summary><div class="body"><ul style="margin:0;padding-left:16px">'+covWhy+'</ul>'+
      '<div style="margin-top:8px">Every column this lookup reads is listed below. The recommendation comes from'+
      ' a column NAME, which is a fact about the name and not a check of its contents — if the right column is a'+
      ' different one, choose it here.</div>'+
      '<div style="margin-top:6px"><label>Use a specific column instead</label><select id="covColumn" style="width:100%;padding:7px">'+
        '<option value="">— use the recommended one —</option>'+
        cap.coverageCandidates.map((o,i)=>'<option value="'+i+'"'+
          (h.coverageColumn && h.coverageColumn.table===o.table && h.coverageColumn.yearColumn===o.yearColumn?' selected':'')+
          '>'+esc(o.table+'.'+o.yearColumn)+(o.yearBearing?' — named like a year':'')+'</option>').join('')+
      '</select></div></div></details>'+
    '<label>'+esc(Q.coverage.reasonLabel)+'</label>'+
    '<input type="text" id="covReason" value="'+esc(h.coverageReason||"")+'"/>'+
   '</div>'+

   '<div class="q"><h3>'+esc(Q.integrity.heading)+'</h3>'+
    '<p class="hint">'+esc(Q.integrity.hint)+'</p>'+
    scenarios+
    '<label class="opt"><input type="checkbox" id="integUnsure"'+(h.integrityUnsure?' checked':'')+'/>'+esc(Q.integrity.unsureLabel)+'</label>'+
    '<label>'+esc(Q.integrity.otherLabel)+'</label>'+
    '<input type="text" id="integOther" value="'+esc(h.integrityOther||"")+'"/>'+
   '</div>'+

   '<div class="q"><h3>'+esc(Q.availability.heading)+'</h3>'+
    '<p class="hint">'+esc(Q.availability.hint)+'</p>'+availOpts+
    (h.availability==="sometimes"
      ? '<label>'+esc(Q.availability.whenLabel)+'</label><input type="text" id="availWhen" value="'+esc(h.availabilityWhen||"")+'"/>'
      : '')+
   '</div>'+

   '<div class="q"><h3>'+esc(Q.owner.heading)+'</h3>'+
    '<p class="hint">'+esc(Q.owner.hint)+'</p>'+ownerOpts+
    (h.owner==="other"
      ? '<label>'+esc(Q.owner.otherLabel)+'</label><input type="text" id="ownerOther" value="'+esc(h.ownerOther||"")+'"/>'
      : '')+
   '</div>'+

   '<div class="q"><h3>'+esc(Q.evidence.heading)+'</h3>'+
    '<p class="hint">'+esc(Q.evidence.hint)+'</p>'+
    '<textarea id="evidence">'+esc(h.evidence||"")+'</textarea></div>'+

   '<div id="mapping"></div>'+

   (S.canWithdraw(cap.id)
     ? '<div class="q"><h3>Remove the existing policy for this lookup</h3>'+
       '<p class="hint">Something was already recorded here. Removing it is a separate, named action —'+
       ' leaving the questions above unanswered does NOT delete it.</p>'+
       (S.isWithdrawn(cap.id)
         ? '<div class="alert">Marked for removal. Exporting and importing will remove what was recorded.</div>'
         : '<button id="withdraw">Remove the recorded policy…</button>')
       +'</div>'
     : '')+
  '</div>';

  const value = (id) => { const el = document.getElementById(id); return el ? el.value : ""; };
  /**
   * The mapping panel repaints on every edit, in place.
   *
   * It used to be part of the card, which is only rebuilt when a radio changes -- so typing the
   * missing reason cleared the problem, and the "confirm" button stayed greyed out with no way to
   * press it. Repainting only this panel keeps the cursor where the person is typing.
   */
  const renderMapping = () => {
    const host = document.getElementById("mapping");
    if (!host) return;
    host.innerHTML = mappingPanel(cap);
    const button = document.getElementById("confirmMapping");
    if (button) button.addEventListener("click", () => { S.confirmMapping(cap.id); status(); renderMapping(); });
  };
  const save = () => {
    const covRadio = document.querySelector('input[name=cov]:checked');
    const availRadio = document.querySelector('input[name=avail]:checked');
    const ownerRadio = document.querySelector('input[name=owner]:checked');
    const columnSel = document.getElementById("covColumn");
    const picked = columnSel && columnSel.value !== "" ? cap.coverageCandidates[Number(columnSel.value)] : null;
    S.update(cap.id, {
      coverage: covRadio ? covRadio.value : null,
      coverageColumn: picked ? { table: picked.table, yearColumn: picked.yearColumn } : null,
      coverageReason: value("covReason"),
      integrity: Array.prototype.slice.call(document.querySelectorAll('input[name=integ]:checked')).map((e)=>e.value),
      integrityOther: value("integOther"),
      integrityUnsure: !!(document.getElementById("integUnsure") || {}).checked,
      availability: availRadio ? availRadio.value : null,
      availabilityWhen: value("availWhen"),
      owner: ownerRadio ? ownerRadio.value : null,
      ownerOther: value("ownerOther"),
      evidence: value("evidence"),
    });
    status();
    renderMapping();
  };
  /* Radios re-render, because which follow-up field is asked depends on the choice. */
  for (const name of ["cov","avail","owner"]){
    Array.prototype.slice.call(document.querySelectorAll('input[name='+name+']')).forEach((el) => {
      el.addEventListener("change", () => { save(); render(); });
    });
  }
  for (const id of ["covReason","integOther","availWhen","ownerOther","evidence"]){
    const el = document.getElementById(id); if (el) el.addEventListener("input", save);
  }
  const columnSel = document.getElementById("covColumn");
  if (columnSel) columnSel.addEventListener("change", () => { save(); render(); });
  Array.prototype.slice.call(document.querySelectorAll('input[name=integ]')).forEach((el) => {
    el.addEventListener("change", () => { save(); render(); });
  });
  const unsure = document.getElementById("integUnsure");
  if (unsure) unsure.addEventListener("change", () => { save(); render(); });

  renderMapping();

  const withdrawButton = document.getElementById("withdraw");
  if (withdrawButton) withdrawButton.addEventListener("click", () => {
    if (!confirm("Remove the recorded policy for this lookup?\\n\\n"+cap.id+
      "\\n\\nExporting and importing will REMOVE it. This is not the same as leaving the questions unanswered.")) return;
    S.withdraw(cap.id); status(); render();
  });
  status();
}

document.getElementById("filter").addEventListener("change", () => { index = 0; render(); });
document.getElementById("prev").addEventListener("click", () => { const l=visible(); index=(index-1+l.length)%l.length; render(); });
document.getElementById("next").addEventListener("click", () => { const l=visible(); index=(index+1)%l.length; render(); });
document.getElementById("nextUnanswered").addEventListener("click", () => {
  const l = visible();
  for (let step=1; step<=l.length; step++){
    const probe=(index+step)%l.length;
    if (!PL.isAnswered(S.human(l[probe].id))){ index=probe; render(); return; }
  }
  alert("Every lookup in this view has been answered.");
});

/* Copying names EVERY affected lookup, and what it costs them, before anything changes. */
document.getElementById("cluster").addEventListener("click", () => {
  const cap = visible()[index];
  const plan = S.clusterPlan(cap.id);
  document.getElementById("confirmIntro").textContent = plan.answered
    ? 'Copy your answers to '+plan.targets.length+' lookup(s) reading '+plan.scope+'.'
    : 'There are no answers here to copy yet.';
  document.getElementById("affected").innerHTML = plan.detail.map((entry) => {
    const notes = [];
    if (entry.overwrites) notes.push('replaces answers already given there');
    if (entry.confirmationCleared) notes.push('its confirmation will be cancelled, so you must re-check its wording');
    return '<li>'+esc(entry.id)+(notes.length?' <b style="color:#8a5a00">— '+esc(notes.join("; "))+'</b>':'')+'</li>';
  }).join('') || '<li>(none)</li>';
  document.getElementById("applyCluster").disabled = !plan.answered || !plan.targets.length;
  document.getElementById("confirm").showModal();
});
document.getElementById("cancelCluster").addEventListener("click", () => document.getElementById("confirm").close());
document.getElementById("applyCluster").addEventListener("click", () => {
  S.applyCluster(visible()[index].id);
  document.getElementById("confirm").close();
  status(); render();
});

document.getElementById("export").addEventListener("click", () => {
  const blob = new Blob([S.serialize()], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "stage2b-policy-decisions.json"; a.click();
  URL.revokeObjectURL(a.href);
  S.markClean();
  status();
});
document.getElementById("import").addEventListener("click", () => document.getElementById("file").click());
document.getElementById("file").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const note = document.getElementById("staleness");
    let parsed; try { parsed = JSON.parse(reader.result); } catch { note.hidden = false; note.textContent = "That file is not JSON. Nothing was loaded."; return; }
    let result = S.loadSession(parsed);
    /* Loading REPLACES the session, so unsaved work has to be given up deliberately. */
    if (!result.ok && result.needsConfirmation){
      if (!confirm(result.reason)) { note.hidden = false; note.textContent = "Nothing was loaded; your unsaved answers are still here."; return; }
      result = S.loadSession(parsed, { discardUnsaved: true });
    }
    if (!result.ok){ note.hidden = false; note.textContent = result.reason; index = 0; status(); render(); return; }
    note.hidden = result.unknown.length === 0;
    if (result.unknown.length) note.textContent = "Loaded "+result.applied+" lookup(s). "+
      result.unknown.length+" entry(ies) in that file are not lookups in this workbook and were ignored.";
    index = 0; status(); render();
  };
  reader.readAsText(f);
});

/* Only when there is something to lose. A guard that always fires is one people learn to dismiss. */
window.addEventListener("beforeunload", (e) => {
  if (!S.isDirty()) return;
  e.preventDefault();
  e.returnValue = "";
  return "";
});
render();
</script></body></html>
`;
}

if (process.argv[1] && path.resolve(process.argv[1]).includes("generate-stage2b-workbook")) {
  fs.mkdirSync(path.dirname(WORKBOOK_FILE), { recursive: true });
  fs.writeFileSync(WORKBOOK_FILE, renderWorkbook());
  console.log(`wrote ${path.relative(process.cwd(), WORKBOOK_FILE)}`);
}
