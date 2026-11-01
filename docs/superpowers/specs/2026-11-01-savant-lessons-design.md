# Two Savant lessons for the new engine: same agencies every year, everyday crime groups

**Status:** decided (Jeff, 2026-11-01, through the coordinator); recorded as policy rows P80-P84. Nothing built yet. Shadow engine only; no live route or answer changes. Codex design check 01 (REVISE, P2 only) is applied; see the review record.

**Sources:**
- Savant, read-only: `C:\Users\jeffm\nibrs-savant`, specifically `nibrs_savant/registry.py` `CRIME_TYPES`, `nibrs_savant/query.py` and `docs/superpowers/plans/2026-10-21-spotlight.md`.
- The engine on dev (1151a5f) and the policy rows P03, P31, P58, P60, P61, P62, D18 and D20.
- Each behavior below was checked by asking the shadow engine on the test5 build.

## Decisions (Jeff, 2026-11-01)

Jeff's answers, relayed by the coordinator:
1. **P80:** the label is **"Consistent Reporting Agencies"** (Savant's term), not "Same agencies every year". It is used on the button and in the answer's statement, with the plain explanation beside it (the agencies that reported every month of the period).
2. **P81:** yes. Each kind keeps its own row (P61, P58, P60), with one shared every-month test.
3. **P82:** domestic violence:
   - (a) any qualifying offender, each victim counted once;
   - (b) the crimes listed, with 09C out;
   - (c) robbery out;
   - (d) cohabitants in "family or household".
4. **P83:** yes. The gun-violence decline offers a "Gun crime in ..." button.
5. **P84:** yes. Car break-in answers say "Car break-ins are counted as theft from motor vehicles."

Domestic violence (P82) runs only after its held-out cases and nibrs-model's expected values are in (section 2).

## The decisions as asked

**Same agencies every year**
1. Should the state and national sums' button read **"Same agencies every year"** instead of today's "Show only agencies that reported every month"? The rule stays the same.
2. When multi-agency trends are built, should each follow its own policy row, reusing one shared test for "reported every month of the span"?
   - **State and national sums:** P61. Everything reported by default, with the fixed-set button.
   - **Several named agencies combined by year:** P58. A total, and a rate, only when every month is known for every agency, with the missing months named. No default that includes partial reporters.
   - **Rankings by change:** P60. Only agencies with every month of both periods are ranked, and those left out are named. No button to include partial reporters.

**Everyday crime groups**

3. **Domestic violence.** Should it be built as below? Each part needs a yes or a different choice:
   - **(a) Relationship.** The victim's relationship to *any* offender in the incident is intimate partner or family/household, and each victim is counted once.
     - The alternative is Savant's first-listed relationship only.
   - **(b) Crimes.** The person crimes that record a relationship: murder (09A), negligent manslaughter (09B), the sex offenses (11A–11D), the assaults (13A–13C), kidnapping (100), incest and statutory rape (36A, 36B), and human trafficking (64A, 64B).
     - **Justifiable homicide (09C) is left out:** counting it could count a domestic aggressor killed in self-defense as a victim.
   - **(c) Robbery.** Include it, counting robbery *victims* with a domestic relationship (an exception to D18's offense unit for robbery), or leave it out?
   - **(d) Cohabitants (CO, "non-intimate").** Include them, with the group named **"family or household"**, or as a third group of their own?
4. Should a **gun violence** question, which is declined per P31, offer a button for the same question as gun crime ("Gun crime in Memphis in 2024")? Today it offers the generic Denver example.
5. Should **car break-ins** add one plain line, "Car break-ins are counted as theft from motor vehicles"? Today the answer says "theft from motor vehicle offenses" with no line saying the phrase was read that way.

## 1. Same agencies every year

**Savant's rule:**
- A multi-agency trend can be limited to agencies that reported every (year, month) of the span.
- A month counts only if the agency has crime records in it (`query.py`).

**The engine today (P03, P61, P62):**
- **State and national sums:**
  - The default counts every agency that reported in each year, as the FBI does.
  - The answer says plainly that participation changed, and how many agencies and what share of residents are counted each year.
  - A button gives **one fixed set** of agencies that reported every month of the whole span, with a header in every year (`state-sum.ts`, `everySet`).
  - Example (Tennessee carjackings by year, 2021–2024): "the button shows one fixed set of 261 agencies that reported every month of 2021 to 2024."
- **What counts as reported: close to Savant's, but not the same.** The engine counts a month if the agency reported any crime that month (`VALUE`) or **filed an explicit zero report** (`REPORTED_ZERO`, P51). Savant counts only months with crime records, so a zero-report month is missing there and reported here. The engine's rule is kept: an explicit zero report is evidence the agency reported. A month with neither is `UNKNOWN` and fails the every-month test. An unknown month adds nothing to the default sum and is never a zero.
- **Single agencies:** already held to every month known (P58 for rates). Gaps are named, not filled.

**What is left:**
- **The button label** (decision 1). P03 promised "agencies that reported in every year" and P61 "every month". Savant's "same agencies every year" says the purpose: comparing like with like across years.
- **Multi-agency trends not built yet** (decision 2):
  - "Shoplifting in Houston and Dallas combined by year from 2021 to 2024" declines ("several agencies by year").
  - "Which Texas cities had the biggest increase in robberies" declines (ranking by change).
  - **One shared test, each row's own policy.** `everySet`'s test (every month of the span `VALUE` or `REPORTED_ZERO`, with a header in every year) is reusable, but the policy around it is not.
    - Only P61's state and national sums include partial reporters by default and offer the fixed set as a button.
    - Named agencies combined fall under P58: no figure unless every month is known.
    - Rankings fall under P60: complete reporters only, no include-others button.
  - Reusing P61's default for these would let reporting gaps decide a ranking, or produce a rate P58 forbids.
- **No duplicate button.** There is one button per answer. A question that already asks for consistent reporters ("only agencies that reported every month") gets that view directly.

**Not changed:**
- P61's default;
- the coverage figures;
- the rate rule (P62);
- single-agency answers.

## 2. Everyday crime groups as named composites

Savant's ready-made crime types (its Spotlight plan) compared with the engine:

| Group | Savant's definition | Engine today | Gap |
|---|---|---|---|
| Carjacking | Robbery (120) in an incident where a motor vehicle was stolen (loss type 7; property 03, 05, 24, 28, 37). Matches nibrsai. | **Same definition** (D18, `offenses.carjacking`): counted by offense. Memphis 2024: 356. | None; held-out cases only. |
| Car break-ins | Theft from motor vehicle (23F). | **Same** (the phrase is read as theft from motor vehicle). Memphis 2024: 8,799. | The answer doesn't say the phrase was read that way (decision 5). |
| Gun violence | Offenses 09A, 120 and 13A with a firearm recorded. Per victim for crimes against persons, per offense otherwise. | Declined by Jeff's P31 decision, with a note that the data has no non-fatal shooting counts. **Gun crime** (P31) is the same three crimes with a firearm, in the same units (murder and aggravated assault victims, robbery offenses). Memphis 2024: 12,229. | The decline's next step is the generic example, not gun crime (decision 4). |
| Domestic violence | Offenses whose first-listed victim-offender relationship is intimate partner or family (Savant's own definition, Spotlight plan item 1). | The layer has `victims.domestic_violence`, but **it does not run** ("no executable definition in v0"), so "Domestic violence in Memphis in 2024" declines. Intimate partner and family exist as relationship filters (`dv:intimate_partner`, `dv:family`). | Build it (decision 3). |

**Gun violence and gun crime:**
- Savant's "gun violence" is the same composite as P31's "gun crime": the same three crimes with a firearm, in the same units.
- Jeff decided the name "gun violence" is declined because readers take it to include people shot and wounded. This note keeps that decision and only adds the button.

### Domestic violence: the proposal (decision 3)

- **Unit:** victims.
- **Relationship:** taken from the victim's own relationship rows. A victim counts if any of their relationships to an offender in the incident is in one of these lists:
  - **intimate partner:** SE, CS, BG, XS, XR, HR (the engine's current list);
  - **family or household:** CH, PA, SB, OF, SC, SP, GP, GC, IL, CF, BE (the engine's current list), plus SS (stepsibling), FP and FC (foster parent and child), and CO (cohabitant, non-intimate).
- **D20's scope:** D20 (decided 2026-10-28) adds stepsiblings, foster relations and cohabitants. It does not decide the crimes counted, or where cohabitants are grouped; those are decisions 3(b)–(d).
- **Counted once:** each victim counts once, however many qualifying offenders or qualifying offenses the incident has.
- **Breakdown by intimate partner or family/household:** a victim with one offender of each is in both, so the grouping is multi-valued (`exclusive: false`, with the "categories overlap" note).
- **Savant's rule differs:** it uses the first-listed relationship only. That undercounts a victim whose first offender is, say, a stranger and whose second is a spouse.
- **The definition note** (wording follows decision 3): "Domestic violence here is [the crimes chosen] where the victim was the offender's spouse, partner, ex-partner, family member (including step, foster and in-law relations) or household member. Each victim counts once."

### Held-out cases

**Where expected values come from:**
- nibrs-model's independent master-file counts, not this engine.
- Domestic violence's expected values wait for decision 3, because its rule decides them.
- **Savant's figures are diagnostics, not expected values.** Its plan compares Tennessee with nibrsai's 67,567, 66,357 and 66,901 for **2018–2020**, and records any difference rather than asserting it. Those figures follow a different rule (first-listed relationship, the older lists), so they are reported beside the new count and never used as its expected value.

| Case | What it tests |
|---|---|
| Carjacking offenses, Memphis, 2024 | Three-way agreement: Savant, nibrsai and the engine. |
| Carjacking by year, Tennessee, 2021–2024: the default sum **and the fixed-set button**, including an agency with an explicit zero-report month and one with an unknown month | The every-month test: zero reported counts, unknown doesn't. |
| "Car break-ins in Memphis in 2024" | The phrase reading and its note. |
| Gun crime, Memphis, 2024 (three parts and the total) | P31's composite and units. |
| DV: a victim whose first offender is a stranger and second a spouse | Any offender, not first-listed. |
| DV: a victim with two qualifying offenders, or two qualifying offenses | Counted once. |
| DV: one case for each of SS, FP, FC and CO | D20's additions and decision 3(d). |
| DV: a 09C victim with a spouse relationship; a robbery victim with a family relationship | Decision 3(b) and (c) boundaries. |
| DV victims, Memphis, 2024, by intimate partner or family/household | The overlap note and `exclusive: false`. |
| DV victims, Tennessee, 2018–2020 | Reported beside Savant's diagnostics, not asserted. |

## 3. Overlap with existing rows

- **P03 and P61:** the state and national default and button are theirs. This note changes only the button's words (decision 1).
- **P58 and P60:** they govern named-agency totals and rankings when multi-agency trends are built (decision 2).
- **P31:** unchanged. "Gun violence" is still declined; decision 4 adds only a button.
- **D18:** units unchanged, unless decision 3(c) makes robbery an exception inside domestic violence.
- **D20:** its relationship additions are used. The engine's current `dv:family` list lacks them (SS, FP, FC, CO), and the build adds them. The rest of decision 3 is new and needs Jeff's yes.
- **No new composite rows** for carjacking, car break-ins or gun crime. Domestic violence gets a policy row from decision 3.

## 4. Not in this note

- **A national and state precompute.** The VPS speed test measured the national sum at 4.5 s alone and up to 14 s at three at once. It is queued for launch separately.
- **Savant's other presets:** the charts and the dashed clearance companion.
