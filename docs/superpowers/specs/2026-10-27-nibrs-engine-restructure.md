# NIBRS answers on one facts table: restructure plan (draft for Codex)

**Owner, 2026-10-27:** "I'm open to a complete restructuring if there's a smarter way to make it possible to answer more
questions without summary tables." "Should you discuss with codex and come up with a plan for the proper way forward?"
"Please ensure codex agrees this is a preferable approach too." Then: "Nay -- the ideal approach." The bar is the ideal design, not an improvement on the current one.

## The problem, measured

NIBRS questions, last 60 days (query_log, tab nibrs, test sessions excluded):

| outcome | count |
|---|---|
| answered, deterministic plan | 179 |
| answered, model-written SQL (validated) | 173 |
| declined: no capability path | 146 |
| declined: query contract failed / model produced no SQL / SQL shape rejected / guardrail | 52 |
| declined: no rows, source health | 25 |
| asked to clarify | 15 |

About 4 in 10 NIBRS questions are not answered. The causes found on 2026-10-27:
- **Wording the reader does not map:** "where a", "large cities", "cities of 250,000 or more", a month range across years.
- **Misreadings:** "firearm stolen" read as the weapon used, not the stolen property.
- **No summary table for the combination:**
  - stolen property by month;
  - two breakdowns at once, e.g. "share of murder victims by race and sex per month in Houston since 2018";
  - a top-N list per month.

**Why the third cause keeps recurring.** Each question type (series, breakdown, share, rank, change: `lib/nibrs-question-types.ts`) has its own compiler path, aimed at its own summary tables. `nibrs.db` holds 37 `summary_*` tables. A new combination therefore needs a new table plus new code, and the model-written-SQL fallback needs its own guardrails. The data itself is a 179 GB SQLite row store, normalized as the FBI ships it. Raw scans with joins are too heavy for the web server, which is why only summaries are allowed.

## What NIBRS Savant shows

Savant (AH-Datalytics/nibrs-savant) answers any combination of whitelisted fields, by month or year, in milliseconds:
- **`etl/build.py` builds one wide table.** `crime_facts` has one row per countable offense, and one row per victim for person crimes, with every field attached. `property_facts` has one row per property segment. Both are columnar DuckDB.
- **`nibrs_savant/query.py` is one general compiler** (filters, up to 3 group-by fields, whitelisted metrics). `nibrs_savant/cubes.py` adds pre-aggregated cubes, used automatically when they cover a search; tests prove the answers are identical.
- **`nibrs_savant/registry.py` is the single list of fields, labels, definitions and metrics.**
- **Size.** 12 states for 2017-2026 take 2.8 GB, which is 36% of national offenses. National 2017-2026 is about 8 GB; 1991-2026 about 15 GB. Free space: 76 GB on the NIBRS volume.
- **Data flow.** Savant's data is exported from NIBRSAI's own `nibrs.db` state by state, at night, and built off the web server. A national build is in progress.

## Facts from the NIBRS Savant session (2026-10-27, code at e491850)

- **Schedule.** Live now: 12 states, 2017 through October 2026. The remaining 39 states export from the night of October 28, then one laptop build (~2 h), comparison, speed test and Jeff's OK. Best case the national release is live around November 1-2, and it could slip. Years: 2017-2026 only; pre-2017 is not planned.
- **Files.** One DuckDB 1.5.6 file per release: `/opt/nibrs-savant/releases/<id>/facts.duckdb`, with `gate.json`, `SHA256SUMS` and `BUILT_AT`. `live` and `previous` are symlinks, and only those two releases are kept.
  - Tables: `crime_facts` (71 columns), `property_facts` (24 columns), `agencies` (ori, year, state, name, population group, population), `build_info` (built_at, partial year, row counts), and seven cubes plus `cube_info`.
  - Estimated national size: 10-12 GB.
