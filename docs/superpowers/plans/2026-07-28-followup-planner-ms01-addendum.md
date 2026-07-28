# MS01 Addendum: Cross-Source Follow-Ups Must Carry Reconstructed Context

**Status: PROPOSAL — awaiting Jeff's approval before implementation.**
Extends `2026-07-28-followup-planner-stage2.md`. Implementer: Codex (planner internals, validated by the strengthened parity checks in its current slice). Reviewer: Claude.

## The failure (live-replay session MS01)

1. "murders in Houston since 2010" (Historical) → pass
2. "compare to Dallas" → pass (Houston + Dallas)
3. "show rates instead of counts" → pass (rates)
4. **"now show firearm murders instead" → FAIL.** The client hard-reroutes to SHR (weapon attribute). The SHR route's `normalizeHistoryForTab(raw, "shr")` drops every Historical-tagged turn, so the model receives the bare fragment with NO history — no Houston, no Dallas, no 2010, no rates — and the response dead-ends in a rate-denominator refusal.

Two stacked root causes:

- **A. Cross-source context loss.** History normalization filters by source tag to keep foreign table names/SQL out of the prompt. Correct for the PROMPT; fatal for RECONSTRUCTION, which only needs user text and query shape.
- **B. Fragment chains.** Even with cross-source history, `latestPriorUserQuestion` returns "show rates instead of counts" — itself a fragment of a fragment. One-hop reconstruction cannot recover "firearm murders in Houston and Dallas, as rates, since 2010".

The current planner inherits both (verified by tracing `planFollowup` on the MS01 turn: normalized history is empty → `priorQuestion` null → `reconstructedQuestion` = the bare fragment).

## Proposed design: reconstruct from the last executed SQL, not from user turns

The prior assistant turn embeds the SQL that actually ran (`[SQL: ...]`). That SQL encodes the *accumulated* state of the whole fragment chain — geography, offense, metric, time — deterministically, regardless of how the user phrased each hop. Parsing machinery already exists (`extractQueryContext` in lib/query-context.ts, `buildQueryContract`).

### D1. New helper in `lib/followup-planner.ts`

```ts
interface PriorQueryState {
  sourceOfSql: SourceId;            // from the history entry's source tag
  sql: string;                      // last [SQL: ...] in history, ANY source
  baseQuestion: string | null;      // last user turn that is NOT itself a fragment
  geography: string[];              // e.g. ["Houston, TX", "Dallas, TX"] via extractQueryContext
  metricUnit: "count" | "rate" | "unknown";
  timeRange: { startYear: number | null; endYear: number | null };
  granularity: "monthly" | "annual" | "unspecified";
}
function extractPriorQueryState(rawHistory: unknown): PriorQueryState | null
```

- Scans RAW history (all sources — cross-source loss fixed here) newest-first for an assistant turn containing `[SQL: ...]`.
- `baseQuestion`: walk user turns newest-first; skip turns where `detectQueryBearingFollowup(turn, historyBefore)` or `detectFollowupTransform` fires (they are fragments); first non-fragment turn wins. Cap the walk at the normalized-history window (12 entries).
- Geography/metric/time/granularity come from the SQL via `extractQueryContext` + regex on the SELECT (rate detection: `per 100,000|_rate|100000.0 /`). Where extraction fails, fields degrade to null/"unknown" — reconstruction then falls back to today's one-hop behavior.

### D2. Reconstruction uses the state

In `planFollowup`, when the one-hop `priorQuestion` is null OR is itself a fragment, build the reconstructed question from `PriorQueryState` + the requested change. Template:

`"<offense/topic> in <geography list> <metric phrase> <time phrase>"` with the changed dimension swapped in. For MS01 turn 4 that yields: `"firearm murders in Houston, TX and Dallas, TX as rates per 100,000 since 2010"`.

The synthesized transform's `[SYSTEM:]` instruction quotes this reconstruction verbatim, so the target route's model gets full context even though its prompt history is (correctly) still source-filtered.

### D3. Source re-resolution unchanged, but now meaningful

`autoRoute(reconstructedQuestion)` on the full reconstruction routes "firearm murders in Houston and Dallas..." to SHR with high confidence. With authoritative mode on the ORIGIN source, the route returns the existing `sourceSwitch` response carrying the reconstruction, and the client visibly reruns it — MS01 then passes end to end.

### D4. Retire the client's pre-emptive hard-reroute (final step)

`components/WorkspaceChatV2.tsx:293-310` (the DEMO_ATTRS check) reroutes BEFORE any route/planner sees the question — this is the path MS01 actually takes today, and it can never carry reconstruction. Once authoritative mode is on for all sources, delete the DEMO_ATTRS branch so every follow-up goes to the ACTIVE source first and switches only via the planner's `sourceSwitch` response. Until then, keep it (removing it early would strand weapon-attribute follow-ups on sources that can't answer them, since `sourceSwitch` only fires in authoritative mode).

## Sequencing

1. D1 + D2 land behind the existing planner (compare mode observes them immediately — the compare log's `reconstructed` field will show full reconstructions on cross-source fragments; that IS the parity evidence).
2. D3 needs nothing new.
3. D4 only after `FOLLOWUP_PLANNER_SOURCES` covers all five sources.

## Tests (all offline)

- `extractPriorQueryState`: MS01's exact 3-turn history (Historical-tagged, SHR current source) → sql found, baseQuestion "murders in Houston since 2010", geography [Houston, Dallas], metricUnit "rate", startYear 2010.
- Fragment-chain walk: history where the last two user turns are fragments → baseQuestion is the first full question.
- `planFollowup("now show firearm murders instead", MS01 history, "shr")` → kind query_bearing, reconstruction mentions Houston, Dallas, firearm, 2010; `source` stays "shr" (client already routed there); transform instruction quotes the reconstruction.
- Cross-source switch: same history but currentSource "historical" → `sourceChanged: true`, `source: "shr"`.
- Degradation: history with SQL the extractor can't parse → behavior identical to today (one-hop), never a throw (planFollowupSafe already guards).
- Live-replay MS01 must pass once authoritative mode covers historical (D3); until then the compare log line for that turn is the acceptance check.

## Risks / limits

- SQL-derived state is only as good as `extractQueryContext`; unparseable SQL degrades to current behavior (never worse).
- The reconstruction template produces slightly stilted English; it feeds the model and the contract, not the user, so clarity beats elegance.
- `PriorQueryState.sql` must NEVER be placed in the prompt history for a different source (table-name leakage) — only the reconstructed QUESTION crosses the boundary. This is the design's load-bearing rule; the parity script should assert no `[SQL:` text appears in cross-source instructions.
