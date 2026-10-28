# Cases

Codes: offenses 09A murder and nonnegligent manslaughter, 09C justifiable homicide, 13A aggravated assault,
120 robbery, 200 arson, 23F theft from motor vehicle, 240 motor vehicle theft. Property loss types: 1 none, 2 burned,
5 recovered, 7 stolen. Property descriptions: 03 automobiles, 13 firearms, 37 trucks, 77 other. Victim types: I
individual, B business, L law enforcement officer. Relationship ST stranger, RU relationship unknown.

## Coverage

| Required by the plan | Cases |
|---|---|
| multiple victims | M1, M2, M3, N1 (94 two-victim, 14 three-victim, one four- and one five-victim Houston murder incidents) |
| multiple offenders | M4 (6 offenders, 4 arrestees), M7 (offender segment 00: nothing known) |
| multiple property segments | M3, M5, M6, M7, N2, N3 |
| overlapping categories | M1 (09A + 13A, different victims), M3 (one victim in 09A, 200 and 240), M7 (23F + 240 share a stolen firearm) |
| missing vs zero vs unknown months | Z, N1 (January-May 2018, August-October 2026), N3 |
| denominator scopes | D, N1, R |
| the named cases | N1 = (a), N2 = (b), N3 = (c), N4 = (d) H1-H3 |

## Micro cases (traced by hand)

Each is one real incident with all its segments in `extracts/micro/`. Expectations: `expected/micro.json`.

### M1. Houston 2019 `008261219`, 2019-01-19: two offenses, five victims
- Offenses: 09A and 13A, both completed, weapon 11 (firearm), location 20 (residence).
- Victims 001-003: individuals, men 23, 18 and 20, White, Hispanic, connected to 09A, circumstance 09, related to offender 01 as ST.
- Victims 004-005: men 19 and 20, connected to 13A, circumstance 09, injury O.
- One offender: 20, male, White, Hispanic. No arrestees, no property.
- So: 1 incident, 2 offenses, 3 murder victims, 2 aggravated assault victims, 5 distinct victims of violent crime.
  The incident counts once in "incidents with murder or aggravated assault". Counting murders by incident gives 1,
  by victim 3; the plan must say which.

### M2. Houston 2021 `6V139B1EZU72`, 2021-05-29: five victims of one murder offense
- One 09A offense, weapon 12 (handgun).
- Victims: 001 Pacific Islander man 62 (circumstance 10); 002 Black man 28 (circumstances 04 and 09);
  003 Black woman 26 (04); 004 Black woman 30 (04); 005 Black man 27 (04). All RU to offender 01.
- One offender segment, age 00, sex U, race U: an offender exists, with nothing known about them.
- So: murder victims 5; by race and sex P-M 1, B-M 2, B-F 2; 6 victim-circumstance pairs (victim 002 has two),
  5 victims with any circumstance. Offender demographics: one offender, all unknown.

### M3. Houston 2021 `729X9A1EZU72`, 2021-09-05: one victim in three offenses
- Offenses 09A (weapon 11), 200 (arson), 240 (motor vehicle theft).
- Victims 001 (man 37) connected to 09A, 200 and 240; 002 (boy 10), 003 (girl 12), 004 (man 46) connected to 09A only.
- Property: loss 2 description 77 (burned, value 0); loss 7 description 37 (a truck stolen, value 7,000, 1 vehicle);
  loss 5 description 37 (the truck recovered 2021-09-09, 1 vehicle).
- Cleared exceptionally, code A (death of the offender), 2021-10-26.
- So: 4 distinct victims, 6 victim-offense pairs, 3 offenses, 1 incident. Adding incidents across the murder, arson
  and motor vehicle theft categories gives 3 for one incident. Stolen value 7,000; the recovered truck is the same truck.

### M4. Houston 2019 `026992719`, 2019-03-02: six offenders
- One 09A offense, weapon 11, criminal activity G (gang). One victim, man 19, circumstance 01.
- Offenders 01-06: men aged 21, 20, 18, 19, 16, 18, all White, Hispanic.
- nibrs.db holds the victim's relationship to offenders 01, 02 and 03 only (all ST). NIBRS allows ten; the
  relationships to 04-06, if reported, are in the master-file line only: `PENDING_MASTER_FILE`.
- Arrestees 01-04, all arrested for 09A, type O, ages 20, 18, 19, 16; the 16-year-old has disposition H.
- So: 6 offenders (1 under 18), 4 arrestees (1 under 18), 1 victim. "Offenders by age" counts offenders, not incidents.

