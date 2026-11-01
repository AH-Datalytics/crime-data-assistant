/**
 * The model follow-up rewriter, live, for the local preview only (coordinator for Jeff, 2026-11-01: "the follow ups
 * still isn't great"). The engine's FollowUpRewriter is synchronous and reads a cache; this calls the same model with
 * the same prompt and settings (lib/nibrs-shadow/model-rewriter.ts, rw-1) and passes its answer through the same
 * guards (`guarded`), so a model rewrite comes back as a proposal ("Did you mean ...?") and runs only when confirmed.
 *
 * Spend is capped twice: a daily cap (ASSISTANT_MODEL_DAILY_USD, default $2), kept in a small file in the system's temp
 * folder, with each call's worst case reserved before it is sent (as scripts/fetch-model-rewrites.ts does); and a cap
 * of calls per chat session, in memory. At either cap the caller falls back to asking for the full question.
 * The model's own choices when it asks are kept (the engine's cached rewriter drops them, since there each would run
 * as a continuation): here each is checked by the same guards and shown as a proposal, and runs only when clicked.
 * The key is GEMINI_API_KEY from the server's environment: never sent to the page, printed or logged.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GENERATION, MODEL_ID, guarded, meaningProblem, type ModelAnswer } from "@/lib/nibrs-shadow/model-rewriter";
import { RESPONSE_SCHEMA, SYSTEM_PROMPT, userPrompt } from "@/lib/nibrs-shadow/model-rewriter-prompt";
import { deterministicRewriter, type Rewrite } from "@/lib/nibrs-shadow/follow-up";

/** USD per million tokens (thinking billed as output), as scripts/fetch-model-rewrites.ts. */
const PRICE = { input: 0.75, output: 3.75 };
const DAILY_USD = Number(process.env.ASSISTANT_MODEL_DAILY_USD ?? "2");
const PER_SESSION = 20;
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

const calls = new Map<string, number>();
const answered = new Map<string, Rewrite | Choices>();

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
 * The model's guarded rewrite of a follow-up, or its question back with checked choices; "capped" when the daily or
 * the session cap is reached; null when the model can't help (no key, an error, a question back with no usable choice),
 * for the caller to keep the deterministic rewriter's question back. It is called with the engine's larger output cap
 * (for answers cut off at the smaller one), and once more when the answer is cut off or is a question back with no
 * usable choice (the model's answers vary).
 */
export async function liveModelRewrite(previous: string, followUp: string, session: string): Promise<Rewrite | Choices | "capped" | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const k = JSON.stringify([previous.trim(), followUp.trim()]);
  const known = answered.get(k);
  if (known) return known;
  const used = calls.get(session) ?? 0;
  if (used >= PER_SESSION) return "capped";
  calls.set(session, used + 1);
  const prompt = userPrompt(previous, followUp);
  let result: Rewrite | Choices | null = null;
  try {
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      // The engine's larger cap from the start: at the smaller one, low thinking often uses the whole budget.
      const a = await call(key, prompt, GENERATION.retryTruncatedMaxOutputTokens);
      if (!a) return null;
      if (a === "cut") continue;
      if (a.kind === "ask") {
        const options = checkedOptions(a, previous, followUp);
        if (options.length) result = { kind: "choices", why: plainWhy(a.why), options };
        continue;
      }
      const r = guarded(a, previous, followUp);
      if (r.kind !== "ask") result = r;
    }
  } catch (e) {
    if (e instanceof Error && e.message === "capped") return "capped";
    return null;
  }
  result ??= yearChoices(previous, followUp);
  if (result) answered.set(k, result);
  return result;
}
