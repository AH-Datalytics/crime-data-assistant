/**
 * Why a requested entity is missing from a result -- with evidence, or not at all.
 *
 * Source of truth: docs/superpowers/specs/2026-08-11-verified-answer-only-handoff.md
 * §7, plus §2.4's rule that the system "never claim[s] a source lacks data unless
 * a deterministic attribution probe established that fact."
 *
 * THE ASYMMETRY THIS MODULE ENFORCES. Saying "Jacksonville is not in this source"
 * is a factual claim about the FBI's data. Saying "I can't include Jacksonville
 * through this comparison path" is a claim about our product. The first is far
 * more useful and far more dangerous: if it is wrong, the product has told a
 * researcher something false about a public dataset. So every source-attributable
 * reason here requires probe output, and anything unproven collapses to
 * `capability_path_unavailable` or `unknown`, which the wording layer renders as
 * product-capability language.
 *
 * lib/proof-contract.ts holds the closed reason set, the source-attributable
 * subset, and assertOmissionEvidence(). This module's job is to reach a reason
 * honestly; that module's job is to refuse one that arrives without evidence.
 *
 * BATCHING (§7). "Batch or cache deterministic probes rather than issuing one
 * uncached database query per omission." A 32-city comparison that misses 8
 * cities must not become 8 round trips on the request path -- the latency budget
 * is 50 ms median for the whole proof step (§11). Every probe here is either a
 * single set-based query covering all candidates at once, or a pure in-memory
 * lookup against tables already loaded.
 */

import type Database from "better-sqlite3";
import type { Omission, OmissionReason, SourceHealthState, SourceId } from "./proof-contract";
import { assertOmissionEvidence } from "./proof-contract";
import { findConsolidatedAgency, CONSOLIDATION_EXCLUSIONS } from "./agency-consolidations";

/** One entity that was requested and did not appear in the result. */
export interface OmittedCandidate {
  /** Canonical identifier used for comparison. */
  entityId: string;
  /** Display label for the wording layer. */
  label: string;
  /** Two-letter state code when known; improves probe precision. */
  state: string | null;
  /** Years the request asked about, when known. */
  requestedYears: number[];
}

export interface AttributionContext {
  sourceId: SourceId;
  /** Read handle for the source being probed. Null forces `unknown`, never a source claim. */
  db: Database.Database | null;
  /** Inclusive year bounds the source covers, when known. */
  sourceYearRange: { min: number; max: number } | null;
  /**
   * Source health as three states, never a boolean.
   *
   * ONLY `degraded` YIELDS `source_unhealthy`. That reason asserts something
   * factual -- "a required source is unavailable, stale for the requested period,
   * or incomplete" (§2.3) -- so it requires a health check that ran and failed.
   *
   * `unknown` must NOT produce it. Stage 1 has no source-health registry yet (that
   * is Stage 2), so health is unknown for all real traffic. An earlier revision
   * took a boolean and was handed `false` for "not yet checked", which made every
   * omission in shadow read as a source-health failure and buried the probe
   * evidence the shadow period exists to collect. Unknown health blocks factual
   * delivery through the manifest, which is the correct place for it; it is not a
   * licence to invent a reason here.
   */
  sourceHealth: SourceHealthState;
}

export interface OmissionAttribution {
  omissions: Omission[];
  /** Probes actually executed, for latency accounting and audit health. */
  probesRun: number;
  /**
   * Candidates that reached `unknown`.
   *
   * Surfaced separately because §7 requires that unknown attribution "results in
   * capability framing or a decline" -- the caller has to act on this, not merely
   * store it.
   */
  unattributed: string[];
}

/**
 * Probe result for one candidate, from a single batched query.
 *
 * `existsInSource` distinguishes "we looked and it is not there" from "we could
 * not look", which is the whole point: only the former licenses `not_in_source`.
 */
interface ExistenceProbe {
  existsInSource: boolean;
  /** Years the entity has any data for, when the probe could determine them. */
  yearsWithData: number[];
  /** Human-readable evidence string recorded on the omission. */
  evidence: string;
}

/**
 * Table and column mapping per source for the existence probe.
 *
 * Kept as data rather than branching code so adding a source is a row, and so the
 * source-parity matrix (§8.1) can be checked against this table directly. A source
 * absent from this map yields no probe and therefore no source-attributable
 * reason -- the safe direction.
 */
const EXISTENCE_PROBES: Partial<
  Record<SourceId, { table: string; nameColumn: string; stateColumn: string; yearColumn: string | null }>
