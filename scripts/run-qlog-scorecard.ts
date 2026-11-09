/**
 * The scorecard of every logged question (coordinator for Jeff, 2026-11-04): each label's expected outcome
 * (scripts/draft-qlog-labels.py) against what the engine does with the question, counted per source.
 *
 *   npx tsx scripts/run-qlog-scorecard.ts --labels <labels_local.json> --progress <outcomes.jsonl> [--root <canonical>]
 *     [--historical <crime index build>] [--python <python with duckdb>] [--limit N] [--report]
 *     [--workers N] [--sql-cache <dir>] [--spot] [--compare <outcomes.jsonl>]
 *
 * --labels: the labels with each question's text, either the repo's scripts/fixtures/answer-eval/qlog-labels.json
 * ({about, labels: [...]}) or a local array of the same labels (labels_local_v17.json: the same 4,379). The file's
 * hash is part of a progress file's identity, so a run resumes only with the same file. Each label's engine outcome is appended
 * to --progress as it is made (outside the repo), so a stopped run resumes where it stopped. --report writes the counts
 * only to docs/reports/qlog-scorecard.md. Local only: reads the canonical build; never in CI.
 *
 * Process (coordinator for Jeff, 2026-11-06):
 *   - docs/reports/qlog-scorecard.md is not committed in PRs; it is regenerated on dev after each merge (--report).
 *   - After each merge to dev: the full run, with --sql-cache, so the cache holds every query dev's answers make.
 *   - A PR: every question again, with the same --sql-cache. A query the build answered before is read from the cache
 *     (the build is pinned and read-only, so the rows are the same); only a question whose SQL changed goes to DuckDB.
 *     No question is left out, so no selection can miss one. Plus --spot without the cache: a fixed 200 questions,
 *     stratified by source, run against DuckDB itself, which must match the cached run (a check on the cache).
 *   - Runs are one process at a time. The full run is on dev after merges, overnight or when the laptop is idle, never
 *     while another build is running (Jeff, 2026-11-07). A query past the time limit is retried once on a fresh process
 *     with three times the limit, so load alone doesn't make an error.
 *   - --workers N (off, unused): N shards at once. It was 23 min vs 60 for the full run, but one shard hung (2026-11-07)
 *     and the cause wasn't found; a per-shard watchdog is where to start if it comes back.
 *   - --compare <outcomes.jsonl> lists every question whose outcome differs from that run's (dev's), for the PR.
 *
 * Buckets (one per label):
 *   correct         the outcome the label expects: a clarify about the part it names, a decline, or (for an answer) the
 *                   right source with every shown number matched against independent values
 *                   (scripts/fixtures/answer-eval/qlog-verified.json, at the same table digest).
 *   unverified      an answer from the right source whose values have no independent check yet; a route to the right
 *                   source that this engine does not run (SHR, Hate Crime).
 *   wrong answer    an answer where the label expects a clarify or a decline (a part assumed, or data that does not
 *                   exist), or an answer from the wrong source. The hard gate: 0. Numbers that differ from
 *                   independent values are reported as each verification batch finds them; an answer whose numbers
 *                   change after verification goes back to unverified (its digest no longer matches). A follow-up
 *                   turn's wrong answer is a wrong answer too, verified by digest the same way.
 *   bad decline     a decline where the label expects an answer or a clarify.
 *   wrong clarify   a clarify where the label expects an answer or a decline, or one about another part.
 *   follow-up error a follow-up turn's bad decline or wrong clarify (its bucket, not those two).
 *   error           the engine threw.
 * Excluded labels (not a question) are not scored. Every report says how many labels are drafts: a scorecard of draft
 * labels is a draft scorecard.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { shadowAnswer, shadowFollowUp, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { duckdbExecutor, SERVER as DUCKDB_SERVER } from "../lib/nibrs-shadow/duckdb";
import { historicalBuildAt } from "../lib/nibrs-shadow/historical";
import { currentBuildAt } from "../lib/nibrs-shadow/current";
import { loadNibrsRelease } from "../lib/nibrs-shadow/release";
import { tableDigest } from "../lib/answer-eval/table-digest";
import { bucket, type Bucket, type Got, type Label } from "./qlog-bucket";
import { qualifies, readerBinding, readerKey, looksPersonal, validateProposal, type Proposal } from "../lib/nibrs-shadow/gemini-reader";

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
// DuckDB's memory and threads (the runner laptop, 16 GB, was killed twice for low memory on uncached spot runs under
// DuckDB's default, 80% of RAM): 4GB and 4 threads unless a flag or SCORECARD_DUCKDB_MEMORY / SCORECARD_DUCKDB_THREADS
// says otherwise. They never change a query's rows, so the cache and run identities don't include them.
const DUCKDB_LIMITS = { memoryLimit: arg("--duckdb-memory", process.env.SCORECARD_DUCKDB_MEMORY ?? "4GB")!, threads: Number(arg("--duckdb-threads", process.env.SCORECARD_DUCKDB_THREADS ?? "4")) };
const crimeIndex = arg("--historical", "C:/Users/jeffm/crimeindex-build/crimeindex-20261101-ct")!;
// Off by default and not used (see the header): one process at a time.
const WORKERS = Math.max(1, Number(arg("--workers", "1")));
const SHARD = arg("--shard") ? arg("--shard")!.split("/").map(Number) as [number, number] : null;
const SPOT = process.argv.includes("--spot");
/**
 * --gemini-readings <cache> (plan 3 step 1, the Gemini reader's shadow run): readings fetched by
 * scripts/fetch-gemini-readings.ts, read offline. A question that qualifies (the engine doesn't answer, the decline is
 * the reader's own, and the reader left words unread) takes Gemini's replacements for its unread words when they
 * validate, and the engine answers the rewritten question by its normal path (a follow-up by the follow-up path);
 * otherwise today's outcome stands. Each such question's outcome says which ("via"), and the rewritten question ("read").
 * --gemini-review <file> (outside the repo) lists every question Gemini's reading answered, for review before the gate is
 * judged: such an answer is unverified, so the scorecard alone can't show it is the question asked (Codex review 01.8).
 */
