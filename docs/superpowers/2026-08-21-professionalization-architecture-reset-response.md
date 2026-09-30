# Professionalization architecture reset — response

**Date:** 2026-08-21 · **Mode:** design and read-only review only · **Author:** Claude

Nothing implemented, installed, committed, pushed, deployed, or migrated. No configuration, flag,
schedule, or production write. `df74915` untouched. The main checkout, its CRLF refresh working copy,
Jeff's modified and untracked files and `stash@{0}` are untouched.

**Read-only inspection worktree:** `C:\tmp\cda-lifecycle-design`, branch `design/decision-lifecycle`,
at `origin/dev` `541f2e5`. This response document is written untracked into the main checkout at the
path the base handoff specifies; it is the only file this task creates.

Every material statement below is labelled **[V]** verified, **[I]** inferred, or **[P]** proposed.

> **Revision 2 — 2026-08-21.** Revised in place after review. Preserved unchanged: the three-layer
> planning model and amendment protocol (§0), reuse of `DeliveryAction` (§5), observability before
> enforcement, the fifth embed surface, and holding `df74915` (§10). Corrected: the roadmap now spans
> the whole professionalization programme rather than the request lifecycle (§7); checkout determinism
> and clean-checkout CI now precede lifecycle *implementation*; observability is split into five
> increments with proof enforcement kept separate; the embed finding is reframed around
> re-execution-without-current-proof with a measurement gate before any access change (§3 C1, §7 P5,
> §9); the factual-execution gateway now has an explicit boundary, invariant, and exclusion list
> (§5.2); the target architecture gains supply-chain, semantic-registry, identity, runtime-control-plane,
> security and operations sections (§5.3–§5.7); and Stage 2 has a bounded, closed completion definition
> (§13).
>
> **This is the last architecture-level pass.** Subsequent discoveries use the §0 amendment protocol.
> A discovery that would reopen §5 requires an ADR naming the failed foundational assumption.
>
> **Revision 3 — 2026-08-21. ACCEPTED AS THE ARCHITECTURE BASELINE.** Four bounded **L3** roadmap
> amendments applied; **no L1 or L2 change**, and no new review performed:
>
> 1. **Scheduler isolation promoted to P0.2** (from Phase 8) — a live operational dependency that has
>    already caused a failed production refresh does not wait behind data-build architecture.
> 2. **Stage 2 S2-1 now requires build evidence for all five production sources.** P8.1 is explicitly
>    the **pilot**; "Stage 2 complete" cannot coexist with four unevidenced source-health verdicts.
> 3. **Typed-outcome acceptance raised from ≥99% to 100%** of *eligible* terminal factual exits, with
>    every exclusion named and justified. A named technical exclusion is acceptable; an unclassified
>    residue is not.
> 4. **P1.3's treatment of the 111 scripts corrected.** The auditor reported *"failure tracking not
>    detected"* — a limit of static recognition, not a defect verdict. P1.3 now inventories and
>    classifies them and proves a runner contract by mutation-testing representative failure paths,
>    instead of prescribing mechanical edits to 111 files on an unverified premise. This corrects an
>    overreach of mine.
>
> **Status: BASELINE.** Planning is closed. Execution begins at **P0.1** (observe the 2026-08-22 03:00
> NIBRS refresh) and **P0.2** (scheduler isolation), then **Phase 1**. From here, ordinary discoveries
> are governed solely by the §0 amendment protocol: they amend one increment. Reopening §1–§5 requires
> an ADR that names the failed L1 principle or L2 foundational assumption. **No further system-wide
> reset.**

---

## 0. How to read this: three layers, and what it costs to change each

The additional requirement — that future discoveries normally change one bounded increment rather
than the plan — is met structurally, not by intention. Three layers, three different costs of change.

| layer | contents | to change it |
|---|---|---|
| **L1 — product constitution** | the frozen correctness principles | evidence that a principle is **impossible or unsafe**, plus Jeff's approval. Not revisable by an increment. |
| **L2 — target architecture** | component boundaries, ownership, data flow, trust boundaries | an **ADR** plus evidence that a *foundational assumption failed*. Not revisable by a discovered case. |
| **L3 — adaptive roadmap** | sequencing, estimates, per-increment contracts | revise freely, one increment at a time, no ADR |

The failure this structure is designed against is the one this project has actually experienced: a
single discovered case (a qualified star, a no-SQL path) triggering a whole-plan reset. Four of the
last five direction changes were L3 events handled as L1/L2 events. **[I]**

### Amendment protocol (normative)

| trigger | response | may touch |
|---|---|---|
| discovered case **inside** an existing invariant | add a regression, continue | L3 only, no contract change |
| new scope, policy, or user-visible behaviour | revise **that increment's** contract before implementing | L3 |
| **second** defect of the same architectural class in one increment | **stop that increment**, reassess its component design | L3, and L2 only for that component |
| evidence disproving a **cross-system foundational assumption** | ADR, reopen L2 | L2 |
| anything else | **do not perform another system-wide reset** | — |

The third row is the rule that produced the correct SHR deferral. It is the one with a track record,
and it is deliberately scoped to *one component* so a stop does not halt the programme.

### What is frozen, what needs an ADR, what is provisional

| status | items |
|---|---|
| **frozen (L1)** | correctness outranks coverage; arbitrary model SQL cannot mint a confirmed answer; verification status never user-facing; six terminal delivery actions with `retry` transitional; missingness ≠ zero; no user-visible enforcement without Jeff's approval; additive-only migrations inside the rollback window |
| **ADR required (L2)** | the four lifecycle stages and their ordering; request-decision-before-cache; the single factual-execution gateway; fact-ownership table; `DeliveryAction` as *the* outcome type; reason codes as a closed union |
| **intentionally provisional (L3)** | every increment's sequencing and estimates; which rules migrate first; the identity model's three-layer shape; retention numbers; whether a plan is retired or revived; the gateway's rollout order |

---

## 1. Executive assessment

**The frozen product target remains sound and should not be reopened. [V/I]** Its central claim — that
postconditions on arbitrary SQL establish internal consistency but not correctness
(`specs/2026-08-11-verified-answer-only-handoff.md` §2.1) — was independently confirmed the hard way:
the AST provenance attempt produced six defects of one class across four review rounds, and the
measured effect of its final form on real traffic was ~20 false refusals and **zero** additional true
catches. That is the frozen contract being right, not wrong.

