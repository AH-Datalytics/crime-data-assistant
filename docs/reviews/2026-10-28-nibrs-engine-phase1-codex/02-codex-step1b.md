**ACCEPT** for phase 1 at `afff57c`. All five required changes are addressed. Canonical-build acceptance remains subject to the explicit README conditions.

1. **D6 demographic cells — met.**  
   `scripts/nibrs-correctness-reference.py:67–75` now returns null numerator/share with `UNKNOWN_UNEVIDENCED_ZERO`, preserving the observed denominator. N1 June 2018’s absent combinations retain denominator **31**; D’s Pacific Islander female cell retains denominator **1**. Positive-cell calculations remain unchanged.

2. **R eligibility and population evidence — met.**  
   Reference lines **307–334** read the population extract and withhold both annual rates. Houston’s **2019 population 2,307,560** is preserved in `extracts/agency_years_2017_2026.csv:24`; **12.18** is now conditional on completeness evidence. The jurisdiction confirmation remains explicitly pending.

3. **S1–S5 and canonical gate conditions — met.**  
   Independently tracing the synthetic inputs gives:
   - S1: A’s evidenced zeros remain **0**; B’s January female count remains **unknown**.
   - S2: reported totals **4, 0, 3**.
   - S3: all-reporting change **−1**; same-agencies A/C change **−3**.
   - S4: A’s nonannualized rate **2.0**; state cohort count **3**, with rate unavailable because C’s primary E is excluded.
   - S5: **1.0 per 100,000 residents of all sexes**.

   `README.md:38–45` explicitly requires master-file anchoring and hashes, resolved M4 relationships, N3 duplicate provenance, and real BH-decoding fixtures before canonical acceptance. The added N3 CSVs substantiate identical duplicate incident, offense, victim, and property rows.

4. **Checks, candidate comparison, and reader cases — met.**  
   `--check` returned **OK**. The reference independently recomputes S and now checks substantive micro measures. `--compare` checks candidate micro measures and named/S answer structures; wording and G1–G6 remain explicitly subject to human review.

   Baseline comparison returned **MATCH**. Four separate perturbed candidate copies each produced a difference and **exit 1**:

   | Perturbation | Result |
   |---|---|
   | N1 unknown demographic cell → zero | Rejected |
   | R 2019 unavailable rate → 12.18 | Rejected |
   | M1 murder victims 3 → 999 | Rejected |
   | S unknown count → zero | Rejected |

   To preserve read-only operation, these copies were held in memory and supplied through mocked file reads to the actual `--compare` entry point.

5. **Firearm/join wording — met.**  
   `CASES.md:63–74` distinguishes property segments from physical firearm quantities. It correctly acknowledges that N2’s exact filtered join does not multiply these rows. The new M5 any-firearm measure demonstrates **1 qualifying offense versus 2 joined rows**, and both expectations are checked.

**Required changes: none.**

Two optional wording refinements, neither blocking acceptance:

- `README.md:28` overstates “every expected file”: G cases are manually reviewed, and `check_micro()` independently recomputes a selected set of measures, while `--compare` checks all declared non-pending micro measures.
- Reference line **325** should ideally say “cannot be evidenced complete **from the available evidence**.” Unknown months do not establish permanent impossibility of later completeness evidence.

No files were changed; the pre-existing untracked `lib/nibrs-plan/` remained untouched.

**Necessity check:** Accept this correction round. No further build or investigation is necessary for phase-1 acceptance. Preserve the documented BH, master-file, M4, N3, and jurisdiction prerequisites for canonical acceptance; defer optional wording polish.
