# NIBRS semantic layer v1: custom definitions and definition lessons

Scope addition to `2026-10-27-nibrs-engine-restructure.md` and `2026-10-28-nibrs-plan-language.md` (r4, accepted).

**Owner, 2026-10-28 (relayed by the NIBRSAI session):** "inventory our custom definitions, add them to the semantic
layer v1 scope, and shadow-test them against the current tables"; and "send ... the definition lessons to the
engine session, each with a test and Codex review."

What this document does:
1. inventories every category NIBRSAI defines itself rather than taking from one FBI offense code, with its exact
   current rule, where it lives, what depends on it, and where the places that define it disagree;
2. turns each into a named, versioned semantic-layer definition at its true grain, with a test;
3. adds lessons 6 (allowed counting units), 7 (the 2013 rape definition) and 8 (coverage percentage);
4. adds the current custom tables, and CDE coverage, to the shadow-comparison set.

Inventory sources: `lib/nibrs-claude.ts`, `lib/guardrails.ts`, `lib/tab-suggest.ts`, `lib/nibrs-codes.ts`,
`lib/nibrs-question-types.ts`, `lib/nibrs-question-compiler.ts`, `lib/query-contract.ts`,
`lib/nibrs-request-accounting.ts`, `lib/nibrs-incident-offense-scopes.json`, `scripts/nibrs-auto-update.py` and
`scripts/build_*.py`, and the `summary_*` tables in the live nibrs.db (37, listed 2026-10-28). Line numbers are at
branch `nibrs-engine/phase1` (base `origin/dev` b55df31).

**Tables with no builder in this repository** (their filters are known only from the prompt): summary_domestic_violence,
summary_dv_arrests, summary_hate_crime, summary_hate_crime_location, summary_offense_weapon, summary_offense_location,
summary_victim_circumstance, summary_victim_relationship, summary_offender_demographics, summary_carjacking_clearance,
summary_clearance_city_annual, summary_drug_arrests, summary_property_offense, summary_victim_weapon_circumstance(_demo).
Their rules must be recovered from the server's builders before their shadow comparison can be explained.
**There is no `summary_flash_mob_monthly`:** flash mob is a prompt-only definition, answered by model SQL, which no
longer runs.

## 1. Inventory

