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
import { loadPlaceIndex } from "../nibrs-shadow/places";
import { follow, toPreview } from "../nibrs-shadow/preview";
import { loadNibrsRelease } from "../nibrs-shadow/release";
import type { EngineRequest, EngineResult } from "./protocol";

export type TabConfig = { root: string; python: string; releaseFile?: string; agenciesJson?: string };
export type CoreConfig = { tabs: Record<string, TabConfig>; memoryLimit: string; threads: number; timeoutMs: number };

export function configFromEnv(env: Record<string, string | undefined> = process.env): CoreConfig {
  const tabs: Record<string, TabConfig> = {};
  if (env.ENGINE_NIBRS_ROOT) tabs.nibrs = { root: env.ENGINE_NIBRS_ROOT, python: env.ENGINE_PYTHON ?? "python3", ...(env.ENGINE_RELEASE_FILE ? { releaseFile: env.ENGINE_RELEASE_FILE } : {}) };
  const threads = Number(env.ENGINE_DUCKDB_THREADS ?? "1");
  return { tabs, memoryLimit: env.ENGINE_DUCKDB_MEMORY ?? "2GB", threads: Number.isInteger(threads) && threads >= 1 ? threads : 1, timeoutMs: Number(env.ENGINE_TIMEOUT_MS ?? "120000") };
}

export type Core = { answer(req: EngineRequest): EngineResult; info(): Record<string, unknown>; close(): void };
/** Test seam: replaces the engine call (an outcome for the question) so the adapter can be tested without data. */
export type CoreHooks = { answerOutcome?: (req: EngineRequest, deps: ShadowDeps) => ShadowOutcome | null };

export function createCore(cfg: CoreConfig, hooks: CoreHooks = {}): Core {
  const built = new Map<string, { deps: ShadowDeps; exec: DuckdbExecutor; release: string }>();
  function depsFor(tab: string): { deps: ShadowDeps; release: string } | null {
    const t = cfg.tabs[tab];
    if (!t) return null;
    let b = built.get(tab);
    if (!b) {
      const rel = loadNibrsRelease(t.releaseFile, t.root);
      const exec = duckdbExecutor(t.python, { memoryLimit: cfg.memoryLimit, threads: cfg.threads, timeoutMs: cfg.timeoutMs });
      const deps: ShadowDeps = {
        places: loadPlaceIndex(t.agenciesJson ?? path.join(process.cwd(), "scripts/fixtures/nibrs-shadow/agencies.json")),
        release: { id: rel.id, firstMonth: rel.firstMonth, lastMonth: rel.lastMonth, asOf: new Date().toISOString().slice(0, 10) },
        target: { root: t.root, builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] },
        execute: exec,
      };
      b = { deps, exec, release: rel.id };
      built.set(tab, b);
    }
    return b;
  }
  return {
    answer(req) {
      const b = depsFor(req.tab);
      if (!b) return { ok: false, kind: "unavailable", message: "This source is not available from the engine yet." };
      try {
        // Timing is the service's business (its pool times each request); here only the answer.
        const outcome = hooks.answerOutcome
          ? hooks.answerOutcome(req, b.deps)
          : req.previous ? (shadowFollowUp(req.previous, req.question, b.deps) as ShadowOutcome) : shadowAnswer(req.question, b.deps);
        const at = outcome && follow(outcome, req.path);
        if (!at) return { ok: false, kind: "bad_request", message: "That button is no longer offered for this question." };
        return { ok: true, response: toPreview(at, req.path, b.deps.places, req.question), ms: 0, release: b.release, sql: at.kind === "answer" ? at.sql : null };
      } catch (e) {
        return { ok: false, kind: "error", message: `The engine failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
    info() {
      const cube = cubeFromEnv(process.env, cfg.tabs.nibrs?.root);
      return { tabs: Object.keys(cfg.tabs), releases: Object.fromEntries([...built].map(([k, v]) => [k, v.release])),
        cubes: { group: !!cube?.years.length, groupV4: !!cube?.groupV4, code: !!cube?.code, offense: !!cube?.offense, weapon: !!cube?.weapon }, memoryLimit: cfg.memoryLimit, threads: cfg.threads };
    },
    close() { for (const b of built.values()) { try { b.exec.close(); } catch { /* ending */ } } built.clear(); },
  };
}
