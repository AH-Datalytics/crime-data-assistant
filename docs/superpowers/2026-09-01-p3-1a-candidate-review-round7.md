# P3.1a candidate review — round 7

**Date:** 2026-09-01  
**Code commit:** `5b30bd4acaab940d3b7ce26b956ed3aebbfa1ef5`  
**Code tree:** `94f1841884aa3e0cf36f4c80fc82c37def91d9a4`  
**Branch tip reviewed:** `b7cf39a7bbe011dad2d4f84776bed528310fa3d3`  
**Scope:** the round-6 independent-tree correction and dependency-incident residual only  
**Verdict:** **REVISE — ALIGN THE CANONICAL CONTROL DOCUMENTATION WITH THE ACCEPTED CLONE DESIGN**  
**Authorization:** the 63-case evidence run remains unauthorized

## 1. Identity and boundary

The named code commit resolves exactly to the named tree. The only later commit is
`b7cf39a7bbe011dad2d4f84776bed528310fa3d3`, whose tree is
`2f988c888967c83f1b77ff7bac6dc5c7cdf137e0` and whose subject is “Record the round-6 response and
the dependency-directory residual.” `git diff --numstat 5b30bd4 HEAD` contains only:

- `docs/superpowers/2026-09-01-p3-1a-candidate-review-round6-response.md` (`+171`); and
- `docs/superpowers/2026-09-01-p3-1a-execution-record.md` (`+48/-9`).

The review worktree was clean before review. Relative to the last accepted code commit `49292fc`,
the correction changes `scripts/test-p3-1a-inventory-binding.ts` and the execution record; the
other additions are review/handoff documentation. The accepted type-only binding implementation,
parser accounting, runner, production files, and frozen cases were untouched. Independently
measured identities remain:

- runner SHA-256: `aaeb1dd29694df52b878da73fe878dde6fbc94dc9a4ab278dc0b6b5878b92f77`;
- frozen v3 SHA-256: `2535cbd934a4766a7f9ff8570f5b0e60d04b7c37430283b48e52b206c75a0b91`;
- `docs/superpowers/p3-1a/runs/`: absent before and after review.

No frozen case was opened through the runner or executed.

## 2. Independent clone — accepted

`git clone --no-hardlinks` is an acceptable independently rooted repository for this control. The
round-6 ruling named archive and complete-manifest copies as examples, not an exhaustive list. The
clone reads the source repository while putting its checkout, refs, index, configuration, and
object files under a fresh OS-temp root. `--no-hardlinks` also prevents object-store inode sharing.
The subsequent detached checkout, shims, validator mutation, Git measurements, and teardown all
operate in that private root.

The archive-plus-GNU-tar failure is therefore a reasonable reason not to use that particular
pipeline. Other archive extraction mechanisms could avoid GNU tar's Windows drive-letter parsing,
but none is required: the clone already satisfies the governing isolation property.

Static containment inspection established:

- `tmpRoot` comes directly from `fs.mkdtempSync(path.join(os.tmpdir(), "p31a-widen-"))`;
- the clone target is the fixed child `tmpRoot/tree`;
- the two module shims are ordinary directories/files under that clone and only re-export the real
  installed packages;
- the fixed candidate tree contains no tracked symlink (`120000`) entries;
- there is no link or junction creation;
- there is no `git worktree add`, `git worktree remove`, or `git worktree prune` call;
- the only source-repository `worktree` operation is the read-only `list` comparison;
- no source file is written; and
- the only W-series recursive deletion targets the independently created `tmpRoot`.

Thus interruption can leave a private temporary clone, but cannot leave registration in the source
repository or cause teardown to escape into the source checkout. This closes the round-6 blocker.

## 3. W-series proof — accepted

The focused suite passed **34/34** in **12.94 seconds** during this review.

W1 is a genuine strengthening: it proves the clone is detached at the exact source `HEAD` used by
the invocation and has a clean Git status. Because the current tip is one documentation-only commit
after `5b30bd4`, W1 by itself does not spell the historical code-commit ID `5b30bd4`; the separate
commit/tree and docs-only-tail checks above establish that the executed code is exactly the reviewed
code. This is not a substitution for source identity.

The remaining obligations were preserved:

- W1b: the cloned validator and shared validator were byte-identical;
- W2/W2b: the actual guard passed unmutated in a fresh process and all four sites resolved to the
  one literal reason;
