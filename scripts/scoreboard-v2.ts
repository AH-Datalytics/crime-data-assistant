import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Bucket, Got, Label } from "./qlog-bucket";

export function labelIdentity(file: string): { blob: string; version: string; file: string } {
  const bytes = fs.readFileSync(file);
  const data = JSON.parse(bytes.toString("utf8"));
  const object = data !== null && typeof data === "object" && !Array.isArray(data);
  const version = object && Object.hasOwn(data, "version") ? String(data.version)
    : object && typeof data.about === "string" ? data.about.slice(0, 60)
    : path.basename(file, path.extname(file));
  return { blob: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), version, file };
}

export function readLabels(file: string): Label[] {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const labels = Array.isArray(data) ? data : data.labels;
  if (!Array.isArray(labels)) throw new Error(`${file}: no labels array`);
  return labels;
}

export function comparedLabelsFile(progress: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const meta = `${progress}.meta.json`;
  if (!fs.existsSync(meta)) return undefined;
  const { labels } = JSON.parse(fs.readFileSync(meta, "utf8"));
  return typeof labels === "string" && fs.existsSync(labels) ? labels : undefined;
}

// Compare label content without depending on JSON object key order.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",") + "}";
  return JSON.stringify(value) ?? "undefined";
}

type Moves = { count: number; moves: Record<string, number>; correctDelta: number };
export type SplitComparison = { labelChange: Moves; engineChange: Moves; engineAlsoLabel: number; added: number; removed: number };

export function splitCompare(
  oldLabels: readonly Label[], newLabels: readonly Label[],
  oldDone: ReadonlyMap<string, Got | null>, newDone: ReadonlyMap<string, Got | null>,
  bucketFn: (label: Label, got: Got | null) => Bucket,
  sameFn: (a: Got | null, b: Got | null) => boolean,
): SplitComparison {
  const old = new Map(oldLabels.map(l => [l.id, l]));
  const next = new Map(newLabels.map(l => [l.id, l]));
  const empty = (): Moves => ({ count: 0, moves: {}, correctDelta: 0 });
  const result: SplitComparison = { labelChange: empty(), engineChange: empty(), engineAlsoLabel: 0,
    added: [...next.keys()].filter(id => !old.has(id)).length,
    removed: [...old.keys()].filter(id => !next.has(id)).length };
  for (const [id, a] of old) {
    const b = next.get(id);
    if (!b || !oldDone.has(id) || !newDone.has(id)) continue;
    const ga = oldDone.get(id) ?? null, gb = newDone.get(id) ?? null;
    const ba = bucketFn(a, ga), bb = bucketFn(b, gb);
    if (ba === bb) continue;
    const sameAnswer = sameFn(ga, gb);
    const group = sameAnswer ? result.labelChange : result.engineChange;
    group.count++;
    const move = `${ba} -> ${bb}`;
    group.moves[move] = (group.moves[move] ?? 0) + 1;
    group.correctDelta += Number(bb === "correct") - Number(ba === "correct");
    if (!sameAnswer && stable(a) !== stable(b)) result.engineAlsoLabel++;
  }
  return result;
}

const signed = (n: number) => n > 0 ? `+${n}` : String(n);
export function formatSplitCompare(result: SplitComparison): string {
  const lines: string[] = [];
  for (const [name, group, detail] of [
    ["label change", result.labelChange, "same answer text, different label"],
    ["engine change", result.engineChange, "the answer changed"],
  ] as const) {
    lines.push(`${name}: ${group.count} bucket moves (${detail})`);
    for (const [move, count] of Object.entries(group.moves).sort()) lines.push(`  ${count}  ${move}`);
  }
  lines.push(`engine moves with a different label: ${result.engineAlsoLabel}; labels added: ${result.added}, removed: ${result.removed} (outside both lines); net correct: label change ${signed(result.labelChange.correctDelta)}, engine change ${signed(result.engineChange.correctDelta)}`);
  return lines.join("\n");
}

export const TREND_COLUMNS = ["date", "head", "label_hash", "scored", "correct", "wrong", "bad_decline", "wrong_clarify", "follow_up_error", "unverified", "error", "digest"] as const;
export type TrendRow = Record<typeof TREND_COLUMNS[number], string | number>;
export const DEFAULT_TREND_FILE = path.join(__dirname, "..", "docs", "reports", "qlog-trend.tsv");

export function readTrend(file: string): TrendRow[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trimEnd().split(/\r?\n/);
  if (lines[0] !== TREND_COLUMNS.join("\t")) throw new Error(`${file}: unexpected trend header`);
  return lines.slice(1).filter(Boolean).map(line => {
    const cells = line.split("\t");
    if (cells.length !== TREND_COLUMNS.length) throw new Error(`${file}: invalid trend row`);
    return Object.fromEntries(TREND_COLUMNS.map((key, i) => [key, cells[i]])) as TrendRow;
  });
}

export function appendTrend(file: string, row: TrendRow): boolean {
  const rows = readTrend(file);
  if (rows.some(r => ["head", "label_hash", "digest"].every(k => String(r[k as keyof TrendRow]) === String(row[k as keyof TrendRow])))) return false;
  const line = TREND_COLUMNS.map(k => String(row[k]));
  if (line.some(cell => /[\t\r\n]/.test(cell))) throw new Error("invalid trend cell");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, TREND_COLUMNS.join("\t") + "\n");
  const separator = fs.readFileSync(file, "utf8").endsWith("\n") ? "" : "\n";
  fs.appendFileSync(file, separator + line.join("\t") + "\n");
  return true;
}

export function formatTrend(rows: readonly TrendRow[]): string {
  if (!rows.length) return "No trend rows.";
  const cells = [ [...TREND_COLUMNS, "correct change", "note"], ...rows.map((r, i) => [
    ...TREND_COLUMNS.map(k => String(r[k])),
    i ? signed(Number(r.correct) - Number(rows[i - 1].correct)) : "-",
    i && r.label_hash !== rows[i - 1].label_hash ? "label file changed" : "",
  ]) ];
  const widths = cells[0].map((_, i) => Math.max(...cells.map(row => row[i].length)));
  return cells.map(row => row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd()).join("\n")
    + `\nFirst correct: ${rows[0].correct}; last correct: ${rows[rows.length - 1].correct}`;
}
