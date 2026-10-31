# Codex review 01: query-log coverage r1 (REVISE)

r1 at 3e1cb93, a local branch that was never pushed: it held unredacted text, so r2 starts from dev on a new branch. Read-only review.

1. P1: identifying free text. A street address tied to a business, and a personal history. Redact, and state the limit.
2. P2: Codex's 50-row audit found shape 88%, source 86%, action 76%, shape-or-action 66%, not the 82% claimed. Grain words were treated as a period, and missing place and crime were never asked about (D31).
3. P2: source was the tab, not the source policy requires (P01, P53, P57).
4. P2: the coverage cells overstated what is built:
   - Historical clearance by type is not Historical's;
   - NIBRS state and national limits were not stated;
   - the national clearance rate is one year only;
   - increment 9 was missing.
5. P2: gap sizes conflated things:
   - county mentions are not county-total requests (P25);
   - estimates are Historical's;
   - lookups were inflated;
   - state and national NIBRS shapes were missing.
6. P2: two of the three policy questions were already decided (P25, D03).
7. P2: held-out first readings to correct: 1, 2, 8, 9, 14, 16, 17, 18, 20, 23, 25, 26.

Applied in r2 (this commit):
- **1:** rule-based redaction; three questions redacted; scan stated.
- **2:** D31 for crime, place and period; grain words are not a period; D03 declines. Re-audit on 60 rows: shape-or-action about 88%.
- **3:** a policy source column beside the tab; *unresolved* when no crime is named.
- **4:** status is judged at the question's place level (the repo's place resolver), with the NIBRS state and national limits, Historical clearance by type moved to NIBRS, and increment 9.
- **5:** gaps re-sized:
  - explicit county-wide 23, metro 17, below the agency 16;
  - estimates moved to Historical;
  - lookups narrowed to 49;
  - NIBRS state and national gaps named (49).
- **6:** one policy question remains (area totals across agencies).
- **7:** the held-out table now separates policy reading, first action and today's status.
