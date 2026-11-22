/**
 * What one engine worker does: answer one request from a named source. Built the way the private preview route builds its dependencies (lib/nibrs-shadow/preview.ts is the shared
 * adapter), but with the executor capped (DuckDB memory limit and threads) and no clock-dependent "as of" beyond the date. A source (tab) that is not configured answers
 * "unavailable": stage 1 configures `nibrs` only; Current Trends, Historical, Homicide Reports and Hate Crime are added by giving them a root in the config.
 *
 * Reads, from the working directory (the release folder): scripts/fixtures/nibrs-shadow/{release,agencies,agency-names}.json, bound to the canonical release by its manifest.
 * The cubes come from the environment as the engine already reads them (NIBRS_CUBE=on|shadow with NIBRS_CUBE_SET and NIBRS_CUBE_SET_SHA256, or the four root variables).
 */
import path from "node:path";
import { cubeFromEnv } from "../nibrs-plan/cube";
import { duckdbExecutor, type DuckdbExecutor } from "../nibrs-shadow/duckdb";
import { shadowAnswer, shadowFollowUp, type ShadowDeps, type ShadowOutcome } from "../nibrs-shadow/answer";
import { asSourceTab, type SourceTab } from "../nibrs-shadow/source-description";
import { loadPlaceIndex } from "../nibrs-shadow/places";
import { follow, toPreview } from "../nibrs-shadow/preview";
import { loadNibrsRelease } from "../nibrs-shadow/release";
import type { EngineRequest, EngineResult } from "./protocol";
import { crimeIndexBuilder, hateBuilder, shrBuilder } from "./sources";

/** The data folders of the sources. `nibrs` is the base every question needs (the release, the places, the target); the others are added to it. */
export type SourceId = "nibrs" | "crimeIndex" | "shr" | "hate";
export type CoreConfig = {
  roots: Partial<Record<SourceId, string>>;
  python: string;
  releaseFile?: string;
  agenciesJson?: string;
  memoryLimit: string;
  threads: number;
  timeoutMs: number;
};

/** Which source holds each tab's data. Historical and Current share one Crime Index folder (one manifest). */
export const TAB_SOURCE: Record<SourceTab, SourceId> = { nibrs: "nibrs", historical: "crimeIndex", current: "crimeIndex", shr: "shr", hate_crime: "hate" };

export function configFromEnv(env: Record<string, string | undefined> = process.env): CoreConfig {
  const roots: CoreConfig["roots"] = {};
  if (env.ENGINE_NIBRS_ROOT) roots.nibrs = env.ENGINE_NIBRS_ROOT;
  if (env.ENGINE_CRIME_INDEX_ROOT) roots.crimeIndex = env.ENGINE_CRIME_INDEX_ROOT;
  if (env.ENGINE_SHR_ROOT) roots.shr = env.ENGINE_SHR_ROOT;
  if (env.ENGINE_HATE_ROOT) roots.hate = env.ENGINE_HATE_ROOT;
  const threads = Number(env.ENGINE_DUCKDB_THREADS ?? "1");
  return {
    roots, python: env.ENGINE_PYTHON ?? "python3",
    ...(env.ENGINE_RELEASE_FILE ? { releaseFile: env.ENGINE_RELEASE_FILE } : {}),
    memoryLimit: env.ENGINE_DUCKDB_MEMORY ?? "2GB", threads: Number.isInteger(threads) && threads >= 1 ? threads : 1, timeoutMs: Number(env.ENGINE_TIMEOUT_MS ?? "120000"),
  };
}

