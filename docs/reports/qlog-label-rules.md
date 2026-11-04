# Query-log label rules

The scorecard (`docs/reports/qlog-scorecard.md`) labels every logged question with one expected outcome. These are the rules that draft the labels, tried in order; the first that matches decides. The code is `scripts/draft-qlog-labels.py`.

The rules read only two things:
- the question's own words;
- the agency list, used as a gazetteer.

They never read the engine's output. Every label is a **draft** until it is reviewed. A label that waits on a decision of Jeff's is **disputed**, and is set aside from the scorecard (and its gate) until he decides; the open decisions are listed under Disputed below.

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

Frequency and trend words don't count. "Per year", "monthly", "by year", "over time", "trends" and "history" say how to show a period, not which one.

**Shootings** with no "fatal", "non-fatal", "killed" or "homicide" ask which (D14). **"New York" alone**, not "New York City", "NYC" or "New York state", asks city or state (P26).

## First questions

| Rule | When | Expected |
|---|---|---|
| R01 | A greeting, a test or one word | not scored (excluded) |
| R03 | Not about crime data; court outcomes or corrections; a "why"; a prediction; advice or a safety judgment | decline, with the plain limit |
| R05 | A place outside the U.S. | decline: U.S. agencies only |
| R04 | Below an agency: a neighborhood, ZIP code, census tract, block, address, precinct, beat or ward | decline: down to the agency, not below it |
| R06 | A definition or method question | answer in text: **disputed** (D1) |
| R07 | A lookup: coverage, codes, a list of agencies | answer (a lookup); a gap today |
| R08 | No crime, and either no place or a lead-in that points back ("now detroit", "how about the national average") | clarify: the whole question |
| R09 / R09b / R10 / R11 / R13 | A part is missing: the crime, or which kind of crime (D09); the place (P12); which of several same-named places (none five times the next in population); the period (P06) | clarify. `about` is the first missing part in D31's order; `about_any` lists every missing part. Asking about any of them is right, because D31 asks one part at a time. |
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
7. A Part I crime by year: Historical (Crime Index), from any tab (P75–P79). A plain murder count asked in the Homicide Reports tab is **disputed** (D3).
8. Otherwise the tab's own source.

People are read as people only when named that way: "Black victims", "females", "Asians". "White Plains" is a place.

## Follow-ups

| Rule | When | Expected |
|---|---|---|
| F1 | It stands alone: a crime and a place, and no lead-in pointing back | labelled as a first question (F1+Rnn) |
| F2 | Presentation only (a chart, table or export), eight words or fewer | answer: the same data shown another way |
| F3 | The earlier question's label is answer | answer: the earlier question changed as asked, from its source |
| F4 | The earlier question's label is clarify | answer: the earlier question with the part supplied. **Disputed** (D4). |
| F5 | The earlier question's label is decline or excluded | clarify: the whole question |

## Disputed (for Jeff)

- **D1. Definition and method questions** ("what does clearance rate mean"): answer in text, or decline?
- **D2.** None open: a set of places with no scope asks the place (P12).
- **D3. A plain murder count asked in the Homicide Reports tab** ("Florida murders per year"): from Crime Index, the Part I figure the engine gives today, or from SHR?
- **D5. A series with no years named** ("Houston murders per year", "murder trend in Texas"). P06 says ask which period. The engine shows every year it has. Which is right? This is the largest group by far.
- **D4. Replies to the old app's clarifying questions.** The old app asked its own questions, which aren't the engine's. A typed reply ("Pittsburgh PA", "nationwide total") may answer something the engine never asked. Score these as follow-ups, or leave them out?

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