- **Counting.**
  - `crime_facts`: person crimes have one row per victim x connected person offense (`count_unit='VICTIM'`), with offender attributes from that victim's first relationship. Property and society crimes have one row per offense (`count_unit='OFFENSE'`).
  - Incidents: `incident_first` marks one row per incident, valid only for incident-level fields; otherwise `count(DISTINCT incident_id)`.
  - Clearance is incident-level.
  - `property_facts`: one row per property segment, attached to the incident's most serious property offense. Recoveries are linked back to the stolen segment.
  - Exports are deduplicated and recounted against `nibrs.db`.
- **Gaps compared with `nibrs.db`:**
  - first-value-only fields (offender suspected of using, criminal activity, injury type, relationship, aggravated-assault circumstance, suspected drug type); weapons 1-3 only;
  - no Group B arrests and no 90x Group B offenses;
  - a person-crime offense with no connected victim produces no row;
  - nothing before 2017.
- **Conditions for NIBRSAI reading the files:**
  - pin a release by full path, which needs a hold list that Savant's `release_switch.sh` honors before deleting (a Savant change);
  - cap NIBRSAI's own process memory and threads (Savant uses a 3 GB DuckDB limit, 2 threads, 4 GB MemoryMax);
  - check a schema version per release (Savant can add one to `build_info`);
  - each pinned release costs 10-12 GB of disk (54 GB free on root);
  - Savant refreshes about the 19th-20th each month, after NIBRSAI's 16th-18th update.

## Consequences for NIBRSAI (from those facts)

1. **Years.** NIBRSAI answers NIBRS from 1991 today; the shared release starts in 2017. Either the build goes back to 1991, or pre-2017 NIBRS questions keep the current path until it does. Open decision 1.
2. **Arrests and Group B.** NIBRSAI answers arrest questions today (the home page suggests "DUI arrests by age group nationally"). The shared release has no arrests table and no Group B. The build needs an `arrest_facts` table (one row per arrestee, Group A and B) before arrest questions can move.
3. **Multi-value fields.** Questions that depend on a second or later value (a second weapon, a second injury type, a second relationship) can differ from NIBRSAI's answers. The shadow comparison must classify these, and the build can carry more values if needed.
4. **Freshness.** After each monthly update NIBRSAI would answer from the previous month's release until the facts build finishes (about 2-4 days). Either NIBRSAI's update triggers the facts build, or answers carry the release's data-through date.
5. **Savant-side changes needed first:** a hold list for pinned releases, a schema version in `build_info`, and the NIBRSAI tables the plan needs (`arrest_facts`; pre-2017 if decided).

## Proposal

