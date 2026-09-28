# Simpler collaboration: milestone ownership, not approval ping-pong

Date: 2026-09-10. Recommended working agreement for Jeff, Claude and Codex. This document does not authorize execution or expand any existing permission.

## Why change

**Standing instruction, adopted 2026-09-11:** Jeff asked that the reviewer's improvement commitments persist beyond the conversation. The reviewer-discipline addition below is now part of the project working rules, linked from AGENTS.md, CLAUDE.md and the current roadmap. This changes review practice, not operational authority. Historical next-task paragraphs in this document are superseded by the current roadmap and its active approval.

The recent chain repeatedly went from recommendation to acknowledgment to approval template to another acknowledgment while the substantive work stayed still. Codex contributed by making small follow-up corrections separately permissioned and by issuing overly narrow rules whose edge cases then consumed successive reviews. Claude's incomplete fixes and overstated proof claims also created real rework. The solution is neither less independent review nor accepting defects to finish faster: it is clearer ownership, earlier decisive evidence and fewer handoff gates.

Some safety and correctness findings were necessary. Repeated approval relaying, restating accepted decisions and creating a fresh plan for the same outcome were not useful progress.

## Recommended agreement

1. **Jeff approves a bounded outcome once.** Before work starts, identify the outcome, allowed machines/data, allowed edits and checks, spending if any, a work limit and the stop. Include routine preparation and a defined correction allowance in that approval. Do not ask again for ordinary steps already inside it. Permission for local work never silently includes production, paid calls, destructive actions or deployment.

2. **Claude owns implementation; Codex owns independent technical review.** Codex provides a recommendation, not an unexplained menu of engineering choices for Jeff. Claude gathers the agreed evidence and checks the full delivered result before handing it off. Jeff decides material scope, cost, risk and product-policy changes, not helper signatures or test mechanics.

3. **One consolidated review, one bounded correction pass by default.** Codex reviews the submitted artifact against predeclared acceptance criteria and returns all material findings found in that review together. Within the owner's expressly approved allowance, Claude fixes those findings without another owner yes. If the correction still fails materially, stop and reassess the affected approach, reporting one concrete recommendation; do not run an indefinite fix-review cycle. A review-round limit never converts a failed result into acceptance. New consequential risk still requires escalation immediately.

4. **Use the smallest check that answers the next question.** Inspect saved evidence before spending; use real offline data when the uncertainty is about source coverage; use local behavior checks for a deterministic repair; reserve broader captures and fresh independent scoring for meaningful integration/regression checkpoints. A targeted success never updates the full frozen score. Do not turn every small edit into 142 new turns and 214 judgments.

5. **Keep durable evidence, reduce duplicate documents.** `docs/roadmap/current.md` stays the single current-status pointer. Use one handoff per milestone, with append-only dated implementation/review/correction sections or linked immutable evidence. Preserve reviewed versions, identities and raw results; never silently overwrite a submitted artifact. An acknowledgment alone needs no new document and no owner relay. Short prompts point to the handoff rather than restating its history.

6. **Only interrupt Jeff for a decision that changes the work.** Escalations state the problem, Codex's recommendation, the consequence and one plain-English decision. Otherwise report outcome, evidence, remaining limitation and next action. After every Claude prompt, retain the requested two non-technical sentences: what Claude did/said, then our response and how it helps make NIBRSAI dependable and useful.

## 2026-09-10 addition: evidence before a source-dependent rule

Claude's session feedback is accepted: before designing or implementing a delivery rule that depends on a source property, test that property on the authorized real offline source. A fixture demonstrates behavior under an assumption; it does not establish that the source satisfies the assumption. Codex owns checking that premise before prescribing the rule, and Claude owns challenging it before implementation. Include the bounded source check in the milestone approval instead of adding a fresh permission exchange for each routine step.

Before submission, Claude should adversarially check the changed decision path: a supported useful answer, the unsafe counterpart, and whether the stated evidence actually proves the claim. This is part of implementation, not an extra review ceremony. Codex's independent review remains necessary.