What is **not** sound is the assumption that the programme's remaining work is *answer validation*.
The last three defects were lifecycle-placement, checkout-determinism, and observability defects. The
correctness engine is comparatively well developed; the plane it runs on is not. **[I]**

Three things are true simultaneously and should be stated together:

1. The product's correctness machinery is real and, where measured, works.
2. Its **control plane does not exist**: no CI, no text normalisation, no typed-outcome persistence in
   production, and a 129-step shell chain as the release gate. **[V]**
3. The programme has been changing direction faster than it has been shipping, and the amendment
   protocol above is the specific remedy.

---

## 2. Verified current-state ledger

### Repository and release

| fact | value | evidence |
|---|---|---|
| `origin/dev` | `541f2e5` | **[V]** `git rev-parse origin/dev` |
| production release | `/opt/nibrs/releases/20260821_212715` | **[V]** `readlink -f /opt/nibrs/current` |
| production commit | `541f2e5` | **[V]** `git -C /opt/nibrs/repo rev-parse HEAD` |
| rollback release retained | `20260818_223123`, 5 releases kept | **[V]** `ls /opt/nibrs/releases` |
| main checkout | `feature/verified-answer-only` @ `74b09b7`, **behind** `origin/dev`, holds the hard-stopped SHR stack | **[V]** |
| `df74915` | tested, **unpushed, undeployed**, not an ancestor of `origin/dev` | **[V]** |

### Data and runtime activation

| fact | value | evidence |
|---|---|---|
| production Historical DB | `sha256 a890fa1f…f34f3444` — **matches** the starting fact | **[V]** `sha256sum /opt/nibrs/shared/crime_data.db` |
| `PROOF_MODE` | **absent** from `ecosystem.config.js` and from the running process env → proof off | **[V]** |
| `query_log` columns | 19; `delivery_action`, `proof_mode`, `proof_manifest` **all ABSENT** | **[V]** `PRAGMA table_info` |
| `model_response` | **7 populated of 8,638 rows** (0.08%); all 7 within 30d | **[V]** |
| latency, 30d, n=1,791 | p50 **3,547 ms**, p95 **10,643 ms**, p99 **27,939 ms** | **[V]** |
| volume by tab, 30d | historical **758 (42%)**, nibrs 334, shr 298, current 264, hate_crime 137 | **[V]** |
| `chart_audit_results` | **85 rows** (not empty) | **[V]** |
| `audit_findings` / `audit_runs` | 1,048 / 23 | **[V]** |
| next scheduled NIBRS refresh | 2026-08-22 03:00 local — **has not run** (now 2026-08-21 22:20 UTC) | **[V]** |

### Engineering control plane

| fact | value | evidence |
|---|---|---|
| `.github`, `.editorconfig`, `.nvmrc`, `engines` | **all absent** | **[V]** |
| `.gitattributes` | one line, `*.db` only — governs no tracked text | **[V]** |
| test chain | `pretest` 21 + `test` 108 = **129 sequential steps** | **[V]** |
| test files vs registered | 149 on disk, **14 in no chain** | **[V]** |
| exit-code auditor | 0 can report-and-exit-0; but **111 of 139 have no failure tracking at all** | **[V]** |
| Increment A claims | **hold**: 0 `npx` in `package.json`, `tsx@^4.23.12` devDependency, auditor first in `pretest` | **[V]** |

### Answer quality baseline

Genuine failure rate is **bounded, not known**: 4.2% classified failures, 5.8% unclassified, so
4.2%–10.0% (`2026-08-18-increment-b-answer-diagnosis.md` §1). The 25% zero-row figure is **not** a
failure rate; more than half is the product clarifying or declining as designed. **[V, cited]**

---

## 3. Contradictions and stale assumptions

| # | contradiction | evidence | consequence |
|---|---|---|---|
| C1 | **A fifth factual surface exists and no lifecycle proposal covers it.** `app/api/embed/route.ts:225` does `db.prepare(check.sanitized!).all()` on **stored** SQL, gated only by `validateAndSanitize`. It sets `intendedAction` (`:267`) but consults **no current proof, no source health, and no source-version check**. `middleware.ts:34` makes GET public. | **[V]** | My lifecycle inventory said "four factual routes"; it was **incomplete**. The **proven** defect is re-execution of stored SQL without current validity — a figure can be served from SQL that was correct against a previous source version. Public access is a **separate, possibly intentional** design choice and is *not* the finding; see §5.2 and §7 P5. |
| C2 | Two "starting facts" are **stale in the optimistic direction**: `chart_audit_results` is 85 rows, not empty; `model_response` is 7 rows, not zero. | **[V]** | Both were cited as unfixed. They are *partially* fixed, which is worse than either: a mechanism that populates 0.08% of rows looks alive and measures nothing. |
| C3 | The frozen contract's §4 claim that the streaming route emits the **first factual result before disclosure** is **still true**. First `type:"result"` at `route.ts:631`; `applyResultDisclosures` at `:2408`. | **[V]** | Stage 1's oldest known gap is still open at `541f2e5`, five stages of planning later. |
| C4 | **Every capability decline in the system is gated on the model producing SQL.** `validateSourceCapabilities` requires `sql` and is called from exactly one site (`query-contract-validator.ts:734`); `extractQueryContext(sql, …)` also requires SQL. | **[V]** | The Historical defect is not special. 9 rules share its shape. |
| C5 | The exit-code auditor's guarantee is **narrower than Increment A implies**: 111 of 139 scripts have no failure tracking, so "no script reports a failure and exits 0" is true largely because most scripts never track failures. | **[V]** | A green chain is weaker release evidence than the Increment A table suggests. |
| C6 | `.gitattributes` governs `*.db` only, while two shipped mechanisms hash or ship **raw bytes of tracked text** (`decisionContract` → `lib/stage2b-plain-language.js`; `recordDigest` → `capability-answers.json`). | **[V]** | Two incidents already: the CRLF Bash payload (`516be76`) and the false capability-policy staleness. This will recur until `.gitattributes` covers text. |

---

## 4. Root-cause map

