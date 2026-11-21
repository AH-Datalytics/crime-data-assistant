/**
 * Stage 1 side-by-side (engine switch scope, section 5): runs the engine on the sample drawn by scripts/stage1-sample.py and writes ONE local page for Jeff: per question the old
 * answer as logged, the engine's answer, an automatic flag, and four buttons (old is right / new is right / both fine / both wrong), disagreements first. Nothing is sent anywhere:
 * the page is a file, its buttons keep their choices in the browser (localStorage) and "Copy choices" puts them on the clipboard as JSON.
 *
 *   npx tsx scripts/stage1-compare.ts --sample sample.json --out compare.html [--json compare.json] [--root <canonical>] [--release-file <release.json>] [--python <python with duckdb>]
 *     [--cube on]                       (the four cube roots come from NIBRS_CUBE_ROOT, NIBRS_CODE_CUBE_ROOT, NIBRS_OFFENSE_CUBE_ROOT, NIBRS_WEAPON_CUBE_ROOT)
 *
 * The automatic flag is a heuristic and says so: "numbers shared" when every number of three or more digits in the old reply also appears in the engine's table or text,
 * "numbers differ" otherwise, "new declines" / "new asks" when the engine did not answer. Data releases differ (the old app reads its own database); the page shows both release names.
 */
