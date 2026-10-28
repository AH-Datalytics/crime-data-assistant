# Codex review r2: NIBRS agency population fix (2026-10-28)

Reviewer: Codex CLI plugin (codex-companion task), read-only. Candidate: worktree fix/nibrs-bh-population-all-counties after the r1 changes. Verbatim:

**Verdict: ACCEPT.** All four r1 findings are resolved. I found no new blocking defect. No files were edited.

1. **Gap semantics:** `gap_max` correctly substitutes each corrected ORI-year’s new value before calculating the all-year maximum. All existing gap years for affected ORIs are backed up, checked against the old maximum, and updated.
2. **Duplicates:** compute compares all five raw population slots; conflicts remain excluded even after subsequent repeats. Duplicate exported keys are excluded, and apply requires exactly one agencies row per correction key.
3. **Restore and transaction checks:** restore validates rowid, ORI, year, and corrected population before writing. Apply rechecks backed-up identities and values inside `BEGIN IMMEDIATE`. `IS`/`IS NOT` correctly handle NULL populations. The writers-idle requirement remains necessary because these checks do not detect every possible concurrent insertion or change to an uncorrected year.
4. **Procedure:** worker reloads follow coverage rebuilds and rollback. Threshold memberships and the deferral for 13 newly eligible ORIs are explicitly recorded.

Validation: parser tests passed **7/7**. The correction suite’s 18 cases were blocked during setup by unavailable writable temporary storage—not implementation failures. Additional in-memory checks passed for maximum calculation, NULL apply/restore, and changed-before refusal. The CSV contains **9,517 changes, 259 mismatches, and 720 not-stored rows**, with population delta **31,534,816**; its SHA-256 matches the recorded rehearsal identifier. I rely on your supplied evidence for the full 18/18 run and production-copy round trip.

Minor provenance note: the corrections CSV is **untracked in this worktree**, despite being described as committed.

**Necessity check:** no further code changes are needed for the owner’s production decision. Execute the documented maintenance procedure after authorization; defer the recorded threshold backfills and two multi-county mismatches. No broader rebuild or certification is necessary for this correction.

