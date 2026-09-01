# P3.1a — execution record

**Started:** 2026-09-01
**Status:** IN PROGRESS — steps 1–4 complete; **review round 2 corrections applied**.
Frozen cases at v3. Candidate corrected and re-frozen at
`c163a0ecc6fab8be4e5d32b9071464c6f0b87b2b`, superseding `9a19e10…` and `c567f4a…`, both preserved.

**No frozen case has been executed.** `docs/superpowers/p3-1a/runs/` does not exist. The runner
refuses to execute without `--run` plus a matching candidate commit, tree, clean worktree and its
own digest. Its live path HAS now been exercised, against synthetic cases only, under the round-2
§7 authorization.

### What the 63-case run may and may not claim — ruling, round 2 §6

The controls evaluate the frozen questions, so the case set is **no longer an unseen holdout**. It
remains an independently adjudicated, pre-frozen **deterministic conformance set**: expected
outcomes were authored and frozen before any candidate execution, production did not write them,
and nothing rewrites them. The formal run may establish exact agreement on those 63 predeclared
cases. It may **not** be described as an unbiased estimate of generalization or production accuracy.
No replacement case set is required for P3.1a; a separately sequestered set would be needed only if
a later certification claim required holdout performance, and that claim must not be retrofitted
here.

**Read with this record:** `2026-09-01-p3-1a-candidate-review-round2-response.md` (current) and
`…-round1-response.md`. Both carry a section stating what is *not* proved.

**Rulings governing this record**

| Ruling | sha256 | Effect |
|---|---|---|
| `2026-09-01-p3-1a-stage-placement-ruling.md` | `BB98575D…006FDBD5` | post-SQL placement is the justification for the stage, not a divergence; the observer must never claim production decides pre-answer |
| `2026-09-01-p3-1a-step-2-coverage-ruling.md` | `127f1dce9c02503eafe850a6abaa20c65953e803d9ae2da45765f354b6b1e672` | expected applicability is adjudicated independently; observed and expected stay in separate columns |

## Approved contract identity

Execution proceeds under this exact contract. Any change to it invalidates this record.

| | |
|---|---|
| Contract | `docs/superpowers/2026-09-01-p3-1a-contract.md`, Revision 3 |
| **sha256** | `2896d1c5e6575f7f9715e1a6f1f7d1000950afad0fa9188ab0362fb716282468` |
| Bytes | 23,028 |
| Line endings | LF |
| Approving review | `2026-09-01-p3-1a-contract-revision-3-final-review.md` (`2BF79D65…07DA38`, verified) |
| Correction applied | the single stale §11 reference, W7 → W6. **No other change.** |

**Authorization:** owner decision 2026-09-01 (D1–D4). **P3.2 remains unauthorized.**

## Pinned trees

Branch for every candidate: `feat/p3-1a-request-decision-observer`. Superseded candidates are
preserved unmodified and remain reachable in that branch's history; none is deleted or rewritten.

| Tree | Identity | Role |
|---|---|---|
| BASE | `e2d24acd37027f436590ed8eae58bb5b30414ffb` | inventory of existing production predicates; flags-off equivalence reference |
| CANDIDATE — **governing** | **`c163a0ecc6fab8be4e5d32b9071464c6f0b87b2b`** (tree `f0b32cebd85d11478c68ec3fd35d6bd0e8363ab2`) | observation stage + five Tier F suites; the tree any evidence run must match |
| candidate, superseded | `9a19e1045ad051afc60cb53efd8d56bd93f952b7` | round-1 corrections |
| candidate, superseded | `c567f4aea31d0f4c5d1c0928b1a2687a8d10955b` (tree `26083c066d572898533af3c9a4ff7ee7dc770448`) | original observation stage |

