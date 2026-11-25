import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { bucket, sameOutcome, tableShape, wordingMatches, VERIFIED, type Label, type Got } from "./qlog-bucket";
import { labelIdentity, readLabels, comparedLabelsFile, splitCompare, formatSplitCompare, appendTrend, readTrend, formatTrend, sumCheck, TREND_COLUMNS, type TrendRow } from "./scoreboard-v2";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoreboard-v2-"));
const repo = path.join(__dirname, "..");
const label = (id: string, outcome: Label["expected"]["outcome"] = "answer", kind: Label["kind"] = "first"): Label => ({
  id, tab: "nibrs", kind, times: 1, question: id, previous: null,
  expected: { outcome, source: "nibrs" }, label: { status: "reviewed", rule: "synthetic" },
});
const got = (kind: string): Got => ({ kind, source: "nibrs", ms: 1 });
// The --compare answer equality.
const same = sameOutcome;

try {
  check("blob and label versions", () => {
    const file = path.join(dir, "labels_local_v17.json");
    fs.writeFileSync(file, JSON.stringify({ version: "v2", about: "ignored", labels: [], text: "\u00e9" }));
    const git = spawnSync("git", ["hash-object", "--no-filters", file], { cwd: repo, encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
    assert.deepEqual(labelIdentity(file), { blob: git.stdout.trim(), version: "v2", file });
    fs.writeFileSync(file, JSON.stringify({ version: 0, labels: [] }));
    assert.equal(labelIdentity(file).version, "0");
    fs.writeFileSync(file, JSON.stringify({ about: "a".repeat(80), labels: [] }));
    assert.equal(labelIdentity(file).version, "a".repeat(60));
    fs.writeFileSync(file, JSON.stringify({ labels: [] }));
    assert.equal(labelIdentity(file).version, "labels_local_v17");
    fs.writeFileSync(file, "[]");
    assert.equal(labelIdentity(file).version, "labels_local_v17");
    assert.deepEqual(readLabels(file), []);
    const progress = path.join(dir, "progress.jsonl");
    assert.equal(comparedLabelsFile(progress), undefined);
    fs.writeFileSync(`${progress}.meta.json`, JSON.stringify({ labels: file }));
    assert.equal(comparedLabelsFile(progress), file);
    assert.equal(comparedLabelsFile(progress, "explicit.json"), "explicit.json");
    fs.writeFileSync(`${progress}.meta.json`, JSON.stringify({ labels: `${file}.missing` }));
    assert.equal(comparedLabelsFile(progress), undefined);
  });

  check("comparison split and exact output", () => {
    const oldLabels = [label("label"), label("engine", "decline"), label("both", "decline"), label("removed"), label("unchanged"), label("missing")];
    const newLabels = [label("label", "decline"), label("engine", "decline"), label("both"), label("added"), label("unchanged"), label("missing", "decline")];
    const oldDone = new Map<string, Got | null>([
      ["label", got("decline")], ["engine", got("answer")], ["both", got("decline")],
      ["removed", got("decline")], ["added", got("decline")], ["unchanged", got("answer")], ["missing", got("decline")],
    ]);
    const newDone = new Map<string, Got | null>([
      ["label", { ...got("decline"), ms: 99, via: "gemini", read: "ignored" }],
      ["engine", got("decline")], ["both", got("clarify")], ["removed", got("answer")],
      ["added", got("answer")], ["unchanged", { ...got("answer"), ms: 8 }],
    ]);
    const result = splitCompare(oldLabels, newLabels, oldDone, newDone, bucket, same);
    assert.deepEqual(result, {
      labelChange: { count: 1, moves: { "bad decline -> correct": 1 }, correctDelta: 1 },
      engineChange: { count: 1, moves: { "wrong answer -> correct": 1 }, correctDelta: 1 },
      bothChanged: { count: 1, moves: { "correct -> wrong clarify": 1 }, correctDelta: -1 },
      added: 1, removed: 1,
    });
    assert.equal(formatSplitCompare(result), [
      "label change: 1 bucket moves (same answer text, different label)", "  1  bad decline -> correct",
      "engine change: 1 bucket moves (the answer changed, the label did not)", "  1  wrong answer -> correct",
      "both changed: 1 bucket moves (the answer and the label both changed: not blamed on either)", "  1  correct -> wrong clarify",
      "labels added: 1, removed: 1 (outside all three lines); net correct: label change +1, engine change +1, both changed -1",
    ].join("\n"));
  });

  check("sum check", () => {
    assert.equal(sumCheck(9, { correct: 5, error: 1, disputed: 2, "not run": 1 }), null);
    assert.match(sumCheck(9, { correct: 5, disputed: 2 })!, /^SUM CHECK FAILED: correct 5 \+ disputed 2 = 7, but the label count is 9$/);
  });

  check("trend header, append, duplicate skip, and reader", () => {
    const file = path.join(dir, "nested", "trend.tsv");
    const row: TrendRow = { date: "2026-11-23T00:00:00.000Z", head: "a".repeat(40), label_hash: "b".repeat(40), labels: 9, scored: 7,
      correct: 1, wrong: 1, bad_decline: 1, wrong_clarify: 1, follow_up_error: 1, unverified: 1, error: 1, disputed: 1, not_run: 1, digest: "c".repeat(64) };
    assert.equal(formatTrend(readTrend(file)), "No trend rows.");
    assert.equal(appendTrend(file, row), true);
    const original = fs.readFileSync(file, "utf8");
    assert.equal(original, TREND_COLUMNS.join("\t") + "\n" + TREND_COLUMNS.map(k => row[k]).join("\t") + "\n");
    assert.equal(appendTrend(file, { ...row, date: "2026-11-24T00:00:00.000Z" }), false);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(appendTrend(file, { ...row, digest: "d".repeat(64), correct: 3 }), true);
    assert.equal(appendTrend(file, { ...row, label_hash: "e".repeat(40), correct: 2 }), true);
    assert.equal(appendTrend(file, { ...row, head: "f".repeat(40), correct: 4 }), true);
    const rows = readTrend(file);
    assert.equal(rows.length, 4);
    const output = formatTrend(rows);
    const lines = output.split("\n");
    assert.match(lines[1], /\s-$/);
    assert.match(lines[2], /\s\+2$/);
    assert.match(lines[3], /\s-1\s+label file changed$/);
    assert.match(lines[4], /\s\+2\s+label file changed$/);
    assert.equal(lines[5], "First correct: 1; last correct: 4");
    const starts = lines.slice(1, 5).map(line => line.indexOf("2026-"));
    assert.deepEqual(starts, [0, 0, 0, 0]);
    const cli = spawnSync(process.execPath, ["--import", "tsx", path.join(__dirname, "print-qlog-trend.ts"), "--file", file], { cwd: repo, encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout.trimEnd(), output);
  });

  check("counting unchanged from a2104bdb; labels without the new fields score as before", () => {
    // CI checks out a shallow clone, so the base revision may be absent; the git comparison is then skipped with a note.
    // qlog-bucket.ts itself changed on purpose (the label fields period, top_n, min_population, wording): the fixed set
    // below, whose labels have none of them, must still score exactly as recorded.
    const haveBase = spawnSync("git", ["cat-file", "-e", "a2104bdb^{commit}"], { cwd: repo, encoding: "utf8" }).status === 0;
    if (!haveBase) console.log("  NOTE  revision a2104bdb is not in this clone (shallow checkout); the counting comparison is skipped here and runs in full clones");
    else {
      const base = spawnSync("git", ["show", "a2104bdb:scripts/run-qlog-scorecard.ts"], { cwd: repo, encoding: "utf8" });
      assert.equal(base.status, 0, base.stderr);
      const per = (text: string) => text.slice(text.indexOf("const per ="), text.indexOf("const rows = TABS"));
      assert.equal(per(fs.readFileSync(path.join(__dirname, "run-qlog-scorecard.ts"), "utf8")), per(base.stdout));
    }
    const cases: [string, Label["expected"]["outcome"], string, Label["kind"]][] = [
      ["correct", "decline", "decline", "first"], ["unverified", "answer", "answer", "first"],
      ["wrong", "decline", "answer", "first"], ["bad", "answer", "decline", "first"],
      ["clarify", "answer", "clarify", "first"], ["follow", "answer", "decline", "follow-up"],
      ["error", "answer", "error", "first"], ["excluded", "exclude", "answer", "first"],
      ["disputed", "answer", "answer", "first"], ["not-run", "answer", "answer", "first"],
    ];
    const labels = cases.map(([id, outcome, , kind]) => label(id, outcome, kind));
    labels.find(l => l.id === "disputed")!.label.status = "disputed";
    const done = new Map(cases.filter(([id]) => id !== "not-run").map(([id, , kind]) => [id, got(kind)]));
    const scored = labels.filter(l => l.expected.outcome !== "exclude" && done.has(l.id));
    const ls = scored.filter(l => l.tab === "nibrs" && l.label.status !== "disputed");
    const c: Record<string, number> = Object.fromEntries(["correct", "unverified", "wrong answer", "bad decline", "wrong clarify", "follow-up error", "error"].map(b => [b, 0]));
    for (const l of ls) { const b = bucket(l, done.get(l.id) ?? null); if (b !== "excluded") c[b]++; }
    // Recorded by running this fixed set against the unmodified code before adding the runner hooks.
    assert.deepEqual({ n: ls.length, c, disputed: scored.filter(l => l.label.status === "disputed").length,
      notRun: labels.filter(l => l.expected.outcome !== "exclude" && !done.has(l.id)).length }, {
      n: 7, c: { correct: 1, unverified: 1, "wrong answer": 1, "bad decline": 1, "wrong clarify": 1, "follow-up error": 1, error: 1 }, disputed: 1, notRun: 1,
    });
  });

  check("label fields: period, top_n, min_population", () => {
    const VER = "verified-shape";
    VERIFIED[VER] = { digest: "d1" };
    try {
      const l = (expected: Partial<Label["expected"]>): Label => ({ ...label(VER), expected: { outcome: "answer", source: "nibrs", ...expected } });
      const a = (g: Partial<Got>): Got => ({ kind: "answer", source: "nibrs", ms: 1, digest: "d1", ...g });
      const monthly = { period: { from: "2017-01", to: "latest" } };
      // Verified numbers over the asked period: correct. Ending a month early, or starting in 2018: a wrong answer.
      assert.equal(bucket(l(monthly), a({ period: { from: "2017-01", to: "2026-09" }, latest: "2026-09" })), "correct");
      assert.equal(bucket(l(monthly), a({ period: { from: "2017-01", to: "2026-08" }, latest: "2026-09" })), "wrong answer");
      assert.equal(bucket(l(monthly), a({ period: { from: "2018-01", to: "2026-09" }, latest: "2026-09" })), "wrong answer");
      // A run that recorded no period (an older progress file) cannot be correct, nor wrong.
      assert.equal(bucket(l(monthly), a({})), "unverified");
      // A wrong period is wrong even with unverified numbers.
      assert.equal(bucket(l(monthly), a({ digest: "other", period: { from: "2020-01", to: "2026-09" }, latest: "2026-09" })), "wrong answer");
      // A fixed "to".
      assert.equal(bucket(l({ period: { from: "2015", to: "2025" } }), a({ period: { from: "2015", to: "2025" } })), "correct");
      // A span is not checked here: verified numbers stay correct.
      assert.equal(bucket(l({ period: { span: "all_nibrs_years" } }), a({})), "correct");
      assert.equal(bucket(l({ top_n: 10 }), a({ rows: 10 })), "correct");
      assert.equal(bucket(l({ top_n: 10 }), a({ rows: 25 })), "wrong answer");
      assert.equal(bucket(l({ top_n: 10 }), a({})), "unverified");
      // A full year asked, a monthly table shown: the same period. One month short: wrong.
      assert.equal(bucket(l({ period: { from: "2024", to: "2024" } }), a({ period: { from: "2024-01", to: "2024-12" } })), "correct");
      assert.equal(bucket(l({ period: { from: "2024", to: "2024" } }), a({ period: { from: "2024-01", to: "2024-11" } })), "wrong answer");
      assert.equal(bucket(l({ min_population: 50000 }), a({ minPop: 52000, popGaps: false })), "correct");
      assert.equal(bucket(l({ min_population: 50000 }), a({ minPop: 31000, popGaps: false })), "wrong answer");
      assert.equal(bucket(l({ min_population: 50000 }), a({ minPop: null })), "unverified");
      // A place with no population: unconfirmed, unless a known one is already under the floor.
      assert.equal(bucket(l({ min_population: 50000 }), a({ minPop: 60000, popGaps: true })), "unverified");
      assert.equal(bucket(l({ min_population: 50000 }), a({ minPop: 31000, popGaps: true })), "wrong answer");
      // A follow-up's wrong answer stays a wrong answer.
      assert.equal(bucket({ ...l({ top_n: 5 }), kind: "follow-up" }, a({ rows: 6 })), "wrong answer");
    } finally { delete VERIFIED[VER]; }
  });

  check("table shape", () => {
    const year = { binding: { kind: "grouping", dimension: "time.year" }, header: "Year" };
    const month = { binding: { kind: "grouping", dimension: "time.month" }, header: "Month" };
    const stat = { binding: { kind: "statistic" }, header: "Murders" };
    assert.deepEqual(tableShape({ columns: [month, stat], rows: [["2017-02", 1], ["2017-01", 2], ["2026-09", 3]] }, "2026-09"),
      { period: { from: "2017-01", to: "2026-09" }, rows: 3, minPop: null, popGaps: false, latest: "2026-09" });
    assert.deepEqual(tableShape({ columns: [{ header: "City" }, { header: "Population" }], rows: [["A", 60000], ["B", null]] }, "2026-09"),
      { rows: 2, minPop: 60000, popGaps: true, latest: "2026-09" });
    // Years across the columns (a place by year table), population column, a total row's blank period ignored.
    assert.deepEqual(tableShape({ columns: [{ header: "City" }, { header: "Population" }, { header: "2023" }, { header: "2024" }], rows: [["A", 60000, 1, 2], ["B", 51000, 3, 4]] }, "2026-09"),
      { period: { from: "2023", to: "2024" }, rows: 2, minPop: 51000, popGaps: false, latest: "2026-09" });
    assert.deepEqual(tableShape({ columns: [year, stat], rows: [["2019", 1], [null, 2]] }, "2026-09").period, { from: "2019", to: "2019" });
    assert.deepEqual(tableShape(undefined, "2026-09"), { latest: "2026-09" });
  });

  check("decline wording", () => {
    const d = (wording?: string): Label => ({ ...label("w", "decline"), expected: { outcome: "decline", source: null, ...(wording ? { wording } : {}) } });
    const g = (kind: string, text?: string): Got => ({ kind, source: null, ms: 1, ...(text !== undefined ? { text } : {}) });
    assert.equal(bucket(d("Metro area data is not available."), g("decline", "Metro area data is not available.")), "correct");
    assert.equal(bucket(d("Metro area data is not available."), g("decline", "  metro area data is  not available. ")), "correct");
    assert.equal(bucket(d("I'm sorry, I didn't understand your question. Please try again."), g("decline", "I’m sorry, I didn’t understand your question. Please try again.")), "correct");
    assert.equal(bucket(d("Metro area data is not available."), g("decline", "We don't track metro areas. For example, try a city.")), "bad decline");
    assert.equal(bucket(d("There is no data available for <crime> in <place>."), g("decline", "There is no data available for arson in Gary, IN.")), "correct");
    assert.equal(bucket(d("There is no data available for <crime> in <place>."), g("decline", "There is no data available.")), "bad decline");
    // No sentence recorded (an older run), or a route: cannot be correct.
    assert.equal(bucket(d("Metro area data is not available."), g("decline")), "unverified");
    assert.equal(bucket(d("Metro area data is not available."), g("route")), "unverified");
    // A label without wording: any decline, as before.
    assert.equal(bucket(d(), g("decline", "anything")), "correct");
    assert.equal(wordingMatches("Cost: $5 (a+b).", "cost: $5 (a+b)."), true);
  });

  check("compare ignores what an older run did not record", () => {
    const old: Got = { kind: "decline", source: null, reason: "scope", ms: 5 };
    assert.equal(sameOutcome(old, { ...old, ms: 9, text: "Metro area data is not available." }), true);
    assert.equal(sameOutcome({ ...old, text: "A." }, { ...old, text: "B." }), false);
    const ans: Got = { kind: "answer", source: "nibrs", ms: 1, digest: "d" };
    assert.equal(sameOutcome(ans, { ...ans, period: { from: "2017", to: "2025" }, rows: 9, minPop: null, latest: "2026-09" }), true);
    assert.equal(sameOutcome(ans, { ...ans, digest: "e" }), false);
    // Recorded by both: a year header that moved while the rows' digest did not is a change.
    const shaped: Got = { ...ans, period: { from: "2024", to: "2024" }, rows: 1, minPop: null, popGaps: false, latest: "2026-09" };
    assert.equal(sameOutcome(shaped, { ...shaped, ms: 7 }), true);
    assert.equal(sameOutcome(shaped, { ...shaped, period: { from: "2025", to: "2025" } }), false);
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `test-scoreboard-v2: ${failed} FAILED` : "test-scoreboard-v2: all passed");
process.exit(failed ? 1 : 0);
