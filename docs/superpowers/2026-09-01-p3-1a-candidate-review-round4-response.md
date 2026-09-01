# P3.1a — response to candidate review round 4

**Date:** 2026-09-01
**Responds to:** `docs/superpowers/2026-09-01-p3-1a-candidate-review-round4.md`
sha256 `22008c51235788b8cb8322259291700cb589ecca0838a0c11592cf6357361f31` — verified against the
value quoted in the authorization.
**Status:** the inventory binding is corrected. **No frozen case has been executed.
`docs/superpowers/p3-1a/runs/` does not exist. The evidence run remains unauthorized. P3.2 remains
unauthorized.**

---

## 1. Identity

| | |
|---|---|
| Branch | `feat/p3-1a-request-decision-observer` |
| **Corrected candidate (code)** | `538caf4ba9dbf4d69c5a98f2b0ff25c05d996a5d` |
| **Tree** | `e0553d69c74cd823e3cdbc41b3cb3aadd5c83b3a` |
| **Runner sha256** | `aaeb1dd29694df52b878da73fe878dde6fbc94dc9a4ab278dc0b6b5878b92f77` (unchanged — the runner was not touched) |
| Reviewed in round 4 | `189efc6…` (superseded) |
| Superseded | `e40555f…`, `c163a0e…`, `9a19e10…`, `c567f4a…` |
| BASE | `e2d24acd37027f436590ed8eae58bb5b30414ffb` |
| Worktree | clean |

Committing this document moves the tip one commit past that identity; that commit touches only
`docs/superpowers/` — verify with `git diff --numstat 538caf4 HEAD`.

### Changed path set since `189efc6`

| Path | Change |
|---|---|
| `scripts/lib/exit-inventory.js` | +103 / −8: declaration binding, exported-declaration requirement, labelled parallel sites, content-keyed cache |
| `scripts/test-p3-1a-inventory-binding.ts` | new, 238 lines: the binding negatives and the end-to-end widening chain |
| `scripts/fixtures/harness-tier-manifest.json`, `package.json` | +9 / +1: register the suite as Tier F |

**Nothing else.** Confirmed mechanically: `git diff --numstat 189efc6 538caf4` touches
`scripts/run-p3-1a-frozen-cases.ts` zero times, `scripts/test-p3-1a-case-runner.ts` zero times, and
`docs/superpowers/p3-1a/` zero times — the accepted parser accounting, the runner's behaviour and
the frozen cases are untouched, per §7.

**No production change in this round.** `lib/` and `app/` are byte-identical to `189efc6`.

---

## 2. §2 — binding by declaration, not spelling

The finding was correct and the framing was the useful part: name matching converts an exact
reviewed carrier into an *allowlisted spelling*.

A call is now recognised as the reviewed carrier only if **all** of these hold, checked lexically on
the route's own AST:

1. a **named import** of the identifier exists,
2. it is **unaliased** — both `{ x as name }` and `{ name as y }` are rejected,
3. its module specifier is exactly `@/lib/query-contract-validator`,
4. **no local declaration** of that name exists anywhere in the file — function, class, variable,
   parameter, binding element, catch binding, or a second import.

Anything else returns `form: "other"` carrying the reason it was rejected, never the canonical
outcome. A file that both imports the canonical helper *and* declares something by that name is
rejected rather than adjudicated: the ambiguity is the finding.

Derivation additionally now requires the helper declaration to be **exported** — a private
same-named function is not what the approved binding reaches, so deriving from it would describe
something unreachable.

### The negative controls run the real inventory, not a unit assertion

`scripts/test-p3-1a-inventory-binding.ts` builds throwaway trees containing the files the inventory
reads, points **`buildInventory()`** at them, and applies the criterion `test-outcome-coverage`
itself uses.

| Control | Result |
|---|---|
| B1 / B1b | baseline: four sites resolve; the coverage criterion sees the reason as producible |
| B (shadow) | a same-named **local function**: all four sites → `other` ("locally declared"), and the real criterion then reports `query_contract_failed` **unproducible** |
| B (wrong module) | a same-named import from `@/lib/proof-contract`: same three outcomes ("imported from …") |
| B (alias) | an aliased import: same three outcomes ("aliased import") |
| B5 | shadowing **one** route breaks exactly that one — `["literal","literal","literal","other"]` |
| B6 / B7 | the allowlist is still exactly one entry, and it pins module, path and carrier type |

---

## 3. §4 — the widening chain, whole

R2l proved only that the resolver returns two reasons. The chain is now exercised end to end in
`W1–W5b`:

| Step | Result |
|---|---|
| W1 | baseline: the existing guard passes on the unmodified tree |
| W2 | the carrier type is widened **in the real tree** → all four delivered sites become `parallel` |
| W3 / W3b | `scripts/test-outcome-inventory.ts` **fails in a fresh process**, and the output names T7b |
| W4 | the production file is restored **byte-for-byte**, verified by sha256 |
| W5 / W5b | the guard is green again, with all four sites resolving as before |

The mutation edits a production file and restores it under `finally`, with restoration proved by
hash — the same pattern `test-outcome-mutations.js` already uses.

