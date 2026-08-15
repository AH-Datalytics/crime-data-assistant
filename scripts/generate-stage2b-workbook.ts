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
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const REGISTRY_FILE = path.join(DATA_DIR, "capability-registry.json");
const POLICY_FILE = path.join(DATA_DIR, "capability-policy.json");
export const WORKBOOK_FILE = path.join(process.cwd(), "docs", "superpowers", "stage2b-policy-workbook.html");
export const DECISIONS_VERSION = 1;

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
 * Identifies the STRUCTURE the decisions were made against.
 *
 * Only the structural fields, deliberately: authoring policy changes `policy` and
 * `authorizationEligible` in the registry, and if those fed the fingerprint then importing a
 * session's own decisions would invalidate the file that produced them. A change to tables, columns
 * or artifacts is what makes an export stale, because the questions themselves would have changed.
 */
export function registryFingerprint(registry: Record<string, RegistryEntry>): string {
  const structural = Object.keys(registry).sort().map((id) => ({
    id,
    artifact: registry[id].artifact,
    emittedDependencies: [...registry[id].emittedDependencies].sort(),
    prepDependencies: [...registry[id].prepDependencies].sort(),
    requiredColumns: Object.fromEntries(
      Object.keys(registry[id].requiredColumns).sort().map((t) => [t, [...registry[id].requiredColumns[t]].sort()]),
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

const YEARISH = /(^|_)(year|yr)($|_)/i;

/** Scripts that mention every one of these tables -- a place to look, not an owner. */
function ownerCandidates(tables: string[], scriptIndex: { file: string; text: string }[]): string[] {
  if (tables.length === 0) return [];
  return scriptIndex
    .filter((entry) => tables.every((table) => entry.text.includes(table.replace(/^rollup\./, ""))))
    .map((entry) => entry.file)
    .sort()
    .slice(0, 6);
}

function readScriptIndex(): { file: string; text: string }[] {
  const dir = path.join(process.cwd(), "scripts");
  return fs.readdirSync(dir)
    .filter((file) => /\.(ts|js|py|sql)$/.test(file) && !file.startsWith("test-"))
    .sort()
    .map((file) => {
      try { return { file, text: fs.readFileSync(path.join(dir, file), "utf8") }; }
      catch { return { file, text: "" }; }
    });
}

export function buildWorkbookModel(registry: Record<string, RegistryEntry>): WorkbookCapability[] {
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
        coverageCandidates.push({ table, yearColumn: column, yearBearing: YEARISH.test(column) });
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

export function renderWorkbook(registryOverride?: Record<string, RegistryEntry>): string {
  const registry = registryOverride
    ?? (JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<string, RegistryEntry>);
  const model = buildWorkbookModel(registry).map((c) => ({ ...c, description: describe(c) }));
  const fingerprint = registryFingerprint(registry);
  const existing = fs.existsSync(POLICY_FILE)
    ? JSON.parse(fs.readFileSync(POLICY_FILE, "utf8")) as Record<string, unknown>
    : {};
  const authored = Object.fromEntries(
    Object.entries(existing).filter(([id]) => !id.startsWith("_")),
  );

  const payload = JSON.stringify({ v: DECISIONS_VERSION, fingerprint, capabilities: model, authored }, null, 1);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>Stage 2B policy workbook</title>
<style>
:root{--ink:#16181d;--dim:#5b6172;--line:#d8dbe3;--bg:#fbfbfd;--card:#fff;--warn:#8a5a00;--warnbg:#fff6e5;--ok:#1c6b4a;--sug:#4a5878;--sugbg:#eef1f7}
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
button{font:inherit;padding:8px 14px;border:1px solid var(--line);background:#fff;border-radius:6px;cursor:pointer}
button.primary{background:var(--ink);color:#fff;border-color:var(--ink)}
button:disabled{opacity:.45;cursor:not-allowed}
.nav{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
.undecided{color:var(--warn);font-weight:600}
.decided{color:var(--ok);font-weight:600}
ul.affected{margin:8px 0 0;padding-left:20px;font:12px ui-monospace,Menlo,monospace;max-height:190px;overflow:auto}
dialog{border:1px solid var(--line);border-radius:9px;padding:20px;max-width:640px}
dialog h3{margin-top:0}
.pill{display:inline-block;font-size:11.5px;background:#eef0f5;color:var(--dim);border-radius:999px;padding:2px 9px;margin-right:6px}
code{font:12px ui-monospace,Menlo,monospace;background:#f2f3f7;padding:1px 4px;border-radius:3px}
</style></head><body>
<header>
 <b>Stage 2B policy workbook</b>
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
 <div class="warn" id="staleness" hidden></div>
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
const decisions = {};
for (const cap of DATA.capabilities) {
  const prior = DATA.authored[cap.id];
  decisions[cap.id] = prior ? JSON.parse(JSON.stringify(prior)) : blank();
}
function blank(){ return { coverage:null, integrity:null, availability:null, receiptOwner:null, evidence:"" }; }
let index = 0;

const FIELDS = ["coverage","integrity","availability","receiptOwner"];
const undecidedFields = (d) => FIELDS.filter((f) => d[f] === null || d[f] === undefined);
const isUnique = (c) => c.tableCluster.length === 0;

function matches(cap){
  const d = decisions[cap.id], f = document.getElementById("filter").value;
  if (f === "all") return true;
  if (f === "undecided") return undecidedFields(d).length > 0;
  if (f === "conditional") return !!cap.conditionalHint;
  if (f === "unique") return isUnique(cap);
  return d[f === "owner" ? "receiptOwner" : f] === null;
}
function visible(){ const v = DATA.capabilities.filter(matches); return v.length ? v : DATA.capabilities; }

function counts(){
  const c = { coverage:0, integrity:0, availability:0, receiptOwner:0, complete:0 };
  for (const cap of DATA.capabilities){
    const d = decisions[cap.id];
    for (const f of FIELDS) if (d[f] === null) c[f]++;
    if (undecidedFields(d).length === 0 && (d.evidence||"").trim().length > 20) c.complete++;
  }
  document.getElementById("counts").innerHTML =
    '<span>Complete: <b class="decided">'+c.complete+'</b>/'+DATA.capabilities.length+'</span>'+
    '<span>Coverage undecided: <b class="undecided">'+c.coverage+'</b></span>'+
    '<span>Integrity undecided: <b class="undecided">'+c.integrity+'</b></span>'+
    '<span>Availability undecided: <b class="undecided">'+c.availability+'</b></span>'+
    '<span>Owner undecided: <b class="undecided">'+c.receiptOwner+'</b></span>';
}

function esc(s){ return String(s).replace(/[&<>"]/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }

function render(){
  const list = visible();
  if (index >= list.length) index = 0;
  const cap = list[index], d = decisions[cap.id];
  const covOpts = cap.coverageCandidates.map((o,i) =>
    '<option value="'+i+'"'+(d.coverage && d.coverage.table===o.table && d.coverage.yearColumn===o.yearColumn ? ' selected':'')+'>'+
      esc(o.table+'.'+o.yearColumn)+(o.yearBearing?' — suggested (year-bearing)':'')+'</option>').join('');
  const ownerOpts = cap.ownerCandidates.map((o) =>
    '<option value="'+esc(o)+'"'+(d.receiptOwner===o?' selected':'')+'>'+esc(o)+'</option>').join('');
  const avail = d.availability ? d.availability.kind : "";
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
    '<div class="sug"><b>Candidates</b> (year-bearing columns this capability actually reads)'+
      (cap.coverageCandidates.some((o)=>o.yearBearing)?'':' — none of this capability's columns look year-bearing, so "No year dimension" may be the honest answer')+
      '. Every column this capability reads is listed; the mark is a hint, not a filter.</div>'+
    '<div class="row"><div><label>Basis</label><select id="cov">'+
      '<option value="">— Undecided —</option>'+covOpts+
      '<option value="none"'+(d.coverage==="none"?' selected':'')+'>No year dimension (state the reason below)</option>'+
    '</select></div></div></div>'+

   '<div class="q"><h3>2. Integrity — what would tell us this data is broken?</h3>'+
    '<div class="sug">Free text, one rule per line. Leave empty for undecided. An empty list is not a rule.</div>'+
    '<textarea id="integrity" placeholder="e.g. national_monthly and agency_monthly must share a MAX(year*100+month)">'+
      esc(d.integrity ? d.integrity.join("\\n") : "")+'</textarea></div>'+

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
  '</div>';

  const save = () => {
    const covSel = document.getElementById("cov").value;
    d.coverage = covSel === "" ? null : covSel === "none" ? "none" : cap.coverageCandidates[Number(covSel)];
    const lines = document.getElementById("integrity").value.split("\\n").map((s)=>s.trim()).filter(Boolean);
    d.integrity = lines.length ? lines : null;
    const kind = document.getElementById("avail").value;
    const cond = document.getElementById("cond").value.trim();
    d.availability = kind === "" ? null : kind === "always" ? {kind:"always"} : {kind:"conditional",condition:cond};
    const owner = document.getElementById("owner").value.trim();
    d.receiptOwner = owner === "" ? null : owner;
    d.evidence = document.getElementById("evidence").value;
    counts();
  };
  for (const id of ["cov","integrity","avail","cond","owner","evidence"]) document.getElementById(id).addEventListener("input", save);
  document.getElementById("ownerPick").addEventListener("change", (e) => {
    if (e.target.value && e.target.value !== "__other") document.getElementById("owner").value = e.target.value;
    save();
  });
  counts();
}

document.getElementById("filter").addEventListener("change", () => { index = 0; render(); });
document.getElementById("prev").addEventListener("click", () => { const l=visible(); index=(index-1+l.length)%l.length; render(); });
document.getElementById("next").addEventListener("click", () => { const l=visible(); index=(index+1)%l.length; render(); });
document.getElementById("nextUndecided").addEventListener("click", () => {
  const l = visible();
  for (let step=1; step<=l.length; step++){
    const probe=(index+step)%l.length;
    if (undecidedFields(decisions[l[probe].id]).length){ index=probe; render(); return; }
  }
  alert("No undecided capability in the current filter.");
});

/* Cluster application names EVERY affected capability before anything changes. */
document.getElementById("cluster").addEventListener("click", () => {
  const cap = visible()[index], d = decisions[cap.id];
  const targets = cap.tableCluster.length ? cap.tableCluster : cap.artifactCluster;
  const scope = cap.tableCluster.length ? "the same table set" : "the same artifact";
  const fields = FIELDS.filter((f) => d[f] !== null);
  document.getElementById("confirmIntro").textContent =
    fields.length ? 'Copy '+fields.join(", ")+' to '+targets.length+' capability(ies) sharing '+scope+'.'
                  : 'This capability has no decided field to copy.';
  document.getElementById("affected").innerHTML = targets.map((t) => {
    const overwrite = FIELDS.some((f) => fields.includes(f) && decisions[t][f] !== null);
    return '<li>'+esc(t)+(overwrite?' <b style="color:#8a5a00">— would overwrite an existing answer</b>':'')+'</li>';
  }).join('') || '<li>(none)</li>';
  document.getElementById("applyCluster").disabled = !fields.length || !targets.length;
  document.getElementById("confirm").showModal();
});
document.getElementById("cancelCluster").addEventListener("click", () => document.getElementById("confirm").close());
document.getElementById("applyCluster").addEventListener("click", () => {
  const cap = visible()[index], d = decisions[cap.id];
  const targets = cap.tableCluster.length ? cap.tableCluster : cap.artifactCluster;
  for (const t of targets){
    for (const f of FIELDS) if (d[f] !== null) decisions[t][f] = JSON.parse(JSON.stringify(d[f]));
    /* Coverage is a table/column pair: only copy it where that pair is one the TARGET reads. */
    const target = DATA.capabilities.find((c) => c.id === t);
    if (d.coverage && d.coverage !== "none" &&
        !target.coverageCandidates.some((o) => o.table===d.coverage.table && o.yearColumn===d.coverage.yearColumn)) {
      decisions[t].coverage = null;
    }
    if (!decisions[t].evidence) decisions[t].evidence = d.evidence;
  }
  document.getElementById("confirm").close();
  counts(); render();
});

/* Deterministic export: sorted ids, fixed field order, so re-exporting an unchanged session is
   byte-identical and a diff shows only what you actually changed. */
function serialize(){
  const out = {};
  for (const id of Object.keys(decisions).sort()){
    const d = decisions[id];
    out[id] = { coverage:d.coverage??null, integrity:d.integrity??null, availability:d.availability??null,
                receiptOwner:d.receiptOwner??null, evidence:d.evidence||"" };
  }
  return JSON.stringify({ v: DATA.v, fingerprint: DATA.fingerprint, decisions: out }, null, 2) + "\\n";
}
document.getElementById("export").addEventListener("click", () => {
  const blob = new Blob([serialize()], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "stage2b-policy-decisions.json"; a.click();
  URL.revokeObjectURL(a.href);
});
document.getElementById("import").addEventListener("click", () => document.getElementById("file").click());
document.getElementById("file").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    let parsed; try { parsed = JSON.parse(reader.result); } catch { alert("That file is not JSON."); return; }
    if (parsed.fingerprint !== DATA.fingerprint){
      document.getElementById("staleness").hidden = false;
      document.getElementById("staleness").textContent =
        "This session was authored against a different registry structure ("+parsed.fingerprint+" vs "+DATA.fingerprint+
        "). The questions may have changed. Regenerate the workbook and re-check every answer; the importer will refuse this file.";
    }
    for (const id of Object.keys(parsed.decisions||{})){
      if (decisions[id]) decisions[id] = Object.assign(blank(), parsed.decisions[id]);
    }
    index = 0; counts(); render();
  };
  reader.readAsText(f);
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
