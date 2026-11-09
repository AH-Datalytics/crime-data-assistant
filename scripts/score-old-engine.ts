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

// The label ids, as draft-qlog-labels.py makes them. Python's str.split() and strip() whitespace, exactly (Codex
// gap-2 review 01.5: JavaScript's \s adds U+FEFF and misses U+001C-U+001F and U+0085).
const WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_WS = new RegExp(`[${WS}]+`), PY_EDGES = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");
const norm = (q: string) => q.toLowerCase().split(PY_WS).filter(Boolean).join(" ").replace(/[?.! ]+$/, "");
const qhash = (q: string) => createHash("sha256").update(norm(q), "utf8").digest("hex").slice(0, 10);
const pyStrip = (q: string) => q.replace(PY_EDGES, "");
const SHORT: Record<string, string> = { historical: "hist", current: "ct", nibrs: "nibrs", shr: "shr", hate_crime: "hc" };
export function labelId(r: { tab: string; question: string; n?: number; previous?: string | null }): string | null {
  const short = SHORT[r.tab];
  const q = pyStrip(r.question ?? "");
  if (!short || !q) return null;
  if (r.n === 1 || !r.previous) return `QL-${short}-${qhash(q)}`;
  return `QL-${short}-${qhash(pyStrip(r.previous)).slice(0, 5)}${qhash(q).slice(0, 5)}`;
}

const TAB_SOURCE: Record<string, string> = { historical: "historical", current: "rtci", nibrs: "nibrs", shr: "shr", hate_crime: "hate_crime" };
export type Reply = { tab: string; sql?: string | null; rows?: number | null; error?: string | null; response?: string | null; guardrails?: string | null; delivery_action?: string | null; reason_code?: string | null };