Recurring defects map to **four** missing architectural properties, not to careless work.

| recurring defect | instances | missing property |
|---|---|---|
| a guarantee enforced at the wrong lifecycle stage | Historical clearance no-SQL path; disclosure after first factual emit (C3); 9 post-SQL-only capability rules (C4) | **stage ownership** — no rule about which stage may establish which fact |
| a fact re-derived from a proxy | SHR licence re-deriving capability from SQL (6 defects/4 rounds); prose-inferred outcomes; `guardrails` text as the only production decision record | **one carrier per fact** |
| behaviour that depends on the checkout | CRLF Bash payload; byte-hashed provenance (C6) | **checkout determinism** |
| a mechanism that exists, runs, and measures nothing | `model_response` 0.08%; `proof_*` columns absent; `chart_audit_results` partial; 111 untracked test scripts (C5) | **activation evidence** — "present" is not "working" |

The fourth is the one this reset most needs to internalise: **five of the six items in the ledger's
"exists" column are not actually load-bearing.** Building more mechanism before making the existing
mechanism observable is how a programme accumulates the appearance of progress. **[I]**

---

## 5. Target architecture (L2 — ADR to change)

The request lifecycle is one of **seven** components. Treating it as the architecture is what made the
previous roadmap stop at the request lifecycle.

| # | component | owns |
|---|---|---|
| 5.1 | request lifecycle | per-request decisions and their ordering |
| 5.2 | factual-execution gateway | the boundary where validated SQL becomes executed SQL |
| 5.3 | semantic registry + typed compilers | what a measure/grain/offense *means*, and deterministic SQL for it |
| 5.4 | identity system | places and agencies across time and sources |
| 5.5 | data supply chain | immutable inputs → deterministic build → receipt → promotion |
| 5.6 | runtime control plane | what is actually deployed, activated, and effective |
| 5.7 | security, privacy, operations | identities, secrets, retention, recovery, latency, ownership |

### 5.1 Request lifecycle

```text
parse / auth / rate-limit
  → routing + source selection
  → conversation resolution (follow-up reconstruction, geo clarification)
  → ① REQUEST DECISION      continue | clarify | decline        ← before cache, model, plans
  → response-cache lookup   (key includes enforcement state + source version)
  → { deterministic plan | model translation | helper query }
  → ② PRE-EXECUTION CONTRACT  validates the exact final SQL, per rewrite
  → ③ FACTUAL EXECUTION GATEWAY  the only place factual SQL is prepared
  → ④ POST-EXECUTION EVIDENCE   rows, absence, nulls, truncation, omissions
  → ⑤ EGRESS                    renders a decision it did not make
```

**Fact ownership — the core invariant.**

| fact | established by | never by |
|---|---|---|
| does the source carry this measure at this grain | ① from the catalog | ② (no rediscovery from SQL or prose) |
| does this SQL honour the request | ② | ①, ⑤ |
| what the rows establish | ④ | ②, ⑤ |
| the words the user sees | ⑤, rendering ①/④ | any stage inventing or softening a decision |

**Trust boundaries.** The model may propose meaning; it may never establish a fact in any of the four
columns above. Stored SQL (embeds) is **untrusted input**, not a prior decision — C1 makes that
concrete, and it is the one place today where a factual answer is served to an unauthenticated caller
from SQL nobody re-validated. **[V/P]**

**Typed outcomes — extend, do not duplicate.** `DeliveryAction` (`lib/proof-contract.ts:89`) already
carries the 6 terminal actions, is used at **101 `finalizeExit` sites** (61 `decline_capability`, 17
`clarify`, 14 `answer`, 9 `decline_data`), and already excludes `retry` for the documented reason.
**[V]** Add exactly two members — `decline_grain`, `query_failed` — plus an orthogonal closed
`reasonCode` for *why*. A parallel enum would be the same "two carriers for one fact" defect as the
root-cause map's second row. **[P]**

### 5.2 Factual-execution gateway — boundary, invariant, exclusions

**Boundary [P].** One function is the sole path from a validated plan to executed factual SQL:

```ts
executeFactual(plan: ValidatedPlan): FactualResult
// ValidatedPlan is constructible ONLY by stage ② and carries:
//   sqlHash        sha256 of the exact validated statement
//   sourceVersion  the source-data version the validation was performed against
//   reasonCodes    what ② established
//   planOrigin     "deterministic" | "model" | "helper" | "stored-embed"
```

**Invariant — the validated SQL is the executed SQL.** The gateway recomputes `sha256(sql)` at the
moment of `prepare` and refuses if it differs from `plan.sqlHash`. This is not theoretical hygiene: the
SHR increment already found a live case where *"the schema check rewrites the SQL after validation, so
the licence had been proved about a statement that was not the one executed"* (§*Claude implementation
response*, deviation 1). **[V]** A hash comparison makes that class unrepresentable rather than
remembered.

Second invariant: `plan.sourceVersion` must equal the live source version at execution, or the gateway
returns `decline_source_health`. That is what makes a **stored** embed safe without changing who may
call it.

**Explicit exclusions — infrastructure, not factual operations.** These must *not* route through the
gateway, and a mechanical ban on `.prepare()` would be wrong **[V — 31 `lib/*.ts` files call it]**:

| excluded | examples |
|---|---|
| catalog/schema introspection | `lib/dynamic-facts.ts`, `PRAGMA table_info`, index checks in `deploy-zero-downtime.sh` |
| health and freshness probes | `lib/source-health.ts`, `check-nibrs-rollup-freshness.ts` |
| write paths that are not answers | `logQuery`, `audit_findings`, `shared_charts` inserts |
| migrations and builders | `scripts/migrate-*.js`, `scripts/build_*.py` |
| entity resolution lookups | `route.ts:166–336` agency/identity/crosswalk reads |

The test of inclusion is **"does a user-visible figure depend on this row?"**, not "is it SQL". The
inventory is therefore **7** factual sites in `/api/query`, the JSON routes' equivalents, the 7 `lib`
files executing caller-supplied SQL, and the stored-embed path — with the ~24 remaining `.prepare()`
sites explicitly excluded.

### 5.3 Semantic registry and typed compilers

