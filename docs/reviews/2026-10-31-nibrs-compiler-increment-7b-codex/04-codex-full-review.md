# Codex review 04: increment 7b full review

Reviewed 2026-10-31, read-only, no network, of `origin/dev...HEAD` (10e1782) plus the working tree, and the scored run against nibrs-model main e0ac35c (V1-V155). Verdict: **REVISE** (four P1, two P2). Applied as below.

**The coordinator's three rules:**
1. **Replaceable rewriter: PASS.** `FollowUpRewriter` (follow-up.ts) is the interface. `deterministicRewriter` implements it, and `shadowFollowUp` accepts any implementation.
2. **Unplaceable follow-ups become a clarify: FAIL**, because of findings 1 and 2. Both are fixed below.
3. **Coverage report: PASS as a disclosed synthetic-context method, not measured session coverage.** Applied: the script and the PR now use Codex's wording. The number is how many follow-ups were placed under at least one of three synthetic previous questions. It measures recognition, not real-session correctness or answer coverage.

**Findings:**

1. **P1: keyword matches silently dropped the rest of the follow-up.** "make it a bar chart for 2023" kept 2024, and "make it quarterly for Nashville in 2023" kept Memphis 2024. Both were returned as certain.
   - Applied: every form must take the whole follow-up. This covers presentation (a closed list of chart, label, sort and color forms), the P72 columns, quarters and the P65 pairing. Otherwise the rewriter asks.
   - The place and period target must be nothing but a place and a year.
   - The crime swap must change nothing else.
   - A "new" question needs its own period and no "instead".
2. **P1: an added period became a replacement.** "add 2023" gave only 2023, and "same for 2023" after "in January 2024" gave "in January 2024 in 2023".
   - Applied: "add 2023" to a single whole year gives "in 2023 and 2024".
   - The rewriter asks about any period that is not one whole year: months, a range, a set, or relative words.
   - A question with no period still takes the year.
3. **P1: quarters widened the period asked.** "by quarter in 2021 and 2024" delivered sixteen quarters.
   - Applied: quarters decline a set of years, and a period that starts or ends inside a quarter.
4. **P1: a second supporting column replaced the first.**
   - Applied: the reader records "both", and the shadow declines it. The rewriter asks when the previous question already has a column.
5. **P2: rewrite equivalence ignored the pre-pass flags.** Monthly and quarterly questions compared as the same, and so did a rate with and without its population column. A missing rewrite was accepted.
   - Applied: the reading key now includes the quarter and column flags.
   - An expected rewrite that was asked about instead is now a material diff.
6. **P2: the population check could certify a wrong number.**
   - Applied: a rate file's cells carry its population. The Population column is compared against that population, with the values.
   - The statement check now needs the number in the rate's population sentence, not anywhere in the text.
   - The test reproduces Codex's case: population 15 against 400,000 is a mismatch.

The coverage recount after the fixes, on 693 logged follow-ups, places 123 (17.7%): 115 rewrites, 5 presentation, 3 new. It asks about 570. Before the fixes it placed 177. The 54 that are now asked about were partial matches.

## Re-check (second pass): REVISE, 2 P1 and 2 P2 remained

Codex confirmed that findings 3, 5 and 6 are fixed. Gaps remained in 1, 2 and 4. Applied:

1. **P1: an additive lead-in was stripped.** "also 2023" answered only 2023.
   - Applied: "and", "also" and "plus" now read as "add ...". Only a place or a year completes that; anything else is asked about.
   - A comparative or additive opening is never a complete new question. "compare shoplifting in Nashville in 2023" is now asked about.
2. **P1: the color form accepted any word.** "make the lines quarterly" was treated as presentation.
   - Applied: the form now accepts named colors only.
3. **P2: quarterly stacked on another grain.** "by year" plus "quarterly" gave "by year by quarter".
   - Applied: "by month" or "by year" is replaced by "by quarter". Any other grain is asked about.