// Which of two places one name means ("Say Washington, DC or Washington state", "Kansas City can mean Missouri or
// Kansas", "Cook County exists in multiple states", "For Alameda County, do you want the countywide total ..."): the
// labels' "which <name>" question.
const WHICH_NAME = /^(?:say|use|choose)\b[^.?]*\bor\b|\bcan mean\b|\busually needs\b|\bexists in (?:multiple|several|more than one)\b|^for [a-z .'-]+ (?:county|parish), do you want\b|\bis ambiguous\b|\bmultiple (?:cities|counties|places|jurisdictions|agencies)\b|\bwhich (?:jurisdictions?|kansas city|baltimore|st\.? louis|portland|washington|new york)\b/i;
/** What a clarifying reply asks about, in the labels' words; "unclassified" when its words name no part. */
export function oldAbout(text: string): string {
  const t = text.toLowerCase();
  if (WHICH_NAME.test(t)) return "which";
  if (/\bvictims?\b[^.?]*\boffenders?\b|\boffenders?\b[^.?]*\bvictims?\b/.test(t)) return "victims or offenders";
  if (/\bwhich\s+(?:city|cities|state|states|county|counties|agency|agencies|place|location|jurisdiction|area|police department)\b|\bwhat\s+(?:city|state|county|location|area|jurisdiction|agency)\b|\bwhere\b/.test(t)) return "place";
  if (/\bviolent\b[^.?]*\bproperty\b|\bproperty\b[^.?]*\bviolent\b/.test(t)) return "violent, property or both";
  if (/\bwhich\s+(?:years?|time period|period|months?|date range)\b|\bwhat\s+(?:years?|time period|period|date range|timeframe|time frame)\b|\bwhen\b/.test(t)) return "period";
  if (/\bdefinitions? (?:of|for)\b|\bwhat you mean by\b|\bwhat metric\b|\bcrime type\b/.test(t)) return "crime";
  if (/\bwhich\s+(?:crimes?|offenses?|type of crime|types of crime|kind of crime|measure)\b|\bwhat\s+(?:crimes?|offenses?|type of crime|kind of crime)\b/.test(t)) return "crime";
  return "unclassified";
}
// A reply that asks for a missing part (the old app's clarifying questions, as logged): "I need to clarify ...", "I
// need clarification", "Did you mean ...", "There are two common definitions ...".
const ASKS = /\b(?:need (?:to clarify|(?:some |one more )?clarification)|could you (?:clarify|specify|tell me)|please (?:clarify|specify)|do you mean|did you mean|can you (?:clarify|specify)|there are two common definitions|need (?:a bit )?more detail)\b|^(?:your question is ambiguous|need clarification)\b/i;
// A short reply that is itself a question about the request ("Which year?", "What city did you mean?").
const QUESTION_ONLY = /^(?:which|what|do you|did you|should i)\b[^.!]{0,160}\?\s*$/i;
// "I could not generate a database query ... Please restate it", "I had trouble formatting my answer", "Sorry, I wasn't
// able to ...": the words weren't understood, the old app's "try asking another way" (the engine's reader decline).
const UNREAD = /^(?:i could not generate|i couldn'?t generate|i couldn'?t find a way|i had trouble formatting|sorry, i wasn'?t able to|```)/i;
// What the data doesn't have, said plainly: a decline even when it offers something else ("... Do you want X instead?").
const NOT_HELD = /\b(?:does not|doesn'?t|do not|don'?t|cannot|can'?t|isn'?t|is not|aren'?t|are not|unable to)\s+(?:track|contain|include|have|record|cover|support|calculate|provide|break|offer|report|available|tracked|recorded|included|in our)\b|\bnot (?:available|tracked|recorded|included|supported|in (?:our|the|this) (?:data|dataset|database))\b|\bonly (?:covers?|tracks?|contains?|includes?)\b|\b(?:returned|there are) no (?:results|rows|data)\b|\bnot track\b|\b(?:contains?|covers?|tracks?) (?:only )?(?:annual|monthly|reported crime|the 7 part i|a sample|crime data (?:from|only|through))\b|\b(?:annual|monthly) (?:crime )?data only\b|\bis not (?:one of|a separate)\b|\bnot yet available\b|^i can'?t (?:rank|answer)\b/i;
// The app's own failures (an execution error, or no valid query after its retries), as logged in `error`; any other
// value there is a guard's tag on a reply that was delivered (Codex gap-2 review 01.3: "contract_block:...",
// "empty_result", "nonfatal_shooting_refusal").
const FAILED = /^(?:DB:|Invalid\b|Validation\b|Cannot\b|attempt\b)|_failure\b/;

/**
 * The old app's reply, in the label's terms (the engine's outcomes use the same shape: run-qlog-scorecard.ts got()).
 * A reply none of the forms below fits is "unclassified": left out of both sides and counted, never guessed (Codex
 * gap-2 review 01.2).
 */
export function oldGot(r: Reply): Got {
  const a = r.delivery_action ?? "";
  const answer = (): Got => ({ kind: "answer", source: TAB_SOURCE[r.tab] ?? null, ms: 0 });
  const clarify = (about: string): Got => ({ kind: "clarify", source: null, about, ms: 0 });
  const decline = (reason: string): Got => ({ kind: "decline", source: null, reason, ms: 0 });
  if (a === "answer" || a === "answer_limited_scope") return answer();
  if (a === "clarify") return clarify(oldAbout(r.response ?? ""));
  if (a.startsWith("decline")) return decline(r.reason_code ?? a);
  // Rows logged without the outcome columns (every row as of 2026-11-08): read from what was sent.
  const text = (r.response ?? "").trim();
  const tags = (r.guardrails ?? "").replace(/^\[|\]$/g, "").split(/[,"\s]+/).filter(Boolean);
  if (r.error && FAILED.test(r.error)) return { kind: "error", source: null, reason: String(r.error).slice(0, 40), ms: 0 };
  if (r.sql && (r.rows ?? 0) > 0) return answer();
  // A plan the app answers without SQL (data completeness, deterministic shootings): an answer when it said something.
  if (!r.sql && text && tags.some((t) => /^completeness-deterministic$|^deterministic-/.test(t)) && !NOT_HELD.test(text)) return answer();
  // A source switch reruns the question elsewhere: its outcome isn't in this row.
  if (tags.includes("followup-source-switch")) return { kind: "unclassified", source: null, reason: "source switch", ms: 0 };
  // Which of two places a name means (the app's geo:* guards), or an ambiguous city or county.
  if ((tags.some((t) => t.startsWith("geo:")) || /^ambiguous_/.test(r.error ?? "")) && (WHICH_NAME.test(text) || /\?/.test(text))) return clarify("which");
  if (UNREAD.test(text)) return decline("reader");
  if (ASKS.test(text) || WHICH_NAME.test(text)) return clarify(oldAbout(text));
  if (r.sql) return decline("no rows");
  if (NOT_HELD.test(text) || tags.some((t) => /unsupported|unavailable|refusal|block/.test(t))) return decline("not held");
  if (QUESTION_ONLY.test(text)) return clarify(oldAbout(text));
  return { kind: "unclassified", source: null, reason: text ? "text" : "empty", ms: 0 };
}

// --------------------------------------------------------------------------------------------------------- run
if (require.main === module) {
  const labelFile = JSON.parse(fs.readFileSync(need("--labels"), "utf8")) as Label[] | { labels: Label[] };
  const labels = Array.isArray(labelFile) ? labelFile : labelFile.labels;
  const extract = JSON.parse(fs.readFileSync(need("--extract"), "utf8")) as { id: number; ts?: number; tab: string; question: string; n?: number; previous?: string | null }[];
  const replyRows = JSON.parse(fs.readFileSync(need("--replies"), "utf8")) as (Reply & { id: number; ts: number })[];
  const replies = new Map(replyRows.map((r) => [r.id, r]));
  const newOut = new Map<string, Got | null>();
  for (const line of fs.readFileSync(need("--new"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); newOut.set(r.id, r.got); } catch { /* a line cut short */ }
  }

  // Each label's latest logged row (by the log's own order, its id), then that row's reply. A label whose latest row has
  // no reply in the copy is left out of both sides and counted, never scored on an older reply (Codex gap-2 review
  // 01.4).
  const latestRow = new Map<string, (typeof extract)[number]>();
  for (const x of extract) {
    const id = labelId(x);
    if (id && (!latestRow.has(id) || x.id > latestRow.get(id)!.id)) latestRow.set(id, x);
  }
  const oldOut = new Map<string, Got>();
  let noReply = 0;
  for (const [id, x] of latestRow) {
    const r = replies.get(x.id);
    if (!r) { noReply++; continue; }
    oldOut.set(id, oldGot({ ...r, tab: x.tab }));
  }
  // The old outcomes, for a later look (outside the repo; never one of the inputs).
  const outOld = arg("--out-old");
  if (outOld) {
    const inputs = ["--labels", "--extract", "--replies", "--new"].map((f) => fs.realpathSync(need(f)));
    if (fs.existsSync(outOld) && inputs.includes(fs.realpathSync(outOld))) throw new Error("--out-old must not be one of the inputs");
    fs.writeFileSync(outOld, [...oldOut].map(([id, got]) => JSON.stringify({ id, got: { kind: got.kind, source: got.source, about: got.about, reason: got.kind === "error" ? "error" : got.reason } })).join("\n") + "\n");
  }

  // The same questions for both: scored, undisputed labels the old app's reply could be read for, that the engine ran.
  const scoredLabels = labels.filter((l) => l.expected.outcome !== "exclude" && l.label.status !== "disputed");
  const unread = scoredLabels.filter((l) => oldOut.get(l.id)?.kind === "unclassified");
  const same = scoredLabels.filter((l) => oldOut.has(l.id) && oldOut.get(l.id)!.kind !== "unclassified" && newOut.has(l.id));
  const BUCKETS: Bucket[] = ["correct", "unverified", "wrong answer", "bad decline", "wrong clarify", "follow-up error", "error"];
  const TABS = ["historical", "current", "nibrs", "shr", "hate_crime"];
  const NAME: Record<string, string> = { historical: "Historical", current: "Current Trends", nibrs: "NIBRS", shr: "Homicide Reports", hate_crime: "Hate Crime" };
  const count = (ls: Label[], out: Map<string, Got | null>) => {
    const c = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
    for (const l of ls) { const b = bucket(l, out.get(l.id) ?? null); if (b !== "excluded") c[b]++; }
    return c;
  };
  console.log(`labels scored by both: ${same.length}. Left out: ${unread.length} whose old reply fits no form (counted below), ${scoredLabels.filter((l) => !oldOut.has(l.id)).length} with no old reply in the copy (${noReply} labels' latest rows), ${scoredLabels.filter((l) => oldOut.has(l.id) && oldOut.get(l.id)!.kind !== "unclassified" && !newOut.has(l.id)).length} the engine didn't run.`);
  console.log("Each old reply is what the old app version live at the time said (each label's latest logged reply), not today's old app.");
  console.log("The old app's answers have no table digest, so a right-source answer is unverified, never correct: \"right kind of outcome\" (correct + unverified) is agreement on the kind of outcome and its source, not on the numbers.\n");
  console.log(`| Tab | Labels | ${BUCKETS.map((b) => `${b[0].toUpperCase() + b.slice(1)} (old / new)`).join(" | ")} | Right kind of outcome (old / new) | Flag |`);
  console.log(`|---|---|${BUCKETS.map(() => "---").join("|")}|---|---|`);
  const rowsAll: Label[] = [];
  for (const t of [...TABS, "all"]) {
    const ls = t === "all" ? rowsAll : same.filter((l) => l.tab === t);
    if (t !== "all") rowsAll.push(...ls);
    if (!ls.length) continue;
    const o = count(ls, oldOut), n = count(ls, newOut);
    const rightO = o.correct + o.unverified, rightN = n.correct + n.unverified;
    // Each flag names its basis (Codex gap-2 review 01.6): more right outcomes, fewer wrong answers, or close (within 5
    // percentage points of the labels on right outcomes).
    const flags = [rightO > rightN ? "old: more right outcomes" : (rightN - rightO) / ls.length <= 0.05 ? "close on right outcomes" : "",
      o["wrong answer"] < n["wrong answer"] ? "old: fewer wrong answers" : ""].filter(Boolean);
    const name = t === "all" ? "**All**" : NAME[t];
    console.log(`| ${name} | ${ls.length} | ${BUCKETS.map((b) => `${o[b]} / ${n[b]}`).join(" | ")} | ${rightO} / ${rightN} | ${flags.join("; ")} |`);
  }
  const unnamed = same.filter((l) => oldOut.get(l.id)?.kind === "clarify" && oldOut.get(l.id)?.about === "unclassified").length;
  console.log(`\nold clarifies whose words name no part (scored as asking about something else): ${unnamed}`);
  const why = new Map<string, number>();
  for (const l of [...same, ...unread]) { const g = oldOut.get(l.id)!; const k = `${g.kind}${g.kind === "decline" || g.kind === "unclassified" ? `:${g.reason}` : ""}`; why.set(k, (why.get(k) ?? 0) + 1); }
  console.log("old outcomes:", JSON.stringify(Object.fromEntries([...why].sort())));
  // The replies left out, by label id, for a person to read in the copy.
  if (process.argv.includes("--list-unclassified")) for (const l of unread) console.log(`unclassified\t${l.id}\t${oldOut.get(l.id)!.reason}`);
}