const READINGS_FILE = arg("--gemini-readings");
const READINGS = READINGS_FILE ? JSON.parse(fs.readFileSync(READINGS_FILE, "utf8")) as { binding: string; entries: Record<string, { proposal: Proposal | null; done: boolean }> } : null;
if (READINGS && READINGS.binding !== readerBinding()) throw new Error(`${READINGS_FILE} was made with another prompt, model or settings`);
// The spot set checks the cache against DuckDB itself, so it never reads or writes the cache.
const CACHE_DIR = SPOT ? undefined : arg("--sql-cache");
// The DuckDB and Python versions (for the cache's fingerprint), read before any executor starts: on Windows a process
// started on another thread at the same moment can inherit this one's output pipe and keep spawnSync waiting for good
// (the hang of 2026-11-07, a run idle before its first question).
const versions = (() => {
  const v = spawnSync(python, ["-I", "-c", "import duckdb, sys; print(duckdb.__version__, sys.version)"], { encoding: "utf8", timeout: 60_000 });
  if (v.status !== 0) throw new Error(`the DuckDB version could not be read: ${v.error ?? v.stderr}`);
  return v.stdout;
})();
let exec = duckdbExecutor(python, { timeoutMs: LIMIT_MS, ...DUCKDB_LIMITS });
/** A new executor in place of the current one, whose process is closed (Codex PR-mode review 01.5: none left idle). */
const replace = (ms: number) => { exec.close(); exec = duckdbExecutor(python, { timeoutMs: ms, ...DUCKDB_LIMITS }); };
// An executor that timed out or whose process exited is replaced when the next query needs one, never sooner: one new
// process per failure, started only after the old one has ended (Codex PR-mode review 03).
let nextMs: number | null = null;
// Only a query past the time limit is tried again; a process that crashed is replaced, and the question is an error.
const TIMEOUT = /no answer within/;
const live = (sql: string) => {
  if (nextMs !== null) { replace(nextMs); nextMs = null; }
  try { return exec(sql); } catch (e) {
    if (/no answer within|process exited/.test(String(e))) nextMs = LIMIT_MS;
    throw e;
  }
};