Separate **mechanically derived schema facts** from **human-reviewed meaning**, because conflating them
is what let `rape_rate` mean two different quantities. **[V — verified collision]**

- **Derived layer**, generated, never hand-edited: tables, columns, types, nullability, row counts,
  observed ranges, coverage by year.
- **Reviewed layer**, human-owned, ADR-gated: measure identity, unit, numerator/denominator,
  additivity, grain validity, offense definition, reporting-status semantics, missingness vs zero, and
  the source-specific caveat text.
- **Compilers** consume only the reviewed layer, per question family, emitting deterministic SQL. A
  family without a compiler exits through stage ① as `decline_capability` — never through model SQL.

**Data-quality policy [P]:** a source-backed anomalous value (e.g. `rape_clr` observed −125 to 12,250
**[V]**) is neither clamped nor dropped nor shown bare. Each anomaly class gets a reviewed rule:
publish-with-caveat, exclude-with-disclosure, or decline. Silence is not an option.

### 5.4 Identity system

Three layers, evaluated and **accepted with one addition [P]**:

- `agency_entity` — the durable real-world body;
- `source_agency` — an identifier as one source spells it;
- `agency_relation` — **period-scoped** links, so a 2016 answer uses 2016's relationships.

Addition: **ambiguity and unplaceable records are first-class states**, not nulls to be resolved by
fuzzy matching. The `"across all states"` → *city Ball, LA* mis-resolution **[V]** is what happens when
unplaceable input is forced into a placement. Same for geography grain: singular state, plural/all-state
scope, ambiguous, and unresolved are four distinct outcomes.

**Shared vs source-specific:** entity identity, place identity, grain vocabulary, and time semantics are
**shared**; offense definitions, reporting status, coverage windows, and caveat wording are
**source-specific**.

### 5.5 Data supply chain

```text
immutable input (checksummed, retained)
  → deterministic build (pinned code + pinned inputs → reproducible output)
  → build receipt (inputs, checksums, code commit, row counts, reconciliation)
  → staging validation (schema, coverage, reconciliation vs previous version)
  → atomic promotion (symlink swap, version recorded)
  → rollback (previous version retained, restore drill proven)
```

Today: promotion is atomic for the **app** (`ln -sfn`, `KEEP_RELEASES=5` **[V]**) but **not for data** —
databases are replaced in `shared/` with no receipt and no version identifier a request can read. A
source-health verdict therefore cannot say *which* data it certified. Build receipts are the missing
primitive, and they are the prerequisite for source health meaning anything (§13 item 1).

**Writer inventory to complete in P6 [P]:** Current Trends (`update-rtci-db.py`), Historical
(`build_historical_core.py`, `import_historical.py`), NIBRS (`build-nibrs-rollups.py`,
`nibrs-auto-update.py`, `refresh-nibrs-rollups.ps1`), SHR (`normalize-shr-agencies.ts`,
`build-shr-*.ts`), Hate Crime (`import-hate-crime.py`). Each needs: inputs, checksums, schedule, host,
receipt, and reconciliation. **[V — files exist]**

### 5.6 Runtime control plane

One endpoint answering *what is actually true right now*: release and commit, configuration hash,
migrations applied, flag/enforcement state per rule, source versions with receipts, scheduler last-run
and outcome, and effective capability state. **[P]**

Justification is concrete: this session spent real effort establishing that `PROOF_MODE` is off, that
three log columns are absent, and that the production DB hash matches — all by ad-hoc SSH. **[V]** A
control plane makes the ledger in §2 a query instead of an investigation, and it is what stops code,
deployment, activation and roadmap status from drifting (§6 status record is its tracked counterpart).

### 5.7 Security, privacy, operations

- **Identity and access:** deploy and runtime identities, secret storage and rotation, database and log
  file permissions, production access paths, and reviewer authentication — inventoried, not assumed.
  Present state includes `AUTH_PASSWORD` unset, so middleware auth is **skipped** and `/api/*` is open
  to anyone who can reach the host **[V, `middleware.ts:39`]**. That is a genuine finding and it belongs
  to Jeff as a decision (D8), because the host may be otherwise restricted.
- **Privacy:** the query log stores user questions. Retention, redaction, access, and deletion need a
  policy; **the number is Jeff's** (D2). Mechanism is engineering.
- **Supply chain:** dependency and secret scanning in the CI control plane; no dependency added without
  a recorded footprint measurement (the `node-sql-parser` 89 MB / 301 KB split is the precedent **[V]**).
- **Latency and cancellation:** p99 is **27.9 s [V]**. An elapsed stopwatch after synchronous work is not
  a timeout; real cancellation needs worker isolation with a kill path. NIBRS already uses a subprocess
  worker — that is the pattern to generalise.
- **Recovery:** backup verification, restore **drills**, and incident records with owners. A runbook that
  has never been executed is a hypothesis.
- **Defect intake:** a user-reported-problem path carrying `request_id` **[V — column exists]** and
  nothing more personal, connecting a confirmed report to a regression test.

---

## 6. Plan supersession map

| document | verified state | disposition |
|---|---|---|
| `specs/2026-08-11-verified-answer-only-handoff.md` | product contract; stages are review inputs | **active — L1**, sequencing demoted to L3 |
| `2026-08-21-…-reset-handoff.md` + `…-lifecycle-addendum.md` | this assignment | **active authority** |
| `2026-08-20-project-collaboration-and-current-contract.md` (2,805 lines) | transcript of 20+ review rounds | **evidence only** — must stop being project status |
| `Claude decision-lifecycle design and inventory` (in the above) | complete; **incomplete on C1** | **accepted with amendment** — see §7.0 and P3.1 |
| `2026-08-18-cross-tab-architecture-review.md` | architecture input | **active evidence** |
| `2026-08-18-increment-a-verification-integrity.md` | claims **verified** at `541f2e5` | **complete**, with C5 caveat |
| `2026-08-18-increment-b-answer-diagnosis.md` | diagnosis; §6 order partly executed | **partially complete** |
| `plans/2026-08-13-stage2-source-health-registry.md` (2,101 lines) | `lib/source-health*.ts` exist, suites wired | **partially complete** — needs build receipts |
| `plans/2026-08-10-rendered-chart-correctness-audit.md` | says "implemented, not deployed"; prod has **85 rows** | **stale status** — reconcile |
| `plans/2026-08-10-clearance-session-reliability.md` | libs exist (`clearance-type-intent`, `geo-correction`, `nibrs-city-aliases`) | **partially complete** |
| `plans/2026-08-03-followup-policy-and-response-firewall.md` | Tasks 1–6 deployed `7b078d5`; 3 later tasks "proposed only" | **partially complete** |
| Stage 2B questionnaire | retired | **retired — do not resurrect** |
| AST/SHR returned-provenance stack | hard-stopped | **rejected — not an implementation base** |