**The evidence run is gated on these exact values.** `scripts/run-p3-1a-frozen-cases.ts --run`
refuses unless `--candidate`, `--tree` and `--runner-sha` are supplied and match HEAD, the HEAD
tree, and the runner file on disk, and unless the worktree is clean. Runner sha256:
`6ab1f354b00b4103486b279fff2819bada439c265dcdbf9fcd9f345891253634`.

This table originally named `c567f4a` as *the* candidate with no supersession column; it is
corrected here for the same reason the frozen-set identity table was corrected in round 1 — a stale
governing identity points every later verification at the wrong tree.

---

## Step 1 — rule inventory from BASE (§3.1) — COMPLETE

Enumerated mechanically from `lib/source-capabilities.ts` at BASE `e2d24ac`, by reproducing the
original classification criterion rather than trusting the recorded figure: a rule is
**question-only** if its `when` predicate reads neither `ctx.sql` nor `ctx.tables` and it declares
none of `requiresAnyTables`, `forbidsTables`, `forbiddenSql`.

### Measured

| Measure | Value |
|---|---|
| Total rules in `SOURCE_CAPABILITY_RULES` | **39** |
| Question-only rule **definitions** | **9** |
| Needs SQL or referenced tables | 30 |
| Severity of the question-only set | `unsupported` only — all nine decline |
| `ALL_QUERY_SOURCES` resolved | `current`, `historical`, `nibrs`, `shr`, `hate_crime` (**5**) |
| **Question-only APPLICABILITY PAIRS** | **21** |

The nine definitions match the 2026-08-20 inventory exactly, by id and by source. The static
figure is **confirmed, not merely inherited**.

### The number the caveat implied but never stated: 21, not 9

The reset document warned that "the count is right; the unit is looser than 'nine rules' implies",
because 3 of 9 declare `source` non-literally. Enumerating it gives the actual unit:

| Form | Definitions | Sources each | Pairs |
|---|---|---|---|
| `...ALL_QUERY_SOURCES.map(...)` | 3 | 5 | 15 |
| literal `source: "nibrs"` | 3 | 1 | 3 |
| literal `source: "shr"` | 3 | 1 | 3 |
| | **9** | | **21** |

**This changes the size of Deliverable B.** §3.2 requires a predeclared triggering *and*
non-triggering case for **every claimed applicability pair** — so the floor is **42 cases**, not 18.

Recorded as a **scope measurement, not a scope expansion**: the contract already specified per-pair
cases; the pair count was simply not known until enumerated. No stop condition under §3.3 is
triggered — nothing observed is absent from the declared inventory, and no declared rule lacks a
binding.

### Question-only definitions and their pairs

| Rule id | Source form | Sources |
|---|---|---|
| `unsupported-sub-city-geography` | spread | current, historical, nibrs, shr, hate_crime |
| `unsupported-court-policy-topic` | spread | current, historical, nibrs, shr, hate_crime |
| `demographic-rate-unsupported` | spread | current, historical, nibrs, shr, hate_crime |
| `nibrs-clearance-weapon-unsupported` | literal | nibrs |
| `nibrs-shooting-category-unsupported` | literal | nibrs |
| `nibrs-countywide-demographics-unsupported` | literal | nibrs |
| `shr-non-homicide-unsupported` | literal | shr |
| `shr-clearance-unsupported` | literal | shr |
| `shr-demographic-rate-unsupported` | literal | shr |

### Carried into step 2, not assumed

- **Historical clearance is in P3.1's scope but is not one of these nine.** It was the original
  demonstrated defect. Whether it is a rule in this table, a separate predicate, or not yet
  represented at all must be established in step 2 before any case is authored. **Not asserted
  here.**
- **The stored-embed surface** is likewise in scope and is not represented in this table.
- **Reachability is not established by this enumeration.** The 2026-08-20 inventory recorded that
  all nine are reachable only after the model produces SQL, because `validateSourceCapabilities`
  takes `sql`. If that still holds at BASE, every one of the 21 pairs may be
  `unreachable`-before-SQL, which is the single most consequential thing step 3 will measure — and
  it bears directly on whether P3.1 can affect the ~11 of 25 defects attributed to it.

