/**
 * A supported year-over-year count comparison for Current Trends, on a FIXED COMPARISON GROUP.
 *
 * WHY THIS EXISTS. GC-055 asked "did violent crime decrease every year from 2023 to 2026?" and got
 * `decreased: "Yes"` for a five-month 2026 against a full-year 2025. The run before, the same
 * question produced `pct_change: -61.9`. Two representations of one operation, and the existing
 * control only recognised the numeric one. So this plan does not infer the operation from a
 * returned column: the request declares it (`contract.comparability.comparison`), and this module
 * owns the periods, the evidence, the arithmetic and the delivered text.
 *
 * WHY A GROUP RATHER THAN THE WHOLE SAMPLE. An earlier version required every member of the stored
 * sample to have reported every required cell. Measured against the real offline source that
 * certified nothing at all: `sample_agencies` admits an agency with a row in every distinct MONTH
 * (`scripts/update-rtci-db.py:258-270`), which is not per-offence completeness, and the import
 * skips blank or invalid offence values (`:130-137`). Measured on that source, one agency short in
 * a cell was enough to block BOTH checked questions across all six of their years — safe, and
 * useless for them. That is a two-case observation, not a proof that the rule could never certify
 * any question anywhere.
 *
 * So the population changed, not the standard of evidence. The comparison uses ONE FIXED GROUP,
 * selected inside the stored sample by having a valid observation in every required
 * year/month/offence cell across the WHOLE requested span — never one group per year, and never
 * selected on whether a count rose or fell. Complete reporting is still required; it is required of
 * the group. Equal contributor COUNTS are not evidence of equal agencies, which is why membership
 * is tracked by identifier and why a rotating set yields no group at all.
 *
 * A VALID RECORDED ZERO COUNTS AS REPORTING. A missing or null observation does not. `MISSING IS
 * NOT ZERO` still holds: absent months and absent offences are never filled in.
 *
 * THREE STATEMENTS, ONE SNAPSHOT, SELECTION IN SQL. The required periods, the membership and the
 * group's totals are separate statements that share their `WITH` prefix verbatim and are executed
 * together by `executeManyWithTimeoutSync` — one worker, one read-only connection, one read
 * transaction. Both properties matter: the shared prefix makes them describe the same scope, and
 * the shared snapshot makes them describe the same moment, so a group selected in one read can
 * never license totals from another. Membership is decided by aggregation, so no round trip to
 * TypeScript is needed and the diagnostic's 90,036-row scan is not repeated in production.
 *
 * ONE CLEAR POPULATION IN THE ANSWER. These are comparison-group figures — not the stored sample
 * and not a national estimate. The delivered text states the group size, the starting sample size,
 * the excluded count and the exclusion reason, and the title agrees with it; a late footnote cannot
 * repair a headline that implies otherwise.
 *
 * WHAT THIS DELIBERATELY WILL NOT DO. It never shortens a completed year to match a partial one, and
 * a required month stays required even when the requested offence is wholly absent from it — the
 * group comes back empty instead. It never withholds the prior-period total: Decision 17 permits
 * both figures, so what is withheld is the derived change alone. A gapped month set is certified on
 * the same terms as any other, labelled exactly by `describeMonths`. Equal membership never licenses
 * unequal months.
 */

import type { ChartMeta } from "./types";
import { buildQueryContract } from "./query-contract";
import { describeMonths } from "./period-comparison";

/** The Current offense labels for the supported topics. NIBRS codes are not `offense` values. */
const CURRENT_OFFENSES: Record<string, { label: string; offenses: string[] }> = {
  violent_crime: { label: "violent crime", offenses: ["Murder", "Rape", "Robbery", "Aggravated Assault"] },
  murder: { label: "murder", offenses: ["Murder"] },
  rape: { label: "rape", offenses: ["Rape"] },
  robbery: { label: "robbery", offenses: ["Robbery"] },
  aggravated_assault: { label: "aggravated assault", offenses: ["Aggravated Assault"] },
  property_crime: { label: "property crime", offenses: ["Burglary", "Theft", "Motor Vehicle Theft"] },
  burglary: { label: "burglary", offenses: ["Burglary"] },
  theft: { label: "theft", offenses: ["Theft"] },
  motor_vehicle_theft: { label: "motor vehicle theft", offenses: ["Motor Vehicle Theft"] },
};

