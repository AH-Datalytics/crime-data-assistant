**Verdict: ACCEPT WITH CHANGES.** This is a useful independent reference set, but it is not yet sufficient to gate the canonical build and plan compiler.

Reviewed HEAD `5cc8425a68b4eff5202c3c7fe9c37bd802240a28` on `nibrs-engine/phase1`. `python scripts/nibrs-correctness-reference.py --check` returned **OK**. No files were changed.

The calculations are independent of the application engines: the reference uses CSVs and standard-library Python, with no engine imports or summary-table inputs. However, independence from the **existing parser** is not established: the extracts inherit acknowledged losses and misparses from `nibrs.db`. Also, most named expectations are reference-program calculations, not hand calculations; README accurately explains that distinction.

**Required changes**

1. **Apply D6 consistently to demographic zeros.**

   In [the reference script](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/scripts/nibrs-correctness-reference.py:99), N1 fills absent race–sex combinations with zero despite having no submission-completeness evidence. For example, `expected/N1-…json:154–158` reports June 2018 Asian women as **0/31, 0.0%**. D repeats this for Pacific Islander women, **0/1**, in `expected/D-denominator-scopes.json:52–56`.

   These are filtered counts, subject to the same D6 rule correctly implemented in Z. `CASES.md:90–92` explicitly permits the unsupported zeros.

   **Change:** represent unsupported absent cells as unknown or omit them with the distinction explicit; retain the observed monthly denominator. Alternatively, add evidence covering those cells’ month and measure. If zero is retained solely as an arithmetic count within the frozen extract, distinguish that diagnostic from the expected public answer.

   **Consequence if unchanged:** the gate would require a compiler to emit false evidentiary zeros.

2. **Fix R’s completeness inference and preserve its denominator evidence.**

   [Reference lines 299–309](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/scripts/nibrs-correctness-reference.py:299) hard-code populations and permit the annual rate whenever all 12 months contain crime rows. D6 explicitly says crime rows do not establish completeness.

   The arithmetic **281 / 2,307,560 × 100,000 = 12.18** is correct. Its eligibility as a completeness-aware annual rate is unproven. The population itself is not in the extracts or `QUERIES.sql`, so the claim that every number is verifiable from extracts is overstated.

   **Change:** make 2019’s rate unavailable pending completeness evidence, or include the evidence supporting it. Preserve the agency-year population and its source, plus the applicable jurisdiction mapping. Keep **12.18** as a conditional arithmetic expectation if useful.

   Clarify `CASES.md:169–172`: withholding an annual rate from an incompletely observed year is the policy; dividing an explicitly labeled partial-period count by population is not inherently invalid. Add an elapsed-period example before claiming YTD-rate coverage.

   **Consequence if unchanged:** a build with incomplete monthly submissions could incorrectly pass the annual-rate gate.

3. **Complete the missing evidence cases before using this as the canonical acceptance gate.**

   [CASES.md:152–155](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/scripts/fixtures/nibrs-correctness/CASES.md:152) correctly admits that no case establishes `REPORTED_ZERO` or `NOT_REPORTED`. Thus the coverage claim at line 16 is incomplete: Z tests unknowns and hypothetical zeros, not actual zero-report evidence.

   **Change:** add a small hand-traced status fixture covering:
   - evidenced `REPORTED_ZERO`;
   - evidenced `NOT_REPORTED`;
   - incomplete/unknown submission with no matching crimes;
   - evidenced complete submission with a genuine filtered zero;
   - matching numerator/population eligibility, including D8’s unavailable-rate fallback when covered population cannot be established.

   Before parser acceptance, anchor the relevant cases to master-file/BH records and source hashes, resolving M4’s `PENDING_MASTER_FILE` relationships. Small explicitly synthetic fixtures can test semantic behavior now; they cannot validate BH decoding.

   **Consequence if unchanged:** the gate cannot distinguish correct status decoding from a builder that never produces either evidenced zero or confirmed non-reporting, and cannot detect the known relationship truncation.

