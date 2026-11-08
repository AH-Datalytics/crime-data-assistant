# Query-log label rules

The scorecard (`docs/reports/qlog-scorecard.md`) labels every logged question with one expected outcome. These are the rules that draft the labels, tried in order; the first that matches decides. The code is `scripts/draft-qlog-labels.py`.

The rules read only two things:
- the question's own words;
- the agency list, used as a gazetteer.

They never read the engine's output. Every label is a **draft** until it is reviewed. A label that waits on a decision of Jeff's is **disputed** and set aside from the scorecard and its gate until he decides. None is open now: his decisions of 2026-11-04 are below.

## The unit

**Questions.** There is one label per distinct question per tab. The same words, ignoring case, spacing and end punctuation, count once. The label records how many times the question was asked (`times`) and holds the question as written (Jeff 2026-11-04).

**First questions and follow-ups.** A first question is the first row of each session in each tab (coordinator 2026-11-04). Each later row in that session and tab is labelled as a pair, with the row before it (`previous`).

**Left out:**
- rows written by the test scripts;
- rows with no question;
- rows outside the five tabs.

## Reading a question

**Spelling.** Common misspellings of crime words ("homocide", "assult") are corrected before the rules run. So is a place name after "in", "for", "of" or "at" that is close to a gazetteer name with the same number of words: difflib ratio 0.85 or more, five letters or more ("new orlens", "wilimington").

**A place:**
- an agency name or alias from the gazetteer: a city or county of 25,000+ people, or any name of two or more words;
- a state name, or a postal code (capitals, or lowercase after a comma or a place name: "richmond va");
- a region, or a national word ("nationally", "the U.S.", "by state");
- a common short name: NYC, LA, DC, NOPD, SFPD and the like.

**A set of places** ("the cities with the most murders", "top 10 cities") with no state or nation named is still missing its scope. The place is asked (P12).

**A crime:**
- any offense word, an arrest or clearance, or a person in it (victim, offender);
- staffing words (officers, sworn);
- drug words.

The bare word "crime", or "dangerous" or "safest", with no kind of crime named, asks violent, property or both (D09). The Hate Crime tab is exempt.

**A period:** only a stated period counts (P06). That means:
- a year, a decade ("the 1950s") or a span;
- "since …", "as far back as …", "as many years as possible", "all available years";
- "this year", "last year", "YTD", "so far this year";
- "last five years", "past decade", "rolling 12 months", "latest year".

Frequency and trend words don't name a period. But a trend or a series ("per year", "monthly", "over time", "trends", "history") with no years named isn't missing one: it answers with every year the source has (D5).

**Shootings** with no "fatal", "non-fatal", "killed" or "homicide" ask which (D14). **"New York" alone**, not "New York City", "NYC" or "New York state", asks city or state (P26).

## First questions

