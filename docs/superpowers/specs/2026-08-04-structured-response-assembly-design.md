# Structured Response Assembly — Architecture Design

**Date:** 2026-08-04
**Status:** Design for review. Nothing implemented.
**Scope:** User-facing response construction across all four sources (Current Trends/RTCI, Historical/UCR, NIBRS, SHR) plus Hate Crime.

---

## 1. Executive summary

The recurring garbling is not a series of unrelated bugs. It is one structural property of the current design:

> **User-facing prose is a mutable string that passes through 45–60 sequential rewrites, and the safety net that catches corruption runs at only 14 of 102 response exit points.**

Every incident cited follows the same shape: the *model* writes a fact the *server* already knows canonically (place name, year range, category label, source name), the server then attempts to repair that fact by regex rewriting, and the repair is either lossy or fires on text that was already correct.

- 7772/7773 — server rewrote a **correct** place name into `"cities in the dataset City"`.
- 7780 — server reconstructed a category label from a sanitized column key and produced `"Asianpacific Islander"` from canonical `"Asian/Pacific Islander"`.
- 7544 — same class as 7772 (New York / New York City entity rewriting).
- 7674 — model-authored prose on a path the firewall did not guard.
- Title year-range, partial-year, and missing-year work — all deterministic corrections *applied on top of* model prose rather than authored by the server in the first place.

**Recommendation: staged migration, not a rewrite.** The highest-value, lowest-risk first step is a **single assembly boundary** that every response must pass through — with no change to prose content at all. That alone closes the 14/102 coverage gap and creates the one place where structured fields can later replace rewriting, incrementally, one source at a time.

**Explicitly rejected:** a full redesign of the response pipeline in one pass, and a second model call for explanation generation (see §8).

---

## 1a. AUDIT CORRECTION (2026-08-04, post-Codex) — read before §2

**The central premise of §1/§2.1 below is wrong. Corrected here; the original text is retained for provenance.**

1. **The leak firewall is already at a near-choke-point.** `sseEvent` (`app/api/query/route.ts:55-66`) and `jsonResp` (`app/api/nibrs-query/route.ts:68-76`, and the equivalents in `shr-query:57-64` and `hc-query:48-55`) **already call `sanitizeUserFacingNarrative` on every payload's `explanation` and `title`**, plus `text` on `type:"explanation"` events. The "14 of 102 exits are firewalled" claim was doubly wrong: the 14 came from a grep that counted import lines (actual explicit invocations: 10), and those explicit calls are *additional* pre-emission sanitizations, not the coverage boundary. **Coverage is effectively universal for anything emitted through the two wrappers.**
2. **Therefore Phase 0's headline benefit does not exist.** Centralizing the firewall was the main justification for the assembler. It is already centralized.
3. **Phase 0 is NO-GO as designed, for an additional reason:** the Current/Historical route is deliberately **two-phase**. It emits `type:"result"` at line 1792 carrying the *pre-query* explanation for latency, then emits `type:"explanation"` events at 1846 and 1893 with the post-disclosure and post-retry prose. The first event has already been flushed to the client before later prose exists. A single terminal render point would change client-visible event sequencing, so "byte-identical" is impossible under that framing.
4. **Real remaining gaps** (small, and mostly not prose): direct `NextResponse.json` exits that bypass the wrappers — `hc-query:118` (server-authored hardcoded prose), and captcha/OPTIONS at `hc:158`, `nibrs:226`, `shr:142`, `nibrs:65` (no prose at all). Plus `middleware.ts:49` (outside the routes).
5. **Genuine finding worth fixing:** logging happens **before** wrapper sanitization, so `query_log.response` can differ from what the user saw. Affects digest fidelity, not users.
6. **7783 correction stands against Codex.** Measured through the real API (`runGuardrails(extractQueryContext(...))`): the final recursive-CTE SQL does **not** fire `contract-year-lower-bound-missing`; a no-lower-bound SQL **does**. Codex's "likely a validator false positive" was speculation. The stale-accumulation diagnosis in §6.7 is correct. Adopt Codex's three-state framing (final-SQL / inherited-from-superseded-attempt / resolved-by-retry).