1. **Shared data, not a shared service.**
   - One build pipeline (Savant's) produces immutable, numbered national releases: `crime_facts`, `property_facts`, cubes, agencies.
   - NIBRSAI and Savant read the same files read-only.
   - Each product runs its own query process: NIBRSAI never calls Savant's public API.
   - Each product pins which data release it reads, and moves to a new one only through its own release checks (`scripts/release.sh` with `expected-changes.json`).
2. **One shared field registry**, as a versioned module both products use. It defines each field's meaning, labels and definitions, and drives NIBRSAI's reader vocabulary, the "Understood as" chips, validation, titles and table headers.
3. **One NIBRSAI engine for NIBRS.**
   - The reader (the existing typed parser, extended) produces a **structured search**: dataset, filters on registry fields, up to 3 group-by fields, a metric, period and grain, and the denominator for shares. This replaces per-type SQL.
   - The model may fill in a structured search only; it never writes SQL.
   - Every search is validated against the registry before it runs.
   - Request accounting stays: every part of the question must map to a field of the search, or the answer is refused or clarified.
4. **Clarify instead of decline.** An unmapped word returns the nearest registry fields as chips to confirm or adjust: Savant's filter panel as the fallback.
5. **Keep and extend the question reader and request accounting.** The work that teaches the app what a question asks, and whether every part of it can be applied, is the front half of this design and is not rewritten. Its target changes: from "which summary table and compiler path serves this" to "does every part map to a registry field, and does the data cover this place and period". With an engine that can answer almost any combination, this step becomes the main safeguard against answering the wrong question confidently.
6. **Carry over every NIBRSAI rule as engine behavior**, with a test for each:
   - person crimes counted by victim;
   - national is a sum, never an agency;
   - missing month versus zero;
   - partial years and coverage notes;
   - agency population denominators;
   - phantom-town geography guard;
   - "US" means national;
   - title formats;
   - refusal wording.

## Migration (strangler, NIBRS first)

| phase | done when |
|---|---|
| 0. Decision | Owner and Codex agree on the approach and the open decisions below |
| 1. National facts available | Savant's national release covers all states for 2017-2026. Recount gate as Savant does now (every segment table-year matches raw). Pinned path on the server. |
| 2. Shared registry module | Savant and NIBRSAI import the same registry version |
| 3. Engine behind a flag | NIBRSAI's own DuckDB read-only process with a memory cap, thread limit, bounded queries and its own logging. Structured search, then SQL, then rows. |
| 4. Shadow comparison | Every NIBRS question answered today also runs through the engine. Answers are compared, and every difference is explained: counting unit, coverage, or a bug in one side. Includes the frozen release questions and the named test cases below. |
| 5. Switch by question family | A family switches when its shadow differences are all explained and accepted. Declined families switch when their new answers pass review. |
| 6. Retire | The NIBRS summary tables and the model-SQL path for NIBRS are retired once every family has switched |
| later | Homicide Reports (one row per victim), Historical (agency-years) and Current Trends (agency-months) follow the same pattern |

**Named test cases.** Each must answer correctly or clarify precisely:
1. Share of murder victims by race and sex per month in Houston since 2018. Houston NIBRS starts mid-2018 (7 months); shares are within each month; the counts are shown.
2. Thefts from motor vehicles where a firearm was stolen, per month. Property description 13, loss stolen, offense 23F, nationally and for one state.
3. Car thefts in Baltimore by month, January 2022 to June 2026: a month range across years.
4. The frozen release questions (H1-H3) must stay byte-identical, or their differences be declared.
5. Today's 146 "no capability path" declines from the last 60 days are replayed; the share answered is reported.

## Alternatives considered

- **A. Keep the summaries and fix the reader.** Add a monthly property summary built off the server. Smallest change, but each new combination still needs a table and code, so the 4-in-10 decline rate is chipped at, not removed.
- **B. Hybrid.** Keep the current paths and send only unanswerable questions to the engine. Lower risk, but two engines forever, with two sets of counting rules to keep aligned.
- **C. This proposal.** One engine for NIBRS. Migrate with the shadow comparison so it is as safe as B during the transition, then retire the old paths.

## Risks

1. **Different numbers.** Counting unit, deduplication and property-matching rules can differ between the two. The shadow comparison must explain every difference before a family switches.
2. **Server load.** NIBRSAI and Savant share a 4-CPU, 15.6 GB server. NIBRSAI's engine process needs its own caps. National queries must be benchmarked, with and without cubes.
3. **Data freshness and coupling.** The monthly NIBRS update now has to flow through the facts build before NIBRSAI sees it. Pinning keeps either product from changing the other's answers unannounced.
4. **Lost guardrail knowledge.** Every rule in `lib/nibrs-claude.ts` and the route guardrails must become an engine test, not just a comment.
5. **Effort.** This is a rebuild of NIBRS answering. A family-by-family switch keeps the site working throughout.

## Open decisions for the owner

1. Years covered by the shared national release: 2017-2026, or back to 1991. NIBRSAI answers from 1991 today.
2. Whether Savant's public product moves to the national release too, or stays on its states.
3. How uncertain small-cell monthly shares are shown: counts beside shares, a minimum count, or a suggestion of quarterly or yearly.
4. Order after NIBRS: Homicide Reports, Historical or Current Trends next.