/** The most years this plan will compare in one answer. */
const MAX_YEARS = 12;

export type CurrentYoyComparisonPlan = {
  /** The answer read: one row per year/month/offence with its count, restricted to the group. */
  sql: string;
  /** Evidence read: the required year/month periods, established independently of the offences. */
  periodSql: string;
  /** Evidence read: the starting sample size, independent of whether any agency qualifies. */
  sampleSql: string;
  /** Evidence read: the eligible agency identifiers. Identifiers only, no metadata. */
  membershipSql: string;
  /** Every requested year, ascending. Adjacent pairs are all preserved, not just the endpoints. */
  years: number[];
  offenseLabel: string;
  /** Title-cased offence label, for the delivered title. */
  offenseTitleLabel: string;
  offenses: string[];
  /** The executed columns, for an empty result. */
  columns: string[];
  /** The delivered columns. */
  presentationColumns: string[];
  title: string;
  guardrail: string;
  chartMeta: ChartMeta;
  /**
   * Does the question ask for a claim about the whole run of years ("every year", "each year")?
   * If so, and any adjacent pair is unsupported, the answer must say the run cannot be assessed —
   * silence about the chain would read as assent.
   */
  asksWholeChain: boolean;
};

/** One row of the answer read: a year/month/offence cell and its count. */
export type CurrentYoyAnswerRow = {
  year: number;
  month: number;
  offense: string;
  offense_count: number;
};

/** One row of the period read: a required year/month, independent of the requested offences. */
export type CurrentYoyPeriodRow = { year: number; month: number };

/** One row of the membership read: an eligible agency. Identifiers only. */
export type CurrentYoyMembershipRow = { ori: string };

/** The single row of the sample read: how many agencies the stored sample holds. */
export type CurrentYoySampleRow = { sample_size: number };

/** The comparison group, as selected and counted from one snapshot. */
export type CurrentYoyGroup = {
  /** The eligible agency identifiers, de-duplicated. Local evidence, never a user-facing list. */
  oris: string[];
  includedCount: number;
  startingSampleSize: number;
  /**
   * Is the STORED SAMPLE itself empty?
   *
   * Distinct from an empty group: a nonempty sample in which nobody qualifies is a reporting fact
   * about the agencies, while an empty sample is a fact about the source. The answer must not
   * describe the first as the second.
   */
  sampleIsEmpty: boolean;
  excludedCount: number;
  /** Required year -> the months required for it, from the offence-independent inventory. */
  requiredPeriods: { year: number; months: number[] }[];
  requiredCellsPerAgency: number;
  /** A requested year with no observations at all. Unknown, never vacuously complete. */
  yearsWithNoPeriods: number[];
};

export type YearCertification = {
  year: number;
  /** The certified month set, or null when the year is not certified. */
  months: number[] | null;
  reason: string;
};

export type CurrentYoyPairDecision = {
  year: number;
  against: number;
  state: "matched" | "unequal" | "unestablished";
  /** The shared basis, only when matched. */
  basis: string | null;
  reason: string;
};

export type CurrentYoyAnswer = {
  rows: Record<string, unknown>[];
  columns: string[];
  title: string;
  explanation: string;
  certifications: YearCertification[];
  decisions: CurrentYoyPairDecision[];
  /** Which years had a change value withheld, and why. */
  withheld: { year: number; state: "unequal" | "unestablished" }[];
  /** The group these figures describe. Its identifiers are local evidence, never user-facing. */
  group: CurrentYoyGroup;
};

function sqlNumberList(values: number[]): string {
  return values.map((value) => String(Math.trunc(value))).join(", ");
}

