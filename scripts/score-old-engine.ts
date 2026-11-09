/**
 * Scoring gap 2 (Jeff 2026-11-08, option B): the old app's logged replies, scored by the same labels and bucket rules
 * as the engine (scripts/qlog-bucket.ts), beside the engine's outcomes on the same questions, per tab. Nothing is run:
 * no old app, no model calls. Each reply is what the old app version live at the time said, not today's old app.
 *
 *   npx tsx scripts/score-old-engine.ts --labels scripts/fixtures/answer-eval/qlog-labels.json \
 *     --extract <qlog_all.json> --replies <replies.json> --new <engine outcomes.jsonl> [--out-old <old outcomes.jsonl>]
 *
 * --extract: the query-log rows the labels were drafted from (id, tab, question, n, previous; draft-qlog-labels.py).
 * --replies: the same rows' replies, read from a copy of the query log, never the production file (id, ts, sql, rows,
 *   error, response, delivery_action, reason_code). Both stay outside the repo.
 * --new: an engine run's progress file (run-qlog-scorecard.ts --progress), e.g. dev's.
 *
 * A label stands for every logged row with its words (and, for a follow-up, the turn before); the old app is scored on
 * the latest of those rows. Its answers carry no table digest, so a right-source answer is unverified, never correct:
 * the comparison is on getting the kind of outcome right (correct + unverified) and on wrong answers.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { bucket, type Bucket, type Got, type Label } from "./qlog-bucket";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const need = (name: string) => arg(name) ?? (() => { throw new Error(`${name} is required`); })();

// The label ids, as draft-qlog-labels.py makes them.
const norm = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean).join(" ").replace(/[?.! ]+$/, "");
const qhash = (q: string) => createHash("sha256").update(norm(q), "utf8").digest("hex").slice(0, 10);
const SHORT: Record<string, string> = { historical: "hist", current: "ct", nibrs: "nibrs", shr: "shr", hate_crime: "hc" };
export function labelId(r: { tab: string; question: string; n?: number; previous?: string | null }): string | null {
  const short = SHORT[r.tab];
  const q = (r.question ?? "").trim();
  if (!short || !q) return null;
  if (r.n === 1 || !r.previous) return `QL-${short}-${qhash(q)}`;
  return `QL-${short}-${qhash(r.previous.trim()).slice(0, 5)}${qhash(q).slice(0, 5)}`;
}

const TAB_SOURCE: Record<string, string> = { historical: "historical", current: "rtci", nibrs: "nibrs", shr: "shr", hate_crime: "hate_crime" };
export type Reply = { tab: string; sql?: string | null; rows?: number | null; error?: string | null; response?: string | null; delivery_action?: string | null; reason_code?: string | null };

/** What a clarifying reply asks about, in the labels' words; "unclassified" when its words name no part. */
export function oldAbout(text: string): string {
  const t = text.toLowerCase();
  // Which of two places one name means ("Say Washington, DC or Washington state", "Kansas City can mean Missouri or
  // Kansas", "Cook County exists in multiple states", "For Alameda County, do you want the countywide total ..."): the
  // labels' "which <name>" question.
  if (/^(?:say|use|choose)\b[^.?]*\bor\b|\bcan mean\b|\busually needs\b|\bexists in (?:multiple|several|more than one)\b|^for [a-z .'-]+ (?:county|parish), do you want\b/.test(t)) return "which";
  if (/\bvictims?\b[^.?]*\boffenders?\b|\boffenders?\b[^.?]*\bvictims?\b/.test(t)) return "victims or offenders";
  if (/\bwhich\s+(?:city|cities|state|states|county|counties|agency|agencies|place|location|jurisdiction|area|police department)\b|\bwhat\s+(?:city|state|county|location|area|jurisdiction|agency)\b|\bwhere\b/.test(t)) return "place";
  if (/\bviolent\b[^.?]*\bproperty\b|\bproperty\b[^.?]*\bviolent\b/.test(t)) return "violent, property or both";
  if (/\bwhich\s+(?:years?|time period|period|months?|date range)\b|\bwhat\s+(?:years?|time period|period|date range|timeframe|time frame)\b|\bwhen\b/.test(t)) return "period";
  if (/\bwhich\s+(?:crimes?|offenses?|type of crime|types of crime|kind of crime|measure)\b|\bwhat\s+(?:crimes?|offenses?|type of crime|kind of crime)\b/.test(t)) return "crime";
  return "unclassified";
}
// A reply that asks (the old app's clarifying questions, as logged): "I need to clarify ...", "I need clarification",
// "do you want ...", "Say X or Y", "X can mean ...", "There are two common definitions ...".
const ASKS = /\b(?:need (?:to clarify|(?:some |one more )?clarification)|could you (?:clarify|specify|tell me)|please (?:clarify|specify)|do you (?:mean|want)|did you mean|which (?:one|of)|can you (?:clarify|specify)|can mean|usually needs|exists in (?:multiple|several|more than one)|there are two common definitions)\b|^(?:say|use|choose)\b[^.?]*\bor\b/i;
// "I could not generate a database query ... Please restate it", "I had trouble formatting my answer", "Sorry, I wasn't
// able to ...": the words weren't understood, the old app's "try asking another way" (the engine's reader decline).
const UNREAD = /^(?:i could not generate|i couldn'?t generate|i had trouble formatting|sorry, i wasn'?t able to)\b/i;

/** The old app's reply, in the label's terms (the engine's outcomes use the same shape: run-qlog-scorecard.ts got()). */
export function oldGot(r: Reply): Got {
  const a = r.delivery_action ?? "";
  const answer = (): Got => ({ kind: "answer", source: TAB_SOURCE[r.tab] ?? null, ms: 0 });
  if (a === "answer" || a === "answer_limited_scope") return answer();
  if (a === "clarify") return { kind: "clarify", source: null, about: oldAbout(r.response ?? ""), ms: 0 };
  if (a.startsWith("decline")) return { kind: "decline", source: null, reason: r.reason_code ?? a, ms: 0 };
  // Rows logged without the outcome columns (every row as of 2026-11-08): read from what was sent.
  if (r.sql && (r.rows ?? 0) > 0 && !r.error) return answer();
  const text = (r.response ?? "").trim();
  // A query that failed, or a failure with no query: the old app failed (the engine's "error").
  if (r.error) return { kind: "error", source: null, reason: String(r.error).slice(0, 120), ms: 0 };
  if (!r.sql && UNREAD.test(text)) return { kind: "decline", source: null, reason: "reader", ms: 0 };
  if (!r.sql && ASKS.test(text)) return { kind: "clarify", source: null, about: oldAbout(text), ms: 0 };
  // A query with no rows, or a reply without a query that asks nothing: nothing was answered.
  return { kind: "decline", source: null, reason: r.sql ? "no rows" : "text", ms: 0 };
}

// --------------------------------------------------------------------------------------------------------- run
if (require.main === module) {
  const labelFile = JSON.parse(fs.readFileSync(need("--labels"), "utf8")) as Label[] | { labels: Label[] };
  const labels = Array.isArray(labelFile) ? labelFile : labelFile.labels;
  const extract = JSON.parse(fs.readFileSync(need("--extract"), "utf8")) as { id: number; tab: string; question: string; n?: number; previous?: string | null }[];
  const replyRows = JSON.parse(fs.readFileSync(need("--replies"), "utf8")) as (Reply & { id: number; ts: number })[];
  const replies = new Map(replyRows.map((r) => [r.id, r]));
  const newOut = new Map<string, Got | null>();
  for (const line of fs.readFileSync(need("--new"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); newOut.set(r.id, r.got); } catch { /* a line cut short */ }
  }

  // The latest logged reply for each label.
  const latest = new Map<string, Reply & { id: number; ts: number }>();
  let noReply = 0;
  for (const x of extract) {
    const id = labelId(x);
    if (!id) continue;
    const r = replies.get(x.id);
    if (!r) { noReply++; continue; }
    const cur = latest.get(id);
    if (!cur || r.ts > cur.ts || (r.ts === cur.ts && r.id > cur.id)) latest.set(id, { ...r, tab: x.tab });
  }
  const oldOut = new Map([...latest].map(([id, r]) => [id, oldGot(r)]));
  const outOld = arg("--out-old");
  if (outOld) fs.writeFileSync(outOld, [...oldOut].map(([id, got]) => JSON.stringify({ id, got })).join("\n") + "\n");

  // The same questions for both: scored, undisputed labels the old app replied to and the engine ran.
  const same = labels.filter((l) => l.expected.outcome !== "exclude" && l.label.status !== "disputed" && oldOut.has(l.id) && newOut.has(l.id));
  const BUCKETS: Bucket[] = ["correct", "unverified", "wrong answer", "bad decline", "wrong clarify", "follow-up error", "error"];
  const TABS = ["historical", "current", "nibrs", "shr", "hate_crime"];
  const NAME: Record<string, string> = { historical: "Historical", current: "Current Trends", nibrs: "NIBRS", shr: "Homicide Reports", hate_crime: "Hate Crime" };
  const count = (ls: Label[], out: Map<string, Got | null>) => {
    const c = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
    for (const l of ls) { const b = bucket(l, out.get(l.id) ?? null); if (b !== "excluded") c[b]++; }
    return c;
  };
  console.log(`labels scored by both: ${same.length} (old app replies found for ${latest.size} labels; ${noReply} logged rows had no reply in the copy)`);
  console.log("Each old reply is what the old app version live at the time said (its latest logged reply per label), not today's old app.\n");
  console.log(`| Tab | Labels | ${BUCKETS.map((b) => `${b[0].toUpperCase() + b.slice(1)} (old / new)`).join(" | ")} | Right kind of outcome (old / new) | Flag |`);
  console.log(`|---|---|${BUCKETS.map(() => "---").join("|")}|---|---|`);
  const rowsAll: Label[] = [];
  for (const t of [...TABS, "all"]) {
    const ls = t === "all" ? rowsAll : same.filter((l) => l.tab === t);
    if (t !== "all") rowsAll.push(...ls);
    if (!ls.length) continue;
    const o = count(ls, oldOut), n = count(ls, newOut);
    const rightO = o.correct + o.unverified, rightN = n.correct + n.unverified;
    // Close: within 5 percentage points of the labels on getting the kind of outcome right; ahead: more right, or fewer wrong answers.
    const flag = rightO > rightN || o["wrong answer"] < n["wrong answer"] ? "OLD AHEAD" : (rightN - rightO) / ls.length <= 0.05 ? "close" : "";
    const name = t === "all" ? "**All**" : NAME[t];
    console.log(`| ${name} | ${ls.length} | ${BUCKETS.map((b) => `${o[b]} / ${n[b]}`).join(" | ")} | ${rightO} / ${rightN} | ${flag} |`);
  }
  const unclassified = same.filter((l) => oldOut.get(l.id)?.kind === "clarify" && oldOut.get(l.id)?.about === "unclassified").length;
  console.log(`\nold clarifies whose words name no part (scored as asking about something else): ${unclassified}`);
  const why = new Map<string, number>();
  for (const l of same) { const g = oldOut.get(l.id)!; const k = `${g.kind}${g.kind === "decline" ? `:${g.reason}` : ""}`; why.set(k, (why.get(k) ?? 0) + 1); }
  console.log("old outcomes:", JSON.stringify(Object.fromEntries([...why].sort())));
}
