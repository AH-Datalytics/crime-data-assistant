/**
 * Stage 3b (plan r1.4 R4.2/R4.3, amendment A1): the scoped store of an INNER run of a route, and the hooks every shared
 * chokepoint calls. This module holds no client code of its own (lib/why-context.ts adds the client wrapper), so a route
 * that only reaches the capture hooks -- the log writers, the proof chokepoints, the chart audit -- reaches no model code.
 *
 * A "why" turn runs its data part by re-entering its own route inside `runInner(...)`:
 *   - mode "rebuild": the earlier question of a why-only turn. Model calls and cached model answers are BLOCKED before
 *     any invocation or read: the guard sets `blocked` and throws, and the outer turn gives the named decline.
 *   - mode "data": the live data part of a mixed turn. The model is allowed exactly as on any turn.
 * In both modes the inner run's admission checks and query-log writes are skipped (the outer request was admitted and
 * logs the turn once), and every finalization and emission is CAPTURED, never delivered.
 *
 * The store is set only here, by server code. No request field or header can set it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type InnerMode = "rebuild" | "data";
/**
 * Round 2 (plan r2.1 R2.4'): a producer's facts, recorded where the value is computed. A fact is PENDING until the next
 * emission, which takes it (the A1 matched pair), so a capture carries exactly the facts of the answer it emitted.
 * Keys identify what a fact describes, so the explainer selects the fact that matches the row it explains.
 */
/** How a producer formed its rates, recorded where it computes them (round 2: Current, Historical; round 3: NIBRS, SHR). */
export type RateMethod = "current-period" | "current-rolling" | "historical-annual"
  | "nibrs-agency-annual" | "nibrs-cohort-annual" | "nibrs-agency-rolling" | "nibrs-cohort-rolling" | "nibrs-clearance" | "nibrs-clearance-pooled"
  | "shr-agency-annual";
export type WhyFactKey ={ place: string | null; measure: string | null; period: string | null; dimension: string | null; unit: string | null };
export type WhyFact =
  | { kind: "breakdown"; key: WhyFactKey; denominator: number | null; overlap: boolean }
  | { kind: "rate"; method: RateMethod; per: number; places: string[] }
  | { kind: "group"; place: string; members: number; sample: number };
/** One emission of the inner run, paired with the finalization input that produced it (A1 clarification 1) and its facts. */
export type InnerCapture = { input: unknown | null; payload: Record<string, unknown>; facts: WhyFact[]; notes: string[] };
export type InnerStore = { mode: InnerMode; blocked: boolean; captures: InnerCapture[]; finalizations: WeakMap<object, unknown>; notes: string[]; pendingFacts: WhyFact[]; pendingNotes: string[] };

const store = new AsyncLocalStorage<InnerStore>();

/** Thrown by a guard inside a rebuild; the outer turn reads `blocked`, never this error's text. */
export class RebuildBlocked extends Error {
  constructor(what: string) { super(`rebuild blocked before ${what}`); this.name = "RebuildBlocked"; }
}

/** The current inner store, or null on an ordinary request. */
export function innerStore(): InnerStore | null {
  return store.getStore() ?? null;
}

/** True inside an inner run (either mode): skip admission checks and query-log writes. */
export function isInnerRun(): boolean {
  return store.getStore() !== undefined;
}

/**
 * Run `fn` as an inner run and wait for it to finish completely (the caller passes a function that consumes the whole
 * response, A1 clarification 2). Returns the store after the run.
 */
export async function runInner(mode: InnerMode, fn: () => Promise<void>): Promise<InnerStore> {
  const s: InnerStore = { mode, blocked: false, captures: [], finalizations: new WeakMap(), notes: [], pendingFacts: [], pendingNotes: [] };
  await store.run(s, fn);
  return s;
}

/** The guard: in a rebuild, mark the run blocked and throw BEFORE a model invocation or a cached-answer read. */
export function assertModelAllowed(what: "model invocation" | "cached model answer"): void {
  const s = store.getStore();
  if (s && s.mode === "rebuild") {
    s.blocked = true;
    throw new RebuildBlocked(what);
  }
}

/** A producer's answer-level notes as data (r1.3 producer addition); recorded only inside an inner run. */
export function recordWhyNotes(notes: string[] | undefined): void {
  const s = store.getStore();
  if (s && notes) { s.notes.push(...notes); s.pendingNotes.push(...notes); }
}

/** A producer fact (R2.4'), pending until the next emission takes it. A no-op outside an inner run. */
export function recordWhyFacts(...facts: WhyFact[]): void {
  const s = store.getStore();
  if (s) s.pendingFacts.push(...facts);
}

/**
 * R2.6': the outcome the carried exit logs is the CAPTURED inner site's own outcome (that site is inventoried). It never
 * defaults: a missing or unmatched input is not a carried success.
 */
export function carriedOutcome<T>(input: unknown): T {
  const o = input && typeof input === "object" ? (input as { outcome?: T }).outcome : undefined;
  if (o === undefined || o === null) throw new Error("carriedOutcome: no captured outcome to carry");
  return o;
}

/** Chokepoint hook (finalizeProof): remember which input produced this finalization. */
export function recordFinalization(finalization: object, input: unknown): void {
  const s = store.getStore();
  if (s) s.finalizations.set(finalization, input);
}

/** Chokepoint hook (emitFactualPayload): capture the emission with its own finalization input. */
export function recordEmission(finalization: object, payload: unknown): void {
  const s = store.getStore();
  if (s && payload && typeof payload === "object") {
    s.captures.push({ input: s.finalizations.get(finalization) ?? null, payload: payload as Record<string, unknown>, facts: s.pendingFacts, notes: s.pendingNotes });
    s.pendingFacts = []; s.pendingNotes = [];
  }
}

/** The data-bearing capture of an inner run: the LAST emission that carries rows or columns (a result), else the last. */
export function resultCapture(s: InnerStore): InnerCapture | null {
  for (let i = s.captures.length - 1; i >= 0; i -= 1) {
    const p = s.captures[i].payload;
    if (Array.isArray(p.rows) || Array.isArray(p.columns)) return s.captures[i];
  }
  return s.captures.length ? s.captures[s.captures.length - 1] : null;
}
