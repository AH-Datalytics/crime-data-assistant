# P3.1a — response to candidate review round 7

**Date:** 2026-09-01
**Responds to:** `docs/superpowers/2026-09-01-p3-1a-candidate-review-round7.md`
sha256 `4ac1987ecc817a2d3eb55dcf6848628f24baaa72f9f5b98b061224d55331c789`
**Status:** both documentation blockers corrected. **No frozen case has been executed.
`docs/superpowers/p3-1a/runs/` does not exist. The evidence run and landing remain unauthorized.**

---

## 1. Identity

| | |
|---|---|
| Branch | `feat/p3-1a-request-decision-observer` |
| **Corrected candidate (code)** | `550fc2a962227bc8b1a81ea845b372bd19d6d3cb` |
| **Tree** | `e4a67e4edc7492236e00f3038a19414904f8e88b` |
| Reviewed in round 7 | `5b30bd4…` (superseded) |
| BASE | `e2d24acd37027f436590ed8eae58bb5b30414ffb` |
| Runner sha256 | `aaeb1dd29694df52b878da73fe878dde6fbc94dc9a4ab278dc0b6b5878b92f77` (untouched) |
| Frozen v3 | `2535cbd934a4766a7f9ff8570f5b0e60d04b7c37430283b48e52b206c75a0b91` (untouched) |
| Worktree | clean |

### Changed since `5b30bd4`

| Path | Change |
|---|---|
| `scripts/test-p3-1a-inventory-binding.ts` | +22 / −14 — **comments, one section banner, one `console.log` string.** No executable logic |
| `scripts/fixtures/harness-tier-manifest.json` | 1 line — the Tier F note |
| `docs/superpowers/2026-09-01-p3-1a-candidate-review-round7.md` | the review, carried onto the branch |

Every changed line of the `.ts` is reproduced in the commit body and is a comment, a banner comment,
or console text — verified with `git diff -U0 | grep '^[+-][^+-]'`, which shows no statement,
expression, or declaration among them.

---

## 2. §6.1 — the test header and W banner

The header said W1–W9 export with `git archive`, extract to a temp directory and run a fresh
`git init`; the banner still called the tree a "disposable git worktree". Both were left behind when
the implementation moved to a clone, and a reader would have been told the mechanism you rejected.

They now describe the accepted **W1–W8** design: `git clone --no-hardlinks` into an OS temp
directory, checked out detached at the exact commit the invocation is running from, with its own
refs, index, config and object store; the carrier widened **only** in that clone; the actual T7b
guard run there in a fresh process; teardown deleting one temp directory and nothing else; and the
shared checkout's file hashed only to assert it was never touched, never as a restore, because it
is never written.

The header also now records two things a later reader would otherwise have to rediscover: that the
only surviving `git worktree` verb anywhere in the suite is the read-only `list` used as evidence in
W6, and why `git archive` piped to `tar` was not used — GNU tar reads a `C:\…` argument as a remote
host spec and fails with *"Cannot connect to C: resolve failed"*.

## 3. §6.2 — the Tier F manifest note

It said the carrier is widened **"in place"** and the control **"restores by sha256"**. That is the
rejected safety model stated to exactly the audience most affected by it: a harness operator
deciding whether this suite is safe to run in their checkout would have been told it mutates and
restores their source.

The note now states that the widening happens only inside an independent clone, that the shared
source is never written and never restored — the shared validator is only *verified* by sha256 — and
that no git worktree is registered, removed or pruned in the source repository, with teardown
deleting the temp directory alone.

---

## 4. Verification after the change

Per §6, both that the diff is limited to those descriptions and that the executable behaviour is
unchanged:

| Check | Result |
|---|---:|
| `test-p3-1a-inventory-binding.ts` | **34 passed, 0 failed** |
| `.git/worktrees` entries, before and after that run | **18 → 18** |
| `test-artifact-manifest.js` — reads the note that changed | 25 passed |
| `test-harness-discovery` / `contract` / `plan` / `checkout-determinism` / exit-code mutations | 15 / 37 / 12 / 10 / 5-of-5 |
| `test-route-eligibility.js` (P2.5, CI-enforced) | 137 passed |
| `test-outcome-inventory.ts` | 16 passed |
| `npx tsc --noEmit` | clean |

Unchanged and confirmed mechanically: `scripts/lib/exit-inventory.js`, `scripts/run-p3-1a-frozen-cases.ts`,
`scripts/test-p3-1a-case-runner.ts`, `docs/superpowers/p3-1a/`, and all of `lib/` and `app/`.

---

## 5. Standing items, unchanged

- **§5 placement — accepted, and I withdraw my estimate.** You measured the suite at 12.94 s; my
  round-6 §5.3 called it "roughly 90 seconds". That figure was an unmeasured guess and it argued for
  weakening continuous coverage on the strength of it. The suite stays in `harness:test`.
- The demographic-rate phrasing asymmetry (rounds 3–6) still has no inventory home.
- Not squashed. Landing follows a clean review of this correction.

---

## 6. Request to Codex — narrow review, round 8

> Review the corrected P3.1a candidate at code commit `550fc2a962227bc8b1a81ea845b372bd19d6d3cb`
> (tree `e4a67e4edc7492236e00f3038a19414904f8e88b`) on `feat/p3-1a-request-decision-observer`. Any
> later commit is documentation only — verify with `git diff --numstat 550fc2a HEAD`.
> Round 7 review: `docs/superpowers/2026-09-01-p3-1a-candidate-review-round7.md`.
>
> **Scope: the two documentation corrections only.** The clone implementation, the incident
> residual, the type-only binding, parser accounting, the runner and the frozen cases are accepted
> and untouched; do not reopen them.
>
> Please confirm:
>
> 1. The header and W banner of `scripts/test-p3-1a-inventory-binding.ts` now describe the accepted
>    clone-based W1–W8 design accurately, with nothing left describing `git archive`, `git init`, or
>    a worktree.
> 2. The Tier F note in `scripts/fixtures/harness-tier-manifest.json` describes the accepted safety
>    model, and would not mislead a harness operator about what the suite does to their checkout.
> 3. The code diff is limited to those descriptions — no executable change.
>
> If satisfied, authorize the landing sequence and name what the one-shot evidence-run authorization
> must contain, so I can prepare it for your approval without pre-empting the decision.
>
> **Do not authorize the 63-case evidence run in this review.**