---

## Step 2 — measured stage placement, Historical clearance, coverage-map shape

### 2a. Measured stage placement — all 21 pairs are post-SQL

Traced mechanically at BASE, not inferred:

```
validateSourceCapabilities({ question, source, contract, sql })   lib/source-capabilities.ts:557
  └── sole production caller: validateQueryContractSql({ question, source, sql, ... })
                                                       lib/query-contract-validator.ts:624/734
        └── called from exactly four sites:
              app/api/query/route.ts:1338
              app/api/nibrs-query/route.ts:849
              app/api/shr-query/route.ts:325
              app/api/hc-query/route.ts:307
```

Every path requires `sql`. **All nine definitions and all 21 pairs are reachable only after the
model produces SQL.** The 2026-08-20 finding holds unchanged at `e2d24ac`. The other two call sites
are test scripts, not production.

### 2b. Does this trigger the §3.3 divergence gate? — a judgment I am surfacing, not settling

Checked against each mechanical trigger:

| §3.3 trigger | Met? |
|---|---|
| observed rule identity absent from the frozen inventory | no |
| declared rule with no executable production predicate binding | no — all nine bind |
| claimed applicability pair for which no positive control can fire | **no** — a positive control *can* fire, post-SQL |
| runtime source/family pair absent from the frozen map | not yet measured (step 3) |
| decision/reason pair outside typed admissibility | not yet measured (step 3) |
| ambiguity preventing one accountable rule result | not yet measured (step 3) |

**No trigger is met, so I have not stopped.** But the reason matters more than the verdict, and I
want it on the record rather than absorbed:

The intended P3.1 role is a request decision made **before the cache, the model, and every plan**.
The measured placement is **after** the model produces SQL. Those differ — but that difference is
**the premise of the increment, not a divergence from it.** The 2026-08-20 inventory called this
gap "the measured justification for stage 1". P3.1 exists to move these rules earlier.

**The consequence that must not be blurred.** If the observation stage evaluates these predicates
pre-answer, it creates a *new evaluation point*. Calling the same predicate functions satisfies
§3.2 — but the observation then measures **"what these predicates would decide pre-answer"**, which
is *not* **"what the system currently decides"**. Those are different claims. Every P3.1a report
must say which one it is making. Conflating them would be exactly the
scope-narrower-than-its-reading error this project has hit repeatedly.

**If the reviewer judges that the intended-versus-measured placement difference is itself a
divergence requiring a stop, this is the point to say so** — before an observation stage is built
and its meaning rationalized around what was convenient to implement.

### 2c. Historical clearance — named, and covered by a different mechanism

Required to be named even though it is outside the nine. Measured:

- **`historical-clearance-table` IS in `SOURCE_CAPABILITY_RULES` but is NOT question-only.** It
  declares `requiresAnyTables: ["national_clearance_rate", "historical_agency_clearance"]`, placing
  it among the 30 that need SQL or tables.
- **A separate contract-only mechanism already exists:**
  `observeHistoricalClearanceGrain(contract: QueryContract)` in `lib/historical-clearance-grain.ts`
  takes a **contract and no SQL**, with `scripts/measure-historical-clearance-shadow.ts` and two
  registered harness tests alongside it.

**Disposition: covered under another mechanism**, not uncovered. And it is a useful precedent — a
contract-only observer is precisely the shape the request-decision stage needs, and it exists
already rather than being hypothesised.

### 2d. Coverage-map shape — 42 is a floor, 63 is the ceiling

Per the control: 42 triggering/non-triggering cases are **not automatically sufficient**. Each of
the 21 pairs needs **positive**, **false-acceptance** and **false-refusal** coverage where
meaningful — 63 role-slots.

