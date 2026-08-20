import type { QueryContract, QueryContractSource } from "./query-contract";
import { detectRequestedGrain } from "./requested-grain";
import { analyzeSql, LITERAL_SOURCE, type SelectItem } from "./sql-lineage";
import {
  allTopicColumns,
  catalogedTables,
  producesLevel,
  requirementColumns,
  requirementSatisfied,
  resolveUnit,
  tableSemantics,
  topicColumns,
  topicIsKnown,
  topicUnitRequirement,
  type EntityLevel,
  type TableSemantics,
} from "./table-semantics";

/**
 * Prove that each returned factual series comes from a source that can actually represent the
 * requested geography, offense, grain and denominator.
 *
 * The first version of this module compared the SET OF TABLES MENTIONED against the request, which
 * is the "a literal appears somewhere, therefore safe" defect the county-ORI validator had to fix
 * twice. Four shapes passed it, all reproduced before this rewrite:
 *
 *   decorative denominator   COUNT(*) * 100000.0 / i.population  with state_population joined and
 *                            entirely unused -- the rate still divided by the per-agency column.
 *   cross-offense            SELECT hac.robbery AS murders  for a murder question.
 *   uncatalogued source      SELECT COUNT(*) AS murders FROM source_build_receipts.
 *   mixed series             one compatible table authorising an incompatible second series.
 *
 * So this works from `sql-lineage.ts`, which resolves each returned expression to the base tables
 * its columns actually come from, and evaluates every factual series independently. Anything that
 * cannot be resolved is a finding, not a pass: a shape we cannot prove is not a shape we execute.
 */

export type StructuralSeverity = "block" | "retry";

export type StructuralFinding = {
  ruleId: string;
  severity: StructuralSeverity;
  message: string;
  requestedLevel: EntityLevel;
  /** Which returned series produced this finding, for the retry directive. */
  series: string | null;
};

export type RequestedScope = {
  rowLevel: EntityLevel;
  evidence: string;
  unit: QueryContract["metric"]["unit"];
  topic: string;
  grain: "monthly" | "annual" | null;
};

/**
 * A request can name a place to filter by and a different level to break out by. "Top 10 US cities"
 * filters nationally and returns cities. Ordered finest-first.
 */