**Revised verdict:** do **not** build the assembler. The architecture work collapses into the three targeted fixes plus two hygiene items — (a) route the direct prose exit at `hc-query:118` through the wrapper or document it as server-authored, and (b) move logging after sanitization. See §12.

---

## 2. Root-cause analysis, grounded in current code

### 2.1 Measured state

| Location | Measurement |
|---|---|
| `lib/result-disclosure.ts` → `applyResultDisclosures` (line 630) | 31 sequential `explanation = …` / `appendSentence(…)` operations in one function |
| `app/api/query/route.ts` | 28 explanation mutations, 24 response emissions, 33 log writes |
| `app/api/nibrs-query/route.ts` | 30 explanation mutations, 23 response emissions, 26 log writes |
| `app/api/shr-query/route.ts` | 29 explanation mutations, 36 response emissions, 33 log writes |
| `app/api/hc-query/route.ts` | 13 explanation mutations, 19 response emissions, 18 log writes |
| `lib/scaffold-helpers.ts` → `sanitizeUserFacingNarrative` | **14 call sites total** against **102 emission points** |

### 2.2 Three structural defects

**D1 — Prose is the source of truth for facts the server already knows.**

The server holds a resolved geography (`lib/geo-place-resolver.ts`), a validated time range (`lib/query-contract-validator.ts`), a known source, and the literal category values from the result rows. It hands none of these to the renderer as data. Instead the model writes them into prose and the server tries to repair them afterward:

- `validateExplanationEntities` (`lib/explain.ts:345`) scans prose against a hardcoded `CITY_NAMES` list and substitutes `"cities in the dataset"` when a city is not found in `resultEntities`/`sqlGeos`. For 7772 all three inputs were empty — SQL filtered by ORI (`s.ori = 'MDBPD0000'`), the question was lowercase (`lib/query-context.ts:109` requires `[A-Z][a-z]+`), and rows had no place column — so a correct mention was destroyed.
- `labelFromComparisonColumn` (`lib/result-disclosure.ts:307`) reconstructs a display label from a *sanitized column key*. The pivot at `app/api/shr-query/route.ts:1087` strips `/` with no separator (`Asian/Pacific Islander` → `AsianPacific_Islander`), then the label function lowercases each part's tail → `Asianpacific Islander`. **The original value is unrecoverable from the key.** Repair is impossible in principle; the value must be carried.

**D2 — There is no single boundary.**

102 emission points, 14 firewalled. Coverage is maintained by hand, per new code path. 7674 was exactly this: a path nobody had wrapped. Every future exit point is a new opportunity to miss the firewall. This does not converge by adding more calls.

**D3 — Rewrites are order-dependent and non-idempotent.**

Each rule reads text a previous rule wrote. Adding rule N+1 multiplies the interaction surface. This session already produced one such bug: the hate-crime chart title stayed stale because `alignTitleYearRange` ran *after* the chart config was built in one route but not others — a pure ordering defect, invisible to unit tests, caught only in a browser. `appendSentence` chains also have no identity, so a note can be appended twice by two rules that both think it is missing (the Task 20 wiring needed an explicit `includes` guard for precisely this reason).

### 2.3 Why these are one problem

D1 creates the need for repair. D3 makes repair fragile. D2 means when repair corrupts the output, nothing catches it. Fixing any one alone leaves the class alive.

---

## 3. Target architecture

### 3.1 The structured object

```ts
/** Server-owned, canonical. The model contributes only `summary`. */
export interface UserFacingResponse {
  kind: "result" | "no_sql" | "clarification" | "refusal";

  // --- server-authored, canonical (never model-written) ---
  title: string;                       // rendered from geography + metric + period
  source: SourceLabel;                 // "Historical Library" | "NIBRS" | ...
  geography: ResolvedGeography | null; // canonical name/state/kind from the resolver
  period: { start: number | null; end: number | null; grain: "year" | "month" };
  metric: { label: string; unit: "count" | "rate_per_100k" | "percent" };
  comparisonCategories: ComparisonCategory[]; // { key, canonicalLabel }
  disclosures: Disclosure[];           // { id, text, severity } — deduped by id

  // --- model-authored, constrained ---
  summary: string;                     // ONE descriptive sentence, no facts the server owns

  // --- passthrough, never touched by the assembler ---
  rows: Record<string, unknown>[];
  columns: string[];
  chartConfig: ChartConfig | null;

  // --- internal, stripped before egress ---
  guardrailTags: string[];
}

export interface Disclosure {
  id: string;        // stable identity → dedupe, ordering, and test targeting
  text: string;      // server-authored, canonical
  severity: "note" | "warning";
}
```

