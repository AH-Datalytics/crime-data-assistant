Design question (one pass): one common agency/place crosswalk for every source? Sent to the coordinator as a nibrs-model proposal with Jeff's OK.

**Yes: build one shared agency/place identity registry, with one P28 implementation in NIBRSAI.** Keep source-specific adapters that translate the selected identity into each source’s records and coverage rules.

The important adjustment to the proposal: **an ORI identifies an agency, not a place.** One flat row per ORI with one place and one county would lose distinctions you already handle correctly.

No files were edited. This assessment is based on code, fixtures, policy, and build documentation; I did not rebuild or audit the underlying databases.

**1. What should be common—and what must differ**

The shared flow should be:

`question → place/agency candidates → P28 and user choice → stable identity → source adapter → records and availability`

All tabs should agree about which Boston, Baltimore, or Washington the user means. Source membership must not silently change that choice: if the selected place is absent from RTCI, return that availability result rather than substitute another place.

The adapters still have necessary work:

| Source | What remains source-specific |
|---|---|
| Historical | Selecting a county agency versus all reporting agencies within a county; applicable historical identities and years. |
| SHR | Its source identifiers, predecessor/successor ranges, and reporting availability. |
| RTCI | Sample membership, available months, and the source’s aggregation/comparison rules. |
| NIBRS | Applicable agency-year records, reporting status, and treatment of coverage relationships. |

These are existing distinctions, not speculative requirements. [historical-county-identity.ts](C:/Users/jeffm/cda-compiler/lib/historical-county-identity.ts) explicitly separates county-agency and countywide predicates and preserves multiple agencies. [shr-place-resolver.ts](C:/Users/jeffm/cda-compiler/lib/shr-place-resolver.ts) resolves source identities and succession ranges. [current-agency-availability.ts](C:/Users/jeffm/cda-compiler/lib/current-agency-availability.ts) checks actual monthly rows.

**P28 should operate on the shared candidate catalog before availability filtering.** Its population floor resolves place ambiguity; it does not authorize choosing between two different police agencies simply because one has a larger population.

There is already policy drift: [geo-place-resolver.ts](C:/Users/jeffm/cda-compiler/lib/geo-place-resolver.ts:353) uses a secondary-city population ratio of 25%, while [P28](C:/Users/jeffm/cda-compiler/docs/policy/nibrsai-answer-policy.csv:29) specifies the 100,000 threshold. A shared catalog alone will not remove that difference; the decision logic must also become common.

**2. What the registry must contain**

Use a small set of related tables, delivered as one artifact:

| Component | Required content |
|---|---|
| Places | Stable internal identity; geographic kind; state; Census geographic code and vintage; official Census name; display name and aliases. Include states and county equivalents, not just cities. |
| Agencies | Agency identity; ORI9 where known; official name; agency kind; dated names and classifications. |
| Source identifiers | Source, source identifier—including ORI7—mapped to agency identity, with effective years and evidence. |
| Agency–place relationships | Which place an agency serves, relationship type, applicable dates, and evidence. Allow multiple places/counties. |
| Population observations | Entity, year, value, population definition, source and vintage. |
| Relationships and aliases | Covered-by, succession/consolidation, source spellings, and reviewed aliases, with effective dates and provenance. |

Several details are essential:

- **Do not manufacture ORI9 by padding ORI7, or assume truncation is always an authoritative join.** Your [crosswalk builder](C:/Users/jeffm/cda-compiler/scripts/build-agency-county-crosswalk.py:2) explicitly warns about non-obvious mappings, including Indianapolis. Preserve source codes and verify the mapping.
- **Separate place population from agency population.** They may describe different areas. Store both rather than placing them in one interchangeable column. For P28, use a documented reference year/vintage consistently across tabs; its county-agency threshold must remain as decided. Missing population is unknown, not zero. Crime-rate denominators remain source/year-specific.
- **Allow multiple county links.** The canonical [BH layout](C:/Users/jeffm/nibrs-model/src/nibrs_model/layouts.py:40) contains five county slots and five FIPS-county slots. A single `county_fips` cannot represent everything.
- **Covered-by is a dated relationship, not an identity merge.** Knowing that agency B covers A does not establish that B’s entire count represents A.
- **Consolidation is not a spelling alias.** Preserve predecessor/successor identities, dates, and jurisdiction differences. [agency-consolidations.ts](C:/Users/jeffm/cda-compiler/lib/agency-consolidations.ts) already documents source-specific ORIs and a Louisville transition-year problem.
- **Mailing cities must remain address attributes.** They should not automatically become jurisdiction aliases: making “Tucson” an unrestricted alias for Oro Valley would create a new error.

For Census names, two separate inputs are needed:

1. Evidence linking the agency to the correct Census geography.
2. The authoritative name for that geography and vintage.

