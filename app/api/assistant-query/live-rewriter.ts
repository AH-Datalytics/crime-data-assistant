/**
 * The model follow-up rewriter, live, for the local preview only (coordinator for Jeff, 2026-11-01: "the follow ups
 * still isn't great"). The engine's FollowUpRewriter is synchronous and reads a cache; this calls the same model with
 * the same prompt and settings (lib/nibrs-shadow/model-rewriter.ts, rw-1) and passes its answer through the same
 * guards (`guarded`), so a model rewrite comes back as a proposal ("Did you mean ...?") and runs only when confirmed.
 *
 * Spend is capped twice: a daily cap (ASSISTANT_MODEL_DAILY_USD, default $2), kept in a small file in the system's temp
 * folder, with each call's worst case reserved before it is sent (as scripts/fetch-model-rewrites.ts does); and a cap
 * of calls per client (the IP nginx saw) per day, in memory, bounded. At either cap the caller falls back to asking for the full question.
 * The model's own choices when it asks are kept (the engine's cached rewriter drops them, since there each would run
 * as a continuation): here each is checked by the same guards and shown as a proposal, and runs only when clicked.
 * The key is GEMINI_API_KEY from the server's environment: never sent to the page, printed or logged.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GENERATION, MODEL_ID, guarded, hybridRewriteAsync, meaningProblem, type ModelAnswer } from "@/lib/nibrs-shadow/model-rewriter";
import { RESPONSE_SCHEMA, SYSTEM_PROMPT, userPrompt } from "@/lib/nibrs-shadow/model-rewriter-prompt";
import { deterministicRewriter, type Rewrite } from "@/lib/nibrs-shadow/follow-up";

/** USD per million tokens (thinking billed as output), as scripts/fetch-model-rewrites.ts. */
const PRICE = { input: 0.75, output: 3.75 };
const DAILY_USD = Number(process.env.ASSISTANT_MODEL_DAILY_USD ?? "2");
const PER_CLIENT = 40; // model calls per client (its IP) per UTC day
const MAX_CLIENTS = 5000, MAX_ANSWERS = 500; // the maps below drop their oldest entries past these
const LEDGER = path.join(os.tmpdir(), "crime-data-assistant-model-spend.json");

type Ledger = { day: string; spent: number };
const today = () => new Date().toISOString().slice(0, 10);
function ledger(): Ledger {
  try {
    const l = JSON.parse(fs.readFileSync(LEDGER, "utf8")) as Ledger;
    if (l.day === today() && typeof l.spent === "number") return l;
  } catch { /* none yet, or unreadable: start the day at zero */ }
  return { day: today(), spent: 0 };
}
const add = (usd: number) => { const l = ledger(); l.spent = Math.max(0, l.spent + usd); fs.writeFileSync(LEDGER, JSON.stringify(l)); };

const calls = new Map<string, { day: string; n: number }>();
const answered = new Map<string, Rewrite | Choices>();
/** Set a key, dropping the oldest entries past `max` (a Map iterates in insertion order), so a caller cannot grow memory. */
function put<V>(m: Map<string, V>, k: string, v: V, max: number) {
  m.delete(k); m.set(k, v);
  while (m.size > max) m.delete(m.keys().next().value as string);
}

/** The model's question back with its own choices, each checked by the guards: shown as proposals, none run until clicked. */
export type Choices = { kind: "choices"; why: string; options: { label: string; question: string }[] };

/**
 * One call: the model's answer, or "cut" when it was cut off at the output cap (or did not parse); null when the call
 * failed. The worst case is reserved before it is sent and settled with the usage that comes back.
 */
async function call(key: string, prompt: string, cap: number): Promise<ModelAnswer | "cut" | null> {
  const worst = ((SYSTEM_PROMPT.length + prompt.length) / 2 * PRICE.input + cap * PRICE.output) / 1e6;
  if (ledger().spent + worst > DAILY_USD) throw new Error("capped");
  add(worst);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: GENERATION.temperature, maxOutputTokens: cap, responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA, thinkingConfig: { thinkingLevel: GENERATION.thinkingLevel } },
      }),
    });
    if (!res.ok) return null; // the worst case stays counted: its cost is unknown
    const j = (await res.json()) as { candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[]; usageMetadata?: Record<string, number> };
    const u = j.usageMetadata;
    if (u && typeof u.promptTokenCount === "number") {
      const cost = ((u.promptTokenCount ?? 0) * PRICE.input + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) * PRICE.output) / 1e6;
      add(cost - worst);
    }
    const raw = (j.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
    if (j.candidates?.[0]?.finishReason === "MAX_TOKENS") return "cut";
    try { return JSON.parse(raw) as ModelAnswer; } catch { return "cut"; }
  } catch {
    return null;
  }
}

