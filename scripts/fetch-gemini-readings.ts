/**
 * Fetches the Gemini reader's proposals (plan 3, step 1) into a cache the scorecard then reads offline
 * (run-qlog-scorecard.ts --gemini-readings). Only the logged questions that qualify are sent (gemini-reader.ts
 * qualifies(): the engine doesn't answer, the decline is the reader's own, and the reader left words unread), each
 * distinct question once, one request at a time.
 *
 * Spending (Jeff, 2026-11-08: a $15 hard cap):
 *   - Each attempt reserves its worst case before it is sent: the input at one token per byte of everything sent (a
 *     token is never shorter than a byte), plus the output cap and the thinking allowance (gemini-reader.ts) at the output price. It is sent
 *     only if the spend so far, the unresolved reservations and it stay within --budget (at most 15).
 *   - A reservation is released when the attempt's usage comes back, or when the service answers with an HTTP error
 *     (429, 5xx: not billed); with no answer at all (a network failure, the 90 s timeout) it stays reserved, across
 *     resumes. A response that cost more than its reservation stops the run.
 *   - A request the service refuses outright (429 or any 5xx: not billed) doesn't count as an attempt: the run waits (15 s,
 *     doubling, at most 2 minutes) and tries again, and stops after six refusals in a row.
 *   - Each question has one attempt plus at most one retry, counted in the cache before each attempt is sent, so a
 *     resumed run never gives a question fresh attempts (Codex review 01.6).
 *   - The cost test comes first, enforced: until 10 questions are cached, a run sends at most 10. After it, a run goes
 *     on only if the spend, the unresolved reservations and the cost test's average times the questions left project
 *     within the budget (Codex review 01.7).
 *
 *   npx tsx scripts/fetch-gemini-readings.ts --labels <qlog-labels.json> --baseline <dev outcomes.jsonl>
 *     --cache <path outside the repository> [--budget 15] [--limit N]
 *
 * The key is GEMINI_API_KEY from the environment; it is never printed or written (error text is redacted). The cache
 * holds question text, so it must be outside the repository.
 */
import fs from "node:fs";
import path from "node:path";
import { qualifies, READER_FOLLOW_UP_PROMPT, READER_GENERATION, READER_MODEL_ID, READER_RESPONSE_SCHEMA, READER_SYSTEM_PROMPT,
  readerBinding, readerFollowUpPrompt, readerKey, readerUserPrompt, scrubPersonal, unreadSpans, type Proposal } from "../lib/nibrs-shadow/gemini-reader";

const arg = (name: string, dflt?: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
/** USD per million tokens (the model rewriter's prices for the same model; thinking billed as output). */
export const PRICE = { input: 0.75, output: 3.75 };
type Usage = { input: number; output: number; thinking: number };
export const costOf = (u: Usage) => (u.input * PRICE.input + (u.output + u.thinking) * PRICE.output) / 1e6;
export type ReadingEntry = { question: string; previous: string | null; proposal: Proposal | null; raw: string; usage: Usage; attempts: number; done: boolean };
export type ReadingCache = { binding: string; spent: number; unresolved: number; entries: Record<string, ReadingEntry> };
type Ask = { question: string; previous: string | null; unread: string[] };
const COST_TEST = 10;

const system = (a: Ask) => (a.previous ? READER_FOLLOW_UP_PROMPT : READER_SYSTEM_PROMPT);
const user = (a: Ask) => (a.previous ? readerFollowUpPrompt(a.previous, a.question, a.unread) : readerUserPrompt(a.question, a.unread));
const requestBody = (a: Ask) => ({
  systemInstruction: { parts: [{ text: system(a) }] },
  contents: [{ role: "user", parts: [{ text: user(a) }] }],
  generationConfig: { temperature: READER_GENERATION.temperature, maxOutputTokens: READER_GENERATION.maxOutputTokens, responseMimeType: "application/json",
    responseSchema: READER_RESPONSE_SCHEMA, thinkingConfig: { thinkingLevel: READER_GENERATION.thinkingLevel } },
});
/** An attempt's worst case: every byte sent as an input token, and the output cap plus the thinking allowance. */
export const worstCase = (a: Ask) => (Buffer.byteLength(JSON.stringify(requestBody(a)), "utf8") * PRICE.input
  + (READER_GENERATION.maxOutputTokens + READER_GENERATION.thinkingAllowance) * PRICE.output) / 1e6;
const redact = (s: string, key: string) => (key ? s.split(key).join("REDACTED") : s).replace(/key=[^&\s]+/gi, "key=REDACTED");

/**
 * One attempt. `billed`: false when the service answered with an HTTP error (it doesn't bill those), so the attempt's
 * reservation is released; null when no answer came back (a network failure or the 90 s timeout: it may have been
 * processed), so the reservation stays.
 */
async function once(a: Ask, key: string): Promise<{ retry: boolean; proposal: Proposal | null; raw: string; usage: Usage | null; billed?: false | null; error?: string }> {
  // A network failure ("fetch failed": a dropped connection, DNS, a reset; job J step 1, 2026-11-09) is an attempt whose
  // usage is unknown: its reservation stays, and it counts toward the one retry. Its cause is reported, redacted before
  // it is cut short (Codex review 04), never the request.
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${READER_MODEL_ID}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(requestBody(a)), signal: AbortSignal.timeout(90_000) });
  } catch (e) {
    const c = (e as { cause?: { code?: string; message?: string } }).cause;
    return { retry: true, proposal: null, raw: "", usage: null, billed: null, error: `network: ${redact(`${(e as Error).name} ${c?.code ?? ""} ${c?.message ?? (e as Error).message ?? ""}`, key).slice(0, 160)}` };
  }
  if (res.status === 429 || res.status >= 500) return { retry: true, proposal: null, raw: "", usage: null, billed: false, error: `HTTP ${res.status}` };
  let j: { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]; usageMetadata?: Record<string, number>; error?: { message?: string } };
  try { j = (await res.json()) as typeof j; }
  // A body cut off or not JSON: a fixed message (the parser's would quote the body).
  catch { return { retry: true, proposal: null, raw: "", usage: null, billed: null, error: `HTTP ${res.status}: the response was not JSON` }; }
  // The service's own error text can echo the request (question text): only the status is printed (Codex review 05).
  if (!res.ok) throw new Error(`HTTP ${res.status} (an error answer; its text is not printed)`);
  const u = j.usageMetadata;
  if (!u || typeof u.promptTokenCount !== "number") throw new Error("USAGE: a response without usage; its cost is unknown");
  const usage = { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thinking: u.thoughtsTokenCount ?? 0 };
  const raw = (j.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
  let proposal: Proposal | null = null;
  try { proposal = JSON.parse(raw) as Proposal; } catch { proposal = null; }
  return { retry: !proposal, proposal, raw, usage };
}

