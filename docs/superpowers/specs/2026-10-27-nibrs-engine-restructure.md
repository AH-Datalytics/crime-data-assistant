# NIBRS answers on a lossless analytical model: restructure plan (r2, for Codex)

**Owner, 2026-10-27:**
- "I'm open to a complete restructuring if there's a smarter way to make it possible to answer more questions without summary tables."
- "Should you discuss with codex and come up with a plan for the proper way forward?"
- "Please ensure codex agrees this is a preferable approach too." Then: "Nay -- the ideal approach." The bar is the ideal design, not an improvement on the current one.
- "I suppose all the work we did in getting the app to appreciate what a question is asking and whether it can answer it is still essential to this new design." Yes; see principle 4.

**r1 → r2.** Codex rated r1 (one wide facts table per source plus a field registry) NOT IDEAL. A flattened representation keeps only first values (first victim for property offenses, first relationship, weapons 1-3), so it cannot answer arbitrary victim, offender, arrest or relationship questions correctly. r2 adopts Codex's design: lossless entities at explicit grains, preserved relationships, a versioned semantic and metrics layer, an expressive structured plan, deterministic compilation, selective accelerators, and pinned, resource-bounded serving.

## The problem, measured

NIBRS questions over the last 60 days (query_log, tab nibrs, test sessions excluded):
- 352 answered: 179 from deterministic plans and 173 historical model-SQL answers;
- about 240 declined or asked to clarify, roughly 4 in 10.

**Baseline correction (Codex):** model-written SQL no longer runs (`NIBRS_MODEL_SQL_NEVER_RUNS = true` in `app/api/nibrs-query/route.ts`). The 173 are historical evidence, not today's capability.

**Causes found on 2026-10-27:**
- unmapped wording: "where a", "large cities", "cities of 250,000 or more", a month range across years;
- misreading: "firearm stolen" taken as the weapon;
- no summary table for the combination: stolen property by month; race × sex × month shares; top-N per month.

**Why this keeps happening.** Five hand-written compiler paths (`lib/nibrs-question-types.ts`) are aimed at 37 `summary_*` tables in a 179 GB SQLite row store, so every new combination needs a table plus code.

## Facts from the NIBRS Savant session (2026-10-27, code at e491850)

- **Schedule.** Live now: 12 states, 2017 to October 2026. The other 39 export from the night of October 28; best case the national release is live around November 1-2. Years: 2017-2026 only.
- **Release layout.** One DuckDB 1.5.6 file per release (`/opt/nibrs-savant/releases/<id>/facts.duckdb`), plus `gate.json`, `SHA256SUMS` and `BUILT_AT`. Only `live` and `previous` are kept. Estimated national size: 10-12 GB.
- **Tables.**
  - `crime_facts`: person crimes have one row per victim × connected person offense; property and society crimes one row per offense, with the lowest-numbered victim.
  - `property_facts`: one row per property segment, attached to the incident's most serious property offense.
  - `agencies`, `build_info`, and seven cubes.
- **What the build leaves out:** only first values for several multi-value fields; weapons 1-3; no Group B arrests or Group B offenses; person offenses with no connected victim produce no row; nothing before 2017.
- **Savant's conditions for NIBRSAI reading the files:**
  - pin releases by full path, with a hold list that Savant honors (a Savant change);
  - cap NIBRSAI's own memory and threads;
  - add a schema version per release;
  - budget 10-12 GB of disk per pinned release (54 GB free on root);
  - refreshes land around the 19th-20th of each month.

## Design

1. **Canonical data layer (lossless, shared).**
   - **Entities at explicit grains:** incident, offense, victim, offender, arrestee (Group A and Group B arrests), property segment.
   - **Link tables carrying every relationship:**
     - victim → offense (all connected offenses);
     - victim → offender (all relationships);
     - offense → weapon (all weapons);
     - victim → injury (all injuries);
     - incident → property.
   - **Attributes are denormalized only where genuinely one-to-one.**
   - **Agency-month reporting status:** an explicit table (reported with crimes, reported zero, not reported), not inferred from crime rows.
   - **Population and coverage denominators:** maintained independently and matched to geography and year; overlapping jurisdictions are never summed.
   - **Storage:** canonical data as partitioned Parquet; optimized DuckDB serving artifacts built from it. Physical layout is chosen by measured workload.
   - **Years:** 2017-2026 for the first switch; 1991-2016 is required before the old paths are retired.
2. **Semantic and metrics layer (shared, versioned).** This replaces a field list of labels with full definitions:
   - entities, grains, relationships and their cardinality;
   - measures with their counting unit (distinct victims, victim-offense pairs, offenders, offenses, incidents, arrests, clearances) and permitted aggregation;
   - denominators and partition scopes;
   - unknown and missing handling;
   - coverage rules, definitions and labels.

   Principles from dbt and Cube are adopted; neither platform as a whole.
3. **Structured plan language.** The reader produces a plan that supports:
   - several measures;
   - filters, including scoped existence filters ("incidents containing a stolen firearm");
   - any number of groupings;
   - denominator partitions ("share within each month and agency");
   - period comparisons and rolling windows;
   - top-N within each period;
   - cohort and coverage options (a same-agencies cohort).

   Savant's three-grouping limit and whole-result percentages are implementation limits, not the contract.