| # | Category | Current rule | Grain today | Lives in | Depends on it |
|---|---|---|---|---|---|
| C1 | Carjacking | an incident with a 120 offense and a property segment loss 7, description 03/05/24/28/37 (any offense's property) | monthly: distinct incident (`COUNT(DISTINCT ori\|\|incident_num)`, no separator, column named offense_count). Demographics: every individual victim, every offender, every arrestee in the incident; weapon = `MIN(type_weapon_1)` over the incident's 120 offenses | `nibrs-auto-update.py:901-913, 1218-1228`; `build_carjacking_demographics.py:54-66`; `nibrs-claude.ts:849-920, 1119, 1231, 1269, 1340-1351`; `city-ranking.ts:669-671, 709`; `city-ranking-builder.ts:333-345`; `nibrs-question-compiler.ts:243, 285-286`; `nibrs-request-accounting.ts:151` | summary_carjacking_monthly, summary_carjacking_{victim,offender,arrestee}_demographics, summary_carjacking_clearance (no builder here); question compiler; city ranking; FAMILIES; the frozen H1-H3 |
| C2 | Flash mob shoplifting | 23C at location 05/07/08/09/12/17/21/23/24/41/56 with 6 or more offender segments in the incident | distinct incident by year | `nibrs-claude.ts:1522-1536` (prompt only) | model SQL only |
| C3 | Theft from vehicle / vehicle burglary | a wording map to 23F alone (not 220, not 23G) | offense | `query-contract.ts:152-153`; `nibrs-request-accounting.ts:148`; `nibrs-question-types.ts:26`; `nibrs-claude.ts:364-370, 1118`; `guardrails.ts:2099-2116`; `tab-suggest.ts:242-243` | every path |
| C4 | Motor vehicle property (value) | property description 03/05/24/28/37 when value words appear; dollars | property value | `nibrs-request-accounting.ts:149`; `nibrs-question-compiler.ts:243, 856`; `build_property_summary.py` (zeroes rows with average value of $1M or more) | summary_property_value_state, summary_property_offense |
| C5 | Violent / property crime | violent = 09A, 11A-C, 120, 13A; property = 200, 220, 23A-H, 240; on request, the NIBRS crimes-against taxonomy | MIXED: victims for person codes, offenses for 120 | `nibrs-codes.ts:83-101` (source); copies in `nibrs-question-types.ts:24-29`, `query-contract.ts:162-163`, `nibrs-incident-offense-scopes.json`, `nibrs-claude.ts:1103-1114` | every path; compiler declines a "victims" unit that would drop robbery (`:739, 755`) |
| C6 | Other offense rollups | rape 11A-C; sex offense 11A-D, 36A/B; theft 23A-H; homicide 09A only; assault (unqualified) 13A-C; drug possession 35A; DUI 90D | per component | `nibrs-question-types.ts:24-29`; `nibrs-claude.ts:1084, 1093-1098` | every path |
| C7 | Juvenile-offender incidents | an incident with any offender aged 1-17 (two-digit ages; unknown excluded); every offense code plus the scopes in `nibrs-incident-offense-scopes.json` | distinct incident per year, month, ORI, scope; month 0 when the date is missing | `nibrs-auto-update.py:1362-1447`; `build-juvenile-offender-incident-summary.py:95-120` | summary_juvenile_offender_incidents; `nibrs-deterministic-queries.ts:75-140` |
| C8 | Domestic violence | relationship-based: intimate partner SE, CS, BG, XS, XR, HR; family CH, PA, SB, OF, SC, SP, GP, GC, IL, CF, BE. A second definition: circumstance 06 in summary_victim_circumstance (09A/13A) | victim-offense rows; counts of distinct incidents or victims | `nibrs-claude.ts:660-661, 1165-1173`; `guardrails.ts:157-202, 1808-1817`; `nibrs-request-accounting.ts:84-85, 152`; `source-capabilities.ts:386-388` | summary_domestic_violence (no builder here), summary_dv_trends (`nibrs-auto-update.py:1706`), summary_dv_arrests |
| C9 | Hate crime | offense bias_motivation not 88 or 99 (location table also excludes blank) | offense; first bias only (one column) | `nibrs-claude.ts:506-520, 675-687, 1124-1128`; `nibrs-request-accounting.ts:87-93` | summary_hate_crime, summary_hate_crime_location (no NIBRS builder here) |
| C10 | Firearm | weapon 11, 11A, 12, 12A, 13, 13A, 14, 14A, 15, 15A | firearm VICTIM counts use the first weapon only, with a note; "gun arrests" = the arrest offense's first weapon (Group A) or arrestee_weapon_1 (Group B) | `nibrs-auto-update.py:166`; `nibrs-question-compiler.ts:224-235`; `guardrails.ts:290-320`; `nibrs-claude.ts:1100-1101, 1194` | summary_victim_demographics, summary_arrestee_demographics, summary_victim_weapon (all three slots) |
| C11 | Shootings | not defined: redirected to Homicide Reports, aggravated assault with a firearm offered | none | `guardrails.ts:2910-2925`; `nibrs-request-accounting.ts:42-43, 197`; `source-capabilities.ts:195, 379` | refusal paths |
| C12 | Commercial locations | 02, 03, 05, 07, 08, 09, 12, 14, 17, 19, 21, 23, 24, 40, 41, 47, 55, each named in the answer | offense | `nibrs-codes.ts:155-162`; `nibrs-question-compiler.ts:266, 667-670` | summary_offense_location |
| C13 | Drug types | the first character of suspected_drug_type (A crack, B cocaine, D heroin, E marijuana, L amphetamine/meth ...); fentanyl refused | distinct incident per drug type, all three slots | `nibrs-claude.ts:376-423`; `nibrs-request-accounting.ts:51, 77-82` | summary_drug_monthly, summary_drug_arrests (no builder here) |
| C14 | Relationship groups | intimate partner and family as C8; known = AQ, FR, NE, OK; stranger = ST | victim | `nibrs-claude.ts:665-669`; `nibrs-request-accounting.ts:117` | summary_victim_relationship (no builder here) |
| C15 | Circumstance categories | gang = 04/05; justifiable homicide by police = 09C + 21; by a private citizen = 09C + 20 | victim | `nibrs-claude.ts:1181-1213` | summary_victim_circumstance |
| C16 | Officers assaulted or killed | victim type L, connected offense 1 or 2 in 09A, 13A, 13B (raw victims table) | victim | `nibrs-claude.ts:1175-1179` | model SQL only |
| C17 | Age groups | buckets in `nibrs-auto-update.py:224`; NN, NB, BB cast to 0 and fall in "Under 18" | per table | `nibrs-auto-update.py:224` | every demographic summary |
| C18 | Stolen firearms | property loss 7, description 13 | property / incident | `nibrs-claude.ts:1230` | model SQL only |

**First-value limits in today's tables** (the canonical layer keeps every value; each is an explained difference in
the shadow comparison): `connected_offense_1` only (victim monthly and victim demographic tables); `type_weapon_1`
only (victim, arrestee and carjacking weapon categories); `arrestee_weapon_1`; one bias motivation; the victim's first
three connected offenses and relationships (nibrs.db's import). Drug and victim-weapon tables use all three slots.

**Disagreements between places that define the same thing** (each needs a decision; the v1 definition below says
which version it keeps):

| # | Disagreement | Evidence |
|---|---|---|
| D1 | Carjacking weapon buckets: the auto-update builder counts the A variants as firearms and maps 90 to Unknown; `build_carjacking_demographics.py:19-24` counts 11-15 only and maps 90 to Other | both builders |
| D2 | `guardrails.ts:1731` calls carjacking a person crime "counted from VICTIM summary tables"; every other path counts carjacking by incident | message text |
| D3 | Flash mob: the text says "at most 1 business victim" but the SQL does not apply it; the list includes 56 (tribal lands, per the prompt's own list at `:1221`) and leaves out 55 (shopping mall); it differs from the commercial list (C12) | `nibrs-claude.ts:1522-1536` |
| D4 | Two domestic-violence definitions (relationship vs circumstance 06). The relationship lists leave out SS (stepsibling, 65 Houston 2024 victims), FP and FC (foster parent and child) and CO | `nibrs-claude.ts:660-661`; Houston 2024 relationship counts |
| D5 | Drug crimes: "35A" at `nibrs-claude.ts:57`, "35A and 35B" at `:1115`; the reader maps "drugs" to 35A | prompt text |
| D6 | "Fatal shootings" maps to 09A with no firearm condition (`query-contract.ts:127`); every other path redirects shootings | contract table |
| D7 | Robbery in DEMO_CODES (`nibrs-question-compiler.ts:237`) for summary_victim_demographics, which is built from PERSON_CRIMES and has no 120: robbery victim demographics come back empty | builder vs compiler |
| D8 | Age special codes NN, NB, BB (under a week, under a year) cast to 0: "under 18" is right, any numeric age bin is not | `nibrs-auto-update.py:224` |

## 2. Semantic-layer v1 definitions

Each definition has a stable id with a version (`@1`), is written at its true grain in the canonical layer's terms
(`lib/nibrs-plan/semantic.ts`: entity, unit, aggregation, predicate, links), and has a test. A changed rule is a new
version (`@2`), never an edit; plans and answers name the version they used.

| Id | Definition at its true grain | Allowed units (lesson 6) | Test |
|---|---|---|---|
| `incidents.carjacking@1` | incidents containing a 120 offense AND, **in the same incident**, a property segment with loss 7 and a motor-vehicle description (03, 05, 24, 28, 37). Property is linked to the incident, not to the robbery: the definition does not say the robbery took the vehicle | incidents (primary); 120 offenses in those incidents (equal: one 120 segment per incident); victims connected to the 120 offense; offenders and arrestees of those incidents | H1-H3 and the whole Memphis 2017-2026 series equal today (correctness set N4: equal in every month); M6, M7 |
| `carjacking.weapon@1` | every weapon of the incident's 120 offense (offense_weapon, all three), each counted (`multiValue: each_value`, shares over distinct incidents); today keeps `MIN(type_weapon_1)` | as above | shadow: summary_carjacking_*_demographics; every difference is a second or third weapon, or D1 |
| `carjacking.victims@1` | individual victims **connected to the 120 offense** in carjacking incidents. Today's table counts every individual victim in the incident (of any offense) | victim | shadow: summary_carjacking_victim_demographics; differences are victims of other offenses in the incident |
| `incidents.flash_mob_shoplifting@1` | incidents with a 23C offense whose location is in the v1 retail list, with 6 or more offender segments. v1 keeps today's list and leaves the business-victim condition out, so the shadow equals today; the D3 corrections are `@2`, an owner decision | incidents | hand case from raw rows (one qualifying, one with 5 offenders, one at a non-retail location) |
| `offenses.theft_from_motor_vehicle` | 23F; the reader maps "car break-ins" and "vehicle burglary" here and never to 220 or 23G | offenses; victims recorded on 23F (lesson 6) | N2, M5, M7 |
| `property.motor_vehicle_value@1` | the value of property segments with a motor-vehicle description, by loss type; v1 keeps today's exclusion of agency-years whose average value is $1M or more, as a declared rule | dollars, property segments, vehicles | shadow: summary_property_value_state |
| `violent_crime@1`, `property_crime@1` | composites of their component measures, each in the FBI's standard unit (victims for crimes against persons, offenses for robbery and property crimes); a composite total is the sum of the components and is labelled as such; it is not additive with a component | the components' units; a composite is not "victims" (the compiler refuses a victims total that drops robbery, as today) | shadow: today's violent and property series; S2-style unit test |
| `offenses.rape@1` and the other C6 rollups | as today's MEASURE_CODES; homicide is 09A; unqualified assault 13A-C | per component (victims for person codes) | shadow: summary_victim_*_monthly |
| `incidents.juvenile_offender@1` | incidents with an offender aged 1-17 (decoded ages; 00 unknown excluded) | incidents | shadow: summary_juvenile_offender_incidents; none expected |
| `victims.domestic_violence@1` | victims with any relationship (all ten, through victim_offender) in the intimate-partner or family set. v1 keeps today's lists; the missing codes (SS, FP, FC, CO) and the circumstance-06 definition are D4, an owner decision for `@2` | victims, incidents | shadow: summary_domestic_violence and summary_dv_trends, once their builders are recovered |
| `offenses.hate_crime@1` | offenses with any bias motivation other than 88 (none) and 99 (unknown); the canonical layer keeps every bias motivation, so a multi-bias offense counts once per offense and under each bias when grouped by bias | offenses, incidents, victims | shadow: summary_hate_crime; differences are offenses whose first bias is 88/99 but a later one is not |
| `weapon.firearm@1` | weapon codes 11, 11A, 12, 12A, 13, 13A, 14, 14A, 15, 15A; any of the offense's weapons (existence), not the first only | any | shadow: summary_victim_demographics weapon_category Firearm; differences are firearms in the second or third slot |
| `location.commercial@1` | C12's list, named in every answer | offenses | shadow: summary_offense_location |
| `drug.category@1` | the first character of the suspected drug type, all three slots | incidents | shadow: summary_drug_monthly |
| `relationship.group@1`, `circumstance.group@1` | C14 and C15 as today | victims | shadow: summary_victim_relationship, summary_victim_circumstance |
| `victims.leoka@1` | victims of type L connected to 09A, 13A or 13B (any connected offense, not only the first two) | victims | hand case from raw rows |
| `age.decoding@1` | numeric ages 1-98, 99 = 99 or over, NN/NB/BB = under 1 year, 00 = unknown (shared spec: special codes never fall in a numeric bin) | n/a | unit test on the decoder |
| `property.stolen_firearm@1` | property segments with loss 7 and description 13; at incident scope with `attribution: incident_level_only` | property segments, incidents | N2 |

Shootings (C11) stay undefined in v1: NIBRS has no shooting code. The reader keeps the redirect, and D6 (the 09A
mapping for "fatal shootings") is fixed in the reader, not the semantic layer.

## 3. Definition lessons

### Lesson 6. Allowed counting units per offense

**Corrected premise.** NIBRS does record victims for crimes against property: a 23F or 240 offense has victim
segments (individuals and businesses; correctness cases M5 and M7 show both). What NIBRS does not do is count
property crimes by victim; the FBI counts them by offense. Today a "theft victims" request reads the victim summary
tables, which are built only from crimes against persons, and so returns no rows, and an empty result can read as
zero. Carjacking victims are not empty today: summary_carjacking_victim_demographics exists (with the C1 caveat).

**Rule.** Every measure in the semantic layer declares its allowed units and its standard unit:
- crimes against persons: victims (standard), offenses, incidents, offenders, arrests;
- crimes against property: offenses (standard), incidents, victims recorded on the offense (labelled "victims
  recorded for <offense>", by victim type), property segments, dollars, vehicles, offenders, arrests;
- crimes against society: offenses (standard), incidents, arrests; victim type S (society) is not a person count, so
  "victims" is not allowed.

The plan language needs no new rule: a measure id carries its unit (`victims.murder`, `offenses.theft`), so the
allowed units of an offense are exactly the measure ids the layer defines for it, and S2 already refuses any other
(`victims.drug_possession` does not exist). Each layer measure also records whether its unit is the offense's
standard unit, for the reader's default. The reader then answers in the standard
unit with the unit named, or asks with chips when two allowed units give different answers ("victims or offenses?").
An empty result is never shown as zero: an empty cell is UNKNOWN or UNKNOWN_UNEVIDENCED_ZERO (D6).

**Test.** "theft victims in Memphis in 2024", "carjacking victims in Memphis in 2025", "drug possession victims in
Houston": the first two answer in an allowed unit with the unit named (or clarify), the third gives the standard
refusal; none returns an empty table.

### Lesson 7. The 2013 rape definition

**Corrected premise, with evidence.** The 2013 change was to the Summary Reporting System (SRS) definition: legacy
SRS rape was forcible carnal knowledge of a female; revised SRS rape includes any sex and any penetration. NIBRS
codes 11A, 11B and 11C did not change meaning in 2013. In nibrs.db (summary_victim_demographics), the male share of
11A victims is flat across the boundary: 902 of 28,894 in 2008 (3.1%), 997 of 30,463 in 2013 (3.3%), 1,446 of 46,258
in 2018 (3.1%); 11B (male victims about half) is likewise flat. So a NIBRS rape trend crossing 2013 needs no
switch. CDA's correction (`scripts/correct-historical-national-rape.py`) is on the Historical tab, which is SRS.

**Rule.** Two named, versioned NIBRS definitions, valid in every year:
- `victims.rape@1`: 11A + 11B + 11C victims: the NIBRS equivalent of the revised SRS definition; NIBRSAI's "rape";
- `victims.rape_legacy_srs@1`: 11A victims who are female: the NIBRS equivalent of legacy SRS rape, used only when a
  question asks for the legacy definition or a NIBRS figure is set beside an SRS figure from before 2013.

A NIBRS trend crossing 2013 uses `rape@1` throughout and labels it "rape (NIBRS 11A, 11B, 11C)" with no further note.
Where NIBRS and SRS are compared (multi-source plans, design point 11), each SRS year carries its own definition
label, legacy before 2013 and revised from 2013, as the Historical tab already does.

**Test.** "rapes in Michigan by year, 2008 to 2018" (a NIBRS state across the boundary): one definition, one label,
no break; and the 11A male share by year stays within the measured band (a guard that the premise still holds when
the canonical build replaces nibrs.db).

### Lesson 8. Coverage percentage

**Measured, 2026-10-28,** for 10 states in 2024: NIBRSAI's `nibrs_state_coverage` against FBI CDE
(`/nibrs/state/{ST}/homicide-offenses`, the "Percent of Population Coverage" and `participated_population` fields).
Files: `scripts/fixtures/nibrs-coverage-shadow/` (the comparison, our 2024 rows, and the 10 CDE responses as fetched).

| State | CDE, Dec | CDE, mean of months | NIBRSAI | Our denominator vs Census | Our numerator / Census |
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

Two causes, each visible:
- **Denominator.** Ours is the sum of agency populations (`build-nibrs-state-coverage.py:54-74`), with no overlap
  rule, so overlapping jurisdictions count residents twice: PA +7.9%, NY +9.9% over the Census population. CDE
  divides by the Census state population. Replacing our denominator with Census moves PA from 46.47 to 50.12.
- **Numerator.** Ours counts an agency's whole population only if it reported 6 or more months; CDE counts each
  month's participating population. FL is the clearest case: same denominator (+0.6%), but our numerator is 12.5M
  against CDE's 16.3M in December: agencies that joined NIBRS during 2024 count for CDE in the months they reported
  and not at all for us.

**Definition (v1).** `coverage.population_pct@1` for a geography and a period: the covered population of agencies
whose months in the period are known (D6), with populations counted only for primary agencies
(`agency_jurisdiction.population_counted`, D8), divided by the Census population of the geography for the period's
year (`geo_population`); for a period of several months, the mean of the monthly values. Labelled in answers as
"share of residents covered by agencies reporting NIBRS data". It matches CDE's construction (monthly participating
population over Census), so the expected residual gap is the D8 overlap rule and the D6 known-month rule, each named.

**Shadow test.** For the 10 states above and every state once the canonical build exists: the v1 value against CDE
by month; every gap over 1 point is explained by agency (an agency CDE counts and we do not, or the reverse).

## 4. Shadow-comparison additions

Added to the shadow set (restructure plan, phase 5). For each, the new engine's figures are compared by agency,
year and month (and by category for demographics); each difference has a named cause or it fails.

| Current table | New-engine definition | Expected, explained differences |
|---|---|---|
| summary_carjacking_monthly | `incidents.carjacking@1` | none (N4: equal in every month 2017-2026 for Memphis) |
| summary_carjacking_victim_demographics | `carjacking.victims@1` × race, sex, age, weapon | victims of other offenses in the incident; second and third weapons; D1 buckets; D8 ages |
| summary_carjacking_offender_demographics, _arrestee_demographics | offenders, arrestees of carjacking incidents | weapons (all vs MIN of the first); D1; arrestee_weapon_2 |
| summary_carjacking_clearance | carjacking incidents cleared | to be stated once its builder is recovered |
| summary_juvenile_offender_incidents | `incidents.juvenile_offender@1` | none expected |
| summary_dv_trends, summary_domestic_violence, summary_dv_arrests | `victims.domestic_violence@1` | relationships beyond nibrs.db's three; builder to be recovered |
| summary_hate_crime, summary_hate_crime_location | `offenses.hate_crime@1` | biases after the first |
| summary_victim_demographics (firearm), summary_victim_weapon | `weapon.firearm@1` | second and third weapons; connected offenses after the first |
| summary_offense_location (commercial) | `location.commercial@1` | none expected |
| summary_drug_monthly | `drug.category@1` | none expected |
| summary_property_value_state, summary_property_offense | `property.motor_vehicle_value@1` | none expected with the $1M rule kept |
| nibrs_state_coverage | `coverage.population_pct@1` | the denominator and numerator causes above (deliberate) |
| (flash mob, LEOKA: no table) | `incidents.flash_mob_shoplifting@1`, `victims.leoka@1` | hand cases from raw rows instead |

## 5. Decisions for the owner

1. D3 flash mob: apply the business-victim condition, and use the commercial location list (C12) instead of the
   current retail list with 56?
2. D4 domestic violence: add SS, FP, FC and CO; and which definition answers "domestic violence murders"
   (relationship, today's default; or circumstance 06)?
3. D5 drug crimes: 35A, or 35A and 35B?
4. Lesson 8: adopt `coverage.population_pct@1` (CDE-like) in place of today's 6-month rule, labelled as above?

v1 keeps today's rules for 1-3 so the shadow comparison measures the engine, not the decisions; a decision becomes
`@2` with its own shadow difference.
