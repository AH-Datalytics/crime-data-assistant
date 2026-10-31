# Codex review 04: increment 7 full review

Reviewed 2026-10-31, read-only, no network, of `origin/dev...HEAD` at 01f0717 and the scored run against nibrs-model main 6b98d8d (V131-V146). Verdict: **REVISE** (five P2). Applied as below.

1. **P2: person conditions silently dropped standalone Group B arrests.** Any condition on the arrestee took the Group A-only path, while the answer said Group B was included. "Juvenile arrests in Denver in 2023" would give 939; V141 gives 1,114 (939 Group A plus 175 Group B).
   - Applied: compile.ts keeps conditions on the counted person apart from conditions on the incident. Every arrest with only a person condition is Group A and Group B, with the condition on both.
   - The shadow now answers 1,114. A compile regression checks both branches.
2. **P2: "Arrests ... by victim race" became the arrestee's race.**
   - Applied: the "by victim <attribute>" rewrite moves into readPeople. For arrests it is declined: an arrest records the arrestee, not the victim. Reader and shadow negative controls were added.
3. **P2: a pair condition was described as a pair grouping.** LS-396 excludes victims with no relationship, but the sentence said they are shown.
   - Applied: a new statement, `pair_condition`, required exactly for a condition on linked offenders. `pair_linked` is now for a grouping only.
   - The scorer requires `pair_condition`, and not `pair_linked`, for LS-396.
4. **P2: the unknown-value sentence named every attribute** where only the constrained one is tested.
   - Applied: "An unknown or unrecorded value does not meet a condition on a person, so that person is not counted."
5. **P2: the reader test still expected "committed by juveniles" to be unsupported.** Applied: it now checks the offender-age condition and the cleared flag.

Codex also answered three questions:
- **LS-384 and LS-388 correction (sequence 00 segment convention): CONFIRMED.** V59 is to be regenerated with seq_00 as its own category.
- **(a) Zero contrasts in Memphis** (LS-379 vs LS-396; LS-382 vs LS-383): add Denver 2023 aggravated-assault cases at the next label pass. The frozen cases stay, with their limited discrimination noted here: in Memphis 2024, every victim is linked to every offender of its incident.
- **(b) LS-392:** do not choose Memphis automatically. Corrected: the label now expects the decline without an agency alternative (the label notes say why).