The full capture exposed the unsupported comparison; the focused diagnostics explained why the proposed solution withheld and whether a better comparison group existed. These checks have different jobs, so the lesson is sequencing rather than abandoning full measurements. The reported 511 ms was one database-read duration, not the total investigation time. The actual cohort results now support the group-only implementation milestone linked from the roadmap; the earlier diagnostic-only example below is historical, not a new pending task. No authority is expanded by this addition.

## 2026-09-11 addition: reviewer discipline that persists between sessions

Codex owns these obligations rather than asking Jeff to enforce them:

1. **Trace the whole failure before prescribing a repair.** Read the saved request, actual selected plan, validation/refusal, execution and final delivered answer. Distinguish a builder returning nothing from a built query rejected later. State which evidence establishes the blocking stage and what remains unknown; do not turn plausible helper behavior into a proven cause.
2. **Establish feasibility before source-dependent design.** Check that required identities, measures, periods and coverage can support the intended answer, within existing authority. A constructed fixture is not a source observation. When new access is needed, recommend the smallest decisive check once, not a succession of speculative rules.
3. **Select milestones for useful delivery and shared benefit.** A warning removed or an isolated test passing is insufficient if the supported request still produces no correct answer. Separate safety-only improvements honestly. Do not switch to an unrelated easy defect merely to report motion, or dismiss an important goal because its proposed method is overcomplicated.
4. **Consolidate review and preserve closure.** Review the complete submitted path against agreed criteria once; return material blockers together, with lower-priority findings parked. Reopen accepted work only for concrete contradictory evidence, not a newly imagined edge case. Claude self-checks the complete delivered behavior before submission.
5. **Apply task-level authority.** One owner approval covers the named outcome, ordinary in-scope preparation/tests and its stated correction allowance. Do not make Jeff relay approval templates for routine steps. Notification is not permission for a material expansion; recommend and ask plainly when scope, risk, cost or policy actually changes.
6. **Enforce the stop.** One consolidated review and one bounded correction pass by default, where authorized. If a material failure remains, reassess the affected approach and recommend the next action instead of starting another micro-fix cycle. Never lower the acceptance bar just to declare closure.

Use the existing completion handoff to state the useful behavior established, the decisive remaining limitation and the next action. Where relevant, acknowledge an avoidable review detour and what changed; do not create a reviewer scorecard, new review document per turn or ceremony to prove compliance.

Judge the process by **fewer avoidable handoffs, earlier rejection of wrong assumptions, and more completed useful behavior**, not by counts of findings, documents or tests. Full measurements remain for meaningful integration checkpoints; local evidence does not update frozen scores. Independent safety/correctness review stays intact.

Persistence is via repository instructions, not a promise of automatic learning or perfect recall. AGENTS.md is the Codex project entry point; CLAUDE.md and docs/roadmap/current.md point here. Sessions launched outside this repository, already-running sessions and other machines may require the pointer to be read explicitly. Keep one substantive agreement, not duplicated evolving policies. No skill, plugin, new service or model-training change is required.

Short prompt for Claude (may be folded into the next substantive handoff; do not interrupt current work for an acknowledgment):

> Read the 2026-09-11 reviewer-discipline addition in docs/superpowers/2026-09-10-simpler-collaboration-working-agreement.md. Apply it within the already-approved milestone: complete-path evidence, useful delivery, one consolidated review and one correction pass. No new authority, plan or acknowledgment is needed.

Claude's investigation helped expose a gap in how we traced failures, and the subsequent review located the overlooked stopping point. I have made the improved review habits standing project instructions so professionalization advances through useful completed work rather than repeated planning and approval exchanges.

## 2026-09-12 addition: a finite path out of correctness repair

Jeff asked Codex to retain the completion discipline explained in the Phase 3 discussion. P3.1's accepted implementation remains finished; do not describe the current correctness work as unfinished P3.1. The governing closeout requirements remain in `docs/roadmap/current.md`; this addition does not replace them or authorize execution.

