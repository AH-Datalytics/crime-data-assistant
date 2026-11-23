import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { bucket, type Label, type Got } from "./qlog-bucket";
import { labelIdentity, readLabels, comparedLabelsFile, splitCompare, formatSplitCompare, appendTrend, readTrend, formatTrend, TREND_COLUMNS, type TrendRow } from "./scoreboard-v2";

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
// Identical to the existing --compare answer equality.
const same = (a: Got | null, b: Got | null) => JSON.stringify({ ...a, ms: 0, via: undefined, read: undefined }) === JSON.stringify({ ...b, ms: 0, via: undefined, read: undefined });

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
      engineChange: { count: 2, moves: { "wrong answer -> correct": 1, "correct -> wrong clarify": 1 }, correctDelta: 0 },
      engineAlsoLabel: 1, added: 1, removed: 1,
    });
    assert.equal(formatSplitCompare(result), [
      "label change: 1 bucket moves (same answer text, different label)", "  1  bad decline -> correct",
      "engine change: 2 bucket moves (the answer changed)", "  1  correct -> wrong clarify", "  1  wrong answer -> correct",
      "engine moves with a different label: 1; labels added: 1, removed: 1 (outside both lines); net correct: label change +1, engine change 0",
    ].join("\n"));
  });

  check("trend header, append, duplicate skip, and reader", () => {
    const file = path.join(dir, "nested", "trend.tsv");
    const row: TrendRow = { date: "2026-11-23T00:00:00.000Z", head: "a".repeat(40), label_hash: "b".repeat(40), scored: 7,
      correct: 1, wrong: 1, bad_decline: 1, wrong_clarify: 1, follow_up_error: 1, unverified: 1, error: 1, digest: "c".repeat(64) };
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

  check("scorer unchanged from a2104bdb", () => {
    const diff = spawnSync("git", ["diff", "--quiet", "a2104bdb", "--", "scripts/qlog-bucket.ts"], { cwd: repo, encoding: "utf8" });
    assert.equal(diff.status, 0, diff.stderr);
    const base = spawnSync("git", ["show", "a2104bdb:scripts/run-qlog-scorecard.ts"], { cwd: repo, encoding: "utf8" });
    assert.equal(base.status, 0, base.stderr);
    const per = (text: string) => text.slice(text.indexOf("const per ="), text.indexOf("const rows = TABS"));
    assert.equal(per(fs.readFileSync(path.join(__dirname, "run-qlog-scorecard.ts"), "utf8")), per(base.stdout));
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
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `test-scoreboard-v2: ${failed} FAILED` : "test-scoreboard-v2: all passed");
process.exit(failed ? 1 : 0);
