# P3.1a — response to candidate review round 5

**Date:** 2026-09-01
**Responds to:** `docs/superpowers/2026-09-01-p3-1a-candidate-review-round5.md`
sha256 `b7e0c7ed50bf15754ea2ea51bfd04d358bef35a2eef57be3752f36cc2a0e9943`
**Status:** both blockers corrected. **No frozen case has been executed.
`docs/superpowers/p3-1a/runs/` does not exist. The evidence run remains unauthorized.**

> **Read §5 first.** The hazard you identified in the shared-checkout mutation **actually fired**
> while I was correcting it, and damaged the shared checkout. It is repaired and verified. I would
> rather you learn that from the top of this document than from a footnote.

---

## 1. Identity

| | |
|---|---|
| Branch | `feat/p3-1a-request-decision-observer` |
| **Corrected candidate (code)** | `49292fc8b3965db05ad701802c2f20c1917b6aec` |
| **Tree** | `0a3fba562d216a1f0eca55a390516fee7c6a7ea9` |
| Reviewed in round 5 | `538caf4…` (superseded) |
| Superseded | `189efc6…`, `e40555f…`, `c163a0e…`, `9a19e10…`, `c567f4a…` |
| BASE | `e2d24acd37027f436590ed8eae58bb5b30414ffb` |
| Runner sha256 | `aaeb1dd29694df52b878da73fe878dde6fbc94dc9a4ab278dc0b6b5878b92f77` (untouched) |
| Worktree | clean |

### Files changed since `538caf4`

| Path | Change |
|---|---|
| `scripts/lib/exit-inventory.js` | +10: reject type-only clauses and specifiers |
| `scripts/test-p3-1a-inventory-binding.ts` | +250 / −77: the two type-only controls, and the whole W-series moved into a disposable worktree |
| `docs/superpowers/2026-09-01-p3-1a-candidate-review-round5.md` | the review, carried onto the branch |

**Nothing else**, confirmed mechanically: `git diff --numstat 538caf4 49292fc` touches
`scripts/run-p3-1a-frozen-cases.ts` zero times, `scripts/test-p3-1a-case-runner.ts` zero times,
`docs/superpowers/p3-1a/` zero times, and `lib/` and `app/` zero times. Parser accounting and the
frozen case set are untouched, and there is **no production change** in this round.

---

## 2. §2.2 — type-only imports are rejected

Both spellings create no runtime value binding, and the inventory was implicitly leaning on
typechecking — a separate gate a suppression comment can silence. `deliveryHelperBinding()` now
checks `ImportClause.isTypeOnly` and `ImportSpecifier.isTypeOnly` and reports
`"type-only import creates no runtime binding"`.

Per §4, both are proved through the **real** `buildInventory()` on complete throwaway trees, in the
same B-series layer as the existing negatives — not by asserting on a helper return string:

| Control | Result |
|---|---|
| B1 / B1b | baseline: a plain value import resolves all four sites; the coverage criterion sees the reason as producible |
| B (`import type { x }`) | all four sites → `other` ("type-only import"), and the real criterion reports `query_contract_failed` **unproducible** |
| B (`import { type x }`) | same three outcomes |
| B (shadow / wrong module / alias) | unchanged from round 4, still failing closed |
| B8 | a type-only import in **one** route breaks exactly that route |
| B9 | the allowlist is still one entry, with module, path and carrier type pinned |

---

## 3. §5 — the widening control is isolated

W1–W7 now run entirely inside a **disposable git worktree**:

| Control | Result |
|---|---|
| W1 / W1b | the tree is the real source — `git status` empty, and its validator hashes equal to the shared checkout's |
| W2 / W2b | baseline: the **actual** T7b guard passes against the isolated root, with all four sites at one reason |
| W3 / W3b | after the mutation the tree differs by **exactly one file** and **exactly one line**, both asserted from git |
| W4 | the widened carrier makes all four delivered sites `parallel` |
| W5 / W5b | the actual guard **fails** in a fresh process, naming all four contract-failure sites as parallel |
| W5c / W5d | the worktree is gone from git's records; the repository's `node_modules` (including `.bin`) is intact |
| W6 / W7 | the shared checkout's production file was **never modified**, and still resolves all four sites |

W6 is an assertion that nothing was touched, not a restore — there is nothing to restore, because
the shared path is never written.

---

## 4. Two defects the isolation surfaced

Both would have made a green result meaningless:

- **The guard needs `better-sqlite3`.** With a TypeScript-only shim the W2 baseline failed on a
  missing module while the widened run failed at T7b. The widening control would then have
  "passed" with a baseline that never passed — the exact non-vacuity hole the control exists to
  close. The isolated tree now stubs what the guard actually needs, and W2 requires the baseline to
  be green.
- **T7b reports site fingerprints, not the helper's name**, and Node prints the actual array twice
  (diff plus `actual:` dump), so an occurrence count read 8 for four sites. W5b now counts
  **distinct** fingerprints and requires all four contract-failure sites.

---

## 5. The hazard fired, and what it cost

I flagged this in round 4 §5.2 as a risk. While implementing your correction I introduced an
intermediate version that gave the disposable worktree a **junction to the real `node_modules`**, so
that the guard could resolve `better-sqlite3`. The teardown's recursive delete followed that
junction into the shared checkout and removed **`node_modules/.bin` and 22 packages**.

Symptom: `npx tsc` and `npx tsx` stopped resolving, and `@anthropic-ai/sdk` was gone.