/**
 * What the cache's rows depend on: both data roots (every file's path from its root, size and time), the release, and
 * how SQL is run (the executor's code, the Python and its DuckDB version). A cache made under any other is refused,
 * never read: its rows could differ (Codex PR-mode review 01.1, 01.4).
 */
function buildFingerprint(): string {
  const h = createHash("sha256").update(JSON.stringify([root, crimeIndex, release.id, python]));
  const walk = (tag: string, base: string, dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(tag, base, p);
      else { const st = fs.statSync(p); h.update(`${tag}:${path.relative(base, p).replace(/\\/g, "/")}|${st.size}|${st.mtimeMs}\n`); }
    }
  };
  walk("canonical", root, root); walk("crimeindex", crimeIndex, crimeIndex);
  // The Python each query runs in (the rows depend on it; not the Node side that carries them).
  h.update(DUCKDB_SERVER);
  h.update(versions);
  return h.digest("hex");
}
/**
 * What a run's outcomes depend on besides the data: the engine's code and fixtures, this runner, the labels, and the
 * mode (cached or spot). A progress file or shard from another is refused, never resumed (Codex PR-mode review 01.3).
 */
function runFingerprint(): string {
  const labelsHash = createHash("sha256").update(fs.readFileSync(LABELS)).digest("hex");
  const h = createHash("sha256").update(JSON.stringify({ spot: SPOT, labels: labelsHash, root, crimeIndex, release: release.id, limitMs: LIMIT_MS }));
  const repo = path.join(__dirname, "..");
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(`${path.relative(repo, p).replace(/\\/g, "/")}\n`).update(fs.readFileSync(p));
    }
  };
  walk(path.join(repo, "lib")); walk(path.join(repo, "scripts", "fixtures"));
  h.update(fs.readFileSync(__filename));
  if (READINGS_FILE) h.update(fs.readFileSync(READINGS_FILE));
  return h.digest("hex");
}
// Rows in the cache are frozen, and every question gets its own copy: the engine sees rows exactly as DuckDB's (it may
// sort or change them in place), and no question can change what a later one reads (Codex PR-mode review 02.1).
const frozen = (rows: unknown[][]): unknown[][] => { for (const r of rows) Object.freeze(r); return Object.freeze(rows) as unknown[][]; };
const sqlKey = (sql: string) => createHash("sha256").update(sql).digest("hex");
const cache = new Map<string, unknown[][]>();
let cacheOut: string | null = null;
if (CACHE_DIR) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const fp = buildFingerprint(), mf = path.join(CACHE_DIR, "build.json");
  if (fs.existsSync(mf) && JSON.parse(fs.readFileSync(mf, "utf8")).fingerprint !== fp)
    throw new Error(`--sql-cache ${CACHE_DIR} was made on another build; use a new directory`);
  if (!SHARD) fs.writeFileSync(mf, JSON.stringify({ fingerprint: fp, root, crimeIndex, release: release.id }));
  for (const f of fs.readdirSync(CACHE_DIR).filter((f) => /^sql\..*\.jsonl$/.test(f)))
    for (const line of fs.readFileSync(path.join(CACHE_DIR, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); cache.set(r.k, frozen(r.rows)); } catch { /* a line cut short by a stopped run */ }
    }
  cacheOut = path.join(CACHE_DIR, `sql.${SHARD ? `w${SHARD[0]}` : "main"}.jsonl`);
}
let hits = 0, misses = 0;
const execute = (sql: string): unknown[][] => {
  if (!cacheOut) return live(sql);
  const k = sqlKey(sql), hit = cache.get(k);
  if (hit) { hits++; return structuredClone(hit) as unknown[][]; }
  misses++;
  const rows = live(sql);
  cache.set(k, frozen(structuredClone(rows) as unknown[][]));
  fs.appendFileSync(cacheOut, JSON.stringify({ k, rows }) + "\n");
  return rows;
};
const deps: ShadowDeps = {
  places: loadPlaceIndex(), release: { ...release, asOf: "2026-11-04" },
  target: { root, builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] },
  execute, historical: historicalBuildAt(crimeIndex), current: currentBuildAt(crimeIndex, execute),
} as ShadowDeps;


// The table digest is shared with the verification tools (lib/answer-eval/table-digest.ts).
export { tableDigest };

