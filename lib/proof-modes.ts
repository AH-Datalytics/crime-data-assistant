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
}

/**
 * Resolve the effective mode for one source (and optionally one plan family).
 *
 * Precedence: kill switch > family override > source override > global > default.
 *
 * An override is CLAMPED to the global mode rather than allowed to exceed it.
 * Without clamping, a stale PROOF_MODE_FAMILY_* left over from an experiment
 * could re-enable enforcement for that family the moment someone set the global
 * mode back to `off` to calm an incident -- the exact scenario a kill switch
 * exists to prevent. Overrides can therefore narrow behavior but never widen it
 * past what the global setting permits.
 */
export function resolveMode(sourceId: SourceId, planFamily: string | null = null, env: ModeEnv = process.env): ModeResolution {
  const killSwitchEngaged = parseKillSwitch(env[ENV_KILL_SWITCH]);
  if (killSwitchEngaged) return { mode: "off", decidedBy: "kill_switch", killSwitchEngaged: true };

  const global = parseMode(env[ENV_GLOBAL_MODE]);
  const ceiling = MODE_RANK[global];

  const clamp = (candidate: ProofMode, decidedBy: ModeResolution["decidedBy"]): ModeResolution => ({
    mode: MODE_RANK[candidate] <= ceiling ? candidate : global,
    decidedBy,
    killSwitchEngaged: false,
  });

  if (planFamily) {
    const raw = env[envKeyForFamily(sourceId, planFamily)];
    if (typeof raw === "string" && raw.trim() !== "") return clamp(parseMode(raw), "family");
  }

  const sourceRaw = env[envKeyForSource(sourceId)];
  if (typeof sourceRaw === "string" && sourceRaw.trim() !== "") return clamp(parseMode(sourceRaw), "source");

  if (typeof env[ENV_GLOBAL_MODE] === "string" && env[ENV_GLOBAL_MODE]!.trim() !== "") {
    return { mode: global, decidedBy: "global", killSwitchEngaged: false };
  }

  return { mode: DEFAULT_MODE, decidedBy: "default", killSwitchEngaged: false };
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

/** Snapshot of every source's effective mode, for startup logging and review. */
export function modeSnapshot(env: ModeEnv = process.env): Record<SourceId, ProofMode> {
  const snapshot = {} as Record<SourceId, ProofMode>;
  for (const sourceId of SOURCE_IDS) snapshot[sourceId] = resolveMode(sourceId, null, env).mode;
  return snapshot;
}

/** True when no source is in enforce mode -- the Stage 0/1 expected state. */
export function noEnforcementActive(env: ModeEnv = process.env): boolean {
  return Object.values(modeSnapshot(env)).every((mode) => mode !== "enforce");
}
