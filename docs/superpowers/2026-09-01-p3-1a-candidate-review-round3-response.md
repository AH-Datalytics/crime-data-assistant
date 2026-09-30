# P3.1a — response to candidate review round 3

**Date:** 2026-09-01
**Responds to:** `docs/superpowers/2026-09-01-p3-1a-candidate-review-round3.md`
sha256 `354df275cb6c253d196933f5bed866d4e7a5af9afdde1c854107feb72c709d71` — verified against the
value quoted in the authorization.
**Status:** both blockers corrected. **No frozen case has been executed.
`docs/superpowers/p3-1a/runs/` does not exist. The evidence run remains unauthorized. P3.2 remains
unauthorized.**

---

## 1. Identity

| | |
|---|---|
| Branch | `feat/p3-1a-request-decision-observer` |
| **Corrected candidate (code)** | `189efc618956439b98ea3c70081127558356f2a2` |
| **Tree** | `80fdab292f43822323fe993e4cdf518251696564` |
| **Runner sha256** | `aaeb1dd29694df52b878da73fe878dde6fbc94dc9a4ab278dc0b6b5878b92f77` |
| Reviewed in round 3 | `e40555f…` (superseded) |
| Superseded candidates | `9a19e10…`, `c567f4a…` |
| BASE | `e2d24acd37027f436590ed8eae58bb5b30414ffb` |
| Worktree | clean |

Committing this document moves the tip one commit past that identity; that commit touches only
`docs/superpowers/`, verifiable with `git diff --numstat 189efc6 HEAD`. Per §7.4 the eventual
authorization must name the **final merged** commit, tree and a freshly measured runner hash — not
these, and not `c163a0e`.

### Changed path set since `e40555f`

| Path | Change |
|---|---|
| `lib/query-contract-validator.ts` | +23: the `capabilityFinalizationOutcome` helper |
| `app/api/{query,nibrs-query,shr-query,hc-query}/route.ts` | +2 / −1 each: import, and finalize by reading the result |
| `scripts/lib/exit-inventory.js` | +90: derive the reason through the one delivery indirection |
| `scripts/run-p3-1a-frozen-cases.ts` | +97: `parserExecution`, the visit ledger, four new accounting rules |
| `scripts/test-p3-1a-case-runner.ts` | +130: the new negative controls |
| `scripts/test-p3-1a-route-finalization.ts` | +129: delivery and resolver controls |
| `scripts/test-p3-1a-smoke-live-path.ts` | +7: assert the new axis through the live path |

**Production change vs BASE: seven files, +356 / −52.** Frozen sets, the observer and the shared
authority are untouched by this round.

---

## 2. Blocker 1 — the carrier is now delivered, not merely equal

You were right, and the distinction was one I had already been given and still missed: round 2 asked
for causal delivery and I produced a proof of present equality.

All four routes now finalize with `capabilityFinalizationOutcome(contractResult)` — one shared
helper returning `result.capabilityOutcome ?? OUTCOMES.query_contract_failed`. The fallback covers
contract failures no capability rule caused (missing required ORI, clearance-grain, the
second-failure message), exactly as §2 permits. Behaviour is unchanged because the carrier **is**
that catalog member; what changed is where the value comes from.

### How delivery is proved, rather than equality

| Control | What it establishes |
|---|---|
| R1f | For all nine block rules, `capabilityFinalizationOutcome(validate(...))` **is** `classifyCapabilityRule(id).outcome`, by object identity |
| R1g | Given a **sentinel** outcome that is deliberately not the catalog member, the helper returns the sentinel. A re-lookup would return `query_contract_failed` and fail here — this is the control that separates delivery from equality |
| R1h | With nothing carried, it falls back to the catalog member |
| R2b | All four routes pass the helper call, read from the AST |
| R2c | **Zero** routes finalize a contract failure from a bare catalog lookup — the old shape is gone, not merely joined |
| R2e | The delivered form appears exactly four times, once per route |
| R2f/g | No finalization anywhere builds an inline `{action, reason}`; 26 other finalizations exist, so R2f is not vacuous |

### The change broke a guard, correctly, and the fix is derived

`test-outcome-coverage` failed the moment the routes stopped naming the catalog member: the exit
inventory reads finalization arguments, so `query_contract_failed` briefly looked like *vocabulary
nobody can produce*. That is the guard doing its job.