**Machine-readable status record [P].** One tracked `docs/roadmap/status.json`, the single writer of
status, with per-increment: `id`, `layer`, `state`, `dependsOn[]`, `contract`, `commits[]`,
`reviewedBy`, `deployedRelease`, `runtimeActivation`, `evidence[]`, `owner`. A `pretest` check fails if
an increment claims `deployed` with no release, or `enforced` with `runtimeActivation:"off"` — which is
exactly the code/deploy/runtime drift that produced C2 and the `PROOF_MODE` confusion. **Prose status
paragraphs stop being authoritative on the day this lands.**

---

## 7. Revised prioritized roadmap (L3 — freely revisable)

Every increment must state: assumptions · dependencies · evidence strength · positive cases ·
false-acceptance cases · **false-refusal cases** · production-impact measurement · rollback boundary ·
owner · completion evidence. An increment missing the false-refusal row is not ready.

### 7.0 What is authorized, and what is not

**The four-stage lifecycle in §5.1 is a proposed target to validate incrementally. It is not
preauthorization for a wholesale refactor.** The evidence today justifies exactly three things:
**observability**, **measurement**, and **bounded experiments**.

Every implementation stage after that must **independently earn continuation** on three grounds:

1. **measured benefit** — the problem it targets is still present and quantified after the prior stage;
2. **false-refusal analysis** — adjudicated, per rule, not aggregate;
3. **handler-level evidence** — per path, with one mutation per path.

**If an early stage shows a smaller change solves the measured problem, stop there.** That is a
success, not an abandonment. Concretely: if P3's observation stage shows the 9 question-only rules
produce almost no real user harm — as the `df74915` measurement showed for its own case, 2 questions
per quarter **[V]** — then the correct outcome is to fix what measurement found and **not** build
stages ②–⑤. The roadmap below is a *plan of record*, not a commitment to execute every row.

### 7.1 Per-increment contract (mandatory fields)

Every increment states: assumptions · dependencies · evidence strength · positive cases ·
false-acceptance cases · **false-refusal cases** · production-impact measurement · rollback boundary ·
owner · completion evidence. **An increment missing the false-refusal row is not ready.**

### 7.2 Phases

Ordering rule: **determinism and CI precede lifecycle *implementation*** (not lifecycle design), and
**observability precedes anything whose acceptance is "behaviour unchanged."**

**Phase 0 — operational, already approved**

| # | increment | user-visible | rollback |
|---|---|---|---|
| **P0.1** | Observe the 2026-08-22 03:00 NIBRS refresh; close the approved operational work | no | n/a |
| **P0.2** | **Scheduler isolation** — scheduled production work stops reading a developer working copy | no | revert to the current scheduled task |

*P0.2 is promoted out of Phase 8.* It is not a data-architecture task; it is a live
operational dependency that **has already caused a failed production refresh** via a CRLF working
copy **[V]**, and it remains true today: the scheduled task reads `w/crlf` working-copy files from
the main checkout, which also holds a hard-stopped commit stack and sits behind `origin/dev`
**[V]**. Nothing later in the roadmap reduces that exposure, so it goes first.

**Phase 1 — trustworthy harness (must precede lifecycle implementation)**

| # | increment | user-visible | rollback |
|---|---|---|---|
| **P1.1** | Checkout determinism — `.gitattributes` for tracked text, `.editorconfig`, normalise the byte-hashed provenance inputs | no | file-level revert |
| **P1.2** | Minimal clean-checkout CI: install from lockfile, run the chain, publish the tally | no | CI-only |
| **P1.3** | Test manifest + accounting — register the 14 orphans; **inventory and classify** the 111 scripts the auditor reports as *failure tracking not detected*; define a registered runner/accounting contract; mutation-test representative failure paths; separate benchmarks from correctness | no | CI-only |
| **P1.4** | Deployed-artifact identity — prove the released commit and configuration are the ones that passed | no | CI-only |

*Why first:* every later acceptance claim is "behaviour unchanged," and evidence from a
CRLF-dependent checkout is not evidence, and neither is a 129-step chain whose failure-reporting
behaviour is unknown for 111 of its scripts (C5, C6). **[V]**

**On those 111:** the auditor's finding is *"no failure tracking detected"* — a limit of static
recognition, **not** a verdict that the scripts are defective **[V]**. Many almost certainly fail
correctly by throwing, by `assert`, or by a non-zero exit from the tool they wrap. P1.3 therefore
**inventories and classifies** them (already-correct / needs a contract / genuinely silent), fixes the
last group, and proves the runner contract by mutation-testing representative failure paths. It does
**not** mechanically retrofit 111 files, which would be churn justified by an unverified premise.

**Phase 2 — observability, split into five (proof enforcement excluded)**

| # | increment | user-visible | rollback |
|---|---|---|---|
| **P2.1** | **Design** — DDL for `delivery_action`, `reason_code`; old-row NULL semantics; writer changes; permissions; retention hooks; activation boundaries | no | n/a (design) |
| **P2.2** | **Implementation** — writers populate the columns locally; tests prove every terminal exit writes one | no | code revert |
| **P2.3** | **Production migration** — additive columns only, `NULL` for the 8,638 existing rows, permissions set, rollback = ignore the columns | no | additive/reversible |
| **P2.4** | **Logging activation** — writes enabled in production; no reader depends on them yet | no | disable writes |
| **P2.5** | **Verified coverage** — **100%** of eligible terminal factual exits carry a typed outcome. Eligibility is a closed, enumerated list built from the §5.1/§5.2 inventory; every excluded path is named with its reason (non-factual response, infrastructure endpoint, error before a decision exists). **A named technical exclusion is acceptable; an unclassified residue is not.** | no | n/a |

