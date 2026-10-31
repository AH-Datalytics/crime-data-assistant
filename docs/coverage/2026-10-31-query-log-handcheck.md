# Query-log coverage: hand check of the gaps and of planned demand (2026-10-31)

A follow-up to the coverage review (`2026-10-30-query-log-coverage.md`, PR #79). Jeff asked for it because the rules label about 86% of rows correctly, which is "okay but not great". Every verdict below comes from reading the question, not from another rule pass. Codex reviewed it once (`docs/reviews/2026-10-31-query-log-handcheck-codex/`); its corrections are applied here.

Two checks:
1. **All 122 gap rows:** is each a real gap? If not, where does it belong (built, planned with its increment or source step, clarify, decline), and why?
2. **A random sample of 100 planned rows** (`random.Random(20261031).sample`, over the 3,177 rows whose status starts with P, in classification-file order): how many are really gaps, and how many are placed wrongly in other ways?

File: `2026-10-31-query-log-handcheck.csv`. Columns: check, id, question, shape, place, source, rule_status, hand_verdict, hand_status, reason.
- The questions are as redacted in the classification CSV.
- Two first names that add nothing to a question are also replaced with `[name]`: a greeting, and a possible name before "crime in Crofton".
- `handcheck.py` wrote the file; it holds the verdicts as data.

**Compound questions:** a question counts as a gap if any part of it is a gap. Its reason names the other parts. For example, a follow-up that also asks for a definition stays a gap, and the reason notes the follow-up.

## 1. The 122 gaps: 100 confirmed, 22 moved

**Corrected gap count: 100.**

| What is missing | Gaps |
|---|---|
| Lookups: coverage, codes, the agency directory | 28 |
| A breakdown, comparison or series for a state (increment 5 built sums only) | 22 |
| A set of cities across states, picked by size, rank or threshold | 17 |
| Definitions and methods (a text answer); two of them asked with a follow-up | 12 |
| Agencies reporting in every year (a panel) across states | 11 |
| A breakdown or ranking for the nation, or a ranking of states | 10 |
| **All** | **100** |

The panel row is new. Eleven questions ask for "consistent reporters" or "agencies that reported in all of those years". The rules had counted these as national breakdowns or as lookups.

**Moved, 22:**

| Moved to | Rows | Why |
|---|---|---|
| Decline | 7 | Not recorded: misdemeanors, calls for service. A national estimate (P61). A model, statistical judgments, a list of individual incidents. |
| Planned: Historical | 5 | Agency Part I questions the rules read as lookups or definitions ("what can you tell me about DC violent crime trends"; murder rates for Denver since 1980; an agency ranking by murder rate). |
| Planned: increment 7b | 4 | Follow-ups ("those years", "the observed trend", edits to the previous table). |
| Clarify | 3 | No place or period, though the capability is built. "PPD": which agency? "The old 11A definition": NIBRS forcible rape only, or Historical's legacy rape series? |
| Built (increment 6) | 1 | Chicago robberies cleared by arrest or exceptional means, by year. |
| Planned: county-wide area totals | 1 | A sum of St. Louis County's agencies (ruling of 2026-10-30). |
| Planned: increment 8 | 1 | Named cities by clearance type, which is a two-way breakdown. |

## 2. 100 planned rows: 9 are gaps, 18 more are misplaced

| Verdict | Rows | 95% interval (Wilson, sampling only) |
|---|---|---|
| Correctly placed | 73 | |
| Really a gap | 9 (one provisional) | 4.8% to 16.2% |
| Misplaced, but not a gap | 18 | |
| **All misplaced** | **27** | 19.3% to 36.4% |

**The 9 gaps:**
- national or statewide offender-age or offender-race breakdowns, 3 (increment 7 is for agencies);
- a region ("the southwest");
- a typical value for a whole state;
- a method question ("does the data classify gang homicides");
- an agency identifier lookup;
- agencies selected by type (tribal agencies). Sets of named agencies are planned with Historical; selecting agencies by type is in no plan.
- robbery by weapon for a state, **provisional**: a NIBRS state breakdown, with no local evidence that Historical's file carries the Return A weapon split. Without it, the count is 8 (4.1% to 15.0%).

**The 18 misplaced but not gaps:**
- already built, 2: one agency's aggravated assaults with a firearm; one agency's murder clearances by type;
- decline, 5:
  - "Who built you?";
  - population by race;
  - "what factors correlate";
  - rates for generational cohorts (D03; offer homicides by offender age);
  - a count of homicide offenders (SHR records one offender per incident; offer homicides by the primary offender's race and age);
- clarify, 3: "nonfatal shootings" and "shootings" are not recorded as such; Crofton, MD is not an agency;
- follow-ups the rules read as new questions, 3;
- the wrong planned source or step, 5:
  - justifiable homicide is SHR's;
  - a monthly moving average is Current Trends';
  - an agency's murder rate against the nation is Historical's, not SHR's;
  - a standalone stolen-value trend is increment 9's, not 7b's;
  - Oakland murders by month in 1996 are SHR's (monthly from 1976), not a gap.

"Murders where the victim was pushed out a window" stays with SHR: its weapon code 55 is "Pushed or Thrown Out Window" (`lib/nibrs-codes.ts`).

## What this means for the coverage numbers

- **Confirmed gaps:** 100 of the 122 labeled.
- **Hidden gaps in the planned rows:** an estimated 9% of all planned rows, about 286 of 3,177 (sampling interval 153 to 516; 254 if the provisional row is not a gap).
  - Labeled gaps plus this estimate come to about 390, which suggests substantially more than the 122 labeled.
  - This counts the planned rows only. The built and clarify rows were not sampled.
- **Hidden gaps by kind:** mostly statistics for states and the nation beyond sums. The confirmed gaps' largest groups are lookups (28), then state statistics (22), then sets of cities (17).
- **Planned demand:** about one planned row in four is placed wrongly.
  - This sample does not say how the errors split between sources. They can pile up in one source or offset across sources.
  - So the per-source planned counts are a rough guide only, not a figure with a known margin.
- **Built:** misplacement also runs toward built. Two planned rows and one gap row are already built.

The intervals describe sampling uncertainty only, not mistakes in the hand verdicts themselves.

Not changed: the classification CSV and the coverage doc's table. The rule labels stay as they are, and this file records the hand verdicts beside them.