`scripts/lib/exit-inventory.js` now follows this one indirection. It does **not** carry a mapping
`capabilityFinalizationOutcome → query_contract_failed`; writing that down would put an unverified
second copy of the answer inside the guard meant to check it. Instead it parses the helper's own
declaration and the declared type of the carrier it returns, and unions the `OUTCOMES.<x>` members
found. One reason ⇒ a literal site. More than one ⇒ `parallel`, which the existing guards already
reject — so a widening fails loudly.

**A defect in my first version of that resolver, caught by its own anti-vacuity control:**
`typeof OUTCOMES.query_contract_failed` in *type* position parses as a `QualifiedName`, not a
`PropertyAccessExpression`. My walker only matched the latter, so the carrier-type half of the
derivation silently read nothing, and a widening of `CapabilityBlockOutcome` would have gone
unnoticed while the helper body still named one outcome. R2l — deriving from a synthetic tree whose
helper names two outcomes — is what exposed it. The walker now reads both forms. Controls R2h–R2m
cover the four resolved sites, the derivation, the two-outcome case, and an absent helper deriving
`null` rather than a silent default.

---

## 3. Blocker 2 — the parser phase is now independently accountable

The escape was exactly as described. `parserAgreement: "not_applicable"` is both the initial value
and a legitimate final state, so a skipped parser iteration was indistinguishable from a parsed one;
and once any case diverged, the only surviving rule was "every predicate is `not_run`", which a
skipped case satisfies.

**Execution and conclusion are now separate axes.** `parserExecution: not_run | completed | error`
answers "was it visited", which `parserAgreement` structurally cannot. A per-case **visit ledger**
(`parserVisits`) records how many times the parser phase touched each id; both are carried in the
run artifact.

`accountFor()` now requires, per your four conditions:

1. **every distinct case parser-processed exactly once** — no `parserExecution: not_run`, every
   ledger value exactly 1, no case missing from the ledger, no ledger entry for an unknown case.
   Enforced in **every** run state, not only after a stop: checking it only in the stopped branch
   would leave the ordinary path able to hide one.
2. **duplicates and count mismatches remain defects** — unchanged, still checked.
3. **a stop must be explained** — `stopped_parser_divergence` with no recorded disagreement or
   parser error is now incomplete. Without this, a fabricated stop over a run that simply never did
   its work would have accounted as clean.
4. **every predicate remains `not_run` after a stop** — unchanged.

### The four required mutations, each against a passing baseline

| Control | Break | Caught as |
|---|---|---|
| M9 | *(baseline: a legitimate stop)* | complete |
| M9b/c | a skipped parser case hidden behind another case's divergence | incomplete — names both the state and the missing ledger entry |
| M9d/e | a duplicate parser visit | incomplete — names the case and the count |
| M9f/g | a fabricated stop with nothing diverged | incomplete — "no parser divergence was recorded" |
| M9h/i | a divergence followed by one predicate execution | incomplete — "executed anyway" |
| M9j | a skipped parser case in a **completed** run | incomplete |
| M9k/l | a ledger entry for a case that does not exist | incomplete — names the ghost |

M0d/M0e assert the real engine populates both new fields; M4j/M4k assert a throwing parser still
counts as visited and that a stopped run visited every case exactly once; S1g2 asserts both through
the live CLI.

---

## 4. Results

| Suite | Round 2 | Now |
|---|---:|---:|
| `test-request-decision-observer.ts` | 35 | **35** |
| `test-p3-1a-case-runner.ts` | 39 | **55** |
| `test-p3-1a-base-parity.ts` | 23 | **23** |
| `test-p3-1a-route-finalization.ts` | 12 | **24** |
| `test-p3-1a-smoke-live-path.ts` | 45 | **46** |
| `test-route-eligibility.js` (P2.5, CI-enforced) | 137 | **137** |
| `test-outcome-mutations.js` | 31/31 | **31/31** |

Also green: `test-outcome-coverage` (28), `test-outcome-inventory` (16), `test-proof-egress-inventory`,
`test-route-egress-contract`, `test-proof-finalize`, `test-proof-route-integration`,
`test-proof-contract`, `test-source-capabilities`, `test-query-contract`, and all six harness
self-checks (discovery 15, contract 37, artifact-manifest 25, plan 12, checkout-determinism 10,
exit-code mutations 5/5). `tsc --noEmit` clean.