The map is therefore a **21 × 3 matrix**, and where one case serves two roles (a non-triggering
case doubling as false-acceptance coverage, say) **the map records the dual purpose explicitly**
against both slots. A slot with no case is `uncovered` and named. A role that is not meaningful for
a given pair is marked `not-meaningful` **with a reason**, never left blank.

Floor 42, ceiling 63, actual determined by how many dual purposes survive review — and every dual
purpose is a written claim, not an accounting convenience.

### 2e. How the observer reaches the predicates — a design finding

The four pure-question helpers (`asksSubCityGeography`, `asksOutOfScopeTopic`,
`asksShootingCategory`, `asksShrNonHomicideTopic`) are **module-local and not exported**. But
`SOURCE_CAPABILITY_RULES` **is** exported, and each rule object holds `when` as a closure over
those helpers.

**Therefore the observer selects rule objects from the exported array and calls `rule.when(...)`.**
That is the exact production predicate — no copy, no reimplementation, and no new production
exports. It never calls `validateSourceCapabilities`, which requires SQL that the ruling forbids
faking. Structural exclusion is applied by rejecting any rule declaring `requiresAnyTables`,
`forbidsTables` or `forbiddenSql`, which yields exactly the 21 eligible rule objects.

### 2f. Corpus v0.1 — two columns, kept separate

**Framing corrected per the step-2 coverage ruling (`127f1dce…`).** My first write-up said corpus
v0.1 "covers 0 of the 21 pairs". That conflated two different things. What was measured is **zero
observed BASE predicate firings**. Certification coverage is established by **independent
adjudication of expected applicability**, derived from each case's adjudicated meaning and the
rule's stated contract — **never** by running `rule.when`, the future observer, or any other
implementation of the predicate.

The map therefore carries two columns, and they are never merged.

#### Column 1 — independently expected applicability (adjudicated, no predicate executed)

Only three pairs are within corpus v0.1's source reach (`rtci` → `current`):

| Pair | Expected applicability across the 30 cases | Basis |
|---|---|---|
| `unsupported-sub-city-geography × current` | **none** | no case asks below city level. RTCI-R04 (`geography_grain_unsupported`) asks a **county** rate — a different grain problem, above city level, not sub-city |
| `unsupported-court-policy-topic × current` | **none** | no case asks about court outcomes, incarceration, fines, immigration, or policy registries. RTCI-R09 (arrests) is law-enforcement reporting, which the rule's own message places **in** scope |
| `demographic-rate-unsupported × current` | **none** | no case asks for a demographic-group rate. RTCI-R04's "per 100,000" is a **geographic** rate, not demographic |

#### Column 2 — observed BASE predicate result

Zero firings across all 30 cases, source-filtered in production order.

#### Reconciliation

**Expected 0, observed 0 — the columns agree.** Under the ruling's classification that means
**no candidate false negatives and no candidate false acceptances** among the three in-reach pairs.
Agreement of two zeros is a weak but real result, and it is not the same as coverage: these three
pairs remain **named gaps**, because no case independently establishes the rule's applicability
either way.

The other **18 pairs are not assessable by this corpus at all** — `nibrs`, `shr`, `hate_crime` and
`historical` sources are outside its scope. They are named gaps by construction, **not** zero
coverage and not evidence of anything.

#### One ambiguity recorded rather than resolved

RTCI-R07 — *"Did the 2025 policing budget increase cause the drop in robberies…"* — is adjudicated
`causal_claim_unsupported`. It also mentions a **policing budget**, which is arguably a policy
topic. I judged expected applicability for `unsupported-court-policy-topic` to be **no**, because
the adjudicated refusal reason is causality rather than topic scope. That is a judgment, the case
sits near a boundary, and if a reviewer reads it the other way it becomes a **candidate false
negative** (semantic match, predicate did not fire) rather than agreement. Recorded so the
classification can be challenged.

#### A gap in the rule set this surfaced

