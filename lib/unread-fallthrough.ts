/**
 * Option 2 stopgap (audit/presentation-2026-10-20/HOTFIX-UNREAD-PLAN.md; Codex ACCEPT WITH CLARIFICATION,
 * codex-hotfix-plan-ruling.md). A request whose ONLY recognition problem is words the question check could not read
 * (every refused part `not-interpreted`; at least one part) falls through to the pre-October-19 model query path and its
 * existing validators, instead of being refused. Everything that ran before the recognition gate, and every established
 * limitation, keeps precedence. Option 3 (the precise over-refusal repair) replaces this.
 *
 * One request-scoped context (AsyncLocalStorage, entered by each route's POST wrapper):
 *  - `eligible`: set at the recognition gate with the unread words (the refused parts' original text);
 *  - `attempted`: set when the request actually enters the model section. Only an ATTEMPTED request gets the note and
 *    the tag, so a clarification or limitation that happens before the model section is never labeled as a model answer.
 * The egress functions (jsonResp / sseEvent), the shared log writer and the proof finalizer read it, so every exit after
 * the attempt carries the note, the log row carries the tag, and the proof narrative matches what was delivered.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { containsInternalLeak } from "./scaffold-helpers";

type UnreadContext = { words: string[] | null; attempted: boolean; answeredRows: boolean };
const store = new AsyncLocalStorage<UnreadContext>();

export const UNREAD_FALLTHROUGH_TAG = "request-accounting:unread-fallthrough";

/** Runs one route request inside its own context. */
export function runWithUnreadContext<T>(fn: () => T): T {
  return store.run({ words: null, attempted: false, answeredRows: false }, fn);
}

/** The unread words when EVERY refused part is `not-interpreted` (and there is at least one); otherwise null. */
export function unreadOnlyWords(refusal: { parts: ReadonlyArray<{ state?: string; text: string }> } | null | undefined): string[] | null {
  if (!refusal || !Array.isArray(refusal.parts) || refusal.parts.length === 0) return null;
  if (!refusal.parts.every((p) => p.state === "not-interpreted")) return null;
  const words = [...new Set(refusal.parts.map((p) => String(p.text ?? "").trim()).filter(Boolean))];
  return words.length ? words : null;
}

export function markUnreadEligible(words: string[]): void {
  const s = store.getStore();
  if (s) s.words = words;
}

/** True when this request was found eligible at its recognition gate (the model-SQL permission for this request). */
export function unreadEligible(): boolean {
  return Boolean(store.getStore()?.words?.length);
}

/** Called where the request enters the model section; from here on every exit carries the note and the tag. */
export function markUnreadAttempted(): void {
  const s = store.getStore();
  if (s && s.words?.length) s.attempted = true;
}

/** The unread words when the request has entered the model section; otherwise null. */
export function unreadAttemptedWords(): string[] | null {
  const s = store.getStore();
  return s && s.attempted && s.words?.length ? s.words : null;
}

export function noteAnsweredRows(rows: unknown): void {
  const s = store.getStore();
  if (s && Array.isArray(rows) && rows.length > 0) s.answeredRows = true;
}

const WORD_LIMIT = 80;

/**
 * One unread phrase as inert display text (build ruling item 2). The notice is appended after the narrative firewall,
 * so the reader's own words must not be able to format: the chat page renders exactly two inline constructs,
 * `**bold**` and `[text](url)` (components/WorkspaceChatV2.tsx renderInlineMarkdown), and neither can form from what
 * this returns. Square brackets become parentheses and asterisk runs become one, so the words still read the same.
 */
export function inertWord(word: string): string {
  let t = String(word ?? "").replace(/["“”]/g, "'").replace(/\s+/g, " ").trim();
  t = t.replace(/\[/g, "(").replace(/\]/g, ")").replace(/\*{2,}/g, "*");
  if (t.length > WORD_LIMIT) t = `${t.slice(0, WORD_LIMIT - 1).trimEnd()}…`;
  return t;
}

/** The quoted words; when any of them trips the existing leak check, a neutral phrase is shown instead of all of them. */
function quoted(words: string[]): string {
  const shown = words.map(inertWord).filter(Boolean);
  if (shown.length === 0 || shown.some((w) => containsInternalLeak(w))) return "some of the words in the question";
  return shown.map((w) => `"${w}"`).join(", ");
}

/** The notice (Codex ruling item 4 wording). `answered` = the delivered result has data. */
export function unreadNote(words: string[], answered: boolean): string {
  const head = `Note: the question check did not understand ${quoted(words)}.`;
  return answered
    ? `${head} We used the general query path, which may not have applied those parts. The usual query safety checks still ran. Check that the answer matches your request.`
    : `${head} We tried the general query path; no answer was produced.`;
}

/** Appends the notice once to a user-visible text when this request was attempted through the fallback. */
export function withUnreadNote(text: string | null | undefined, answered?: boolean): string | null | undefined {
  const words = unreadAttemptedWords();
  if (!words) return text;
  const s = store.getStore()!;
  const ans = answered ?? s.answeredRows;
  const note = unreadNote(words, ans);
  const base = String(text ?? "");
  // Idempotent on the EXACT server-composed notice (build ruling item 2): prose that merely contains the opening phrase
  // cannot suppress it. A notice of the other variant (answered / not answered) is replaced by this one.
  const present = [unreadNote(words, true), unreadNote(words, false)].find((n) => base.includes(n));
  if (present === note) return base;
  const rest = (present ? base.replace(present, "") : base).trim();
  return rest ? `${rest}\n\n${note}` : note;
}

/** Adds the tag once to a guardrail list when this request was attempted through the fallback. */
export function withUnreadTag(tags: string[] | null | undefined): string[] | null | undefined {
  if (!unreadAttemptedWords()) return tags;
  const list = Array.isArray(tags) ? tags : [];
  return list.includes(UNREAD_FALLTHROUGH_TAG) ? list : [...list, UNREAD_FALLTHROUGH_TAG];
}
