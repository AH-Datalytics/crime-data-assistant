/**
 * OFFLINE EVIDENCE GUARD — deny real sources before the product modules are imported.
 *
 * WHY THIS EXISTS. Importing the guardrail, capability and disclosure modules pulls in
 * `lib/dynamic-facts.ts`, which runs `loadRtciFacts()` / `loadHistoricalFacts()` /
 * `loadNibrsFacts()` / `loadShrFacts()` AT MODULE LOAD. Those functions open the developer's
 * local `crime_data.db`, `shr.db` and NIBRS databases read-only and execute SELECTs to print
 * coverage lines. The Cause A proof originally said "nothing here queries them", which was
 * wrong: the reads happen whether or not an assertion depends on them.
 *
 * Each of those loaders wraps its work in try/catch and falls back to a fixed set of constants,
 * so denying the open is safe AND makes the importing suite deterministic on a machine that has
 * no local databases at all. The denial is counted, not hidden — `deniedDatabaseOpens()` reports
 * what was refused, and a suite that means to be source-free should print it.
 *
 * HOW TO USE IT. Import it FIRST, before any product module:
 *
 *     import { deniedDatabaseOpens, installOfflineEvidenceGuard } from "./offline-evidence-guard";
 *     installOfflineEvidenceGuard();
 *     import { applyResultDisclosures } from "../lib/result-disclosure";  // now isolated
 *
 * Import order is what makes this work; a guard installed after the product imports guards
 * nothing. `installOfflineEvidenceGuard()` is idempotent and is also called on import, so the
 * bare `import "./offline-evidence-guard";` placed first is enough.
 *
 * WHAT IT DOES NOT CLAIM. This blocks the paths the suites here actually use — better-sqlite3
 * file opens and the Node network entry points. It is not a sandbox, and it is not a substitute
 * for the product learning to start without touching a database.
 */

import Module from "module";

const deniedOpens: string[] = [];
const deniedNetwork: string[] = [];
let installed = false;

/** Databases opened in memory are fixtures, not sources, so they stay allowed. */
const isInMemory = (target: unknown) =>
  typeof target === "string" && (target === ":memory:" || target.startsWith("file::memory:"));

export function installOfflineEvidenceGuard(): void {
  if (installed) return;
  installed = true;

  // ── file-backed SQLite ──
  type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
  const loader = Module as unknown as { _load: Loader };
  const realLoad = loader._load;
  loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
    const loaded = realLoad.call(this, request, parent, isMain);
    if (request !== "better-sqlite3") return loaded;
    return new Proxy(loaded as new (...a: unknown[]) => object, {
      construct(target, args: unknown[]): object {
        if (!isInMemory(args[0])) {
          deniedOpens.push(String(args[0]));
          throw new Error("offline evidence guard: file-backed SQLite is not available to this suite");
        }
        return Reflect.construct(target, args) as object;
      },
    });
  };

  // ── network ──
  const refuse = (what: string) => () => {
    deniedNetwork.push(what);
    throw new Error(`offline evidence guard: ${what} is not available to this suite`);
  };
  for (const name of ["http", "https"] as const) {
    const mod = require(name) as { request: unknown; get: unknown };
    mod.request = refuse(`${name}.request`);
    mod.get = refuse(`${name}.get`);
  }
  (require("net") as { connect: unknown; createConnection: unknown }).connect = refuse("net.connect");
  (require("net") as { createConnection: unknown }).createConnection = refuse("net.createConnection");
  (require("tls") as { connect: unknown }).connect = refuse("tls.connect");
  (globalThis as { fetch?: unknown }).fetch = refuse("fetch");
}

/** Every file-backed database open this process asked for and did not get. */
export function deniedDatabaseOpens(): string[] {
  return [...deniedOpens];
}

/** Every network call this process attempted and did not get. */
export function deniedNetworkCalls(): string[] {
  return [...deniedNetwork];
}

installOfflineEvidenceGuard();
