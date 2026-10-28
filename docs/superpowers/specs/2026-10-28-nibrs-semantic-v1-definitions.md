# NIBRS semantic layer v1: custom definitions and definition lessons (r3)

Scope addition to `2026-10-27-nibrs-engine-restructure.md` and `2026-10-28-nibrs-plan-language.md` (r4, accepted).

**Owner, 2026-10-28 (relayed by the NIBRSAI session):** "inventory our custom definitions, add them to the semantic
layer v1 scope, and shadow-test them against the current tables"; and "send ... the definition lessons to the
engine session, each with a test and Codex review."

**r2 → r3 (Codex ACCEPT WITH CHANGES, 6 changes):** versioned and qualified measure ids bind in request accounting;
a composite's share needs the same composite as denominator (S12); numeric conditions checked for operand count,
finiteness, order and range; Group A arrests keep today's arrest-offense weapon as its own dimension beside armed-with;
carjacking clearance at incident grain; hate crime qualified by known bias codes, blank never qualifies. Code and
tests: `lib/nibrs-plan/{validate,semantic}.ts`, `scripts/test-nibrs-plan-language.ts`.

**r1 → r2 (Codex REVISE, 7 changes):** the property-value rule restated at its real grain (row values zeroed, counts
kept) as a declared difference; every definition mapped to measure ids with one entity and one unit, with two narrow
interface extensions (composite measures, numeric conditions); robbery weapons and arrestee weapons separated; the
inventory completed (multiple-victim incidents, all homicide types, the NIBRS taxonomy, clearance, age buckets, weapon
categories) and every current table mapped; legacy rape bounded by the FBI's 2023 change; the coverage formula made
exact and its causes marked as hypotheses; explicit expected outcomes for every changed semantic.

Inventory sources: `lib/nibrs-claude.ts`, `lib/guardrails.ts`, `lib/tab-suggest.ts`, `lib/nibrs-codes.ts`,
`lib/nibrs-question-types.ts`, `lib/nibrs-question-compiler.ts`, `lib/query-contract.ts`,
`lib/nibrs-request-accounting.ts`, `lib/nibrs-incident-offense-scopes.json`, `scripts/nibrs-auto-update.py`,
`scripts/build_*.py`, and the 37 `summary_*` tables in the live nibrs.db (listed 2026-10-28). Line numbers are at
branch `nibrs-engine/phase1`.

**Tables with no builder in this repository** (filters known only from the prompt; recovering their builders from
the server is a precondition of their shadow comparison, not of this scope): summary_domestic_violence,
summary_dv_arrests, summary_hate_crime, summary_hate_crime_location, summary_offense_weapon, summary_offense_location,
summary_victim_circumstance, summary_victim_relationship, summary_offender_demographics, summary_carjacking_clearance,
summary_clearance_city_annual, summary_drug_arrests, summary_property_offense (its value clean-up is in
`build_property_summary.py`), summary_victim_weapon_circumstance(_demo). **There is no `summary_flash_mob_monthly`:**
flash mob is a prompt-only definition, answered only by model SQL, which no longer runs.

## 1. Inventory

