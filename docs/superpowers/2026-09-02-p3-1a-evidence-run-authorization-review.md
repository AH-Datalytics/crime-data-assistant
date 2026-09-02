# P3.1a one-shot evidence-run authorization review

**Date:** 2026-09-02  
**Verdict:** **APPROVED WITH COMMAND-FORM CORRECTION**  
**Authorization:** exactly one 63-case evidence run is authorized; P3.2 remains unauthorized

## Reviewed identity

- Final merged commit: `e986dac6a0e5537b1a699ec01d9acb45bb3aa634`
- Merged tree: `9d3b2f9969520dac13ef3ede00ec6a36628edd00`
- Parent: `e2d24acd37027f436590ed8eae58bb5b30414ffb`
- Runner SHA-256: `aaeb1dd29694df52b878da73fe878dde6fbc94dc9a4ab278dc0b6b5878b92f77`
- Governing v3 SHA-256: `2535cbd934a4766a7f9ff8570f5b0e60d04b7c37430283b48e52b206c75a0b91`
- Governing case count: 63

The post-merge qualification completed successfully with fixture verdict `fixture_passed`, corpus
verdict `corpus_not_certified`, 177 passed Tier F commands, 10 skipped Tier C commands, zero failed,
zero blocked, and exact 187-command accounting. That result does not certify corpus data integrity.

## Authorization

One execution is authorized from a clean checkout at exactly the merged commit and tree above,
using this literal single-line command:

```text
npx tsx scripts/run-p3-1a-frozen-cases.ts --run --candidate e986dac6a0e5537b1a699ec01d9acb45bb3aa634 --tree 9d3b2f9969520dac13ef3ede00ec6a36628edd00 --runner-sha aaeb1dd29694df52b878da73fe878dde6fbc94dc9a4ab278dc0b6b5878b92f77
```

This single-line form replaces the draft's backslash-wrapped display, which is not a valid
PowerShell continuation form. No substantive pin or runner argument changes.

The authorization ends after the first invocation, regardless of exit status. There is no retry,
second attempt, altered argument, changed pin, or re-run after refusal or failure without a new
decision.

## Required interpretation and verification

- Exit 0: accounting complete and evidence conformant.
- Exit 1: accounting complete, but evidence nonconformant or not established; report it without
  retry.
- Exit 2: refused before execution or accounting defective; report the refusal without retry.

Before describing the artifact as evidence, independently verify its provenance, separate
accounting and evidence verdicts, all four per-case axes, exact 63-case accounting, immutable
destination, and unchanged frozen-set after-digests.

The result may claim exact agreement or disagreement on the 63 predeclared deterministic
conformance cases only. It is not an unseen holdout or an estimate of generalization or production
accuracy.

## Documentation disposition

Do not open a standalone PR solely for the remaining review documentation. Round 7 review and
response are already present in the merged tree. Preserve the round 8 review and this authorization
with the eventual evidence-run or refusal record in the follow-up record change.

## Exclusions

This authorization does not permit P3.2, enforcement, production activation, production traffic,
model calls, database writes, a second evidence run, or any expansion beyond the exact command and
post-run verification above.