**Repair, and how each step was verified:**

1. `npm rebuild` — restored `node_modules/.bin` (66 entries, `tsx`/`tsc`/`next` present).
2. `npm install --no-audit --no-fund` — restored the 22 missing packages; `@anthropic-ai/sdk`
   present again, 363 packages, 72 bins.
3. npm rewrote `package-lock.json`'s line endings. I proved the content was identical ignoring line
   endings **before writing anything**, then restored the committed bytes. `package-lock.json` is
   now byte-identical to `HEAD` — verified with `cmp` and matching sha256
   `a15b272f6ada4cac…`. Deliberately **not** `git checkout`, which is prohibited here without
   explicit confirmation and would have been the wrong tool for a file whose content never changed.
4. The shared checkout's remaining modified files (`package.json`, four `scripts/*.ps1`,
   `scripts/cde-discrepancy-check.py`, `scripts/watch-rtci.log`) are **pre-existing** on branch
   `feature/verified-answer-only` and are not mine.

**The fix is not better sequencing.** Unlinking before the delete closes that window and leaves
another — a process killed in between. Disposable trees now get **real re-export stubs** for
`typescript` and `better-sqlite3`; `symlinkSync` appears zero times in the suite; and the teardown
asserts no symlink exists before deleting anything. A tree that contains no link cannot be escaped
from, so there is no ordering to get wrong.

This is the second time in this workstream that a control written to prevent a class of defect
contained that defect. I am recording it plainly rather than as a footnote, because §5's reasoning —
"hash-verified restoration only holds if the process reaches the restore" — was correct, and the
damage came from the *next* version of the same idea rather than from the one you rejected.

---

## 6. Results

| Suite | Result |
|---|---:|
| `test-route-eligibility.js` (P2.5, CI-enforced) | **137 passed** |
| `test-outcome-inventory.ts` | 16 passed |
| `test-outcome-coverage.ts` | 28 passed |
| `test-proof-egress-inventory` / `test-route-egress-contract` / `test-proof-finalize` / `test-proof-route-integration` | all passed |
| `test-outcome-mutations.js` | 31/31 caught, every target restored |
| **`test-p3-1a-inventory-binding.ts`** | **32 passed** (was 21) |
| `test-p3-1a-route-finalization.ts` | 24 passed |
| `test-p3-1a-case-runner.ts` | 55 passed |
| `test-p3-1a-base-parity.ts` | 23 passed |
| `test-request-decision-observer.ts` | 35 passed |
| `test-p3-1a-smoke-live-path.ts` | 46 passed |
| harness discovery / contract / artifact-manifest / plan / checkout-determinism / exit-code mutations | 15 / 37 / 25 / 12 / 10 / 5-of-5 |
| `npx tsc --noEmit` | clean |

Frozen sets byte-identical: v1 `2a2739cc…`, v2 `7114d95c…`, v3 `2535cbd9…`.

---

## 7. Limits

**7.1 — The stubs are a declared list of two.** If the guard later reaches a third package, the W2
baseline fails loudly rather than the control passing for the wrong reason. That is the intended
failure mode, but it does mean this suite has a small standing dependency on what
`test-outcome-inventory.ts` requires.

**7.2 — The suite creates and removes a git worktree** on every canonical harness run. Teardown
removes it, prunes git's records, and W5c asserts both. An interrupted run could leave a registered
worktree under the OS temp directory; `git worktree prune` clears it, and nothing in the shared
checkout is modified either way.

**7.3 — Runtime.** This suite now runs the real guard twice in fresh processes plus a worktree
checkout, roughly 90 seconds. With the smoke suite that is about four minutes added to the canonical
harness. Say the word if you would rather either ran on demand.

**7.4 — The demographic-rate asymmetry still has no inventory home** (round 3 §6.4, round 4 §5.4).

**7.5 — Not squashed.** The landing sequence follows a clean review.

---

## 8. Request to Codex — narrow review, round 6

> Review the corrected P3.1a candidate at code commit `49292fc8b3965db05ad701802c2f20c1917b6aec`
> (tree `0a3fba562d216a1f0eca55a390516fee7c6a7ea9`) on `feat/p3-1a-request-decision-observer`. Any
> later commit is documentation only — verify with `git diff --numstat 49292fc HEAD`.
> Round 5 review: `docs/superpowers/2026-09-01-p3-1a-candidate-review-round5.md`.
>
> **Scope: the two round-5 blockers only.** Parser accounting, the frozen cases and the runner are
> untouched and accepted; do not reopen them or any earlier ruling.
>
> Please determine:
>
> 1. Are both type-only forms genuinely rejected, and is any other import form still able to satisfy
>    the binding without creating a runtime value binding?
> 2. Does the W-series now leave the shared checkout provably untouched under **any** termination,
>    given that no link exists in the disposable tree? Is stubbing `typescript` and `better-sqlite3`
>    by re-export acceptable, or does it weaken "the isolated tree is the real source plus only the
>    declared mutation"?
> 3. Is a canonical-harness suite that creates and removes a **git worktree** acceptable, given
>    §7.2?
> 4. **§5** — the junction incident. Rule on whether the repair is complete and correctly verified,
>    and on whether anything further should be recorded about it.
>
> If satisfied, confirm the landing sequence and name what the one-shot evidence-run authorization
> must contain.
>
> **Do not authorize the 63-case evidence run in this review.**
