// Tests for lib/proof-modes.ts — off | shadow | enforce configuration.
// Run: npx tsx scripts/test-proof-modes.ts
//
// Stage 0's non-negotiable boundary is that nothing is enabled. These tests are
// the executable form of that promise: an empty environment, a malformed
// environment, and a hostile leftover-override environment must all resolve to
// `off`, and no configuration reachable without an explicit deliberate value can
// alter a user response.
import assert from "node:assert/strict";
import {
  DEFAULT_MODE,
  enforcedTargets,
  ENV_GLOBAL_MODE,
  ENV_KILL_SWITCH,
  envKeyForFamily,
  envKeyForSource,
  isObserving,
  mayAlterDelivery,
  modeSnapshot,
  noEnforcementActive,
  parseKillSwitch,
  parseMode,
  resolveMode,
  type ModeEnv,
} from "../lib/proof-modes";
import { SOURCE_IDS } from "../lib/proof-contract";

// The default. An empty environment -- the state of production today -- is off
// for every source, and nothing may alter delivery.
{
  const env: ModeEnv = {};
  assert.equal(DEFAULT_MODE, "off");
  for (const sourceId of SOURCE_IDS) {
    const resolution = resolveMode(sourceId, null, env);
    assert.equal(resolution.mode, "off", `${sourceId} must default to off`);
    assert.equal(resolution.decidedBy, "default");
    assert.equal(mayAlterDelivery(resolution.mode), false);
    assert.equal(isObserving(resolution.mode), false, "off must not even observe");
  }
  assert.equal(noEnforcementActive(env), true);
  assert.deepEqual(modeSnapshot(env), {
    current: "off",
    historical: "off",
    nibrs: "off",
    shr: "off",
    hate_crime: "off",
  });
}

// Malformed values degrade toward off rather than throwing or escalating.
{
  for (const bad of ["", "   ", "enforced", "ENFORCE!", "1", "true", "shadowy", "on"]) {
    assert.equal(parseMode(bad), "off", `'${bad}' must parse to off`);
  }
  assert.equal(parseMode(undefined), "off");
  assert.equal(parseMode(null), "off");
  // Recognized values still work, case- and whitespace-insensitively.
  assert.equal(parseMode("shadow"), "shadow");
  assert.equal(parseMode("  ENFORCE "), "enforce");
}

// The kill switch outranks every other setting, including an explicit enforce.
{
  const env: ModeEnv = {
    [ENV_KILL_SWITCH]: "1",
    [ENV_GLOBAL_MODE]: "enforce",
    [envKeyForSource("nibrs")]: "enforce",
    [envKeyForFamily("nibrs", "nibrs-clearance-type")]: "enforce",
  };
  const resolution = resolveMode("nibrs", "nibrs-clearance-type", env);
  assert.equal(resolution.mode, "off", "kill switch must force off");
  assert.equal(resolution.decidedBy, "kill_switch");
  assert.equal(resolution.killSwitchEngaged, true);
  assert.equal(noEnforcementActive(env), true, "kill switch must clear enforcement everywhere");

  for (const truthy of ["1", "true", "TRUE", "on", "yes", " Yes "]) assert.equal(parseKillSwitch(truthy), true);
  for (const falsy of ["0", "false", "off", "no", "", undefined, null]) assert.equal(parseKillSwitch(falsy), false);
}

// The narrowest level wins whenever any level narrows.
{
  const env: ModeEnv = {
    [ENV_GLOBAL_MODE]: "enforce",
    [envKeyForSource("nibrs")]: "shadow",
    [envKeyForFamily("nibrs", "nibrs-clearance-type")]: "off",
  };
  assert.equal(resolveMode("nibrs", "nibrs-clearance-type", env).mode, "off");
  assert.equal(resolveMode("nibrs", "some-other-family", env).mode, "shadow");
  assert.equal(resolveMode("nibrs", null, env).mode, "shadow");
}

// A global of `off` is a complete stop; no override can revive anything.
{
  const env: ModeEnv = {
    [ENV_GLOBAL_MODE]: "off",
    [envKeyForSource("historical")]: "enforce",
    [envKeyForFamily("historical", "historical-city-change")]: "enforce",
  };
  assert.equal(resolveMode("historical", null, env).mode, "off");
  assert.equal(resolveMode("historical", "historical-city-change", env).mode, "off");
  assert.equal(noEnforcementActive(env), true);
}

