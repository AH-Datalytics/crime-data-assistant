/**
 * Operating-mode configuration for the verified-answer-only system.
 *
 * Source of truth: docs/superpowers/specs/2026-08-11-verified-answer-only-handoff.md
 * section 9.1.
 *
 *   off     - the proof system performs no request-path work and has no effect.
 *   shadow  - it observes and records hypothetical proof/delivery decisions but
 *             preserves existing user-visible behavior exactly.
 *   enforce - it may change delivery behavior, for the explicitly enabled
 *             source x family only.
 *
 * STAGE 0 SCOPE: configuration plumbing only. Nothing calls these yet. Stage 1
 * consults resolveMode() at the egress hook; until then every caller count is
 * zero and the effective mode everywhere is `off`.
 *
 * THE DEFAULT IS OFF AND FAILURE MOVES TOWARD OFF. Every unset, unparseable, or
 * unrecognized value resolves to `off` rather than to the more capable state.
 * A misconfigured deploy therefore loses the new machinery instead of silently
 * changing what users are told, which is the direction the contract requires
 * (handoff 3.14: no user-visible change until explicit approval).
 */

import { SOURCE_IDS, type SourceId } from "./proof-contract";

export type ProofMode = "off" | "shadow" | "enforce";

export const PROOF_MODES: readonly ProofMode[] = ["off", "shadow", "enforce"] as const;

/** Ordering used to clamp an override against the global ceiling. */
const MODE_RANK: Record<ProofMode, number> = { off: 0, shadow: 1, enforce: 2 };

export const DEFAULT_MODE: ProofMode = "off";

/**
 * Environment variables consulted. Named explicitly rather than built by string
 * concatenation so that grepping the repo for an env var finds its use site.
 */
export const ENV_KILL_SWITCH = "PROOF_KILL_SWITCH";
export const ENV_GLOBAL_MODE = "PROOF_MODE";
/** Per-source override, e.g. PROOF_MODE_NIBRS=shadow. */
export function envKeyForSource(sourceId: SourceId): string {
  return `PROOF_MODE_${sourceId.toUpperCase()}`;
}
/** Per-family override, e.g. PROOF_MODE_FAMILY_NIBRS_CLEARANCE_TYPE=enforce. */
export function envKeyForFamily(sourceId: SourceId, planFamily: string): string {
  const normalized = planFamily.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  return `PROOF_MODE_FAMILY_${sourceId.toUpperCase()}_${normalized}`;
}

/**
 * Parse a mode string. Anything unrecognized -- including empty string,
 * whitespace, mixed case garbage, or a typo like "enforced" -- yields `off`.
 * We do not throw: a bad value in production must degrade to no-op, not crash
 * the request path.
 */
export function parseMode(raw: string | undefined | null): ProofMode {
  if (typeof raw !== "string") return DEFAULT_MODE;
  const value = raw.trim().toLowerCase();
  return (PROOF_MODES as readonly string[]).includes(value) ? (value as ProofMode) : DEFAULT_MODE;
}

/** Truthy values for the kill switch. Anything else leaves it disengaged. */
export function parseKillSwitch(raw: string | undefined | null): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

export interface ModeEnv {
  [key: string]: string | undefined;
}

export interface ModeResolution {
  mode: ProofMode;
  /** Which configuration level decided the outcome, for logging and review. */
  decidedBy: "kill_switch" | "family" | "source" | "global" | "default";
  killSwitchEngaged: boolean;
  /**
   * Set when a level asked for `enforce` but the three-way authorization below
   * was not satisfied, so the result was capped at `shadow`. Surfaced for
   * logging: a half-configured enforcement attempt should be visible, not
   * silently downgraded.
   */
  enforcementWithheldReason?: string;
}

function readExplicit(env: ModeEnv, key: string): ProofMode | null {
  const raw = env[key];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return parseMode(raw);
}

function lowest(modes: ProofMode[]): ProofMode {
  return modes.reduce((a, b) => (MODE_RANK[a] <= MODE_RANK[b] ? a : b));
}

/**
 * Resolve the effective mode for one source and, optionally, one plan family.
 *
 * ENFORCEMENT REQUIRES THREE INDEPENDENT AUTHORIZATIONS. The contract grants
 * enforcement per source x family (handoff 9.1), so `enforce` is returned only
 * when all three of these are explicitly set to "enforce":
 *
 *   PROOF_MODE                                  (global)
 *   PROOF_MODE_<SOURCE>                         (source)
 *   PROOF_MODE_FAMILY_<SOURCE>_<FAMILY>         (family)
 *
 * An earlier revision treated the global setting as sufficient, which meant a
 * single PROOF_MODE=enforce would have begun altering delivery for every source
 * and family at once -- the opposite of a per-family rollout, and impossible to
 * stage. Any partial configuration now caps at `shadow`: the system observes and
 * records, but cannot change what a user receives.
 *
 * Everything below enforcement still behaves as a ceiling: a level that is set
 * lower than the global narrows behavior, and an unset level inherits. So
 * PROOF_MODE=off remains a complete stop regardless of any stale per-source or
 * per-family variable, and the kill switch outranks all of it.
 */