/** What the engine did, in the label's terms. */
function got(o: { kind: string } & Record<string, unknown>, ms: number): Got {
  switch (o.kind) {
    case "answer": return { kind: "answer", source: "nibrs", ms, digest: tableDigest((o.delivered as { table?: { rows: unknown } })?.table?.rows) };
    case "srs": case "historical": return { kind: "answer", source: "historical", ms, digest: tableDigest((o.delivered as { table?: { rows: unknown } })?.table?.rows) };
    case "current": return { kind: "answer", source: "rtci", ms, digest: tableDigest((o.delivered as { table?: { rows: unknown } })?.table?.rows) };
    case "route": return { kind: "route", source: String(o.source), ms };
    case "clarify": return { kind: "clarify", source: null, about: String(o.about ?? ""), ms };
    case "proposal": return { kind: "proposal", source: null, ms };
    case "decline": return { kind: "decline", source: null, reason: String(o.reason ?? ""), ms };
    default: return { kind: o.kind, source: null, ms };
  }
}


// The repo fixture wraps the labels in an object; a local file is the array itself (the runner laptop, 2026-11-07:
// "labels.forEach is not a function" when the fixture was passed).
const labelFile = JSON.parse(fs.readFileSync(LABELS, "utf8")) as Label[] | { labels: Label[] };
const allLabels = Array.isArray(labelFile) ? labelFile : labelFile.labels;
if (!Array.isArray(allLabels)) throw new Error(`--labels ${LABELS}: no labels array (expected an array, or an object with "labels")`);
/**
 * The spot set: a fixed 200 questions, 40 from each source's tab, the first by a hash of the label id (so the same 200
 * every run, whatever the order of the file), first questions and follow-ups alike.
 */
function spotSet(ls: Label[]): Label[] {
  const h = (id: string) => createHash("sha256").update(id).digest("hex");
  const tabs = [...new Set(ls.map((l) => l.tab))].sort();
  return tabs.flatMap((t) => ls.filter((l) => l.tab === t && l.expected.outcome !== "exclude").sort((a, b) => h(a.id).localeCompare(h(b.id))).slice(0, 40));
}
const labels = SPOT ? spotSet(allLabels) : allLabels;
const readProgress = (file: string, into: Map<string, Got | null>) => {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); into.set(r.id, r.got); } catch { /* a line cut short by a stopped run */ }
  }
};
const shardFile = (i: number) => `${PROGRESS}.w${i}`;
if (!SHARD) {
  const meta = `${PROGRESS}.meta.json`, fp = runFingerprint();
  const leftover = fs.existsSync(PROGRESS) || Array.from({ length: 64 }, (_, i) => shardFile(i)).some((f) => fs.existsSync(f));
  if (leftover && (!fs.existsSync(meta) || JSON.parse(fs.readFileSync(meta, "utf8")).fingerprint !== fp))
    throw new Error(`${PROGRESS} (or its shards) came from other code, labels or mode; use a new --progress`);
  fs.writeFileSync(meta, JSON.stringify({ fingerprint: fp, spot: SPOT, labels: LABELS, cache: CACHE_DIR ?? null }));
}
const done = new Map<string, Got | null>();
readProgress(PROGRESS, done);
// A stopped parallel run's shards count as done; they are folded into --progress below.
if (!SHARD) for (let i = 0; i < 64; i++) readProgress(shardFile(i), done);
// A shard skips what the whole run has done already.
if (SHARD && arg("--done-from")) readProgress(arg("--done-from")!, done);
const limit = Number(arg("--limit", "0")) || Infinity;

