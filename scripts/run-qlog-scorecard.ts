/**
 * The scorecard of every logged question (coordinator for Jeff, 2026-11-04): each label's expected outcome
 * (scripts/draft-qlog-labels.py) against what the engine does with the question, counted per source.
 *
 *   npx tsx scripts/run-qlog-scorecard.ts --labels <labels_local.json> --progress <outcomes.jsonl> [--root <canonical>]
 *     [--historical <crime index build>] [--python <python with duckdb>] [--limit N] [--report]
 *
 * --labels is the local label file (with the question text; outside the repo). Each label's engine outcome is appended
 * to --progress as it is made (outside the repo), so a stopped run resumes where it stopped. --report writes the counts
 * only to docs/reports/qlog-scorecard.md. Local only: reads the canonical build; never in CI.
 *
 * Buckets (one per label):
 *   correct         the outcome the label expects: a clarify about the part it names, a decline, or (for an answer) the
 *                   right source with values checked against independent values. Answers are not checked yet, so a
 *                   right-source answer is "unverified", never "correct".
 *   unverified      an answer from the right source whose values have no independent check yet; a route to the right
 *                   source that this engine does not run (SHR, Hate Crime).
 *   wrong answer    an answer where the label expects a clarify or a decline (a part assumed, or data that does not
 *                   exist), or an answer from the wrong source; or values that differ. The hard gate: 0.
 *   bad decline     a decline where the label expects an answer or a clarify.
 *   wrong clarify   a clarify where the label expects an answer or a decline, or one about another part.
 *   follow-up error any miss on a follow-up turn (its bucket, not the four above).
 *   error           the engine threw.
 * Excluded labels (not a question) are not scored. Every report says how many labels are drafts: a scorecard of draft
 * labels is a draft scorecard.
 */
