# Historical in the new engine: design note

**Status:** design only. Codex design check 01 (ACCEPT WITH CHANGES) is applied below. No build yet.

**Why now.** Jeff decided that all five sources join the new engine before launch. Historical agency-level is the most-asked of the four still missing, so it comes ahead of increment 8 (coordinator, 2026-11-01).

**The ruling this note follows.** Jeff: "Historical data strictly comes from the Crime Index", "as does current". Historical and Current Trends are the Crime Index's data, not FBI summary files.

**The earlier design this builds on:** docs/superpowers/specs/2026-10-28-engine-other-sources.md. Its G1–G8 changes to the plan language and its Historical section ("Historical means everything — crime, clearance & staffing", owner 2026-10-28) still stand; this note narrows them to a first increment.

## 1. What it compiles against

**The archived Crime Index snapshot, not the app's live Historical tables.** The snapshot is `20261030` (nibrs-model `manifests/crimeindex-archive.json`, RUNBOOK 4.1). It comes from crimeindex.org's public download, AH Datalytics' own product, and is archived to B2 by SHA-256.

| Dataset | File | Rows |
|---|---|---|
| historical_crime | historical_crime_1960-2025.csv (sha256 c8266ba7…) | 919,376: city 710,748, county 205,262, state 3,300, nation 66 |
| historical_clearances | historical_clearances_1960-2025.csv (sha256 9423d03a…) | 884,107: city 682,724, county 201,313, nation 66, and 4 rows with a blank type; no state rows |

**The files are not the same shape** (corrected, Codex 01.1):
- **Crime rows** have `name, type, uid, id, year, population, agencies`. Then, for violent, property and the seven Part I offenses: `*_total` (the count), `*_change` (the percent change from the year before) and `*_capita` (a rate per 100,000). For city and county rows, `id` is the agency's ORI.
- **Clearance rows** have `*_all_total` (offenses), `*_cleared_total` (clearances) and `*_cleared_rate` (a published percentage) for the same nine.
  - The nation's rows carry the published percentages **with blank counts**.
  - The four blank-type rows are listed in the build manifest, set aside, and never guessed into a place.

**The build.** A "Crime Index build", like the NIBRS canonical build:
- the two files are read from the archive, and their SHA-256 is checked against the manifest;
- they are written as typed tables (agency-year crime, agency-year clearances, state-year, nation-year), with a manifest that lists every row set aside and why;
- the release id names the snapshot (`crimeindex-20261030`), and the engine compiles against it read-only;
- the engine never reads the live app database.

The shadow already reads this snapshot's state and nation files for P53 (lib/nibrs-shadow/srs.ts, byte-pinned).

**Why not the live tables.** They come from other inputs and so would break Jeff's ruling:
- the agency tables (scripts/build_historical_core.py, which builds a throwaway database to prove the build) come from a 1930–2024 historical CSV, a separate populations file, an FBI Return A annual file for 2025, and agency consolidations and ORI remaps;
- `historical_state_national` is not built by that script at all; it is the app's existing table.

**Reconciliation with the live tables.** A report, run before any switchover, not before the build (corrected, Codex 01.5):
- It reads a pinned, hashed extract of the live tables, through 2025.
- It compares agency-years, state and nation values, and rates.
- It keeps **identity differences** (remaps, consolidations, agencies only one side has) apart from **value differences**, and **null** apart from **zero**.
- It lists the largest differences for Jeff.

Agreement isn't required for correctness: the snapshot is the source. The live app isn't touched.

## 2. What is in, and what is out

**In (first increment):**
- **Offenses.** Violent crime, property crime and the seven Part I offenses, as the file gives them. Sums are read, never re-added.
- **Places.** One agency (an ORI from the place resolver), several named agencies side by side, a state, the nation.
- **Periods.** Years 1960–2025: one year, a range by year, or two years compared. Months are declined plainly (P74).
- **Statistics:**
  - counts;
  - rates per 100,000, either the file's stored `*_capita` or calculated from the file's population (section 3 says which and when);
  - percent change between two years;
  - clearances where the file has counts, and the published clearance percentage where it has only that. A published percentage is shown as published, never averaged or turned into a count. There is no state clearance figure (P18).
- **Rankings.** A state's cities by count or rate for one year. Only city rows with a value and, for a rate, a population that year are ranked. Cities without them are named as left out. P08's 250,000 floor applies only when the question says "large" or "big" cities.

**Out:**
- **1930–1959.** The snapshot starts in 1960. Section 7, decision 2.
- **Agency staffing.** Historical includes staffing (owner, 2026-10-28), so it is part of Historical before launch, but it comes in the second increment, after crime and clearances. Section 7, decision 4.
- **Combining.** Combined totals across several agencies, every-month cohorts and a reporting cohort's "agencies counted" are out: the file has no month detail to build a cohort from. They are asked about or declined plainly, never guessed.
- **Arson, demographics, and anything not in these files.** Declined plainly, with the nearest answerable question.

## 3. Availability, reporting and rates

Corrected, Codex 01.2. The file says what Crime Index published, not how much an agency reported.

**Availability, not reporting.** The answer text says:
- **"As published by Crime Index"**, not "as the agency reported it".
- **A missing row or a blank cell** is "not available in this data", never zero, and never claimed to be "not reported".
- **A published zero** is shown as zero. It doesn't establish that the agency reported every month.

**Rates and P58.** P58 gives a rate only when every month of the period is known, and this file has no months. So a Historical rate needs a rule of its own, which is decision 1 in section 7. Proposed:
- a yearly rate is given only when the year's count is present and the file's population for that agency-year is present and above zero;
- the stored `*_capita` is shown when present;
- otherwise the rate is calculated from the same row's count and population, and the answer says it is calculated;
- with no population or a zero population, no rate is given, and the answer says why (P59 is unchanged).

