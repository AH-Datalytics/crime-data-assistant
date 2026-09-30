# P3.1a candidate review — round 8

**Date:** 2026-09-01  
**Code commit:** `550fc2a962227bc8b1a81ea845b372bd19d6d3cb`  
**Code tree:** `e4a67e4edc7492236e00f3038a19414904f8e88b`  
**Branch tip reviewed:** `69be35d8fea00c03f5496000b5e3b8c303c41530`  
**Scope:** the two round-7 documentation corrections only  
**Verdict:** **ACCEPT — LANDING SEQUENCE AUTHORIZED**  
**Authorization:** landing is authorized; the 63-case evidence run remains separately unauthorized

## 1. Identity and scope

The named code commit resolves exactly to the named tree. The only later commit is
`69be35d8fea00c03f5496000b5e3b8c303c41530`, tree
`9d3b2f9969520dac13ef3ede00ec6a36628edd00`, which records the round-7 response and re-pins the
execution record. `git diff --numstat 550fc2a HEAD` contains only:

- `docs/superpowers/2026-09-01-p3-1a-candidate-review-round7-response.md` (`+123`); and
- `docs/superpowers/2026-09-01-p3-1a-execution-record.md` (`+7/-5`).

The review worktree was clean before review. The scoped correction relative to `5b30bd4` changes
only:

- comments, the W banner comment, and the W heading printed by
  `scripts/test-p3-1a-inventory-binding.ts`;
- the note for that suite in `scripts/fixtures/harness-tier-manifest.json`; and
- review/execution documentation already accounted for in the commit chain.

No predicate, command, mutation, assertion, branch, data value used by an assertion, module shim,
teardown operation, production file, runner, frozen case, or harness membership changed.

## 2. Test header and W banner — accepted

The header accurately describes W1–W8 as an independent `git clone --no-hardlinks` into a fresh OS
temporary directory, detached at the source `HEAD` used by that invocation. It correctly states
that the clone has its own refs, index, configuration, and object store; the carrier is widened only
inside the clone; the real T7b guard runs there in a fresh process; teardown deletes only the temp
directory; and the shared validator hash is an assertion of non-mutation rather than a restore.

The W banner and printed heading now both say “independent clone.” Nothing describes `git archive`,
`git init`, or a linked worktree as the active mechanism. The remaining mentions are deliberately
historical or negative: they explain the rejected `git worktree add`/`prune` design, identify
read-only `git worktree list` as the only surviving worktree verb, and record why archive piped to
GNU tar was not selected. Those explanations do not create ambiguity about what the current suite
does.

## 3. Tier F manifest note — accepted

The manifest note now tells a harness operator the relevant operational facts:

- the repository is cloned into an OS temp directory;
- the carrier mutation occurs only in that clone;
- the shared checkout source is never written or restored;
- SHA-256 only verifies the shared validator;
- no linked worktree is registered, removed, or pruned in the source repository; and
- teardown deletes the temp directory alone.

It no longer presents the rejected mutate-and-restore model. The note also preserves the Tier F,
database-free classification and identifies the actual fresh-process T7b proof.

## 4. Executable-change ruling and verification

There is no executable **logic** change. One runtime string literal changed from “isolated tree” to
“independent clone”; that intentionally corrects the human-facing W heading and is the only
observable executable output difference. Calling the entire `.ts` diff “comments only” would be
imprecise, but the output-label correction cannot affect control flow, exit status, containment, or
any proof result.

Independent execution of the focused suite at the reviewed tip passed **34/34** in approximately
13 seconds. Its output used the corrected independent-clone heading and again proved W1–W8,
including the green baseline, one-file/one-line mutation, four widened sites, actual fresh-process
T7b failure, unchanged worktree registry, private-root deletion, and unchanged shared source.

The candidate response records the manifest consumer passing **25/25** and the safe neighboring
checks passing. During this review, three attempts to start the manifest consumer were rejected by
the Windows process launcher before Node began (`SetTokenInformation(TokenDefaultDacl) failed:
1344`), including an attempt through `cmd.exe`. That is not a test failure: the process never
started, the one-line JSON diff is statically valid and accurately scoped, and the candidate's
successful result is consistent with it. The launch condition does not block this documentation-only
review.

No frozen case was executed, and no evidence-run artifact was created.

## 5. Landing sequence — authorized

The round-7 documentation blockers are closed. Proceed with the established landing sequence:

1. squash the final P3.1a candidate to one commit while preserving the feature-branch review trail;
2. prove the squashed tree is identical to the final reviewed tree;
3. run qualification on the exact squashed PR head, reporting both fixture and corpus verdicts
   honestly;
4. merge through the reviewed path and verify the merged tree and path set;
5. run post-merge qualification; and
6. stop for a separate, explicit one-shot evidence-run authorization.

This authorizes only that landing and qualification sequence. It does not authorize executing the
63 governing cases, creating their evidence artifact, P3.2, production activation, production
traffic, model calls, or database writes.

## 6. Required contents of the later one-shot authorization

Prepare the authorization for approval only after landing and both qualification points are clean.
It must:

1. name the **final merged commit**, its exact tree, and a freshly measured SHA-256 of
   `scripts/run-p3-1a-frozen-cases.ts`;
2. require execution from a clean checkout at exactly that merged commit;
3. re-verify the frozen v1, v2, and governing v3 pins, with exactly 63 governing v3 cases;
4. prove there is no pre-existing destination artifact collision;
5. record the literal one-shot command and the meaning of every permitted exit code before running
   it;
6. prohibit automatic retry, changed pins, or a second attempt after refusal or failure;
7. explicitly acknowledge the residual that v3 selection, the positive clean-worktree gate, and
   the evidence-directory write will take their positive branches for the first time; and
8. require independent post-run verification of artifact provenance, both verdicts, all four
   per-case axes, exact 63-case accounting, immutable destination behavior, and frozen-set
   after-digests before any result is described as evidence.

Those are the contents to prepare for a later decision; they are not authorization now. The
**63-case evidence run remains unauthorized**, and P3.2 remains unauthorized.