| # | Category | Current rule | Grain today | Lives in | Consumers |
|---|---|---|---|---|---|
| C1 | Carjacking | an incident with a 120 offense and a property segment loss 7, description 03/05/24/28/37 (any offense's property) | monthly: distinct incident (`COUNT(DISTINCT ori\|\|incident_num)`, column named offense_count). Demographics: every individual victim, every offender, every arrestee in the incident. Victim and offender weapon = `MIN(type_weapon_1)` over the incident's 120 offenses; **arrestee weapon = `arrestee_weapon_1`** (`nibrs-auto-update.py:988`) | `nibrs-auto-update.py:895-1000, 1218-1228`; `build_carjacking_demographics.py:54-66`; `nibrs-claude.ts:849-920, 1119, 1231, 1269, 1340-1351`; `city-ranking.ts:669-671, 709`; `city-ranking-builder.ts:333-345`; `nibrs-question-compiler.ts:243, 285-286`; `nibrs-request-accounting.ts:151` | summary_carjacking_monthly, summary_carjacking_{victim,offender,arrestee}_demographics, summary_carjacking_clearance; question compiler tables carjacking_monthly and carjacking_victims; city ranking; the frozen H1-H3 |
| C2 | Flash mob shoplifting | 23C at location 05/07/08/09/12/17/21/23/24/41/56 with 6 or more offender segments in the incident | distinct incident by year | `nibrs-claude.ts:1522-1536` | model SQL only |
| C3 | Theft from vehicle | the wording "car break-in", "vehicle burglary" maps to 23F alone (never 220 or 23G) | offense | `query-contract.ts:152-153`; `nibrs-request-accounting.ts:148`; `nibrs-question-types.ts:26`; `nibrs-claude.ts:364-370, 1118`; `guardrails.ts:2099-2116`; `tab-suggest.ts:242-243` | reader; summary_city_monthly |
| C4 | Motor-vehicle property value | property description 03/05/24/28/37 when value words appear; dollars. `build_property_summary.py:30-43` sets `total_value = 0` on each **summary_property_offense row** (ori, year, state, offense code, loss type, description) whose average value is $1M or more, keeping its `record_count` | summary row | `nibrs-request-accounting.ts:149`; `nibrs-question-compiler.ts:243, 856` | summary_property_offense, summary_property_value_state |
| C5 | Violent / property crime | UCR-aligned (default): violent 09A, 11A-C, 120, 13A; property 200, 220, 23A-H, 240. NIBRS taxonomy (on request): against persons 09A, 09B, 09C, 11A-D, 13A-C, 100, 36A, 36B, 64A, 64B; against property 120, 200, 210, 220, 23A-H, 240, 250, 26A-G, 270, 280, 290, 510 | mixed: victims for person codes, offenses for 120 and property codes | `nibrs-codes.ts:83-101`; `nibrs-question-types.ts:24-29`; `query-contract.ts:162-163`; `nibrs-incident-offense-scopes.json`; `nibrs-claude.ts:1103-1114` | reader, compiler (`:739, 755`), juvenile scopes |
| C6 | Offense rollups | murder/homicide 09A; "all homicide types" 09A+09B+09C (only when asked, `nibrs-claude.ts:1082`); rape 11A-C; sex offense 11A-D, 36A/B; assault (unqualified) 13A-C; theft 23A-H; drug possession 35A; DUI 90D | per component | `nibrs-question-types.ts:24-29`; `nibrs-claude.ts:1078-1098` | reader, compiler |
| C7 | Juvenile-offender incidents | an incident with any offender of two-digit age 1-17; every offense code plus the scopes in `nibrs-incident-offense-scopes.json` | distinct incident per year, month, ORI, scope; month 0 when the date is missing | `nibrs-auto-update.py:1362-1447`; `build-juvenile-offender-incident-summary.py:95-120` | summary_juvenile_offender_incidents; `nibrs-deterministic-queries.ts:75-140` |
| C8 | Domestic violence | relationship-based: intimate partner SE, CS, BG, XS, XR, HR; family CH, PA, SB, OF, SC, SP, GP, GC, IL, CF, BE. Second definition: circumstance 06 (09A/13A) | victim-offense rows; distinct incidents or victims | `nibrs-claude.ts:660-661, 1165-1173`; `guardrails.ts:157-202, 1808-1817`; `nibrs-request-accounting.ts:84-85, 152`; `source-capabilities.ts:386-388` | summary_domestic_violence, summary_dv_trends (`nibrs-auto-update.py:1706`), summary_dv_arrests (arrestees of DV incidents) |
| C9 | Hate crime | offense bias_motivation not 88 or 99 (location table also excludes blank) | offense; one bias column | `nibrs-claude.ts:506-520, 675-687, 1124-1128`; `nibrs-request-accounting.ts:87-93` | summary_hate_crime, summary_hate_crime_location |
| C10 | Weapon categories | `weapon_category_expr` (`nibrs-auto-update.py:212`): Firearm = 11-15 and A variants; Knife = 20; Blunt Object = 30; Unknown = 90, 95, 99, blank; Other = the rest. Firearm victim counts use the first weapon only, with a note; "gun arrests" = the arrest offense's first weapon (Group A) or arrestee_weapon_1 (Group B). `build_carjacking_demographics.py:19-24` differs (D1); `build_homicide_demographics.py` has its own buckets | per table | `nibrs-auto-update.py:166, 212`; `nibrs-question-compiler.ts:224-235`; `guardrails.ts:290-320`; `nibrs-claude.ts:1100-1101, 1194` | summary_victim_demographics, summary_arrestee_demographics, summary_victim_weapon (all three slots), carjacking and homicide demographics |
| C11 | Shootings | not defined: redirected to Homicide Reports; aggravated assault with a firearm offered | none | `guardrails.ts:2910-2925`; `nibrs-request-accounting.ts:42-43, 197`; `source-capabilities.ts:195, 379` | refusal paths |
| C12 | Commercial locations | 02, 03, 05, 07, 08, 09, 12, 14, 17, 19, 21, 23, 24, 40, 41, 47, 55, each named in the answer | offense | `nibrs-codes.ts:155-162`; `nibrs-question-compiler.ts:266, 667-670` | summary_offense_location |
| C13 | Drug categories | first character of suspected_drug_type; fentanyl refused | distinct incident per category, all three slots | `nibrs-claude.ts:376-423`; `nibrs-request-accounting.ts:51, 77-82` | summary_drug_monthly, summary_drug_arrests |
| C14 | Relationship groups | intimate partner, family as C8; known = AQ, FR, NE, OK; stranger = ST | victim | `nibrs-claude.ts:665-669`; `nibrs-request-accounting.ts:117` | summary_victim_relationship |
| C15 | Circumstance groups | gang = 04/05; justifiable homicide by police = 09C + 21, by a private citizen = 09C + 20 | victim | `nibrs-claude.ts:1181-1213` | summary_victim_circumstance |
| C16 | Officers assaulted or killed | victim type L, connected offense 1 or 2 in 09A, 13A, 13B | victim | `nibrs-claude.ts:1175-1179` | model SQL only |
| C17 | Age groups | `age_group_expr` (`nibrs-auto-update.py:224`): Unknown = blank, NULL or 00; Under 18; 18-24; 25-34; 35-44; 45-54; 55-64; 65+. NN, NB, BB cast to 0 and fall in Under 18 | per table | `nibrs-auto-update.py:224` | every demographic summary |
| C18 | Stolen firearms | property loss 7, description 13 | property / incident | `nibrs-claude.ts:1230` | model SQL only |
| C19 | Multiple-victim incidents | incidents bucketed by the number of individual victims connected (slots 1-3) to each offense code | state, year, code, victims-in-incident | `nibrs-auto-update.py:1312-1360`; `nibrs-claude.ts:273-277` | summary_victims_per_incident |
| C20 | Cleared | an offense is cleared if its incident has an arrestee or `cleared_exceptionally != 'N'` | offense (cleared_count) | `nibrs-auto-update.py:1051-1105` | summary_city_monthly, summary_state_monthly cleared_count; clearance tables |

**First-value limits in today's tables** (each is a declared difference in the shadow comparison): connected offense 1
only (victim monthly and demographic tables); `type_weapon_1` only (victim and carjacking weapon categories, and the
arrest offense's weapon for Group A arrestees); `arrestee_weapon_1`; one bias motivation; the victim's first three
connected offenses and relationships (nibrs.db's import).

**Disagreements between places that define the same thing:**

| # | Disagreement | Evidence |
|---|---|---|
| D1 | Carjacking weapon buckets: the auto-update builder counts the A variants as firearms and maps 90 to Unknown; `build_carjacking_demographics.py:19-24` counts 11-15 only and maps 90 to Other | both builders |
| D2 | `guardrails.ts:1731` calls carjacking a person crime counted from victim tables; every other path counts it by incident | message text |
| D3 | Flash mob: "at most 1 business victim" in the text is not in the SQL; the list includes 56 (tribal lands, `nibrs-claude.ts:1221`) and leaves out 55 (shopping mall); it differs from C12 | `nibrs-claude.ts:1522-1536` |
| D4 | Two domestic-violence definitions (relationship vs circumstance 06). The relationship lists leave out SS (stepsibling; 65 Houston victims in 2024), FP and FC (foster parent and child) and CO | prompt lists; Houston 2024 relationship counts |
| D5 | Drug crimes: "35A" at `nibrs-claude.ts:57`, "35A and 35B" at `:1115`; the reader maps "drugs" to 35A | prompt text |
| D6 | "Fatal shootings" maps to 09A with no firearm condition (`query-contract.ts:127`); other paths redirect shootings | contract table |
| D7 | Robbery in DEMO_CODES (`nibrs-question-compiler.ts:237`) for summary_victim_demographics, which has no 120: robbery victim demographics come back empty | builder vs compiler |
| D8 | NN, NB, BB (under one year) cast to 0: "Under 18" is right, a numeric age is not | `nibrs-auto-update.py:224` |

## 2. Semantic-layer v1 definitions

Every definition is one or more measures or dimensions in the accepted interface (`lib/nibrs-plan/semantic.ts`):
**one measure, one entity, one unit, one aggregation.** Versions are part of the id (`@1`); a changed rule is a new
version, never an edit; plans and answers name the version.

Two narrow extensions to the interface, made with this revision and tested in `scripts/test-nibrs-plan-language.ts`
(`checkLayer`):
- **composite measures:** aggregation `{ kind: "composite", components: [...] }` with unit `fbi_standard` (added to
  the plan's counting units). Each component keeps its own unit; the composite is their labelled sum, not additive
  across categories; a share over it needs the same composite as denominator (S12); components cannot be composites;
- **numeric conditions:** predicate `{ kind: "numeric", dimension, op: ">=" | "<=" | "between", values }` on a
  numerically decoded or derived dimension of the predicate's entity.

### Measures

| Measure id | Entity, unit | Definition | Today's equivalent |
|---|---|---|---|
| `incidents.carjacking@1` | incident, incident | incidents with a 120 offense AND, **in the same incident**, a property segment loss 7 with description 03, 05, 24, 28 or 37. Property is linked to the incident: the definition does not say the robbery took the vehicle | summary_carjacking_monthly |
| `victims.carjacking@1` | victim, victim | victims (any type I) **connected to the 120 offense** of a carjacking incident | summary_carjacking_victim_demographics counts every individual victim in the incident |
| `offenders.carjacking@1` | offender, offender | offender segments with information (not 00) of carjacking incidents | summary_carjacking_offender_demographics (counts all offender rows, 00 included) |
| `arrestees.carjacking@1` | arrestee, arrestee | Group A arrestees of carjacking incidents | summary_carjacking_arrestee_demographics |
| `incidents.flash_mob_shoplifting@1` | incident, incident | incidents with a 23C offense whose location is in the v1 retail list (today's, including 56), and `incident.offender_segment_count >= 6` (numeric condition on a derived incident dimension). No business-victim condition (today's SQL) | prompt SQL |
| `offenses.theft_from_motor_vehicle@1` | offense, offense | 23F | summary_city_monthly 23F |
| `victims.theft_from_motor_vehicle@1`, `victims.theft@1` | victim, victim | victims connected to 23F, or to any of 23A-H, by victim type (lesson 6) | none |
| `property.value@1`, `property.segments@1`, `property.vehicles@1` | property; dollars, property segment, vehicles | the sum of `value`, the count of segments, the sum of stolen or recovered vehicle quantities, with loss type and description as dimensions; motor-vehicle property = description in 03, 05, 24, 28, 37 | summary_property_offense, summary_property_value_state (declared difference: below) |
| `violent_crime.ucr@1` | incident, fbi_standard | composite of `victims.murder@1`, `victims.rape@1`, `offenses.robbery@1`, `victims.aggravated_assault@1` | today's violent series (CTE/UNION of victim and offense tables) |
| `property_crime.ucr@1` | offense, offense | 200, 220, 23A-H, 240 offenses (one unit: no composite needed) | summary_city_monthly |
| `violent_crime.nibrs_persons@1` | victim, victim | victims of 09A, 09B, 09C, 11A-D, 13A-C, 100, 36A, 36B, 64A, 64B (distinct victims: a victim of two of them counts once) | prompt taxonomy |
| `property_crime.nibrs_property@1` | offense, offense | 120, 200, 210, 220, 23A-H, 240, 250, 26A-G, 270, 280, 290, 510 | prompt taxonomy |
| `victims.murder@1` | victim, victim | victims connected to 09A | summary_victim_*_monthly 09A |
| `victims.homicide_all@1` | victim, victim | victims connected to 09A, 09B or 09C (only when asked for "all homicide types") | prompt rule |
| `victims.rape@1` | victim, victim | distinct victims connected to 11A, 11B or 11C | summary_victim_*_monthly 11A-C (sums slot-1 codes) |
| `victims.rape_legacy_srs@1` | victim, victim | female victims connected to 11A, **data years 1991-2022 only**; unavailable (with the reason) from 2023 (lesson 7) | Historical tab (SRS) only |
| `victims.sex_offense@1`, `victims.assault@1`, `victims.aggravated_assault@1` | victim, victim | 11A-D, 36A, 36B; 13A-C; 13A | summary_victim_*_monthly |
| `offenses.robbery@1`, `offenses.theft@1`, `offenses.drug_possession@1` | offense, offense | 120; 23A-H; 35A | summary_city_monthly |
| `group_b_arrests.dui@1` | group_b_arrest, group_b_arrest | Group B arrests for 90D | summary_arrestee_demographics (90D) |
| `incidents.juvenile_offender@1` | incident, incident | incidents with an offender segment of decoded age 1-17 | summary_juvenile_offender_incidents |
| `victims.domestic_violence@1` | victim, victim | victims with any relationship (all ten, through victim_offender) in today's intimate-partner or family list | summary_domestic_violence (relationship split) |
| `incidents.domestic_violence@1` | incident, incident | incidents with such a victim | summary_dv_trends |
| `arrestees.domestic_violence@1` | arrestee, arrestee | Group A arrestees of incidents with such a victim | summary_dv_arrests (builder to be recovered) |
| `offenses.hate_crime@1` | offense, offense | offenses with **any** bias motivation that is a known substantive bias code (the FBI bias list, by era); 88 (none), 99 (unknown), blank and NULL never qualify | summary_hate_crime (first bias only) |
| `victims.leoka@1` | victim, victim | victims of type L connected to 09A, 13A or 13B in any slot | prompt rule (slots 1-2) |
| `offenses.cleared@1` | offense, offense | offenses whose incident has an arrestee or an exceptional clearance (today's rule, kept) | cleared_count |
| `incidents.carjacking_cleared@1` | incident, incident | carjacking incidents with an arrestee or an exceptional clearance: one per incident however many offenses it holds | summary_carjacking_clearance (builder to be recovered) |
| `incidents.victim_count_bucket@1` | incident, incident | incidents by the number of individual victims connected to an offense code (derived numeric incident-offense dimension `offense.individual_victims`) | summary_victims_per_incident |

### Dimensions and named groups

| Id | Entity | Definition |
|---|---|---|
| `offense_weapon.weapon` with groups `weapon.category@1` | offense_weapon | every weapon of an offense (up to three); category: Firearm = 11, 11A, 12, 12A, 13, 13A, 14, 14A, 15, 15A; Knife = 20; Blunt Object = 30; Unknown = 90, 95, 99, blank; Other = the rest (today's `weapon_category_expr`; D1 resolved to it) |
| `arrestee_weapon.weapon` with the same groups | arrestee_weapon | "armed with": every weapon of an arrestee (up to two), Group A and Group B: **a different concept from an offense's weapon**, never substituted for it |
| `arrestee.arrest_offense_weapon` with the same groups | offense_weapon of the arrestee's arrest offense | today's Group A concept (`nibrs-auto-update.py:822, 849-868`): the weapons of the offense the arrestee was arrested for, in that incident (all three, where today uses `MIN(type_weapon_1)`). For Group B arrests (no offense) it does not exist, and today's Group B weapon is armed-with |
| `location.commercial@1` | offense | C12's list, named in every answer |
| `drug.category@1` | property_drug | the first character of the suspected drug type, all three slots |
| `relationship.group@1` | victim_offender | intimate partner, family (C8 lists), known (AQ, FR, NE, OK), stranger (ST) |
| `circumstance.group@1` | victim_circumstance | gang 04/05; justifiable by police 21, by a private citizen 20 (with 09C) |
| `bias.motivation` | offense_bias | every bias motivation of an offense |
| `age.group@1` | decoded age | Unknown (00, blank; and NN, NB, BB for offenders and arrestees); Under 18 (1-17, and NN, NB, BB for victims); 18-24; 25-34; 35-44; 45-54; 55-64; 65+ (99 = 99 or over); special codes never fall in a numeric bin |
| `incident.offender_segment_count` | incident | derived: offender segments in the incident (flash mob) |

### Carjacking weapons, unit by unit

A weapon grouping is reached from the counted unit, and a share's denominator is the same unit (S12):
- carjacking incidents by robbery weapon: incident → 120 offense → offense_weapon, `multiValue: each_value`,
  shares over distinct incidents;
- carjacking victims by robbery weapon: victim → its connected 120 offense → offense_weapon, shares over distinct
  victims;
- carjacking offenders by robbery weapon: offender → incident → 120 offense → offense_weapon (an incident attribute),
  shares over distinct offenders;
- carjacking arrestees **armed with**: arrestee → arrestee_weapon (both slots), shares over distinct arrestees. This
  is today's arrestee concept (`arrestee_weapon_1`), kept separate from the robbery weapon.

Shootings (C11) stay undefined: NIBRS has no shooting code. D6 is fixed in the reader, not here.

### Declared difference: property value outliers (C4)

Today zeroes `total_value` on a summary row (ori, year, state, offense code, loss type, description) whose average
value is $1M or more, and keeps its count. That rule depends on the row's aggregate, so it cannot be a property of a
segment. v1 does not reproduce it: `property.value@1` sums every segment's value, and the answer shows the dollars.
Every shadow difference on value is then the zeroed rows, listed by key; counts (`property.segments@1`) must be equal.
Whether to exclude outlier segments (a per-segment rule, `@2`) is an owner decision (section 5). Test: an agency-year
with one row whose average is over $1M and one under: counts equal, dollars differ by exactly the zeroed row's total.

## 3. Definition lessons

### Lesson 6. Allowed counting units per offense

**Corrected premise.** NIBRS records victims for crimes against property: a 23F or 240 offense has victim segments,
individuals and businesses (correctness cases M5, M7). The FBI counts property crimes by offense, not by victim.
Today's victim summary tables are built only from crimes against persons, so a "theft victims" request finds no rows
there.

**Rule.** The measures defined for an offense are its allowed units (the plan language needs no new rule: S2 refuses a
measure id the layer does not define). Each measure records whether its unit is the offense's standard unit:
- crimes against persons: victims (standard), offenses, incidents, offenders, arrests;
- crimes against property: offenses (standard), incidents, victims recorded on the offense (labelled "victims
  recorded for <offense>", by victim type), property segments, dollars, vehicles, offenders, arrests;
- crimes against society: offenses (standard), incidents, arrests. Victim type S (society) is not a person count:
  there is no `victims.drug_possession`.

The reader answers in the standard unit with the unit named, or asks with chips when two allowed units give
different answers. An empty cell is never shown as zero: it is REPORTED_ZERO (0, evidenced), UNKNOWN or
UNKNOWN_UNEVIDENCED_ZERO, as the accepted D6 handling says.

**Tests (expected outcomes):**

| Question | Expected |
|---|---|
| "theft victims in Memphis in 2024" | a plan on `victims.theft@1` (victims recorded for theft, by victim type), or clarify "victims or offenses"; never an empty table |
| "carjacking victims in Memphis in 2025" | `victims.carjacking@1`: victims connected to the robbery in carjacking incidents |
| "drug possession victims in Houston" | limitation, unsupported unit (no victims measure for a crime against society), offering offenses |
| synthetic agency with a REPORTED_ZERO month, asked for theft victims | that month 0 (REPORTED_ZERO); an UNKNOWN month null; a month with crime rows but no theft victims UNKNOWN_UNEVIDENCED_ZERO |

### Lesson 7. The 2013 and 2023 rape definitions

**What changed, and where.**
- **2013 (SRS):** the Summary Reporting System replaced legacy rape (forcible carnal knowledge of a female) with the
  revised definition (any sex, any penetration). NIBRS already captured those offenses; its reporting requirement did
  not change, only some wording. The FBI published both SRS definitions for years afterward, so an SRS figure's
  definition comes from its series metadata, not from the year alone.
- **2023 (NIBRS):** the FBI's 2023 NIBRS specification broadened 11A and stopped separate collection of 11B (sodomy)
  and 11C (sexual assault with an object); agencies move to it over the following years.

**Evidence** (`scripts/fixtures/nibrs-semantic-evidence/`, from nibrs.db summary tables): 11A's male share is flat
across 2013 (902 of 28,894 in 2008, 997 of 30,463 in 2013, 1,446 of 46,258 in 2018) and rises after 2023 (2,474 of
78,650 in 2023, 4,841 of 58,565 in 2026), while 11B and 11C fall (11B victims 18,888 in 2024, 13,545 in 2025, 7,058 in
2026 to date). Male victims are moving from 11B into 11A.

**Rule.**
- `victims.rape@1` (11A + 11B + 11C, distinct victims) is valid in every year: the 2023 fold moves victims between
  its components, not out of it. A NIBRS trend across 2013 or 2023 uses it throughout, labelled "rape (NIBRS 11A,
  11B, 11C)", with no further note.
- `victims.rape_legacy_srs@1` (female 11A victims) reconstructs legacy SRS rape only for data years 1991-2022. From
  2023 it is unavailable, with the reason, because a broadened 11A no longer isolates the legacy offense. It is used
  only when a question asks for the legacy definition or sets NIBRS beside a legacy SRS figure.
- Where NIBRS and SRS are compared (multi-source plans), each SRS figure carries the definition its series metadata
  states (the Historical tab's correction table), not one inferred from the year.

**Tests (expected outcomes), on synthetic records across the boundaries:**

| Record | `victims.rape@1` | `victims.rape_legacy_srs@1` |
|---|---|---|
| 2012, female victim of 11A | 1 | 1 |
| 2012, male victim of 11B | 1 | 0 |
| 2014, female victim connected to 11A and 11C | 1 (distinct victim) | 1 |
| 2014, male victim of 11A | 1 | 0 |
| 2024, male victim of 11A (post-fold reporting) | 1 | unavailable for 2024 |
| 2024, female victim of 11A | 1 | unavailable for 2024 |

The male-share series is evidence for the premise, not a test.

### Lesson 8. Coverage percentage

**Measured, 2026-10-28,** for 10 states in 2024: NIBRSAI's `nibrs_state_coverage` against FBI CDE
(`/nibrs/state/{ST}/homicide-offenses`, fields "Percent of Population Coverage" and `participated_population`).
Files: `scripts/fixtures/nibrs-coverage-shadow/` (the comparison, our 2024 rows, the 10 CDE responses as fetched).
CDE's monthly percentages equal its participating population over its population denominator, within rounding.

| State | CDE, Dec | CDE, mean of months | NIBRSAI | Our denominator vs CDE's | Our numerator / CDE's denominator |
|---|---|---|---|---|---|
| PA | 51.67 | 50.19 | 46.47 | +7.9% | 50.12 |
| NY | 80.39 | 78.73 | 64.85 | +9.9% | 71.26 |
| FL | 69.56 | 70.46 | 53.17 | +0.6% | 53.50 |
| NJ | 75.96 | 73.06 | 71.75 | +0.6% | 72.21 |
| CA | 76.93 | 75.18 | 75.53 | +0.4% | 75.81 |
| OH | 93.97 | 94.28 | 89.92 | +0.2% | 90.15 |
| IL | 94.56 | 94.35 | 91.40 | -1.6% | 89.92 |
| GA | 92.04 | 92.71 | 89.60 | +1.6% | 91.02 |
| TX | 99.43 | 99.34 | 99.03 | -2.6% | 96.42 |
| MD | 99.55 | 99.60 | 98.48 | +1.0% | 99.47 |

**What is proven:** the two formulas differ in both parts. Ours divides by the sum of agency populations
(`build-nibrs-state-coverage.py:54-74`) and counts an agency's population only if it reported 6 or more months; CDE
divides by a state population and counts each month's participating population.
**Hypotheses, pending agency-level reconciliation:** that overlapping jurisdictions explain our denominator excess (PA
+7.9%, NY +9.9%), and that agencies joining during the year explain FL's numerator gap (12.5M against CDE's 16.3M in
December).

**Definition (v1), `coverage.population_pct@1`.** For a geography G and a month m:
- numerator(m) = the sum of `population` over agencies in G with `population_counted` (primary agencies, D8) whose
  status for m is REPORTED_CRIMES, REPORTED_CRIMES_COMPLETE or REPORTED_ZERO (an agency that submitted for m, partial
  submissions included); NOT_REPORTED and UNKNOWN months contribute nothing;
- denominator(m) = the Census population of G for m's year (`geo_population`);
- coverage(m) = numerator(m) / denominator(m), each month evaluated on its own;
- for a period: the mean of its monthly values, each month using its own year's populations (so a period across
  years needs no special rule);
- label: "share of residents covered by agencies reporting NIBRS data".

UNKNOWN months make coverage a lower bound until the BH evidence is decoded. The answer adds nothing about it: the
UNKNOWN statuses are server-side evidence, and the table shows only the coverage numbers (the result-column rule).

**Shadow test.** For the 10 states, and every state once the canonical build exists: v1 against CDE by month; every
gap over 1 point is reconciled agency by agency (an agency counted by one side and not the other, or a different
population), and the two hypotheses above are confirmed or replaced.

## 4. Shadow comparison: every current custom table

Compared by agency (or state), year, month and category. Every difference has a named cause or it fails.

| Current table | New definition | Declared, explained differences | Changed-semantics test |
|---|---|---|---|
| summary_carjacking_monthly | `incidents.carjacking@1` | none (N4: equal in every month 2017-2026, Memphis) | N4, M6, M7 |
| summary_carjacking_victim_demographics | `victims.carjacking@1` × race, sex, age group, robbery weapon | victims of other offenses in the incident; second and third robbery weapons; D1; D8 | T1, T2 |
| summary_carjacking_offender_demographics | `offenders.carjacking@1` × robbery weapon | offender 00 rows; weapons | T2 |
| summary_carjacking_arrestee_demographics | `arrestees.carjacking@1` × armed-with | the second arrestee weapon | T3 |
| summary_carjacking_clearance | `incidents.carjacking_cleared@1` | builder to be recovered | T12 |
| summary_victims_per_incident | `incidents.victim_count_bucket@1` | connected offenses beyond slot 3 | T4 |
| summary_juvenile_offender_incidents | `incidents.juvenile_offender@1` | none expected | T5 |
| summary_domestic_violence, summary_dv_trends | `victims.domestic_violence@1`, `incidents.domestic_violence@1` | relationships beyond nibrs.db's three | T6 |
| summary_dv_arrests | `arrestees.domestic_violence@1` | builder to be recovered | |
| summary_victim_relationship | `relationship.group@1` | relationships beyond three | T6 |
| summary_victim_circumstance | `circumstance.group@1` | none expected (two circumstances kept today) | |
| summary_hate_crime, summary_hate_crime_location | `offenses.hate_crime@1` × `bias.motivation` | offenses whose first bias is 88 or 99 but a later one qualifies; offenses counted under several bias groups when grouped by bias | T7 |
| summary_victim_demographics (incl. firearm), summary_victim_weapon | victims × `weapon.category@1` | second and third weapons; connected offenses beyond slot 1; D7 (robbery) | T1 |
| summary_arrestee_demographics | Group A arrestees × `arrestee.arrest_offense_weapon` (today's concept); Group B arrests × armed-with (today's concept) | second and third offense weapons (Group A); the second arrestee weapon (Group B); Group A arrestees whose arrest offense has no offense row (INNER join today). Armed-with for Group A is a new, separate dimension, never compared with today's column | T3, T11 |
| summary_offense_location | `location.commercial@1` | none expected | |
| summary_drug_monthly | `drug.category@1` | none expected | |
| summary_drug_arrests | arrestees by drug category | builder to be recovered | |
| summary_property_offense, summary_property_value_state | `property.value@1`, `property.segments@1` | the zeroed outlier rows (C4), dollars only | T8 |
| summary_city_monthly / summary_state_monthly cleared_count | `offenses.cleared@1` | none expected | |
| nibrs_state_coverage | `coverage.population_pct@1` | both formula differences (deliberate) | lesson 8 |
| (flash mob, LEOKA: no table) | `incidents.flash_mob_shoplifting@1`, `victims.leoka@1` | | T9, T10 |

### Changed-semantics tests (synthetic incidents, expected outcomes)

| Test | Incident | Today's table | New definition |
|---|---|---|---|
| T1 | a carjacking whose 120 offense has weapons 12 (handgun) and 20 (knife); one robbery victim and one 13B victim | victims: 2 (all individuals); weapon: Firearm only | `victims.carjacking@1` = 1; by robbery weapon: Firearm 1 and Knife 1 (each value), share denominator 1 victim |
| T2 | two carjacking incidents: one with an offender 00 segment, one with two offenders | offenders: 1 + 2 = 3 rows | `offenders.carjacking@1` = 2 |
| T3 | a carjacking whose robbery weapon is 12 and whose arrestee is armed with 20 and 11 | arrestee by `arrestee_weapon_1`: Knife | armed-with: Knife and Firearm (each value), never the robbery's handgun |
| T4 | an incident where 4 individual victims are connected to 13A, one of them in slot 4 | 3 victims (slots 1-3 only, nibrs.db) | 4 victims (canonical keeps all ten) |
| T5 | three incidents whose only offenders are aged 17, 00 and NN | 1 (17 only) | 1: for offenders, 00 and the infant codes NN, NB, BB decode to unknown (an offender age error), so they never count as juvenile |
| T6 | a victim related to offender 01 as AQ and offender 04 as SE | not DV (relationship 4 not in nibrs.db) | DV, intimate partner |
| T7 | an offense with biases 88 then 21; another with 12 then 21 | first: not a hate crime; second: anti-Black only | both hate crimes; grouped by bias: anti-Black 1, anti-Jewish 2 |
| T8 | one property row averaging $1.2M and one averaging $5,000 in one agency-year | dollars: 0 + total of the second | dollars: both totals; counts equal |
| T9 | 23C at location 07 with 6 offenders; with 5 offenders; at location 20 with 8 | 1 (model SQL) | 1, 0, 0 |
| T10 | an L victim connected to 13B in slot 3 | not counted (slots 1-2) | counted |
| T11 | a Group A arrest for 13A whose offense weapon is 12 (handgun) and whose arrestee is unarmed (01) | Firearm (the offense's weapon) | arrest-offense weapon: Firearm (equal); armed-with: Other (code 01, unarmed, falls in Other under `weapon.category@1`), a separate dimension |
| T12 | a cleared carjacking incident holding 120 and 240 | builder to be recovered | `incidents.carjacking_cleared@1` = 1 (not 2 cleared offenses) |
| T13 | an offense whose only bias field is blank; another with blank then 21 | blank-only: not in the hate-crime location table, in summary_hate_crime as written today | blank-only: not a hate crime; blank + 21: a hate crime, anti-Jewish |

## 5. Decisions for the owner

1. D3 flash mob: apply the business-victim condition, and use the commercial location list (C12) instead of the
   current retail list with 56?
2. D4 domestic violence: add SS, FP, FC and CO; and which definition answers "domestic violence murders"
   (relationship, today's default, or circumstance 06)?
3. D5 drug crimes: 35A, or 35A and 35B?
4. C4 property value: keep every value (v1), or exclude outlier segments by a per-segment rule?
5. Lesson 8: adopt `coverage.population_pct@1` (CDE-like) in place of today's 6-month rule?

v1 keeps today's membership rules for 1-3 so the shadow measures the engine, not the decisions; a decision becomes
`@2` with its own shadow difference.

### Owner's answers, 2026-10-28 (relayed by the NIBRSAI session)

Each answer is a new version beside v1, never an edit of it. v1 stays the shadow baseline (it measures the engine); each
`@2` is shadowed against its `@1` and every difference has to be the one declared here. The reader binds the wording to
`@2` once the `@2` shadow passes.

| Decision | New definition | Declared difference from `@1` (the shadow must show exactly this) | Test |
|---|---|---|---|
| D3 flash mob | `incidents.flash_mob_shoplifting@2`: incidents with a 23C offense whose location is in `location.commercial@1` (C12: 02, 03, 05, 07, 08, 09, 12, 14, 17, 19, 21, 23, 24, 40, 41, 47, 55), `incident.offender_segment_count >= 6`, and `incident.business_victim_count <= 1` (a derived incident dimension: victim segments of type B; the prompt's "at most 1 business victim", never in its SQL) | added: incidents at 02, 03, 14, 19, 40, 47, 55; removed: incidents at 56 (tribal lands) and incidents with two or more business victims | T14 |
| D4 domestic violence | `victims.domestic_violence@2`, `incidents.domestic_violence@2`, `arrestees.domestic_violence@2`, `relationship.group@2`: the C8 lists with SS (stepsibling) in family, and FP, FC and CO as decided. "Domestic violence murders" stays relationship-based: `victims.domestic_violence@2` connected to 09A (circumstance 06 is not used) | added: victims whose only qualifying relationship is SS, FP, FC or CO, and their incidents and arrestees | T15 |
| D5 drug crimes | `offenses.drug_crimes@2`: offenses 35A and 35B. "Drug crimes" and "drugs" bind to it; 35A stays available by its own name ("drug/narcotic violations", `offenses.drug_possession@1`) | added: every 35B offense. An incident with both 35A and 35B counts two offenses (the offense unit) | T16 |
| C4 property value | no rule yet. v1 keeps every value. The owner asked for the outliers ($10,000,000, $999,999,999 and other repeated values) to be found and discussed first: a separate outlier report | none until a rule is chosen | T8 |
| Lesson 8 coverage | `coverage.population_pct@1` replaces today's 6-month rule as the coverage answer | the lesson-8 differences, reconciled agency by agency as stated there | lesson 8 |
| H3 (correctness set) | acknowledged: the FBI's re-upload of 2026-08-14 changes Memphis carjackings (2023: 527; 2024: 356). A source revision, not a definition | none | H3 |

**A fact for D4.** The FBI's 2025 NIBRS user manual (p. 167) lists SS among the victim-to-offender relationship codes,
but not FP, FC or CO; those three appear only in the app's own label table. They are adopted as decided, and they match
only if the data carries them: the shadow reports the count of each of the four codes by year, so a code that never
occurs is visible as zero rather than silently doing nothing. (XR, also absent from the manual's list, does occur in the
data and is already in C8.)

| Test | Incident | `@1` | `@2` |
|---|---|---|---|
| T14 | 23C with 6 offenders: at location 55 with 1 business victim; at 56 with 1; at 07 with 2 business victims; at 07 with 0 | 0, 1, 1, 1 | 1, 0, 0, 1 |
| T15 | a 13A victim related to its offender as SS; a 09A victim related as SE | DV: no, yes | DV: yes, yes; "DV murders" counts the second only |
| T16 | one incident with 35A and 35B; one with 35B alone | drug crimes: 1, 0 | 2, 1 |