**Agencies.** The state and nation rows' `agencies` field is shown only on request (P72). The file can't tell complete reporters from partial ones, so P61's reporting-cohort wording is not used for Historical.

**Source line.** Decision 3 in section 7.

## 4. Independent expected values (nibrs-model)

Corrected, Codex 01.4.

**(a) Published figures, a separate path.** crimeindex.org's page API serves the Historical Data Library page (https://crimeindex.org/historical):

```
GET https://crimeindex.org/api/db/explorer/historical/overview?topic=crime|clearances&stat=<offense>&geo=<ORI | state code | us>&year=<Y>
GET https://crimeindex.org/api/db/explorer/historical/table?topic=…&stat=…&geo=…&year=<Y>&type=year&sort=dsc&col=date&page=1&count=10&format=count
```

- It is public, with no credentials and never Neon.
- `geo` takes an ORI. Checked read-only on 2026-11-01: `geo=TNMPD0000&year=2023` gave Memphis violent 16,091, population 616,061, rate 2,611.9.
- It is a **separate delivery path from the export, not proven independent data**: it may be served from the same database. What it checks is that the build ingested and calculated faithfully what Crime Index publishes.
- Read `rate.stat`, `rate.population`, `rate.rate` and `change.latest` / `change.previous`, not `recent`, whose totals look rounded.
- **The sample.** About 200 agency-years, stratified by agency size, state and decade, plus every state and the nation for a few years, and clearances the same way.
- **Archiving.** Each response body is saved with its request, time and hash.
- **Two kinds of difference.** A difference from the snapshot is either a later source revision (the API changed after 20261030; recorded, and the snapshot stays the reference) or a build error (it blocks acceptance).

**(b) Internal consistency over the whole snapshot.** These are diagnostics, not independent truth:
- a rate equals the count divided by the population, × 100,000, within the file's rounding (a stated tolerance);
- a clearance percentage equals cleared / all only where both counts are present, and the published percentage is never recomputed;
- violent and property equal the sums of their offenses where all are present;
- a `*_change` matches two consecutive available years, with a base above zero;
- no ORI appears twice in a year.

An inconsistency inside the source is recorded and disclosed where it matters. An ingestion or calculation error blocks acceptance.

nibrs-model proposes the exact procedure (coordinator, 2026-11-01).

## 5. Plan language and the engine

Corrected, Codex 01.3. These are the extensions the earlier design names (2026-10-28-engine-other-sources.md); the first increment needs them:
- **G1 source.** Plans name `historical`, compiled against the Crime Index build by its own compiler.
- **G3 time basis `data_year`.** The only grain is the year. Month grains and periods are refused by the compiler and declined by the reader.
- **G4 units.** Aggregate units (`reported_count`), not NIBRS entities, so NIBRS unit rules don't reject or reinterpret a Historical plan.
- **G7 `published_value`.** State and nation values, stored rates and published clearance percentages are read as published, never summed over agencies or averaged.
  - A **calculated** rate is a separate statistic from a **stored** one, and the answer says which.
  - A change against a missing or zero base gives no change, with the reason, not a number.
- **G8 statements by source.** Historical's own statements ("as published by Crime Index", "a blank means not available in this data", "this rate is calculated from the file's count and population"). The NIBRS statements are never required for a Historical plan.
- **Unsupported in this increment.** Combined totals, cohorts, two-way groupings and months. The compiler refuses them with a reason kept in `detail`; the user reads one plain sentence (P74).
- **Shared with NIBRS:** the reader, the place resolver, plain wording (P74), delivery and the answer contract.
- **Labels.** Held-out cases come from the query log's Historical-tab questions (the coverage classification) and its real Historical follow-up turns. Codex reviews the labels first.

## 6. Current Trends (source only; its own design comes later)

Optional change Codex 01.7 is taken: the detail moves to its own design note.
- **Source.** The Crime Index `current_crime` export: archived snapshot `20261101`, monthly rows by agency, state and size group, 2025–2026.
  - It is paired with the "Final" panel the site is built from (`082026 - Final.csv`, 2017-01 to 2026-08), archived as a cross-path check. Its independence is not proven.
  - The known differences between the two are recorded in the manifest.
- **Not archived yet.** The manifest has no `current_clearances` snapshot; nibrs-model to add it.
- **Before its build, the design must settle:**
  - the sample's membership and consistent contributors;
  - matched year-to-date periods;
  - population rules;
  - the boundary between the 2025–2026 export and the 2017–2026 panel;
  - rolling rates under P58 and P59 (the earlier note's months-weighted rolling rates conflict with them).

## 7. Decisions for Jeff (proposed, not assumed)

1. **The rate rule for Historical.** A yearly rate is given when the year's count is present and the file's population is above zero. The stored rate is used when present, otherwise one is calculated and the answer says so. The file can't satisfy P58's every-month rule, so this replaces it for Historical.
2. **1930–1959.** Snapshot those years from crimeindex.org (nibrs-model), or start the engine at 1960.
3. **The source line.** Proposed: **"Source: Crime Index."** for Historical, the same as P63's Current Trends line. It replaces P63's "Source: FBI SRS." for Historical, and the P53 state and national answers change with it.
4. **Staffing timing.** It is in the second increment of Historical, before launch, unless Jeff wants it in the first.
5. **Switchover.** After the reconciliation report, Historical questions are routed to the engine at launch, and the live tables stay as they are for the live site until it is retired. Does Jeff want that, or the live tables physically replaced?
