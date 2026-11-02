/**
 * A model-backed follow-up rewriter, tested in the shadow (Jeff 2026-10-31: "yes, we should at least test an ai
 * followup"; design: docs/superpowers/specs/2026-10-31-model-follow-up-rewriter.md, Codex design check applied). It
 * implements the same `FollowUpRewriter` as the deterministic baseline: the model only rewords; its question goes
 * through the normal reader, plan and delivery path, and it never produces a number, a plan or SQL.
 *
 * The interface is synchronous and the scored run must be reproducible offline, so the model's answers are fetched
 * once (scripts/fetch-model-rewrites.ts) into a cache bound to the exact prompt and settings, and read here. A pair with
 * no cached answer, a malformed answer, or an answer that fails a guard is asked about with no options: never a guess
 * (7b's rule 2). The model's own options are not used (each would be run as a continuation).
 */
import { createHash } from "node:crypto";
import { deterministicRewriter, PLACE_ASK, type FollowUpRewriter, type Rewrite } from "./follow-up";
import { readQuestion } from "./reading";

export const MODEL_ID = "gemini-3.8-flash";
export const PROMPT_VERSION = "rw-1";
export const GUARD_VERSION = "g-3";
/** The generation settings the cache is bound to (with the prompt's hash). */
// An answer cut off at the output cap (thinking counts toward it) is fetched once more with the larger cap.
export const GENERATION = { temperature: 0, maxOutputTokens: 512, retryTruncatedMaxOutputTokens: 2048, thinkingLevel: "low" } as const;

/** The model's answer, as its JSON schema allows. */
export type ModelAnswer = { kind: "rewrite" | "new" | "presentation" | "ask"; question?: string; why?: string; options?: { label: string; question: string }[] };
/** One cached call: the parsed answer (null when it did not parse), its token usage, and the raw text for audit. */
export type CacheEntry = { previous: string; followUp: string; answer: ModelAnswer | null; raw: string; usage: { input: number; output: number; thinking: number };
  /** Fetched again with the larger cap after the first answer was cut off; the first attempt's usage. */
  retried?: true; firstUsage?: { input: number; output: number; thinking: number } };
/** The cache: its binding (model, prompt hash, settings) and its entries. */
export type RewriteCache = { binding: string; entries: Record<string, CacheEntry> };

/** The binding of a cache to one experiment: the model, the prompt's exact text and the generation settings. */
export const bindingOf = (prompt: string) => createHash("sha256").update(JSON.stringify([MODEL_ID, PROMPT_VERSION, prompt, GENERATION])).digest("hex");
export const cacheKey = (previous: string, followUp: string) => createHash("sha256").update(JSON.stringify([previous.trim(), followUp.trim()])).digest("hex");

const ask = (why: string): Rewrite => ({ kind: "ask", why, options: [] });
const numbers = (s: string) => s.match(/\d[\d,.]*/g)?.map((n) => n.replace(/[,.]+$/, "").replace(/,/g, "")) ?? [];