- Codex owns a finite completion path: known unsafe answers corrected or demonstrably prevented, agreed supported answer families delivering useful correct answers, and combined changes independently checked with explicit remaining limitations.
- At milestone closure, credit accepted repairs and reconcile remaining groups against those requirements. Identify actual completion blockers, later-roadmap work and the next meaningful integration checkpoint before recommending further repairs. A newly noticed issue is not automatically another mandatory detour; material contradictory evidence still requires reassessment.
- Measure meaningful batches together under separate authorization, not each small repair. Local acceptance does not change measured scores. Do not demand perfect answers to every possible question or 120/120 as an invented exit gate; equally, do not silently drop promised capabilities or count refusals as useful delivery.
- Distinguish roadmap continuation from release approval. Preserve the approved correction limit, make an explicit accept-or-reassess decision, and carry unresolved risks with an owner rather than allowing an automatic growing patch queue.

This is standing reviewer guidance, not a new milestone, status change, Claude task or approval request. Fold it into future substantive handoffs without an acknowledgment relay; current approved work continues within its existing boundaries.

### Owner-adopted quality requirements, 2026-09-12

Jeff approved applying the finite completion path without sacrificing professionalization quality. Finite means a defined outcome, not a deadline, repair quota or permission to accept an unresolved failure. The existing Phase 3 closeout requirements remain governing.

1. Promised capabilities must deliver useful, correct answers. Refusal-only success, silent scope reduction and relabelling failures do not satisfy this requirement.
2. Known serious wrong-answer paths must be corrected or demonstrably prevented through delivered behavior, while preserving supported answers. Merely recording the defect is not protection; any necessary product-scope change requires an explicit owner decision.
3. Combined changes require independent qualification at a meaningful, separately authorized checkpoint, including preservation of previously working answers and explicit source/runtime limitations. Local checks alone do not certify the whole application or update its measured score.
4. Every residual group must have a reasoned disposition and owner: essential before completion, already covered with evidence, dependent on a named prerequisite, or assigned to later roadmap work. Essential protections cannot be deferred just to finish. A new issue changes the completion path when it materially undermines these requirements, not merely because it has been noticed.
5. If the approved correction pass still fails materially, Codex recommends a changed approach or openly reassessed scope; neither automatic further patch rounds nor a lowered acceptance standard is allowed. No guaranteed completion date or fixed remaining repair count is claimed.

**Next checkpoint owned by Codex:** after the current shared-limitation correction pass, give one closure-or-reassessment ruling and reconcile the existing grouped backlog with accepted repair evidence before recommending another build. In the existing roadmap/handoff, name the remaining essential outcomes, their actual dependencies and the next meaningful combined-test checkpoint with its prerequisites. This does not require a new inventory, another acknowledgment document, a new tool or an automatic full run. Claude continues only the current approved work; later execution and deployment retain their separate approval boundaries.

Short prompt for Claude, to accompany the current substantive handoff:

> Read the owner-adopted quality requirements dated 2026-09-12 in `docs/superpowers/2026-09-10-simpler-collaboration-working-agreement.md`. Apply them within the approved shared-limitation correction pass and return its evidence in the existing handoff. Preserve useful answers and the named protections; do not start another repair or run. Codex owns the completion-path checkpoint afterward. No acknowledgment-only reply is needed.

Claude's latest build improved four explanations but still needs the two corrections already identified. I will judge that work against firm quality requirements and identify the essential remaining steps, so professionalization reaches a dependable result without an endless repair queue.

## Practical handoff limit

Shared files reduce copying but do not wake another session or transfer binaries to MSI. Without an already available authorized coordination channel, Jeff may still need to send a short start/review prompt. Do not imply autonomous Claude-to-Codex communication exists, revive SSH, or build an agent-coordination platform to solve this. The immediate gain comes from eliminating acknowledgment-only relays and bundling authority, not introducing another system.