The BJS **LEAIC 2012** dataset includes ORI and FIPS state, county, and place identifiers, making it a useful starting linkage source. Its age means it cannot establish every modern or historical relationship without supplements. [BJS dataset description](https://catalog.data.gov/dataset/law-enforcement-agency-identifiers-crosswalk-united-states-2012)

Census Gazetteer files provide geographic codes and names, but **do not include population**, and Census explicitly warns that codes/names are not necessarily one-to-one across vintages. Use separately identified Census population data where place population is required. [Census Gazetteer documentation](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html)

Return A names and Historical names remain useful source labels and alias evidence. Stripping department words from them does not make them Census names. For an unresolved agency–place link, retain an explicit unknown rather than asserting a guessed Census identity.

**3. Ownership, versioning, and checks**

**Build and own the factual registry in `nibrs-model`; own P28 and interaction behavior in NIBRSAI.**

Publish it as a separately versioned reference artifact alongside canonical releases. That allows a corrected place name without rebuilding incident data. Preserve the raw FBI fields unchanged.

This fits the existing shared-build/product-serving arrangement in [nibrs-model README](C:/Users/jeffm/nibrs-model/README.md). The current [design](C:/Users/jeffm/nibrs-model/docs/DESIGN.md) reserves FBI master files as the source of NIBRS rows; external geographic enrichment should therefore be explicitly identified as reference data.

The registry must cover the **union of source identities**, including Historical/SHR agencies absent from the current NIBRS build. Building solely from test5 would make it unsuitable as the universal catalog.

Each release should record:

- Schema version, registry release ID, build commit, input versions/hashes, output hash.
- Supported years and source coverage.
- Unresolved/conflicting mappings and reviewed overrides.
- Changes from the previous release affecting identity, population, or P28 candidates.

NIBRSAI should pin that release and record it with evaluation results.

Essential checks are bounded: identifier joins and collisions; valid geographic references; conflicting effective periods; preservation of multiple county/agency relationships; and regressions for the known naming, consolidation, and P28 cases. Missing mappings can be published explicitly; a mapping asserted as verified must pass its checks.

The canonical [agency-history builder](C:/Users/jeffm/nibrs-model/src/nibrs_model/build.py:596) currently exports only a subset of annual attributes. The crosswalk build will need the richer agency-year/link data for counties and covered-by relationships.

**4. Risk of not doing it, and the minimum first release**

The main risk is **plausible answers for different jurisdictions across tabs**, not cosmetic inconsistency. Other risks include truncated historical series after renames, wrong population denominators, hidden county-agency ambiguity, and repeatedly repairing the same alias in several paths.

The minimum useful release is:

- A shared place/agency catalog seeded from existing source inventories.
- Explicit source-ID mappings, preserving existing verified county and succession work.
- Census-backed place names where links are established, with unresolved links marked.
- Population observations sufficient for P28, with year and definition.
- Dated relationships needed by supported queries.
- A manifest, focused validation, and an exceptions list.

**Do not impose the shadow’s 10,000 population cutoff on the permanent registry.** P28’s threshold controls clarification, not whether a small place exists.

Migrate adapters incrementally. A full historical boundary reconstruction and every possible legacy alias can wait; unsupported periods must remain explicit rather than silently inheriting current geography.

**5. Can reader work keep the stand-in index?**

**Yes—for the current bounded shadow-reader evaluation. The crosswalk is not a prerequisite for continuing it.** Targeted, evidence-backed naming corrections are reasonable within the existing correction allowance.

However, they establish only that the evaluated cases work. They do not establish complete P28 behavior or general geographic correctness.

The files show why that distinction matters:

- [build-nibrs-shadow-agencies.py](C:/Users/jeffm/cda-compiler/scripts/build-nibrs-shadow-agencies.py) uses latest attributes, a 10,000 floor, a seven-character Return A lookup, and restrictive county-name selection.
- [places.ts](C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/places.ts) reduces candidates to the most populous of each kind in each state. That is not proof that the discarded agencies are the same identity.
- The checked-in [fixture](C:/Users/jeffm/cda-compiler/scripts/fixtures/nibrs-shadow/agencies.json) already has Boston and Oro Valley, but still lists Nashville and Las Vegas under department names, despite the builder describing stripped place names. The checked-in artifact therefore cannot be assumed to reflect the builder’s intended output.

For evaluated questions, verify the intended ORI **and the competing candidates needed by P28**, not just the displayed name. Record remaining fixture failures as evaluation results. If fixes expand into general identity reconstruction, stop expanding this workaround and move that work into the registry.

**Necessity check:** Accept the shared-registry design with separate place and agency identities, source adapters, and one P28 implementation. Continue reader evaluation now; correct only identity/candidate errors necessary to interpret its results, because otherwise apparent reader passes or failures are misleading. Defer the universal crosswalk build, all-tab migration, and exhaustive historical enrichment from this reader round.

Codex review: Not needed for another review of this recommendation; implementation and release remain future work.