export type Core = { answer(req: EngineRequest): EngineResult; info(): Record<string, unknown>; close(): void };
/** What a source adds to the engine's dependencies, and the release id each of its tabs reports. */
export type SourceBuild = { deps: Partial<ShadowDeps>; releases: Partial<Record<SourceTab, string>> };
export type SourceBuilder = (root: string, ctx: { execute: ShadowDeps["execute"] }) => SourceBuild;
/** The builders for the sources besides nibrs; each source's own piece registers its builder here (lib/engine-service/sources.ts). Crime Index, Homicide Reports and Hate crime. */
export const SOURCE_BUILDERS: Partial<Record<Exclude<SourceId, "nibrs">, SourceBuilder>> = { crimeIndex: crimeIndexBuilder, shr: shrBuilder, hate: hateBuilder };
/** A source that failed to load is tried again no sooner than this. */
const RETRY_MS = 30_000;
/** Test seams: replace the engine call (an outcome for the question) so the adapter can be tested without data; supply source builders and a clock. */
export type CoreHooks = {
  answerOutcome?: (req: EngineRequest, deps: ShadowDeps) => ShadowOutcome | null;
  sources?: Partial<Record<Exclude<SourceId, "nibrs">, SourceBuilder>>;
  now?: () => number;
  /** Replaces loading the nibrs base from disk. */
  base?: () => { deps: Omit<ShadowDeps, "tab">; release: string };
};

/** Follow-ups #2: the whole question a reply answered or asked about. A first question is itself; a typed follow-up is its rewritten question, or the
 * previous question when the follow-up could not be read (so the next turn still has a whole question to change). */