/** What the reader finds in a question: each recognized concept's values, and the pre-pass flags that change the answer. */
function signature(q: string) {
  const l = readQuestion(q, 2026).ledger as ReturnType<typeof readQuestion>["ledger"] & { people?: unknown; quarter?: boolean; column?: string | null; combined?: boolean };
  const parts = l.parts.filter((p) => p.clause === 0);
  const by = new Map<string, Set<string>>();
  for (const p of parts) if (p.state === "recognized") (by.get(p.concept) ?? by.set(p.concept, new Set()).get(p.concept)!).add(String(p.value));
  const flags = JSON.stringify({ people: l.people ?? null, quarter: !!l.quarter, column: l.column ?? null });
  return { by, flags, unread: parts.some((p) => p.concept === "unrecognized"), combined: /\bcombined\b/i.test(q) };
}
/** The years a period value covers ("year:2024", "years:2023:2024", "range:2021:2024"). */
function years(values: Set<string> | undefined): Set<number> {
  const out = new Set<number>();
  for (const v of values ?? []) {
    const [kind, ...ys] = v.split(":");
    const n = ys.map(Number).filter((x) => x >= 1900 && x < 2100);
    if (kind === "range" && n.length === 2) for (let y = n[0]; y <= n[1]; y++) out.add(y); else n.forEach((y) => out.add(y));
  }
  return out;
}
let noFlags: string | null = null;
/** The flags of a question that sets none. */
const NO_FLAGS = () => (noFlags ??= signature("x").flags);
const same = (a: Set<string> | undefined, b: Set<string> | undefined) => (a?.size ?? 0) === (b?.size ?? 0) && [...(a ?? [])].every((x) => b?.has(x));
const ADDITIVE = /^(?:(?:ok(?:ay)?|now|then|so|please)\b[,\s]*)*(?:add|also|and|plus|as well as|compare(?:\s+(?:it|this|that))?(?:\s+(?:to|with))?|vs\.?|versus)\b/i;

/**
 * Why a model rewrite does not keep the meaning of the previous question and the follow-up, or null (structural, from
 * the reader; it catches the known ways of losing a part, it does not prove two questions mean the same).
 *   - every part the follow-up names is in the rewrite (a period's years included);
 *   - every part of the previous question the follow-up does not touch is kept exactly, and so are its flags (people,
 *     quarters, columns) when the follow-up sets none;
 *   - an additive or comparative follow-up keeps the previous places or years beside the new ones;
 *   - a place brought to a combined group is asked about;
 *   - the rewrite reads completely (no unread words).
 */
export function meaningProblem(previous: string, followUp: string, rewrite: string, opts: { exceptions?: boolean } = {}): string | null {
  const allow = opts.exceptions !== false;
  const P = signature(previous), F = signature(followUp), O = signature(rewrite);
  if (O.unread) return "the rewrite has words the reader does not read";
  if (P.combined && F.by.has("place")) return "a place brought to a combined group";
  // Exceptions, each from a correct rewrite the 60-row sort found blocked (Codex amendment check 4); no others.
  const pBy = JSON.parse(P.flags).people?.by, oBy = JSON.parse(O.flags).people?.by;
  // "by ethnicity instead" for arrests: the reader carries the person's breakdown in its people flag, its role kept.
  const peopleBreakdown = (v: string) => allow && !!pBy && !!oBy && oBy.attr === v && oBy.who === pBy.who && oBy.paired === pBy.paired;
  // "This is a count. Is it possible to show a rate?": the follow-up names the old statistic only as the contrast.
  const contrast = (c: string, v: string) => allow && ((c === "statistic" && v === "count") || (c === "unit" && v === "incidents"))
    && !!F.by.get("statistic")?.has("rate") && !!O.by.get("statistic")?.has("rate");
  let peopleChanged = false;
  for (const [c, vs] of F.by) {
    if (c === "period") {
      const oy = years(O.by.get("period"));
      if (![...years(vs)].every((y) => oy.has(y))) return "a year the follow-up names is missing";
      // "since 2019" runs through the latest data: a rewrite that ends at a fixed year cuts it short (hand checks g-1 #44, g-2 #8).
      if ([...vs].some((v) => v.startsWith("since:")) && ![...vs].every((v) => !v.startsWith("since:") || O.by.get("period")?.has(v))) return "a \"since\" period was given an end year";
      continue;
    }
    for (const v of vs) {
      if (O.by.get(c)?.has(v) || contrast(c, v)) continue;
      if (c === "breakdown" && peopleBreakdown(v)) { peopleChanged = true; continue; }
      return `the follow-up's ${c} (${v}) is missing`;
    }
  }
  // A relative period ("the year before") changes the period without naming one (coordinator, 2026-11-01).
  for (const [c, vs] of P.by) if (!F.by.has(c) && !same(vs, O.by.get(c)) && !(c === "period" && derivedYears(previous, followUp).length))
    return `the previous ${c} changed although the follow-up does not change it`;
  // "y/y % change": a percent change is read as a share with a change; allowed only for a follow-up that says percent.
  const percentChange = allow && /%|\bpercent/i.test(followUp) && O.by.has("change");
  for (const c of O.by.keys()) if (!P.by.has(c) && !F.by.has(c) && c !== "unit" && !(c === "share" && percentChange)) return `a ${c} neither question asked for`;
  const flagsWithout = (f: string) => JSON.stringify({ ...JSON.parse(f), people: { ...(JSON.parse(f).people ?? {}), by: null } });
  if (F.flags === NO_FLAGS() && (peopleChanged ? flagsWithout(O.flags) !== flagsWithout(P.flags) : O.flags !== P.flags))
    return "a breakdown, quarters or a column changed although the follow-up names none";
  if (F.flags !== NO_FLAGS()) {
    const f = JSON.parse(F.flags), o = JSON.parse(O.flags), none = JSON.parse(NO_FLAGS());
    for (const k of Object.keys(f)) if (JSON.stringify(f[k]) !== JSON.stringify(none[k]) && JSON.stringify(f[k]) !== JSON.stringify(o[k])) return `the follow-up's ${k} is not in the rewrite`;
  }
  if (ADDITIVE.test(followUp.trim())) {
    if (F.by.has("place") && ![...(P.by.get("place") ?? [])].every((v) => O.by.get("place")?.has(v))) return "an added place replaced the previous ones";
    if (F.by.has("period") && ![...years(P.by.get("period"))].every((y) => years(O.by.get("period")).has(y))) return "an added year replaced the previous period";
  }
  return null;
}

