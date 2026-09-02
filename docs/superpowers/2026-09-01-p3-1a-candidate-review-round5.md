# P3.1a CANDIDATE review - round 5

**Date:** 2026-09-01  
**Code commit:** `538caf4ba9dbf4d69c5a98f2b0ff25c05d996a5d`  
**Code tree:** `e0553d69c74cd823e3cdbc41b3cb3aadd5c83b3a`  
**Branch tip observed:** `20b53cdd199207e572ce7af142834cacc4ed164e`  
**Scope:** inventory binding and its controls only; parser accounting remains accepted and was not reopened  
**Verdict:** **REVISE - ISOLATE THE MUTATION CONTROL AND REJECT TYPE-ONLY IMPORTS**  
**Authorization:** the 63-case evidence run remains unauthorized

## 1. Identity and focused verification

The named commit resolves to the named tree. `git diff --numstat 538caf4 HEAD` contains only these
documentation changes:

- `docs/superpowers/2026-09-01-p3-1a-candidate-review-round4-response.md`
- `docs/superpowers/2026-09-01-p3-1a-candidate-review-round4.md`
- `docs/superpowers/2026-09-01-p3-1a-execution-record.md`

No later code change exists.

Focused checks run from the candidate worktree:

| Check | Result |
|---|---:|
| P2.2 outcome inventory | 16 passed, 0 failed |
| P2.5 route-eligibility guard | 137 passed, 0 failed |
| `npx tsc --noEmit` | clean |

I did not execute `test-p3-1a-inventory-binding.ts`. Its widening control rewrites the real
`lib/query-contract-validator.ts` in this shared worktree, which is itself a review finding below.
No frozen case was executed. No model, database, corpus, network, or production path was used.

## 2. Ruling on lexical binding

### 2.1 Lexical proof is sufficient

A TypeScript symbol-resolution pass is not required here. The guard is allowed to define a deliberately
narrow, reviewed source form and fail closed on every other form. The current proof has the right core:

1. a named import must exist;
2. the imported and local names must both be exactly `capabilityFinalizationOutcome`;
3. the module specifier must be exactly `@/lib/query-contract-validator`;
4. a competing local declaration makes the call unbound;
5. helper semantics are derived only after that binding succeeds; and
6. the canonical helper file must still contain the exported function declaration.

Rejecting legitimate alternatives is acceptable and preferable to broadening this guard. An aliased
import, a barrel re-export, a namespace import, a default import, a CommonJS binding, or a dynamic import
may be valid application code, but changing to any of those forms must require an explicit guard review.
This is exact reviewed-syntax change control, not a general TypeScript linker.

The whole-file shadow scan is conservative: it can reject a declaration whose lexical scope does not
actually contain the call. That is also acceptable. False refusal here causes review; false acceptance
would silently assign canonical semantics to an unrelated call.

### 2.2 One remaining lexical false acceptance: type-only imports

`deliveryHelperBinding()` does not inspect either `ImportClause.isTypeOnly` or
`ImportSpecifier.isTypeOnly`. Therefore both of these satisfy `importedCorrectly` today:

```ts
import type { capabilityFinalizationOutcome } from "@/lib/query-contract-validator";
import { type capabilityFinalizationOutcome } from "@/lib/query-contract-validator";
```

Neither establishes the runtime value binding that the inventory claims to prove. A normal call will
usually fail typechecking, but the inventory must not outsource its identity proof to that separate gate;
a suppression comment can make that reliance especially misleading.

**Required correction:** type-only clauses and specifiers must be rejected as unbound, with controls for
both spellings against the real inventory result. A normal exact value import must remain green.

## 3. Same-named-call ruling

Subject to the type-only correction, no same-named call can inherit the canonical outcome through the
three forms named in the request:

- **Namespace import:** `ns.capabilityFinalizationOutcome()` is a property-access callee. The recognized
  indirection requires an identifier callee, so this remains `other` rather than canonical.
- **Re-export/barrel:** importing the name from a barrel fails the exact module-specifier check. Keeping an
  additional exact canonical import does not rescue a call through a namespace or alias, and a competing
  local same-named binding is rejected.
- **Dynamic import:** a property-access call on `await import(...)` is not an identifier callee. Destructuring
  it into the canonical local name creates a local declaration without the required exact static import,
  so it is rejected.

Wrong-module imports, aliases, local functions, variables, parameters, binding elements, classes, named
function expressions, and catch bindings also fail closed. The helper source itself remains pinned by its
derived declaration and content-keyed analysis; a re-export substituted for that declaration yields no
canonical reason.

## 4. Binding controls

The B-series control structure is accepted. It exercises `buildInventory()` on complete throwaway trees,
compares actual delivered-site classifications, proves one-route localization, and proves exact allowlist
accounting. That is materially stronger than testing `deliveryHelperBinding()` in isolation.

Add the two type-only cases to this same end-to-end control layer. Do not satisfy the correction with a
unit-only assertion about a helper return string.

## 5. Widening control

The semantic chain being tested is correct:

```text
widen production carrier
  -> derive multiple possible outcomes
  -> classify the delivery as parallel
  -> existing T7b guard fails
```

That is the right non-vacuity proof, and the real guard must still run in a fresh process. The problem is
where the mutation is applied.

### Blocker: do not rewrite a production source file in the shared checkout

`test-p3-1a-inventory-binding.ts` writes directly to the candidate worktree's real
`lib/query-contract-validator.ts`, then restores the saved bytes in `finally`. The before/after hashes and
green rerun prove restoration only when the process reaches those checks. They do not protect against:

- process termination, host shutdown, or test-runner teardown after the write;
- a concurrent reader observing the widened production source;
- a concurrent legitimate edit being overwritten by the `finally` restoration; or
- parallel canonical-harness invocations racing over the same path.

Registration in a canonical suite makes this more consequential, because the suite is run in developer
checkouts as well as disposable CI workspaces. An existing mutation test with the same pattern is precedent
to retire, not a safety argument for extending the pattern.

**Required correction:** perform W1-W5 in an isolated disposable tree or worktree and run the actual guard
against that isolated root in a fresh process. The mutation must never touch the shared checkout's
production path. Preserve all existing proof obligations: exact one-reason baseline, widened source with
two reasons, actual T7b failure naming the helper, fresh-process execution, and a green unmutated control.
Verify the shared source hash before and after as an assertion that it was never changed, not as a restore
mechanism.

An explicit repository-root parameter used by the inventory/guard is acceptable if it is production-neutral,
defaults to the real repository, and the control proves the disposable tree contains the real source plus
only the declared mutation. A disposable worktree is also acceptable. A copied parser reimplementation or
a helper-only simulation is not.

## 6. Required response

Return a narrow response covering only:

1. rejection of both type-only import forms, with end-to-end negative controls and a green value-import
   control;
2. replacement of shared-checkout mutation with an isolated, fresh-process execution of the actual guard;
3. the exact files changed and focused results; and
4. confirmation that parser accounting and the frozen case set were untouched.

Do not execute or authorize the 63-case evidence run. After these two corrections, the next review should
remain confined to their implementation and controls.
