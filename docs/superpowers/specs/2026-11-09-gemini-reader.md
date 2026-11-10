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

The plan's step 2 ("Gemini turns the question into the plan language") is carried out in its narrowest form, after
Codex's review of a first design (a full reading checked by quoted words) showed a reading could quote the question's
real words and still misread them, and quoted words could hide a condition. Here Gemini only proposes what the words
the pattern reader couldn't read mean; every other word stays the user's own and is read by the pattern reader.

### When Gemini is called
- The engine doesn't answer (a decline or a clarify);
- a decline is the reader's own ("I didn't understand", a place not found), never a policy decision (forecast, court
  outcome, not recorded, unsupported, outside the data), and the question carries no policy flag;
- the pattern reader left some of the question's words unread (for a follow-up: the follow-up's words).
A question read in full is never Gemini's, whatever its outcome. About 1,750 logged questions qualify.

### What Gemini returns
For each unread span it can map: the span (the question's exact words) and what it means in the plan language: a
measure (one of the reader's measure ids), a place (as named), a period (years written in the span), a breakdown
(whose only when the span names it), a statistic (rate, percent change, share) or a unit. And "unhandled": every unread
condition or request it couldn't map. Gemini never returns a number to show.

### How the engine validates it
- Nothing unhandled; each span found once in the question; each value from the vocabulary and grounded in its span
  (a year written in it, a person word for whose, a state named in it, never from Gemini's knowledge).
- The span is replaced by the reader's own words for the value, and the rewritten question must:
  - read in full (nothing unread);
  - keep every part the original read, unchanged (one refinement allowed: "by race" with "of the killers" becomes by
    offender race), and every condition or setting the reader read ("unsolved" is a clearance setting);
  - gain only parts of the kinds the replacements declared.
- Then the engine answers the rewritten question by its normal path (a follow-up's rewritten follow-up by the normal
  follow-up path, with the previous question as state): places resolve to one agency, state or the nation or are asked
  about; periods outside the data decline; the answer's first line states the reading.
- Any refusal keeps today's outcome, with its reason counted.

### Step 1: the shadow run
- `scripts/fetch-gemini-readings.ts`: one request at a time; each attempt's worst case (every byte sent as an input
  token, plus the output cap and a 4,096-token thinking allowance) reserved before it is sent and released only when
  its usage comes back; a $15 maximum; one attempt plus at most one retry, counted before each is sent; the 10-question
  cost test enforced before the rest, which runs only if its projection (spend, unresolved reservations, average times
  the questions left) fits the budget; the cache outside the repo; the key never printed, logged or written.
- The scorecard runs offline from the cache (`--gemini-readings`); `--compare` against dev's run gives the fixes and
  breaks by bucket and the new wrong answers against dev; `--gemini-review` lists every new Gemini answer.
- The gate: 0 new wrong answers, judged after the listed answers are reviewed (each is unverified, so the scorecard
  alone can't show it is the question asked): the rewritten question against the user's words, then their numbers by
  the blind verification tool.
- The key: `GEMINI_API_KEY` in the runner's environment, typed in by Jeff.

### After the step 1 run (Jeff, 2026-11-09)
- Gemini fixes spelling and shorthand only, never one term for another. A measure replacement is accepted only when its
  span is the measure's own words, word for word: the word itself, its start ("agg") or a close misspelling
  ("murdered"). "Felony assaults" is never aggravated assaults, and "slayings" is never murders. The prompt is
  unchanged, so the cached readings stay valid; the validator refuses these replacements.
- Gang wording is declined for every source (P38). Gang involvement is loosely defined and inconsistently reported to
  the FBI, so a count would mislead. The engine no longer reads it as a circumstance filter, and the question is never
  sent to Gemini. The next step offered is the same question without the gang words, where they qualify a crime and
  the question answers; otherwise the usual example.