/** The model's answer as a Rewrite, after the guards; anything that fails a guard is asked about, with no options. */
export function guarded(a: ModelAnswer | null, previous: string, followUp: string): Rewrite {
  if (!a || typeof a !== "object" || !["rewrite", "new", "presentation", "ask"].includes(a.kind)) return ask(PLACE_ASK);
  if (a.kind === "ask") return ask(typeof a.why === "string" && a.why.trim() ? a.why.trim().slice(0, 300) : PLACE_ASK);
  // A complete question of its own: only when the baseline's whole-question check agrees, and then the follow-up itself.
  if (a.kind === "new") {
    const d = deterministicRewriter.rewrite(previous, followUp);
    return d.kind === "new" ? { ...d, how: `model ${MODEL_ID} (${PROMPT_VERSION}), new question confirmed by the baseline's check` } : ask("Whether this is a question of its own or a change to the previous one.");
  }
  // Presentation is the baseline's: only its supported wording keeps the data question (unread words could hold a data
  // change; Codex amendment check 4). A model's presentation reading is asked about.
  if (a.kind === "presentation") return ask("Which change to the chart or table is meant; ask the full question.");
  const q = a.question;
  if (typeof q !== "string" || !q.trim() || q.length > 300) return ask("The model's rewrite could not be used; ask the full question.");
  const allowed = new Set([...numbers(previous), ...numbers(followUp)]);
  // A relative period ("the year before", "three years earlier") names years the conversation doesn't: only years the
  // follow-up's own offset reaches from the previous question's years are allowed (coordinator, 2026-11-01; Codex
  // follow-up review 01.1: never a nearby guess).
  for (const y of derivedYears(previous, followUp)) allowed.add(String(y));
  if (numbers(q).some((n) => !allowed.has(n))) return ask("The rewrite named a number that is not in the conversation; ask the full question.");
  const problem = meaningProblem(previous, followUp, q);
  if (problem) return ask(`The rewrite was not used (${problem}); ask the full question.`);
  // P69 amendment (Jeff 2026-10-31): a model rewrite is proposed, never run before the user confirms it.
  return { kind: "propose", question: q.trim(), how: `model ${MODEL_ID} (${PROMPT_VERSION}), guards ${GUARD_VERSION}` };
}