| Rule | When | Expected |
|---|---|---|
| R01 | A greeting, a test or one word | not scored (excluded) |
| R03 | Not about crime data; court outcomes or corrections; a "why"; a prediction; advice or a safety judgment | decline, with the plain limit |
| R15 | A decided limit: a state clearance rate (P18); a rate for a group of people rather than a place (D03); calls for service (P47) | decline, with the limit |
| R05 | A place outside the U.S. | decline: U.S. agencies only |
| R04 | Below an agency: a neighborhood, ZIP code, census tract, block, address, precinct, beat or ward | decline: down to the agency, not below it |
| R06 | A definition or method question | answer: the FBI's definition (D1) |
| R07 | A lookup: coverage, codes, a list of agencies | answer (a lookup); a gap today |
| R08 | No crime, and either no place or a lead-in that points back ("now detroit", "how about the national average") | clarify: the whole question |
| R09 / R09b / R10 / R11 / R13 | A part is missing: the crime, or which kind of crime (D09); the place (P12); which of several same-named places (the app's rule: two of 100,000+ people, or the largest under twice the next); the period (P06) | clarify. `about` is the first missing part in D31's order; `about_any` lists every missing part. Asking about any of them is right, because D31 asks one part at a time. |
| R12 | A year after 2026 | decline: no future figures |
| R14 | Otherwise | answer, from the source below |

## The source of an answer (R14)

1. Hate or bias words: Hate Crime.
2. A state's or the nation's murder by a Homicide Report detail (circumstance, relationship, weapon, a person's race, sex or age), with NIBRS not named: Homicide Reports (P53).
3. NIBRS named, or a NIBRS-only detail: NIBRS. That includes a single agency's murder detail (P53). The details:
   - offenders, or a person's race, sex or age;
   - location, property stolen, clearance type, arrests;
   - relationship, weapon, drug type;
   - Group B offenses, simple assault, fraud and the like;
   - carjacking, and theft from a vehicle.
4. Staffing (officers, sworn, police employees): Historical (Crime Index).
5. A Part I crime by month, year to date, rolling, a span ending in a named month, or within 2026 with no yearly series: Current Trends. NIBRS is also right (`source_any`) where Current Trends lacks the place.
6. A ranking or set of places for a Part I crime: Historical or NIBRS (`source_any`).
7. A Part I crime by year: Historical (Crime Index), from any tab (P75–P79). A plain murder count asked in the Homicide Reports tab is Historical's too (D3).
8. Otherwise the tab's own source.

People are read as people only when named that way: "Black victims", "females", "Asians". "White Plains" is a place.

## Follow-ups

| Rule | When | Expected |
|---|---|---|
| F1 | It stands alone: a crime and a place, and no lead-in pointing back | labelled as a first question (F1+Rnn) |
| F2 | Presentation only (a chart, table or export), eight words or fewer | answer: the same data shown another way |
| F3 | The earlier question's label is answer | answer: the earlier question changed as asked, from its source |
| F4 | The earlier question's label is clarify | left out (D4) |
| F5 | The earlier question's label is decline or excluded | clarify: the whole question |

## Jeff's decisions (2026-11-04)

- **D1. Definition and method questions** are answered with the FBI's own definitions, named as the FBI's (Jeff: "ideally we'd offer definitions from the FBI on every term we reference"). Rule R06.
- **D2.** None open: a set of places with no scope asks the place (P12).
- **D3. A plain murder count asked in the Homicide Reports tab** ("Florida murders per year") is answered from Historical (Jeff: "historical would be the right tab for Florida murders per year, not current data").
- **D4. Typed replies to the old app's own clarifying questions** are left out of the scorecard (Jeff: "leave out"). Rule F4.
- **D5. A trend or a series by year or month with no years named** answers with every year the source has (Jeff: "show every year we have"). P06 is amended to match: it is not a missing period.

## Scoring

`scripts/run-qlog-scorecard.ts` runs each question through the engine. A follow-up goes with the turn before it, through the engine's follow-up path. Each label lands in one bucket:

- **correct**
- **unverified**: an answer from the right source whose numbers aren't checked yet. It is never counted as correct.
- **wrong answer**: the hard gate, 0.
- **bad decline**
- **wrong clarify**
- **follow-up error**
- **error**

A clarify is correct when the engine asks about any missing part. A route to another source is unverified (that source answers or asks there). An answer from any source in `source_any` is the right source. A label asking for "the whole question" also accepts the engine's "try asking another way". A decline's reason isn't compared yet.

## Known limits

- Small towns with one-word names (under 25,000) aren't read as places unless misspelled close to a bigger name.
- "Which kind of crime" versus "violent or property" is read loosely.
- A decline's reason is drafted, not checked.
- Answers count as unverified until their numbers are checked against independent values.

## Label quality

**Rules alone.** Codex checked three random samples, each fixed before the next: 23% wrong, then 11%, then 15%. The rules reached about 85–90%.

**Second labeler** (Jeff: "Yes, run it"). Codex read every undisputed label against only the question, this doc and the decided policy, never the engine's output.
- It agreed with 3,182 of 3,944 and flagged 762 (19%), 17 of them as unclear.
- A hand check of 30 flags found about 26 corrections right. Most rested on decided policy the rules don't encode, such as P13, P18, P27, P28, P34, P40 and P70. Others caught rule bugs, such as "New Mexico" read as a foreign country.
- So the corrections replace the rules' labels: they are drafts, drafted by the second labeler. The 17 unclear labels are disputed. Agreed labels are **reviewed**.
- Each verdict is in `scripts/fixtures/answer-eval/qlog-label-review.json`, applied by the drafter.

**After the review.** Codex checked a fresh uniform sample of 100 labels:
- 3 wrong and 3 unclear: **ACCEPT** (3%, under the 10% bar);
- reviewed labels: 3 of 82 wrong; corrected drafts: 0 of 18.
The three corrections are applied as review entries (codex-check-4).

**Changes after the review** (each a review entry in `qlog-label-review.json`, so the drafter keeps it):
- v18 (2026-11-07): QL-hist-81df62c2e3, "National clearance rates 1960 to 2024", is a clarify about the crime, not an answer. No crime is named, and D31/D09 ask which (PR #131's scorecard; agreed by the coordinator).
- v18 (2026-11-07): a bare "Los Angeles" asks which agency. Jeff: "Los Angeles should ask whether they mean the county sheriff or police department". The 31 labels for a bare "Los Angeles" (not "Los Angeles city", "City of Los Angeles", "LAPD", "Los Angeles County" or "sheriff") that expected an answer now expect the clarify "which Los Angeles", follow-ups too. Left out: "What agencies have the name Los Angeles in the historical_agency table?", which isn't about a place's figures.

**Still to do.** No label is confirmed: a reviewed label is two labelers agreeing, not a human check. A miss on the scorecard is a strong candidate, not yet a finding.