## Apply to the next milestone

The existing next recommendation remains the two-question offline coverage check in `2026-09-10-next-measurement-readiness-codex-ruling.md`. A single explicit owner approval can cover its named preparation, verified transfer, bounded read-only checks and one result handoff. It grants no product repair, paid/full capture or deployment. Do not add a correction allowance to this diagnostic-only milestone by analogy with an implementation milestone.

Neither this process recommendation nor the owner's question about efficiency grants that operational approval. Future milestone approvals should contain their correction allowance up front; historical narrow approvals must not be retroactively broadened. Accepted batches remain closed; scores stay 56/58/6.

## Short Claude prompt

> Read `docs/superpowers/2026-09-10-simpler-collaboration-working-agreement.md`. This is Codex's recommended simpler workflow: one bounded outcome, consolidated review, durable milestone evidence and no acknowledgment-only relays. Future approvals should include routine steps and any bounded correction allowance explicitly. Do not broaden existing authority or start work from this process recommendation; no response-only handoff or new plan is needed.

Claude's updates have repeatedly stopped at small approval boundaries, leaving you to carry messages between us. I recommend approving complete, limited pieces of work and reviewing their results together, so more of our effort makes NIBRSAI dependable and less goes into managing the conversation.

## 2026-09-10 addition: tooling priorities, without a new workstream

**Recommendation: prioritize the candidate-delta helper before the next packaging/transfer milestone; defer the project skill and shared probe module. None is a prerequisite for the already recommended cohort implementation.** No tool or skill build/install is authorized by this recommendation.

### 1. Candidate delta: the one near-term tool with a demonstrated job

`scripts/candidate-delta.js` is not present at review time. The existing main-laptop `build-candidate-manifest.js` enumerates app/lib for its source list; the returned MSI manifest has a different, broader scope. A delta helper should compare the submitted baseline with an explicitly declared current input scope, enumerate fresh files across all included roots, and report added, changed, missing and unchanged inputs. Reading only baseline paths cannot discover new files. Config/test roots must not silently fall out of scope, as happened with the two proof suites.

Keep it a small, read-only local command with concise human output and optional machine-readable output. Do not make it a manifest generator replacement, transfer tool, build runner, database hasher or environment audit. Reuse the existing formats deliberately, report unsupported schemas or unreadable paths as incomplete/error rather than clean, validate paths stay in scope, and preserve the secret/database/build-output exclusions. State the scanned roots and exclusions; no claim to cover undeclared roots. Fixture checks should catch an added proof suite outside app/lib, changed/deleted inputs, unchanged files and an unreadable or invalid input. Finish there.

The command verifies input differences, not source correctness, installed dependency identity, actual served bytes or operator authority. Its output can support an approval gate only when the launcher actually compares it with approved inputs and refuses unexpected differences. Printing a hash is still not a gate. Schedule this within the next explicitly approved packaging milestone, not as an extra review gate before product progress.

### 2. Project skill: defer, keep the agreement authoritative

These are project-specific conventions, so an outside marketplace skill is not the recommendation. Use this existing working agreement and the current milestone handoff now. If repeated omissions persist, a later approved thin skill may point to those sources and the delta command; it must not duplicate changing policy or turn suggested scope into authority. A skill can remind an agent to check identities, but only executed checks enforce that requirement. No skill is installed or authored here.

### 3. Shared probe module: extract only after the behavior is stable

The repeated diagnostic shapes are a plausible future reuse opportunity, but the claimed thirteen throwaway probes were not independently inventoried in this review. Do not pool them indiscriminately: recent diagnostics differed in which hashes were gated, snapshot handling, retained evidence and interpretation. Reuse a reviewed invocation within scope now; consider a small tested common wrapper at a later checkpoint if the repetition persists. No generic probe framework or changes to historical evidence.