function sqlStringList(values: string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

/**
 * Is this a request this plan is allowed to own?
 *
 * Every condition narrows: the declared comparison with resolved years, a count (not a rate, share
 * or clearance), one supported Current offense topic, the national/default sample with no place
 * named, and no breakdown other than by year. Anything else returns null and the request continues
 * to the paths that already handle it.
 */
export function buildCurrentYoyComparisonPlan(question: string): CurrentYoyComparisonPlan | null {
  const contract = buildQueryContract(question, "current");
  if (!contract) return null;

  const comparison = contract.comparability.comparison;
  // The operation is recorded even when its years do not resolve; this plan needs them resolved.
  if (!comparison.requested || !comparison.years) return null;

  const { startYear, endYear } = comparison.years;
  if (endYear <= startYear) return null;
  if (endYear - startYear + 1 > MAX_YEARS) return null;

  if (contract.metric.unit !== "count") return null;
  const offense = CURRENT_OFFENSES[contract.metric.topic];
  if (!offense) return null;

  /*
   * The national sample, however the request names it.
   *
   * An earlier version admitted `kind: "national"` and then rejected every non-null geography
   * name — and the contract represents an explicitly national request as
   * `kind: "national", name: "United States"`. So "…in the United States" was refused while the
   * same question with no place named was accepted: the more explicit form of the request was the
   * one that fell through. A named SUBNATIONAL place is still out of scope, because it is a
   * different question with different evidence.
   */
  const nationalOrDefaultSample = contract.geographies.every((geo) =>
    geo.kind === "national" || (geo.kind === "unknown" && geo.name === null && geo.state === null));
  if (!nationalOrDefaultSample) return null;

  // By-year is the grain this plan answers in. Any other breakdown belongs elsewhere.
  if (contract.breakdowns.some((breakdown) => breakdown !== "year")) return null;

  // Rankings and per-agency listings are not comparisons of two periods.
  if (/\b(?:rank(?:ed|ing)?|top\s+\d+|which\s+(?:cit(?:y|ies)|states?|agenc(?:y|ies))|by\s+(?:cit(?:y|ies)|state|agency)|per\s+capita|rate)\b/i.test(question)) return null;

  const years: number[] = [];
  for (let year = startYear; year <= endYear; year += 1) years.push(year);

  /*
   * THREE STATEMENTS, ONE SNAPSHOT, AND THE SELECTION DONE IN SQL.
   *
   * The cohort diagnostic answered feasibility by pulling 90,036 per-agency rows and selecting in
   * TypeScript. That must not become the production path, so the group is computed by aggregation
   * instead: `need` derives the required cell count in SQL, `eligible` applies it with a HAVING,
   * and the answer read joins to `eligible`. Nothing needs a round trip to TypeScript to decide
   * membership, so all three statements go to the bounded worker in ONE call and therefore share
   * one read transaction. Row budget is roughly 41 + 558 + 164 instead of 90,036.
   *
   * THE PERIOD INVENTORY IS INDEPENDENT OF THE REQUESTED OFFENCES. `req` deliberately omits the
   * offence filter. The diagnostic took its month inventory from cells that had already been
   * filtered by offence, which would silently drop a month in which the requested offence is wholly
   * absent — turning missing data into a shorter, apparently complete period. Here such a month
   * stays required, no agency can satisfy it, and the group comes back empty. A requested year with
   * no observations at all yields no required months for that year and is reported as unknown, not
   * as a vacuously complete interval.
   *
   * A VALID RECORDED ZERO COUNTS AS REPORTING; a missing or null observation does not. That is why
   * the filter is `am.count IS NOT NULL` and never `am.count > 0`.
   *
   * The answer read still projects only dimensions and one real measure, so it passes the
   * answer-measure guard. The two evidence reads project counts and identifiers and are not
   * answers; they are accounted for by name in the route-placement suite.
   */
  const { periodSql, sampleSql, membershipSql, sql } = currentYoyGroupStatements({ years }, offense.offenses, null);

  const label = offense.label;
  const titleLabel = label.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  return {
    sql,
    periodSql,
    sampleSql,
    membershipSql,
    years,
    offenseLabel: label,
    offenseTitleLabel: titleLabel,
    offenses: offense.offenses,
    columns: ["year", "month", "offense", "offense_count"],
    presentationColumns: ["year", "total", "prior_year_total", "change_pct"],
    // A placeholder only. The delivered title names the comparison group, whose size is not known
    // until the read returns, so `buildCurrentYoyComparisonAnswer` owns the final wording.
    title: `${titleLabel} Counts, ${startYear}-${endYear}`,
    guardrail: "deterministic-current-yoy-comparison",
    chartMeta: { source: "RTCI", agencyCount: 0, population: null },
    asksWholeChain: /\b(?:every|each)\s+year\b|\byear\s+(?:after|on)\s+year\b/i.test(question),
  };
}

/**
 * The fixed comparison group's four statements, shared by this path and the stage 3a typed change (C5) for a state or the
 * nation (plan 2026-10-10-request-accounting-stage3a-current.md r1.2). One `WITH` prefix scopes the required periods,
 * the membership and the totals together, so the three reads still describe the same scope and run in one snapshot.
 *
 *   - `periods`: whole years (this path) or the explicit months a request names (C5: "January to May 2025 vs ...").
 *   - `state`: null for the national sample (this path), or one state's sample agencies.
 *
 * With `{ years }` and no state the statements are, character for character, the ones this path has always issued.
 */
export function currentYoyGroupStatements(
  periods: { years: number[] } | { months: [number, number][] },
  offenses: string[],
  state: string | null,
): { periodSql: string; sampleSql: string; membershipSql: string; sql: string } {
  const periodFilter = "years" in periods
    ? `am.year IN (${sqlNumberList(periods.years)})`
    : `(am.year * 100 + am.month) IN (${sqlNumberList(periods.months.map(([y, m]) => y * 100 + m))})`;
  const stateFilter = state === null ? "" : `\n    AND sa.state = ${sqlStringList([state])}`;
  const offenseListSql = sqlStringList(offenses);
  const withClause = `WITH req AS (
  SELECT am.year AS year, am.month AS month
  FROM agency_monthly am
  JOIN sample_agencies sa ON sa.ori = am.ori
  WHERE ${periodFilter}${stateFilter}
  GROUP BY am.year, am.month
), need AS (
  SELECT COUNT(*) * ${offenses.length} AS n FROM req
), supplied AS (
  SELECT am.ori AS ori
  FROM agency_monthly am
  JOIN sample_agencies sa ON sa.ori = am.ori
  JOIN req r ON r.year = am.year AND r.month = am.month
  WHERE am.offense IN (${offenseListSql})
    AND am.count IS NOT NULL${stateFilter}
  GROUP BY am.ori, am.year, am.month, am.offense
), eligible AS (
  SELECT ori FROM supplied GROUP BY ori HAVING COUNT(*) = (SELECT n FROM need)
)`;

  // Evidence read 1: the required periods, established without reference to the requested offences.
  const periodSql = `${withClause}
SELECT year, month FROM req ORDER BY year, month`;

  /*
   * Evidence read 2: the STARTING SAMPLE SIZE, read independently of whether anything qualifies.
   *
   * This used to ride along on the membership rows as `(SELECT COUNT(...)) AS sample_size`. When no
   * agency qualified, `eligible` returned no rows, so the sample size vanished with them and the
   * answer reported a starting sample of zero and zero exclusions — false accounting of the source
   * on the exact path where the reader most needs the truth. It is its own statement now, always one
   * row, and deliberately carries no agency identifier so it can never be miscounted as a member.
   */
  const sampleSql = state === null
    ? `SELECT COUNT(DISTINCT ori) AS sample_size FROM sample_agencies`
    : `SELECT COUNT(DISTINCT ori) AS sample_size FROM sample_agencies WHERE state = ${sqlStringList([state])}`;

  // Evidence read 3: group membership. Identifiers only; metadata is kept out of these rows.
  const membershipSql = `${withClause}
SELECT e.ori AS ori FROM eligible e ORDER BY e.ori`;

  // The answer read: group-only totals, from the same snapshot as the membership that defined them.
  const sql = `${withClause}
SELECT am.year AS year,
    am.month AS month,
    am.offense AS offense,
    SUM(am.count) AS offense_count
  FROM agency_monthly am
  JOIN eligible e ON e.ori = am.ori
  JOIN req r ON r.year = am.year AND r.month = am.month
  WHERE am.offense IN (${offenseListSql})
    AND am.count IS NOT NULL
  GROUP BY am.year, am.month, am.offense
  ORDER BY am.year, am.month, am.offense`;
  return { periodSql, sampleSql, membershipSql, sql };
}

/**
 * Build the comparison group from the two evidence reads.
 *
 * The required periods come from the offence-INDEPENDENT inventory, so a month in which the
 * requested offence is wholly absent stays required and simply cannot be satisfied. Membership is
 * whatever the SQL `HAVING` admitted: agencies with a valid observation in every required
 * offence/month cell across the whole requested span. Selection never looks at a count's direction,
 * and the group is one fixed set for every period — never one per year.
 */
export function buildCurrentYoyGroup(
  years: number[],
  periods: CurrentYoyPeriodRow[],
  membership: CurrentYoyMembershipRow[],
  sample: CurrentYoySampleRow[],
  offenseCount: number,
): CurrentYoyGroup {
  const monthsByYear = new Map<number, Set<number>>();
  for (const row of periods) {
    const year = Number(row.year);
    const month = Number(row.month);
    if (!Number.isFinite(year) || !Number.isFinite(month)) continue;
    if (!monthsByYear.has(year)) monthsByYear.set(year, new Set());
    monthsByYear.get(year)!.add(month);
  }

  const requiredPeriods = years
    .map((year) => ({ year, months: [...(monthsByYear.get(year) ?? new Set<number>())].sort((a, b) => a - b) }))
    .filter((entry) => entry.months.length > 0);
  const yearsWithNoPeriods = years.filter((year) => (monthsByYear.get(year)?.size ?? 0) === 0);

  /*
   * De-duplicated identifiers, and a sentinel guard. The SQL groups by `ori` so duplicates are not
   * expected, and a null or blank identifier is not an agency — counting one would inflate the
   * group and understate the exclusions.
   */
  const oris = [...new Set(
    membership
      .map((row) => (row.ori === null || row.ori === undefined ? "" : String(row.ori).trim()))
      .filter((ori) => ori.length > 0),
  )].sort();

  // Read from its own statement, so it survives an empty group.
  const startingSampleSize = sample.length > 0 && Number.isFinite(Number(sample[0].sample_size))
    ? Number(sample[0].sample_size)
    : 0;

  return {
    oris,
    includedCount: oris.length,
    startingSampleSize,
    sampleIsEmpty: startingSampleSize === 0,
    excludedCount: Math.max(0, startingSampleSize - oris.length),
    requiredPeriods,
    requiredCellsPerAgency: requiredPeriods.reduce((n, p) => n + p.months.length, 0) * offenseCount,
    yearsWithNoPeriods,
  };
}

/**
 * Certify each requested year against the group.
 *
 * Every group member supplies every required cell by construction, so a year is certified exactly
 * when the group is non-empty and that year has required periods. What certification still does NOT
 * do is make unequal months comparable: equal membership never licenses unequal periods, and the
 * pair decision below is what enforces that.
 */
export function certifyCurrentYoyYears(
  years: number[],
  group: CurrentYoyGroup,
): YearCertification[] {
  return years.map((year) => {
    if (group.includedCount === 0) {
      return {
        year, months: null,
        reason: "no agency reported every requested crime in every required month across the whole period",
      };
    }
    const required = group.requiredPeriods.find((p) => p.year === year);
    if (!required) {
      // A requested year with no observations at all is unknown, never a complete empty interval.
      return { year, months: null, reason: `the source holds no ${year} observations for this sample` };
    }
    return {
      year, months: required.months,
      reason: `all ${group.includedCount} agencies in the comparison group reported ${describeMonths(required.months)} ${year}`,
    };
  });
}

/**
 * Does the answer read cover exactly the required cells, and nothing else?
 *
 * The answer read joins the same `req` and `eligible` CTEs, so this should always hold; it is
 * checked rather than assumed because the delivered totals must describe the required periods and
 * the selected group, and a silent divergence is the failure that requirement exists for. An
 * answer with FEWER cells than required would mean a required cell had no group observation, which
 * selection is supposed to have made impossible.
 */
export function answerCoversRequiredCells(
  answer: CurrentYoyAnswerRow[],
  group: CurrentYoyGroup,
  offenses: string[],
): boolean {
  if (group.includedCount === 0) return answer.length === 0;
  const required = new Set<string>();
  for (const p of group.requiredPeriods) for (const m of p.months) for (const o of offenses) required.add(`${p.year}|${m}|${o}`);
  const returned = new Set(answer.map((r) => `${Number(r.year)}|${Number(r.month)}|${String(r.offense)}`));
  if (required.size !== returned.size) return false;
  for (const key of required) if (!returned.has(key)) return false;
  return true;
}

/** Decide every adjacent pair in the requested run — not only the endpoints. */
export function decideCurrentYoyPairs(certifications: YearCertification[]): CurrentYoyPairDecision[] {
  const decisions: CurrentYoyPairDecision[] = [];
  for (let i = 1; i < certifications.length; i += 1) {
    const now = certifications[i];
    const prev = certifications[i - 1];
    if (!now.months || !prev.months) {
      const unresolved = !now.months ? now : prev;
      decisions.push({
        year: now.year, against: prev.year, state: "unestablished", basis: null,
        reason: unresolved.reason,
      });
      continue;
    }
    const same = now.months.length === prev.months.length && now.months.every((m, idx) => m === prev.months![idx]);
    if (!same) {
      decisions.push({
        year: now.year, against: prev.year, state: "unequal", basis: null,
        reason: `${prev.year} covers ${describeMonths(prev.months)} and ${now.year} covers ${describeMonths(now.months)}`,
      });
      continue;
    }
    decisions.push({
      year: now.year, against: prev.year, state: "matched",
      basis: describeMonths(now.months),
      reason: `both cover ${describeMonths(now.months)}`,
    });
  }
  return decisions;
}

function roundedPercent(now: number, prev: number): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(prev) || prev === 0) return null;
  return Math.round((1000 * (now - prev)) / prev) / 10;
}

