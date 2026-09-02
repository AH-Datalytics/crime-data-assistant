# P3.1a evidence disposition and follow-up handoff

**Date:** 2026-09-02  
**Purpose:** dispose the completed P3.1a evidence run, assign the Ward finding, and authorize the
smallest next actions without expanding into P3.2  
**P3.2:** unauthorized

## 1. Evidence-run ruling

The one-shot authorization was consumed exactly once. The preserved artifact is:

| Item | Value |
|---|---|
| Artifact | `run-20260902_130744.json` |
| Preserved directory | `C:/Users/jeffm/cda-evidence/p3-1a-evidence-20260902/` |
| SHA-256 | `a97860ee73cc6b775a1828f7a540e6dfb8402956094a8c5597f8866629a6535e` |
| Bytes | 41,419 |
| Exit | 1 |
| Accounting verdict | `complete` |
| Evidence verdict | `nonconformant` |
| Cases | 63 total: 58 conformant, 5 nonconformant |

Independent inspection confirmed the artifact hash, 63 results and unique ids, 63 completed parser
executions, one parser visit per case, no parser error, no analysis-incomplete result, no harness
error, and the five recorded disagreements. All five are the Ward, Arkansas false-acceptance probes
for `unsupported-sub-city-geography`, one for each source.

The run is trustworthy and the system is nonconformant against this deterministic conformance set.
Do not call it a holdout, generalization estimate, production-accuracy measurement, or corpus data
certification.

P3.1a achieved its bounded measurement purpose and may close with a **nonconformant measurement
result** after the record change in §2 lands. The finding does not authorize P3.2.

## 2. Decision: land the evidence record

**Authorized:** prepare and land one documentation/evidence-only follow-up change. The two normal CI
qualification points are authorized. Do not weaken or bypass them because the change is records-only.

Include:

1. `docs/superpowers/2026-09-01-p3-1a-candidate-review-round8.md` from the reviewed worktree;
2. `docs/superpowers/2026-09-02-p3-1a-evidence-run-authorization-review.md`;
3. `docs/superpowers/2026-09-02-p3-1a-evidence-run-authorization-handoff.md`;
4. `docs/superpowers/2026-09-02-p3-1a-evidence-run-record.md`;
5. this disposition/handoff; and
6. the artifact, byte-for-byte, at
   `docs/superpowers/p3-1a/runs/run-20260902_130744.json`.

Before commit, verify the copied artifact remains exactly 41,419 bytes with SHA-256
`a97860ee73cc6b775a1828f7a540e6dfb8402956094a8c5597f8866629a6535e`. Preserve the external copy.

The change must contain no production code, test code, runner, frozen-set, contract, package,
workflow, timeout, or harness-manifest modification. In particular, do not edit any frozen case to
match the observed system and do not combine the Ward correction with this record change.

Qualify the exact PR head, merge through the reviewed path, verify the merged path set and artifact
identity, and run post-merge qualification. Report the fixture and corpus verdicts separately and
honestly. A CI timeout does not count as a pass and does not authorize repeated retries or a timeout
change inside this record PR.

## 3. Decision: Ward is a standalone correctness item

The Ward defect does **not** belong in P3.2. P3.2 concerns activation/enforcement decisions; it must
not absorb a known defect in the predicate it might later enforce.

No governed P3.1b scope currently exists in the reviewed roadmap. Do not invent one merely to hold
this finding. Assign the issue as a standalone bounded correctness item:

**Ward incorporated-place false-refusal correction**

It is a prerequisite finding for any later P3.2 decision. Its objective is to prevent an
incorporated place whose proper name contains a sub-city token—demonstrated by Ward, Arkansas—from
being classified as a below-city request, while preserving genuine ward/district/precinct
detection.

The frozen v1/v2/v3 sets and the completed nonconformant artifact are immutable historical evidence.
Never rewrite their expectation or result after the fix. A regression test may reuse the question
and expected behavior in a new test fixture, but it must not alter the frozen evidence.

Do not implement the fix under this handoff. First complete the diagnostic in §4 and return with a
narrow correction contract.

## 4. Decision: authorize an offline production-path diagnostic only

**Authorized:** one bounded, read-only diagnostic of the actual production decision path for the
Ward question. This is not a second frozen-case run and not a fix.

The diagnostic must:

1. use the real production predicate and the real post-SQL validator/route decision wiring, not the
   P3.1a observer as a substitute;
2. use deterministic local inputs sufficient to reach that path, including an explicitly declared
   contract and SQL/table fixture where required;
3. identify, per applicable production route/source, whether the request reaches
   `decline_capability / query_contract_failed`, and at which exact stage;
4. include a genuine sub-city positive control and an ordinary incorporated-city negative control
   so the Ward result is not interpreted in isolation;
5. make no repository change, database write, model call, network request, production request,
   production traffic, or external side effect; and
6. state the limit honestly: an offline production-path reproduction is not a live end-to-end
   request.

If reaching the real decision path cannot be done without a model call, database access, live
server request, production traffic, or mutation, stop and request a new authorization. None of those
actions is authorized here.

After the diagnostic, write a short report naming the exact path, observed result, controls, and
remaining end-to-end uncertainty. Then propose—but do not implement—a correction contract covering
the smallest durable semantic fix and its regressions.

## 5. Demographic-rate asymmetry

The demographic-rate phrasing asymmetry remains a separate unassigned finding. Do not combine it
with the Ward diagnostic or correction. Record it in the next program-level open-findings inventory;
no implementation or probe is authorized by this handoff.

## 6. Sequence

1. Land the records-only change from §2.
2. Stop and report its merged identity and both qualification results.
3. In a separate clean worktree/branch, perform only the offline Ward diagnostic from §4.
4. Return the diagnostic report and proposed standalone correction contract for review.
5. Do not begin the fix, a live end-to-end probe, P3.2, or another evidence run.

## 7. Short prompt for Claude

> Read `docs/superpowers/2026-09-02-p3-1a-evidence-disposition-and-followup-handoff.md` and follow it
> exactly. First prepare and land the records-only change in §2, including the byte-identical
> evidence artifact, with normal PR-head and post-merge qualification. Stop and report that landing.
> Then, only after the records change is complete, perform the separate read-only offline Ward
> production-path diagnostic authorized by §4 and return a diagnostic report plus a proposed
> standalone correction contract. Do not edit frozen cases, implement the fix, run a live request,
> call a model, access a database, generate production traffic, rerun the 63 cases, or begin P3.2.