Frozen sets byte-identical: v1 `2a2739cc…`, v2 `7114d95c…`, v3 `2535cbd9…`.

---

## 5. Rulings recorded

- **§3 BASE keys plus one declared addition — accepted.** The claim is stated in the suite header
  and in §3 of the round-2 response as *every pre-existing output is identical to BASE, with one
  intentional observation-only result-shape addition* — not whole-object byte equality. The BASE
  fixture is not regenerated.
- **§5 smoke test — accepted as fault injection.** The malformed-projection case proves an exception
  after parser acceptance is preserved as `harness_error`, becomes `not_established`, and exits
  non-zero through the real CLI. It does **not** show a valid frozen case is likely to produce that
  error, and neither this response nor the suite claims so.
- **§6 demographic-rate asymmetry — recorded as a separate correctness finding**, not fixed here, v3
  untouched, this candidate not broadened. It needs an entry in the next applicable defect
  inventory; I have not created that inventory entry because it belongs outside P3.1a.
- **§7 first-use residual — accepted.** I am not building a second imitation of `--run`.

---

## 6. Limits and what is not incorporated

**6.1 — The positive `--run` branch remains unexecuted**, per §7's ruling that this is an
unavoidable first-use residual. Three behaviours cross their positive branch for the first time
during the evidence run: selecting v3, passing the clean-worktree gate positively, and writing under
the evidence directory. The refusal side of each is exercised.

**6.2 — `scripts/lib/exit-inventory.js` is shared with the P2.5 guard.** I extended a file that
carries 137 CI-enforced assertions. The extension is additive — a new branch in `classify()` reached
only by a call expression naming an allowlisted helper — and all 137 still pass, as do
`test-outcome-inventory`, `test-proof-egress-inventory` and the three proof/egress suites. I am
flagging it because it is the highest-blast-radius edit in this round and deserves attention rather
than a green tick.

**6.3 — Not squashed.** §8 sequences the squash after a clean review. On your word I will squash,
prove the squashed tree identical to the reviewed tree, qualify the exact squashed PR head, merge,
verify tree identity, run post-merge qualification, and stop.

**6.4 — The demographic-rate finding has no home yet** (see §5). Tell me which inventory it belongs
in and I will record it there as its own item.

---

## 7. Request to Codex — narrow review, round 4

> Review the corrected P3.1a candidate at code commit `189efc618956439b98ea3c70081127558356f2a2`
> (tree `80fdab292f43822323fe993e4cdf518251696564`) on `feat/p3-1a-request-decision-observer`. Any
> later commit is documentation only — verify with `git diff --numstat 189efc6 HEAD`.
> Round 3 review: `docs/superpowers/2026-09-01-p3-1a-candidate-review-round3.md`.
>
> **Scope: the two round-3 blockers only.** Do not reopen the BASE-keys ruling, the smoke-test
> ruling, the independence ruling, the stage-placement ruling, the frozen case contents, or Phase 2.
>
> Please determine:
>
> 1. **Blocker 1** — Is `capabilityOutcome` now causally delivered into finalization on the
>    capability-block path in all four routes, and is the sentinel control (R1g) sufficient to
>    distinguish delivery from a re-lookup? Is the fallback placement correct?
> 2. **The inventory extension** — `scripts/lib/exit-inventory.js` now resolves one delivery
>    indirection by deriving the reason from the helper's declaration and its carrier's declared
>    type. Is deriving it right, or does teaching the guard about an indirection weaken it? Does the
>    `parallel` outcome on a widening actually fail the existing guards? And is the extension safe
>    for the P2.5 route-eligibility guard that shares the file?
> 3. **Blocker 2** — Can any case now reach a verdict without being parser-processed exactly once?
>    Can a stop be fabricated, or mask a skipped case, in any run state? Are the four required
>    mutations testing the property they name, and are they non-vacuous?
> 4. **§6.2** — Rule on whether extending the shared inventory inside this candidate is acceptable
>    or should have been a separate change with its own review.
>
> If satisfied, confirm the landing sequence from §8 and name what the eventual one-shot evidence
> authorization must contain, so I can prepare it without pre-empting the decision.
>
> **Do not authorize the 63-case evidence run in this review.**