const ROW_LEVEL_CUES: { level: EntityLevel; pattern: RegExp; label: string }[] = [
  {
    level: "agency", label: "asks for a list of agencies or departments",
    pattern: /\b(?:top|bottom|best|worst|highest|lowest|most|fewest|rank(?:ed|ing)?|list|which|every|all)\b[^.?!]{0,40}\b(?:agenc(?:y|ies)|police\s+departments?|sheriff'?s?\s+offices?)\b|\bby\s+agenc(?:y|ies)\b|\bagenc(?:y|ies)\s+(?:with|that|ranked)\b/i,
  },
  {
    level: "city", label: "asks for a list of cities",
    pattern: /\b(?:top|bottom|best|worst|highest|lowest|most|fewest|rank(?:ed|ing)?|list|which|every|all|safest|deadliest)\b[^.?!]{0,40}\bcit(?:y|ies)\b|\bby\s+cit(?:y|ies)\b|\bcit(?:y|ies)\s+(?:with|that|ranked|had|have)\b/i,
  },
  {
    level: "county", label: "asks for a list of counties",
    pattern: /\b(?:top|bottom|highest|lowest|most|fewest|rank(?:ed|ing)?|list|which|every|all)\b[^.?!]{0,40}\b(?:count(?:y|ies)|parish(?:es)?)\b|\bby\s+count(?:y|ies)\b|\bcount(?:y|ies)\s+(?:with|that|ranked)\b/i,
  },
  {
    level: "state", label: "asks for a list of states",
    pattern: /\b(?:top|bottom|highest|lowest|most|fewest|rank(?:ed|ing)?|list|which|every|all)\b[^.?!]{0,40}\bstates?\b|\bby\s+state\b|\bstates?\s+(?:with|that|ranked)\b/i,
  },
];

const GEOGRAPHY_TO_LEVEL: Record<QueryContract["geography"]["kind"], EntityLevel> = {
  city: "city", county: "county", state: "state", agency: "agency", campus: "agency",
  national: "national", unknown: "unknown",
};

/** Columns that describe a row rather than measure it. */
const DIMENSION_COLUMNS = new Set([
  "year", "month", "quarter", "data_year", "date", "incident_date", "state", "state_name", "ori",
  "agency", "agency_name", "city", "county", "county_key", "type", "agency_type", "pop_group",
  "ori9", "name", "division", "region", "start", "end", "id", "incident_number", "incident_num",
  // A population column is a denominator or a context column beside the measure, not the measure.
  // Selecting it is how several real queries show the rate's base.
  "population",
]);

export function requestedScope(question: string, contract: QueryContract): RequestedScope {
  // Reuse the existing detector so the pre-execution check and `validateGrain()` cannot disagree.
  const grain = detectRequestedGrain(question);

  for (const cue of ROW_LEVEL_CUES) {
    if (cue.pattern.test(question)) {
      return { rowLevel: cue.level, evidence: cue.label, unit: contract.metric.unit, topic: contract.metric.topic, grain };
    }
  }
  for (const breakdown of contract.breakdowns) {
    if (breakdown === "city" || breakdown === "state" || breakdown === "agency") {
      return {
        rowLevel: breakdown as EntityLevel, evidence: `contract breakdown "${breakdown}"`,
        unit: contract.metric.unit, topic: contract.metric.topic, grain,
      };
    }
  }
  return {
    rowLevel: GEOGRAPHY_TO_LEVEL[contract.geography.kind],
    evidence: `requested geography is ${contract.geography.kind}`,
    unit: contract.metric.unit, topic: contract.metric.topic, grain,
  };
}

/**
 * Levels the question explicitly names in addition to the one it is about.
 *
 * "Compare murders in Chicago to the national total" legitimately returns a city series AND a
 * national one. Licensing is deliberately narrow: a coarser series is allowed only when the
 * question names that level in words AND another series in the same query actually serves the
 * requested level. Without both, "top 10 us cities" would license `national` from the word "us"
 * and a state-row answer would slip through again.
 */
function licensedLevels(question: string): EntityLevel[] {
  const levels: EntityLevel[] = [];
  if (/\b(?:national(?:ly|wide)?|united\s+states|countrywide)\b/i.test(question)) levels.push("national");
  if (/\bstate(?:wide)?\b/i.test(question)) levels.push("state");
  return levels;
}

/** Does this returned expression carry a measurement, as opposed to labelling the row? */
function isFactualSeries(item: SelectItem): boolean {
  const real = item.refs.filter((ref) => ref.table !== LITERAL_SOURCE);
  // A wildcard returns whatever the table holds. It carries measurements by definition, and none of
  // them can be checked, so it must be treated as factual and then fail closed below.
  if (item.hasWildcard) return true;
  if (item.countsRows) return true;
  if (real.length === 0) return false;
  return real.some((ref) => !DIMENSION_COLUMNS.has(ref.column));
}

/**
 * Resolve each reference to a base table, narrowing a CTE shortlist by role.
 *
 * A deterministic multi-city plan builds a CTE that joins `historical_agency_crime` to
 * `historical_agency`, so a column drawn from it could come from either. Exactly one of them is a
 * metric table, and a measure can only have come from that one. Narrowing this way keeps real plans
 * working without weakening the check: if the shortlist holds two metric tables it stays unresolved.
 */
function tablesOf(
  refs: { table: string | null; candidates?: string[] }[],
  source: QueryContractSource
): (string | null)[] {
  const resolved: (string | null)[] = [];
  for (const ref of refs) {
    if (ref.table === LITERAL_SOURCE) continue;   // supplied by the query, not read from a table
    if (ref.table) { resolved.push(ref.table); continue; }
    const metric = (ref.candidates ?? [])
      .filter((table) => tableSemantics(source, table)?.role === "metric");
    resolved.push(metric.length === 1 ? metric[0] : null);
  }
  return [...new Set(resolved)];
}

function serves(entry: TableSemantics, scope: RequestedScope, source: QueryContractSource): boolean {
  if (entry.role !== "metric") return false;
  if (!producesLevel(entry, scope.rowLevel)) return false;
  switch (scope.unit) {
    case "clearance_rate":
      return entry.measures.includes("clearance_rate");
    case "rate_per_100k":
      if (entry.measures.includes("rate_per_100k")) return true;
      if (!entry.measures.includes("count")) return false;
      return catalogedTables(source).some(
        (other) => (other.denominatorLevels ?? []).includes(scope.rowLevel)
      );
    default:
      return entry.measures.includes("count") || entry.measures.includes("rate_per_100k");
  }
}

/** Could ANY table in this source answer the request? Decides retry versus decline. */
function repairable(scope: RequestedScope, source: QueryContractSource): boolean {
  return catalogedTables(source).some((entry) => serves(entry, scope, source));
}

/** Does this expression's division bind a population valid at the requested level? */
function denominatorApproved(
  item: SelectItem, scope: RequestedScope, source: QueryContractSource
): boolean {
  if (item.denominatorRefs === null) return false;
  return item.denominatorRefs.some((ref) => {
    const entry = ref.table ? tableSemantics(source, ref.table) : null;
    return Boolean(entry && (entry.denominatorLevels ?? []).includes(scope.rowLevel));
  });
}

export function evaluateStructuralSemantics(opts: {
  question: string;
  source: QueryContractSource;
  contract: QueryContract;
  sql: string;
}): StructuralFinding[] {
  const scope = requestedScope(opts.question, opts.contract);
  const lineage = analyzeSql(opts.sql);
  const findings: StructuralFinding[] = [];
  const canBeFixed = repairable(scope, opts.source);
  const add = (
    ruleId: string, severity: StructuralSeverity, message: string, series: string | null
  ) => { findings.push({ ruleId, severity, message, requestedLevel: scope.rowLevel, series }); };

  if (lineage.unsupportedShape) {
    add("structural-unsupported-sql-shape", "retry",
      `This query is ${lineage.unsupportedShape}, and only its first branch can be traced. Each ` +
      "returned series has to be checked against the request, so write it as a single SELECT over " +
      "the supported tables.", null);
    return findings;
  }

  if (!lineage.parsed) {
    add("structural-returned-series-unresolved", "retry",
      "The returned columns could not be traced to their source tables, so nothing proves this " +
      "query answers the question asked. Rewrite it as a plain SELECT over the supported tables.",
      null);
    return findings;
  }

  const factual = lineage.items.filter(isFactualSeries);
  if (factual.length === 0) return findings;

  // Every offense the question asked for, not just the first.
  const requestedTopics = opts.contract.metric.offenses.length > 0
    ? opts.contract.metric.offenses.map((offense) => offense.topic)
    : [scope.topic];

  const licensed = licensedLevels(opts.question);
  const someSeriesServesRequestedLevel = factual.some((item) => {
    const tables = item.refs.length > 0 ? tablesOf(item.refs, opts.source) : lineage.baseTables;
    return tables.some((table) => {
      const entry = table ? tableSemantics(opts.source, table) : null;
      return Boolean(entry && entry.role === "metric" && producesLevel(entry, scope.rowLevel));
    });
  });

  for (const item of factual) {
    const label = item.alias ?? item.raw.slice(0, 40);

    if (item.hasWildcard) {
      add("structural-wildcard-projection", "retry",
        `"${label}" selects every column, so nothing states which measure is being returned or ` +
        "whether it matches the request. Name the columns the answer needs.", label);
      continue;
    }

    const narrowed = item.refs.length > 0 ? tablesOf(item.refs, opts.source) : [];
    if (!item.resolved || narrowed.includes(null)) {
      add("structural-returned-series-unresolved", "retry",
        `The returned value "${label}" could not be traced to a source table, so nothing proves it ` +
        "measures what was asked for. Qualify each column with its table.", label);
      continue;
    }

    // COUNT(*) with no column refs takes its meaning from the FROM clause.
    const refTables = item.refs.length > 0 ? tablesOf(item.refs, opts.source) : lineage.baseTables;
    const entries: TableSemantics[] = [];
    let sawUnknown = false;
    for (const table of refTables) {
      if (!table) { sawUnknown = true; continue; }
      const entry = tableSemantics(opts.source, table);
      if (!entry) {
        sawUnknown = true;
        add("structural-uncatalogued-factual-source", "retry",
          `"${label}" is read from \`${table}\`, whose meaning is not established for this source. ` +
          "An unverified table cannot authorise a factual answer. Use a supported table, or say " +
          "plainly that this cannot be answered.", label);
        continue;
      }
      entries.push(entry);
    }
    if (sawUnknown || entries.length === 0) continue;

    // A directory referenced next to a metric table is a filter or a label -- deterministic plans
    // legitimately write SUM(CASE WHEN ha.agency = 'Baltimore' THEN hac.murder END). It is only a
    // defect when the measure has NO metric source at all.
    const hasMetricSource = entries.some((entry) => entry.role === "metric");
    for (const entry of entries) {
      if (!hasMetricSource &&
          (entry.role === "identity" || entry.role === "crosswalk" || entry.role === "support")) {
        add("structural-non-factual-source", "retry",
          `"${label}" is measured from \`${entry.table}\`, which is a ${entry.role} table and holds ` +
          "no offense counts. Counting its rows answers a different question.", label);
        continue;
      }
      if (entry.role !== "metric") continue;

      // --- geography ---------------------------------------------------------------------
      const licensedHere = someSeriesServesRequestedLevel &&
        licensed.some((level) => producesLevel(entry, level));
      if (scope.rowLevel !== "unknown" && !producesLevel(entry, scope.rowLevel) && !licensedHere) {
        add("structural-row-level-substitution", canBeFixed ? "retry" : "block",
          `"${label}" is ${scope.rowLevel}-level in the request (${scope.evidence}) but comes from ` +
          `\`${entry.table}\`, which produces ${entry.outputLevels.join("/") || "no"}-level rows. ` +
          (canBeFixed
            ? "Use a table that can represent the requested place."
            : `No table in this source carries this measure at ${scope.rowLevel} level, so this ` +
              "cannot be rewritten -- say so plainly instead."),
          label);
      }

      // --- aggregating a measure whose components are gone -------------------------------
      if (entry.components === "absent" && entry.aggregation === "not-aggregatable" &&
          scope.rowLevel !== "unknown" && !entry.outputLevels.includes(scope.rowLevel)) {
        add("structural-clearance-not-aggregatable", "block",
          `\`${entry.table}\` stores ${entry.rowKey}-level values without the components needed to ` +
          `re-derive them, so they cannot be combined into a ${scope.rowLevel}-level figure. ` +
          "Report it at a level the table supports, or decline.", label);
      }

      // --- offense ------------------------------------------------------------------------
      // Enforced only where the selected COLUMN is itself the claim. Code and value predicates
      // (NIBRS `ucr_offense_code`, Current Trends `offense`) are left to the existing offense-code
      // validation rather than duplicated into a second vocabulary here.
      // MEMBERSHIP: is any selected column a DIFFERENT offense from the ones requested?
      // The unit is part of the measure: `murder_rate` does not answer "how many murders", and
      // `murder` does not answer "what is the murder rate" unless a denominator is bound.
      const expected = [...new Set(
        requestedTopics.flatMap((topic) => topicColumns(entry, topic, scope.unit) ?? [])
      )];
      if (expected.length > 0) {
        const everyTopicColumn = allTopicColumns(entry);
        const foreign = item.refs
          .filter((ref) => ref.table === entry.table && everyTopicColumn.has(ref.column))
          .map((ref) => ref.column)
          .filter((column) => !expected.includes(column));
        if (foreign.length > 0) {
          add("structural-measure-substitution", "retry",
            `"${label}" selects ${foreign.map((c) => `\`${c}\``).join(", ")} from ` +
            `\`${entry.table}\`, but the question asks about ${requestedTopics.join(" and ")} ` +
            `measured as ${scope.unit}. Select the requested measure; do not relabel a different one.`, label);
        }
      }
      if (entry.measureBinding.kind === "fixed_topics" && scope.topic !== "unknown" &&
          !entry.measureBinding.topics.includes(scope.topic)) {
        add("structural-measure-unavailable", canBeFixed ? "retry" : "block",
          `\`${entry.table}\` only holds ${entry.measureBinding.topics.join(", ")}, but the question ` +
          `asks about ${scope.topic}.`, label);
      }

      // --- time grain ---------------------------------------------------------------------
      if (scope.grain && !entry.timeGrains.includes(scope.grain)) {
        add("structural-time-grain-unavailable", canBeFixed ? "retry" : "block",
          `${scope.grain} figures were requested, but \`${entry.table}\` carries ` +
          `${entry.timeGrains.join("/")} data.`, label);
      }
    }

    // --- rate denominator, traced rather than assumed --------------------------------------
    if (scope.unit === "rate_per_100k" && scope.rowLevel !== "unknown" && item.denominatorRefs !== null) {
      const denominatorTables = tablesOf(item.denominatorRefs, opts.source)
        .map((table) => (table ? tableSemantics(opts.source, table) : null));
      const approved = denominatorTables.some(
        (entry) => entry && (entry.denominatorLevels ?? []).includes(scope.rowLevel)
      );
      if (!approved) {
        const named = item.denominatorRefs.map((ref) => `${ref.table ?? "?"}.${ref.column}`).join(", ");
        add("structural-rate-denominator-unbound", "retry",
          `The rate "${label}" divides by ${named || "an expression that could not be traced"}, which ` +
          `is not a population valid at ${scope.rowLevel} level. Joining a population table is not ` +
          "enough -- the division itself has to use it.", label);
      }
    } else if (scope.unit === "rate_per_100k" && scope.rowLevel !== "unknown" &&
               item.countsRows && item.refs.length === 0) {
      add("structural-rate-denominator-unbound", "retry",
        `The rate "${label}" has no denominator expression at all.`, label);
    }
  }

  // ---- COMPLETENESS ---------------------------------------------------------------------------
  // Each requested topic is looked for across all returned expressions, but a composite must be
  // satisfied WITHIN ONE expression. Pooling columns across unrelated series meant
  // `SELECT murder, rape, robbery, assault` -- four separate offense series -- counted as a violent
  // crime total, which it is not. A multi-offense request may still use one expression per offense.
  const tablesInPlay = new Set<string>();
  for (const item of factual) {
    for (const ref of item.refs) if (ref.table) tablesInPlay.add(ref.table);
  }

  for (const table of tablesInPlay) {
    const entry = tableSemantics(opts.source, table);
    if (!entry || entry.role !== "metric" || entry.measureBinding.kind !== "topic_columns") continue;

    const everyTopicColumn = allTopicColumns(entry);
    const usesAMeasure = factual.some((item) =>
      item.refs.some((ref) => ref.table === table && everyTopicColumn.has(ref.column)));
    if (!usesAMeasure) continue;

    // A unit the catalog does not model cannot be satisfied by another unit's columns. Until a
    // share's numerator and denominator are represented, the honest outcome is a rewrite and then a
    // decline -- never a count standing in for a proportion.
    const resolvedUnit = resolveUnit(scope.unit);
    if (resolvedUnit.kind === "unmodeled") {
      if (requestedTopics.some((topic) => topicIsKnown(entry, topic))) {
        add("structural-measure-unit-unmodeled", "retry",
          `The question asks for a ${resolvedUnit.unit}, and \`${table}\` does not model one -- a ` +
          "share needs a numerator and a denominator, and neither is established here. Return the " +
          "underlying counts, or say plainly that this cannot be computed.", null);
      }
      continue;
    }
    if (resolvedUnit.kind === "unspecified") continue;

    for (const topic of requestedTopics) {
      if (!topicIsKnown(entry, topic)) continue;
      const requirement = topicUnitRequirement(entry, topic, scope.unit);
      if (!requirement) {
        add("structural-measure-unavailable", canBeFixed ? "retry" : "block",
          `\`${table}\` does not express ${topic} as ${scope.unit}.`, null);
        continue;
      }

      const satisfiedBySome = factual.some((item) => {
        const columns = new Set(
          item.refs.filter((ref) => ref.table === table).map((ref) => ref.column));
        if (requirement.direct && requirementSatisfied(requirement.direct, columns)) return true;
        // Counts can produce a rate only when the division binds an approved denominator.
        return Boolean(requirement.derivedFrom
          && requirementSatisfied(requirement.derivedFrom, columns)
          && denominatorApproved(item, scope, opts.source));
      });
      if (satisfiedBySome) continue;

      const describe = (req: typeof requirement.direct) =>
        req ? requirementColumns(req).map((c) => `\`${c}\``).join(" and ") : null;
      const wanted = [describe(requirement.direct), describe(requirement.derivedFrom)]
        .filter(Boolean).join(", or derived from ");
      add("structural-measure-incomplete", "retry",
        `The question asks for ${topic} as ${scope.unit}, which \`${table}\` expresses as ` +
        `${wanted || "no supported column"}. No single returned expression provides it. A component ` +
        "is not the total, and separate offense series are not a combined measure.", null);
    }
  }

  return findings;
}

export function catalogCoverage(source: QueryContractSource): {
  tables: number; metric: number; withAbsentComponents: number;
} {
  const entries = catalogedTables(source);
  return {
    tables: entries.length,
    metric: entries.filter((entry) => entry.role === "metric").length,
    withAbsentComponents: entries.filter((entry) => entry.components === "absent").length,
  };
}
