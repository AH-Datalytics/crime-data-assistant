# Heavy national questions: declined for now, to be made answerable

Questions the new engine declines up front (policy row P122) because the national statements over several years take minutes to count
(the scorecard's time limits are 120 s, then 360 s). The speed work starts from this list.

## The decision (Jeff, 2026-11-16)
- Decline, with the approved sentence and no pointer to another tool: "We should decline and try to make it work later."
- **Offenders are not arrestees.** The answer to "annual counts of offenders by age" is offenders by age group from NIBRS, from the first
  year the release holds to the latest, not arrests.
- **Target:** answer offenders by age group from the earliest NIBRS year (2017) to the latest, once the national statements are fast
  enough. The period clamps to the release's first year (2017) and the answer says so.
- One year, one state, one agency or one named crime still answer today.

## Why they are heavy (runner profile, 2026-11-16, DuckDB 1.5.6, 4 GB, 4 threads)
- The national plan for property crime by offender age over 2017-2025 reads about 96 million offender rows and 105 million offense rows,
  keeps about 40 million units, and aggregates them (a DISTINCT, then a COUNT(DISTINCT) over the same rows): about 300 s standalone on the
  runner (55-75 s on a laptop), then a second statement of the same size for the sums.
- Tried and not the lever (identical rows, laptop): COUNT(DISTINCT hash) 59 s vs 55 s; no DISTINCT in the unit scan 48 s; a sparse
  coverage/sums formulation about 1.3x. The unit set itself is the cost. Ideas not yet tried: a precomputed per-agency-month-by-category
  summary in the release; per-year statements merged afterwards; computing coverage once and sharing it.

## The list
Filled from the runner's full run on the PR that adds the guard: (a) logged questions answered by the new decline, and (b) logged questions
whose run on dev executed a statement over 100,000 characters or over 60 s.

| id | question | tab | why heavy | outcome now |
|---|---|---|---|---|
| QL-shr-349398af53 | annual counts of offenders by age from 1986 through 2025 | nibrs | national property-crime offenders by age, 2017-2025: two statements of about 900 KB, about 300 s each standalone | before: clarify "which place" after about 8.7 minutes (a timeout error in the run); now: the same clarify in under a second |
