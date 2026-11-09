/**
 * Fetches the Gemini reader's readings (plan 3, step 1) into a cache the scorecard then reads offline
 * (run-qlog-scorecard.ts --gemini-readings). Only the logged questions that qualify are sent (gemini-reader.ts
 * qualifies(): the engine doesn't answer and the reader left words unread), each distinct question once, one request at
 * a time, progress saved after every call.
 *
 * Budget (Jeff, 2026-11-08: a $15 hard cap): each attempt reserves its worst case (its input estimated high, plus the
 * whole output cap at the output price) before it is sent, and is sent only if the spend so far, the unresolved
 * reservations and it stay within --budget. Spend and unresolved reservations persist across resumes; a response
 * without usage stops the run (its cost would be unknown). One attempt per question plus at most one retry (a rate
 * limit, a server error or a reply that doesn't parse).
 *
 *   npx tsx scripts/fetch-gemini-readings.ts --labels <qlog-labels.json> --baseline <dev outcomes.jsonl>
 *     --cache <path outside the repository> [--budget 15] [--limit N]
 *
 * --limit 10 is the cost test: its spend per question times the questions that qualify must project under the budget
 * before the full run. The key is GEMINI_API_KEY from the environment; it is never printed or written. The cache holds
 * question text, so it must be outside the repository.
 */
import fs from "node:fs";
import path from "node:path";
import { qualifies, READER_FOLLOW_UP_PROMPT, READER_GENERATION, READER_MODEL_ID, READER_RESPONSE_SCHEMA, READER_SYSTEM_PROMPT,
  readerBinding, readerFollowUpPrompt, readerKey, readerUserPrompt, type Reading } from "../lib/nibrs-shadow/gemini-reader";

