# Brief for label drafters

You draft expected outcomes for a slice of the labeled interaction set. Another judge reviews them later; you are
never the only judge, but draft as if you were.

## Read first

- `docs/superpowers/specs/2026-10-28-answer-eval-labeled-set.md`: the labeling rules. Follow them exactly.
- `lib/answer-eval/case.ts`: the `Expected` and `Meaning` schema. Your output must parse against it.
- `docs/policy/nibrsai-answer-policy.csv`: the answer policy.
  - Rows D01-D29 are decided and bind.
  - Rows P01-P24 are open: label the *proposed* behavior and list the row id in `policy_add`.
- For gold cases: `docs/superpowers/2026-09-06-correctness-gold-set-v7.json`. Read each case's `expectations`
  (rules, not answers), plus `data_condition_verified` and the top-level `ground_truth_rule` and
  `coverage_evidence_rule`. Your label must satisfy every expectation of that case.
- Vocabulary for meanings: measure names as in `lib/nibrs-plan/draft-layer.ts` and `lib/nibrs-question-types.ts`
  (MEASURE_CODES), in plain words ("murder", "aggravated assault", "motor vehicle theft").
  - Units: victim, offense, incident, offender, arrest, group B arrest, dollars, property segment, officer,
    employee, percent cleared.
  - Sources: nibrs, rtci (Current Trends), historical, shr (Homicide Reports), hate_crime.
  - Tab "current" is rtci.

## Never read

- Any logged response or outcome: `outcome_then`, `decision_then`, `baseline` and `request` in
  `scripts/fixtures/nibrs-replay/inventory.json`.
- Anything under `docs/superpowers/p3-1a/`, saved answers, or query logs.
- The candidate engine's output (`scripts/fixtures/nibrs-replay/reachability/`).

Label from the question, its setup turns, the policy and the source definitions only.

## Output

Write ONE file, `scripts/fixtures/answer-eval/drafts/<batch>.json`: an object keyed by case id.

```json
{
  "LS-001": {
    "status": "drafted",
    "expected": { "action": "answer", "meaning": { "...": "..." }, "values": { "status": "pending_build" }, "statements": ["..."] },
    "policy_add": ["P06"],
    "notes": "one or two sentences: the reading chosen and why; any doubt"
  }
}
```

Status and expected:
- `status` is `drafted`, or `unresolved` when the right action or meaning cannot be established. Say why in
  `notes`, and set `expected` to null.
- `values.status` is `pending_build` unless the question exactly matches a correctness case with known numbers.
  Leave it `pending_build` otherwise; never invent numbers.

Meaning fields:
- Periods are months (`{"from": "2024-01", "to": "2024-12"}`), or `{"rule": "..."}` for relative ones: "latest
  complete year", "year to date through the latest month", "calendar year before today".
- Places: `{"kind": "agency", "name": "Houston Police Department", "state": "TX"}` for a city (its principal police
  agency, P16); `{"kind": "county", ...}` for a county (the sheriff's agency, D10, name it so);
  `{"kind": "national", "name": "United States"}`.

By action:
- A clarify has options. Each option's meaning is the original question with that choice filled in. Use
  `leads_to: "decline"` and `meaning: null` when that choice cannot be answered.
- A decline's `alternative` is a runnable Meaning, or null when no genuine nearest measure exists (D14).

Do not edit `cases.json` or any other file. Keep notes short. Report back with counts by action and status, and the
cases you were least sure of.
