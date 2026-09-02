# P3.1a CANDIDATE review - round 6

**Date:** 2026-09-01  
**Code commit:** `49292fc8b3965db05ad701802c2f20c1917b6aec`  
**Code tree:** `0a3fba562d216a1f0eca55a390516fee7c6a7ea9`  
**Branch tip observed:** `ebee55dc65d86389dbf1c92f233fb9ec7bc60574`  
**Scope:** the two round-5 blockers only  
**Verdict:** **REVISE - REMOVE SHARED GIT-METADATA MUTATION FROM THE CANONICAL TEST**  
**Authorization:** the 63-case evidence run remains unauthorized

## 1. Identity and review boundary

The named code commit resolves to the named tree. `git diff --numstat 49292fc HEAD` contains only:

- `docs/superpowers/2026-09-01-p3-1a-candidate-review-round5-response.md`; and
- `docs/superpowers/2026-09-01-p3-1a-execution-record.md`.

No later code change exists. Parser accounting, the frozen cases, and the runner were not reopened.

I did not execute `test-p3-1a-inventory-binding.ts`. The implementation under review creates and
removes a linked worktree in the repository's shared Git metadata and invokes a repository-wide
`git worktree prune`; deciding whether that is permissible must precede executing it.

Safe focused checks from the prior round remain applicable to the unchanged guarded code: the P2.5
route-eligibility guard passed 137/137, the outcome inventory passed 16/16, and TypeScript was clean.
No frozen case was executed.

## 2. Type-only binding correction - accepted

The correction checks both erasure forms at the place where the binding is established:

- `ImportClause.isTypeOnly` rejects `import type { x } from "..."`; and
- `ImportSpecifier.isTypeOnly` rejects `import { type x } from "..."`.

Both enter the same fail-closed `problems` path before `importedCorrectly` can be set. The B-series
controls exercise complete throwaway trees through the real `buildInventory()` result, verify that
all four canonical value-import sites remain literal, verify both type-only forms become `other`,
and localize a one-route type-only mutation. This satisfies round 5.

No other accepted import form lacks a runtime value binding. To be accepted, the implementation now
requires an unaliased named value import from the exact canonical module. Namespace calls and dynamic
import calls have property-access callees rather than the required identifier callee. Barrel/re-export
imports fail the exact module string. Destructured dynamic imports create a local declaration without
the required static import. Default imports, import-equals, aliases, wrong-module imports, and local
shadows also fail closed. A local type-only declaration such as an interface can coexist with the
runtime import, but it does not replace or shadow the runtime value binding and is not an escape.

## 3. Re-export shims - accepted

The files called stubs are module-resolution shims, not behavioral fakes. Each shim's entire behavior
is an absolute `require()` of the package installed under the shared checkout:

```text
disposable node_modules/typescript       -> real installed typescript
disposable node_modules/better-sqlite3   -> real installed better-sqlite3
```

The actual guard, actual inventory source, actual migration source, and actual native/database package
are therefore executed. The isolated baseline must pass before the widening result is considered, so a
missing or newly required third dependency fails the control rather than masquerading as a successful
mutation. Installing these two ignored resolution shims does not weaken the claim that the tracked source
is the real source plus the one declared tracked mutation.

Keep the shim list exact and the green-baseline requirement. Do not replace either shim with a mock API.

## 4. Remaining blocker - a canonical test must not alter the shared worktree registry

The production source-file hazard is closed: no link exists, the shared validator is never written, and
recursive deletion cannot escape through the two ordinary shim directories. That part is correct under
termination.

But the isolation is incomplete at the repository level. `git worktree add` writes registration and lock
state under the repository's common `.git/worktrees`; `git worktree remove` and `git worktree prune` mutate
the same shared namespace. Under interruption the test can leave a registered worktree and temporary
directory. Under concurrent developer or harness activity, the global `prune` can act on stale records
that this test does not own. The test's unique filesystem path does not make the common Git metadata
unique.

This is not acceptable for a canonical Tier F test that can run in a developer checkout. The prior review
allowed a disposable worktree in principle; the concrete implementation exposes the common-metadata and
global-prune effects that the abstract option did not address. The ruling is therefore narrowed, not
silently reversed: a disposable **independent repository/tree** is acceptable; a linked worktree registered
in the checkout under test is not.

**Required correction:** build the W-series tree without changing the source repository's Git metadata.
Acceptable forms include:

1. export the exact committed tree with `git archive`, then initialize a new independent temporary Git
   repository solely so `status` and `diff --numstat` can measure the declared mutation; or
2. copy the complete tracked file set from the exact commit into a temporary directory and compare a
   complete path/hash manifest before applying the one mutation.

The disposable repository may contain the same two re-export shims. It must run the actual guard in a
fresh process, prove the unmutated baseline green, prove exactly one tracked file and one line changed,
prove four parallel sites, and prove T7b fails. Teardown may delete only the independently rooted temp
directory. It must not call `git worktree add`, `git worktree remove`, or `git worktree prune` against the
source repository.

## 5. Junction incident ruling

### 5.1 Operational repair is sufficient

The incident is serious and the causal account is credible: a recursive teardown traversed a junction
into the real dependency directory. Removing links entirely is the correct fix; sequencing unlink and
delete would remain crash-sensitive.

Read-only verification during this review found:

- `npm ls --depth=0` completes successfully;
- `@anthropic-ai/sdk`, `typescript`, and `better-sqlite3` are present;
- `node_modules/.bin` exists with 72 entries;
- the working `package-lock.json` has SHA-256
  `a15b272f6ada4cac930cc1055e869946ea29042d66637248204ebd3d005b66c2`;
- Git reports no content diff for `package-lock.json`, and its filtered object identity equals
  `HEAD:package-lock.json`; and
- the candidate's TypeScript and focused guards execute successfully against the repaired installation.

That is enough to treat the declared dependency installation and toolchain as operationally repaired.

### 5.2 Exact pre-incident restoration is not provable

There was no byte/path inventory of the untracked `node_modules` tree before the incident. Consequently,
the record may say that the declared dependency graph and required tools were restored, but it cannot say
that every pre-incident untracked package or file was restored exactly. `npm ls` also reports several
extraneous transitive packages; there is no evidence in this review that they are damage, but their prior
state is unknown.

Record that limitation in the execution record. No further package mutation is warranted merely to make
the unprovable claim appear cleaner.

One precision note should also be recorded: the main checkout still displays `package-lock.json` as
worktree-modified in `git status`, despite an empty content diff and matching content identity. Therefore
describe the bytes/content as restored; do not describe the already-dirty main checkout as clean or omit
the observable status entry.

The response document already contains the necessary cause, impact, repair commands, and prevention.
Adding the concise incident classification and residual above to the execution record is sufficient; a
new workstream is not needed.

## 6. Required response

Return a narrow response covering only:

1. replacement of the linked worktree with an independent temporary export/repository that never mutates
   the source repository's Git metadata;
2. preservation of W1-W7's real-source, fresh-process, green-baseline, one-mutation, and actual-T7b proofs;
3. the incident residual recorded as: declared dependencies/toolchain restored, exact pre-incident
   `node_modules` contents unprovable, and the package-lock status/content distinction; and
4. focused results and confirmation that type-only binding, parser accounting, runner, and frozen cases
   were untouched.

Do not execute or authorize the 63-case evidence run. Landing sequence and the one-shot evidence-run
authorization remain premature until this correction receives a narrow clean review.
