/**
 * The model follow-up rewriter, live, for the local preview only (coordinator for Jeff, 2026-11-01: "the follow ups
 * still isn't great"). The engine's FollowUpRewriter is synchronous and reads a cache; this calls the same model with
 * the same prompt and settings (lib/nibrs-shadow/model-rewriter.ts, rw-1) and passes its answer through the same
 * guards (`guarded`), so a model rewrite comes back as a proposal ("Did you mean ...?") and runs only when confirmed.
 *
 * Spend is capped twice: a daily cap (ASSISTANT_MODEL_DAILY_USD, default $2), kept in a small file in the system's temp
 * folder, with each call's worst case reserved before it is sent (as scripts/fetch-model-rewrites.ts does); and a cap
 * of calls per chat session, in memory. At either cap the caller falls back to asking for the full question.
 * The key is GEMINI_API_KEY from the server's environment: never sent to the page, printed or logged.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GENERATION, MODEL_ID, guarded, type ModelAnswer } from "@/lib/nibrs-shadow/model-rewriter";
import { RESPONSE_SCHEMA, SYSTEM_PROMPT, userPrompt } from "@/lib/nibrs-shadow/model-rewriter-prompt";
import type { Rewrite } from "@/lib/nibrs-shadow/follow-up";

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
const answered = new Map<string, Rewrite>();

/**
 * The model's guarded rewrite of a follow-up; "capped" when the daily or the session cap is reached; null when the model
 * can't be used (no key, an error, a timeout), for the caller to keep the deterministic rewriter's question back.
 */
export async function liveModelRewrite(previous: string, followUp: string, session: string): Promise<Rewrite | "capped" | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const k = JSON.stringify([previous.trim(), followUp.trim()]);
  const known = answered.get(k);
  if (known) return known;
  const used = calls.get(session) ?? 0;
  const prompt = userPrompt(previous, followUp);
  // The worst case: input at one token per two characters, and the whole output cap.
  const worst = ((SYSTEM_PROMPT.length + prompt.length) / 2 * PRICE.input + GENERATION.maxOutputTokens * PRICE.output) / 1e6;
  if (used >= PER_SESSION || ledger().spent + worst > DAILY_USD) return "capped";
  calls.set(session, used + 1);
  add(worst);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: GENERATION.temperature, maxOutputTokens: GENERATION.maxOutputTokens, responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA, thinkingConfig: { thinkingLevel: GENERATION.thinkingLevel } },
      }),
    });
    if (!res.ok) return null; // the worst case stays counted: its cost is unknown
    const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]; usageMetadata?: Record<string, number> };
    const u = j.usageMetadata;
    if (u && typeof u.promptTokenCount === "number") {
      const cost = ((u.promptTokenCount ?? 0) * PRICE.input + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) * PRICE.output) / 1e6;
      add(cost - worst);
    }
    const raw = (j.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
    let answer: ModelAnswer | null = null;
    try { answer = JSON.parse(raw) as ModelAnswer; } catch { answer = null; }
    const r = guarded(answer, previous, followUp);
    answered.set(k, r);
    return r;
  } catch {
    return null;
  }
}