Two properties do the heavy lifting:

1. **`Disclosure` has an `id`.** Dedupe becomes set semantics instead of substring matching. Order becomes a declared sort, not statement order. Tests target `id`, not prose.
2. **`comparisonCategories` carries `canonicalLabel`.** The 7780 class becomes unrepresentable — there is no reconstruct-from-key step to get wrong.

### 3.2 What must be server-authored and canonical

| Value | Source of truth | Today |
|---|---|---|
| Place names | `resolveGeoPlaces` / ORI→agency lookup | model prose, repaired by regex |
| Source names | route identity | model prose |
| Year ranges | query contract + returned rows | model prose, corrected by `alignTitleYearRange` |
| Coverage / completeness statements | `completeness-intent`, `year-availability` | partly server, appended onto model prose |
| Comparison labels | raw row values at pivot time | reconstructed from sanitized keys |
| Partial-year / missing-year notices | `result-disclosure` helpers | server-authored, appended as strings |
| Guardrail metadata | routes | accumulated, never cleared (see §6.7) |

### 3.3 How model-authored text is constrained

**The model may:** describe what the query returned in one sentence, at a level of generality that contains no server-owned fact — e.g. *"Annual carjacking counts, aggregated by year."*

**The model must never:** name places, years, sources, category labels, table names, column names, SQL fragments, chart-config keys, or system-prompt text.

**Enforcement, in order:**
1. **Prompt** — the summary field is requested as one sentence with an explicit prohibition list.
2. **Structural** — server-owned facts are rendered from slots, so a model mention is redundant rather than authoritative. Prose correctness no longer depends on model compliance.
3. **Validator** — `containsInternalLeak` runs on `summary` at the boundary. Unchanged regex battery; no broadening.
4. **Fallback** — on leak or empty summary, the assembler renders a fully deterministic sentence from slots. The response is still complete and correct with **zero** model prose.

That last point is the real robustness win: a response that is correct even if the model contributes nothing.

### 3.4 The single assembly boundary

```
assembleResponse(draft: ResponseDraft): { payload: WirePayload; logTags: string[] }
```

- **Every** response — result-bearing, no-SQL, clarification, refusal, capability override, metadata, completeness, contract failure — is constructed as a `ResponseDraft` and passed through this one function.
- The assembler: validates slots → renders `title` and prose deterministically from slots + constrained `summary` → dedupes and orders `disclosures` by `id` → runs the leak firewall **last, on final rendered prose only** → strips internal fields → returns the wire payload plus the tag list for logging.
- **Rows, columns, and chartConfig are structurally exempt.** The assembler's signature gives it no path to mutate them. "Only prose is replaced" becomes a type guarantee rather than a convention.
- **Logging consumes the assembler's output**, so the log always reflects what the user actually saw — which is not true today.
- No-SQL differs from result-bearing only in `kind` and in having empty `rows`; it takes the identical firewall and identical assembly path. That is precisely the gap that produced 7674.

---

## 4. Current → target data flow

**Current (result-bearing, representative):**

```
model prose
  → sanitizeExplanation
  → source-specific caveats (per-route, 13–30 mutations)
  → applyResultDisclosures (31 sequential mutations)
  → validateExplanationEntities (regex substitution over CITY_NAMES)
  → alignTitleYearRange (order-sensitive vs. chart build)
  → grain / lower-bound / trailing-year notes (append, guarded by includes)
  → sanitizeUserFacingNarrative   [reached at 14 of 102 exits]
  → emit (24/23/36/19 distinct call sites)
```

**Target:**

