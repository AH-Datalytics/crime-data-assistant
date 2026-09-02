# P3.1a Codex session handoff - after candidate review round 6

**Date:** 2026-09-01  
**Purpose:** resume the P3.1a review at the exact current boundary without reconstructing this long
conversation  
**Workspace:**
`C:\Users\jeffm\AppData\Local\Temp\claude\C--Users-jeffm\ff23c010-9397-43ac-a664-d23de1897aa1\scratchpad\wt-cand`

## 1. Governing objective

The program objective is 100% correct disposition: answer correctly when the system has adequate
support, otherwise qualify or refuse correctly. P3.1a is a bounded measurement increment. It adds a
request-decision observer over existing production capability predicates and measures those predicates
against an independently adjudicated frozen case set.

P3.1a is not P3.2. It does not authorize enforcement, production activation, production traffic,
model calls, database writes, or an expansion into unrelated correctness or security work.

## 2. Current checkpoint

### Repository identities

| Item | Identity |
|---|---|
| Branch | `feat/p3-1a-request-decision-observer` |
| BASE | `e2d24acd37027f436590ed8eae58bb5b30414ffb` |
| Last reviewed code commit | `49292fc8b3965db05ad701802c2f20c1917b6aec` |
| Last reviewed code tree | `0a3fba562d216a1f0eca55a390516fee7c6a7ea9` |
| Branch tip when round 6 was written | `ebee55dc65d86389dbf1c92f233fb9ec7bc60574` |
| Frozen cases v3 | `2535cbd934a4766a7f9ff8570f5b0e60d04b7c37430283b48e52b206c75a0b91` |
| Frozen-case bytes | 112,928, LF |

At the last identity check, `git diff --numstat 49292fc HEAD` showed documentation-only changes.

### Current review verdict

Round 6 verdict: **REVISE - REMOVE SHARED GIT-METADATA MUTATION FROM THE CANONICAL TEST.**

The full ruling is:

`docs/superpowers/2026-09-01-p3-1a-candidate-review-round6.md`

The 63-case evidence run remains unauthorized and has never begun. The expected run directory
`docs/superpowers/p3-1a/runs/` did not exist at the last check.

### Concurrent/in-progress correction detected

When this handoff was written, the candidate worktree contained one uncommitted modification:

`scripts/test-p3-1a-inventory-binding.ts`

The diff appears to be Claude's in-progress round-6 correction. It replaces the linked-worktree design
with an independent temporary clone made with `git clone --no-hardlinks`, uses its own Git metadata,
and removes `git worktree add/remove/prune` from the test. This change is **not reviewed, not committed,
and not accepted yet**. It belongs to the ongoing correction. Do not overwrite, restore, discard, or
attribute it to the user without first reconciling the current status and Claude's eventual response.

The round-6 Codex review document is also untracked. Preserve it.

## 3. Read order

Read only what is needed, in this order:

1. `docs/superpowers/2026-09-01-p3-1a-candidate-review-round6.md` - current governing review.
2. Claude's next response to round 6, if one exists. It should be named as a round-6 response and should
   identify a new code commit and tree.
3. `docs/superpowers/2026-09-01-p3-1a-candidate-review-round5-response.md` - background for the two
   corrections and the junction incident.
4. `docs/superpowers/2026-09-01-p3-1a-execution-record.md` - cumulative P3.1a record and pinned identities.
5. `docs/superpowers/2026-09-01-p3-1a-contract.md` - Revision 3 governing contract, only if the response
   raises a contract question.

Do not reread or reopen earlier candidate rounds unless the new diff touches an already accepted area or
the new response makes a claim that requires tracing its history.

## 4. Accepted findings - do not reopen without new evidence

The following are settled:

1. Parser accounting is accepted and untouched.
2. The v3 frozen case set is accepted and remains byte-frozen at the identity above.
3. The evidence expectations were independently adjudicated before predicate execution.
4. A conservative lexical binding proof is sufficient; full TypeScript symbol resolution is not required.
5. It is acceptable and desirable for the guard to reject alternative legitimate import spellings.
6. Namespace, barrel/re-export, dynamic-import, default-import, import-equals, alias, wrong-module, and local
   shadow forms cannot inherit the canonical helper outcome.
7. Both type-only import forms are now correctly rejected:
   `import type { x }` and `import { type x }`.
8. The `typescript` and `better-sqlite3` files in the disposable tree are acceptable resolution shims
   because they re-export the real installed packages and do not mock behavior.