> = {
  current: { table: "agency_monthly", nameColumn: "agency", stateColumn: "state", yearColumn: "year" },
  historical: { table: "historical_agency", nameColumn: "agency", stateColumn: "state", yearColumn: null },
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * One query covering every candidate, rather than one query per candidate.
 *
 * Returns an empty map when the probe cannot run at all -- a missing table, an
 * unmapped source, a closed database. An empty map means every candidate stays
 * unattributed, which is correct: we learned nothing.
 */
function batchExistenceProbe(
  context: AttributionContext,
  candidates: OmittedCandidate[],
): { results: Map<string, ExistenceProbe>; probesRun: number } {
  const results = new Map<string, ExistenceProbe>();
  const mapping = EXISTENCE_PROBES[context.sourceId];
  if (!context.db || !mapping || candidates.length === 0) return { results, probesRun: 0 };

  try {
    const placeholders = candidates.map(() => "?").join(", ");
    const yearSelect = mapping.yearColumn
      ? `, GROUP_CONCAT(DISTINCT ${mapping.yearColumn}) AS years`
      : ", NULL AS years";
    const sql =
      `SELECT LOWER(${mapping.nameColumn}) AS name, LOWER(${mapping.stateColumn}) AS st${yearSelect} ` +
      `FROM ${mapping.table} ` +
      `WHERE LOWER(${mapping.nameColumn}) IN (${placeholders}) ` +
      `GROUP BY LOWER(${mapping.nameColumn}), LOWER(${mapping.stateColumn})`;
    const rows = context.db
      .prepare(sql)
      .all(...candidates.map((candidate) => candidate.label.toLowerCase())) as {
      name: string;
      st: string | null;
      years: string | null;
    }[];

    const found = new Map<string, { states: Set<string>; years: Set<number> }>();
    for (const row of rows) {
      const key = normalize(row.name);
      if (!found.has(key)) found.set(key, { states: new Set(), years: new Set() });
      const entry = found.get(key)!;
      if (row.st) entry.states.add(row.st.toLowerCase());
      for (const part of (row.years ?? "").split(",")) {
        const year = Number.parseInt(part.trim(), 10);
        if (Number.isFinite(year)) entry.years.add(year);
      }
    }

    for (const candidate of candidates) {
      const entry = found.get(normalize(candidate.label));
      if (!entry) {
        results.set(candidate.entityId, {
          existsInSource: false,
          yearsWithData: [],
          evidence: `probe: no row in ${mapping.table} where ${mapping.nameColumn} matches '${candidate.label}'`,
        });
        continue;
      }
      // A name match in the wrong state is not a match. Recorded as not-in-source
      // for the requested state rather than as a hit, because answering with
      // another state's agency is worse than omitting it.
      if (candidate.state && entry.states.size > 0 && !entry.states.has(candidate.state.toLowerCase())) {
        results.set(candidate.entityId, {
          existsInSource: false,
          yearsWithData: [],
          evidence:
            `probe: ${mapping.table} has '${candidate.label}' only in ` +
            `${[...entry.states].join("/").toUpperCase()}, not ${candidate.state.toUpperCase()}`,
        });
        continue;
      }
      results.set(candidate.entityId, {
        existsInSource: true,
        yearsWithData: [...entry.years].sort((a, b) => a - b),
        evidence:
          `probe: ${mapping.table} has '${candidate.label}'` +
          (entry.years.size > 0
            ? ` with data for ${Math.min(...entry.years)}-${Math.max(...entry.years)}`
            : " with no year detail available"),
      });
    }
    return { results, probesRun: 1 };
  } catch (error) {
    // A failed probe must leave candidates unattributed, not attribute them to the
    // source. Recorded at debug level rather than thrown: this runs on the request
    // path and its failure is a loss of evidence, not of the answer.
    console.warn(
      `[omission-attribution] existence probe failed for ${context.sourceId}:`,
      error instanceof Error ? error.message : String(error),
    );
    return { results: new Map(), probesRun: 1 };
  }
}

/**
 * Decide one candidate's reason, given whatever the probes established.
 *
 * The ordering is deliberate: cheap, certain, in-memory conclusions first, then
 * probe-derived source claims, then the two honest fallbacks. Every branch that
 * returns a source-attributable reason has probe output in hand at that point.
 */
function attributeOne(
  candidate: OmittedCandidate,
  context: AttributionContext,
  probe: ExistenceProbe | undefined,
): { reason: OmissionReason; evidence: string | null } {
  // A source that was CHECKED AND FAILED explains the absence without saying
  // anything about the data itself, and outranks every other reason -- an entity
  // may be perfectly present in a source we currently cannot trust. `unknown`
  // deliberately falls through to the probe ladder; see AttributionContext.
  if (context.sourceHealth === "degraded") {
    return {
      reason: "source_unhealthy",
      evidence: `source '${context.sourceId}' health check ran and reported degraded for this request`,
    };
  }

  // Consolidation is decided from a static table in the repository, so it needs no
  // query and its evidence is the table entry itself.
  const consolidation = findConsolidatedAgency(candidate.state, candidate.label);
  if (consolidation) {
    return {
      reason: "consolidation_mapping",
      evidence:
        `agency-consolidations: '${candidate.label}, ${candidate.state}' maps to ` +
        `${consolidation.alias} (historical ORI ${consolidation.historicalOri})`,
    };
  }
  const exclusionKey = `${candidate.label}, ${candidate.state ?? ""}`;
  if ((CONSOLIDATION_EXCLUSIONS as readonly string[]).includes(exclusionKey)) {
    return {
      reason: "capability_path_unavailable",
      evidence: `agency-consolidations: '${exclusionKey}' is an explicit consolidation exclusion`,
    };
  }

  // A year outside the source's coverage is established from the source's own
  // declared range, which is evidence independent of any per-entity probe.
  if (context.sourceYearRange && candidate.requestedYears.length > 0) {
    const outside = candidate.requestedYears.filter(
      (year) => year < context.sourceYearRange!.min || year > context.sourceYearRange!.max,
    );
    if (outside.length === candidate.requestedYears.length) {
      return {
        reason: "outside_source_years",
        evidence:
          `source '${context.sourceId}' covers ${context.sourceYearRange.min}-${context.sourceYearRange.max}; ` +
          `requested ${outside.join(", ")}`,
      };
    }
  }

  // Everything below requires probe output. Without it we know nothing, and §7
  // forbids turning that into a source claim.
  if (!probe) {
    return {
      reason: "unknown",
      evidence: null,
    };
  }

  if (!probe.existsInSource) {
    return { reason: "not_in_source", evidence: probe.evidence };
  }

  // Present in the source but absent for the requested years: a real reporting
  // gap, distinct from not existing at all.
  if (candidate.requestedYears.length > 0 && probe.yearsWithData.length > 0) {
    const missingYears = candidate.requestedYears.filter((year) => !probe.yearsWithData.includes(year));
    if (missingYears.length === candidate.requestedYears.length) {
      return {
        reason: "nonreporting_period",
        evidence: `${probe.evidence}; no data for requested year(s) ${missingYears.join(", ")}`,
      };
    }
  }

  // The entity exists, the years overlap, and it still did not come back. The
  // cause is somewhere in this product's query path, which is a capability
  // statement -- not a claim that the source lacks the data.
  return {
    reason: "capability_path_unavailable",
    evidence: `${probe.evidence}; entity is present and in range but absent from this result`,
  };
}

/**
 * Attribute every omitted candidate, batching the probe work.
 *
 * Never throws. An attribution failure degrades that candidate to `unknown`,
 * because a thrown error here would propagate into a user's request over a
 * diagnostic concern.
 */
export function attributeOmissions(
  candidates: OmittedCandidate[],
  context: AttributionContext,
): OmissionAttribution {
  if (candidates.length === 0) {
    return { omissions: [], probesRun: 0, unattributed: [] };
  }

  const { results, probesRun } = batchExistenceProbe(context, candidates);
  const omissions: Omission[] = [];
  const unattributed: string[] = [];

  for (const candidate of candidates) {
    let reason: OmissionReason;
    let evidence: string | null;
    try {
      const attributed = attributeOne(candidate, context, results.get(candidate.entityId));
      reason = attributed.reason;
      evidence = attributed.evidence;
    } catch {
      reason = "unknown";
      evidence = null;
    }

    const omission: Omission = {
      entityId: candidate.entityId,
      label: candidate.label,
      reason,
      evidence,
    };

    // Validate against the frozen contract before recording. A reason that cannot
    // justify itself is downgraded to `unknown` here rather than being stored and
    // later rendered to a user as a source limitation.
    try {
      assertOmissionEvidence(omission);
    } catch {
      omission.reason = "unknown";
      omission.evidence = null;
    }

    if (omission.reason === "unknown") unattributed.push(candidate.entityId);
    omissions.push(omission);
  }

  return { omissions, probesRun, unattributed };
}