RTCI-R04's `geography_grain_unsupported` is a genuine geography refusal that **none of the nine
question-only rules covers** — the only geography rule among them is sub-city, and this is a county
grain problem. Whatever handles it is either among the 30 SQL-dependent rules or another mechanism
entirely. Named here as a question for step 3, not answered.

#### The earlier mistake, retained

A first run reported six hits. It evaluated `rule.when()` without the source filter production
applies **first**:

```ts
for (const rule of SOURCE_CAPABILITY_RULES) {
  if (rule.source !== opts.source) continue;   // ← evaluated BEFORE `when`
```

Those six were `shr-non-homicide-unsupported` (source `shr`) matching `rtci` questions — a rule
production would never evaluate for that source. Retained in the record because I nearly entered
six non-events into a coverage map as coverage.

**A first run of this mapping reported six hits, and they were wrong.** It evaluated `rule.when()`
without applying the source filter that production applies *first*:

```ts
for (const rule of SOURCE_CAPABILITY_RULES) {
  if (rule.source !== opts.source) continue;   // ← evaluated BEFORE `when`
```

The six "hits" were `shr-non-homicide-unsupported` (source `shr`) firing on the corpus's `rtci`
questions — predicate text-matches on a rule production would never evaluate for that source. With
the production filter applied in the production order, the count is zero. **Recorded because I
nearly entered six non-hits into a coverage map as coverage**, which would have overstated evidence
for a rule that has none.

**Consequence for Deliverable B.** All 21 pairs remain named gaps: three assessed with expected
and observed both zero, eighteen not assessable by this corpus at all. **Essentially the entire
42-63 slot matrix must be newly authored.** This is contract weakness W2 - "corpus v0.1 may barely
exercise these rules" - now measured rather than anticipated. It is a finding about the corpus's
scope, not a defect in the corpus, which was built to measure answer correctness and not rule
triggering.

**Assumption recorded, not hidden:** corpus v0.1 labels its source `rtci`; I mapped that to the
contract source `current`. That mapping is stated here so it can be checked; it is not derived from
the corpus file.

**Deferred to step 3 — and RESOLVED there.** The five contract-dependent definitions
(`demographic-rate-unsupported`, `nibrs-clearance-weapon-unsupported`,
`nibrs-countywide-demographics-unsupported`, `shr-clearance-unsupported`,
`shr-demographic-rate-unsupported`) require a built `QueryContract` and cannot be mapped from
question text. They were reported as deferred, not as absent.

Step 3 closed the deferral. Those five definitions span **9 of the 21 applicability pairs = 27 of
the 63 cases**, and each of those cases carries `contract_projection_required: true` plus its own
independently authored `expected_contract` projection, frozen in v2 and carried into v3. The
projection is written by hand from the `QueryContract` type declaration, never produced by
`buildQueryContract`, so the parser is never its own oracle — the runner compares the parser
against the frozen projection and records any disagreement on a separate axis that cannot rewrite
the applicability verdict. This paragraph is a correction under candidate review round 1: the
original text left the deferral open with no statement of how it closed.

### 2g. RTCI-R07 and RTCI-R04 — resolved by ruling

- **RTCI-R07 is NOT applicable to `unsupported-court-policy-topic`.** That rule's stated scope is
  court outcomes, incarceration, fines, immigration and policy registries — not police budgets or
  general causal inference. R07 remains a causal-claim case covered by another mechanism or a named
  gap. The ambiguity I flagged is closed: expected applicability is **no**.
- **RTCI-R04 is correctly outside the sub-city rule.** Its county-grain handling stays a named
  step-3 question. It is **not** assigned to any of the nine merely to create coverage.

**Confirmed reconciliation:** three reachable pairs — expected 0, observed 0. Eighteen pairs not
assessable by corpus v0.1. All 21 remain certification gaps. **No false-acceptance or false-negative
candidate arises from this corpus mapping.** No stop condition.

---