let shardFailed = false;
if (WORKERS > 1 && !SHARD) {
  // N shards at once, each this script on every Nth label with its own DuckDB process, progress file and cache file.
  const own = new Set(["--workers", "--progress", "--report", "--compare"]);
  const rest: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (own.has(process.argv[i])) { if (process.argv[i] !== "--report") i++; continue; }
    rest.push(process.argv[i]);
  }
  const cmds = Array.from({ length: WORKERS }, (_, i) => [process.execPath, ...process.execArgv, process.argv[1], ...rest, "--progress", shardFile(i), "--shard", `${i}/${WORKERS}`, "--done-from", PROGRESS]);
  const launcher = `const { spawn } = require("node:child_process");
const cmds = JSON.parse(process.argv[1]);
let left = cmds.length, bad = 0;
for (const [cmd, ...a] of cmds) spawn(cmd, a, { stdio: "inherit" }).on("exit", (c) => { if (c) bad++; if (--left === 0) process.exit(bad ? 1 : 0); });`;
  const r = spawnSync(process.execPath, ["-e", launcher, JSON.stringify(cmds)], { stdio: "inherit" });
  for (let i = 0; i < WORKERS; i++) readProgress(shardFile(i), done);
  if (r.status !== 0) { shardFailed = true; console.log("a shard stopped early; run again to finish (done questions are kept)"); }
}
// Fold the shards into --progress, once, so the run is one file again.
if (!SHARD) {
  const shards = Array.from({ length: 64 }, (_, i) => shardFile(i)).filter((f) => fs.existsSync(f));
  if (shards.length) {
    const have = new Map<string, Got | null>(); readProgress(PROGRESS, have);
    const add = [...done].filter(([id]) => !have.has(id)).map(([id, g]) => JSON.stringify({ id, got: g }) + "\n").join("");
    fs.appendFileSync(PROGRESS, add);
    for (const f of shards) fs.unlinkSync(f);
  }
}

let ran = 0;
const mine = (i: number) => !SHARD || i % SHARD[1] === SHARD[0];
if (WORKERS === 1 || SHARD) labels.forEach((l, i) => {
  if (ran >= limit || !mine(i)) return;
  if (done.has(l.id) || l.expected.outcome === "exclude") return;
  const t = Date.now();
  const once = () => (l.kind === "follow-up" && l.previous ? shadowFollowUp(l.previous, l.question, deps) : shadowAnswer(l.question, deps));
  let g: Got | null;
  try {
    let o;
    // A query past the time limit is tried once more on a fresh DuckDB process: under load it can be the load's.
    // The retry has three times the limit (the slow consistent-reporters question takes about 2-4 minutes alone, more
    // beside three other shards); then the usual limit again.
    try { o = once(); } catch (e) {
      if (!TIMEOUT.test(String(e))) throw e;
      nextMs = LIMIT_MS * 3;
      try { o = once(); } finally { nextMs = LIMIT_MS; }
    }
    // The Gemini reader (--gemini-readings): only where it qualifies; a reading that doesn't validate keeps the outcome.
    let via: string | undefined, read: string | undefined;
    if (READINGS) {
      const fu = l.kind === "follow-up" && !!l.previous, year = Number(deps.release.lastMonth.slice(0, 4));
      const o0 = o as unknown as { kind: string; reason?: string };
      const q = l.question, prev = fu ? l.previous : null;
      if (qualifies(q, { kind: o0.kind, reason: o0.reason }, year)) {
        // Withheld for personal details (never sent): today's outcome stands.
        const e = looksPersonal(q) || (prev && looksPersonal(prev)) ? undefined : READINGS.entries[readerKey(q, prev)];
        const v = e?.done ? validateProposal(e.proposal, q, year)
          : { ok: false as const, reason: looksPersonal(q) || (prev && looksPersonal(prev)) ? "withheld: personal details" : "not fetched" };
        if (v.ok) { o = fu ? shadowFollowUp(l.previous!, v.question, deps) : shadowAnswer(v.question, deps); via = "gemini"; read = v.question; }
        else via = `gemini refused: ${v.reason}`;
      }
    }
    g = { ...got(o as unknown as { kind: string } & Record<string, unknown>, Date.now() - t), ...(via ? { via } : {}), ...(read ? { read } : {}) };
  } catch (e) {
    // A process that can't be ended stops the run (incomplete, so not judged): the next one must never run beside it.
    if (/duckdb executor:/.test(String(e))) throw e;
    g = { kind: "error", source: null, reason: String(e).slice(0, 120), ms: Date.now() - t };
  }
  fs.appendFileSync(PROGRESS, JSON.stringify({ id: l.id, got: g }) + "\n");
  done.set(l.id, g);
  if (++ran % 100 === 0) console.log(`${SHARD ? `shard ${SHARD[0]}: ` : ""}${ran} run (${done.size} of ${labels.length} labels done)${cacheOut ? `; queries from the cache ${hits}, from DuckDB ${misses}` : ""}`);
});
if (SHARD) process.exit(0);

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
const incomplete = all.notRun > 0 || shardFailed;
const gate = incomplete ? `NOT JUDGED: the run is incomplete (${all.notRun} questions not run${shardFailed ? ", a shard failed" : ""})`
  : all.c["wrong answer"] === 0 ? "met" : `NOT met: ${all.c["wrong answer"]} wrong answers`;
