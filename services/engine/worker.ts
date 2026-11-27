/**
 * One engine worker process: built once (services/engine/dist/worker.cjs by scripts/build-engine-service.mjs), forked by main.ts. Messages in: { id, req }; messages out:
 * { ready, info } once, then { id, result } for each request. It answers one request at a time (the engine is synchronous); the service kills it if it overruns.
 */
import { configFromEnv, createCore } from "../../lib/engine-service/core";
import type { EngineRequest, EngineResult } from "../../lib/engine-service/protocol";

const core = createCore(configFromEnv());
process.on("message", (m: { id: number; req: EngineRequest }) => {
  let result: EngineResult;
  try { result = core.answer(m.req); } catch (e) { result = { ok: false, kind: "error", message: `The engine worker failed: ${e instanceof Error ? e.message : String(e)}` }; }
  process.send?.({ id: m.id, result, info: core.info() }); // the info follows each answer: the release a source loaded is known only once it has answered
});
process.on("disconnect", () => { core.close(); process.exit(0); });
core.warm(); // the cube and DuckDB start, before the first question (slow-list f)
process.send?.({ ready: true, info: core.info() });
