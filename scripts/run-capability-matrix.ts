/**
 * The capability matrix, runner: asks every non-excluded combination of scripts/fixtures/nibrs-capability-matrix.jsonl to the ENGINE SERVICE (127.0.0.1, the token from the
 * environment) one at a time and records the outcome per combination, appending to a results file so an interrupted run resumes where it stopped.
 *
 *   ENGINE_SERVICE_URL=http://127.0.0.1:8420 ENGINE_TOKEN=... npx tsx scripts/run-capability-matrix.ts --out results.jsonl [--shard 0/8] [--scope nation] [--timing] [--limit 500]
 *
 * Results (one JSON object per line): { id, status, kind, reason, ms, rows, digest, note }
 *   status  answered | declined | excluded | service_error
 *   kind    the response kind ("answer", "decline", "route", ...), or the service failure kind (busy, timeout, error)
 *   reason  a decline's reason code (response.reason) and, when present, the engine's sentence (first 400 characters) in `note`
 *   ms      the service's own time for the question (no clock is read here)
 *   rows    the number of result rows; answer: { columns, rows, text } for an answered row (the engine's own table, rows keyed by column in display order, at most 5000), so a reference can be joined by id; digest: a short hash of the whole response (for comparing two runs or two builds)
 * Run at Idle priority, serial; `--timing` asks only the plain state and national one-year totals (the Texas/US per-measure raw timing table, with the matrix's state = Ohio).
 * Cube on versus off (the matrix as a same-build equality check, no reference needed): run the whole matrix against a service started with the cube set and again against one without
 * (two ENGINE_SERVICE_URL ports), then `--compare cube-on.jsonl cube-off.jsonl`: every id whose status or response digest (statements left out) differs is listed; exit code 1.
 * Summary: `npx tsx scripts/run-capability-matrix.ts --summary results.jsonl` prints answered / declined / excluded / service_error and coverage per measure, breakdown, scope and grain.
 */
import crypto from "node:crypto";
import fs from "node:fs";

type Row = { id: string; measure: string; breakdown: string; family: string; scope: string; grain: string; question: string; excluded?: string; timing?: boolean };
type Res = { id: string; status: "answered" | "declined" | "excluded" | "service_error"; kind: string; reason?: string; ms?: number; rows?: number; digest?: string; note?: string; answer?: { columns: string[]; rows: Record<string, unknown>[]; text: string[] } };
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (k: string) => process.argv.includes(`--${k}`);
const readJsonl = <T>(p: string): T[] => (fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);
const MATRIX = "scripts/fixtures/nibrs-capability-matrix.jsonl";

/** The statements differ by design between a cube-on and a cube-off service; everything else in a response must not (same rule as scripts/test-nibrs-cube.ts). */
const noSql = (k: string, v: unknown) => (k === "sql" || k === "sqls" ? undefined : v);

function classify(r: unknown): Res["status"] {
  const k = (r as { kind?: string })?.kind;
  return k === "decline" ? "declined" : k === "answer" || k === "srs" || k === "historical" || k === "current" || k === "shr" ? "answered" : "declined";
}

async function main(): Promise<void> {
  const sumPath = arg("summary");
  if (sumPath) return summary(sumPath);
  const cmp = arg("compare");
  if (cmp) return compare(cmp, process.argv[process.argv.indexOf("--compare") + 2]);
  const out = arg("out"); if (!out) throw new Error("--out <results.jsonl> is required");
  const url = process.env.ENGINE_SERVICE_URL ?? "http://127.0.0.1:8420", token = process.env.ENGINE_TOKEN ?? "";
  if (!token) throw new Error("ENGINE_TOKEN is not set (read it from the engine settings file on the machine that runs the service; never put it in a file in the repository)");
  const done = new Set(readJsonl<Res>(out).map((r) => r.id));
  const [si, sn] = (arg("shard") ?? "0/1").split("/").map(Number);
  let rows = readJsonl<Row>(MATRIX).filter((r, i) => i % sn === si);
  if (arg("scope")) rows = rows.filter((r) => r.scope === arg("scope"));
  if (has("timing")) rows = rows.filter((r) => r.timing);
  const limit = Number(arg("limit") ?? "0");
  let asked = 0;
  for (const r of rows) {
    if (done.has(r.id)) continue;
    let res: Res;
    if (r.excluded) res = { id: r.id, status: "excluded", kind: "excluded", note: r.excluded };
    else {
      if (limit && asked >= limit) break;
      asked++;
      try {
        const http = await fetch(`${url}/answer`, { method: "POST", headers: { "content-type": "application/json", "x-engine-token": token }, body: JSON.stringify({ tab: "nibrs", question: r.question }) });
        const body = (await http.json()) as { ok: boolean; response?: Record<string, unknown>; ms?: number; kind?: string; message?: string };
        if (!body.ok) res = { id: r.id, status: "service_error", kind: body.kind ?? "error", note: String(body.message ?? "").slice(0, 160) };
        else {
          const resp = body.response ?? {};
          // The engine's response carries columns (names), rows (objects keyed by column, in display order) and text (lines) at the top level.
          const columns = Array.isArray(resp.columns) ? (resp.columns as unknown[]).filter((c): c is string => typeof c === "string") : [];
          const rowsOut = Array.isArray(resp.rows) ? (resp.rows as Record<string, unknown>[]) : null;
          const text = Array.isArray(resp.text) ? (resp.text as unknown[]).filter((t): t is string => typeof t === "string") : typeof resp.text === "string" ? [resp.text] : [];
          res = { id: r.id, status: classify(resp), kind: String(resp.kind ?? ""), ms: body.ms, digest: crypto.createHash("sha256").update(JSON.stringify(resp, noSql)).digest("hex").slice(0, 12),
            ...(rowsOut ? { rows: rowsOut.length } : {}), ...(resp.kind === "answer" && rowsOut ? { answer: { columns, rows: rowsOut.slice(0, 5000), text } } : {}),
            ...(resp.kind === "decline" ? { reason: String(resp.reason ?? ""), note: (text.join(" ") || String(resp.explanation ?? "")).slice(0, 400) } : {}) };
        }
      } catch (e) { res = { id: r.id, status: "service_error", kind: "unreachable", note: String((e as Error).message).slice(0, 160) }; }
    }
    fs.appendFileSync(out, JSON.stringify(res) + "\n");
  }
  console.log(`asked ${asked} questions; results in ${out}`);
}