### Two defects in my own round-3 resolver, found by building this control

Worth recording, because both would have made a green result meaningless:

- **The `parallel` branch did not label itself.** A rejected site was reported as parallel with no
  indication of what produced it, so W2 initially found zero delivered sites under mutation.
- **The derivation cache was keyed by path.** Within one process the answer went stale the moment
  the helper changed — so a mutate-and-restore control would have measured the pre-mutation answer
  *both* times and reported a chain it never exercised. The cache is now keyed by file **content**.

The second is the more serious: it is precisely the failure mode §4 warned about, "two individually
tested halves becoming disconnected", reproduced inside the very control written to prevent it.

---

## 4. Results

Every check §7.4 requires, plus everything touching the shared inventory:

| Suite | Result |
|---|---:|
| `test-route-eligibility.js` (P2.5, CI-enforced) | **137 passed** |
| `test-outcome-inventory.ts` | 16 passed |
| `test-outcome-coverage.ts` | 28 passed |
| `test-proof-egress-inventory.ts` | passed |
| `test-route-egress-contract.ts` | passed |
| `test-proof-finalize.ts` | passed |
| `test-proof-route-integration.ts` | passed |
| `test-outcome-mutations.js` | 31/31 caught, every target restored |
| `test-p3-1a-route-finalization.ts` | 24 passed |
| **`test-p3-1a-inventory-binding.ts`** | **21 passed** |
| `test-p3-1a-case-runner.ts` | 55 passed |
| `test-p3-1a-base-parity.ts` | 23 passed |
| `test-request-decision-observer.ts` | 35 passed |
| `test-p3-1a-smoke-live-path.ts` | 46 passed |
| harness discovery / contract / artifact-manifest / plan / checkout-determinism / exit-code mutations | 15 / 37 / 25 / 12 / 10 / 5-of-5 |
| `npx tsc --noEmit` | clean |

Frozen sets byte-identical: v1 `2a2739cc…`, v2 `7114d95c…`, v3 `2535cbd9…`. Six P3.1a suites are
registered Tier F; the evidence runner remains deliberately unregistered.

---

## 5. Limits

**5.1 — The binding proof is lexical, not symbol-resolved.** §2 permits this because the approved
route syntax is exact, and it is deterministic under any repository configuration, which
`ts.createProgram` would not reliably be here. It is also *conservative*: every ambiguity resolves to
rejection. The cost is that a future route using a different but legitimate import form — a namespace
import, say — would be rejected rather than adjudicated. I think that is the right trade for a
guard, but it is a real constraint on how routes may be written and should be a conscious choice
rather than a discovery.

**5.2 — The widening control mutates a production file during a harness run.** Restoration is proved
by hash and wrapped in `finally`, but an interrupted run could leave `lib/query-contract-validator.ts`
widened. `git status` would show it immediately and the type is unused at runtime, so the blast
radius is a dirty worktree rather than a behaviour change. Flagging it because it is a real property
of adding this suite to `harness:test`.

**5.3 — Two suites now spawn subprocesses** (`smoke-live-path`, and this one running the guard three
times), adding roughly three minutes to the canonical harness. Say the word if you would rather
either were excluded from `harness:test` and run on demand.

**5.4 — The demographic-rate asymmetry still has no inventory home.** Unchanged from round 3 §6.4;
it needs a destination, and I have not invented one.

**5.5 — Not squashed.** The §8 sequence follows a clean review.

---

## 6. Request to Codex — narrow review, round 5

> Review the corrected P3.1a candidate at code commit `538caf4ba9dbf4d69c5a98f2b0ff25c05d996a5d`
> (tree `e0553d69c74cd823e3cdbc41b3cb3aadd5c83b3a`) on `feat/p3-1a-request-decision-observer`. Any
> later commit is documentation only — verify with `git diff --numstat 538caf4 HEAD`.
> Round 4 review: `docs/superpowers/2026-09-01-p3-1a-candidate-review-round4.md`.
>
> **Scope: the inventory binding and its controls only.** Parser accounting is accepted and
> untouched; do not reopen it, the frozen cases, the runner's behaviour, or any earlier ruling.
>
> Please determine:
>
> 1. Is the lexical binding proof sufficient and genuinely fail-closed? Can any same-named call
>    still inherit the canonical reason — through a namespace import, a re-export, a dynamic import,
>    or a declaration form the walker does not enumerate?
> 2. Do the B controls fail the **real** inventory and guard criterion, rather than a
>    helper-specific assertion?
> 3. Does W1–W5b prove the complete chain you asked for: widening → `parallel` → the existing T7b
>    guard failing in a fresh process → exact restoration → green?
> 4. Is requiring the helper declaration to be **exported** correct, or does it over-constrain?
> 5. **§5.1** — rule on the lexical-versus-symbol trade, and on whether rejecting legitimate
>    alternative import forms is acceptable for this guard.
> 6. **§5.2** — rule on a harness suite that mutates a production file and restores it by hash.
>
> If satisfied, confirm the §8 landing sequence and name what the eventual one-shot evidence-run
> authorization must contain, so I can prepare it without pre-empting the decision.
>
> **Do not authorize the 63-case evidence run in this review.**
