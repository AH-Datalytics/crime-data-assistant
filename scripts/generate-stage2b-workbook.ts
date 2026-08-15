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
import { isYearBearingColumn } from "../lib/capability-policy";
import { decidableCapabilities } from "../lib/sweep-only-capabilities";

const DATA_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const REGISTRY_FILE = path.join(DATA_DIR, "capability-registry.json");
const POLICY_FILE = path.join(DATA_DIR, "capability-policy.json");
export const SESSION_MODULE_FILE = path.join(process.cwd(), "lib", "stage2b-session.js");
export const WORKBOOK_FILE = path.join(process.cwd(), "docs", "superpowers", "stage2b-policy-workbook.html");

/**
 * 2: the export became a conflict-checked CHANGE SET carrying the baseline each entry was authored
 * against, and coverage became a discriminated union. A v1 file cannot be read as either, so it is
 * refused by version rather than misread field by field.
 */
export const DECISIONS_VERSION = 2;

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

export function renderWorkbook(registryOverride?: Record<string, RegistryEntry>): string {
  const registryInput = registryOverride
    ?? (JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<string, RegistryEntry>);
  const model = buildWorkbookModel(registryInput).map((c) => ({ ...c, description: describe(c) }));
  const fingerprint = registryFingerprint(registryInput);
  const existing = fs.existsSync(POLICY_FILE)
    ? JSON.parse(fs.readFileSync(POLICY_FILE, "utf8")) as Record<string, unknown>
    : {};
  const authored = Object.fromEntries(
    Object.entries(existing).filter(([id]) => !id.startsWith("_")),
  );

  const payload = embedJson({ v: DECISIONS_VERSION, fingerprint, capabilities: model, authored });
  /**
   * Inlined VERBATIM, not re-implemented. The suite imports the same file and asserts the page
   * contains it unchanged, so there is exactly one copy of this logic and no way for the tested
   * copy and the shipped copy to disagree.
   */
  const sessionSource = fs.readFileSync(SESSION_MODULE_FILE, "utf8");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>Stage 2B policy workbook</title>
<style>
:root{--ink:#16181d;--dim:#5b6172;--line:#d8dbe3;--bg:#fbfbfd;--card:#fff;--warn:#8a5a00;--warnbg:#fff6e5;--ok:#1c6b4a;--sug:#4a5878;--sugbg:#eef1f7;--alert:#8c2f1d;--alertbg:#fdefec}
*{box-sizing:border-box}
body{margin:0;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--line);padding:10px 20px;display:flex;gap:18px;align-items:center;flex-wrap:wrap;z-index:5}
header b{font-size:14px}
.counts{color:var(--dim);font-size:13px;display:flex;gap:14px;flex-wrap:wrap}
main{max-width:940px;margin:0 auto;padding:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:18px 20px;margin-bottom:16px}
h2{font-size:17px;margin:0 0 4px}
.id{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);word-break:break-all;margin-bottom:10px}
.meta{font-size:13px;color:var(--dim);margin-bottom:14px}
.q{border-top:1px solid var(--line);padding:14px 0}
.q h3{font-size:14px;margin:0 0 8px}
label{display:block;font-size:13px;margin:6px 0 3px;color:var(--dim)}
select,input[type=text],textarea{width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:5px;font:inherit;background:#fff}
textarea{min-height:52px;resize:vertical}
.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1;min-width:200px}
.sug{background:var(--sugbg);border-left:3px solid var(--sug);padding:7px 10px;margin:8px 0;font-size:12.5px;color:#39435c;border-radius:0 4px 4px 0}
.sug b{color:var(--sug)}
.warn{background:var(--warnbg);border-left:3px solid var(--warn);padding:8px 11px;margin:10px 0;font-size:13px;color:var(--warn);border-radius:0 4px 4px 0}
.alert{background:var(--alertbg);border-left:3px solid var(--alert);padding:8px 11px;margin:10px 0;font-size:13px;color:var(--alert);border-radius:0 4px 4px 0}
button{font:inherit;padding:8px 14px;border:1px solid var(--line);background:#fff;border-radius:6px;cursor:pointer}
button.primary{background:var(--ink);color:#fff;border-color:var(--ink)}
button:disabled{opacity:.45;cursor:not-allowed}
.nav{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
.undecided{color:var(--warn);font-weight:600}
.decided{color:var(--ok);font-weight:600}
#dirty{font-size:12.5px;font-weight:600;padding:3px 9px;border-radius:999px}
#dirty.unsaved{background:var(--warnbg);color:var(--warn)}
#dirty.saved{background:#e9f4ee;color:var(--ok)}
ul.affected{margin:8px 0 0;padding-left:20px;font:12px ui-monospace,Menlo,monospace;max-height:190px;overflow:auto}
dialog{border:1px solid var(--line);border-radius:9px;padding:20px;max-width:640px}
dialog h3{margin-top:0}
.pill{display:inline-block;font-size:11.5px;background:#eef0f5;color:var(--dim);border-radius:999px;padding:2px 9px;margin-right:6px}
code{font:12px ui-monospace,Menlo,monospace;background:#f2f3f7;padding:1px 4px;border-radius:3px}
</style></head><body>
<header>
 <b>Stage 2B policy workbook</b>
 <span id="dirty" class="saved">Nothing to save yet</span>
 <span class="counts" id="counts"></span>
 <span style="flex:1"></span>
 <select id="filter" style="width:auto">
  <option value="all">All capabilities</option>
  <option value="undecided">Any field undecided</option>
  <option value="integrity">Integrity undecided</option>
  <option value="coverage">Coverage undecided</option>
  <option value="owner">Receipt owner undecided</option>
  <option value="conditional">Possibly conditional</option>
  <option value="unique">Unique table set</option>
 </select>
 <button id="import">Load a saved session</button>
 <button class="primary" id="export">Export decisions</button>
 <input type="file" id="file" accept="application/json" hidden/>
</header>
<main>
 <div class="alert" id="staleness" hidden></div>
 <div class="sug">Decisions live only in this tab until you press <b>Export decisions</b>. Nothing here
  can change the repository. Export whenever you have done a few — a closed tab or a browser crash
  takes unexported work with it.</div>
 <div id="card"></div>
 <div class="nav">
  <button id="prev">Previous</button>
  <button id="next">Next</button>
  <button class="primary" id="nextUndecided">Next undecided</button>
  <button id="cluster">Apply to related capabilities…</button>
 </div>
</main>
<dialog id="confirm">
 <h3>Apply to related capabilities</h3>
 <p id="confirmIntro"></p>
 <p style="font-size:13px;color:#5b6172">Every capability that would change is named below. Nothing is applied until you confirm.</p>
 <ul class="affected" id="affected"></ul>
 <div class="nav"><button id="cancelCluster">Cancel</button><button class="primary" id="applyCluster">Apply to these</button></div>
</dialog>
<script>
const DATA = ${payload};
/* Decisions live only in this page's memory until you press Export. Nothing here can reach the
   repository, a database, or any flag: the sole output is a downloaded file. */

${sessionSource}

const S = createStage2bSession(DATA);
let index = 0;

const isUnique = (c) => c.tableCluster.length === 0;
function matches(cap){
  const d = S.decisions[cap.id], f = document.getElementById("filter").value;
  if (f === "all") return true;
  if (f === "undecided") return S.undecidedFields(d).length > 0;
  if (f === "conditional") return !!cap.conditionalHint;
  if (f === "unique") return isUnique(cap);
  return d[f === "owner" ? "receiptOwner" : f] === null;
}
function visible(){ const v = DATA.capabilities.filter(matches); return v.length ? v : DATA.capabilities; }

function esc(s){ return String(s).replace(/[&<>"]/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }

function status(){
  const c = S.counts();
  document.getElementById("counts").innerHTML =
    '<span>Complete: <b class="decided">'+c.complete+'</b>/'+DATA.capabilities.length+'</span>'+
    (c.problems?'<span>Needs fixing: <b class="undecided">'+c.problems+'</b></span>':'')+
    '<span>Coverage undecided: <b class="undecided">'+c.coverage+'</b></span>'+
    '<span>Integrity undecided: <b class="undecided">'+c.integrity+'</b></span>'+
    '<span>Availability undecided: <b class="undecided">'+c.availability+'</b></span>'+
    '<span>Owner undecided: <b class="undecided">'+c.receiptOwner+'</b></span>';
  const badge = document.getElementById("dirty");
  const changed = Object.keys(S.changeSet()).length;
  if (S.isDirty()){ badge.className = "unsaved"; badge.textContent = "Unsaved changes — export to keep them"; }
  else { badge.className = "saved"; badge.textContent = changed ? "Saved: "+changed+" exported" : "Nothing to save yet"; }
}

function render(){
  const list = visible();
  if (index >= list.length) index = 0;
  const cap = list[index], d = S.decisions[cap.id];
  const cov = d.coverage;
  const selectedIndex = cov && cov.kind === "column"
    ? cap.coverageCandidates.findIndex((o) => o.table===cov.table && o.yearColumn===cov.yearColumn) : -1;
  const covOpts = cap.coverageCandidates.map((o,i) =>
    '<option value="'+i+'"'+(i===selectedIndex ? ' selected':'')+'>'+
      esc(o.table+'.'+o.yearColumn)+(o.yearBearing?' — suggested (year-bearing)':'')+'</option>').join('');
  const ownerOpts = cap.ownerCandidates.map((o) =>
    '<option value="'+esc(o)+'"'+(d.receiptOwner===o?' selected':'')+'>'+esc(o)+'</option>').join('');
  const avail = d.availability ? d.availability.kind : "";
  const needsJust = S.coverageNeedsJustification(cap.id, cov);
  const problem = S.coverageProblem(cap.id, cov);

  document.getElementById("card").innerHTML =
  '<div class="card">'+
   '<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap">'+
     '<h2>'+esc(cap.description)+'</h2>'+
     '<span class="pill">'+(index+1)+' of '+list.length+(list.length!==DATA.capabilities.length?' (filtered)':'')+'</span></div>'+
   '<div class="id">'+esc(cap.id)+'</div>'+
   '<div class="meta"><span class="pill">'+esc(cap.artifact)+'</span>'+
     'Reads <code>'+cap.reads.map(esc).join('</code> <code>')+'</code>'+
     (cap.prepares.length?' · prepares <code>'+cap.prepares.map(esc).join('</code> <code>')+'</code>':'')+
     '<br/>Columns: '+Object.keys(cap.columns).map((t)=>esc(t)+' ('+cap.columns[t].map(esc).join(', ')+')').join(' · ')+
     '<br/>Shares its table set with '+cap.tableCluster.length+' other capability(ies); '+cap.artifactCluster.length+' others use this artifact.</div>'+
   (cap.conditionalHint?'<div class="warn">'+esc(cap.conditionalHint)+'</div>':'')+

   '<div class="q"><h3>1. Coverage — how do we know the data covers the years asked for?</h3>'+
    '<div class="sug"><b>Candidates</b> (every column this capability reads)'+
      (cap.coverageCandidates.some((o)=>o.yearBearing)?'':' — no column here looks year-bearing, so "No year dimension" may be the honest answer')+
      '. The mark is a hint, not a filter: any column may be chosen, and an unmarked one asks you to say why.</div>'+
    '<div class="row"><div><label>Basis</label><select id="cov">'+
      '<option value=""'+(cov?'':' selected')+'>— Undecided —</option>'+covOpts+
      '<option value="none"'+(cov&&cov.kind==="none"?' selected':'')+'>No year dimension (state the reason below)</option>'+
    '</select></div></div>'+
    (cov&&cov.kind==="none"
      ? '<div><label>Why does this capability have no year dimension?</label>'+
        '<input type="text" id="covReason" value="'+esc(cov.reason||"")+'"/></div>' : '')+
    (needsJust
      ? '<div><label>This column is not year-bearing by name. Why is it the coverage basis?</label>'+
        '<input type="text" id="covJust" value="'+esc(cov.justification||"")+'"/></div>' : '')+
    (problem?'<div class="alert">'+esc(problem)+'</div>':'')+
   '</div>'+

   '<div class="q"><h3>2. Integrity — what would tell us this data is broken?</h3>'+
    '<div class="sug">Free text, one rule per line. Leave empty for undecided. An empty list is not a rule.'+
      ' <b>Draft, and non-authorizing</b>: write the plain-language rule describing what broken data would look like.'+
      ' Nothing can run these yet, and no capability becomes eligible however complete the rest of the entry looks —'+
      ' what you write here is the record a real check will later be written from.</div>'+
    /* Bound rules are shown but not editable here: the textarea is re-parsed on every keystroke
       anywhere on the card, so anything inside it can be rewritten by an unrelated edit. */
    (S.boundRules(cap.id).length
      ? '<div class="sug"><b>Bound rules</b> (kept as authored; edit them in the policy source)<ul style="margin:6px 0 0;padding-left:20px">'+
        S.boundRules(cap.id).map((r)=>'<li>'+esc(r.rule)+' <code>'+esc(r.boundTo)+'</code></li>').join('')+
        '</ul></div>' : '')+
    '<textarea id="integrity" placeholder="e.g. national_monthly and agency_monthly must share a MAX(year*100+month)">'+
      esc(S.draftRules(cap.id).join("\\n"))+'</textarea></div>'+

   '<div class="q"><h3>3. Availability — is this always present?</h3>'+
    '<div class="row"><div><label>Kind</label><select id="avail">'+
      '<option value="">— Undecided —</option>'+
      '<option value="always"'+(avail==="always"?' selected':'')+'>Always</option>'+
      '<option value="conditional"'+(avail==="conditional"?' selected':'')+'>Conditional</option>'+
    '</select></div><div><label>Condition (required if conditional)</label>'+
      '<input type="text" id="cond" value="'+esc(d.availability&&d.availability.condition?d.availability.condition:"")+'"/></div></div></div>'+

   '<div class="q"><h3>4. Receipt owner — which process keeps this fresh?</h3>'+
    '<div class="sug"><b>Scripts mentioning every table this reads</b> — a place to look, not an answer'+
      (cap.ownerCandidates.length?'':' — none found; type the owner yourself')+'</div>'+
    '<div class="row"><div><label>From candidates</label><select id="ownerPick">'+
      '<option value="">— Undecided —</option>'+ownerOpts+
      '<option value="__other"'+(d.receiptOwner&&!cap.ownerCandidates.includes(d.receiptOwner)?' selected':'')+'>Other (type below)</option>'+
    '</select></div><div><label>Owner</label><input type="text" id="owner" value="'+esc(d.receiptOwner||"")+'"/></div></div></div>'+

   '<div class="q"><h3>Evidence — what do these answers rest on?</h3>'+
    '<div class="sug">Required before a capability counts as complete. A file:line, a production observation with its date, or a spec section.</div>'+
    '<textarea id="evidence">'+esc(d.evidence||"")+'</textarea></div>'+
   /* Withdrawal is offered only where there is authored policy to remove, and never by blanking. */
   (S.canWithdraw(cap.id)
     ? '<div class="q"><h3>Withdraw authored policy</h3>'+
       '<div class="sug">This capability already carries authored policy. Removing it is a named act,'+
       ' separate from leaving a question undecided: clearing the fields above does NOT delete it.</div>'+
       (S.isWithdrawn(cap.id)
         ? '<div class="alert">Marked for withdrawal. Exporting and importing will remove the authored policy for this capability.</div>'
         : '<button id="withdraw">Withdraw this authored policy…</button>')
       +'</div>'
     : '')+
  '</div>';

  const readCoverage = () => {
    const sel = document.getElementById("cov").value;
    if (sel === "") return null;
    if (sel === "none"){
      const reason = document.getElementById("covReason");
      return { kind:"none", reason: reason ? reason.value.trim() : "" };
    }
    const candidate = cap.coverageCandidates[Number(sel)];
    const basis = { kind:"column", table:candidate.table, yearColumn:candidate.yearColumn };
    const just = document.getElementById("covJust");
    if (just && just.value.trim()) basis.justification = just.value.trim();
    return basis;
  };
  const save = () => {
    const kind = document.getElementById("avail").value;
    const cond = document.getElementById("cond").value.trim();
    const owner = document.getElementById("owner").value.trim();
    S.update(cap.id, {
      coverage: readCoverage(),
      availability: kind === "" ? null : kind === "always" ? {kind:"always"} : {kind:"conditional",condition:cond},
      receiptOwner: owner === "" ? null : owner,
      evidence: document.getElementById("evidence").value,
    });
    /* Drafts replace ONLY the prose rules; bound rules are never round-tripped through the textarea. */
    S.setIntegrityDrafts(cap.id, document.getElementById("integrity").value.split("\\n"));
    status();
  };
  for (const id of ["integrity","avail","cond","owner","evidence","covReason","covJust"]){
    const el = document.getElementById(id); if (el) el.addEventListener("input", save);
  }
  /* Coverage re-renders: which follow-up field is required depends on what was chosen. */
  document.getElementById("cov").addEventListener("change", (e) => {
    const sel = e.target.value;
    if (sel !== "" && sel !== "none"){
      const candidate = cap.coverageCandidates[Number(sel)];
      if (!candidate.yearBearing){
        const ok = confirm(candidate.table+"."+candidate.yearColumn+" does not look like a year column.\\n\\n"+
          "It can still be the coverage basis, but you will be asked to say why. Use it?");
        if (!ok){ render(); return; }
      }
    }
    save(); render();
  });
  const withdrawButton = document.getElementById("withdraw");
  if (withdrawButton) withdrawButton.addEventListener("click", () => {
    if (!confirm("Withdraw the authored policy for this capability?\\n\\n"+cap.id+
      "\\n\\nExporting and importing will REMOVE it from the policy file. This is not the same as"+
      " leaving a question undecided.")) return;
    S.withdraw(cap.id); status(); render();
  });
  document.getElementById("ownerPick").addEventListener("change", (e) => {
    if (e.target.value && e.target.value !== "__other") document.getElementById("owner").value = e.target.value;
    save();
  });
  status();
}

document.getElementById("filter").addEventListener("change", () => { index = 0; render(); });
document.getElementById("prev").addEventListener("click", () => { const l=visible(); index=(index-1+l.length)%l.length; render(); });
document.getElementById("next").addEventListener("click", () => { const l=visible(); index=(index+1)%l.length; render(); });
document.getElementById("nextUndecided").addEventListener("click", () => {
  const l = visible();
  for (let step=1; step<=l.length; step++){
    const probe=(index+step)%l.length;
    if (S.undecidedFields(S.decisions[l[probe].id]).length){ index=probe; render(); return; }
  }
  alert("No undecided capability in the current filter.");
});

/* Cluster application names EVERY affected capability, and what it costs them, before anything changes. */
document.getElementById("cluster").addEventListener("click", () => {
  const cap = visible()[index];
  const plan = S.clusterPlan(cap.id);
  document.getElementById("confirmIntro").textContent =
    plan.fields.length ? 'Copy '+plan.fields.join(", ")+' to '+plan.targets.length+' capability(ies) sharing '+plan.scope+
      '. Evidence on any capability that changes is REPLACED with this one\\u2019s, because evidence describes the values it was written for.'
                       : 'This capability has no decided field to copy.';
  document.getElementById("affected").innerHTML = plan.detail.map((entry) => {
    const notes = [];
    if (entry.overwrites.length) notes.push('would overwrite '+entry.overwrites.join(", "));
    if (entry.coverageDropped) notes.push('coverage not copied — that column pair is not one it reads');
    if (entry.evidenceReplaced) notes.push('evidence replaced');
    return '<li>'+esc(entry.id)+(notes.length?' <b style="color:#8a5a00">— '+esc(notes.join("; "))+'</b>':'')+'</li>';
  }).join('') || '<li>(none)</li>';
  document.getElementById("applyCluster").disabled = !plan.fields.length || !plan.targets.length;
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
      if (!confirm(result.reason)) { note.hidden = false; note.textContent = "Nothing was loaded; your unsaved changes are still here."; return; }
      result = S.loadSession(parsed, { discardUnsaved: true });
    }
    if (!result.ok){ note.hidden = false; note.textContent = result.reason; index = 0; status(); render(); return; }
    note.hidden = result.unknown.length === 0;
    if (result.unknown.length) note.textContent = "Loaded "+result.applied+" capability(ies). "+
      result.unknown.length+" id(s) in that file are not capabilities in this registry and were ignored.";
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
