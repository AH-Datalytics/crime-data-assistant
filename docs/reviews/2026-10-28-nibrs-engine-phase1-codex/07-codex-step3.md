**Verdict: REVISE.** The inventory is reproducible and preserves the supplied export, but it is not yet sufficient for a faithful shadow comparison. The main gaps are actual answer data, reliable conversation context, and baseline provenance.

Read-only review completed on `nibrs-engine/phase1`; no files changed. I ran the builder with writes captured in memory: both `inventory.json` and `summary.md` matched the committed files byte-for-byte.

What passes:

- All **605 unique exported records** are present, with every recorded outcome category preserved.
- The specified interval, `[2026-08-29, 2026-10-28)` UTC, is 60 days.
- README’s count table reconciles: **358 public-classified, 247 internal**, including 132 correctness-baseline, 109 presentation-study, and six release-check records.
- Historical model-SQL answers are appropriately distinguished.
- No original session IDs remain in the inventory; 229 distinct non-null sessions produce 229 distinct hashes.

Required changes, consolidated:

1. **Make the baseline usable for answer comparison.**  
   In the [builder’s `today` fields](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/scripts/build-nibrs-replay-inventory.py:116), `rows` is a **row count**, not result data. Every `result_digest` is null. `response` is explanation text: for example, record 10632 has one result row but only the generic “Figures from the NIBRS summary tables…” explanation. Four SQL strings also reach the logger’s 4,000-character truncation limit: 8915, 9470, 9912, 10083.

   **Consequence:** changed numbers can go undetected, and historical answers cannot generally be reconstructed from these records.

   Preserve these as historical observations. Add an explicit baseline-availability status and a defined phase-5 baseline capture: full results/columns, explanation, chart configuration, timing, and pinned application/data versions. Recover historical payloads where available; otherwise mark them unavailable. Do not treat missing evidence as equality or silently omit those cases.

2. **Separate inferred session adjacency from replayable history.**  
   The [linking logic](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/scripts/build-nibrs-replay-inventory.py:95) creates 27 predecessor links among the 35 sessionless requests solely from timing. It also joins repeated internal runs: `correctness-baseline-GC-001` becomes one conversation across records 8818, 9373 and 9701, weeks apart.

   The application consumes user **and assistant** history, including source tags; cross-source boundaries affect follow-up interpretation. A NIBRS-only session chain does not establish the history actually sent.

   **Consequence:** replay can answer a different question because fabricated or missing context changes its meaning.

   Preserve actual request history where recoverable, identify independent baseline runs, and label inferred links as candidates rather than authoritative predecessors. Retain unresolved cases with an explicit context limitation and human-reviewed reconstruction where possible. Do not replay sessionless adjacency automatically.

3. **Retain available request metadata and identify missing provenance.**  
   The export includes `routing_mode`, `routing_reason`, `query_contract`, `guardrails`, and `request_id`; the builder drops them. Routing mode is populated on 364 records. Preserve these, along with explicit tab/endpoint information. Export `chart_config` where available—the logger supports it—and preserve millisecond timestamps.

   **Consequence:** reviewers lose available evidence for routing, interpreted intent, presentation differences, and joins to other records.

   Record historical deployed-code/data-release identity or deployment intervals where evidence exists; otherwise mark them unknown. Query timestamps alone do not identify releases. A full historical deployment reconstruction need not block this inventory, but a pinned baseline is necessary before attributing shadow differences to the new engine.

4. **Bound the completeness and reproducibility claims.**  
   I verified completeness **against the supplied export**, not against the source database. Its latest record is `2026-10-27T21:36:15.493Z`; that alone cannot establish coverage through midnight. The builder also trusts its input while always labeling it with the fixed window.

   **Consequence:** an early, partial, or wrong-window export could receive the same “every request” claim.

   Record extraction time, effective cutoff, source-query/count evidence, and an input checksum; retain the source securely beyond its temporary location. Validate the input window and IDs. If extraction preceded window closure, finish the export or state the actual cutoff.

5. **Correct misleading reporting claims.**  
   In the [README](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/scripts/fixtures/nibrs-replay/README.md:48), **36% is the historical deterministic-answer proportion**, not a measured answer rate for today’s deployed system. All historical outcomes—not only model-SQL answers—may differ today.

   Also:
   - The summary’s “Declined or clarified” residual includes operational/unrecorded records; rename or split it.
   - “Public” means “not matched by the internal-session rule,” not verified human traffic.
   - “The questions are what the public typed” excludes the reality of 247 internal records.
   - Hashing provides pseudonymization, not anonymity: the salt is public, and predictable internal IDs are guessable. No hash redesign is necessary for this private inventory.

The five phase-5 reporting dimensions are correctly named. Their actual adjudication can remain phase-5 work; historical “answered” must not become a correctness label.

**Necessity check:** preserve the accepted 605-row inventory and reproducible builder. Fix baseline/context availability, retain existing metadata, and correct provenance and reporting claims now because they determine whether replay measures the intended questions and answers. Defer the replay runner, full correctness adjudication, historical deployment archaeology, and broader product certification.