4. **P2: the existing-column guard needed a comma.**
   - Applied: the guard now uses the reader's column flag, whatever the punctuation.

After these fixes, the recount places 121 of 693 (17.5%): 113 rewrites, 5 presentation, 3 new. It asks about 572. The scored run is unchanged: 21 of the 23 scored 7b cases are correct, 2 are unverified, and no other case changed.

## Third pass: REVISE, 1 P1 and 1 P2 remained

Codex confirmed all four second-pass fixes. Applied:

1. **P1: a comparison joined a combined total.** "compare to Knoxville" after "Memphis and Nashville combined" combined all three.
   - Applied: adding or comparing a place to a combined group is asked about. The question is whether the place joins the total or is shown beside it.
2. **P2: a follow-up that pointed back passed as a complete new question.** This happened with repeated lead-ins ("please now compare ...") or a word pointing back at the previous answer ("... alongside that").
   - Applied: lead-ins are stripped in a loop.
   - A "new" question is now rejected when it contains a word that points back: that, this, it, alongside, compare, versus, against, instead, also, too, as well and similar.

## Fourth pass: REVISE, 1 P1 and 1 P2 remained

Codex confirmed both third-pass fixes. Applied:

1. **P1: an option's question contradicted its label.** "show all three separately" kept "combined".
   - Applied: each option's question now does exactly what its label says.
   - "Only" and "separately" drop "combined". A combined group gets a third option: "Add X to the combined total".
2. **P2: a follow-up with unread words passed as a complete new question.** Examples: "... using the same breakdown", "please include ...".
   - Applied: a "new" question is read without its lead-ins.
   - The reader must recognize every word: any `unrecognized` part means the follow-up is asked about.
   - This is a structural rule, replacing an ever-longer word list.

## Fifth pass: REVISE, 1 P2 remained

Codex confirmed both fourth-pass fixes. Applied:

- **P2: back-references hidden in filler or context passed as a new question.** The reader files "same" as filler, and "side by side" and "for comparison" as context.
  - Applied: the rule is now an allowlist. Besides what the reader recognizes, a "new" question may hold only:
    - an opener;
    - punctuation;
    - a plain filler word: in, of, were, was, there, the, a, an, is, are, did, during, total.
  - Any other part means the follow-up is asked about.

## Sixth pass: REVISE, 2 P2 remained

Codex confirmed the fifth-pass fix. Applied:

1. **P2: a clarify option dropped the year asked.** After several places, "what about Knoxville in 2023?" offered options that kept 2024.
   - Applied: a new place with a new year after several places is asked about plainly, with no ready-made options.
2. **P2: a place with other words was placed.** "combined with Knoxville" became "... and with Knoxville", shown separately.
   - Applied: the new place must be exactly the place the reader found. Anything else is asked about.

## Seventh pass: REVISE, 1 P2, then closed

Codex confirmed both sixth-pass fixes and found no other P1 or P2.

- **P2: an ambiguous sex swap was guessed.** After "Female murder victims with female offenders ...", "male" changed the victims' sex.
  - Applied: when the previous question has more than one sex word, the follow-up is asked about. A test covers it.

**Closed at the coordinator's direction.** The deterministic rewriter is the shadow baseline; the live path is meant to take a model-backed rewriter behind the same interface. The passes stop here unless a guess reaches an answer.

Known limits, recorded for the PR (not fixed):
- The rewriter recognizes few follow-up forms; the rest clarify, which is the safe default.
- Clarifications with no ready-made options ask the user to type the full question.
- The coverage count uses synthetic previous questions, so it measures recognition, not real-session correctness.

Final recount on the merged code: 103 of 693 logged follow-ups placed (14.9%): 98 rewrites, 5 presentation, 0 new. 590 asked about. The scored run is unchanged: 21 of the 23 scored 7b cases are correct, 2 are unverified, and no other case changed.