export function resolveMode(sourceId: SourceId, planFamily: string | null = null, env: ModeEnv = process.env): ModeResolution {
  const killSwitchEngaged = parseKillSwitch(env[ENV_KILL_SWITCH]);
  if (killSwitchEngaged) return { mode: "off", decidedBy: "kill_switch", killSwitchEngaged: true };

  const globalSet = typeof env[ENV_GLOBAL_MODE] === "string" && env[ENV_GLOBAL_MODE]!.trim() !== "";
  const global = parseMode(env[ENV_GLOBAL_MODE]);
  const source = readExplicit(env, envKeyForSource(sourceId));
  const family = planFamily ? readExplicit(env, envKeyForFamily(sourceId, planFamily)) : null;

  const decidedBy: ModeResolution["decidedBy"] = family !== null ? "family" : source !== null ? "source" : globalSet ? "global" : "default";

  // Full authorization: every level explicitly enforces.
  if (global === "enforce" && source === "enforce" && family === "enforce") {
    return { mode: "enforce", decidedBy: "family", killSwitchEngaged: false };
  }

  // Otherwise take the lowest setting among the levels that apply, so a narrower
  // level always wins, then cap below enforcement.
  const applicable: ProofMode[] = [global];
  if (source !== null) applicable.push(source);
  if (family !== null) applicable.push(family);
  const effective = lowest(applicable);

  if (effective === "enforce") {
    const missing: string[] = [];
    if (global !== "enforce") missing.push(ENV_GLOBAL_MODE);
    if (source !== "enforce") missing.push(envKeyForSource(sourceId));
    if (family !== "enforce") {
      missing.push(planFamily ? envKeyForFamily(sourceId, planFamily) : "a plan family (none supplied)");
    }
    return {
      mode: "shadow",
      decidedBy,
      killSwitchEngaged: false,
      enforcementWithheldReason: `enforcement requires explicit authorization at every level; not set to enforce: ${missing.join(", ")}`,
    };
  }

  return { mode: effective, decidedBy, killSwitchEngaged: false };
}

/** True when the proof system may do request-path observation work. */
export function isObserving(mode: ProofMode): boolean {
  return mode === "shadow" || mode === "enforce";
}

/**
 * True when the proof system may change what the user receives.
 *
 * Every delivery-altering branch in Stage 4 must be gated on this function and
 * nothing else, so that the audit question "what can change a response?" has a
 * single greppable answer.
 */
export function mayAlterDelivery(mode: ProofMode): boolean {
  return mode === "enforce";
}

/**
 * Snapshot of every source's family-less effective mode, for startup logging.
 *
 * Because enforcement is granted per source x family, this snapshot can never
 * contain `enforce` -- use enforcedTargets() to answer "is anything enforcing?".
 */
export function modeSnapshot(env: ModeEnv = process.env): Record<SourceId, ProofMode> {
  const snapshot = {} as Record<SourceId, ProofMode>;
  for (const sourceId of SOURCE_IDS) snapshot[sourceId] = resolveMode(sourceId, null, env).mode;
  return snapshot;
}

export interface EnforcedTarget {
  sourceId: SourceId;
  /**
   * The NORMALIZED family token as it appears in the env key (upper snake case),
   * not the plan library's original identifier. Round-trips back through
   * envKeyForFamily() to the same key, which is what matters for resolution;
   * treat it as an identifier for reporting, not as a display label.
   */
  planFamily: string;
  /** The env variable that granted family-level authorization. */
  envKey: string;
}

/**
 * Every source x family currently authorized to alter delivery.
 *
 * Enumerated by scanning the environment for PROOF_MODE_FAMILY_* keys rather
 * than by checking a fixed list of families, because families are declared by
 * the plan library and this module must not need updating when one is added.
 * A previous revision's noEnforcementActive() consulted only the family-less
 * snapshot, so a family-level enforcement was invisible to the very function
 * used to assert that nothing was enforcing.
 */
export function enforcedTargets(env: ModeEnv = process.env): EnforcedTarget[] {
  if (parseKillSwitch(env[ENV_KILL_SWITCH])) return [];
  const targets: EnforcedTarget[] = [];
  const prefix = "PROOF_MODE_FAMILY_";
  for (const envKey of Object.keys(env)) {
    if (!envKey.startsWith(prefix)) continue;
    const remainder = envKey.slice(prefix.length);
    // Source ids may themselves contain an underscore (hate_crime), so match by
    // prefix against the known ids rather than splitting on the separator.
    const sourceId = SOURCE_IDS.find((candidate) => remainder.startsWith(`${candidate.toUpperCase()}_`));
    if (!sourceId) continue;
    const planFamily = remainder.slice(sourceId.length + 1);
    if (!planFamily) continue;
    // Re-resolve through the same path a request would take, so this can never
    // drift from the real decision.
    if (resolveMode(sourceId, planFamily, env).mode === "enforce") {
      targets.push({ sourceId, planFamily, envKey });
    }
  }
  return targets;
}

/** True when nothing anywhere is authorized to alter delivery. */
export function noEnforcementActive(env: ModeEnv = process.env): boolean {
  return enforcedTargets(env).length === 0;
}
