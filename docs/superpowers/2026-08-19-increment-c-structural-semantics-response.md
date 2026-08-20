# Increment C: proving the returned value, not the FROM clause

Eleven correction passes. `89c331b` through `06e9fe4` are unchanged; the latest is **`PENDING`**.
**Not pushed, not deployed. No data, migration, proof mode or production configuration changed.**
Production remains release `20260818_223123` running `e4a9acb`; `origin/dev` is `83a0cbb`. Jeff's
`scripts/cde-discrepancy-check.py`, `scripts/watch-rtci.log`, his untracked files and `stash@{0}`
are untouched; only owned paths were staged by exact name.

---

## Round 11: the licence now proves the predicate, and three more holes closed

Correct, and the third time this exact error has been caught in this repository: a regular
expression searched the statement for `homicide_type = 'Murder'` and treated a hit as proof. So the
check no longer lives in a hand-written regex next to the rule. It lives in **`lib/sql-restriction.ts`**,
built by extracting the prover the ORI pin already uses — which had to learn these same lessons —
and **4,620 bytes of duplicated logic came out of `query-contract-validator.ts`** in the process.
Two copies of a prover is how the two callers drift apart.

`sqlRestrictsColumnToValue(sql, column, value, {countedTable, filterTable})` accepts two shapes:
the predicate applied where the rows are counted, or the house idiom where a CTE restricts and the
counting scope INNER joins it — the same shape `cteTargetsOri` accepts, and refusing it would have
refused the shipped deterministic plan.

### Writing the tests honestly found three more holes

The six negatives went green immediately, which was the warning sign. **Mutation testing showed
five of eight guarantees uncovered — the tests were passing for the wrong reasons.** Fixing that
surfaced defects Codex's list did not name:

- **An outer join's `ON` restricts nothing.** `FROM victims v LEFT JOIN incidents i ON … AND
  i.homicide_type = 'Murder'` keeps every victim row and blanks the incident columns for the rest.
  It over-counted by exactly the rows it appeared to exclude. Same for an outer-joined CTE.
- **The predicate must live on `incidents`.** `WHERE v.homicide_type = 'Murder'` attributes the
  column to the wrong table and skips the join, and the join is half of what makes the count a
  murder count.
- **The parenthesised-`OR` false refusal**, below.

I also **removed** the multi-value-`IN` "defeating literal" scan rather than keep it. Under this
design it cannot change any outcome — a broader condition enters only through an `OR` (region
refused) or a separate region (an `AND`, which narrows) — while it *could* cause false refusals by
reading `CASE WHEN homicide_type = 'Manslaughter'` in a SELECT list as a widened filter.
`IN ('Murder', 'Manslaughter')` is refused by construction: it matches no equality. Unfalsifiable
code that looks like a safeguard is worse than none, because it invites belief in a protection that
is not there.

### The measurement that caught a wrong refusal

Run against 165 logged queries at their **actual** tab, the rule refused two correct answers
(#157, #159): a murder-filtered query that ANDs a bracketed place-alias list,
`AND (i.agency = 'New York' OR i.agency = 'New York City')`. My `OR` guard read the raw region, so
a safely-scoped `OR` sank the whole query. The test now comes **after** paren-flattening: a
top-level `OR` still refuses, a parenthesised one does not.

| | before | after |
|---|---|---|
| logged queries flagged | 8.5% | **7.3%** |
| the new rule fires on | 2 (both wrong) | **0** |

An earlier pass of this probe forced `source="shr"` on rows that were NIBRS-tab queries and
reported inflated "uncatalogued source" hits. That was an artifact of my probe, not a finding.

### Round 11 verification

| | |
|---|---|
| `test-structural-semantics.ts` | **64 passed, 0 failed** (7 new cases) |
| structural enforcement / route placement | **15** and **20**, 0 failed |
| ORI-pin regressions after the extraction | `test-query-contract`, `test-historical-county-identity`, `test-historical-county-live-paths`, `test-proof-contract`, `test-route-egress-contract`, `test-historical-deterministic-queries` — all pass |
| `tsc --noEmit`, lint | clean |
| **`npm test`** | **exit 0**, 2,623 lines, all **17** tallies `0 failed` |
| **mutations** | **10 of 10 caught**, no skips |

The harness refused a stale anchor when my own edit moved it, rather than reporting a false pass —
which is the behaviour that made the five uncovered guarantees visible in the first place.

No wall-clock flakes appeared in these runs. The two pre-existing ones
(`test-nibrs-deterministic-queries`, `test-nibrs-place-resolver`) remain worth their own increment.

---

## Round 10 (`06e9fe4`): a documented limitation that still authorizes the wrong answer

The last surviving `eventRow` was still too broad, and the shape of the mistake is worth naming: **I
wrote the limitation into a note and then let the code authorize the thing the note said was wrong.**
That is not a limitation; it is a hole with a comment attached.

`shr.victims` is one row per **homicide** victim, and murder is a subset. The product contract is
explicit — `shr-claude.ts:123`: *"Always JOIN to the victims table and count victims … Use `COUNT(*)`
on the joined result"* — and every example in that prompt filters `i.homicide_type = 'Murder'`. So the
licence is now conditional:

```ts
eventRow: { topics: [...], requiresFilters: [{ column: "homicide_type", value: "Murder" }] }
```

Declared as **data**, not as another hand-written rule. `homicide_type` lives on `incidents`, so
requiring the filter also requires the join.

**On the offered fallback**: "conservatively require `COUNT(v.id)` and reject `COUNT(*)`" would have
contradicted the prompt's own examples, which all use `COUNT(*)` on the joined result. Taking the
conditional route means **no prompt example needs changing** — I checked every one.

### Two consequences

Row-count detection had to widen: `COUNT(v.id)` names a column, so it escaped the check entirely even
though `id` is an identifier and the value is still a row count. It now counts as one when every
referenced column is a dimension.

Widening that **broke four rate tests**, and the reason is worth keeping: a division is a **rate**,
and the denominator rule owns it. `COUNT(*) * 100000.0 / population` uses a row count as its
numerator but is not itself a row count, and claiming it here short-circuited the check that actually
governs it.

| Case | Verdict |
|---|---|
| `COUNT(*) FROM victims` unfiltered | **refused** — `structural-row-count-unqualified` |
| `COUNT(v.id) FROM victims` unfiltered | **refused** |
| `COUNT(*) FROM incidents` | **refused** — `structural-row-count-not-a-measure` |
| `COUNT(v.id) … JOIN incidents … homicide_type = 'Murder'` | clean |
| the prompt's own example, verbatim | clean |

### Round 10 verification

| | |
|---|---|
| `test-structural-semantics.ts` | **62 passed, 0 failed** |
| `test-structural-enforcement.ts` | **15 passed, 0 failed** |
| `test-structural-route-placement.ts` | **20 passed, 0 failed** |
| `test-shadow-route-equivalence.ts` | **28 passed** |
| `test-layer3-contract-corpus`, `test-shr-deterministic-murder`, `test-source-capabilities` | green |
| `tsc --noEmit` | clean |
| lint | clean on all owned files |
| **`npm test`** | **exit 0**, 2,621 lines, all **17** tallies `0 failed` |

**Thirty-two mutations, no skips, none uncovered.**

**Two pre-existing wall-clock flakes** seen this session, neither related to this work and neither
importing it: `test-nibrs-deterministic-queries` — *"500 local plan compilations under one second"*,
measured 1604 ms — and `test-nibrs-place-resolver` — *"500 cached resolutions under 100 ms"*, where 2
of 3 isolated runs pass. Both are roughly 0.2 ms/op budgets that lose to background load, and both
will keep producing false failures until someone loosens or removes them.

---

## Round 9 (`e0df3d0`): eventRow must mean the PRODUCT's measure


Three of the four declarations were wrong, and each contradicted a definition already in this
repository:

| Table | Why it fails |
|---|---|
| `summary_domestic_violence` | one victim-offense per row, but the product counts **DISTINCT incidents** — `query-contract.ts:165`, and the guardrail's own SQL at `guardrails.ts:198` |
| `hate_crime_incidents` | `hc-claude.ts:23` calls `COUNT(*)` here **`offense_count`**, and names `COUNT(DISTINCT incident_number \|\| ori \|\| year)` as the **default** |
| `shr.incidents` | one homicide **incident** per row — the review asked me to confirm rather than assume, and it fails: `shr-claude.ts:17` gives the SHR default as murder **victim** counts, `situation` records multi-victim incidents explicitly, and the deterministic plan computes `COUNT(v.id)` from `victims` |

**Only `shr.victims` survives** — one row per victim, and victims *is* the measure. Its known limit
is recorded rather than hidden: an unfiltered count there is homicide victims, of which murder is a
subset, because `homicide_type` is a filter concern and is not modelled.

The field's documentation now states the test as **one physical row equalling one user-facing
occurrence**. Reading it as "the row describes something occurrence-related" is what produced three
wrong entries from one plausible-sounding idea.

### Two consequences found by running, not reasoning

- Two tests used an SHR `incidents` `COUNT(*)` purely as a convenient clean baseline, so they had
  been passing for a reason unrelated to what they test. Both now use `victims`.
- The **shadow-equivalence fixture** used `COUNT(*) AS incidents` on `hate_crime_incidents` — the
  exact shape now refused — which forced a re-translation and broke the cache-equivalence invariant
  (*"enabling shadow can change SQL, rows, narrative and charts"*). That fixture is about caching,
  not SQL validity, so it now uses the product's own default pattern.

Also fixed: `warnings.push("structural-" + ruleId)` double-prefixed every structural warning, since
the ids already start with `structural-`. The logs read `structural-structural-row-count-not-a-measure`.

### Round 9 verification

| | |
|---|---|
| `test-structural-semantics.ts` | 61 then; **62** now |
| `test-structural-enforcement.ts` | **15 passed, 0 failed** |
| `test-structural-route-placement.ts` | **20 passed, 0 failed** |
| `test-shadow-route-equivalence.ts` | **28 passed** |
| `test-layer3-contract-corpus`, `test-shr-deterministic-murder`, `test-source-capabilities` | green |
| `tsc --noEmit` | clean |
| lint | clean on all owned files |
| **`npm test`** | exit 0 at 2,620 lines then; **2,621** now |

**Thirty mutations, no skips, none uncovered** — including a new one that restores `eventRow` on
`hate_crime_incidents` and fails two cases.

---

## Round 8 (`73ce8ef`): a row count is a measure only where one row IS the occurrence


All three cases reproduced first and returned no enforcement.

`historical_agency_crime` has one row per agency-**year**, so `COUNT(*) AS murders` counts
agency-years. SHR `incidents` has one row per homicide, so there the same expression is a real
murder count. **Nothing in the catalog recorded that difference**, and "the table's role is metric"
cannot stand in for it.

`eventRow` now states, per table, that one row is one occurrence of named topics. It is set on
exactly four — SHR `incidents` and `victims`, `hate_crime_incidents`, and the NIBRS
domestic-violence summary (one row per victim-offense in the live schema). Everything else is
pre-aggregated, so counting its rows counts buckets.

**That fell out immediately**: `COUNT(*)` over `agency_monthly` — one agency-month-offense bucket
per row — is now caught too. The review did not ask for it; it is the same defect.

### Two causes, both fixed

| Cause | Effect |
|---|---|
| A non-`COUNT` expression with no column references was classified as carrying no measurement | `SUM(1) AS murders` and `SELECT 5 AS murders` never reached any check |
| Topic completeness exited when no topic column had been selected | precisely the case that needs to fail |

`numericWithoutColumns` now marks any aggregate or constant with no lineage as a measurement claim,
and completeness runs whenever a factual series is **attributed** to the table.

The two rules are **separate guarantees and are asserted separately** — these expressions must fail
the row-count binding *and* completeness. An earlier version of the test asserted only the first,
and the mutation run caught that the second was uncovered.

### Round 8 verification

| | |
|---|---|
| `test-structural-semantics.ts` | 59 then; **61** now |
| `test-structural-enforcement.ts` | **15 passed, 0 failed** |
| `test-structural-route-placement.ts` | **20 passed, 0 failed** |
| `test-layer3-contract-corpus`, `test-shr-deterministic-murder`, `test-source-capabilities` | green |
| `tsc --noEmit` | clean |
| lint | clean on all owned files |
| **`npm test`** | exit 0 at 2,622 lines then; **2,620** now |

**Twenty-nine mutations, no skips, none uncovered.**

---

## Round 7 (`ba5e103`): one placement error, two localized causes


Both reproduced first. The diagnosis was exactly right.

**The refusal sat after the `topic_columns` branch**, so Current Trends, SHR and NIBRS kept
answering *"What share of Chicago murders occurred in 2020?"* with a raw total. It now runs against
every factual metric source, **before** any branch on `measureBinding.kind`; topic/unit completeness
stays specific to `topic_columns`.

**`tablesInPlay` was built from column references alone**, so `COUNT(*)` — which has none —
contributed no table and escaped the check entirely. It now uses the same rule as the per-item loop:
column lineage where there is any, otherwise the statement's base tables.

`ratio` remains deliberately unsupported rather than guessed. This widens **where** the refusal
applies; it does not invent numerator and denominator semantics.

### A finding about the harness, not the code

Both new mutations first reported **"NO TEST FAILED"**, and neither report was true. The anchor
`const tables = item.refs.length > 0 ? … : lineage.baseTables` now appears **twice**, so
`replace(…, 1)` mutated the per-item loop instead of the completeness block and the real guarantee
was never disturbed.

A non-unique anchor reports a covered guarantee as uncovered — and could as easily report an
uncovered one as covered, which is the direction that actually matters. **The harness now refuses an
ambiguous anchor outright.** This is the fourth time an anchor has silently disarmed a mutation;
refusing ambiguity is the durable fix rather than another manual repair.

### Round 7 verification

| | |
|---|---|
| `test-structural-semantics.ts` | 55 then; **59** now |
| `test-structural-enforcement.ts` | **15 passed, 0 failed** |
| `test-structural-route-placement.ts` | **20 passed, 0 failed** |
| `test-layer3-contract-corpus`, `test-shr-deterministic-murder`, `test-source-capabilities` | green |
| `tsc --noEmit` | clean |
| lint | clean on all owned files |
| **`npm test`** | exit 0 at 2,616 lines then; **2,622** now |

**Twenty-six mutations, no skips, none uncovered, no ambiguous anchors.**

---

## Round 6 (`4955243`): an unmodeled unit must not borrow another unit's columns


Reproduced first: *"What share of Chicago murders occurred in 2020?"* is classified `ratio`, and
`SELECT hac.murder AS share` passed with **no enforcement**. "percentage" and "percent" behaved
identically.

**The cause was a default.** `unitKeyOf` folded every unrecognised unit into `count`, so a share
inherited the count requirement and a raw total satisfied it.

Unit resolution is now three-way:

| | |
|---|---|
| `modeled` | the catalog states what this unit requires |
| `unspecified` | no measure claim to check |
| `unmodeled` | a real unit we cannot yet express — **fails closed** |

An unmodeled unit produces a retry asking for the underlying counts or a plain statement that this
cannot be computed, then the existing second-failure gate. `topicUnitRequirement` returns `null` for
anything not modeled, so no unit can borrow another's columns even by accident.

**`ratio` is deliberately not added as a supported unit.** Doing that would mean inventing numerator
and denominator semantics, and a catalog that guesses is worse than one that declines — so the
positive case waits until both sides are structurally represented.

### Round 6 verification

| | |
|---|---|
| `test-structural-semantics.ts` | 52 then; **55** now |
| `test-structural-enforcement.ts` | **15 passed, 0 failed** |
| `test-structural-route-placement.ts` | **20 passed, 0 failed** |
| `test-layer3-contract-corpus`, `test-shr-deterministic-murder`, `test-source-capabilities` | green |
| `tsc --noEmit` | clean |
| lint | clean on all owned files |
| **`npm test`** | exit 0 at 2,613 lines then; **2,616** now |

**Twenty-four mutations, no skips, none uncovered.** Restoring the count default fails two cases;
removing the finding fails one.

**One flake, recorded rather than hidden.** An earlier full run failed
`test-nibrs-deterministic-queries.ts` on *"500 local plan compilations should stay under one second;
took 1604.2ms"*. That test imports none of this work and passes 3/3 in isolation — the assertion is
a wall-clock budget that loses to background load. Pre-existing, not introduced here, and worth
someone's attention separately.

---

## Round 5 (`e08c761`): the unit dimension, and where a composite lives


Both cases reproduced through `validateQueryContractSql()` first, each returning no enforcement.

### A measure is a topic AND a unit

Keying requirements by offense alone made `murder` and `murder_rate` interchangeable alternatives of
one topic. They are not — they are different measures that share a name stem:

| Asked | Returned | Old verdict |
|---|---|---|
| "How many murders?" | `murder_rate AS murders` | passed |
| "the murder rate" | `murder AS murder_rate` | passed |

Requirements are now keyed by **topic and unit**, and each unit distinguishes two ways of being
satisfied:

```ts
type UnitRequirement = {
  direct?: MeasureRequirement;      // columns that ARE this measure
  derivedFrom?: MeasureRequirement; // columns that can produce it, given a bound denominator
};
```

A per-capita rate derived from counts is valid **exactly when the division binds an approved
denominator** — which `structural-rate-denominator-unbound` already proves — so that dependency is
now written down rather than assumed. `historical_state_national` says murder is `murder` as a
count and `murder_rate` as a rate, derivable from `murder`. `historical_agency_crime` holds counts
only, so a rate there is always derived.

### A composite lives in one expression

Completeness was pooled across every returned series, so this counted as a violent-crime total:

```sql
SELECT year, murder, rape, robbery, assault FROM historical_agency_crime ...
```

It is four offense series. A composite must now be satisfied **within one expression**, while each
requested topic is still looked for **across** expressions — so a multi-offense question may keep
one expression per offense, and only the combination has to be combined.

### Round 5 verification

| | |
|---|---|
| `test-structural-semantics.ts` | 49 then; **52** now |
| `test-structural-enforcement.ts` | **15 passed, 0 failed** |
| `test-structural-route-placement.ts` | **20 passed, 0 failed** |
| `test-layer3-contract-corpus`, `test-shr-deterministic-murder`, `test-source-capabilities` | green |
| `tsc --noEmit` | clean |
| lint | clean on all owned files |
| **`npm test`** | exit 0 at 2,608 lines then; **2,613** now |

**Twenty-two mutations, no skips, none uncovered.** Removing the unit key fails six cases; pooling
composites again fails one; dropping the derived-rate denominator requirement fails one. One
intermediate `SKIP` came from this rewrite moving its own anchor, and was fixed.

**Impact**: 6.2% flagged, 0.2% blocked (802 sampled, every 8th answered query — the every-4th run
exceeded its time limit). The new rules account for 12 of 50 flags:
`structural-measure-incomplete` 7, `structural-measure-unavailable` 5.

---

## Round 4 (`3ba2d2e`): what a measure REQUIRES, not which columns are allowed


All five cases reproduced through `validateQueryContractSql()` first, each returning no enforcement.

### The design change

The review was right that another allowed-set patch would recreate the defect. A flat list can only
answer *"is this column permitted"*, and two real failures lived in the gap between that and what a
measure actually requires:

| Asked | Returned | Old verdict |
|---|---|---|
| murders **and** robberies | `murder AS murders` | passed |
| violent crime | `murder AS violent_crime` | passed |

`MeasureRequirement` is now typed:

```ts
type MeasureRequirement =
  | { kind: "all"; columns: string[] }              // every column required
  | { kind: "any"; alternatives: MeasureRequirement[] }   // one alternative suffices
