/**
 * Test preload: freeze the global clock of a child process.
 *
 * Loaded with `node --require scripts/fixtures/frozen-clock.cjs` by a test that needs a spawned
 * script to observe one exact, predeclared instant -- for example so a filename the script
 * derives from "now" collides with a fixture the test created in advance, instead of the test
 * pre-seeding "the current second plus the next few" and hoping the child starts fast enough.
 *
 * The instant comes from FROZEN_CLOCK_EPOCH_MS (milliseconds since the epoch). Without it the
 * preload does nothing, so a stray inheritance cannot freeze a process by accident. It is never
 * loaded by the application.
 */
"use strict";

const raw = process.env.FROZEN_CLOCK_EPOCH_MS;
if (raw !== undefined && raw !== "") {
  const frozen = Number(raw);
  if (!Number.isFinite(frozen)) throw new Error(`FROZEN_CLOCK_EPOCH_MS is not a number: ${raw}`);
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(frozen);
      else super(...args);
    }
    static now() {
      return frozen;
    }
  }
  globalThis.Date = FrozenDate;
}