console.log(`hard gate (wrong answers = 0): ${gate}`);
if (READINGS) {
  // The Gemini reader's questions, by what happened: used (and the bucket it reached), or refused and why.
  const via = new Map<string, number>();
  for (const l of scored) { const g = done.get(l.id); if (g?.via) { const k = g.via === "gemini" ? `gemini used -> ${bucket(l, g)}` : g.via; via.set(k, (via.get(k) ?? 0) + 1); } }
  console.log("gemini reader:", JSON.stringify(Object.fromEntries([...via].sort())));
  const review = arg("--gemini-review");
  if (review) {
    const rows = scored.filter((l) => done.get(l.id)?.via === "gemini" && done.get(l.id)?.kind === "answer")
      .map((l) => JSON.stringify({ id: l.id, question: l.question, previous: l.kind === "follow-up" ? l.previous : null, read: done.get(l.id)!.read, source: done.get(l.id)!.source, bucket: bucket(l, done.get(l.id)!) }));
    fs.writeFileSync(review, rows.join("\n") + (rows.length ? "\n" : ""));
    console.log(`gemini answers to review: ${rows.length} (${review})`);
  }
}
// Follow-up answers on their own (undisputed labels): how many there are, and how many of each kind.
const fuAnswers = scored.filter((l) => l.kind === "follow-up" && l.label.status !== "disputed" && done.get(l.id)?.kind === "answer");
const fuCount = (b: Bucket) => fuAnswers.filter((l) => bucket(l, done.get(l.id) ?? null) === b).length;
const fuLine = `follow-up answers: ${fuAnswers.length} (correct ${fuCount("correct")}, unverified ${fuCount("unverified")}, wrong ${fuCount("wrong answer")})`;
console.log(fuLine);
if (cacheOut) console.log(`queries from the cache ${hits}, from DuckDB ${misses} (this process; shards print their own)`);