```

Violent crime is `any(all("violent"), all("murder", "rape", "robbery", "assault"))` — the stored
total **or** the complete component set, never one component standing in for the whole.

**Membership and completeness are now separate questions, asked separately.** Completeness is judged
**once per table across every returned series**, because a multi-offense request legitimately puts
each offense in its own select item — a per-item check would fail both halves of a correct answer.

### Compound CTE arms align by position

SQL aligns arms positionally. Merging by each arm's own alias filed
`SELECT robbery AS anything` under `anything`, so `x.murders` never saw the robbery at position 2.

### All four SQLite quotings

Recognising only bare and `"double"` let `[hac].*` and `` `hac`.* `` through untouched.

### The placement test accepted the injection it exists to catch

`db.prepare(
  unguardedSql
)` passed, because an empty same-line argument was treated as a
literal continuation. It now looks ahead, and a **synthetic multiline mutation proves it**.

### Round 4 verification

| | |
|---|---|
| `test-structural-semantics.ts` | 44 then; **49** now |
| `test-structural-enforcement.ts` | **15 passed, 0 failed** |
| `test-structural-route-placement.ts` | **20 passed, 0 failed** |
| `test-layer3-contract-corpus`, `test-shr-deterministic-murder`, `test-source-capabilities` | green |
| `tsc --noEmit` | clean |
| lint | clean on all owned files |
| **`npm test`** | exit 0 at 2,601 lines then; **2,608** now |

**Nineteen mutations, no skips, none uncovered.** Two intermediate `SKIP`s came from my own
refactors moving their anchors; both fixed rather than left.

**Impact**: 6.3% → **6.5%** flagged, blocks steady at **0.3%**. The new completeness rule accounts
for 6 of 104 flags.

---

## Round 3 (`d4755ec`): the same fail-open one level deeper


All four reproduced through `validateQueryContractSql()` first, each returning no enforcement.

### Compound SQL: refusing it was wrong, reading it is right

The check ran over the outer statement only, so a `UNION ALL` **inside a CTE** laundered its second
arm into the outer select. Refusing every compound closed that — and flagged **150 of 1,605 sampled
production queries, 140 of them legitimate**, mostly the documented NIBRS pattern of combining
victim summaries (person crimes) with offense summaries (everything else).

A 9% coverage loss for no correctness gain is not a fix. **Every arm is now read.** The laundering
case is caught on its merits by the measure rule, honest unions pass, and the recursive month
generator in the SHR deterministic murder plan stops being collateral damage.

That exposed two further defects, both mine:

- The measure check fired only when **no** selected column matched the request, so an arm could
  smuggle `robbery` in *beside* `murder` under one label. It now fires on any column belonging to a
  different offense, judged against **every** offense the question asked for rather than the first.
- An **unqualified** column drawn from a CTE resolved straight to the single base table, inventing
  `historical_agency_crime.murders`. The arm stayed invisible even once arms were being read.

### Wildcards after a quantifier or with quoted aliases

`SELECT DISTINCT *` and `SELECT "hac".*` both passed. A leading `DISTINCT`/`ALL` is stripped and
quoted aliases are recognised.

### Nested CTE column lists

`cteOutputs()` recursed **without forwarding** `columnLists`, so an `x(m)` → `y(murders)` chain lost
the positional mapping and laundered the measure one level down.

### Route placement: proved, not asserted

Two holes, both fatal to the claim:

- the inventory only examined expressions containing `.sql`, so `db.prepare(unguardedSql)` — a bare
  identifier — was silently ignored;
- the model-path check counted the `validateQueryContractSql(` call **inside the helper's own
  definition** as an invocation of it, so a route could "validate" without ever calling it.

The test now classifies the argument of **every** execution helper in every handler and fails on
anything it cannot place; requires a real invocation rather than a declaration; and checks that
every assignment to the executed variable comes from a recognised source. **Two synthetic mutations
prove it**: an injected `db.prepare(unguardedSql)` and an assignment from an unvalidated source each
fail it.

### The egress-only exception, stated plainly

The agency scorecard and the Historical place lookup run SQL **inside a helper** and are proved
before **delivery**, not before execution. A refused result is never sent, which prevents the wrong
answer — but it is not the pre-execution contract the rest of the file asserts, and calling it one
would be false. It is recorded as an explicit exception with its own tests.

### Round 3 verification

| | |
|---|---|
| `test-structural-semantics.ts` | 40 then; **44** now |
| `test-structural-enforcement.ts` | **15 passed, 0 failed** |
| `test-structural-route-placement.ts` | **20 passed, 0 failed** |
| `test-layer3-contract-corpus.ts`, `test-shr-deterministic-murder.ts` | green |
| `tsc --noEmit` | clean |
| lint | clean on all owned files |
| **`npm test`** | exit 0 at 2,595 lines then; **2,601** now |

**Fifteen mutations, no skips, none uncovered.** An intermediate run reported two `SKIP`s from my
own stale anchors and one `NO TEST FAILED`; both are fixed rather than ignored.

**Impact improved**: 7.1% flagged → **6.3%**, blocks steady at **0.3%**, and
`structural-unsupported-sql-shape` disappears entirely.

| rule | flags |
|---|---:|
| `structural-returned-series-unresolved` | 32 |
| `structural-row-level-substitution` | 18 |
| `structural-non-factual-source` | 17 |
| `structural-rate-denominator-unbound` | 10 |
| `structural-measure-unavailable` | 9 |
| `structural-measure-substitution` | 6 |
| `structural-clearance-not-aggregatable` | 5 |
| `structural-time-grain-unavailable` | 5 |
| `structural-uncatalogued-factual-source` | 2 |
| `structural-wildcard-projection` | 1 |

---

## Round 2 (`24e251f`): four gaps, all reproduced first


Each returned **no finding at all** through the validator before the fix.

### 1. Compound queries were half-checked

Only the first arm was read, so a second arm returning `robbery` under the label `murders` passed
unexamined. **Refused rather than parsed** — teaching the analyzer to fully understand `UNION` is a
much larger change than this guarantee is worth, and the review asked for the smallest safe
correction.

### 2. Wildcard projections failed open

`SELECT hac.*` produced no column references, was classified as carrying no measurement, and
returned clean. A wildcard is now factual by definition and fails closed.

Narrowing that took two attempts: the first read the `*` in `COUNT(*) * 100000.0 / population` as a
projection and flagged **every rate in the suite**. A projection wildcard is the whole item or
`alias.*`; anything else is multiplication.

### 3. CTE column lists were discarded

```sql
WITH x(murders) AS (SELECT robbery FROM historical_agency_crime) SELECT x.murders FROM x
```

The declared list was thrown away, so `x.murders` resolved to a column that does not exist and no
offense check could match it. Declared names are now mapped **positionally** onto the CTE body, so
`x.murders` resolves to `robbery` — the substitution is **caught**, not merely refused.

### 4. Route coverage was one pattern in one route

The NIBRS deterministic branch executed with no structural validation, and the old placement test
could not have seen it. It now enumerates every factual execution helper —
`executeWithTimeout`, `executeWithTimeoutSync`, `*.prepare` — across all four routes and classifies
what each executes: a contract result, or a plan guarded before its execution line. Anything else
fails.

**Running that stronger test immediately found two more unguarded factual paths I had missed**: the
agency scorecard and the Historical place lookup. Both build SQL inside a helper, so their proof
sits at the delivery boundary — a refused result is never sent.

### Two supporting fixes

- `rollup.national_summary_...` is one table in an ATTACHed database, and the parser read `rollup`
  as the table name. That would have refused a working NIBRS plan. Schema-qualified names now
  resolve, and the **eighteen rollup tables are catalogued from the live schema**.
- One assertion from `89c331b` still demanded **silence** for an uncatalogued table — precisely the
  behaviour the previous review rejected. It is inverted.

### Round 2 verification

| | |
|---|---|
| `test-structural-semantics.ts` | 36 then; **40** now |
| `test-structural-enforcement.ts` | **15 passed, 0 failed** |
| `test-structural-route-placement.ts` | 16 then; **20** now |
| `tsc --noEmit` | clean |
| lint | clean on all owned files |
| **`npm test`** | exit 0 at 2,585 lines then; **2,595** now |

**Ten mutations, each failing only its own cases** — compound refusal, wildcard, CTE column list,
NIBRS guard, scorecard delivery guard, series lineage, denominator, measure binding, uncatalogued
table, geography.

**Measured, not assumed**: 15/15 NIBRS plan-path and 12/12 scorecard/place-lookup production answers
pass cleanly. Sampling every fourth answered query: **7.1% flagged, 0.3% blocked**; the three new
rules account for 9 of 114 flags.

| source | sampled | flagged | % | block |
|---|---:|---:|---:|---:|
| current | 348 | 16 | 4.6% | 0 |
| historical | 435 | 30 | 6.9% | 5 |
| nibrs | 450 | 35 | 7.8% | 0 |
| shr | 282 | 19 | 6.7% | 0 |
| hate_crime | 90 | 14 | 15.6% | 0 |
| **all** | **1,605** | **114** | **7.1%** | **5** |

---

## Round 1 (`0d16004`): lineage instead of table presence

### All four blockers reproduced against `89c331b` first

Every one passed clean before any code was written:

| Blocker | Probe against `89c331b` |
|---|---|
| 1. decorative denominator | `COUNT(*) * 100000.0 / i.population` with `state_population` joined and unused — **no finding** |
| 1b. mixed series | one compatible table joined, the series drawn from an incompatible one — **no finding** |
| 2. cross-offense | `SELECT hac.robbery AS murders` for a murder question — **no finding** |
| 3. uncatalogued source | `SELECT COUNT(*) AS murders FROM source_build_receipts` — **no finding** |
| 4. route reachability | `runContractValidation` defined at ~1332; three plans execute at ~936, ~992, ~1116 |

### 1. Lineage, not table presence

`lib/sql-lineage.ts` resolves each returned expression to the base tables its columns actually come
from: through aliases, through CTEs by reading the CTE's **own select list**, and — for a division —
the denominator side separately. `structural-semantics.ts` then evaluates **each factual series
independently**. Anything untraceable is a finding, never a pass.

Getting there fixed four analyzer bugs, each found by replaying real production SQL rather than by
reasoning:

1. `count` is a real column in `agency_monthly`; treating it as a function name meant `SUM(count)`
   resolved to nothing and the series escaped evaluation entirely.
2. A scalar subquery in the select list brings its own `FROM`; without those aliases a legitimate
   city-versus-national comparison failed closed.
3. `VALUES` CTEs read no table at all — the SHR murder plan uses several — so their columns are
   literals, not unresolved references.
4. A CTE column needs narrowing by role, and where two metric tables are joined, by reading the
   CTE's select list. `counts AS (… COUNT(v.id) AS murder_victims …)` resolves to `victims`.

**Mixed series.** A coarser series is licensed only when the question names that level in words
**and** another series in the same query serves the requested level. Both conditions matter: without
the second, "top 10 us cities" would license `national` from the word "us" and slip through again.

### 2. Measure meaning, and typed aggregation

The catalog now separates three things `89c331b` conflated:

| Field | Meaning |
|---|---|
| `rowKey` | the **physical** grain. `summary_city_monthly` carries `ori`, so its rows are agencies. |
| `outputLevels` | what the table may legitimately **produce**. This is what enforcement compares. |
| `measureBinding` | how a requested offense maps onto real columns or code predicates. |

Offense binding is enforced where the selected **column is itself the claim** (`topic_columns`), so
`hac.robbery AS murders` is caught. Column names are taken from the live schema, including the trap
that `historical_agency_crime` spells it `assault` while `historical_state_national` spells it
`aggravated_assault`. NIBRS `ucr_offense_code` and Current Trends `offense` are code/value
predicates, and are **left to the existing offense-code validation** rather than duplicated into a
competing vocabulary — that is a deliberate gap, stated below.

Aggregation safety is now the typed pair `components: "present" | "absent"` and
`aggregation: "additive" | "not-aggregatable"`, replacing a regex over a human-readable note.
Exactly two tables carry `components: "absent"`:

```
historical.national_clearance_rate       outputLevels=[national]
historical.historical_agency_clearance   outputLevels=[agency, city]
```

### 3. Uncatalogued sources fail closed — after measuring what that costs

The first catalog would have blocked **68.7% of answered NIBRS queries** (1,176 of 1,711), because
44 real tables were missing. Failing closed was only safe after cataloguing them from live schemas:

| source | tables | metric | identity | population | crosswalk | support |
|---|---:|---:|---:|---:|---:|---:|
| current | 9 | 3 | 1 | 1 | 1 | 3 |
| historical | 8 | 5 | 1 | 1 | 1 | 0 |
| nibrs | **50** | 33 | 1 | 1 | 2 | 13 |
| shr | 7 | 2 | 2 | 1 | 1 | 1 |
| hate_crime | 7 | 5 | 0 | 0 | 0 | 2 |
| **total** | **81** | 48 | 5 | 4 | 5 | 19 |

**Measured impact, sampling every fourth answered query (1,605 of 6,456):**

| source | sampled | flagged | % | of which block |
|---|---:|---:|---:|---:|
| current | 348 | 11 | 3.2% | 0 |
| historical | 435 | 28 | 6.4% | 5 |
| nibrs | 450 | 37 | 8.2% | 0 |
| shr | 282 | 18 | 6.4% | 0 |
| hate_crime | 90 | 14 | 15.6% | 0 |
| **all** | **1,605** | **108** | **6.7%** | **5 (0.3%)** |

Hand-checking that sample found three more false positives, all fixed: the agency directories really
do carry a `population` column that real city-rate queries divide by; an unknown requested level has
nothing to check a denominator against; and `population` selected beside a measure is context, not
the measure. That took the flag rate from 9.2% to 6.7%.

The largest remaining bucket is `structural-returned-series-unresolved` (36 of 108) — the analyzer
failing closed on shapes it cannot trace. Those are retries, not blocks.

### 4. Route reachability, proved by placement

`runContractValidation` is defined at ~line 1332 of `app/api/query/route.ts`, and three deterministic
plans executed and returned before it existed. Each now calls `deterministicPlanRefusal` **before**
`db.prepare`, and a refused plan is simply not used — the request falls through to the model path,
which validates in full. A deterministic plan cannot be retried, so any finding is a refusal.

`scripts/test-structural-route-placement.ts` reads the route sources and asserts guard-before-execute
by line number, that every `db.prepare(<plan>.sql)` belongs to a guarded variable, and that the SHR
murder plan still validates before executing. **All 21 deterministic plans replayed from the log pass
cleanly**, so this gate is expected to be silent; it exists so a future builder edit cannot
reintroduce the substitution.

### 5. `detectRequestedGrain` reused

`requestedScope()` no longer carries its own monthly/annual parser; it calls the existing detector,
so the pre-execution check and `validateGrain()` cannot disagree. `validateGrain()` stays as the
post-result backstop.

### Verification

| | |
|---|---|
| `test-structural-semantics.ts` | 31 at the time; **36** now |
| `test-structural-enforcement.ts` | **15 passed, 0 failed** |
| `test-structural-route-placement.ts` | 10 at the time; **16** now |
| `test-layer3-contract-corpus.ts` | green |
| `tsc --noEmit` | clean |
| `npm run lint` | **clean on all owned files** (90 problems elsewhere, pre-existing; `route.ts`'s `retrySql`/`dbStart` warnings exist on `origin/dev` too) |
| **`npm test`** | exit 0 at 2,568 lines then; **2,585** now |

### Mutations — six guarantees, each failing only its own cases

| Mutation | Result |
|---|---|
| returned-series lineage no longer fails closed | 1 failure |
| denominator no longer traced | 2 + 1 |
| offense column no longer checked | 1 |
| uncatalogued table allowed | 1 |
| geography no longer compared | 9 + 4 |
| deterministic route guard removed | 1 (placement) |

**The first mutation run reported "NO TEST FAILED" for returned-series lineage.** My existing test
used an unparseable statement, which trips the whole-statement guard, not the per-series one. A case
was added — a CTE joining two metric tables leaving a column role-narrowing cannot resolve — and the
mutation now fails it.

## Known gaps, restated after round 10

0. **`ratio` and `percentage` requests cannot be answered at all**, only declined. Supporting them
   means modelling a numerator and a denominator per topic — real work, deliberately not guessed.


1. **`structural-returned-series-unresolved` is the largest bucket** (33 of 104). Each is a retry.
   Reducing it means extending the analyzer, not relaxing it.
2. **Offense binding covers `topic_columns` only.** NIBRS code predicates and Current Trends value
   predicates are left to the existing offense-code validation, per the instruction not to build a
   competing vocabulary.
3. **Hate Crime has the least verified semantics** of any source and warrants a targeted pass.
4. **The row-level cues remain four regexes over the question.** Intent exists only as text; a miss
   falls back to `contract.geography.kind`, which is HEAD's behaviour.
5. **The scorecard and place lookup are egress-only**, not pre-execution. Refactoring them into
   plan-then-execute is the durable fix and is not attempted here.
6. **Assignment provenance is not dataflow.** The placement test proves every assignment to the
   executed variable comes from a recognised source; it does not prove the specific value reaching
   `db.prepare` was validated. Following a chain of post-validation rewrites is beyond a
   source-reading test, and the limitation is recorded in the file itself.

## Superseded gap list from round 2

1. **Compound queries are refused, not understood.** 8 of 114 sampled flags. A legitimate `UNION`
   now costs a retry.
2. **Offense binding covers `topic_columns` only.** NIBRS code predicates and Current Trends value
   predicates are left to the existing offense-code validation, per the instruction not to build a
   competing vocabulary.
3. **`structural-returned-series-unresolved` is the largest bucket** (32 of 114). Each is a retry.
   Reducing it means extending the analyzer, not relaxing it.
4. **Hate Crime flags at 15.6%**, the highest of any source on a 90-query sample, and has the least
   verified semantics. Worth a targeted pass.
5. **The row-level cues remain four regexes over the question.** Intent exists only as text; a miss
   falls back to `contract.geography.kind`, which is HEAD's behaviour.
6. **Support tables as a sole factual source** — a coverage figure read only from
   `nibrs_national_coverage` is flagged non-factual. Arguably correct, but it will affect legitimate
   coverage answers.

Returning for review. No push, no deploy.

## What I did not do

No identity-schema work, no proof activation, no outcome logging, no latency work, no release work,
no push, no deploy. The resolved-ORI restriction, county clarifier, SHR/NIBRS capability blocks and
the authoritative label are untouched and still asserted in `test-structural-enforcement.ts`.

Returning for review.
