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

// Precedence: family beats source beats global.
{
  const env: ModeEnv = {
    [ENV_GLOBAL_MODE]: "enforce",
    [envKeyForSource("nibrs")]: "shadow",
    [envKeyForFamily("nibrs", "nibrs-clearance-type")]: "off",
  };
  assert.equal(resolveMode("nibrs", "nibrs-clearance-type", env).mode, "off");
  assert.equal(resolveMode("nibrs", "some-other-family", env).mode, "shadow");
  assert.equal(resolveMode("nibrs", null, env).mode, "shadow");
  assert.equal(resolveMode("shr", null, env).mode, "enforce", "unoverridden source follows global");
}

// Clamping. A stale override cannot exceed the global ceiling -- the scenario
// where someone sets PROOF_MODE=off during an incident and a leftover
// PROOF_MODE_FAMILY_* would otherwise keep enforcing that family.
{
  const env: ModeEnv = {
    [ENV_GLOBAL_MODE]: "off",
    [envKeyForSource("historical")]: "enforce",
    [envKeyForFamily("historical", "historical-city-change")]: "enforce",
  };
  assert.equal(resolveMode("historical", null, env).mode, "off", "source override must clamp to global off");
  assert.equal(resolveMode("historical", "historical-city-change", env).mode, "off", "family override must clamp to global off");
  assert.equal(noEnforcementActive(env), true);
}

{
  // Clamping to shadow: overrides may narrow (enforce -> shadow) but not widen.
  const env: ModeEnv = { [ENV_GLOBAL_MODE]: "shadow", [envKeyForSource("current")]: "enforce" };
  assert.equal(resolveMode("current", null, env).mode, "shadow", "override cannot exceed global shadow");

  const narrowing: ModeEnv = { [ENV_GLOBAL_MODE]: "enforce", [envKeyForSource("current")]: "off" };
  assert.equal(resolveMode("current", null, narrowing).mode, "off", "override may narrow below global");
}

// Reaching enforce requires an explicit, deliberate value. There is no
// environment shape short of literally writing "enforce" that produces it.
{
  const shouldNotEnforce: ModeEnv[] = [
    {},
    { [ENV_GLOBAL_MODE]: "" },
    { [ENV_GLOBAL_MODE]: "shadow" },
    { [ENV_GLOBAL_MODE]: "typo" },
    { [envKeyForSource("nibrs")]: "enforce" }, // no global set -> global is off -> clamped
    { [envKeyForFamily("nibrs", "x")]: "enforce" },
  ];
  for (const env of shouldNotEnforce) {
    assert.equal(noEnforcementActive(env), true, `env ${JSON.stringify(env)} must not enable enforcement`);
    for (const sourceId of SOURCE_IDS) {
      assert.equal(mayAlterDelivery(resolveMode(sourceId, "any-family", env).mode), false);
    }
  }

  // The one shape that does enforce, proving the negative tests above are real.
  const explicit: ModeEnv = { [ENV_GLOBAL_MODE]: "enforce" };
  assert.equal(resolveMode("nibrs", null, explicit).mode, "enforce");
  assert.equal(mayAlterDelivery("enforce"), true);
  assert.equal(noEnforcementActive(explicit), false);
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