4. **The question reader and request accounting are kept and extended, not rewritten.** They break a question into parts and require every part to be applied. Their target changes: from "which summary table serves this" to "does every part map to the semantic layer, and does coverage allow it". With an engine that can answer most combinations, this step is the main safeguard against confidently answering the wrong question.
5. **The model fills a plan only; compilation is deterministic.** Plans are validated against the semantic layer before running. Validated text-to-SQL is rejected as the public answer contract, because syntactically safe SQL can still count the wrong entity, multiply joins or use the wrong denominator.
6. **Clarify consequential ambiguity; state real limits.**
   - An ambiguity that changes the answer gets clarifying chips with the nearest semantic options.
   - Data that is missing, or a concept that is genuinely unrecorded, gets an explicit limitation, not endless confirmation.
7. **Accelerators.** Wide tables and cubes are selective and workload-driven, chosen automatically only when they cover a plan, with an exact fallback to the canonical data. Equality is proven by tests.
8. **Serving.**
   - NIBRSAI runs its own workers, never Savant's public service.
   - Each worker is capped: memory, threads, concurrency, cancellation and spill quota.
   - Releases activate atomically, with rollback.
   - Each product pins a release through a manifest that records each state's source vintage and held status, the transformation version, the schema and semantic versions, and checksums.
   - A separate analytics server, or ClickHouse, is adopted only if measured load cannot protect web latency within this server's budget.
9. **Provenance.** Every answer records:
   - the question and the resolved interpretation, including defaults;
   - the semantic and data versions;
   - the compiled query;
   - the denominator and cohort;
   - transformations and any truncation.

   Caches are keyed by those versions.
10. **Shared governance with Savant.**
    - One reproducible build of the canonical and semantic layers, jointly governed.
    - Savant's current facts become a derived serving artifact.
    - Each product owns its acceptance criteria and serving configuration.
11. **Multiple sources.** Each source gets its own subplan. Aggregates are aligned only where geography, period, units and coverage are compatible; overlapping NIBRS, Historical, Current Trends and Homicide Reports counts are never added together.

## Migration

| phase | done when |
|---|---|
| 0. Decision | The owner and Codex agree on this design and on the open decisions |
| 1. Independent correctness examples | A small hand-traced test set exists, with expected answers computed by hand from raw segments: multiple victims, multiple offenders, multiple property segments, overlapping categories, missing versus zero months, denominator scopes. Raw recounts prove transfer integrity only, not analytical correctness. |
| 2. Canonical build and semantic layer v1 (2017-2026) | Entities, links, reporting status and denominators are built and pass phase 1, plus raw recounts. The partial-year rule is resolved (Savant's refresh plan says cut to the last complete month; `etl/build.py` says "Nothing is cut"; the latest observed month is not proof of completeness). The Savant-side changes are in: a hold list, a schema version, Group B arrests. |
| 3. Plan language and compiler | Plans compile deterministically against the semantic layer. Every named test case below passes on hand-checked expectations. |
| 4. National performance and isolation | The national release is benchmarked under realistic concurrency, with and without accelerators. Web latency stays protected within the worker caps. |
| 5. Shadow comparison | Sampled or queued, so it never doubles production load. It covers every outcome category, not only declines. Results are reported separately: correct answers, necessary clarifications, unsupported questions, incorrect answers, latency. Every difference from today's answers is explained. |
| 6. Switch by semantic capability and coverage | A capability switches when its shadow results are accepted. Old paths are kept for rollback. |
| 7. Backfill 1991-2016 | Pre-2017 questions answer on the new model, with phase 1-style checks for each era |
| 8. Retire | The old NIBRS paths and the summary dependencies are retired; useful accelerators stay. Then Homicide Reports, Historical and Current Trends follow the same pattern. |

## Named test cases (hand-checked expectations)

1. **Share of murder victims by race and sex per month in Houston since 2018.**
   - Each cell's denominator is that month's total murder victims for the Houston Police Department.
   - Unknown race or sex is a visible category.
   - Numerators and denominators are shown.
   - Houston's NIBRS reporting starts mid-2018 (7 months).
   - (Savant's `pct_of_total` divides by the whole result total and would be wrong here.)
2. **Thefts from motor vehicles where a firearm was stolen, per month.** Answered as "23F offenses in incidents with a stolen-firearm property segment". The answer states that NIBRS does not tie a property segment to one offense in a multi-offense incident; no attribution is invented.
3. **Car thefts in Baltimore by month, January 2022 to June 2026.** A month range across years.
4. **The frozen release questions (H1-H3).** Unchanged, or the change is declared.
5. **Replay of the last 60 days of NIBRS questions.** Every outcome category, reported as in phase 5.

## Rules carried into the semantic layer (each with a test)

- Person crimes counted by victim, with distinct victims versus victim-offense pairs named explicitly.
- National is a sum of reported counts, never an agency; national answers say "reported NIBRS counts".
- Participation change is distinguished from crime change, with a same-agencies cohort option.
- Missing versus zero months, from the reporting-status table.
- Partial years.
- Rates use matched denominators. A demographic-filtered count over total residents is labeled as such, not called a group risk rate.
- Small cells: numerator, denominator and restrained precision are shown, and larger periods offered. No silent suppression, no shares recomputed over only the displayed cells, no sampling confidence intervals.
- The phantom-town geography guard, "US" means national, title formats, refusal wording.
- Old workarounds are not frozen as rules: the first-weapon limit and the summary-table restrictions in the prompt are retired.

## Open decisions for the owner

1. The order of the pre-2017 backfill relative to the first switch. The design requires it before retiring the old paths.
2. Whether Savant's public product moves to the national release and the canonical model.
3. How small-cell monthly shares are presented: counts beside shares, plus a larger-period suggestion.
4. Which source follows NIBRS: Homicide Reports, Historical or Current Trends.