**Proof enforcement (`PROOF_MODE`) is not in this phase and is not implied by it.** Schema deployment,
logging activation, and proof activation are three separate approvals. **[V — `PROOF_MODE` absent today]**

**Phase 3 — request-decision lifecycle, earning continuation at each step**

| # | increment | user-visible | rollback | continuation gate |
|---|---|---|---|---|
| **P3.1** | Request-decision stage, **observation only** — 9 question-only rules + Historical clearance; inventory includes the stored-embed surface | no | flag per rule | — |
| **P3.2** | Shadow measurement per rule; adjudicate false refusals | no | flag per rule | requires P2.5 |
| **P3.3** | **Decision point** — does measured harm justify continuing, or does a smaller fix close it? | no | n/a | **may terminate Phase 3** |
| **P3.4** | Per-rule enforcement, one rule at a time | **yes** | flag per rule | Jeff, per rule |
| **P3.5** | Egress: first factual SSE event gated by finalisation (C3) | **yes** | release | measured benefit |

**Phase 4 — factual-execution gateway**

| # | increment | user-visible | rollback |
|---|---|---|---|
| **P4.1** | Gateway with the §5.2 invariant (`sqlHash` equality) behind a flag, model-SQL path only | no | flag |
| **P4.2** | Deterministic plans and helper queries migrated | no | per-call-site |
| **P4.3** | Stored-embed path migrated — see the P5 measurement gate first | possibly | per-call-site |

**Phase 5 — stored-embed validity (measurement gate before any access change)**

| # | increment | user-visible | rollback |
|---|---|---|---|
| **P5.1** | **Measure first** — how many `shared_charts` rows re-execute SQL with no recoverable proof, health, or source version; how many are read; how many would change answer under the current source version | no | n/a |
| **P5.2** | Attach current-validity checks (proof + health + `sourceVersion`) to embed reads | possibly | flag |
| **P5.3** | *Only if P5.1 shows it is warranted:* propose an authentication or compatibility change | **yes** | flag |

**Public read access is treated as an intentional product property until P5.1 says otherwise.** The
finding is re-execution without current validity, not who may call it (C1).

**Phase 6 — source semantics and typed compilers**

| # | increment | user-visible | rollback |
|---|---|---|---|
| **P6.1** | Derived schema-fact layer, generated (§5.3) | no | regenerate |
| **P6.2** | Reviewed semantic layer for the highest-volume families; `rape_rate`-class collisions named explicitly | no | ADR revert |
| **P6.3** | Data-quality rules for source-backed anomalies (e.g. `rape_clr` −125…12,250) — publish-with-caveat, exclude-with-disclosure, or decline | **yes** | flag |
| **P6.4** | Typed compilers for 2–3 families, measured against current answers | **yes** | flag per family |

**Phase 7 — identity**

| # | increment | user-visible | rollback |
|---|---|---|---|
| **P7.1** | `agency_entity` / `source_agency` / period-scoped `agency_relation`, read-only alongside today's resolution | no | n/a |
| **P7.2** | Ambiguous and unplaceable as first-class states; no fuzzy substitution | **yes** | flag |
| **P7.3** | Cross-tab geography-intent contract (the 5 deferred forms), consuming stage ① | **yes** | flag |

**Phase 8 — data supply chain and scheduler isolation**

| # | increment | user-visible | rollback |
|---|---|---|---|
| **P8.1** | Build receipts for one source end-to-end (inputs, checksums, code commit, reconciliation) | no | n/a |
| **P8.2** | Receipts for the remaining four; source version readable at request time | no | n/a |
| **P8.3** | Staging validation + atomic data promotion + data rollback, with a restore **drill** | no | previous version retained |

*Scheduler isolation was the highest-urgency item here and has been promoted to **P0.2**.* What
remains in Phase 8 is data-build architecture, which is genuinely later work.

**Phase 9 — operations, security, governance**

| # | increment | user-visible | rollback |
|---|---|---|---|
| **P9.1** | Runtime control plane endpoint (§5.6) | no | remove endpoint |
| **P9.2** | Real cancellation and latency isolation; p99 is 27.9 s today **[V]** | **yes** (faster failure) | flag |
| **P9.3** | Security/privacy inventory: identities, secrets, permissions, access paths, dependency + secret scanning | no | n/a |
| **P9.4** | Retention, redaction, access and deletion **mechanism** (policy is D2) | no | config |
| **P9.5** | User defect intake carrying `request_id`; confirmed report → regression test | no | n/a |
| **P9.6** | Recovery drills, incident records, named owners and escalation | no | n/a |
| **P9.7** | Roadmap/ADR governance: `status.json` as sole status writer, ADR directory, reassessment triggers | no | n/a |

### 7.3 The two ordering changes that matter

1. **Determinism and CI before lifecycle implementation** (Phase 1 before Phase 3), because unchanged-behaviour
   evidence produced by an untrustworthy harness is not evidence.
2. **Observability before anything measured against it** (Phase 2 before P3.2), split into five steps so
   "exists" cannot again be mistaken for "working" — the root-cause map's fourth row. **[P]**

---

## 8. Stop-doing list

1. **Stop treating the 2,805-line collaboration document as project status.** It is evidence.
2. **Stop shipping mechanism before activation evidence.** Four mechanisms exist and measure ~nothing.
3. **Stop system-wide resets for single discovered cases.** Use the §0 protocol.
4. **Stop adding gates at whatever stage the defect surfaced.** That produced `df74915`.
5. **Stop treating checkbox/status prose as status.** Three of four plans' statuses disagree with code.
6. **Stop accumulating approved and rejected work in one checkout.** The main checkout holds a
   hard-stopped stack, is behind `origin/dev`, and a scheduled production job reads its working copy.
7. **Stop reopening the SHR provenance stack** in any form.

---

## 9. Risk register

