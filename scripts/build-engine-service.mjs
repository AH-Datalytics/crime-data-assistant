// Bundles the engine service (services/engine/main.ts and worker.ts) into services/engine/dist/{main,worker}.cjs with esbuild, so the server needs only node and a python with duckdb
// (no tsx, no type-checking at run time). Run from the repository root: node scripts/build-engine-service.mjs. The output folder is not committed.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("services/engine/dist", { recursive: true });
await build({
  entryPoints: { main: "services/engine/main.ts", worker: "services/engine/worker.ts" },
  outdir: "services/engine/dist",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outExtension: { ".js": ".cjs" },
  sourcemap: true,
  logLevel: "info",
});