/**
 * The hybrid (P69 amendment): the deterministic rewriter first, its certain rewrites run directly; where it asks, the
 * model's guarded answer (a proposal, or a new question the baseline's check confirms); where both ask, the baseline's
 * ask, with its options.
 */
export function hybridRewriter(model: FollowUpRewriter): FollowUpRewriter {
  return {
    rewrite(previous: string, followUp: string): Rewrite {
      const d = deterministicRewriter.rewrite(previous, followUp);
      if (d.kind !== "ask") return d;
      const m = model.rewrite(previous, followUp);
      return m.kind === "ask" ? d : m;
    },
  };
}

/** Words that make a period relative to the previous question's ("the year before", "the next year", "three years earlier"). */
const RELATIVE = /\b(?:before|after|previous|prior|following|next|earlier|later|back|ago)\b/i;
const OFFSET_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
/**
 * The years a relative-period follow-up can reach from the previous question's years: only for a follow-up about years
 * ("year" or "years" with before, after, previous, next, earlier, later, back or ago), and only as far as the offset it
 * names (a number or a number word; "the year before" is one). Every year from the previous years moved by that offset
 * to the previous years is allowed, so a span ("the three years before that") is too; nothing else.
 */
function derivedYears(previous: string, followUp: string): number[] {
  if (!/\byears?\b/i.test(followUp) || !RELATIVE.test(followUp)) return [];
  const ys = (previous.match(/\b(?:19|20)\d{2}\b/g) ?? []).map(Number);
  if (!ys.length) return [];
  const named = [...followUp.toLowerCase().matchAll(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/g)].map((m) => OFFSET_WORDS[m[1]] ?? Number(m[1]));
  const k = Math.max(1, ...named.filter((n) => n >= 1 && n <= 20));
  const out = new Set<number>();
  for (const y of ys) for (let d = -k; d <= k; d++) out.add(y + d);
  return [...out];
}

/**
 * The hybrid, live (coordinator, 2026-11-01): the deterministic rewriter first, its certain rewrites run directly;
 * where it asks, the model's answer through the same guards (a proposal, never run before the user confirms it). The
 * caller makes the model call with this module's prompt (model-rewriter-prompt.ts: SYSTEM_PROMPT, userPrompt,
 * RESPONSE_SCHEMA) and keeps its key and spending limits; `callModel` gives the model's JSON answer, or null when there
 * is none (a failure, a limit reached). Where both ask, the baseline's ask, with its options.
 */
export async function hybridRewriteAsync(previous: string, followUp: string,
  callModel: (previous: string, followUp: string) => Promise<unknown | null>): Promise<Rewrite> {
  const d = deterministicRewriter.rewrite(previous, followUp);
  if (d.kind !== "ask") return d;
  let answer: ModelAnswer | null = null;
  try { answer = (await callModel(previous, followUp)) as ModelAnswer | null; } catch { answer = null; }
  if (!answer) return d;
  const m = guarded(answer, previous, followUp);
  return m.kind === "ask" ? d : m;
}

/** The cached model rewriter: offline and synchronous, for a cache of this binding. A miss is asked about, and counted. */
export function cachedModelRewriter(cache: RewriteCache, binding: string): FollowUpRewriter & { misses: string[] } {
  if (cache.binding !== binding) throw new Error("The model-rewrite cache was made with another prompt, model or settings.");
  const misses: string[] = [];
  return {
    misses,
    rewrite(previous: string, followUp: string): Rewrite {
      const e = cache.entries[cacheKey(previous, followUp)];
      if (!e) { misses.push(`${previous} || ${followUp}`); return ask("No model answer is cached for this follow-up; ask the full question."); }
      return guarded(e.answer, previous, followUp);
    },
  };
}