/** `--compare cube-on.jsonl cube-off.jsonl`: the whole matrix run against a service with the cubes on and one with them off; every id whose status or digest differs is a difference (same build, so none is expected). */
function compare(a: string, b: string): void {
  const rows = new Map(readJsonl<Row>(MATRIX).map((r) => [r.id, r]));
  const off = new Map(readJsonl<Res>(b).map((r) => [r.id, r]));
  let same = 0, only = 0; const diffs: string[] = [];
  for (const x of readJsonl<Res>(a)) {
    const y = off.get(x.id); if (!y) { only++; continue; }
    if (x.status === "excluded") continue;
    if (x.status === y.status && x.digest === y.digest) same++;
    else diffs.push(`${x.id} ${rows.get(x.id)?.question ?? ""} :: on ${x.status}/${x.kind}/${x.digest ?? "-"} off ${y.status}/${y.kind}/${y.digest ?? "-"}`);
  }
  console.log(`compared: ${same} identical, ${diffs.length} different, ${only} only in the first file`);
  for (const d of diffs.slice(0, 200)) console.log(d);
  if (diffs.length) process.exitCode = 1;
}

function summary(path: string): void {
  const rows = new Map(readJsonl<Row>(MATRIX).map((r) => [r.id, r]));
  const res = readJsonl<Res>(path);
  const tally = (key: (r: Row) => string) => {
    const t = new Map<string, Record<string, number>>();
    for (const x of res) { const r = rows.get(x.id); if (!r) continue; const k = key(r); const c = t.get(k) ?? {}; c[x.status] = (c[x.status] ?? 0) + 1; t.set(k, c); }
    return [...t.entries()].sort().map(([k, c]) => { const a = c.answered ?? 0, d = c.declined ?? 0, e = c.excluded ?? 0, s = c.service_error ?? 0; const asked = a + d + s; return `${k.padEnd(34)} answered ${a}  declined ${d}  excluded ${e}  service_error ${s}  coverage ${asked ? Math.round((100 * a) / asked) : 0}%`; });
  };
  const all = res.reduce((c: Record<string, number>, x) => ((c[x.status] = (c[x.status] ?? 0) + 1), c), {});
  const asked = (all.answered ?? 0) + (all.declined ?? 0) + (all.service_error ?? 0);
  console.log(`TOTAL answered ${all.answered ?? 0}  declined ${all.declined ?? 0}  excluded ${all.excluded ?? 0}  service_error ${all.service_error ?? 0}  of ${readJsonl<Row>(MATRIX).length} combinations; coverage (answered / asked) ${asked ? ((100 * (all.answered ?? 0)) / asked).toFixed(1) : 0}%`);
  for (const [name, key] of [["scope", (r: Row) => r.scope], ["grain", (r: Row) => r.grain], ["family", (r: Row) => r.family], ["measure", (r: Row) => r.measure]] as const) { console.log(`\nby ${name}`); console.log(tally(key).join("\n")); }
  const reasons = new Map<string, number>();
  for (const x of res) if (x.status === "declined") reasons.set(`${x.reason ?? ""} | ${x.note ?? ""}`, (reasons.get(`${x.reason ?? ""} | ${x.note ?? ""}`) ?? 0) + 1);
  console.log("\ndecline reasons (count, reason | first words)"); for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`${String(v).padStart(6)}  ${k}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