| risk | likelihood | consequence | current mitigation | owner | next evidence |
|---|---|---|---|---|---|
| **Stored embed SQL is re-executed without current proof, source health, or source-version validation** (C1). *Public read access is a separate, possibly intentional property and is not this risk.* | medium | a figure correct against a **previous** source version is served as current | `validateAndSanitize` only | Claude → Jeff | **P5.1** — how many `shared_charts` rows lack recoverable proof/version, how many are read, how many would change answer under the current version |
| Scheduled production job reads a developer working copy | **high** | already caused a failed refresh (CRLF) | fix at payload boundary (`516be76`, deployed) | Jeff | P0.1 outcome; then **P0.2** |
| Green chain read as release evidence (C5) | high | a real regression ships | none | Claude | P1.2–P1.3 |
| Typed outcomes unobservable in production (C2) | **certain today** | decisions reconstructed from prose — happened today | none | Jeff (migration approval) | P2.1–P2.5 |
| **Lifecycle work continues past the point measurement justifies it** | medium | a four-stage refactor of 42%-of-traffic path for a problem a smaller fix would close | **§7.0 continuation gates**; P3.3 may terminate Phase 3 | Claude → Jeff | P3.2 shadow numbers |
| Lifecycle change destabilises the hottest path | medium | user-visible regressions on Historical (42% of 30d volume **[V]**) | observation → shadow → per-rule, flag per rule | Claude | P3.1/P3.2 |
| Another same-class defect stalls an increment | medium | delay bounded to that increment | §0 protocol row 3 | Codex | first stop event |
| `df74915` becomes the foundation by inertia | low–medium | permanent second gate | held unpushed; §10 disposition; P3.1 must pass without it | Jeff | P3.1 acceptance |
| Anomalous source values presented without a reviewed rule | medium | a published figure like `rape_clr = 12,250` | none today | Claude → Jeff | **P6.3** |

---

## 10. Human-decision register — and the `df74915` disposition

Genuine decisions only. Everything else in this document is engineering the system should handle.

| # | decision | why it is Jeff's |
|---|---|---|
| D1 | Approve the `query_log` schema migration (P2.3) | production schema change |
| D2 | Log retention, redaction, and access policy — **I will not choose a number** | privacy/legal |
| D3 | Whether `decline_capability` may be split into `decline_capability` + `decline_grain` | changes the meaning of existing rows |
| D4 | Whether a cached answer predating a rule is invalidated or served | product behaviour |
| D5 | Per-rule enforcement approvals (P3.4), each one separately | user-visible behaviour |
| D6 | Whether embeds created before proof existed keep working (C1) | product/compat |
| D7 | Priority of the clean operational checkout vs the lifecycle work | cost/sequencing |
| D8 | Whether `/api/*` should stay open because `AUTH_PASSWORD` is unset, or be closed — the host may be restricted by other means **[V, `middleware.ts:39` skips auth when the variable is absent]** | production access posture |

### `df74915` — recommendation: **HOLD as reference, do not ship, retire when P3.1 lands**

I recommended shipping it as a stopgap before I measured it. **Measured, that recommendation is
wrong** and I withdraw it.

| measurement (90 days, production log) | value |
|---|---|
| Historical rows | 2,062 **[V]** |
| …with `no-sql-server-template` | 50 (2.4%) **[V]** |
| …**and** clearance-related wording | **2** **[V]** |
| `no-sql-server-template`, all tabs | 108 **[V]** |

**User harm while waiting is ~2 questions per quarter** receiving a misleading "restate it" message on
a path where restating cannot help. That does not justify a permanent second enforcement point in the
hottest route, which is exactly the architectural debt the reset exists to stop accruing.

- **Debt if shipped:** a second gate at a stage the target architecture does not have, in
  `app/api/query/route.ts`, which P3.1 must then find and remove.
- **Expiry/removal trigger:** superseded the moment P3.1's request-decision stage covers the no-SQL path.
- **Anti-inertia:** it stays **unpushed**; it is recorded in the status record as
  `state: "superseded-before-merge"`; and P3.1's acceptance requires the no-SQL cases to pass **without**
  it. Its tests are the reusable part and should be lifted into P3.1.

If Jeff prefers the 2 questions/quarter closed now, shipping it is defensible — but it is a product
call to accept known debt, not the engineering default.

---

## 11. Disagreements with Codex

Stated plainly, as instructed. Each was tested against evidence, not preference.

Stated plainly, as instructed. Each was tested against evidence, not preference.

**Still disagreements**

1. **Observability must precede the lifecycle work, not sit inside shadow measurement.** The addendum
   makes it a prerequisite *for* shadow; I go further — it precedes the implementation entirely,
   because "prove this changed nothing" gates every later stage and there is no column to prove it in
   today (C2). Now Phase 2 before P3.2. **[P]**
2. **"Nine question-only rules" needs a caveat I did not give it either.** The classification is static
   predicate inspection; 3 of the 9 declare `source` non-literally (spread over `ALL_QUERY_SOURCES`),
   so it is 9 *rule definitions* covering more source×rule pairs. The count is right; the unit is
   looser than "nine rules" implies. **[V]** Correcting my own inventory.
3. **Increment A's guarantee is over-read** (C5): 111 of 139 scripts have no failure tracking, so "no
   script reports a failure and exits 0" holds largely because most never track failures. **[V]** A
   disagreement with a document I wrote.
4. **Scale versus evidence.** A four-stage refactor of the hottest path (Historical = 42% of 30-day
   volume **[V]**) is authorized on nine rules with **one** demonstrated harm. The clarification in
   §7.0 resolves this — the lifecycle is now a target to validate incrementally with a termination
   point at P3.3 — but the tension was real and should be stated from the authorizing side too.
5. **Reset cadence has been a bigger risk than any single defect.** Two system-wide resets in one day,
   and `df74915` exists *because* one instruction commissioned a pre-generation gate and the next
   declared that pattern out of scope. Neither analysis was wrong; the sequencing produced the debt.
   The §0 amendment protocol — which came from Jeff's instruction, not from either reviewer — is the
   remedy, and §7.0 plus this pass close it. **[I]**

**Corrections to my own earlier disagreements**

6. **My embed recommendation was wrong and is withdrawn.** I wrote that the *public, unauthenticated*
   path was "the highest-risk item found" and should be gated first. Public read access is plausibly
   the intended product behaviour — the table is `shared_charts` — and I let an alarming-sounding fact
   outrank the demonstrated one. The proven defect is **re-execution of stored SQL without current
   proof, health, or source-version validation**. Access control is now gated behind the P5.1
   measurement, and the same discipline I applied to the SHR work applies here: measure before
   recommending. **[V/P]**