const arg = (name: string, dflt?: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
/** USD per million tokens (the model rewriter's prices for the same model; thinking billed as output). */
export const PRICE = { input: 0.75, output: 3.75 };
type Usage = { input: number; output: number; thinking: number };
export const costOf = (u: Usage) => (u.input * PRICE.input + (u.output + u.thinking) * PRICE.output) / 1e6;
export type ReadingEntry = { question: string; previous: string | null; reading: Reading | null; raw: string; usage: Usage; attempts: number };
export type ReadingCache = { binding: string; spent: number; unresolved: number; entries: Record<string, ReadingEntry> };
type Ask = { question: string; previous: string | null };

const system = (a: Ask) => (a.previous ? READER_FOLLOW_UP_PROMPT : READER_SYSTEM_PROMPT);
const user = (a: Ask) => (a.previous ? readerFollowUpPrompt(a.previous, a.question) : readerUserPrompt(a.question));
/** An attempt's worst case: input at one token per two characters (high), and the whole output cap. */
const worstCase = (a: Ask) => ((system(a).length + JSON.stringify(READER_RESPONSE_SCHEMA).length + user(a).length) / 2 * PRICE.input + READER_GENERATION.maxOutputTokens * PRICE.output) / 1e6;

async function once(a: Ask, key: string): Promise<{ retry: boolean; reading: Reading | null; raw: string; usage: Usage | null; error?: string }> {
  const body = {
    systemInstruction: { parts: [{ text: system(a) }] },
    contents: [{ role: "user", parts: [{ text: user(a) }] }],
    generationConfig: { temperature: READER_GENERATION.temperature, maxOutputTokens: READER_GENERATION.maxOutputTokens, responseMimeType: "application/json",
      responseSchema: READER_RESPONSE_SCHEMA, thinkingConfig: { thinkingLevel: READER_GENERATION.thinkingLevel } },
  };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${READER_MODEL_ID}:generateContent`, {
    method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) });
  if (res.status === 429 || res.status >= 500) return { retry: true, reading: null, raw: "", usage: null, error: `HTTP ${res.status}` };
  const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]; usageMetadata?: Record<string, number>; error?: { message?: string } };
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(j.error?.message ?? "").slice(0, 200)}`);
  const u = j.usageMetadata;
  if (!u || typeof u.promptTokenCount !== "number") throw new Error("USAGE: a response without usage; its cost is unknown");
  const usage = { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thinking: u.thoughtsTokenCount ?? 0 };
  const raw = (j.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
  let reading: Reading | null = null;
  try { reading = JSON.parse(raw) as Reading; } catch { reading = null; }
  return { retry: !reading, reading, raw, usage };
}

async function main() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { console.error("GEMINI_API_KEY is not set in this process; stopping."); process.exit(2); }
  const cachePath = arg("--cache");
  const rel = cachePath ? path.relative(path.resolve(__dirname, ".."), path.resolve(cachePath)) : "";
  if (!cachePath || !(rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel))) { console.error("--cache must be a path outside the repository; stopping."); process.exit(4); }
  const budget = Number(arg("--budget", "15")), limit = Number(arg("--limit", "1000000"));
  if (!(budget > 0 && budget <= 15)) { console.error("--budget must be more than 0 and at most 15 (the approved cap); stopping."); process.exit(5); }
  const labelFile = JSON.parse(fs.readFileSync(arg("--labels")!, "utf8"));
  const labels = (Array.isArray(labelFile) ? labelFile : labelFile.labels) as { id: string; kind: string; question: string; previous: string | null; expected: { outcome: string } }[];
  const base = new Map<string, { kind: string; about?: string }>();
  for (const line of fs.readFileSync(arg("--baseline")!, "utf8").split("\n")) { if (line.trim()) try { const r = JSON.parse(line); base.set(r.id, r.got); } catch { /* cut short */ } }
  const year = new Date().getFullYear();
  const asks = new Map<string, Ask>();
  for (const l of labels) {
    const g = base.get(l.id);
    if (l.expected.outcome === "exclude" || !g) continue;
    const fu = l.kind === "follow-up" && !!l.previous;
    if (qualifies(l.question, g, fu, year)) asks.set(readerKey(l.question, fu ? l.previous : null), { question: l.question, previous: fu ? l.previous : null });
  }
  const binding = readerBinding();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const store: ReadingCache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : { binding, spent: 0, unresolved: 0, entries: {} };
  if (store.binding !== binding) { console.error("The cache on disk was made with another prompt, model or settings; stopping."); process.exit(3); }
  const save = () => fs.writeFileSync(cachePath, JSON.stringify(store, null, 1));
  const todo = [...asks].filter(([k]) => !store.entries[k]);
  console.log(`questions that qualify ${asks.size} (distinct), to fetch ${todo.length}, cached ${Object.keys(store.entries).length}; spent so far $${store.spent.toFixed(4)} (+ $${store.unresolved.toFixed(4)} unresolved) of $${budget}`);
  let sent = 0;
  try {
    for (const [k, a] of todo) {
      if (sent >= limit) break;
      const worst = worstCase(a);
      let last: Awaited<ReturnType<typeof once>> | null = null, usage: Usage = { input: 0, output: 0, thinking: 0 }, attempts = 0;
      for (; attempts < 2; ) {
        if (store.spent + store.unresolved + worst > budget) throw new Error("BUDGET");
        store.unresolved += worst; save();
        attempts++;
        last = await once(a, key);
        store.unresolved = Math.max(0, store.unresolved - worst);
        if (last.usage) { usage = { input: usage.input + last.usage.input, output: usage.output + last.usage.output, thinking: usage.thinking + last.usage.thinking }; store.spent += costOf(last.usage); }
        else store.unresolved += worst;   // no usage (a rate limit or server error): its cost stays reserved
        save();
        if (!last.retry) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      store.entries[k] = { question: a.question, previous: a.previous, reading: last!.reading, raw: last!.raw, usage, attempts };
      sent++; save();
      if (sent % 100 === 0) console.log(`${sent} sent, $${store.spent.toFixed(4)}`);
    }
  } catch (e) {
    save();
    const m = String(e instanceof Error ? e.message : e);
    console.log(m === "BUDGET" ? `stopped before the budget: $${store.spent.toFixed(4)} spent and $${store.unresolved.toFixed(4)} unresolved of $${budget}` : `stopped: ${m}`);
  }
  const all = Object.values(store.entries);
  const per = all.length ? store.spent / all.length : 0;
  console.log(`sent ${sent}; cache ${all.length} entries (${all.filter((e) => !e.reading).length} unparsed); spent $${store.spent.toFixed(4)}; $${per.toFixed(5)} per question; ` +
    `projected for all ${asks.size}: $${(per * asks.size).toFixed(2)} (budget $${budget})`);
}

if (require.main === module) main().catch((e) => { console.error(String(e).replace(/key=[^&\s]+/gi, "key=REDACTED")); process.exit(1); });
