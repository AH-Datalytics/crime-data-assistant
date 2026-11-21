/**
 * Offline probes of the cube router, shared by scripts/gen-cube-measure-checks.ts and scripts/test-cube-measure-guard.ts: a stand-in cube configuration that holds every offense code
 * and attribute (nothing is read: its roots do not exist), and a runner that asks the engine a question with an executor that only records the statements it is given. A question
 * "routes to a cube" when one of those statements reads a stand-in cube folder.
 */
import type { CubeConfig } from "../../lib/nibrs-plan/cube";

export function stand_in_cube(codes: string[], years: number[]): CubeConfig {
  const all = new Set(codes);
  return {
    root: "/stand-in/group", years, mode: "on", groupV4: true,
    code: { root: "/stand-in/code", years, codes: all, ethnicity: true },
    offense: { root: "/stand-in/offense", years, codes: all, attributes: ["incident_hour", "location_type", "clearance_type"] },
    weapon: { root: "/stand-in/weapon", years, codes: all, attributes: ["weapon", "firearm"] },
  };
}

/** Runs `ask` (which fills `statements` through its executor) and says whether a statement read a stand-in cube. A failure inside the engine after its statements were built is not a routing answer. */
export function routesToCube(ask: () => unknown, statements: string[]): boolean {
  statements.length = 0;
  try { ask(); } catch { /* the engine may stop on the empty rows the executor returns; the statements it built before that are what is inspected */ }
  return statements.some((s) => /\/stand-in\/(group|code|offense|weapon)\/canonical\/cube\/data_year=/.test(s));
}
