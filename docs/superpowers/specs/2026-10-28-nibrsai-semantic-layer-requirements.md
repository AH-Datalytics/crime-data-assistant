# What NIBRSAI needs from the shared semantic layer

For the "NIBRS model" session, which owns the shared semantic layer (`nibrs-model/semantic/`, versioned YAML). This is
NIBRSAI's side of the contract. The binding form is the TypeScript interface `lib/nibrs-plan/semantic.ts` in
crime-data-assistant (branch `nibrs-engine/phase1`), accepted by Codex with the plan language (r4, 305cb73); NIBRSAI
writes one adapter from the shared YAML to that interface, so the YAML's own shape is the owner's choice as long as
everything below is in it. Context: `2026-10-28-nibrs-plan-language.md` (the plans that consume it) and
`2026-10-28-nibrs-semantic-v1-definitions.md` (the custom definitions it must hold).

## Why each piece is needed

NIBRSAI's compiler turns a validated plan into DuckDB SQL deterministically. It must invent no semantics: every
counting rule, join and code meaning comes from the layer. The plan validator uses the same layer to refuse plans
that would count the wrong entity, multiply rows through a join, use a code outside its era, or apply a unit an
offense does not have.

## Requirements

**R1. Version.** One version string per layer release, carried into every plan, answer and cache key. A canonical
release names the semantic version it was validated with.

**R2. Entities.** For each entity (incident, offense, victim, offender, arrestee, group_b_arrest, property, and the
link entities victim_offense, victim_offender, offense_weapon, victim_injury, victim_circumstance, property_drug,
arrestee_weapon ...):
- its canonical table and identity key columns;
- the entity it belongs to one-to-one, with join keys (victim to incident);
- its date columns by time basis (incident date, arrest date, clearance date);
- its agency column (ORI) and data-year column.

**R3. Links.** For each relationship: id, from and to entities, cardinality (one or many rows of `to` per `from`),
join keys. For a pair entity (victim_offender pairs a victim with one offender), the far-end dimensions read through
the pair row (offender age, sex, race), so "relationship by offender age" never becomes a cross product.

**R4. Measures.** For each measure: id (`<unit-plural>.<name>`, e.g. `victims.murder`), counted entity, counting unit,
label, and an executable definition:
- aggregation: count of distinct entity keys, or a sum of a column over distinct rows (dollars, vehicles);
- predicate: dimension conditions on the entity, existence over a named link (whose conditions belong to the link's
  far entity), and all/any combinations;
- additivity across agencies, months and categories (a victim of two offenses makes "violent crime victims" not the
  sum of its parts);
- the time bases it supports, and the data years it is valid for;
- whether its unit is the offense's standard FBI unit (victims for crimes against persons, offenses otherwise), for
  the reader's default.

The measures defined for an offense ARE its allowed units (lesson 6): no `victims.drug_possession` means the unit is
refused, never answered as an empty table.

**R5. Dimensions.** For each dimension: id (`<entity>.<name>`), entity, column, label, original NIBRS codes with
labels (codes are kept as in the file; mappings live here), unknown codes (always visible categories), the data
years it is recorded, and per-code era validity where a code was added or retired. For numeric codes (age): the
range and the special codes (00 unknown; NN, NB, BB under one year; 99 meaning 99 or over) with their labels, which
never fall in a numeric bin.

**R6. Named, versioned definitions.** The custom categories (carjacking, flash mob, juvenile-offender incidents,
domestic violence, hate crime, firearm, commercial locations, drug categories, relationship and circumstance groups,
officers assaulted, legacy SRS rape, coverage percentage) as named measures or dimension groups with versions
(`incidents.carjacking@1`); a changed rule is a new version, never an edit. Their rules are in the v1 definitions
document.

**R7. Coverage and reporting status.** The layer names the agency-month status table (D6) and its four states with
evidence, and the coverage definition (`coverage.population_pct@1`): covered population of primary agencies with
known months over the Census population (D8).

**R8. Self-consistency.** Every predicate resolves: each existence names a link that starts at the entity the
predicate stands on, and each condition's dimension belongs to the entity it is evaluated on (`checkLayer` in
`semantic.ts`). A layer release that fails is not published.

**R9. Tests NIBRSAI will run against each layer release.** `checkLayer`; the plan-language examples
(`lib/nibrs-plan/examples.ts`, 35 plans) validate against it with no problems; and the hand-traced correctness set
(`scripts/fixtures/nibrs-correctness/`) compiles to its expected answers once the compiler exists.

## Not required from the layer

SQL, table layout for accelerators, presentation wording, clarification thresholds: NIBRSAI's own.
