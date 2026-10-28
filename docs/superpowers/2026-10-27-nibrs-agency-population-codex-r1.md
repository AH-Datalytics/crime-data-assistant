# Codex review r1: NIBRS agency population fix (2026-10-27)

Reviewer: Codex CLI plugin (codex:codex-rescue), read-only. Candidate: uncommitted worktree fix/nibrs-bh-population-all-counties. Verbatim:

**Verdict: ACCEPT WITH CHANGES.** The parser fix is sound for the stated master-file layout. The correction script and production procedure need the following changes before production use. No files were edited.

1. **High — `agency_reporting_gaps` is updated using the wrong population semantics.**  
   [build_reporting_gaps.py:52](scripts/build_reporting_gaps.py:52) selects `MAX(a.population)` **across all years for each ORI**, then writes that value into every gap year. The correction instead treats it as an ORI-year copy and requires equality with that year’s old population at [correct-nibrs-agency-population.py:250](scripts/correct-nibrs-agency-population.py:250).

   **Consequence:** legitimate gap rows can abort the whole correction; gap rows outside the changed years can retain an obsolete maximum.

   **Exact fix:** handle this table separately. Back up all existing gap rows for affected ORIs, calculate their old and corrected all-year maxima, validate against the old maximum, and update all their gap years to the corrected maximum. Add a fixture with differing populations across years. Do not simply remove the old-value guard.

2. **Medium — compute assumes deduplication that the importer does not perform.**  
   [compute:134](scripts/correct-nibrs-agency-population.py:134) silently keeps the first BH per ORI-year. The importer [appends every BH](scripts/nibrs-auto-update.py:658) and uses plain `INSERT`; its raw deduplication does not include `agencies`. The exported agencies CSV also silently collapses duplicate keys into a dictionary.

   **Consequence:** repeated headers with different later slots can yield an unjustified correction. Duplicate stored rows generally cause safe refusal through the backup count check, rather than successful correction.

   **Exact fix:** explicitly detect duplicate exported keys and repeated BHs. Permit collapsing BHs only after verifying identical population inputs; refuse conflicting duplicates with an actionable report. Establish one stored row per correction key before applying. Add identical/conflicting repeated-header and duplicate-agency tests. No broader importer deduplication project is necessary if the production preflight establishes uniqueness.

3. **High — restore cannot establish row identity.**  
   [restore:295](scripts/correct-nibrs-agency-population.py:295) restores by table and rowid and checks only the number updated.

   **Consequence:** after a refresh, rebuild, or rowid reassignment, the same rowids can identify different records; restore can corrupt populations and still report success.

   **Exact fix:** retain rowid but back up identifying columns and expected post-correction values. Validate identity and current values for every target before updating anything; refuse on mismatch. Document that backups cannot be used after intervening table replacement/reimport without those checks. Test reused rowids and changed identities, not just immediate restore.

4. **Medium — the live procedure misses cached populations and another population-filtered dataset.**  
   [nibrs-place-resolver.ts:515](lib/nibrs-place-resolver.ts:515) caches resolved places—including population—by database connection and geography/year range, without a data-version check. Those populations feed peer selection.

   **Consequence:** existing processes can continue using old population evidence after the database correction; a fresh SQL spot-check does not establish that application behavior is corrected.

   **Exact fix:** restart/reload application workers after correction and coverage rebuild, **before** live acceptance checks; repeat after rollback. The importer deployment can supply that restart if deliberately placed there, and must complete before November 16.

   Also document that [build_cde_agency_totals.py:184](scripts/build_cde_agency_totals.py:184) and `update_cde_totals.py` select agencies using a population floor. Newly eligible agencies may be missing there too. Produce explicit threshold-crossing counts: compute currently reports statuses, not those counts. Review the affected memberships before deciding whether rebuilding/backfilling can be deferred.

The remaining technical assessment:

- **Parser:** the five slices are implemented correctly as specified. Placeholder suppression happens per slot, preserving the existing `>= 100,000,000` rule. Zero remains zero; blank/unavailable slots contribute nothing. `s()` ignores an incomplete field rather than parsing a truncated number. Strictly, `None` means no *valid numeric* slot, not only “all blank.” I found no caller relying on the previous first-slot `None` behavior beyond storage. The [NACJD field inventory](https://www.icpsr.umich.edu/sites/nacjd/resources/learning-and-data-guides/nibrs-resource-guide/nibrs-file-specifications/varlist) corroborates the repeated current/previous population structure; I did not independently validate the exact offsets against an archived layout file.
- **Apply safety:** backup creation and integrity/count checks precede source updates. Source updates share one `BEGIN IMMEDIATE` transaction; detected failures roll back, and closing an uncommitted connection also rolls back SQLite exceptions. A backup file can remain after failure—“nothing changed” applies to source data.
- **Backup consistency:** backup reads occur before the SQLite write transaction. This is adequate only while competing writers are excluded. The maintenance lock explicitly does not exclude nonparticipating writers; the procedure should require those builders to remain idle through backup/apply.
- **Locks:** release-then-maintenance ordering is consistent with deployment. Maintenance acquisition waits up to an hour by default; it is not immediate “busy” behavior. SQLite errors are not normalized to the advertised exit codes, but this alone does not defeat rollback.
- **Totals:** floating `TOTAL()` is acceptable for these integer populations and realistic aggregate sizes below `2^53`; changing it is not necessary. It is an aggregate sanity check, not proof that every unrelated row stayed unchanged.
- **Copies/rollups:** the year-specific copy condition is appropriately conservative where that provenance holds. I found no population columns requiring a NIBRS rollup rebuild. The two server-only copy builders were unavailable here, so their exact schemas/provenance remain based on the supplied description.

**Tests:** `python -B scripts/test_nibrs_bh_population.py` passed **7/7**. I attempted the correction suite; **all nine tests errored during setup** because the read-only sandbox provides no writable temporary directory. That is an environment limitation, not nine demonstrated implementation failures. Its current fixtures miss the findings above. Add those focused cases plus a NULL-old-population apply/restore case, then run the suite in a writable test environment.

**Necessity check:** fix the gap-table semantics, duplicate assumptions, restore identity checks, and cache-refresh procedure before production authorization; obtain a passing correction-suite run. Threshold backfills may be deferred only after reviewing actual affected memberships and recording the limitation. A full database backup, general rollup rebuild, and broader product certification are unnecessary for this decision.

