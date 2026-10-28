# Plan-language reachability over the replay inventory

How much of the 605 NIBRS questions the new engine can reach through today's reader, before any SQL exists.
`scripts/nibrs-plan-reachability.ts` runs, offline, on every question:
1. today's reader (`accountNibrsRequest` + `matchNibrsType`);
2. the adapter (`lib/nibrs-plan/from-spec.ts`), which turns the typed spec and its request ledger into a plan with
   every part bound;
3. every validation the plan language defines: schema, structure, NIBRSAI's draft semantic layer
   (`lib/nibrs-plan/draft-layer.ts`), request accounting by value, and release resolution.

Places resolve through a stand-in map (`places.json`: the largest City-type agency of each city named). At run time the
route's resolver supplies the ORIs. Files: `results.json` (one row per question), `summary.md` (counts).

## Results

| Category | All | Unmatched | What it means |
|---|---|---|---|
| plan_valid | 246 | 160 | today's reader understands it, and the plan is valid |
| no_typed_reading | 106 | 34 | today's typed reader has no reading (other routes, or nothing) |
| no_typed_reading_follow_up | 81 | 70 | the same, for a follow-up that needs its conversation |
| decline_reader_vocabulary_gap | 53 | 34 | today's reader does not understand a word ("historical", "where a", "related to") |
| decline_table_limit_removed_by_plan_language | 37 | 14 | declined for a limit of today's summary tables that plans do not have (a monthly breakdown, a share per year, a ranking of a subset ...) |
| decline_cohort_supported_by_plan | 32 | 22 | "for consistent reporters": a cohort the plan language expresses (`same_agencies`) |
| decline_peer_selection_not_in_plan_v1 | 16 | 7 | "agencies of similar size": peer selection is not in plan language v1 |
| decline_unresolved_place_or_period | 11 | 3 | a place or period today's reader could not resolve |
| decline_not_recorded_in_nibrs | 9 | 7 | a concept NIBRS does not record |
| spec_unmapped | 6 | 6 | a typed spec the plan refuses by design: an unresolved place (Omaha, Montgomery County, MD), or a mixed-unit composite broken down by a person attribute |
| clarify | 3 | 0 | today's reader asks |
| decline_explanation_requested | 3 | 0 | a request for causes |
| plan_invalid | 2 | 1 | the plan is refused: a clearance rate counted in victims, and a breakdown that drops "rate" |

Of the 160 unmatched questions with a valid plan, at the time 114 were answered deterministically, 33 by model SQL
(which no longer runs), 10 declined, 2 failed and 1 found no rows. So the bridge alone reaches 46 questions that
today's site would not answer. A further 36 unmatched (14 + 22) were declined for limits the plan language removes.
Most of the rest (34 + 70 + 34) need a reader that fills plans directly, not a new engine.

These are reachability counts, not correctness: a valid plan has yet to be compiled and its answer checked (phase 5).

## Findings

1. **Today's typed matcher drops "rate" from breakdowns.** "show the shoplifting rate since 2010 by race of offender"
   and "please show the violent crime rate by race" become count breakdowns. The live route declines them earlier
   (no per-capita rate by race), so no wrong answer was delivered. The plan's request accounting refuses them on its
   own (A1).
2. **"How many rapes were cleared" is read without "cleared".** The typed spec does not carry the clearance part. The
   adapter reads it from the ledger, as the cleared offenses.
3. **Two named-case wordings are declined by today's reader:** "car thefts in Baltimore by month from January 2022
   to June 2026" (Baltimore unresolved) and "thefts from motor vehicles in Memphis in 2024 where a firearm was stolen"
   ("where a" not understood). The plans exist (correctness set N2, N3); the reader is the gap.
4. **A year in progress** ("Allentown murder rate 2026") ran past the release's last month and was refused by R1. The
   plan language now clips such a period to the release's last month and records the clip (`clippedTo`), as today's
   site answers a partial year.
