# Gemini reader (plan 3, B+C): design and step 1

Approved by Jeff on 2026-11-08 ("ok, I'm down for trying it") as the coordinator gave it to him, below. Step 1 only: a
shadow run on the runner, scoring only. Steps 2 and 3 each need Jeff's go after he sees step 1's numbers.

## The plan as approved

1. The pattern reader tries first. If it reads the question, Gemini isn't called.
2. Otherwise Gemini Flash turns the question into the plan language: the measure, places, period, breakdowns, and
   statistic (count, rate or percent change).
3. The engine validates every field strictly:
   - the measure must exist for that source;
   - each place must resolve to exactly one agency, state, or the nation;
   - the period must be within the data;
   - the combination must be answerable.
4. Any validation failure means a clarifying question or a plain decline, never a guess.
5. If everything passes, the engine runs its normal SQL. The answer's first line states the reading, so a misreading is
   visible.

Follow-ups (C):
- The last reading is kept as state. "Same for Dallas" replaces the place; "as a rate" changes the statistic.
- Gemini proposes the change and the engine validates it the same way.
- This replaces today's rewrite-to-a-new-question path.

Safety:
- Gemini never produces numbers.
- An outage or the spending cap falls back to today's behavior.
- One validator serves all sources.
- The gate is 0 new wrong answers.

Cost:
- About a cent or less per call, with roughly 1-2 seconds of added latency on those questions only.
- The live cap stays at $2/day, unchanged.

Rollout:
1. Shadow run on the runner: all 3,939 logged questions, scoring only. It reports fixes and breaks by bucket, with a
   $15 hard cap, the 10-question cost test first, and one attempt plus at most one retry per question. Jeff types in the
   runner's key himself.
2. Turn it on at /redesign for questions the engine declines today. This needs Jeff's go after he sees the step 1 numbers.
3. Then follow-ups, also needing Jeff's go.

The shadow run scores both B and C, so Jeff sees both sets of numbers before steps 2 and 3.

Coordinator's answers (2026-11-09): B is only questions the pattern reader can't fully read (it would decline or
clarify today); a full deterministic reading always wins and Gemini isn't called; comparing Gemini on fully read
questions is not approved (an option to bring to Jeff, not part of step 1).

## Design

### When Gemini is called
A question is "not fully read" when the deterministic outcome is not an answer (a decline or a clarify) and the reader
left words of the question unread (an unrecognized or not-interpreted part). A question the reader read in full but
declined or asked about (a missing place, an ambiguous name, a crime the data doesn't record, a forecast) is not
Gemini's: no reading can fix it, and calling would only add a chance to answer what policy declines.

Follow-ups (C) are the same: a follow-up whose deterministic outcome is a decline or clarify, with its own words not
read, gets Gemini with the previous question as state.

### What Gemini returns
A reading in the plan language's terms, every field with the words of the question it comes from ("evidence"): the
measure (one of the reader's measure ids), the unit when the question names one (victims, offenses, offenders,
arrests), places (as named), the period (a year, a range, a list of years), breakdowns (a time grain, or a person's
attribute with whose: victim, offender, arrestee), the statistic (count, rate, percent change), and every condition or
word it could not put in a field ("unhandled"). For a follow-up, each field says whether it comes from the follow-up or
the previous question. Gemini never returns a number to show.

### How the engine validates it
- Grounding: each field's evidence must occur in the question (or, for a follow-up's state, in the previous question).
  A field without it is dropped, so a missing part stays missing and the engine asks about it, as today.
- Nothing unhandled: a reading with any unhandled condition is refused (an answer without the user's condition would be
  a wrong answer).
- Coverage: every content word of the question must fall inside some field's evidence or a short list of filler words
  ("show me", "how many", "data", ...). Uncovered words refuse the reading.
- The same reader decides the rest: the reading is written back as a canonical question in the reader's own grammar
  ("murders in Memphis, Tennessee in 2024 by offender race"), the deterministic reader reads it, and every part it
  reads must match the reading's field values exactly, with nothing unread. Measure, places (each resolving to one
  agency, state or the nation; several candidates ask which, as today), period (within the data), breakdown and
  statistic are then validated, routed and answered by the engine's normal path, its first line stating the reading.
- Any refusal keeps today's outcome (the decline or clarify), with the reason counted in the report.

### Step 1: the shadow run
- `scripts/fetch-gemini-readings.ts` calls Gemini for the questions that qualify, one at a time, with the same budget
  enforcement as the model rewriter's fetch (each attempt's worst case reserved before dispatch; spend kept across
  resumes; a response without usage stops the run), a $15 hard cap, one attempt plus at most one retry, and progress
  saved after each call. The cache holds question text, so it lives outside the repo.
- The 10-question cost test first: its cost per question, times the questions that qualify, must project under $15.
- The scorecard then runs offline from the cache (`--gemini-readings`), and `--compare` against dev's run gives the
  fixes and breaks by bucket. The gate: 0 new wrong answers.
- The key: `GEMINI_API_KEY` in the runner's environment, typed in by Jeff. It is never printed, logged or written.