// --compare: every question whose outcome differs from another run's (dev's), with its bucket before and after; the
// counts are compared over the questions both runs have.
const COMPARE = arg("--compare");
if (COMPARE) {
  const before = new Map<string, Got | null>(); readProgress(COMPARE, before);
  // The outcome itself, not where it came from (Codex review 01: a refused reading is an unchanged outcome).
  const same = (a: Got | null, b: Got | null) => JSON.stringify({ ...a, ms: 0, via: undefined, read: undefined }) === JSON.stringify({ ...b, ms: 0, via: undefined, read: undefined });
  const both = scored.filter((l) => before.has(l.id));
  const moved = new Map<string, number>();
  const diffs: string[] = [];
  for (const l of both) {
    const a = before.get(l.id) ?? null, b = done.get(l.id) ?? null;
    if (same(a, b)) continue;
    const ba = bucket(l, a), bb = bucket(l, b);
    if (ba !== bb) moved.set(`${ba} -> ${bb}`, (moved.get(`${ba} -> ${bb}`) ?? 0) + 1);
    const short = (g: Got | null) => (g ? `${g.kind}${g.source ? `:${g.source}` : ""}${g.about ? `:${g.about}` : ""}${g.reason ? `:${g.reason.slice(0, 40)}` : ""}${g.digest ? `#${g.digest.slice(0, 6)}` : ""}` : "none");
    diffs.push(`${l.id}\t${ba} -> ${bb}\t${short(a)} -> ${short(b)}\t${l.question.slice(0, 100)}`);
  }
  console.log(`\ncompared with ${COMPARE}: ${both.length} questions in both, ${diffs.length} outcomes differ, ${[...moved.values()].reduce((x, y) => x + y, 0)} change bucket`);
  // The gate against the baseline (Codex review 01.8): wrong answers this run has that the compared run didn't.
  console.log(`new wrong answers against ${COMPARE}: ${[...moved].filter(([k]) => /-> wrong answer$/.test(k) && !/^wrong answer ->/.test(k)).reduce((x, [, n]) => x + n, 0)}`);
  for (const [k, n] of [...moved].sort()) console.log(`  ${n}  ${k}`);
  for (const d of diffs) console.log(d);
}

// Per rule, for triage (local): each rule's buckets.
const byRule = new Map<string, Record<string, number>>();
for (const l of scored) { const b = bucket(l, done.get(l.id) ?? null); const r = byRule.get(l.label.rule) ?? {}; r[b] = (r[b] ?? 0) + 1; byRule.set(l.label.rule, r); }
for (const [r, c] of [...byRule].sort()) console.log(r, JSON.stringify(c));

const disputedGroups = new Map<string, number>();
for (const l of labels) if (l.label.status === "disputed") { const k = (l.label as { notes?: string }).notes?.split(":")[0] ?? "?"; disputedGroups.set(k, (disputedGroups.get(k) ?? 0) + 1); }
if (process.argv.includes("--report") && incomplete) console.log("--report skipped: the run is incomplete");
if (process.argv.includes("--report") && !incomplete) {
  const draftAll = all.n - all.drafts - all.reviewed === 0;
  const out = [
    `# Query-log scorecard${draftAll ? " (DRAFT: no label is confirmed yet)" : ""}`, "",
    "Every logged question gets one expected outcome: answer (with its source), clarify (with what is asked) or decline (with the plain reason). Labels come from written rules (scripts/draft-qlog-labels.py), never from the engine's output; this run compares the engine with them (scripts/run-qlog-scorecard.ts). The labels, with each question as written (Jeff 2026-11-04), are scripts/fixtures/answer-eval/qlog-labels.json, keyed by a hash of the normalized question; the rules are docs/reports/qlog-label-rules.md. The log copy itself stays outside the repo.", "",
    `Release ${deps.release.id}; run ${new Date().toISOString().slice(0, 10)}. A first question is the first row of each session in each tab; a follow-up is any later row, labeled with the row before it. Distinct questions per tab (the same words counted once; "times" in the label file says how often each was asked).`, "",
    `**Label status: ${all.n - all.drafts - all.reviewed} confirmed, ${all.reviewed} reviewed (two labelers agree: the rules and an independent second labeler), ${all.drafts} draft (a second-labeler correction, or a rule label not yet reviewed).** No label is confirmed, so this is still a draft scorecard: a miss here is a candidate, not a finding.`, "",
    "**Unverified is not correct.** An answer from the right source counts as correct only once its numbers match independent values (nibrs-model's files, or SQL against the source build); until then it is unverified.", "",
    table, "",
    `Hard gate, wrong answers = 0 (undisputed labels): **${gate}**. Follow-up turns count: ${fuLine}.`, "",
    `**Disputed: ${all.disputed} labels wait on Jeff and are set aside** (not in any bucket or the gate): ${[...disputedGroups].map(([k, n]) => `${k} ${n}`).join(", ")}. The questions are in docs/reports/qlog-label-rules.md.`, "",
    "Buckets: *correct* the outcome the label expects; *unverified* the right source, numbers not yet checked against independent values (or routed to a source this engine does not run yet); a right-source answer whose every number matched independent values (qlog-verified.json) is *correct*; *wrong answer* an answer where a clarify or decline is expected, or an answer from the wrong source (numbers found to differ from independent values are reported as each verification batch finds them; a verified answer whose numbers change goes back to *unverified*; a follow-up turn's wrong answer is a wrong answer too); *bad decline* a decline where an answer or a clarify is expected; *wrong clarify* a clarify where an answer or decline is expected, or about another part; *follow-up error* a follow-up turn's bad decline or wrong clarify; *error* the engine failed.", "",
  ].join("\n");
  fs.writeFileSync(path.join(__dirname, "..", "docs", "reports", "qlog-scorecard.md"), out);
}
exec.close();
// A run that is incomplete, or whose gate isn't met, exits non-zero.
process.exit(incomplete ? 2 : all.c["wrong answer"] === 0 ? 0 : 1);