const numbers = (s: string) => s.match(/\d[\d,.]*/g)?.map((n) => n.replace(/[,.]+$/, "").replace(/,/g, "")) ?? [];
/** The model's own choices that pass the engine's checks (no new number; the meaning of both questions kept). */
function checkedOptions(a: ModelAnswer, previous: string, followUp: string): Choices["options"] {
  const allowed = new Set([...numbers(previous), ...numbers(followUp)]);
  return (a.options ?? []).filter((o) => typeof o?.label === "string" && typeof o?.question === "string" && o.question.trim() && o.question.length <= 300
    && o.label.length <= 80 && numbers(o.question).every((n) => allowed.has(n)) && !meaningProblem(previous, followUp, o.question)).slice(0, 4);
}
/** The model's question back, only when it reads as one plain sentence (it sometimes spills its reasoning there). */
const plainWhy = (why: unknown) => (typeof why === "string" && why.trim().length <= 160 && !/\b(?:rule|wait|options?)\b/i.test(why) ? why.trim() : "Which of these do you mean?");

/**
 * A follow-up that names one year and little else ("show me 2023", "can I see 2022"): the model nearly always asks
 * whether it replaces the period or is added, but often without choices. The choices are then the deterministic
 * rewriter's own rewrites of "same for <year>" and "add <year>", each certain, shown as proposals.
 */
function yearChoices(previous: string, followUp: string): Choices | null {
  const years = followUp.match(/\b(?:19|20)\d{2}\b/g);
  if (years?.length !== 1 || followUp.trim().split(/\s+/).length > 6) return null;
  const y = years[0];
  const options = [{ label: `${y} instead`, follow: `same for ${y}` }, { label: `Add ${y}`, follow: `add ${y}` }].flatMap((o) => {
    const r = deterministicRewriter.rewrite(previous, o.follow);
    return r.kind === "rewrite" ? [{ label: o.label, question: r.question }] : [];
  });
  return options.length ? { kind: "choices", why: `Do you want ${y} instead, or added?`, options } : null;
}

/**
 * A follow-up through the engine's live hybrid (hybridRewriteAsync, #95): the deterministic rewriter first, its certain
 * rewrites run directly; where it asks, the model's answer through the same guards, as a proposal. This supplies the
 * model call, with the spending caps: called with the engine's larger output cap (for answers cut off at the smaller
 * one), and once more when the answer is cut off or is not usable (the model's answers vary). Where both ask, the
 * model's own checked choices, else "same for"/"add" a single year, are offered as proposals; at the daily or the
 * session cap, the question back asks for the full question. The client cap counts each call sent, retries included.
 * A fallback made when the model could not be reached (no key, a failed call) is not kept, so a later try asks again.
 */
export async function liveModelRewrite(previous: string, followUp: string, client: string): Promise<Rewrite | Choices> {
  const k = JSON.stringify([previous.trim(), followUp.trim()]);
  const known = answered.get(k);
  if (known) return known;
  let capped = false, failed = false, choices: Choices | null = null;
  const r = await hybridRewriteAsync(previous, followUp, async (p, f) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) { failed = true; return null; }
    const prompt = userPrompt(p, f);
    let last: ModelAnswer | null = null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const day = today(), c = calls.get(client); // one reading of the date, so midnight cannot fall between the two uses
        const used = c && c.day === day ? c.n : 0;
        if (used >= PER_CLIENT) { capped = true; return last; }
        put(calls, client, { day, n: used + 1 }, MAX_CLIENTS);
        // The engine's larger cap from the start: at the smaller one, low thinking often uses the whole budget.
        const a = await call(key, prompt, GENERATION.retryTruncatedMaxOutputTokens);
        if (!a) { failed = true; return last; }
        if (a === "cut") continue;
        last = a;
        if (a.kind === "ask") {
          const options = checkedOptions(a, p, f);
          if (options.length) { choices = { kind: "choices", why: plainWhy(a.why), options }; return a; }
          continue;
        }
        if (guarded(a, p, f).kind !== "ask") return a;
      }
    } catch (e) {
      if (e instanceof Error && e.message === "capped") capped = true;
      else failed = true;
      return null;
    }
    return last;
  });
  if (r.kind !== "ask") { put(answered, k, r, MAX_ANSWERS); return r; }
  if (capped) return { ...r, why: "Please ask the full question, with the crime, the place and the years." };
  const out = choices ?? yearChoices(previous, followUp) ?? r;
  if (out !== r && !failed) put(answered, k, out, MAX_ANSWERS);
  return out;
}