## Step 3 — frozen case set (§4.3–§4.5) — FROZEN

### Identity

Three sets exist. All three are preserved unmodified; **v3 alone governs**. This table originally
named v1 as the governing identity and was corrected under candidate review round 1 — v1 was
already superseded by the time the review read it, and leaving it as the governing hash would have
pointed every later verification at the wrong oracle.

| Set | sha256 | Bytes | Status |
|---|---|---|---|
| `frozen-cases-v1.json` | `2a2739cc9dcab7872537d6c22880d70ee5ec0e012362d2c6fb47f8346d69cc78` | 72,452 | **SUPERSEDED** by v2 |
| `frozen-cases-v2.json` | `7114d95c6c3a84c7da1f8e786915825436994085dfcc924477e26924203f391f` | 110,584 | **SUPERSEDED** by v3 |
| `frozen-cases-v3.json` | `2535cbd934a4766a7f9ff8570f5b0e60d04b7c37430283b48e52b206c75a0b91` | 112,928 | **GOVERNING** |

| | |
|---|---|
| Line endings | LF (0 CRLF), all three |
| Binds contract | Revision 3, `2896d1c5…82468` |
| Binds BASE | `e2d24acd37027f436590ed8eae58bb5b30414ffb` |

**Frozen before any predicate or candidate-stage execution**, as §4.5 requires. v1 → v2 added the
`question_family` vocabulary, `expected_outcome` and `expected_contract`; v2 → v3 added the
independent Census evidence. Each supersession is an addition to the record, not a rewrite: all
three files remain byte-identical to the moment they were frozen, and
`scripts/test-request-decision-observer.ts` and `scripts/run-p3-1a-frozen-cases.ts` both verify the
v3 hash rather than trusting the path.

### Composition

| Measure | Value |
|---|---|
| Applicability pairs | 21 |
| Cases | **63** (21 × 3 roles) — the ceiling, not the 42 floor |
| Triggering | 21 |
| Non-triggering | 42 |
| Pairs with all three roles | **21 / 21** |
| Dual-purpose slots recorded | 21 |
| Boundary probes recorded | 21 |

**All three roles are meaningful for every pair, so none is marked `not-meaningful`.** Because all
nine rules decline, `false_acceptance` and the predicate-over-match form of `false_refusal` are the
same event seen from predicate and user. Each `false_acceptance` slot therefore records that dual
purpose explicitly rather than counting once and implying twice. The `false_refusal` slot is kept
distinct and probes the **centre** of the in-scope domain — an ordinary answerable question — where
`false_acceptance` probes the **edge**.

### Adjudication discipline

`expected_applicability` was adjudicated from each rule's **stated scope message** and the case's
meaning. No case's expectation was populated by running `rule.when`, the observer, or any
reimplementation.

Predicate source *was* read, to design boundary probes worth running. Knowing where an edge lies so
a case can sit on it is not the same as letting the implementation decide what the answer should
be. Every case designed that way carries a `probe_basis` field naming it — 21 of 63.

### The divergence candidate this produced

`P31A-002` — *"How many murders were reported in Ward, AR in 2022?"*

`SUB_CITY_GEOGRAPHY_RE` matches the standalone token `ward`. **Ward, Arkansas is a real
incorporated city**, so this is a city-level, answerable question. Independent adjudication says
`does_not_apply`; if the predicate fires it is a genuine **false acceptance** producing a wrongful
refusal on legitimate traffic. This is the single most valuable case in the set, and it exists
because the boundary was designed against rather than around.

### Question reuse, recorded not hidden

50 distinct question texts across 63 cases; 7 texts serve more than one slot — for instance
*"How many homicides were reported in Los Angeles, CA in 2021?"* is the `false_refusal` control for
four different rules on the `shr` source. Each occurrence is a **separate case id with its own
rule, pair and role**, so every slot is explicitly recorded rather than one case silently counted
several times. The `Ward, AR` probe recurs across all five sources of the sub-city rule by design —
the same probe, five different applicability claims.

