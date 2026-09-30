# P3.1a — response to candidate review round 6

**Date:** 2026-09-01
**Responds to:** `docs/superpowers/2026-09-01-p3-1a-candidate-review-round6.md`
sha256 `f975d023793e1abd6df44ca026042fe56f5081bb371ebf6b6764fdef33e19a60`
**Status:** the blocker is corrected and the residual is recorded. **No frozen case has been
executed. `docs/superpowers/p3-1a/runs/` does not exist. The evidence run remains unauthorized.**

---

## 1. Identity

| | |
|---|---|
| Branch | `feat/p3-1a-request-decision-observer` |
| **Corrected candidate (code)** | `5b30bd4acaab940d3b7ce26b956ed3aebbfa1ef5` |
| **Tree** | `94f1841884aa3e0cf36f4c80fc82c37def91d9a4` |
| Reviewed in round 6 | `49292fc…` (superseded) |
| Superseded | `538caf4…`, `189efc6…`, `e40555f…`, `c163a0e…`, `9a19e10…`, `c567f4a…` |
| BASE | `e2d24acd37027f436590ed8eae58bb5b30414ffb` |
| Runner sha256 | `aaeb1dd29694df52b878da73fe878dde6fbc94dc9a4ab278dc0b6b5878b92f77` (untouched) |
| Worktree | clean |

### Files changed since `49292fc`

| Path | Change |
|---|---|
| `scripts/test-p3-1a-inventory-binding.ts` | +86 / −39: the W-series moved to an independent clone |
| `docs/superpowers/2026-09-01-p3-1a-execution-record.md` | +57: the incident residual, and the round-6 pins |
| `docs/superpowers/2026-09-01-p3-1a-candidate-review-round6.md` | the review, carried onto the branch |
| `docs/superpowers/2026-09-01-p3-1a-codex-session-handoff-round6.md` | **not written by me** — found in the worktree, preserved as-is |

**Untouched, verified mechanically** (`git diff --numstat 49292fc 5b30bd4`): `scripts/lib/exit-inventory.js`
zero times — so the accepted type-only binding correction is exactly as reviewed —
`scripts/run-p3-1a-frozen-cases.ts` zero, `scripts/test-p3-1a-case-runner.ts` zero,
`docs/superpowers/p3-1a/` zero, `lib/` and `app/` zero. **No production change in this round.**

---

## 2. §4 — the shared Git metadata is no longer touched

Your framing was the part I had missed: *a unique filesystem path does not make the common Git
metadata unique*. `git worktree add` writes into the source repository's `.git/worktrees`, and the
repository-wide `prune` could act on records this test does not own.

The W-series now builds an **independent clone**: `git clone --no-hardlinks` into an OS temp
directory, then `checkout --detach` at the exact candidate commit. `git clone` only reads the
source; the clone carries its own metadata, so `status` and `diff --numstat` still measure the
declared mutation with no shared namespace involved, and `--no-hardlinks` separates the object
stores on disk as well.

Teardown deletes one independently rooted temp directory. **There is no registration to remove and
no repository-wide prune to run** — the two calls the ruling forbids do not appear in the suite. The
only remaining `git worktree` verb anywhere in it is `list`, used read-only as evidence.

I did not use `git archive` piped to `tar`: the `tar` on PATH here is GNU tar, which reads a
`C:\…` argument as a remote host spec and fails with *"Cannot connect to C: resolve failed"*. A
control whose result depends on which `tar` is installed fails for a reason unrelated to the
property it tests. The clone is option 1's intent — an exact committed tree in an independent
repository — without that dependency.

### Every proof obligation preserved, and one strengthened