Ordering remains the dominant improvement: verify the source assumption before building a rule around it, then validate safe and useful behavior. Tools reduce repeated mechanical mistakes; they do not replace that judgment. No Claude-Codex channel, status.json, new evaluator or governance framework.

### Short Claude prompt for this addition

> Read the tooling-priorities addition in `docs/superpowers/2026-09-10-simpler-collaboration-working-agreement.md`. Candidate-delta is the recommended small tool for the next authorized packaging milestone, not a blocker for cohort implementation. Defer the project skill and shared probe library; keep source-first ordering. No build, installation or new workstream is authorized here, and no acknowledgment-only handoff is needed.

Claude proposed three aids to reduce repeated mistakes but correctly put checking the data first above all of them. I recommend the small file-comparison helper when next needed and deferring the rest, so professionalization gains reliability without delaying better answers for another tooling project.

## Owner delegation - sensible fixes within approved outcomes

2026-09-17T01:51:15Z. Jeff: **"yes, approved, I want you to approve sensible fixes."**

Codex may approve reasonable local fixes and bounded corrections needed to achieve an already-approved outcome, using independent technical judgment, without returning routine implementation decisions to Jeff. Claude remains the implementer; Codex reviews and records the substantive ruling in the existing handoff. This delegation does not authorize accepting unsupported completion claims or an indefinite patch loop: authorize a finite correction batch, then accept or reassess against the agreed outcome.

Material changes to promised behavior or product policy, new source/machine access, spending, deployment and release remain owner decisions. Existing access restrictions and pending qualification gates remain in force. Apply this delegation to ongoing work; do not send acknowledgment-only replies or restart closed tasks.

For the current unit-ownership integration, Jeff's approval includes the recommended population policy. Codex has authorized one consolidated correction in "Codex integration ruling - one authorized correction for clause ownership"; the earlier recommendation's no-automatic-correction wording does not require another owner approval for that expressly authorized pass.


### Direction remains Codex's responsibility after a review stop

2026-09-17T11:33:12Z. Jeff asked why Claude had been left without guidance. Ending a correction allowance limits automatic implementation; it does not suspend Codex's responsibility to finish the reassessment and give a concrete next action. Within Jeff's delegated authority, Codex should authorize a sensible revised local task with its outcome, evidence, allowance and stop. Ask Jeff only when the next action actually changes a reserved scope, policy, access, spending or release decision. Do not leave Claude with an indefinite stop notice or ask Jeff to relay routine approval again. Claude remains the implementer; an authorized task is not evidence that another session has started it.

## Process recommendation - comparative submissions, explicit coverage and proportionate tooling

2026-09-17T01:55:29Z. Separate response to Claude's process questions, based on the working agreement and the P6.4 record from the feasibility submission at line 11300 through the integration at line 11557.

**Recommendation only.** This section proposes future submission practice; it does not amend the pending unit-ownership review, add acceptance conditions to that review, restart feasibility, authorize a helper implementation, or change its correction allowance. The cut-off wording in the request is interpreted as referring to limitations around existing supported unit forms and to a small shared proof-harness module.

### 1. Standing comparison requirement: yes, with an essential addition

Recommend requiring a before/after behavior comparison for submissions that change recognition, eligibility, refusal or delivery. **The proposed newly-refused check would have caught F2, but not F1.** F2's forward-unit request was already in the prototype proof and changed from a supported answer to refusal. F1's retained trailing `per capita` request remained wrongly accepted. Agreement with the shipped implementation cannot establish that a known bug was fixed.

The standing requirement should therefore combine **behavior differences and independent expected behavior**:

- Freeze and identify the actual pre-change implementation and candidate, including relevant collaborators. Compare both against the same declared local request corpus and fixtures. A historical test file imported against the new implementation is not execution of the old baseline.
- The corpus must include existing regression requests, dynamically generated suite cases, retained review witnesses and their supported counterparts, and **every request introduced by the submission's proof or edge checks**, including examples the candidate expects to refuse. Identify coverage gaps. Do not extract string literals and call that execution of the suite.
- For every corpus case, record baseline and candidate outcomes. Enumerate every accepted-to-refused change; also report refused-to-accepted changes, changes to meaning/results among accepted cases, changed refusal reasons, and exits from the owned family. Where the claim concerns delivery, compare the relevant delivered fields and route outcome, not just the recognizer verdict.
- Give each change a disposition against the approved outcome: intended bug correction, authorized policy change, regression to repair, or unresolved scope question. A refusal is neither automatically a regression nor automatically a safety improvement. Keep already-refused reason changes separate from newly lost answers.
- Independently assert the promised meaning of the retained blockers and supported controls, including unchanged verdicts. This catches F1, where a pure difference report remains green.

"Every" means every case in the declared bounded corpus, not every possible English request. A missing executable baseline is an evidence limitation to resolve or explicitly carry; hashes alone do not reconstruct old behavior. No full capture, paid run or real-source read becomes mandatory through this requirement.

Suggested standing sentence:

> Before submitting a behavior change, compare the candidate with the identified pre-change implementation over the complete declared regression, witness and submission-proof corpus; enumerate and explain changed outcomes, and separately test the intended meaning of known blockers even where both implementations agree.

### 2. Declared limitations: require coverage of existing forms; keep honest limits

**Yes: reject a declared limitation as a substitute for covering behavior already inside the promised outcome.** A claim that unit ownership is complete cannot exclude existing unit words while testing only numeric denominators. List the finite existing alternatives, their relevant roles/placements, expected behavior and actual evidence. Numeric and word forms need meaningful coverage; an unsupported combination can be correctly refused, and that refusal still needs a test.

This is not a ban on declaring limitations. Genuine source uncertainty, out-of-scope capabilities and incomplete evidence must remain visible. If an in-scope form is not covered, say the submission is partial or request a scope decision; do not treat the limitation paragraph as permission to call it complete. Enumeration does not require an unbounded catalogue of English or every Cartesian combination.

Codex shares responsibility here: the original feasibility scope should have made the retained unit alternatives and forward-placement preservation explicit, instead of leaving their omission to a later review. Better expectations before work, plus Claude's comparative evidence before submission, would reduce avoidable relays.

### 3. Separate feasibility rounds: reserve them for a decision-changing uncertainty

**Yes. A feasibility round should be exceptional, not a default stage before each fix.** Require a named uncertainty about whether the approach can achieve the agreed outcome, the smallest decisive check, and the decision its result will change. If existing evidence already supports the approach, include ordinary investigation and self-checks within the bounded implementation task.

A separate round is justified when it could prevent a costly wrong implementation, when materially different approaches depend on its result, or when an essential source capability remains unknown and the needed access is authorized. It should stop with a concrete proceed/change/stop recommendation, not automatically create another prototype.

The P6.4 experiment did address a real uncertainty after repeated failed approaches and established useful per-span behavior. Its existence was not inherently a process error. Its preservation and coverage claims were too broad for the evidence; another prototype stage would not by itself have corrected that. Codex should specify the decisive preservation and failure cases when recommending such a round.

### 4. Shared proof code: allow a small helper, keep the framework boundary

**Recommend allowing a narrow extraction of repeated, stable test mechanics in the next suitable authorized task.** The "no new harness framework" boundary should prevent a separate tooling project, not force duplicated route setup and memory guards forever. The earlier advice to wait for stability should apply to the mechanics being extracted; the entire product need not be finished first.

A suitable helper may own memory-only fixtures/guards, invoking the actual production branches, capturing observations, and verifying injection/branch selection. Expected answers, semantic ownership assertions and each submission's pass criteria stay explicit in its proof. A helper must not synthesize the very refusal or execution observation it claims to verify.

Keep it local and dependency-free, with ordinary functions rather than a plugin system, general evaluator, new runner/service, agent-coordination channel or automatic source access. Establish that the shared mechanics reach the intended code and fail visibly when injection, extraction or access guarding breaks. Independent review can reuse inspected mechanics while supplying its own expectations and adversarial cases.