export function askedOf(req: Pick<EngineRequest, "question" | "previous">, outcome: unknown): string {
  if (!req.previous) return req.question;
  const rewrite = (outcome as { rewrite?: unknown } | null)?.rewrite;
  return typeof rewrite === "string" && rewrite.trim() ? rewrite.trim() : req.previous;
}
export function createCore(cfg: CoreConfig, hooks: CoreHooks = {}): Core {
  const now = hooks.now ?? Date.now;
  const builders = { ...SOURCE_BUILDERS, ...hooks.sources };
  // One DuckDB executor for the whole worker, whatever the tab: memory is workers x the cap, not tabs x workers x the cap.
  let exec: DuckdbExecutor | null = null;
  // The base every question needs: the nibrs release, the places and the target. If it cannot load, no tab can answer.
  let base: { deps: Omit<ShadowDeps, "tab">; release: string } | null = null;
  // Each other source is built on its own: a failed one costs only its own tabs, and is tried again after a pause.
  const sources = new Map<string, { build: SourceBuild } | { error: string; at: number }>();

  function loadBase(): { deps: Omit<ShadowDeps, "tab">; release: string } {
    if (base) return base;
    if (hooks.base) return (base = hooks.base());
    const root = cfg.roots.nibrs;
    if (!root) throw new Error("no NIBRS folder is configured");
    const rel = loadNibrsRelease(cfg.releaseFile, root);
    exec ??= duckdbExecutor(cfg.python, { memoryLimit: cfg.memoryLimit, threads: cfg.threads, timeoutMs: cfg.timeoutMs });
    base = {
      release: rel.id,
      deps: {
        places: loadPlaceIndex(cfg.agenciesJson ?? path.join(process.cwd(), "scripts/fixtures/nibrs-shadow/agencies.json")),
        release: { id: rel.id, firstMonth: rel.firstMonth, lastMonth: rel.lastMonth, asOf: new Date().toISOString().slice(0, 10) },
        target: { root, builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] },
        execute: exec,
      },
    };
    return base;
  }
  /** What a source adds, or why it is not there. Tried once per pause when it failed. */
  function sourceFor(id: Exclude<SourceId, "nibrs">, b: { deps: Omit<ShadowDeps, "tab"> }): SourceBuild | string | null {
    const root = cfg.roots[id], builder = builders[id];
    if (!root || !builder) return null;
    const have = sources.get(id);
    if (have && "build" in have) return have.build;
    if (have && now() - have.at < RETRY_MS) return have.error;
    try {
      const build = builder(root, { execute: b.deps.execute });
      sources.set(id, { build });
      return build;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      sources.set(id, { error, at: now() });
      return error;
    }
  }
  /** Whether a tab has what it needs configured at all (a root for its source, and a builder if it is not nibrs). */
  const served = (tab: SourceTab) => !!cfg.roots.nibrs && (TAB_SOURCE[tab] === "nibrs" || (!!cfg.roots[TAB_SOURCE[tab]] && !!builders[TAB_SOURCE[tab] as Exclude<SourceId, "nibrs">]));

  /** The dependencies for a tab: the base plus every source that loaded (so a question on one tab can still read another's data, as the preview and the scorecard do), and the tab. */
  function depsFor(tabName: string): { deps: ShadowDeps; release: string } | { unavailable: string } {
    const tab = asSourceTab(tabName);
    if (!tab || !served(tab)) return { unavailable: "This source is not available from the engine yet." };
    let b: { deps: Omit<ShadowDeps, "tab">; release: string };
    try { b = loadBase(); } catch (e) { return { unavailable: `The engine could not load its data: ${e instanceof Error ? e.message : String(e)}` }; }
    let deps: ShadowDeps = { ...b.deps, tab };
    const releases: Partial<Record<SourceTab, string>> = {};
    const own = TAB_SOURCE[tab];
    let ownProblem: string | null = null;
    for (const id of ["crimeIndex", "shr", "hate"] as const) {
      const s = sourceFor(id, b);
      if (s === null) { if (id === own) ownProblem = "This source is not available from the engine yet."; continue; }
      if (typeof s === "string") { if (id === own) ownProblem = `This source could not be loaded: ${s}`; continue; }
      deps = { ...deps, ...s.deps, tab };
      Object.assign(releases, s.releases);
    }
    if (ownProblem) return { unavailable: ownProblem };
    return { deps, release: releases[tab] ?? b.release };
  }
  return {
    answer(req) {
      const b = depsFor(req.tab);
      if ("unavailable" in b) return { ok: false, kind: "unavailable", message: b.unavailable };
      try {
        // Timing is the service's business (its pool times each request); here only the answer.
        const outcome = hooks.answerOutcome
          ? hooks.answerOutcome(req, b.deps)
          : req.previous ? (shadowFollowUp(req.previous, req.question, b.deps) as ShadowOutcome) : shadowAnswer(req.question, b.deps);
        const at = outcome && follow(outcome, req.path);
        if (!at) return { ok: false, kind: "bad_request", message: "That button is no longer offered for this question." };
        // Follow-ups #2: the whole question asked, for the page to send back as the next turn's `previous` (a decline or an ask carries it too).
        const asked = askedOf(req, outcome);
        return { ok: true, response: toPreview(at, req.path, b.deps.places, req.question), ms: 0, release: b.release, sql: at.kind === "answer" ? at.sql : null, asked };
      } catch (e) {
        return { ok: false, kind: "error", message: `The engine failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
    info() {
      const cube = cubeFromEnv(process.env, cfg.roots.nibrs);
      const releases: Record<string, string> = {};
      // A live check tries every configured source (root set and builder registered) so it shows loaded or failed without a question first.
      // A failed source is not tried again inside its pause, so repeated checks cannot hammer a broken folder.
      let baseState: string | undefined;
      if (cfg.roots.nibrs) {
        try {
          const b = loadBase();
          baseState = "loaded";
          for (const id of ["crimeIndex", "shr", "hate"] as const) sourceFor(id, b);
        } catch (e) { baseState = `failed: ${e instanceof Error ? e.message : String(e)}`; }
      }
      if (base) releases.nibrs = base.release;
      const state: Record<string, string> = {};
      for (const [id, s] of sources) { state[id] = "build" in s ? "loaded" : `failed: ${s.error}`; if ("build" in s) Object.assign(releases, s.build.releases); }
      return { tabs: (["nibrs", "historical", "current", "shr", "hate_crime"] as const).filter(served), releases, ...(baseState ? { base: baseState } : {}), sources: state,
        cubes: { group: !!cube?.years.length, groupV4: !!cube?.groupV4, code: !!cube?.code, offense: !!cube?.offense, weapon: !!cube?.weapon }, memoryLimit: cfg.memoryLimit, threads: cfg.threads };
    },
    close() { try { exec?.close(); } catch { /* ending */ } exec = null; base = null; sources.clear(); },
  };
}