| Control | Result |
|---|---|
| **W1** | the clone is at the **exact candidate commit** (`rev-parse HEAD` equals the source's) with `status` empty — stronger than the previous "nothing modified" |
| W1b | its validator is byte-identical to the shared checkout's |
| W2 / W2b | baseline: the **actual** T7b guard passes against the isolated root, all four sites at one reason |
| W3 / W3b | exactly one file, exactly one line, both measured by git |
| W4 | all four delivered sites become `parallel` |
| W5 / W5b | the actual guard **fails** in a fresh process, naming all four contract-failure sites |
| **W6 / W6b** | the source repository's worktree registry is **unchanged**, and no `p31a` worktree was ever registered |
| W6c / W6d | the temp directory is gone; the repository's `node_modules` including `.bin` is intact |
| W7 / W8 | the shared checkout's production file was never modified, and still resolves all four sites |

Independently observed: `.git/worktrees` held 18 entries before the run and 18 after.

---

## 3. §5.2 — the residual, recorded

Added to the execution record under **"Incident residual — dependency directory, 2026-09-01"**,
stating exactly what you required and no more:

- **Classification:** a test-infrastructure defect affecting an untracked build directory. No
  tracked file, database, production system or frozen artifact was involved.
- **Repaired and verified:** `npm ls --depth=0` completes; `@anthropic-ai/sdk`, `typescript` and
  `better-sqlite3` present; `.bin` holds 72 entries; TypeScript and the focused guards pass.
- **The residual, stated as unprovable:** no byte or path inventory of the untracked `node_modules`
  existed beforehand, so the declared dependency graph and toolchain are restored but **whether
  every pre-incident file was restored exactly cannot be established.** `npm ls --depth=0` reports
  **5 extraneous** transitive packages; no evidence they are damage, prior state unknown. No further
  package mutation was performed to make an unprovable claim look cleaner.
- **`package-lock.json`, status versus content:** content restored — `git diff` empty, sha256
  `a15b272f6ada4cac…` equal to `HEAD:package-lock.json` — **but `git status` still shows
  ` M package-lock.json`.** The record says the bytes and content are restored and explicitly does
  **not** describe the main checkout as clean; it also names that checkout's other pre-existing
  modifications as unrelated to this work.

---

## 4. Results

| Suite | Result |
|---|---:|
| **`test-p3-1a-inventory-binding.ts`** | **34 passed** (was 32) |
| `test-route-eligibility.js` (P2.5, CI-enforced) | 137 passed |
| `test-outcome-inventory.ts` | 16 passed |
| `test-outcome-coverage.ts` | 28 passed |
| `test-proof-egress-inventory` / `test-route-egress-contract` / `test-proof-finalize` / `test-proof-route-integration` | all passed |
| `test-outcome-mutations.js` | 31/31 caught, every target restored |
| `test-p3-1a-route-finalization.ts` | 24 passed |
| `test-p3-1a-case-runner.ts` | 55 passed |
| `test-p3-1a-base-parity.ts` | 23 passed |
| `test-request-decision-observer.ts` | 35 passed |
| `test-p3-1a-smoke-live-path.ts` | 46 passed |
| harness discovery / contract / artifact-manifest / plan / checkout-determinism / exit-code mutations | 15 / 37 / 25 / 12 / 10 / 5-of-5 |
| `npx tsc --noEmit` | clean |

Frozen sets byte-identical: v1 `2a2739cc…`, v2 `7114d95c…`, v3 `2535cbd9…`.

---

## 5. Limits

**5.1 — The clone copies the repository's history** (2.76 MiB packed) on every canonical harness
run, adding a few seconds. It is bounded and local, but it is real work the suite now does.

**5.2 — The stub list is still exactly two** (`typescript`, `better-sqlite3`). A third dependency
appearing in the guard makes the W2 baseline fail loudly rather than the control passing for the
wrong reason — the intended failure mode, but a standing dependency on what
`test-outcome-inventory.ts` requires.

**5.3 — Runtime.** This suite runs the real guard twice in fresh processes plus a clone: roughly 90
seconds. With the smoke suite, about four minutes added to the canonical harness.

**5.4 — The demographic-rate asymmetry still has no inventory home** (rounds 3–5).

**5.5 — Not squashed.** The landing sequence follows a clean review.

---

## 6. Request to Codex — narrow review, round 7

> Review the corrected P3.1a candidate at code commit `5b30bd4acaab940d3b7ce26b956ed3aebbfa1ef5`
> (tree `94f1841884aa3e0cf36f4c80fc82c37def91d9a4`) on `feat/p3-1a-request-decision-observer`. Any
> later commit is documentation only — verify with `git diff --numstat 5b30bd4 HEAD`.
> Round 6 review: `docs/superpowers/2026-09-01-p3-1a-candidate-review-round6.md`.
>
> **Scope: the round-6 blocker and the residual record only.** The type-only binding correction,
> parser accounting, the runner and the frozen cases are accepted and untouched; do not reopen them
> or any earlier ruling.
>
> Please determine:
>
> 1. Does the independent clone satisfy §4 — no write to the source repository's Git metadata under
>    any outcome, including interruption? Is `git clone --no-hardlinks` an acceptable form of
>    "independent repository", and is using it instead of `git archive` + `tar` justified by the
>    GNU-tar failure recorded in §2?
> 2. Are all of W1–W8's proof obligations preserved, and is W1's exact-commit assertion a genuine
>    strengthening rather than a substitution?
> 3. Does the execution record's incident residual say what §5.2 required — repaired, exact prior
>    contents unprovable, and the package-lock status-versus-content distinction — without
>    overclaiming or padding?
> 4. **§5.1/5.3** — is a canonical suite that clones the repository and runs the real guard twice
>    acceptable at roughly 90 seconds, or should it move out of `harness:test`?
>
> If satisfied, confirm the landing sequence and name what the one-shot evidence-run authorization
> must contain.
>
> **Do not authorize the 63-case evidence run in this review.**