```
server facts ─┐
              ├→ ResponseDraft (typed slots) ─→ assembleResponse ─→ emit (one path)
model summary ┘                                      │
                                                     ├─ deterministic render from slots
                                                     ├─ disclosure dedupe/order by id
                                                     ├─ leak firewall (last, prose only)
                                                     └─ tags → log
```

Rewriting is replaced by *rendering*: prose is produced once, from data, instead of edited repeatedly.

---

## 5. File-by-file migration plan

| File | Change | Phase |
|---|---|---|
| `lib/user-facing-response.ts` | **New.** Types, `assembleResponse`, deterministic renderers, disclosure registry. | 0 |
| `lib/scaffold-helpers.ts` | No logic change. Called only from the assembler. | 0 |
| `app/api/query/route.ts` | Route all 24 emissions through the assembler; keep prose identical. | 0 → 1 |
| `app/api/nibrs-query/route.ts` | Same, 23 emissions. | 1 |
| `app/api/shr-query/route.ts` | Same, 36 emissions. Also carry pivot labels (§6.3). | 1 |
| `app/api/hc-query/route.ts` | Same, 19 emissions. | 1 |
| `lib/result-disclosure.ts` | Convert the 31 mutations into `Disclosure[]` producers. Keep pure/testable; no behavior change in Phase 2. | 2 |
| `lib/explain.ts` | `validateExplanationEntities` demoted from mutator to **validator** (flag, don't rewrite) once geography is canonical; then retired. | 3 |
| `lib/query-context.ts` | Feed canonical geography (ORI→agency, resolver) into the draft. | 2 |
| `lib/query-contract-validator.ts` | Supply canonical `period`; tag semantics fix (§6.7). | 2 |
| `lib/geo-correction.ts`, `lib/geo-place-resolver.ts` | Unchanged; become the geography slot's source. | 2 |
| `lib/refusal-safety.ts` | `buildNoSqlFallbackMessage` becomes a draft producer with `kind:"no_sql"`. | 1 |

---

## 6. Treatment of each failure class

**6.1 Baltimore "dataset City"** — Phase 2 puts the resolved canonical place in `geography`; the title and prose render from it. `validateExplanationEntities` no longer needs to guess, and in Phase 3 is retired. *Interim (ship now):* populate `geos` from ORI→agency and `resolveGeoPlaces`, which makes the existing rewrite correct without touching the firewall.

**6.2 New York / New York City** — same mechanism, same fix. Canonical geography carries `"New York, NY"` with its `kind`, so no substring heuristic decides whether "New York City" is valid.

**6.3 Malformed race labels** — the pivot records `{key, canonicalLabel}` from the raw row value at `shr-query/route.ts:1073` and puts it in `comparisonCategories`. `labelFromComparisonColumn` is used only as a fallback for genuine SQL aliases (`new_orleans` → "New Orleans"). The lossy round-trip is eliminated, not patched.

**6.4 Stale title year ranges** — `title` is rendered from `period` after rows are known, inside the assembler. There is exactly one render point, so the route-ordering bug that produced the stale hate-crime title cannot recur.

**6.5 Partial-year / missing-year disclosures** — become `Disclosure` entries with stable ids (`partial-year`, `missing-lower-bound`, `trailing-years-trimmed`). Existing logic and text are preserved verbatim in Phase 2; only the carrier changes. Dedupe by id replaces `includes()` guards.

**6.6 System-prompt / internal-schema leakage** — the firewall moves from 14 hand-placed calls to one unavoidable boundary covering all 102 exits. Regex battery unchanged.

**6.7 False-positive entity rewrites and stale tags** — two parts. Rewriting stops being a mutation (6.1). Separately, contract tags are currently unioned and never cleared (`recordContractValidation`, present in all four routes; `runContractValidation` is called at 7 points in `query/route.ts` alone), so a tag from a superseded attempt survives into the log — this is what produced `contract-year-lower-bound-missing` on 7783 even though the final SQL was correct and returned 46 correct rows. Fix: re-validate the final executed SQL at assembly time; tags that still fail stay verbatim, tags resolved by a retry are renamed `<tag>-resolved-on-retry`. Warnings are preserved, not suppressed.

---

## 7. Testing strategy

**Phase 0 — coverage proof (the important one).**
- `scripts/test-response-assembly-coverage.ts`: static assertion that no route file emits a response payload except through the assembler. Implemented as a source scan asserting the count of raw emission constructs is zero. This is the test that makes the 14/102 gap structurally impossible to reopen.
- Snapshot equivalence: for a fixed corpus of drafts, Phase 0 output is **byte-identical** to current output. Phase 0 is a refactor; any diff is a bug.

**Phase 1–3.**
- Unit tests for `assembleResponse`: slot rendering, disclosure dedupe by id, ordering determinism, `summary` leak fallback, rows/chart passthrough identity.
- Adversarial explanation tests: model summaries containing table names, `[SYSTEM:`, SQL, chart keys, prompt fragments → assert the *returned* prose is the deterministic fallback and rows/chart are unchanged.
- Golden responses per source (4 sources × result-bearing + no-SQL), asserting `title` and prose **string values**, not tags.
- Regression cases from this backlog, asserting returned strings: 7772/7773 (Baltimore present, `dataset City` absent), 7780 (`Asian/Pacific Islander`), 7783 (no unsuffixed lower-bound tag; true missing-bound case still fires), 7674 (no-SQL path firewalled), plus a **safe case** proving legitimate "cities in the dataset" wording is never rewritten.

**Mandatory test hygiene** (this repo has shipped vacuous tests three times):
- Every assertion checks a **returned value**.
- All assertions execute **before** any final `console.log` and before any `process.exit()`. No assertion may follow an exit call.
- No test asserts a field that cannot fail.
- Full `npm test` + `npx tsc --noEmit` gate before any deploy.

**Production replay + monitoring.** Replay 7772, 7773, 7780, 7783, 7544, 7674 plus one control per tab and a `new orlens` typo check. Add digest categories for `assembly-fallback-used` and `assembly-leak-blocked` so silent degradation to deterministic prose is visible rather than invisible.

---

## 8. Tradeoffs

**Incremental fix vs. full redesign.** The three targeted fixes (geography, labels, tag semantics) resolve the *reported* incidents in roughly a day with small, reviewable diffs. They do not close the 14/102 gap or stop D3 from generating new incidents. The full redesign closes the class but touches 102 emission points across 6,700 lines of route code — on a system that has been stable for hours. **Do both, in this order:** ship the targeted fixes now as forward-compatible down-payments, then Phase 0, which is a pure refactor with a byte-identical output test.

**Performance and model calls.** The assembler is synchronous string/object work — negligible. **No second explainer call.** A context-minimized second call would add latency and cost to every query and would still leave the model authoring facts the server owns. The correct move is the opposite: shrink what the model authors to one sentence and make prose correct without it. If a summary is ever unusable, the deterministic fallback is already the answer.

**Compatibility risk.** Field names and payload shape are unchanged; the assembler emits the same SSE and JSON contracts. Frontend requires no change. Risk concentrates in Phase 0's mechanical rerouting of emission points, mitigated by the byte-identical snapshot test and per-route migration.

**Ship now vs. wait.** Now: the three targeted fixes. Next: Phase 0 (choke point) — highest value per unit of risk. Then Phase 1 (per-route migration), Phase 2 (canonical slots), Phase 3 (retire entity rewriting). Phases 2 and 3 are independently valuable and can stop at any point.

---

## 9. Rollback strategy

Symlink deploys make release rollback trivial (`bash scripts/rollback.sh`). Beyond that:

- Phase 0 ships behind no flag but is provably output-identical; rollback = previous release.
- Phases 1–3 migrate **one route at a time**, each its own deploy and its own replay. A regression rolls back one source, not the pipeline.
- `assembleResponse` keeps a `legacyPassthrough: true` draft option during migration that emits pre-assembly prose verbatim, so a route can be reverted to old behavior without reverting the deploy.
- Disclosure conversion (Phase 2) preserves text verbatim, so rollback never changes what users read.

---

## 10. Changes that should NOT be made

- Do **not** broaden `containsInternalLeak` — no generic `word.word` or table-shaped matching. False positives here silently replace correct answers.
- Do **not** remove or soften existing disclosures, caveats, or guardrail warnings to reduce digest noise.
- Do **not** change SSE/JSON field names, payload shape, or chart-config keys.
- Do **not** let the assembler touch `rows`, `columns`, or `chartConfig`.
- Do **not** migrate all four routes in one commit.
- Do **not** add a second model call for explanations.
- Do **not** rewrite `lib/guardrails.ts`, the SQL-safety layer, the deterministic query paths, the retry machinery, or the router. They are out of scope.
- Do **not** make `assembleResponse` async or give it DB access — it must stay pure and trivially testable.
- Do **not** delete `validateExplanationEntities` before canonical geography is live in the route being migrated.

---

## 12. Revised plan after the audit (supersedes §11a steps 6–7)

The assembler is cancelled. Remaining work, in order:

1. **Fix 1** — resolved-place canonicalization (Claude).
2. **Fix 2** — canonical comparison labels (Codex).
3. **Fix 3** — guardrail tag semantics, three-state (Codex): warning from final SQL / inherited from superseded attempt / resolved by retry. Re-validate the final SQL at write time.
4. **Hygiene A** — move `writeLog`/`writeNibrsLog`/`logQuery` calls after wrapper sanitization, so the log matches what the user saw.
5. **Hygiene B** — route `hc-query:118` through `jsonResp`; document captcha/OPTIONS/middleware as protocol-only exits with no model-authored prose.
6. **Reassess** D1/D3 (canonical fields, ordering) from digest results only after 1–5 ship. Do not pre-commit.

**Not doing:** `UserFacingResponse`, `assembleResponse`, per-route funnel migration, disclosure-to-typed-list conversion. The justification for each rested on the firewall-coverage gap, which does not exist.

**Still true and worth remembering:** D1 (prose is the source of truth for server-known facts) and D3 (order-dependent, non-idempotent rewrites) are real defects. Fixes 1 and 2 address the two instances that actually caused incidents. If new garbling appears that is *not* explained by a missing canonical field, revisit §3.

---

## 11a. Agreed execution order (2026-08-04) — steps 6–7 superseded by §12

1. **Codex audits** this design and the complete inventory of user-facing response exits. **Blocking gate for Phase 0.**
2. **Claude implements Fix 1** — resolved-place canonicalization.
3. **Codex implements Fix 2** — canonical comparison labels.
4. **Codex implements Fix 3** — corrected guardrail tag semantics.
5. Review + deploy fixes 1–3 only after verification (full suite, tsc, production replay).
6. **Phase 0 assembler** as a separate, byte-identical refactor — **not started until step 1 confirms the exit inventory and names any path that cannot pass through the funnel.**
7. Reassess Phases 2–3 against production digest results before committing to them.

---

## 11. Codex review prompt

> Review the design in `docs/superpowers/specs/2026-08-04-structured-response-assembly-design.md` against the actual codebase at `C:\Users\jeffm\crime-data-assistant`. **Do not implement anything.** Verify or refute, with file:line evidence for each:
>
> 1. The measured counts in §2.1 — mutation ops in `applyResultDisclosures`, per-route explanation mutations, response emission points per route, and `sanitizeUserFacingNarrative` call sites. Report any count that is wrong.
> 2. That the 7772 root cause is the conjunction of ORI-only SQL filtering, the case-sensitive question fallback in `lib/query-context.ts`, and place-free result rows — and that no *other* path also rewrites place names.
> 3. That `Asian/Pacific Islander` is unrecoverable from the pivot key produced at `app/api/shr-query/route.ts:1087`, so carrying the label is required rather than optional.
> 4. That contract guardrail tags are accumulated without clearing in all four routes, and that this fully explains 7783.
> 5. Whether any response exit point exists that the proposed assembler boundary could not cover — streaming/SSE partials, error paths, rate limits, captcha, early validation returns. List every one.
> 6. Whether Phase 0 can be genuinely output-identical, or whether any current path depends on mutation ordering in a way a single render point would change. Name the paths.
> 7. Whether the phase sequencing creates a state where a route is half-migrated and a disclosure could be dropped or duplicated.
>
> Report findings ranked by severity, with the specific code that contradicts the design. Do not write code.
