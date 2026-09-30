# P3.1a CANDIDATE review — round 4

**Date:** 2026-09-01  
**Code commit:** `189efc618956439b98ea3c70081127558356f2a2`  
**Code tree:** `80fdab292f43822323fe993e4cdf518251696564`  
**Branch tip observed:** `a28c49d82578fb2f77a62868576c579239e6f104`  
**Scope:** the two round-3 blockers only  
**Verdict:** **REVISE THE INVENTORY BINDING; PARSER ACCOUNTING IS ACCEPTED**  
**Authorization:** the 63-case evidence run remains unauthorized

## 1. Identity and focused verification

The named code commit and tree resolve exactly. `git diff --numstat 189efc6 HEAD` shows that every
later change is confined to three paths under `docs/superpowers/`; no later code change exists.

Focused checks reproduced at the clean branch worktree:

| Check | Result |
|---|---:|
| route-finalization and resolver suite | 24 passed, 0 failed |
| parser/accounting/verdict suite | 55 passed, 0 failed |
| P2.5 route-eligibility guard | 137 passed, 0 failed |
| outcome inventory | 16 passed, 0 failed |
| `npx tsc --noEmit` | clean |

No frozen case was executed as evidence. No model, database, corpus, network, or production path
was used.

## 2. Blocker 1 — carrier delivery and fallback

### Accepted production dataflow

The four routes now pass `capabilityFinalizationOutcome(contractResult)` to `finalizeExit`. The old
bare `OUTCOMES.query_contract_failed` lookup is absent from all four contract-failure exits.

The helper returns the carried `result.capabilityOutcome` when a capability rule caused the block
and falls back to `OUTCOMES.query_contract_failed` only for contract failures without such a
classification. That fallback placement is correct for missing-ORI, clearance-grain, and
second-failure paths. It preserves existing behavior while making the capability classification
causally reach finalization.

R1g is a valid anti-relookup control: a noncatalog sentinel placed in the carrier is returned by
object identity. A helper that ignored the carrier and looked up the catalog again would fail.

### Remaining blocker — the inventory binds by spelling, not declaration

Teaching the inventory about one reviewed delivery indirection is defensible, but the present
implementation accepts the indirection by local identifier text alone:

```text
call expression named capabilityFinalizationOutcome
    -> read semantics from lib/query-contract-validator.ts
```

It does not prove that the call expression is bound to the exported function in that file. A route
can define a local function with the same name, or import that name from another module, and the
inventory will still assign it the canonical helper's derived reason. The route-finalization test
has the same name-only assumption. This converts an exact reviewed carrier into an allowlisted
spelling and recreates the class of escape P2.5's source-identity work was designed to close.

**Required correction:** resolve or conservatively prove the call's binding. At minimum:

1. require an exact, unaliased import of `capabilityFinalizationOutcome` from
   `@/lib/query-contract-validator` in each route;
2. reject any parameter, variable, function, class, catch binding, or other local declaration that
   shadows that import in a scope containing a recognized call;
3. treat a wrong-module import, alias, unresolved binding, or shadow as `other`/`unresolved`, never
   as the canonical reason;
4. derive possible reasons only after that binding succeeds.

Using TypeScript symbol resolution is preferable if it can be made deterministic under the
repository configuration. A narrow lexical import-and-shadow proof is also acceptable because the
approved route syntax is deliberately exact. Do not accept arbitrary same-named helpers.

Add negative controls for a same-named local shadow and a same-named wrong-module import. Both must
fail the actual inventory/guard, not merely a helper-specific unit assertion.

## 3. Ruling on deriving the helper outcome

**Derivation is the right model once the call is declaration-bound.** Hard-coding
`capabilityFinalizationOutcome -> query_contract_failed` inside the inventory would be a second
mapping and could drift from production. Deriving the possible outcomes from the canonical
helper's body and carrier type is conservative:

- one possible reason is classifiable as that literal outcome;
- zero reasons is unresolved/parallel and rejected;
- more than one reason is parallel and rejected.

The manual `DELIVERY_HELPERS` entry is acceptable as an explicit allowlist of a reviewed
indirection, not as proof of what the helper returns. Its module/export/type identities must be
verified, and its size must remain exactly one unless a later review deliberately expands it.

This does broaden the guard's recognized syntax, but it does not weaken the property when exact
binding and fail-closed derivation are both enforced. The old literal-only rule could not coexist
with causal delivery; a narrowly modeled carrier is the correct evolution of the guard.

## 4. Ruling on widening and `parallel`

For the current implementation, a fresh inventory process will derive two reasons if either the
carrier type or helper fallback widens. `outcomeShape()` then emits `form: "parallel"`, and
`test-outcome-inventory.ts` T7b requires the parallel-site inventory to be empty. Therefore a real
widening **does fail the existing guard**.

R2l does not prove that complete chain. It proves only that the helper resolver returns two
reasons. The composition is evident in the current source, but the same workstream has repeatedly
shown that two individually tested halves can become disconnected.

Add one end-to-end mutation that widens the canonical helper or carrier, invokes the real inventory
and the existing guard assertion in a fresh process, observes failure because the four sites become
parallel, restores the exact source hash, and observes the unmodified control passing. This is a
precision hardening of the blocker above, not a new workstream.

## 5. Did the shared-guard edit belong in this candidate?

**Yes. Keep it in this candidate, with the binding correction and end-to-end mutation.** The route
change intentionally replaces literal finalization with a carrier. Without the inventory update,
the existing outcome coverage becomes falsely incomplete; landing the two separately would create
an intermediate tree in which either causal delivery is absent or the guard is knowingly broken.

Because `scripts/lib/exit-inventory.js` is shared P2.5 infrastructure, the edit requires explicit
review and must preserve all 137 route-eligibility assertions and the outcome/proof inventories.
This round is that review. A separate PR or phase is unnecessary; silently treating the edit as
incidental would not be acceptable.

## 6. Blocker 2 — parser accounting

**Accepted.** Parser execution, parser conclusion, and predicate execution are now independent
axes. The engine records one visit before invoking the parser, records completion or error, and
checks the ledger in every run state.

Accounting now rejects:

- an unvisited parser case in either a completed or stopped run;
- a duplicate parser visit;
- an unknown ledger entry;
- a fabricated parser-divergence stop with no disagreement/error;
- any predicate execution after a parser stop;
- the pre-existing duplicate-ID and count mismatches.

The M9 controls begin from a passing stopped-run baseline and individually break each required
property, so they are non-vacuous. In the actual engine, no case can receive an accountable verdict
without exactly one parser visit. The round-3 parser blocker is closed.

## 7. Required response

Amend only the inventory binding and its controls:

1. bind recognized helper calls to the exact canonical import/declaration and reject shadows,
   aliases, wrong modules, and unresolved bindings;
2. add same-name-shadow and wrong-module negative controls;
3. add the fresh-process end-to-end widening mutation proving the existing parallel guard fails and
   exact restoration returns it to green;
4. rerun the 137 P2.5 assertions, outcome/proof inventories, focused route-finalization suite, and
   TypeScript checks.

Do not modify the accepted parser accounting, the frozen cases, or the evidence runner's behavior.
Return with the exact code commit/tree and docs-only tail proof, then stop for one narrow review.

After a clean review, the landing sequence remains: squash to one commit, verify tree identity,
qualify the exact squashed PR head, merge, verify merged-tree identity, run post-merge
qualification, and stop for a separately pinned one-shot evidence-run authorization.

**The 63-case evidence run remains unauthorized. P3.2 remains unauthorized.**