9. The actual guard must run in a fresh process; an unmutated baseline must be green before a widened
   failure is meaningful.
10. The production validator in the shared checkout must never be mutated by a test.
11. P3.2 remains unauthorized.

## 5. Remaining round-6 requirements

Only these items remain in the current review cycle:

1. Replace the linked Git worktree with an independent temporary export/repository that does not write
   the source repository's `.git/worktrees` registry and never calls the source repository's global
   `git worktree prune`.
2. Preserve the W-series proof:
   - exact committed source;
   - clean unmutated baseline;
   - actual guard in a fresh process;
   - exactly one tracked file and one line mutated;
   - all four sites become `parallel`;
   - actual T7b failure names all four sites; and
   - shared validator, dependencies, and Git metadata remain unchanged.
3. Record the dependency incident residual in the execution record:
   - the declared dependency graph and required toolchain were restored;
   - exact pre-incident contents of untracked `node_modules` are unprovable because no prior manifest
     existed; and
   - `package-lock.json` has restored/matching content but remained visibly marked modified by the main
     checkout's Git status at the last review.
4. Confirm type-only binding, parser accounting, runner, and frozen cases were untouched by this correction.

## 6. Junction incident - current ruling

During the prior correction, an intermediate test created a junction from a disposable tree to the real
`node_modules`. Recursive teardown traversed it and removed `node_modules/.bin` plus 22 packages.

The operational repair was independently checked:

- `npm ls --depth=0` completed successfully;
- `@anthropic-ai/sdk`, `typescript`, and `better-sqlite3` were present;
- `node_modules/.bin` contained 72 entries;
- the working `package-lock.json` SHA-256 was
  `a15b272f6ada4cac930cc1055e869946ea29042d66637248204ebd3d005b66c2`;
- Git showed no package-lock content diff and the filtered object identity matched `HEAD`; and
- TypeScript and focused guards ran successfully.

Ruling: the declared installation and toolchain are operationally repaired. Exact pre-incident restoration
of all untracked dependency-tree content cannot be proved and must not be claimed. No further package
mutation is authorized merely to make that residual disappear.

## 7. Verification already completed

For code commit `49292fc` and the unchanged guarded code:

- `npx tsc --noEmit`: clean;
- `npx tsx scripts/test-outcome-inventory.ts`: 16/16;
- `node scripts/test-route-eligibility.js`: 137/137.

The round-5 mutation suite was deliberately not executed by Codex because its implementation was the
subject of the isolation ruling.

## 8. Safety and process rules

1. Preserve the dirty worktree. Do not use `git checkout --`, `git restore`, reset, clean, or another
   destructive recovery command.
2. Do not mutate the shared production validator or shared `node_modules` during review.
3. Do not run a test that registers linked worktrees or globally prunes worktrees in the source repository.
4. Before running Claude's corrected suite, inspect it and prove that all writes and recursive deletion are
   confined to an independently rooted temporary directory.
5. Do not contact production, run a model, access a corpus/database, or execute a frozen case.
6. Do not authorize the 63-case evidence run in the round-6 correction review.
7. Do not let perceived impatience relax the review standard.
8. Keep communication compact: put the complete review in a document and return only its path, verdict,
   blockers, and authorization status in chat.

## 9. Next-thread task

When Claude supplies the round-6 correction response:

1. Verify the named code commit and tree.
2. Verify every later commit is documentation-only with `git diff --numstat <code-commit> HEAD`.
3. Reconcile the pre-existing uncommitted test-file change before assuming the response owns or supersedes it.
4. Inspect only the independent-tree implementation and the incident-record amendment.
5. Confirm there are no links, shared source writes, linked-worktree commands, global worktree-prune calls,
   or recursive deletes capable of escaping the private temp root.
6. Rule on whether the independent clone/export proves exact source plus one declared mutation.
7. Only after static inspection establishes containment, run the focused corrected suite and safe neighboring
   checks. Do not run the frozen evidence cases.
8. Write the complete review to a new response document under `docs/superpowers/`.
9. In chat, provide only a short pointer and the verdict.

If the correction is clean, state the next landing/review sequence but keep the evidence run separately
unauthorized. If it is not clean, return only bounded blockers within this scope.

## 10. Short prompt for the new thread

> Read `docs/superpowers/2026-09-01-p3-1a-codex-session-handoff-round6.md` and follow section 9.
> Preserve the current dirty worktree, keep the review confined to the round-6 correction, and do not
> authorize or execute the 63-case evidence run. Put the full review in a document and reply here with only
> the path, verdict, blockers, and authorization status.