- W3/W3b: Git measured exactly one tracked file and one changed line;
- W4: all four delivered sites became `parallel`;
- W5/W5b: the actual fresh-process T7b guard failed and named four distinct affected site
  fingerprints;
- W6–W6d: the source worktree registry was unchanged, no `p31a` worktree was registered, the temp
  directory was removed, and the shared dependency markers remained present; and
- W7/W8: the shared validator hash and the four shared-checkout outcomes remained unchanged.

Post-run inspection found no `p31a-*` temp directory, no evidence-run directory, and no worktree
change. Safe neighboring checks also passed: TypeScript `--noEmit`, outcome inventory **16/16**, and
route eligibility **137/137**.

## 4. Incident residual — accepted

The execution record now states the required distinction without claiming exact restoration of an
unrecorded tree:

- the declared dependency graph and required toolchain are operationally restored;
- no prior byte/path manifest exists, so exact pre-incident `node_modules` contents are unprovable;
- the five extraneous packages have unknown prior state and are not called damage; and
- `package-lock.json` content is restored while the main checkout still visibly reports it as
  modified.

Read-only re-verification against the main checkout found `npm ls --depth=0` successful,
`@anthropic-ai/sdk`, `typescript`, and `better-sqlite3` present, and the same five extraneous
packages. `git diff -- package-lock.json` was empty; its working-file Git object matched
`HEAD:package-lock.json` at `7cede35c3acd4ace646315609d5aee4293deb25d`; its SHA-256 was the
recorded `a15b272f6ada4cac930cc1055e869946ea29042d66637248204ebd3d005b66c2`; and `git status`
still showed ` M package-lock.json`. The record does not overclaim the unknown dependency-tree
history.

## 5. Canonical-harness placement — keep it

The suite belongs in `harness:test`. It is a declared Tier F, database-free structural safety
control, and removing it from the canonical chain would make the isolation and non-vacuity proof
optional. The clone is local and small; the focused suite took 12.94 seconds in this review, not
the response's rough 90-second estimate. Even if another environment takes roughly 90 seconds, the
two fresh guard processes are the property being proved, not incidental duplication. The runtime
does not justify weakening continuous coverage.

## 6. Bounded blockers

The implementation and incident residual are accepted. Two canonical descriptions still document
the superseded mechanism and must be corrected before squash/landing:

1. The header of `scripts/test-p3-1a-inventory-binding.ts` says W1–W9 export with `git archive`,
   extract into a temp directory, and perform a fresh `git init`; the implementation and response
   correctly use an independent clone and controls W1–W8. The W-section banner also still calls the
   tree a “disposable git worktree.” Rewrite those descriptions to the clone-based W1–W8 design.
2. The Tier F note in `scripts/fixtures/harness-tier-manifest.json` says the carrier is widened “in
   place” and “restores by sha256.” The accepted control mutates only the independent clone, deletes
   that clone, and merely verifies the shared validator by SHA-256; it never restores shared source.
   Update the manifest note so future reviewers and harness operators are not told the rejected
   safety model.

These are documentation-only corrections. They do not require changing the accepted clone logic or
rerunning the frozen cases. After correction, verify the code diff is limited to those descriptions
and rerun the focused suite or establish that the executable tree is unchanged.

## 7. Landing and authorization status

Landing is not yet authorized because the two canonical descriptions above must be reconciled and
receive a narrow clean review. After that clean review, the established sequence remains:

1. squash to one commit while preserving the feature-branch review trail;
2. prove the squashed tree matches the final reviewed tree;
3. qualify the exact squashed PR head with honest fixture and corpus verdicts;
4. merge and verify merged-tree identity;
5. run post-merge qualification; and
6. stop for a separate, explicit one-shot evidence-run authorization.

That later authorization must name the **final merged commit**, its tree, and a freshly measured
runner SHA-256; require a clean checkout at that exact commit; re-pin all frozen sets and exactly 63
v3 cases; establish no pre-existing target-artifact collision; record the literal one-shot command
and exit meanings before execution; prohibit automatic retry or pin changes; acknowledge that the
v3 selection, positive clean-worktree gate, and evidence-directory write will take their positive
branches for the first time; and require independent post-run verification of provenance, both
verdicts, all four per-case axes, 63-case accounting, immutable destination, and frozen-set
after-digests.

This review does **not** supply that authorization. The 63-case evidence run and P3.2 remain
unauthorized.
