# Plan-language reachability over the replay inventory

How much of the 605 NIBRS questions the new engine can reach through today's reader, before any SQL exists.
`scripts/nibrs-plan-reachability.ts` runs, offline, on every question:
1. today's reader (`accountNibrsRequest` + `matchNibrsType`);
2. the adapter (`lib/nibrs-plan/from-spec.ts`), which turns the typed spec and its request ledger into a plan with
   every part bound;
3. every validation the plan language defines: schema, structure, NIBRSAI's draft semantic layer
   (`lib/nibrs-plan/draft-layer.ts`), request accounting by value, and release resolution (release through 2026-10,
   request date 2026-10-28).

Places resolve through a stand-in map (`places.json`: the largest City-type agency of each city named). At run time the
route's resolver supplies the ORIs. Files: `results.json` (one row per question), `summary.md` (counts).

**What this measures, and what it does not.** "Structurally valid" means the plan passes every rule: it reads every
part of the question, uses units and dimensions the layer allows, and resolves against the release. It does not prove
that today's reader read the question correctly, and no plan has been compiled or its answer checked (phase 5). One
misreading upstream is known: replay 10617, "vehicle burglaries with a firearm stolen per month", is read by today's
matcher as a firearm used plus some property stolen, not as a stolen firearm, and its plan is structurally valid.

## Results

| Category | All | Unmatched | What it means |
|---|---|---|---|
| plan_structurally_valid | 246 | 160 | today's reader produced a spec, and its plan passes every validation |
| no_typed_reading | 106 | 34 | today's typed reader has no reading (other routes, or nothing) |
| no_typed_reading_follow_up | 81 | 70 | the same, for a follow-up that needs its conversation |
| decline_reader_vocabulary_gap | 53 | 34 | today's reader does not understand a word ("historical", "where a", "related to") |
| decline_cohort_supported_by_plan | 32 | 22 | "for consistent reporters": a cohort the plan language expresses (`same_agencies`) |
| decline_table_limit_removed_by_plan_language | 31 | 9 | declined for a limit of today's summary tables that plans do not have (a monthly breakdown, a share per year, a ranking of a subset ...) |
| decline_peer_selection_not_in_plan_v1 | 16 | 7 | "agencies of similar size": peer selection is not in plan language v1 |
| decline_unresolved_place_or_period | 11 | 3 | a place or period today's reader could not resolve |
| decline_not_recorded_in_nibrs | 9 | 7 | a concept NIBRS does not record |
| spec_unmapped | 6 | 6 | a spec the adapter refuses by design: an unresolved place (Omaha, Montgomery County, MD), or a mixed-unit composite broken down by a person attribute |
| decline_reader_could_not_combine_parts | 6 | 5 | the reader read a word as a stray part ("state") or split a range into two periods |
| clarify | 3 | 0 | today's reader asks |
| decline_explanation_requested | 3 | 0 | a request for causes |
| plan_invalid | 2 | 1 | refused: a clearance rate stated in victims, and a breakdown that drops "rate" |

Of the 160 unmatched questions with a structurally valid plan, at the time 114 were answered deterministically, 33 by
model SQL (which no longer runs), 10 declined, 2 failed and 1 found no rows. So 46 are questions today's site does not
answer that the bridge reaches structurally, subject to the fidelity audit above. A further 31 unmatched questions
(9 + 22) were declined for limits the plan language removes. Most of the rest (34 + 70 + 34 + 5) need a reader that
fills plans directly, not a new engine.

## Findings

1. **Today's typed matcher drops "rate" from a breakdown.** "show the shoplifting rate since 2010 by race of offender"
   becomes a count breakdown, and the plan's request accounting refuses it (A1). "please show the violent crime rate
   by race" is refused earlier by the adapter (a mixed-unit composite has no single person to break down). The live
   route declines both (no per-capita rate by race), so no wrong answer was delivered.
2. **"How many rapes were cleared" is read without "cleared".** The typed spec does not carry the clearance part. The
   adapter reads it from the ledger, as the cleared offenses, and the accounting accepts a cleared-offense measure only
   when the question asks about clearances.
3. **Two named-case wordings are declined by today's reader:** "car thefts in Baltimore by month from January 2022
   to June 2026" (Baltimore unresolved) and "thefts from motor vehicles in Memphis in 2024 where a firearm was stolen"
   ("where a" not understood). The plans exist (correctness set N2, N3); the reader is the gap.
4. **A year in progress** ("Allentown murder rate 2026") ran past the release's last month and was refused by R1. The
   plan language now answers it through the release's last month: resolution returns the clipped period and records
   `clippedTo`, as today's site answers a partial year. A compared period must lie entirely inside the release (R2).

## Fidelity choices the adapter makes (and differences from today's SQL)

- Clearance breakdowns count every offense, with "not cleared" as a category; "by exception by type" narrows to the
  exceptional clearances. As today.
- "Last year" is the calendar year before the request date (`previous_calendar_year`), as today's reader reads it.
- DUI and other Group B offenses are Group B arrests, placed in time by arrest date.
- Age bins are today's groups. The infant codes (NN, NB, BB) stay their own categories instead of falling into
  "Under 18": an intentional difference that follows the plan language.

## The draft semantic layer

`draft-layer.ts` stands in for the shared layer until `nibrs-model/semantic/` exists. Its links carry the full join keys
(data year, ORI and incident number, plus the entity keys), and a victim reaches offense attributes only through its
own connected offenses (an explicit route), never through every offense of its incident. Its measure predicates are
null: it checks structure, units, reachability, cardinality and codes, not counts.
