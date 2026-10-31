/**
 * Fetches the model rewriter's answers into its cache (online; the scored run and the measurement then read the cache
 * offline). Each distinct (previous question, follow-up) pair is sent once, one request at a time; progress is saved
 * after every call. The budget is enforced before dispatch: each attempt reserves its worst case (its input, estimated
 * high, and the full output cap at the output price, thinking included), and is sent only if the spend so far plus that
 * reservation stays within the budget. Spend persists in the cache across resumes; a response without usage stops the
 * run (its cost would be unknown).
 *
 *   npx tsx scripts/fetch-model-rewrites.ts --pairs <pairs.json> [--budget 4.50] [--limit N]
 *
 * The key is GEMINI_API_KEY from the environment; it is never printed or written.
 */
import fs from "node:fs";
import path from "node:path";
import { bindingOf, cacheKey, GENERATION, MODEL_ID, type CacheEntry, type ModelAnswer, type RewriteCache } from "../lib/nibrs-shadow/model-rewriter";
import { RESPONSE_SCHEMA, SYSTEM_PROMPT, userPrompt } from "../lib/nibrs-shadow/model-rewriter-prompt";

const arg = (name: string, dflt?: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
export const CACHE_PATH = path.join(__dirname, `fixtures/answer-eval/model-rewrites/${MODEL_ID}.json`);
/** USD per million tokens until 2027-01-01 (thinking billed as output). */
export const PRICE = { input: 0.75, output: 3.75 };
export const costOf = (u: CacheEntry["usage"]) => (u.input * PRICE.input + (u.output + u.thinking) * PRICE.output) / 1e6;
/** An attempt's worst case: input estimated at one token per two characters, and the whole output cap. */
const worstCase = (previous: string, followUp: string, cap: number) => ((SYSTEM_PROMPT.length + userPrompt(previous, followUp).length) / 2 * PRICE.input + cap * PRICE.output) / 1e6;

type Store = RewriteCache & { spent: number };

async function call(previous: string, followUp: string, key: string, cap: number, reserve: () => boolean): Promise<Omit<CacheEntry, "previous" | "followUp"> & { billed: number }> {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: userPrompt(previous, followUp) }] }],
    generationConfig: { temperature: GENERATION.temperature, maxOutputTokens: cap, responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA, thinkingConfig: { thinkingLevel: GENERATION.thinkingLevel } },
  };
  for (let attempt = 0; ; attempt++) {
    if (!reserve()) throw new Error("BUDGET");
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 3) throw new Error(`HTTP ${res.status} after ${attempt + 1} attempts`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]; usageMetadata?: Record<string, number>; error?: { message?: string } };
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(j.error?.message ?? "").slice(0, 200)}`);
    const u = j.usageMetadata;
    if (!u || typeof u.promptTokenCount !== "number") throw new Error("USAGE: a response without usage; its cost is unknown");
    const raw = (j.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
    let answer: ModelAnswer | null = null;
    try { answer = JSON.parse(raw) as ModelAnswer; } catch { answer = null; }
    const usage = { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thinking: u.thoughtsTokenCount ?? 0 };
    return { answer, raw, usage, billed: costOf(usage) };
  }
}

async function main() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { console.error("GEMINI_API_KEY is not set in this process; stopping."); process.exit(2); }
  const pairs = JSON.parse(fs.readFileSync(arg("--pairs")!, "utf8")) as { previous: string; followUp: string }[];
  const budget = Number(arg("--budget", "4.50")), limit = Number(arg("--limit", "1000000"));
  const binding = bindingOf(SYSTEM_PROMPT);
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  const store: Store = fs.existsSync(CACHE_PATH) ? JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) : { binding, spent: 0, entries: {} };
  if (store.binding !== binding) { console.error("The cache on disk was made with another prompt, model or settings; stopping."); process.exit(3); }
  const save = () => fs.writeFileSync(CACHE_PATH, JSON.stringify(store, null, 1));
  // The first pass fetches what is not cached; --retry-truncated fetches once more, with the larger cap, the answers
  // that did not parse (cut off at the cap), each only once.
  const retry = process.argv.includes("--retry-truncated");
  const cap = retry ? GENERATION.retryTruncatedMaxOutputTokens : GENERATION.maxOutputTokens;
  const todo = [...new Map(pairs.map((p) => [cacheKey(p.previous, p.followUp), p])).entries()]
    .filter(([k]) => (retry ? !!store.entries[k] && !store.entries[k].answer && !store.entries[k].retried : !store.entries[k]));
  console.log(`pairs ${pairs.length}, distinct to fetch ${todo.length}, cached ${Object.keys(store.entries).length}, spent so far $${store.spent.toFixed(4)} of $${budget}`);
  let sent = 0;
  try {
    for (const [k, p] of todo) {
      if (sent >= limit) break;
      // Each attempt (retries included) is sent only if its worst case fits; one request at a time, so nothing is outstanding.
      const r = await call(p.previous, p.followUp, key, cap, () => store.spent + worstCase(p.previous, p.followUp, cap) <= budget);
      // A retry keeps the first attempt's usage in the total (both were billed).
      const first = store.entries[k];
      store.entries[k] = { previous: p.previous, followUp: p.followUp, answer: r.answer, raw: r.raw, usage: r.usage,
        ...(retry ? { retried: true, firstUsage: first.usage } : {}) };
      store.spent += r.billed; sent++;
      save();
      if (sent % 100 === 0) console.log(`${sent} sent, $${store.spent.toFixed(4)}`);
    }
  } catch (e) {
    save();
    const m = String(e instanceof Error ? e.message : e);
    console.log(m === "BUDGET" ? `stopped before the budget: $${store.spent.toFixed(4)} spent of $${budget}` : `stopped: ${m}`);
  }
  const all = Object.values(store.entries);
  const tok = all.reduce((t, e) => ({ input: t.input + e.usage.input, output: t.output + e.usage.output, thinking: t.thinking + e.usage.thinking }), { input: 0, output: 0, thinking: 0 });
  console.log(`sent ${sent}; cache ${all.length} entries (${all.filter((e) => !e.answer).length} unparsed); tokens in ${tok.input}, out ${tok.output}, thinking ${tok.thinking}; spent $${store.spent.toFixed(4)}`);
}

if (require.main === module) main().catch((e) => { console.error(String(e).replace(/key=[^&\s]+/gi, "key=REDACTED")); process.exit(1); });