/**
 * Build the delivered answer from the executed evidence.
 *
 * `prior_year_total` is always present and always labelled — a prior-period observation is not a
 * change claim, and Decision 17 permits both figures. `change_pct` is null wherever the pair is not
 * matched; null renders as an empty cell, and a zero would assert no change.
 */
export function buildCurrentYoyComparisonAnswer(
  plan: CurrentYoyComparisonPlan,
  answerRows: CurrentYoyAnswerRow[],
  group: CurrentYoyGroup,
): CurrentYoyAnswer {
  const certifications = certifyCurrentYoyYears(plan.years, group);
  const decisions = decideCurrentYoyPairs(certifications);
  // The delivered totals are summed from the group's own cells, in the snapshot that selected it.
  const totals = new Map<number, number>();
  for (const row of answerRows) {
    const count = Number(row.offense_count);
    if (!Number.isFinite(count)) continue;
    const year = Number(row.year);
    totals.set(year, (totals.get(year) ?? 0) + count);
  }

  const decisionFor = new Map<number, CurrentYoyPairDecision>();
  for (const decision of decisions) decisionFor.set(decision.year, decision);

  const withheld: CurrentYoyAnswer["withheld"] = [];
  const presented: Record<string, unknown>[] = [];
  for (let i = 0; i < plan.years.length; i += 1) {
    const year = plan.years[i];
    const total = totals.has(year) ? totals.get(year)! : null;
    const priorYear = i > 0 ? plan.years[i - 1] : null;
    const priorTotal = priorYear !== null && totals.has(priorYear) ? totals.get(priorYear)! : null;
    const decision = decisionFor.get(year);

    let change: number | null = null;
    if (decision) {
      if (decision.state === "matched") {
        if (total !== null && priorTotal !== null) change = roundedPercent(total, priorTotal);
      } else if (total !== null && priorTotal !== null) {
        // Both totals exist and could have been divided; the pair's coverage is why they were not.
        withheld.push({ year, state: decision.state });
      }
    }

    presented.push({ year, total, prior_year_total: priorTotal, change_pct: change });
  }

  const span = `${plan.years[0]}-${plan.years[plan.years.length - 1]}`;
  const sentences: string[] = [];

  /*
   * ONE CLEAR POPULATION, SAID FIRST.
   *
   * These are comparison-group figures: neither the full stored sample nor a national estimate. A
   * late footnote cannot repair a headline that implies otherwise, so the population, the group
   * size, the starting sample, the excluded count and the exclusion reason all appear up front, and
   * the title below agrees with them.
   */
  if (group.includedCount > 0) {
    sentences.push(
      `Reported ${plan.offenseLabel} counts for a fixed comparison group of ${group.includedCount} agencies, ${plan.years[0]} to ${plan.years[plan.years.length - 1]}, with the year-over-year change shown only where the compared years rest on the same reporting.`
    );
    sentences.push(
      `This comparison uses the same ${group.includedCount} agencies from a starting sample of ${group.startingSampleSize}.`
    );
    // The excluded count is stated when it is zero as well as when it is positive: "we excluded
    // some" and "we excluded none" are different facts, and silence reads as the first.
    sentences.push(group.excludedCount > 0
      ? `We excluded ${group.excludedCount} because their records did not include every requested crime for every required month.`
      : "No agencies were excluded: every agency in the starting sample had records for every requested crime in every required month.");
    sentences.push(
      "These figures describe that reporting group, not all crime in the United States, and may differ from totals shown elsewhere for the larger sample."
    );
  } else if (group.sampleIsEmpty) {
    // A fact about the source, not about the agencies.
    sentences.push(
      `No comparison is shown for ${plan.offenseLabel} over ${span}: the stored reporting sample is empty, so there were no agencies to compare.`
    );
  } else {
    /*
     * A nonempty sample in which nobody qualified. The starting size and the excluded count are
     * both real and both stated — an earlier version read the sample size off the membership rows,
     * which vanish on this path, and so reported a starting sample of zero and zero exclusions.
     */
    sentences.push(
      `No fixed comparison group could be formed for ${plan.offenseLabel} over ${span}: of the ${group.startingSampleSize} agencies in the starting sample, none had records covering every requested crime in every required month, so all ${group.excludedCount} were excluded. No comparison is shown.`
    );
  }

  for (const certification of certifications) {
    sentences.push(certification.months
      ? `${certification.year} covers ${describeMonths(certification.months)}.`
      : `Coverage for ${certification.year} is not established: ${certification.reason}.`);
  }

  const delivered = decisions.filter((decision) => decision.state === "matched");
  for (const decision of delivered) {
    sentences.push(`The ${decision.against}-to-${decision.year} change is shown: ${decision.reason}.`);
  }
  for (const decision of decisions.filter((d) => d.state !== "matched")) {
    /*
     * Only claim the totals are shown when they actually are. This sentence used to be appended
     * unconditionally, so an empty group — every total null — was told its totals were shown above.
     */
    const bothTotalsShown = totals.has(decision.year) && totals.has(decision.against);
    sentences.push(bothTotalsShown
      ? `The ${decision.against}-to-${decision.year} change is not shown, because ${decision.reason}. The totals for both years are unchanged and are shown above.`
      : `The ${decision.against}-to-${decision.year} change is not shown, because ${decision.reason}.`);
  }

  if (plan.asksWholeChain && (delivered.length !== decisions.length || group.includedCount === 0)) {
    sentences.push(
      `Because at least one year-to-year step could not be compared on the same reporting, this result does not establish whether ${plan.offenseLabel} moved in the same direction in every year of ${span}.`
    );
  }

  sentences.push(
    "For comprehensive state-level estimates, try the Historical Library tab."
  );

  /*
   * The title must agree with the population the explanation names. "National Sample" was wrong for
   * a selected group, and a group size is not known until the read returns — which is why the plan
   * supplies only a placeholder and the final wording is built here.
   */
  const title = group.includedCount > 0
    ? `${plan.offenseTitleLabel} Counts, Comparison Group of ${group.includedCount} Agencies, ${span}`
    : `${plan.offenseTitleLabel} Counts, ${span} — No Comparison Group Available`;

  return {
    rows: presented,
    columns: plan.presentationColumns,
    title,
    explanation: sentences.join(" "),
    certifications,
    decisions,
    withheld,
    group,
  };
}