import fs from "node:fs";
import { shadowAnswer, shadowFollowUp, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { duckdbExecutor } from "../lib/nibrs-shadow/duckdb";
import { loadNibrsRelease } from "../lib/nibrs-shadow/release";
import { cubeFromEnv } from "../lib/nibrs-plan/cube";
import { toPreview } from "../lib/nibrs-shadow/preview";

const arg = (name: string, dflt?: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
type Old = { response: string; had_sql: boolean; rows: number | null; error: string | null };
type Item = { id: number; ts: number; question: string; previous: string | null; group: string; old: Old };
type Result = Item & { kind: string; seconds: number; text: string[]; columns: string[]; rowsOut: Record<string, string | number | null>[]; flag: string; buttons: string[] };

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const numbersOf = (s: string) => new Set((s.match(/\d[\d,]*\d|\d/g) ?? []).map((x) => x.replace(/,/g, "")).filter((x) => x.length >= 3 && !/^(19|20)\d\d$/.test(x)));

async function main(): Promise<void> {
  const sample = JSON.parse(fs.readFileSync(arg("--sample")!, "utf8")) as { sample: Item[]; tab: string };
  const root = arg("--root", "C:/Users/jeffm/nibrs-model/work/buildhost/test6-20261031/release/canonical")!;
  const python = arg("--python", "C:/Users/jeffm/nibrs-model/.venv/Scripts/python.exe")!;
  const { released: _r, ...release } = loadNibrsRelease(arg("--release-file"), root);
  const cube = arg("--cube", "off") === "on" ? cubeFromEnv({ ...process.env, NIBRS_CUBE: "on" }, root) : null;
  const exec = duckdbExecutor(python, { timeoutMs: 600_000 });
  const places = loadPlaceIndex();
  const deps = { places, release: { ...release, asOf: "2026-11-04" }, target: { root, builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026], cube }, execute: exec } as unknown as ShadowDeps;
  const results: Result[] = [];
  for (const it of sample.sample) {
    const t0 = performance.now();
    let kind = "error", text: string[] = [], columns: string[] = [], rowsOut: Result["rowsOut"] = [], buttons: string[] = [];
    try {
      const o = it.previous ? shadowFollowUp(it.previous, it.question, deps) : shadowAnswer(it.question, deps);
      const p = toPreview(o as never, [], places, it.question) as { kind: string; text?: string[]; columns?: string[]; rows?: Result["rowsOut"]; reason?: string; about?: string; buttons?: { label: string }[]; presentation?: { title?: string; lead?: string } };
      kind = p.kind;
      text = [p.presentation?.title, p.presentation?.lead, ...(p.text ?? []), p.reason, p.about].filter((x): x is string => typeof x === "string" && !!x);
      columns = p.columns ?? []; rowsOut = (p.rows ?? []).slice(0, 25); buttons = (p.buttons ?? []).map((b) => b.label);
    } catch (e) { text = [String(e instanceof Error ? e.message : e).slice(0, 200)]; }
    const seconds = Math.round((performance.now() - t0) / 100) / 10;
    const newText = text.join(" ") + " " + JSON.stringify(rowsOut);
    const oldNums = numbersOf(it.old.response), newNums = numbersOf(newText);
    const flag = kind === "decline" ? "new declines" : kind === "clarify" ? "new asks" : kind === "error" ? "new error"
      : oldNums.size === 0 ? "old gave no number" : [...oldNums].every((n) => newNums.has(n)) ? "numbers shared" : "numbers differ";
    results.push({ ...it, kind, seconds, text, columns, rowsOut, flag, buttons });
    console.error(`${it.id} ${kind} ${flag} ${seconds}s: ${it.question.slice(0, 60)}`);
  }
  exec.close();
  if (arg("--json")) fs.writeFileSync(arg("--json")!, JSON.stringify({ release: release.id, results }, null, 1));
  // Disagreements first: differing numbers, then new declines/asks/errors, then agreement.
  const rank = (f: string) => ({ "numbers differ": 0, "new declines": 1, "new asks": 2, "new error": 3, "old gave no number": 4, "numbers shared": 5 }[f] ?? 6);
  const ordered = [...results].sort((a, b) => rank(a.flag) - rank(b.flag) || a.id - b.id);
  const table = (r: Result) => r.columns.length ? `<table><tr>${r.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>${r.rowsOut.map((row) => `<tr>${r.columns.map((c) => `<td>${esc(String(row[c] ?? ""))}</td>`).join("")}</tr>`).join("")}</table>` : "";
  const card = (r: Result) => `<section id="q${r.id}"><h3>${esc(r.question)} <small>#${r.id}, ${new Date(r.ts).toISOString().slice(0, 10)}, ${esc(r.group)}${r.previous ? ", follow-up to: " + esc(r.previous) : ""}</small></h3>
<p class="flag f-${r.flag.replace(/\W+/g, "-")}">${esc(r.flag)}</p>
<div class="cols"><div><h4>Old app, as logged${r.old.error ? " (" + esc(r.old.error) + ")" : ""}</h4><pre>${esc(r.old.response)}</pre></div>
<div><h4>Engine: ${esc(r.kind)} (${r.seconds} s)</h4>${r.text.map((t) => `<p>${esc(t)}</p>`).join("")}${table(r)}${r.buttons.length ? `<p class="b">Offers: ${r.buttons.map(esc).join(" | ")}</p>` : ""}</div></div>
<p class="pick">${["old is right", "new is right", "both fine", "both wrong"].map((c) => `<label><input type="radio" name="p${r.id}" value="${c}"> ${c}</label>`).join(" ")}</p></section>`;
  const counts = Object.entries(results.reduce<Record<string, number>>((m, r) => (m[r.flag] = (m[r.flag] ?? 0) + 1, m), {})).map(([k, v]) => `${k}: ${v}`).join("; ");
  const html = `<!doctype html><meta charset="utf-8"><title>Stage 1: old app against engine</title>
<style>body{font:14px/1.45 system-ui,sans-serif;max-width:1100px;margin:1.5rem auto;padding:0 1rem;color:#111}section{border-top:2px solid #111;padding:.6rem 0}h3{margin:.2rem 0}h3 small{font-weight:400;color:#555}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:1rem}pre{white-space:pre-wrap;background:#f4f4f4;padding:.5rem}table{border-collapse:collapse;font-size:12px}td,th{border:1px solid #bbb;padding:2px 6px;text-align:left}
.flag{font-weight:700;margin:.2rem 0}.f-numbers-differ,.f-new-declines,.f-new-asks,.f-new-error{color:#a00}.pick label{margin-right:1rem}.b{color:#555}@media(max-width:800px){.cols{grid-template-columns:1fr}}</style>
<h1>Stage 1: old app against engine (${esc(sample.tab)})</h1>
<p>Engine release ${esc(release.id)}; the old app answered from its own database at the time it was asked. ${results.length} questions. ${esc(counts)}. The flag is a heuristic on numbers of three or more digits, not a verdict. Disagreements first.</p>
<p><button onclick="copyChoices()">Copy choices</button> <span id="saved"></span></p>
${ordered.map(card).join("\n")}
<script>
const K="stage1-choices";let st={};try{st=JSON.parse(localStorage.getItem(K)||"{}")}catch(e){}
document.querySelectorAll("input[type=radio]").forEach(i=>{if(st[i.name]===i.value)i.checked=true;i.onchange=()=>{st[i.name]=i.value;try{localStorage.setItem(K,JSON.stringify(st))}catch(e){}document.getElementById("saved").textContent=Object.keys(st).length+" chosen"}});
function copyChoices(){navigator.clipboard.writeText(JSON.stringify(st,null,1))}
</script>`;
  fs.writeFileSync(arg("--out")!, html);
  console.error(`wrote ${arg("--out")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