async function main() {
  const key = process.env.GEMINI_API_KEY ?? "";
  if (!key) { console.error("GEMINI_API_KEY is not set in this process; stopping."); process.exit(2); }
  const cachePath = arg("--cache");
  const rel = cachePath ? path.relative(path.resolve(__dirname, ".."), path.resolve(cachePath)) : "";
  if (!cachePath || !(rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel))) { console.error("--cache must be a path outside the repository; stopping."); process.exit(4); }
  const budget = Number(arg("--budget", "15"));
  if (!(budget > 0 && budget <= 15)) { console.error("--budget must be more than 0 and at most 15 (the approved cap); stopping."); process.exit(5); }
  const labelFile = JSON.parse(fs.readFileSync(arg("--labels")!, "utf8"));
  const labels = (Array.isArray(labelFile) ? labelFile : labelFile.labels) as { id: string; kind: string; question: string; previous: string | null; expected: { outcome: string } }[];
  const base = new Map<string, { kind: string; reason?: string }>();
  for (const line of fs.readFileSync(arg("--baseline")!, "utf8").split("\n")) { if (line.trim()) try { const r = JSON.parse(line); base.set(r.id, r.got); } catch { /* cut short */ } }
  const year = Number(arg("--year", String(new Date().getFullYear())));
  const asks = new Map<string, Ask>();
  for (const l of labels) {
    const g = base.get(l.id);
    if (l.expected.outcome === "exclude" || !g) continue;
    const fu = l.kind === "follow-up" && !!l.previous;
    // Personal details never leave the runner or reach the cache: everything below is the scrubbed text.
    const q = scrubPersonal(l.question), prev = fu ? scrubPersonal(l.previous!) : null;
    if (qualifies(q, g, year)) asks.set(readerKey(q, prev), { question: q, previous: prev, unread: unreadSpans(q, year) });
  }
  const binding = readerBinding();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const store: ReadingCache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : { binding, spent: 0, unresolved: 0, entries: {} };
  if (store.binding !== binding) { console.error("The cache on disk was made with another prompt, model or settings; stopping."); process.exit(3); }
  // A question whose two attempts are used up is done, answered or not (a run stopped mid-attempt could leave one
  // neither done nor retryable: job J step 1's third question).
  const save = () => fs.writeFileSync(cachePath, JSON.stringify(store, null, 1));
  let repaired = 0;
  for (const e of Object.values(store.entries)) if (!e.done && e.attempts >= 2) { e.done = true; repaired++; }
  if (repaired) save();   // saved at once, whatever happens next (Codex review 05)
  const done = () => Object.values(store.entries).filter((e) => e.done);
  const todo = [...asks].filter(([k]) => !store.entries[k]?.done && (store.entries[k]?.attempts ?? 0) < 2);
  // The cost test first; then the projection decides whether the rest may run.
  let limit = Number(arg("--limit", "1000000"));
  const pricedNow = done().filter((x) => x.usage.input > 0).length;
  if (pricedNow < COST_TEST) limit = Math.min(limit, COST_TEST - pricedNow);
  else {
    // The average over questions whose usage came back (a failed attempt has no price to average).
    const priced = done().filter((x) => x.usage.input > 0).length;
    if (!priced) { console.log("no question has a price yet; run the cost test again"); return; }
    const per = store.spent / priced;
    const projected = store.spent + store.unresolved + per * todo.length;
    console.log(`cost test: $${per.toFixed(5)} a question; projected total $${projected.toFixed(2)} (spent $${store.spent.toFixed(4)}, unresolved $${store.unresolved.toFixed(4)}, ${todo.length} left)`);
    if (projected > budget) { console.log(`the projection is over the $${budget} budget; stopping before any request.`); return; }
  }
  console.log(`questions that qualify ${asks.size} (distinct), left ${todo.length}, done ${done().length}; spent $${store.spent.toFixed(4)} (+ $${store.unresolved.toFixed(4)} unresolved) of $${budget}; this run sends at most ${Math.min(limit, todo.length)}`);
  let sent = 0, refusedInARow = 0;
  try {
    for (const [k, a] of todo) {
      if (sent >= limit) break;
      const worst = worstCase(a);
      const e: ReadingEntry = store.entries[k] ?? { question: a.question, previous: a.previous, proposal: null, raw: "", usage: { input: 0, output: 0, thinking: 0 }, attempts: 0, done: false };
      store.entries[k] = e;
      while (e.attempts < 2 && !e.done) {
        if (store.spent + store.unresolved + worst > budget) throw new Error("BUDGET");
        // Reserved and counted before it is sent.
        store.unresolved += worst; e.attempts++; save();
        const r = await once(a, key);
        if (r.error) console.log(`attempt ${e.attempts} failed: ${r.error}`);
        // The service refused it outright (429 or any 5xx: not billed, nothing reached the model): the attempt doesn't count,
        // and the run waits, longer each time, before trying again; refused six times running, the run stops (job J
        // step 1 rerun, 2026-11-09: 15 of 16 attempts were 503 or 429 and used up eight questions' attempts).
        if (r.billed === false) {
          store.unresolved = Math.max(0, store.unresolved - worst);
          e.attempts--; refusedInARow++; save();
          if (refusedInARow >= 6) throw new Error("REFUSED");
          const wait = Math.min(120, 15 * 2 ** (refusedInARow - 1));
          console.log(`the service refused it (${r.error}); waiting ${wait} s`);
          await new Promise((res) => setTimeout(res, wait * 1000));
          continue;
        }
        refusedInARow = 0;
        if (r.usage) {
          const cost = costOf(r.usage);
          store.unresolved = Math.max(0, store.unresolved - worst); store.spent += cost;
          e.usage = { input: e.usage.input + r.usage.input, output: e.usage.output + r.usage.output, thinking: e.usage.thinking + r.usage.thinking };
          if (cost > worst) { save(); throw new Error(`a response cost $${cost.toFixed(5)}, more than its reservation $${worst.toFixed(5)}`); }
        }
        e.proposal = r.proposal; e.raw = r.raw; e.done = !r.retry || e.attempts >= 2;
        save();
        if (!e.done) await new Promise((res) => setTimeout(res, 2000));
      }
      sent++;
      if (sent % 100 === 0) console.log(`${sent} sent, $${store.spent.toFixed(4)}`);
    }
  } catch (err) {
    save();
    const m = redact(String(err instanceof Error ? err.message : err), key);
    console.log(m === "BUDGET" ? `stopped before the budget: $${store.spent.toFixed(4)} spent and $${store.unresolved.toFixed(4)} unresolved of $${budget}`
      : m === "REFUSED" ? "stopped: the service refused six requests in a row (429/5xx, not billed); try later or check the key's quota" : `stopped: ${m}`);
  }
  const all = done();
  const pricedAll = all.filter((x) => x.usage.input > 0).length;
  const per = pricedAll ? store.spent / pricedAll : 0;
  console.log(`sent ${sent}; ${all.length} questions done (${all.filter((x) => !x.proposal).length} unparsed); spent $${store.spent.toFixed(4)} + $${store.unresolved.toFixed(4)} unresolved; ` +
    `$${per.toFixed(5)} a question; projected for all ${asks.size}: $${(store.spent + store.unresolved + per * (asks.size - all.length)).toFixed(2)} (budget $${budget})`);
}

if (require.main === module) main().catch((e) => { console.error(redact(String(e), process.env.GEMINI_API_KEY ?? "")); process.exit(1); });