// ENFORCEMENT REQUIRES ALL THREE LEVELS. The contract grants enforcement per
// source x family, so no configuration missing any level may alter delivery.
// A global-only `enforce` previously enabled every source and family at once,
// which made a staged per-family rollout impossible.
{
  const family = "nibrs-clearance-type";
  const partial: Array<[string, ModeEnv]> = [
    ["global only", { [ENV_GLOBAL_MODE]: "enforce" }],
    ["source only", { [envKeyForSource("nibrs")]: "enforce" }],
    ["family only", { [envKeyForFamily("nibrs", family)]: "enforce" }],
    ["global + source, no family", { [ENV_GLOBAL_MODE]: "enforce", [envKeyForSource("nibrs")]: "enforce" }],
    ["global + family, no source", { [ENV_GLOBAL_MODE]: "enforce", [envKeyForFamily("nibrs", family)]: "enforce" }],
    ["source + family, no global", { [envKeyForSource("nibrs")]: "enforce", [envKeyForFamily("nibrs", family)]: "enforce" }],
  ];
  for (const [label, env] of partial) {
    const resolution = resolveMode("nibrs", family, env);
    assert.equal(mayAlterDelivery(resolution.mode), false, `${label} must not alter delivery`);
    assert.equal(noEnforcementActive(env), true, `${label} must leave enforcement inactive`);
  }

  // Partial authorization caps at shadow and says why, rather than silently
  // reverting to off (which would hide a half-finished rollout).
  const twoOfThree = resolveMode("nibrs", family, { [ENV_GLOBAL_MODE]: "enforce", [envKeyForSource("nibrs")]: "enforce" });
  assert.equal(twoOfThree.mode, "shadow");
  assert.match(twoOfThree.enforcementWithheldReason || "", /PROOF_MODE_FAMILY_NIBRS_NIBRS_CLEARANCE_TYPE/);

  // Full authorization at all three levels -- the only shape that enforces.
  const authorized: ModeEnv = {
    [ENV_GLOBAL_MODE]: "enforce",
    [envKeyForSource("nibrs")]: "enforce",
    [envKeyForFamily("nibrs", family)]: "enforce",
  };
  assert.equal(resolveMode("nibrs", family, authorized).mode, "enforce");
  assert.equal(mayAlterDelivery(resolveMode("nibrs", family, authorized).mode), true);
  assert.equal(noEnforcementActive(authorized), false, "family-level enforcement must be detectable");

  // Authorization is scoped: siblings of the enforced family, and other
  // sources, are unaffected.
  assert.equal(resolveMode("nibrs", "some-other-family", authorized).mode, "shadow");
  assert.equal(mayAlterDelivery(resolveMode("shr", "shr-family", authorized).mode), false);

  // enforcedTargets names exactly what is enforced, so a reviewer can audit it.
  const targets = enforcedTargets(authorized);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].sourceId, "nibrs");
  assert.equal(targets[0].envKey, envKeyForFamily("nibrs", family));
  // The reported family round-trips back to the same env key.
  assert.equal(envKeyForFamily(targets[0].sourceId, targets[0].planFamily), targets[0].envKey);

  // The kill switch clears even a fully authorized target.
  assert.equal(noEnforcementActive({ ...authorized, [ENV_KILL_SWITCH]: "1" }), true);
  assert.equal(resolveMode("nibrs", family, { ...authorized, [ENV_KILL_SWITCH]: "1" }).mode, "off");
}

// A source id containing an underscore must not confuse key reversal.
{
  const env: ModeEnv = {
    [ENV_GLOBAL_MODE]: "enforce",
    [envKeyForSource("hate_crime")]: "enforce",
    [envKeyForFamily("hate_crime", "hc-basic")]: "enforce",
  };
  const targets = enforcedTargets(env);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].sourceId, "hate_crime", "HATE_CRIME_HC_BASIC must resolve to the hate_crime source");
  assert.equal(targets[0].planFamily, "HC_BASIC");
}

// Unparseable or unrelated env keys are ignored rather than throwing.
{
  const env: ModeEnv = {
    [ENV_GLOBAL_MODE]: "enforce",
    PROOF_MODE_FAMILY_: "enforce",
    PROOF_MODE_FAMILY_NOTASOURCE_X: "enforce",
    SOMETHING_ELSE: "enforce",
  };
  assert.deepEqual(enforcedTargets(env), []);
  assert.equal(noEnforcementActive(env), true);
}

// Env key naming is stable and collision-free across sources and families.
{
  assert.equal(envKeyForSource("hate_crime"), "PROOF_MODE_HATE_CRIME");
  assert.equal(envKeyForFamily("nibrs", "nibrs-clearance-type"), "PROOF_MODE_FAMILY_NIBRS_NIBRS_CLEARANCE_TYPE");
  const keys = new Set(SOURCE_IDS.map(envKeyForSource));
  assert.equal(keys.size, SOURCE_IDS.length, "per-source env keys must be unique");
}

// Observation gating: only shadow and enforce do request-path work.
{
  assert.equal(isObserving("off"), false);
  assert.equal(isObserving("shadow"), true);
  assert.equal(isObserving("enforce"), true);
  assert.equal(mayAlterDelivery("off"), false);
  assert.equal(mayAlterDelivery("shadow"), false, "shadow must never alter delivery");
  assert.equal(mayAlterDelivery("enforce"), true);
}

console.log("proof-modes tests passed");