### M5. Memphis 2024 `0U0S3UG6NNFF`, 2024-01-02: one firearm, stolen and recovered
- One 23F offense, completed. One individual victim connected to 23F. One offender, 17, male, Black.
- Property: loss 7 description 13 value 550; loss 5 description 13 value 550, recovered the same day.
- So: it counts in N2 (a stolen-firearm segment exists). 2 firearm segments, 1 stolen.
  "Firearms stolen" is 1, not 2.

### M6. Memphis 2024 `0U0S3UJ2H0FF`, 2024-01-12: carjacking with a stolen firearm
- One 120 offense, weapon 11. One victim, man 49, RU to offender 01 (woman 25).
- Property: loss 7 description 03 (automobile, 30,000), loss 5 description 03 (recovered same day), loss 7
  description 13 (firearm, value 1).
- One arrestee, arrested 2024-06-21 for 120, type T.
- So: carjacking 1 (robbery with a stolen motor vehicle: N4's definition); not in N2 (no 23F);
  stolen value 30,001. By arrest month the arrest is June 2024; by incident month the incident is January 2024.

### M7. Memphis 2024 `0U023-G72OFF`, 2024-04-27: a firearm no offense owns
- Offenses 23F and 240, both completed.
- Victims: 001 a business connected to 240; 002 a man 36 connected to 23F.
- Offender segment 00: no offender information at all (not "one unknown offender").
- Property: loss 7 description 03 (automobile, value 1, 1 vehicle) and loss 7 description 13 (firearm, value 700).
- So: the 23F counts in N2, and the 240 would count in "motor vehicle thefts with a stolen firearm" too. Whether the
  firearm was taken from the car (the 23F) or with it (the 240) is not recorded. NIBRS links property to the
  incident, not to an offense. Known offenders 0.

## Named cases

### N1. Share of murder victims by race and sex, per month, Houston since 2018 (case a)
`expected/N1-houston-murder-victims-race-sex-monthly-share.json`
- Measure: victim segments of TXHPD0000 connected to 09A; counted by victim. 2,818 victims in 2,689 incidents.
  All 2,818 have 09A in the first connected-offense slot. 2,816 are type I and 2 are type L. Both types are murder
  victims.
- Each cell is a share of that month's murder victims: numerator, denominator and share to one decimal
  (half up from the exact fraction).
- Unknown race (U, 12 victims) and unknown sex (U, 6) are categories of their own. 14 race-sex combinations
  occur over the period. A combination absent in a month is 0 of that month's denominator; an answer may show it
  as 0 or leave it out, but must not recompute shares over the cells it shows.
- Months: January-May 2018 have no Houston NIBRS rows: UNKNOWN, and the answer says Houston's NIBRS data begins
  June 2018. June 2018-July 2026 (98 months) have rows. August-October 2026 have none: UNKNOWN.
  Not one reported month has zero murder victims.
- Hand trace, June 2018 (31 victims, 31 incidents, one victim each):
  - White men 14 (45.2%), Black men 10 (32.3%), White women 5 (16.1%), Black women 2 (6.5%);
  - 14 + 10 + 5 + 2 = 31; 2/31 = 6.45%, which rounds to 6.5.
- Wrong answers this case catches:
  - dividing by the period total (Savant's `pct_of_total`; case D shows the numbers);
  - dropping unknowns;
  - showing January-May 2018 as 0;
  - counting incidents instead of victims (M2: a five-victim incident is 5, not 1).

### N2. Thefts from motor vehicles where a firearm was stolen, per month (case b)
`expected/N2-memphis-23f-with-stolen-firearm-2024.json`
- Scope of the extract: Memphis (TNMPD0000), 2024. The rule does not depend on the place.
- Measure: 23F offenses in incidents that have at least one property segment with loss 7 and description 13.
  This is a scoped existence filter at incident scope, not a join. A join would count a 23F once per firearm
  segment (M5 has two firearm segments).
- 2024: 8,792 23F offenses. 1,503 are in incidents with a stolen-firearm segment, 156 of which also hold another
  offense (23F with 240, 290, 13C ...), as in M7.
- The answer must state that NIBRS does not attribute property to one offense, so the firearm is not said to be
  taken in the theft from the vehicle. It must not read "firearm stolen" as the weapon (the 2026-10-27 misreading).
  The 156 shared incidents are provenance; the answer adds no other note.

### N3. Car thefts in Baltimore by month, January 2022 to June 2026 (case c)
`expected/N3-baltimore-motor-vehicle-theft-2022-01-to-2026-06.json`
- Measure: 240 offenses of MDBPD0000, completed and attempted, by incident month. 54 months over five calendar
  years, all with Baltimore rows; 26,702 offenses.
- **Duplicates in the source rows.** Five 2023 incidents are stored twice in nibrs.db, every segment identical
  (incident, offense, victim, property): `C60 RWQQ628N` (March), `C60VRWRLQ28N` (May), `C60GRBS9V28N` (June),
  `C60DRA5MP28N` (July), `C60ARFECV28N` (August). Each counts once.
  - Today's live `summary_city_monthly` counts them twice: it is 1 higher in each of those five months and equal
    in the other 49. That is the only difference.
  - Whether the FBI master file repeats them, or the nibrs.db import did, is checked when the canonical build
    reads the 2023 file.
- "Car" is read as motor vehicle theft, labelled as such. The narrower reading (240 in incidents with a stolen
  automobile segment) is recorded per month as `variant_with_stolen_automobile_segment`. It is much lower, for
  example July 2023: 1,571 against 926. The reader should be shown the label; whether "car" should ever narrow to
  description 03 is a semantic-layer decision, recorded as open.
- Baltimore's NIBRS rows begin June 2021 (19 incidents, then about 3,600 a month) and taper in July-September 2026
  (3,510, 937, 5). The requested range avoids both edges.

### N4. Frozen release questions H1-H3 (case d)
`expected/N4-frozen-release-H1-H3-memphis-carjacking.json`
- Definition unchanged: incidents with a 120 offense and a stolen (loss 7) motor-vehicle segment
  (03, 05, 24, 28, 37), counted once per incident.
- H1 "carjacking per month in Memphis": today's default reads the latest complete year, 2025:
  26, 16, 22, 25, 14, 13, 20, 20, 17, 5, 4, 8.
- H2 "carjackings in Memphis in 2025": 190.
- H3 "carjackings per year in Memphis from 2020 to 2025": 411, 535, 601, 528, 359, 190.
- The raw recount equals `summary_carjacking_monthly` in every month from January 2017 to October 2026, and
  so equals the live answers of 2026-10-27 (query_log 10631-10633). The new engine must give these numbers;
  any change to H1's default period is a declared change.

## Rule cases

### Z. Missing, zero and unknown months: Houston justifiable homicides (09C) per month since 2018
`expected/Z-houston-09c-missing-zero-unknown.json`
- 59 offenses in 35 months.
- 63 months have Houston rows (thousands of incidents each) but no 09C. Under D6 these are UNKNOWN for this
  measure, not 0, until the month's submission is evidenced complete. Each row carries the value it takes then (0).
- 8 months have no Houston rows at all (January-May 2018, August-October 2026): UNKNOWN for the agency.
- No month here is NOT_REPORTED or REPORTED_ZERO, because no evidence can establish either yet.

### D. Denominator scopes: Houston murder victims, May 2021
`expected/D-denominator-scopes.json`
- May 2021: 51 murder victims, 44 men and 7 women. 2021: 473.
- Within the month (the usual request): women 7/51 = 13.7%, men 44/51 = 86.3%.
- Within the period: what a whole-result percentage computes on a 2021 monthly table: women 7/473 = 1.5%,
  men 44/473 = 9.3%.
- Within each race: Black women 4/35 = 11.4%, White women 3/15 = 20.0%, the one Pacific Islander victim 1/1 male.
- The plan must name the partition. One scope must never be substituted for another.

### R. Rates and partial years: Houston murder victims per 100,000
`expected/R-houston-murder-rate-partial-year.json`
- 2019: 281 victims, 12 months, population 2,307,560 (FBI agency population for 2019): 12.18.
- 2018: 171 victims in the 7 months June-December. The annual rate is unavailable: the agency's year is
  incomplete, and numerator and denominator use the same agency-period eligibility (D6). The answer returns the
  count and the months, and says why the rate is missing. It never divides 7 months of victims by a full year's
  population.
- Under D8 the population is the primary agency's covered population. Houston PD is the primary agency for the
  city of Houston, so the FBI agency population is the right denominator.

## Open questions for review

1. N3: should "car theft" ever narrow to automobiles (description 03), or always mean motor vehicle theft with the
   label shown? Recorded as motor vehicle theft.
2. N1: should combinations absent from a month be shown as 0 or omitted? Both are allowed; recomputing over the
   shown cells is not.
3. M2 and M7: offender counts. Should an all-unknown offender segment (age 00, sex U) count as one offender of
   unknown demographics (M2: yes), while segment 00 counts as no offender information (M7: 0)? This follows the
   NIBRS rule that offender 00 means nothing is known.