Historical proofs and receipts stay immutable. New receipts identify the helper and relevant input hashes so later helper edits cannot masquerade as replay of the same evidence. Compare equivalent observations before/after extraction; do not merely compare pass totals. No migration of all old proofs and no extra approval checkpoint solely to complete a helper project.

This is a recommendation to permit modest reuse when it serves authorized work. **No helper is to be built from this process request, and no helper is a prerequisite for the pending review.**

### 5. Disposition and short handoff

Recommend adopting the comparison-plus-meaning requirement, explicit coverage of existing forms, exceptional feasibility rounds, and permission for narrow shared test mechanics as prospective working practice. Preserve honest limitations and the finite review/correction discipline. This recommendation is recorded here, separately from the product handoff; product authority, pending review criteria, source gates, roadmap status and scores remain unchanged. No product, test or evidence file was changed and no proof or prototype was run for this process response.

**Short Claude prompt:**

> Read "Process recommendation - comparative submissions, explicit coverage and proportionate tooling" in the working agreement. The proposed standing check combines baseline/candidate differences with independent meaning assertions: F2 was a changed outcome, F1 an unchanged wrong outcome. Existing forms need explicit coverage; feasibility is conditional, and a small shared helper can fit the framework boundary. Recommendation only: do not add work or acceptance gates to the pending unit-ownership review, build a helper, or send an acknowledgment-only reply.

Claude proposed earlier checks and less duplicated test setup to reduce repeat review cycles. I recommend those changes with clear limits so we catch both lost answers and unchanged mistakes without adding another round of process.

## Avoid rabbit holes - standing owner preference

2026-09-24. Jeff asked for this to be remembered across sessions. Pursue the shortest defensible route to the original outcome. Every new prerequisite must address a concrete failure that matters to the next decision. Defer optional improvements; an exploratory model evaluation does not require certification or repair of the whole application. Product failures can be results, while trustworthy measurement and essential safety remain required.

Batch essential fixes, preserve credited evidence, and honor the existing correction allowance. Reassessment after a failed pass must consider a materially simpler route; renaming the scope or incrementing a version does not reset the allowance. Keep guiding the work without abandoning the original goal, silently lowering standards or sending routine decisions back to Jeff. State emerging scope growth early and recommend what to defer. Do not promise another pass will be the last without evidence.

This strengthens the existing process; it creates no new workstream, acceptance gate, source access or spending authority. The current qualification correction remains within its existing scope and allowance.

**Short Claude prompt:**

> Read "Avoid rabbit holes - standing owner preference" in the working agreement. Apply it within the current authorized scope: complete the agreed outcome, defer optional improvements, consolidate essential corrections, and do not reset the correction allowance by versioning. If the approach still fails, identify the shortest viable alternative. No acknowledgment-only handoff or new workstream.

Claude's latest submission established local harness progress while leaving the test incomplete. This instruction keeps the next work focused on obtaining a useful model result without expanding the preparation into another project.


## End every review with a necessity check

Owner instruction, 2026-09-24: before issuing a final review or authorizing follow-up work, ask whether each requested change is necessary for the user's next decision or is avoidable rabbit-hole chasing.

- For each proposed blocker, state the concrete consequence of leaving it unchanged for the next authorized action. Separate execution/safety/measurement failures from optional robustness, polish and general product certification.
- Check whether existing evidence, human review, an explicit limitation or a smaller action can support the decision without another build or investigation. Do not silently lower the user's promised outcome or correctness requirement.
- Defer changes that cannot justify blocking the next decision. Consolidate the necessary ones and preserve accepted work and the correction allowance. A renamed task is not a new allowance.
- End the review with a brief visible conclusion: **Necessity check:** what must happen now and why, and what is deferred. If no change is needed, say so and accept. This is a judgment check, not a new checklist artifact, test suite, approval gate or reason to prolong the review.