7. **Two "starting facts" were stale in the optimistic direction** (C2): `chart_audit_results` is **85
   rows**, not empty; `model_response` is **7 rows**, not zero. **[V]** Both are re-measured and carried
   correctly in §2. Minor, but they were framed as pessimistic-but-true and were neither.

**Where Codex was right and I was wrong**

8. The `DeliveryAction` duplication warning — the addendum adopted my objection, so this is now
   agreement, and the extend-don't-duplicate decision stands (§5).
9. `df74915` is an isolated branch patch that should not ship — **my own measurement confirmed it**
   (2 affected questions per quarter, §10).
10. The lifecycle inventory needed auditing for completeness — it did, and C1 is the hole.
11. Splitting observability into five steps, and putting determinism and CI ahead of lifecycle
    implementation. Both catch me failing to apply my own root-cause findings: collapsing five
    observability steps is the "exists but measures nothing" pattern, and leaving CI after the refactor
    contradicts my own argument about unchanged-behaviour evidence.
12. Requiring an explicit gateway boundary and invariant. Defining it is what surfaced the supporting
    evidence — the SHR increment had already hit a live case where the schema check rewrote SQL *after*
    validation, so the licence was proved about a statement that never ran. **[V]**

**How these were independently tested:** every numeric claim was re-measured from the repository at
`541f2e5` or from production read-only, not taken from any prior document. Three prior conclusions of
mine were overturned in the process: the `df74915` stopgap recommendation, the "four factual routes"
inventory, and the embed access-control framing.

---

## 12. Immediate next two increments

**P1.1 — Checkout determinism.** Scope: `.gitattributes` covering tracked text; `.editorconfig`;
normalise the two byte-hashed provenance inputs (`lib/stage2b-plain-language.js`,
`capability-answers.json`) so a digest cannot depend on how a file was checked out. **Why first:** it
is small, it has already caused two incidents **[V]**, and it is a precondition for CI producing
evidence anyone can trust.

**P2.1 — Observability design (design only, no migration).** Scope: exact DDL for `delivery_action`
and `reason_code`; NULL semantics for the 8,638 existing rows; writer changes at all terminal exits;
file permissions; retention hooks (policy is D2, mechanism is not); rollback by ignoring the columns;
and the explicit three-way separation of **schema deployment**, **logging activation**, and **proof
enforcement**. **Why second:** every later increment's acceptance is "behaviour unchanged," and that is
unprovable in production today.

Both are design/low-risk and neither touches the request lifecycle. **P0.1 — observing the 03:00
refresh — precedes both.** Phase 3 does not begin until Phase 1 and Phase 2 have landed and P3.3 has a
measurement to decide on.

---

## 13. Stage assessment

### Stage 2 is bounded, closed, and small — deliberately

Stage 2's failure mode is becoming a container for all professionalization work. So its definition is
**closed at four items**, each with a binary completion test, and **nothing may be added to it.**

| # | Stage 2 exit criterion | binary test | increment | today |
|---|---|---|---|---|
| S2-1 | source health is backed by a build receipt, not schema presence, for **all five production sources** | for **each of** Current Trends, Historical, NIBRS, SHR, Hate Crime, a request can name the data version its verdict certified | P8.1 (**pilot**, one source) **+ P8.2 (the remaining four)** | ✗ partial |
| S2-2 | typed outcomes persisted and queryable in production | `delivery_action` non-NULL for **100% of eligible terminal factual exits**, with every excluded path **named and justified** in the increment's completion evidence | P2.3–P2.5 | ✗ absent **[V]** |
| S2-3 | a green suite is release evidence | CI runs from a clean checkout on a lockfile install, and the deployed commit is provably the one that passed | P1.2, P1.4 | ✗ absent **[V]** |
| S2-4 | provenance is checkout-independent | the same commit yields identical digests on a CRLF and an LF checkout | P1.1 | ✗ absent **[V]** |

**Explicitly NOT in Stage 2**, and not admissible later: the factual-execution gateway (Phase 4), the
request-decision lifecycle (Phase 3), typed compilers (Phase 6), the identity model (Phase 7), data
promotion architecture (P8.3), and everything in Phase 9. Those are Stage 3+ or standalone, and moving
any of them into Stage 2 requires an ADR stating why the boundary above was wrong.

**One source is a pilot, not a milestone.** P8.1 proves the receipt mechanism on a single source; it
does **not** satisfy S2-1. "Stage 2 complete" cannot coexist with four unevidenced source-health
verdicts, because a verdict that cannot name the data it certified is the same "exists but measures
nothing" defect as the rest of §4. If Jeff wants the earlier milestone, it must be named
**"Stage 2 pilot"** and not "Stage 2 complete".

**Stage 2 is not complete:** S2-1 partial, S2-2/3/4 absent. **[V]** On this definition it is
five bounded increments from done — P1.1, P1.2/P1.4, P2.3–P2.5, P8.1, **P8.2** — none of which changes
user behaviour.

**Stage 3 is not ready**, for a structural reason rather than effort: its finding-lifecycle and
safe-exit work presumes a lifecycle with owned stages, and that lifecycle is Phase 3 — which itself is
now gated on measurement at P3.3 and may legitimately terminate early. Starting Stage 3 first would
place safe exits at whichever stage each defect happened to surface, which is exactly how `df74915`
came to exist.

**One consequence worth stating:** because Phase 3 may terminate at P3.3, "Stage 3 readiness" is not
guaranteed to arrive. If measurement shows the nine rules cause little real harm, the right outcome is
a bounded fix and **no Stage 3 lifecycle work at all** — and Stage 2, as defined above, would still be
complete.

---

## Boundaries honoured

Design and read-only only. No implementation, dependency install, commit, amend, push, deploy,
migration, flag change, schedule change, or production write. No full NIBRS refresh. `df74915`
untouched. Main checkout, CRLF refresh working copy, Jeff's files and `stash@{0}` untouched. Production
reads were read-only and aggregate; no question text or session identifiers were copied. The
2026-08-22 refresh had not run at the time of writing (2026-08-21 22:20 UTC) — its outcome is new
evidence for P0.1, to be recorded and not acted on.
