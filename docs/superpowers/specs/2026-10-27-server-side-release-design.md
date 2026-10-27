# Server-side release: one command that deploys, checks and rolls back by itself

**Owner, 2026-10-27:** "we have to make the deployment simpler. this is absurd." Then: "Design the simpler deploy
process: a server-side release script that deploys, checks and rolls back by itself, with no laptop loop or
hand-copied captures." Earlier the same day: "the questions should only run if needed."

## Why the window has to go

On 2026-10-27, item 3 (PR #55) passed every live check, and both window attempts still rolled back:

- **Attempt 1:** at 12:43Z, ssh connections from this laptop were reset.
- **Attempt 2:** at 13:15Z, ssh connections from this laptop timed out.

The window keeps a controller on the laptop that reads the server clock over ssh every 5 s, and rolls back after three failures. A network blip on the laptop side therefore decides the release.

The window also costs:

- about 40 minutes of serialized operator steps;
- about 3,000 characters of base64 per answer, retyped by hand (typos on 10-26 and 10-27);
- review overruns from operator stalls.

The same release then went live in about 2 minutes with the plain `deploy-zero-downtime.sh`, run on the server.

## What already exists (keep)

`scripts/deploy-zero-downtime.sh <sha> dev` already does the following, all on the server:

- refuses a SHA not on `origin/dev`;
- builds an isolated release from a `git archive` bundle;
- smoke-tests a preflight port;
- verifies the artifact against its receipt before the switch (gates L2/L3);
- switches the symlink atomically;
- runs `pm2 reload`;
- checks `/` and `/test` health.

**Gap:** a failed post-switch health check only logs a WARNING and leaves the new release live. Nothing checks answers, and nothing rolls back automatically.

## Design

A new `scripts/release.sh <40-char sha>` in the repo, so it is reviewed with code and bundled like the deploy script. It runs entirely on the server, and the laptop only starts it and reads its result:

```
ssh root@VPS 'cd /tmp && nohup bash /tmp/deploy-$SHA/scripts/release.sh $SHA > /opt/nibrs/release-logs/$SHA.log 2>&1 &'
ssh root@VPS 'cat /opt/nibrs/release-logs/$SHA.result'      # any time later
```

A dropped laptop connection changes nothing.

### Steps

1. **Lock and preconditions.**
   - `flock -n /opt/nibrs/release.lock` (one release or rollback at a time). This also closes the non-atomic rollback launch Codex found in the window scripts.
   - The NIBRS maintenance lock must be free.
   - Crime Index Studio must have no queued or running job, or the script waits up to N minutes and then stops untouched.
   - Record the live release and commit as the rollback target.
2. **Baseline answers (before the switch).** Ask the live release the check questions over HTTPS through nginx (`https://nibrsai.com`, from the server, authenticated with the server's own HMAC cookie). Record each answer body with requestId and timings masked.
3. **Deploy.** Run the existing `deploy-zero-downtime.sh $SHA dev` unchanged. If it dies before the switch, production is untouched: result `NOT DEPLOYED`.
4. **Post-switch checks.** All are server-local and bounded:
   - **Identity:** `RELEASE_INFO` commit equals `$SHA`; `current` is the new release.
   - **Health:** all PM2 workers online on the new release, and `/` and `/test` return 200, with retries (C4 logic).
   - **Answers:** ask the same check questions again. Each answer must be byte-identical to its baseline after masking, unless the SHA's `scripts/fixtures/release-checks/expected-changes.json` names that question. A named question must instead pass the checker that file points to. That file is written and reviewed in the PR that changes the answer.
5. **Pass:** write `RESULT=LIVE` with the release, commit, rollback target and each check's outcome.
6. **Any failure, error or timeout in steps 4-5:** run `scripts/rollback.sh <target>`, verify the target is live and healthy, then write `RESULT=ROLLED BACK` with the reason. If the rollback itself cannot be verified: `RESULT=ROLLBACK NOT CONFIRMED`, exit nonzero, and notify (the existing digest mail).
7. **Overall bound:** `timeout` around the whole run (for example 20 minutes). Expiry after the switch means rollback.

### The check questions ("only if needed")

The check questions are the window's four (O352, H1-H3), plus any added later. They now cost nothing to run, because nobody copies anything: about 10 seconds each, on the server.

So they always run. Skipping them is no longer worth a special "display-only" path.

Because the before/after comparison is against the live release, a release that does not mean to change answers needs no expected files at all. That is the common case, and it removes the per-release package build: no recaptured positives, no seal, no rehearsal.

### Visual changes

Visual changes are not machine-checked here. After `RESULT=LIVE`, the operator looks at the page, or names page checks in the PR. A wrong look is undone with one command: `bash /opt/nibrs/current/scripts/rollback.sh <target>`.

## What changes for people

| | Window today | `release.sh` |
|---|---|---|
| Time | ~40 min of serialized operator steps | ~5 min, unattended |
| Laptop network | Decides the outcome | Irrelevant after start |
| Package per release | Maker, positives, seal, rehearsal, Codex confirm | None. The script and fixtures are reviewed in their PRs. |
| Answer checks | Hand-copied captures, controller deadlines | Server-side before/after comparison |
| Rollback | Controller over ssh, operator fallback | Automatic, on the server, under a lock |
| Codex | PR review, package confirm, window record | PR review only. `release.sh` gets one design and code review now. |

## What is given up

- **Browser-side bytes.** The page-hashed proof of the bytes a browser received goes. The new check reads the answer through the same public HTTPS path (nginx included), but from the server rather than a browser.
- **Per-release Codex sign-off.** Codex no longer confirms each release's package. Its review moves entirely into the PRs: the code, and any `expected-changes.json`.

## Build plan (after approval)

1. `scripts/release.sh`, `scripts/fixtures/release-checks/questions.json` (the four questions with their sources), and the masking and compare helper. The window's checker becomes the per-question checker for named changes.
2. Tests, run offline:
   - fake deploy and rollback scripts;
   - pass;
   - pre-switch failure;
   - health failure, then rollback;
   - answer mismatch, then rollback;
   - rollback failure, then NOT CONFIRMED;
   - lock held;
   - Studio busy.
3. One supervised first use on a small real PR. The window procedure stays in the repo, unused, until `release.sh` has shipped two releases.

## Codex review (2026-10-27): ACCEPT-WITH-CHANGES, folded in

These requirements are part of the design. Each has its failure case in the offline tests.

1. **Failures during the deploy itself.**
   - Recovery is decided from the real switch state (where `current` points, and what PM2 has loaded), not from the deploy's exit code. A deploy that dies after the switch, for example during the PM2 reload, is rolled back.
   - On the overall timeout, the deploy process is stopped and reaped before rollback, so it cannot switch again later. Rollback gets its own bounded time.
   - Each attempt writes its own result, atomically (`<sha>.<attempt>.result` plus a `latest` pointer), so a retry never shows an earlier LIVE.
   - `NOT DEPLOYED` is reported only when production was never touched.

2. **Real exclusion, and a protected rollback target.**
   - One lock is shared by every way of changing production: `release.sh`, `deploy-zero-downtime.sh` and `rollback.sh` all take `/opt/nibrs/release.lock`. Nested calls inherit it rather than deadlocking.
   - The NIBRS maintenance lock is HELD from the baseline answers through verification, so a data refresh cannot land between the two reads.
   - Studio admission is paused while the release runs, through its existing mechanism or an explicit pause, so the idle check cannot be outrun.
   - Historical/RTCI refresh paths are coordinated the same way.
   - The recorded rollback release is protected from the deploy's pruning of old releases.

3. **A narrow, fail-closed comparison.**
   - Fixed endpoints, source, exact question and empty history.
   - JSON and SSE are parsed. HTTP failures, error events, and malformed or incomplete answers fail the check.
   - Only enumerated volatile fields are masked (`requestId`, `executionTimeMs`, timing fields). Values, notes, titles, chart configuration and row order must be equal.
   - Two equal error responses never pass.
   - Each check question must provably take a model-free path, cold included: the response must carry the deterministic-path marker, or the check fails.

4. **A narrow `expected-changes.json`.**
   - It is read, with its checkers, from the target commit. Unknown questions and missing checkers are rejected.
   - A named question is excused only for the fields its entry lists. Every other field must still be equal.
   - The old title checkers are extra assertions, never a substitute for the equality check.

5. **Rollback that is proven, not assumed.**
   - `rollback.sh`'s exit status is not trusted. It reloads PM2 by app name, warns rather than fails, and does nothing if the symlink already points at the target.
   - `release.sh` reloads from the target's own ecosystem file when needed. It then independently verifies the target commit in `RELEASE_INFO`, every worker's loaded release, and health, with retries.
   - Only then is the result ROLLED BACK. Otherwise it is ROLLBACK NOT CONFIRMED, with a nonzero exit and a notification.
   - Scope: code releases that are compatible with the current shared data. A release does not undo database migrations.

**What is given up, stated fully:** the window's browser-byte proof, and its rendered-page and answer-meaning review. Equality keeps existing behavior, including existing defects. Visual and intended answer changes get targeted human review after LIVE. No package, seal, laptop watchdog or per-release Codex approval.
