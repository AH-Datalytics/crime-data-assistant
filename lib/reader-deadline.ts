/**
 * A time limit on the reader (reading a question into a request ledger, places and parts), for the scorecard only.
 *
 * The reader runs in the same process as the runner and cannot be interrupted, so it checks the clock at the points
 * where it starts a reading again (readQuestion). Time spent inside the database (the executor) is not the reader's
 * and is left out, so a slow query is bounded by its own limit and a slow reading by this one.
 *
 * Nothing sets a limit in the website or the engine service: with no limit set the check does nothing.
 */
export class ReaderTookTooLong extends Error {
  constructor(public readonly seconds: number) {
    super(`the reader took too long (more than ${seconds} s reading the question)`);
    this.name = "ReaderTookTooLong";
  }
}

let limitMs: number | null = null;
let startedAt = 0;
let databaseMs = 0;

/** Start the clock for one question: the reader has `ms` (database time excluded). `null` clears the limit. */
export function startReaderClock(ms: number | null, now: number = Date.now()): void {
  limitMs = ms; startedAt = now; databaseMs = 0;
}

/** Record time spent in the database, which does not count against the reader. */
export function noteDatabaseTime(ms: number): void {
  databaseMs += ms;
}

/** Throws ReaderTookTooLong when the reader has used more than its limit on the current question. */
export function checkReaderClock(now: number = Date.now()): void {
  if (limitMs === null) return;
  if (now - startedAt - databaseMs > limitMs) throw new ReaderTookTooLong(Math.round(limitMs / 1000));
}