import fs from "node:fs";
import path from "node:path";
import { shadowAnswer, shadowFollowUp, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { duckdbExecutor } from "../lib/nibrs-shadow/duckdb";
import { historicalBuildAt } from "../lib/nibrs-shadow/historical";
import { currentBuildAt } from "../lib/nibrs-shadow/current";
import { loadNibrsRelease } from "../lib/nibrs-shadow/release";

const arg = (name: string, dflt?: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const LABELS = arg("--labels")!, PROGRESS = arg("--progress")!;
if (!LABELS || !PROGRESS) throw new Error("--labels and --progress are required");
const root = arg("--root", "C:/Users/jeffm/nibrs-model/work/buildhost/test6-20261031/release/canonical")!;
const { released: _r, ...release } = loadNibrsRelease(arg("--release-file"), root);
// A query past the limit closes the executor for good (duckdb.ts); here a new one takes over, so one slow question
// is that question's error, never every later question's. The limit is shorter than the app's: a question this slow is
// an error on the scorecard either way.
const python = arg("--python", "C:/Users/jeffm/nibrs-model/.venv/Scripts/python.exe")!;
const LIMIT_MS = Number(arg("--timeout-ms", "120000"));
let exec = duckdbExecutor(python, { timeoutMs: LIMIT_MS });
const execute = (sql: string) => {
  try { return exec(sql); } catch (e) {
    if (/no answer within|process exited/.test(String(e))) exec = duckdbExecutor(python, { timeoutMs: LIMIT_MS });
    throw e;
  }
};
const crimeIndex = arg("--historical", "C:/Users/jeffm/crimeindex-build/crimeindex-20261101-ct")!;
const deps: ShadowDeps = {
  places: loadPlaceIndex(), release: { ...release, asOf: "2026-11-04" },
  target: { root, builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] },
  execute, historical: historicalBuildAt(crimeIndex), current: currentBuildAt(crimeIndex, execute),
} as ShadowDeps;

type Label = { id: string; tab: string; kind: "first" | "follow-up"; times: number; question: string; previous: string | null;
  expected: { outcome: "answer" | "clarify" | "decline" | "exclude"; source: string | null; about?: string; about_any?: string[]; source_any?: string[]; reason?: string };
  label: { status: string; rule: string; notes?: string } };
type Got = { kind: string; source: string | null; about?: string; reason?: string; ms: number };

/** What the engine did, in the label's terms. */
function got(o: { kind: string } & Record<string, unknown>, ms: number): Got {
  switch (o.kind) {
    case "answer": return { kind: "answer", source: "nibrs", ms };
    case "srs": case "historical": return { kind: "answer", source: "historical", ms };
    case "current": return { kind: "answer", source: "rtci", ms };
    case "route": return { kind: "route", source: String(o.source), ms };
    case "clarify": return { kind: "clarify", source: null, about: String(o.about ?? ""), ms };
    case "proposal": return { kind: "proposal", source: null, ms };
    case "decline": return { kind: "decline", source: null, reason: String(o.reason ?? ""), ms };
    default: return { kind: o.kind, source: null, ms };
  }
}

/** The part a clarify asks about, in the label's words. */
function aboutClass(s: string): string {
  const t = s.toLowerCase();
  if (/^which (?:place|places|period|year|years|crime|crimes)\b/.test(t)) return aboutClass(t.slice(6));
  if (/^which /.test(t)) return "which";
  if (/violent|property/.test(t)) return "violent, property or both";
  if (/place|where|location|agency|city|state/.test(t)) return "place";
  if (/period|year|when|month|time/.test(t)) return "period";
  if (/crime|offen[cs]e|measure/.test(t)) return "crime";
  return t;
}

type Bucket = "correct" | "unverified" | "wrong answer" | "bad decline" | "wrong clarify" | "follow-up error" | "error" | "excluded";
function bucket(l: Label, g: Got | null): Bucket {
  if (l.expected.outcome === "exclude") return "excluded";
  if (!g || g.kind === "error") return "error";
  const miss = (b: Bucket): Bucket => (l.kind === "follow-up" ? "follow-up error" : b);
  const e = l.expected;
  // A proposal ("Did you mean ...?") runs nothing: a clarify in effect.
  const kind = g.kind === "proposal" ? "clarify" : g.kind;
  if (e.outcome === "answer") {
    const okSource = (x: string | null) => x === e.source || (!!x && (e.source_any ?? []).includes(x));
    if (kind === "answer") return okSource(g.source) ? "unverified" : miss("wrong answer");
    if (kind === "route") return okSource(g.source) ? "unverified" : miss("bad decline");
    return miss(kind === "decline" ? "bad decline" : "wrong clarify");
  }
  if (e.outcome === "clarify") {
    if (kind === "clarify") {
      // Any missing part is a right one to ask about (D31 asks one at a time; the labels list them all).
      const wants = (e.about_any ?? [e.about ?? ""]).map((w) => (/^which /.test(w) ? "which" : aboutClass(w)));
      return wants.includes("the whole question") || wants.includes(aboutClass(g.about ?? "")) ? "correct" : miss("wrong clarify");
    }
    // Asking for the whole question again is what a decline of the words does ("try asking another way").
    if (kind === "decline" && (e.about === "the whole question") && g.reason === "reader") return "correct";
    return kind === "route" ? "unverified" : miss(kind === "answer" ? "wrong answer" : "bad decline");
  }
  // A decline: any plain decline or route away is a decline; its reason is not checked yet.
  if (kind === "decline" || kind === "route") return "correct";
  return miss(kind === "answer" ? "wrong answer" : "wrong clarify");
}

const labels = (JSON.parse(fs.readFileSync(LABELS, "utf8")) as Label[]);
const done = new Map<string, Got | null>();
if (fs.existsSync(PROGRESS)) for (const line of fs.readFileSync(PROGRESS, "utf8").split("\n")) if (line.trim()) { const r = JSON.parse(line); done.set(r.id, r.got); }
const limit = Number(arg("--limit", "0")) || Infinity;
let ran = 0;
for (const l of labels) {
  if (ran >= limit) break;
  if (done.has(l.id) || l.expected.outcome === "exclude") continue;
  const t = Date.now();
  let g: Got | null;
  try {
    const o = l.kind === "follow-up" && l.previous ? shadowFollowUp(l.previous, l.question, deps) : shadowAnswer(l.question, deps);
    g = got(o as unknown as { kind: string } & Record<string, unknown>, Date.now() - t);
  } catch (e) {
    g = { kind: "error", source: null, reason: String(e).slice(0, 120), ms: Date.now() - t };
  }
  fs.appendFileSync(PROGRESS, JSON.stringify({ id: l.id, got: g }) + "\n");
  done.set(l.id, g);
  if (++ran % 100 === 0) console.log(`${ran} run (${done.size} of ${labels.length} labels done)`);
}

// ------------------------------------------------------------------------------------------------- counts
const BUCKETS: Bucket[] = ["correct", "unverified", "wrong answer", "bad decline", "wrong clarify", "follow-up error", "error"];
const TABS = ["historical", "current", "nibrs", "shr", "hate_crime"];
const NAME: Record<string, string> = { historical: "Historical", current: "Current Trends", nibrs: "NIBRS", shr: "Homicide Reports", hate_crime: "Hate Crime" };
const scored = labels.filter((l) => l.expected.outcome !== "exclude" && done.has(l.id));
// A disputed label waits on Jeff: set aside in its own column, never in a bucket or the gate.
const per = (tab: string) => {
  const disputed = scored.filter((l) => l.tab === tab && l.label.status === "disputed").length;
  const ls = scored.filter((l) => l.tab === tab && l.label.status !== "disputed");
  const c = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
  for (const l of ls) { const b = bucket(l, done.get(l.id) ?? null); if (b !== "excluded") c[b]++; }
  const drafts = ls.filter((l) => l.label.status === "draft").length;
  const reviewed = ls.filter((l) => l.label.status === "reviewed").length;
  return { n: ls.length, c, drafts, reviewed, disputed, notRun: labels.filter((l) => l.tab === tab && l.expected.outcome !== "exclude" && !done.has(l.id)).length };
};
const rows = TABS.map((t) => ({ t, ...per(t) }));
const all = rows.reduce((a, r) => { a.n += r.n; a.drafts += r.drafts; a.reviewed += r.reviewed; a.disputed += r.disputed; a.notRun += r.notRun; for (const b of BUCKETS) a.c[b] += r.c[b]; return a; },
  { n: 0, drafts: 0, reviewed: 0, disputed: 0, notRun: 0, c: Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number> });
const table = [
  `| Source | Labels scored | ${BUCKETS.map((b) => b[0].toUpperCase() + b.slice(1)).join(" | ")} | Reviewed labels | Draft labels | Disputed (not scored) | Not run yet |`,
  `|---|---|${BUCKETS.map(() => "---").join("|")}|---|---|---|---|`,
  ...rows.map((r) => `| ${NAME[r.t]} | ${r.n} | ${BUCKETS.map((b) => r.c[b]).join(" | ")} | ${r.reviewed} | ${r.drafts} | ${r.disputed} | ${r.notRun} |`),
  `| **All** | **${all.n}** | ${BUCKETS.map((b) => `**${all.c[b]}**`).join(" | ")} | **${all.reviewed}** | **${all.drafts}** | **${all.disputed}** | **${all.notRun}** |`,
].join("\n");
console.log(table);
const gate = all.c["wrong answer"] === 0 ? "met" : `NOT met: ${all.c["wrong answer"]} wrong answers`;
console.log(`hard gate (wrong answers = 0): ${gate}`);

// Per rule, for triage (local): each rule's buckets.
const byRule = new Map<string, Record<string, number>>();
for (const l of scored) { const b = bucket(l, done.get(l.id) ?? null); const r = byRule.get(l.label.rule) ?? {}; r[b] = (r[b] ?? 0) + 1; byRule.set(l.label.rule, r); }
for (const [r, c] of [...byRule].sort()) console.log(r, JSON.stringify(c));

const disputedGroups = new Map<string, number>();
for (const l of labels) if (l.label.status === "disputed") { const k = (l.label as { notes?: string }).notes?.split(":")[0] ?? "?"; disputedGroups.set(k, (disputedGroups.get(k) ?? 0) + 1); }
if (process.argv.includes("--report")) {
  const draftAll = all.n - all.drafts - all.reviewed === 0;
  const out = [
    `# Query-log scorecard${draftAll ? " (DRAFT: no label is confirmed yet)" : ""}`, "",
    "Every logged question gets one expected outcome: answer (with its source), clarify (with what is asked) or decline (with the plain reason). Labels come from written rules (scripts/draft-qlog-labels.py), never from the engine's output; this run compares the engine with them (scripts/run-qlog-scorecard.ts). The labels, with each question as written (Jeff 2026-11-04), are scripts/fixtures/answer-eval/qlog-labels.json, keyed by a hash of the normalized question; the rules are docs/reports/qlog-label-rules.md. The log copy itself stays outside the repo.", "",
    `Release ${deps.release.id}; run ${new Date().toISOString().slice(0, 10)}. A first question is the first row of each session in each tab; a follow-up is any later row, labeled with the row before it. Distinct questions per tab (the same words counted once; "times" in the label file says how often each was asked).`, "",
    `**Label status: ${all.n - all.drafts - all.reviewed} confirmed, ${all.reviewed} reviewed (two labelers agree: the rules and an independent second labeler), ${all.drafts} draft (a second-labeler correction, or a rule label not yet reviewed).** No label is confirmed, so this is still a draft scorecard: a miss here is a candidate, not a finding.`, "",
    "**Unverified is not correct.** An answer from the right source counts as correct only once its numbers match independent values (nibrs-model's files, or SQL against the source build); until then it is unverified.", "",
    table, "",
    `Hard gate, wrong answers = 0 (undisputed labels): **${gate}**.`, "",
    `**Disputed: ${all.disputed} labels wait on Jeff and are set aside** (not in any bucket or the gate): ${[...disputedGroups].map(([k, n]) => `${k} ${n}`).join(", ")}. The questions are in docs/reports/qlog-label-rules.md.`, "",
    "Buckets: *correct* the outcome the label expects; *unverified* the right source, numbers not yet checked (or routed to a source this engine does not run yet); *wrong answer* an answer where a clarify or decline is expected, an answer from the wrong source, or numbers that differ; *bad decline* a decline where an answer or a clarify is expected; *wrong clarify* a clarify where an answer or decline is expected, or about another part; *follow-up error* any miss on a follow-up turn; *error* the engine failed.", "",
  ].join("\n");
  fs.writeFileSync(path.join(__dirname, "..", "docs", "reports", "qlog-scorecard.md"), out);
}
process.exit(0);
