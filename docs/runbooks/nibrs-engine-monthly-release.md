# NIBRS engine: pointing the shadow engine at a new monthly release

The shadow engine (lib/nibrs-shadow) reads one canonical release. Three repo fixtures and two cubes are bound to that release; when the FBI's monthly CDE file arrives and the Model builds a new canonical release, they must all be regenerated before any script, scorecard or preview reads it. Until then `loadNibrsRelease` refuses the new build (release id and latest-year source sha256 do not match), by design: a cutoff from one build is never applied to another. The shadow engine runs locally and on the runner only; nothing here touches the VPS, B2 or the public site.

Written 2026-11-18 after the November release (canon2-20261118-host, new 2026 file sha256 4ada0be5...).

## Inputs the cycle needs

- The new canonical release dir (its parent holds `manifest.json`; `<release>/canonical` is the `--root`).
- The Model's `manifests/source-archive.json` (the CDE last-modified time of the new latest-year file).
- The Model's `reference/agency-names/agency-names.csv` on `main`.
- For agencies.json: the release's `agency/data.parquet`, `crime_data.db` (Historical agency table), and optionally the agency crosswalk release dir and the Crime Index build dir.

## Steps (in this order)

1. **release.json**: `python -I scripts/build-nibrs-shadow-release.py --release-dir <release dir> --source-archive <source-archive.json> --first-year 2017`. First year stays 2017: the labels, cubes and gates start there; widening the engine to earlier years is a separate product decision (Jeff 2026-11-18). The latest shown month is the month before the CDE file's release month (P93): a file released 2026-11-15 shows data through 2026-10.
2. **agency-names.json**: `python -I scripts/build-nibrs-agency-names.py --model <nibrs-model checkout> --release <release id>`. It copies the Model's directory (the file does not depend on the release except for the id), so ORIs new in the release have no name until the Model refreshes the directory; the engine then shows the ORI.
3. **agencies.json**: `<python with duckdb> -I scripts/build-nibrs-shadow-agencies.py --root <canonical dir> --names <crime_data.db> --release <release id> [--crosswalk <dir> --crimeindex <dir>]`. Needs the release's agency parquet (2026 populations; agencies new or gone since the last build). The engine does not check its release id, so an old file reads without error and silently carries the old population and agency list: do not skip it.
4. **Cubes**: the Model refreshes the group cube (crime_groups_v2) and the code cube against the new release (each manifest records `source_manifest_sha256` of the release's manifest.json; a cube built from another release is refused with a stderr line and the engine reads raw: slow, never wrong). The code cube must be built at Model commit 064661b or later (offender sequence 00 blank in sex and race).
5. **Checks on the runner**: `scripts/test-nibrs-cube.ts` cell by cell (cube vs raw; env NIBRS_CUBE_TEST_ROOT, _CUBE, _CODE_CUBE, _PYTHON, _QUESTIONS), then the scorecard with the flag on and off, the 53 heavy ids and a shadow run. Merge only when all are identical to the previous release's rules.
6. Commit the three fixtures in one small PR into dev; the correctness indexes (the Model's repo) and the record of new values are the Model's.

## Known cost

Steps 1 and 2 take seconds. Step 3 needs the release and the other inputs on the machine that runs it (not timed). The cubes are the long part (the Model's figure is 1.5 to 2.5 hours per ten-year cube).
