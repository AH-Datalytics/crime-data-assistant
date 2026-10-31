# Codex review 02: re-check of r2 (45a72db) and the addendum (e8adf55)

Reviewed 2026-10-30, read-only, no network. Verdict: **REVISE** (seven P2, one P3). Applied in r3.

## Part 1: 45a72db

1. **P2, shape and action errors remain** (classify_query_log.py:28; CSV rows "Did Trump's DC crime surge work?", "how marijuana legalization has affected crime", "add a column for the city's population", "add in the 2019 population", "remove 2026 from the data", "max of the y-axis should be 80%", the top-10 metro request). Causal questions became count/clarify; explicit continuations became count/clarify or out-of-scope/decline.
   - r3: edits to a table or chart are follow-ups; causal wording is out of scope.
2. **P2, policy-required sources misclassified** (classify_query_log.py:85). Property value in burglaries and aggravated-assault victims by age need NIBRS but got Historical; a 1960-2026 series went wholly to Current Trends; an April comparison got Historical though it needs monthly data.
   - r3: a NIBRS-only detail wins over the period default; monthly data is Current Trends'; a yearly series reaching this year is Historical, with the current year from Current Trends.
3. **P2, status rules overstate and understate built coverage** (classify_query_log.py:114). Texas-city carjacking rankings were marked a national-ranking gap though increment 4 ranks a state's agencies; the 15 largest US cities as separate series were marked a built national total; current-year city rankings got a built route; state clearance was marked planned though P18 declines it; agency Historical clearance routes were omitted.
   - r3: lists of places are sets of agencies; the Current Trends route counts only for state and national totals; D03, P18 and below-agency declines come first; an agency's clearance rate for a year is the named P57 route.
4. **P2, gap and demand sizes conflated** (coverage doc around line 105). "About 1,570 Historical agency questions" was unsupported (770 planned Historical rows had place=agency, staffing included); the 49-question NIBRS geographic gap included built Texas-city rankings and an example labeled P inc 7; ZIP and neighborhood requests had answer/G labels though the doc said decline; the national robbery-offender estimate was labeled P inc 7.
   - r3: every named group is summed from its member rows; below-agency requests are declines; the estimate is a no-source gap.
5. **P2, held-out cases 25 and 4 wrong.** #25's share is not covered by increment 6; #4 asks for counts across major cities, not a ranking.
   - r3: both corrected.

**Fresh audit** (seed random.Random(2026103017), 50 distinct rows): shape 43/50 (86%), source 47/50 (94%), action 43/50 (86%), shape and action 43/50, status bucket 40/50 (80%), full status 37/50 (74%). The doc's claims were 5 to 7 points too high.

**Privacy:** no remaining private names, street addresses, emails, phones or identifying personal narratives.

**Earlier findings:** 1 (privacy) and 6 (policy questions) closed; 7 (held-out readings) accepted with caveats; 2, 3, 4 and 5 only partly closed (findings 1-4 above).

## Part 2: e8adf55

6. **P2, agency names trigger metro status** (classify_query_log.py:108). A clearance comparison naming LAS VEGAS METRO PD and METROPOLITAN NASHVILLE became a metro total.
   - r3: metro means metro geography (metro area, region, MSA, CBSA), not an agency name.
7. **P2, metro actions contradict the interim decline** (classify_query_log.py:97). Metro rows kept correct_action=answer.
   - r3: the action is "decline (metro area: until after inc 8)"; the status names the later plan.
8. **P3, a leftover follow-up gap label** (coverage doc line 111).
   - r3: follow-ups are listed under planned demand, not gaps.

**Reconciliation passed:** table cells matched the CSV; follow-ups all carried "P inc 7b"; the open policy question was removed.