**Next:** step 4 — see below.

---

## Step 4 — CANDIDATE implemented, controls proved, identity FROZEN

> **SUPERSEDED IDENTITY — historical record.** The identity below is the FIRST candidate. It was
> superseded by review round 1 (`9a19e10…`) and again by round 2 (`c163a0e…`). The governing
> candidate is in **Pinned trees** above; the evidence run is gated on that one. This block is kept
> because the controls described beneath it were designed against this tree, and deleting it would
> erase why they look the way they do.

**First CANDIDATE identity, superseded twice.**

| | |
|---|---|
| Branch | `feat/p3-1a-request-decision-observer` |
| **Commit** | `c567f4aea31d0f4c5d1c0928b1a2687a8d10955b` — **superseded** |
| **Tree** | `26083c066d572898533af3c9a4ff7ee7dc770448` — **superseded** |
| Base | `e2d24acd37027f436590ed8eae58bb5b30414ffb` |
| Diff | 4 files, +372 / -1 |
| Frozen cases | v3 `2535cbd934a4766a7f9ff8570f5b0e60d04b7c37430283b48e52b206c75a0b91` |

### How the observer reaches production predicates

It selects rule objects from the exported `SOURCE_CAPABILITY_RULES` and calls each rule's own
`when`. The four pure-question helpers are module-local and unexported, so going through the rule
objects is what makes **exact reuse possible without adding production exports**. The full
validator is never invoked, so no dummy SQL is fabricated.

### SQL independence is structural, not asserted

Two independent guarantees, because either alone would be an assumption:

1. **Structural exclusion** — any rule declaring `requiresAnyTables`, `forbidsTables` or
   `forbiddenSql` is rejected before evaluation.
2. **Throwing context** — `ctx.sql` and `ctx.tables` are getters that **throw**. A predicate that
   reads either is recorded `analysis_incomplete` rather than returning a value derived from a
   fabricated default. Absence of a declaration is not proof of independence.

Source filtering runs first, in production's order.

### Controls — 16 / 16

| Control | Proves |
|---|---|
| C1 | the denominator is exactly the 9 SQL-independent definitions and 21 pairs |
| C2 | no selected predicate reads `ctx.sql`/`ctx.tables`; **and** all 21 pairs return identical results under two materially different SQL inputs |
| C3 | mutating the shared production predicate flips **both** the post-SQL validator and the observer — so the observer cannot be a private copy |
| C4 | all 30 SQL/table-dependent rules excluded; adding a table dependency removes a rule from the pre-answer denominator |
| C5 | the denominator is exactly the frozen nine; a `shr`-only rule is never evaluated for a `current` request |
| C6 | disabled by default — no records, no denominator, no exclusions |

C3 is the load-bearing one: it is the only control that could distinguish reuse from a convincing
copy, and it does so by mutating the shared object and requiring both paths to move.

### Behavior unchanged

No file in `app/` or `lib/` imports the observer. It is off unless a caller opts in. Harness
accounting: **182 commands, 0 undeclared, 0 stale**. Neighbouring suites unaffected —
`test-route-eligibility` 137/137, `test-outcome-inventory` 16/16.

### A fixture inadequacy, recorded

C3 first failed with `Cannot read properties of undefined (reading 'continuousReporters')`. The
full validator evaluates **every** rule for the source, including SQL-dependent ones reading
contract fields the observer never touches. My fixture was a minimal projection. It is now
complete against the `QueryContract` **type declaration** — still hand-written, with
`buildQueryContract` never called, so the parser is never its own oracle. The fixture was
inadequate; nothing about the observer was wrong.

**Next:** execute the 63 frozen v3 cases against this frozen CANDIDATE, recording observed results
into the reserved null fields, and report expected-versus-observed applicability separately from
expected-versus-observed contract parsing.
