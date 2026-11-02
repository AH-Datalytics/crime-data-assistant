# Codex reviews: shadow speed, part 1 (2026-11-01)

## 01, full review: REVISE (two P1s), fixed
1. A Python that could not start left the caller waiting forever (no error handler; Atomics.wait with no timeout).
2. Python exiting between queries left the next call waiting (the exit reply was taken by the wrong call).

Fixed: the worker replies only to a pending request; a launch error or an exit is remembered and answers every later request at once; the caller waits at most timeoutMs, after which the executor is closed. Tests cover a missing Python and a timeout. Codex found no cache mutation and no aggregation regression.

## 02, confirmation: ACCEPT