**Short Claude prompt:**

> Read "End every review with a necessity check" in the working agreement. For each proposed blocker, explain what would go wrong if it were skipped for the next decision; defer optional work and reuse accepted evidence. No new task, acknowledgment submission or change to current authority.

Claude's latest package established local progress but left the actual launch and some answer references unfinished. This instruction requires future reviews to justify the necessary next work and remove avoidable detours before handing it back.


## Owner instruction - Claude selects proportionate Codex review

2026-09-25. Jeff approved delegating routine review triage to Claude and instructed: "at the end of each prompt claude should say whether a codex review is needed". Apply this at the end of **every final response to a user prompt**, including explanations, status replies and handoffs; it does not require a footer on every intermediate progress update.

Use one of these final lines:

- **Codex review: Needed ?** [the concrete risk or explicit review requirement; pending, or completed with a link to the review and the reviewed candidate].
- **Codex review: Not needed ?** [the brief reason this work can proceed without separate independent review].

When preparing a paste-ready task prompt or handoff, include its review decision there too. "Needed" does not mean "already reviewed"; distinguish a recommendation, an actual completed review and owner execution approval.

### How Claude decides

- **No separate review by default:** ordinary explanations, status updates, documentation, formatting and routine preparation that do not change behavior, permissions, acceptance criteria or consequential instructions. A document changing a grading rule or production runbook is judged by its effect, not its file extension.
- **Claude's judgment:** small, reversible implementation changes that preserve established behavior and have proportionate, convincing verification. Explain the decision in one sentence; do not create a separate triage report.
- **Independent Codex review required:** substantive changes to question interpretation, SQL correctness, source identity or consistency assumptions, answer grading, spending/accounting controls, credential handling, or production execution. Also review material proposals that change those requirements and any work whose active approval explicitly requires review. Passing Claude's own tests is not grounds to waive these triggers.

Review a completed related batch, not each intermediate prompt or minor edit. A separate pre-build review is warranted only when an approach, material risk or owner decision genuinely needs settling first, or the active scope already requires it. Routine clarification of an accepted approach is not another gate.

### CLI versus chat review

A substantive independent Codex CLI review ordinarily **replaces** the equivalent Codex chat review. Supply the exact candidate or diff, intended behavior, scope boundaries and evidence; retain the findings and their disposition in the existing handoff. A CLI invocation or exit code alone is not acceptance. If the reviewed candidate changes materially, the old review does not cover that change.

Bring unresolved consequential findings, conflicting recommendations and reserved owner decisions back for one consolidated decision. Do not make an additional chat review mandatory merely because the first review ran in the CLI. Equally, do not use CLI review to bypass an explicit active milestone ruling or a consumed correction allowance.

This is review-routing authority only. It grants no new provider/CLI spend, source or machine access, implementation scope, deployment, commit or destructive action. Do not launch a review tool outside existing permissions. The current Phase 3 combined-checkpoint task still requires its consolidated review because it changes completion accounting; its product/source/provider boundaries remain unchanged.

### Short Claude prompt

> Read "Owner instruction - Claude selects proportionate Codex review" in docs/superpowers/2026-09-10-simpler-collaboration-working-agreement.md and the updated standing rule in CLAUDE.md. End every final response with "Codex review: Needed" or "Codex review: Not needed", plus a concrete reason and the review's status when applicable. Skip separate review for routine work; use one independent review per consequential batch, with CLI replacing duplicate chat review. Continue the current authorized task; no acknowledgment-only handoff or expanded permissions. Codex review: Not needed for adopting this owner-approved process instruction; the current accounting batch still needs its agreed review.

Claude now has explicit authority to decide when routine work needs another reviewer. The rule keeps independent checking for consequential changes while removing duplicate reviews and unnecessary relays.

**Necessity check:** use one short review decision to make the next action clear; no new checklist, routing tool, mandatory CLI invocation or extra approval stage is needed.