4. **Make the future gate exercise the semantic expectations, not merely reproduce the reference files.**

   [Reference lines 336–347](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/scripts/nibrs-correctness-reference.py:336) check seven micro segment-count fields. They do **not** check the micro `measures`, such as distinct victims, circumstance pairs, stolen value, offender ages, or arrest month. Named checks compare the reference program’s output with files generated by that program.

   That is a useful consistency check, but not an engine gate.

   **Change before canonical/compiler acceptance:** connect these frozen expectations to actual candidate outputs, including micro measures, null/status distinctions, denominator partitions, and required interpretations. Add compact cases for the still-uncovered semantic rules being accepted: national reported-count aggregation, changing participation versus a same-agencies cohort, demographic counts over total-population denominators, and geography/clarification behavior.

   **Consequence if unchanged:** a faulty canonical model or compiler can coexist with a passing `--check`.

5. **Correct the firearm-unit and join claims.**

   [CASES.md:58–62](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/scripts/fixtures/nibrs-correctness/CASES.md:58) calls M5 “one firearm” and says “Firearms stolen” is **1**. The extract establishes **one stolen-firearm property row**, not one physical firearm; it contains value **550**, but no firearm quantity. The JSON appropriately says `stolen_firearm_segments`.

   At lines 108–110, M5 is also offered as proof that a join multiplies the answer. A join correctly filtered to **loss 7 / description 13** matches only one M5 row. Across N2, I found **1,503 qualifying property rows and 1,503 distinct incident keys**: this dataset does not distinguish that filtered join from `EXISTS`.

   **Change:** use segment/existence terminology, qualify the join claim, and add a minimal legal multiplicity case for whichever relationship the compiler must aggregate safely.

   **Consequence if unchanged:** documentation teaches an unsupported physical-item count and overstates the regression protection.

**Verified counts and interpretations**

| Spot-check | Result |
|---|---|
| N1 June 2018, victim CSV lines 2–32 | **31** victims: WM **14**, BM **10**, WF **5**, BF **2**. Shares **45.2%, 32.3%, 16.1%, 6.5%** are correct. |
| M1–M3 | M1: **3 murder + 2 assault victims**. M2: **5 victims, 6 circumstance pairs**. M3: **4 distinct victims, 6 victim–offense pairs**, stolen value **7,000**. |
| M4–M7 | M4: **6 offenders, 4 arrestees**, one juvenile in each. M5: stolen/recovered firearm rows. M6: stolen value **30,001**, arrest in June versus incident in January. M7: **23F and 240**, shared incident-level property, offender placeholder **00**. |
| D | May 2021: **51**, comprising BM **31**, BF **4**, WM **12**, WF **3**, PM **1**. Annual denominator **473**. The positive-cell partition calculations are correct. |
| N2 | **1,503** matching offenses; January **108**. Incident-scoped property existence and the non-attribution statement are correct. |
| N3 | Requested range: **26,707 raw offense rows − 5 duplicate copies = 26,702**. All five duplicate offense pairs are identical. July 2023: **1,571** versus automobile variant **926**. |
| N4 | H1 monthly values sum to **190**. H3: **411, 535, 601, 528, 359, 190**. Questions match the frozen H1–H3 text. |

Houston’s first observed month is June 2018; preserving January–May as **UNKNOWN** is correct. Z’s **59 offenses / 35 positive months / 63 measure-unknown months / 8 agency-unknown months** is consistent with D6.

**Optional suggestions**

- Describe H1’s 2025 selection as the **legacy default calendar year**, rather than “latest complete year,” unless completeness is evidenced (`CASES.md:139`, reference line 237).
- N3’s “every segment identical” claim exceeds the bundled evidence: offense duplicates can be verified, but duplicate incident and victim rows are not included.
- Keep the deferred replay and broader production/performance work outside this correction round.

**Necessity check:** Preserve the accepted counts and traces. Correct the unsupported zeros, rate eligibility, and firearm claims now; add the small evidence fixtures and candidate-output comparisons before declaring this an acceptance gate. Full national validation, historical-era certification, and production replay can remain deferred to their planned stages.
