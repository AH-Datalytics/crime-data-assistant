/**
 * Writes the SQL for a declared city ranking, per source.
 *
 * Every predicate here comes from a named field of the request. There is no path that emits an
 * eligibility condition the request did not state, which is why the three saved defects cannot be
 * reproduced through this builder: a `HAVING SUM(...) > 0` has nothing to originate from.
 *
 * The two sources are built separately and deliberately. Current stores offenses by NAME in
 * `agency_monthly` with population in `agency_population`; NIBRS stores them by CODE in
 * `summary_city_monthly` with population and the city name on `agencies`. Reusing one shape for
 * both is how a query ends up counting the wrong thing, so the shapes do not share a template.
 *
 * ELIGIBILITY IS TYPED ALL THE WAY DOWN. A population condition becomes a predicate on the
 * population column; a count condition becomes a HAVING on the aggregated measure, and carries the
 * offense it was stated about so it cannot be written against a different one. They are emitted by
 * different branches reading different fields, so no number can cross from one to the other, and a
 * rate is never a filter -- it is only ever what orders the result.
 *
 * A POPULATION RELATIONSHIP IS REQUIRED ONLY WHERE POPULATION IS. The first version inner-joined
 * population into every Current statement, including plain count rankings that need no denominator
 * and stated no population condition -- so a city with offense records and no population row was
 * silently dropped from a ranking that never mentioned population. That is an unrequested
 * eligibility restriction, which is the exact defect this family exists to remove.
 */
import type { CityRankingRequest, CityRankingSource, EligibilityCondition, OffenseIdentity } from "./city-ranking";
import { CURRENT_CITY_AUTHORITY, NIBRS_CITY_AUTHORITY, SHR_CITY_AUTHORITY } from "./entity-authority";
import type { CompletenessPlan } from "./city-ranking-completeness";
import { coverageOf } from "./source-coverage";

export type BuiltCityRanking = {
  sql: string;
  title: string;
  /** The measure column the answer ranks by, for delivery and charting. */
  sortColumn: string;
  columns: string[];
  /** Sentences the source's policy requires be delivered with this answer. */
  caveats: string[];
  guardrail: string;
  /** The period this statement actually covers, for delivery that has to describe it. */
  period: ResolvedPeriod;
  /** The column that names each ranked entity, and its axis label, for delivery and charting. */
  entityColumn: string;
  entityLabel: string;
  /**
   * City rankings (every source; not reporting jurisdictions): what the shared S1 completeness decision
   * needs (lib/city-ranking-completeness.ts). The ranked statement is `sql` when nothing is excluded.
   */
  completeness?: CompletenessPlan;
};

const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** A year the builder is willing to interpolate: four digits, nothing else. */
function safeYear(year: number): number {
  if (!Number.isInteger(year) || year < 1960 || year > 2100) {
    throw new Error(`city-ranking: refusing to build with year ${year}`);
  }
  return year;
}

function safeCount(value: number): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`city-ranking: refusing to build with threshold ${value}`);
  }
  return value;
}

function safeMonth(month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`city-ranking: refusing to build with month ${month}`);
  }
  return month;
}

/* ------------------------------------------------------------------ *
 * Identity uniqueness: why the join cannot multiply the measure
 * ------------------------------------------------------------------ */

/**
 * The uniqueness invariant each source's identity table ENFORCES, and where it is declared.
 *
 * A flat join to an identity table multiplies the measure once per duplicate identity row: two
 * `agencies` rows for one agency-year double every figure, and the rate with it. Two shapes that
 * would defend against that inside the statement -- aggregating the measure in a CTE first, and the
 * same thing as a derived table -- were both built and both rejected by the product's own lineage,
 * which cannot trace a value whose denominator arrives through a subquery
 * (`structural-returned-series-unresolved`). A statement that cannot pass validation cannot be
 * delivered, and widening the parser is outside this milestone.
 *
 * So the protection is the one the schema already provides: both identity tables declare a PRIMARY
 * KEY on exactly the columns this builder joins on, and SQLite ENFORCES it -- a duplicate row
 * cannot be inserted, so the fan-out cannot occur. `scripts/test-city-ranking.ts` asserts three
 * things rather than assuming them: that each retained schema declares that key, that the built
 * join equates exactly those columns (so a future edit to the join drifts away from the key and
 * fails), and that the constraint is enforced rather than decorative.
 *
 * WHAT THIS IS NOT. The retained schema is what the pipeline creates, not a reading of the deployed
 * database. Confirming that the live `agencies` and `agency_population` tables carry these keys is a
 * QUALIFICATION REQUIREMENT recorded for the later source-data gate, not something established here.
 */
// SHR has no entry: its branch joins no identity table (population is on the incident rows), so there
// is no identity fan-out to guard. Its own identity risk, one agency split across two population or
// type values within a year, is checked on the returned rows by the SHR adapter.
export const IDENTITY_UNIQUENESS: Record<
  Exclude<CityRankingSource, "shr">,
  { table: string; key: [string, string]; declaredIn: string }
> = {
  nibrs: { table: "agencies", key: ["ori", "year"], declaredIn: "scripts/fixtures/operation-taxonomy/nibrs.ddl.sql" },
  // `scripts/fetch_population.py` creates this table with the same key; the committed DDL is cited
  // because it is the repository's retained record of the database's own schema.
  current: { table: "agency_population", key: ["ori", "year"], declaredIn: "scripts/fixtures/operation-taxonomy/crime_data.ddl.sql" },
};

/* ------------------------------------------------------------------ *
 * Eligibility predicates
 * ------------------------------------------------------------------ */

function populationPredicates(conditions: EligibilityCondition[], column: string): string[] {
  return conditions
    .filter((condition): condition is Extract<EligibilityCondition, { kind: "population" }> => condition.kind === "population")
    .map((condition) => `${column} ${condition.comparison} ${safeCount(condition.value)}`);
}

function sameOffense(a: OffenseIdentity, b: OffenseIdentity): boolean {
  if (a.kind === "shr_victims" && b.kind === "shr_victims") return a.measure === b.measure;
  if (a.kind === "current_offense" && b.kind === "current_offense") return a.value === b.value;
  if (a.kind === "nibrs_codes" && b.kind === "nibrs_codes") {
    return a.codes.length === b.codes.length && a.codes.every((code, i) => code === b.codes[i]);
  }
  if (a.kind === "nibrs_carjacking" && b.kind === "nibrs_carjacking") return true;
  return false;
}

/**
 * The HAVING for a count threshold.
 *
 * The condition carries the offense it was stated about, and this refuses to emit it against any
 * other one. Recognition already declines a cross-offense threshold; this is the second lock, so a
 * future caller that constructs a request by hand cannot write "at least 100 shoplifting offenses"
 * onto a murder ranking the way the first version did.
 */
function countHaving(request: CityRankingRequest, aggregate: string): string[] {
  return request.eligibility
    .filter((condition): condition is Extract<EligibilityCondition, { kind: "count" }> => condition.kind === "count")
    .map((condition) => {
      if (!sameOffense(condition.offense, request.offense)) {
        throw new Error("city-ranking: refusing to apply a count threshold stated about a different offense");
      }
      return `${aggregate} ${condition.comparison} ${safeCount(condition.value)}`;
    });
}

/* ------------------------------------------------------------------ *
 * Period
 * ------------------------------------------------------------------ */

/**
 * The year the ranking covers.
 *
 * `observed` is the point. `loadRtciCutoff`/`loadNibrsCutoff` fall back to a CLOCK-BASED heuristic
 * when the database read fails, and the first version took only the year and month -- so a guessed
 * date could be delivered as "the latest year with data". Freshness that was never observed cannot
 * establish a period, and the request is declined instead.
 */
export type SourceCutoff = { year: number; month: number; observed: boolean };

export type ResolvedPeriod = {
  year: number;
  /**
   * The last month the SOURCE holds for this year, when that is known from observed evidence.
   * Null means the statement covers the whole year, or that nothing observed says otherwise --
   * and in the second case the answer claims nothing about completeness.
   */
  throughMonth: number | null;
  /** Where the year came from. A requested year is not evidence about coverage. */
  provenance: "requested" | "observed-cutoff";
};

export function resolvePeriod(
  request: CityRankingRequest, cutoff: SourceCutoff | null
): ResolvedPeriod | null {
  if (request.period.kind === "explicit") {
    const year = safeYear(request.period.year);
    /*
     * An EXPLICITLY requested year can still be partial in the source. The first version marked
     * every explicit year complete, so a request for 2025 answered from a source holding January
     * through July said "2025" with nothing to tell the reader five months were missing.
     */
    if (cutoff && cutoff.observed && cutoff.year === year && cutoff.month < 12) {
      return { year, throughMonth: safeMonth(cutoff.month), provenance: "requested" };
    }
    return { year, throughMonth: null, provenance: "requested" };
  }
  // "The latest year with data" is a claim about the source, so it needs observed evidence.
  if (!cutoff || !cutoff.observed) return null;
  const year = safeYear(cutoff.year);
  return {
    year,
    throughMonth: cutoff.month < 12 ? safeMonth(cutoff.month) : null,
    provenance: "observed-cutoff",
  };
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function periodPhrase(period: ResolvedPeriod): string {
  if (period.throughMonth === null) return String(period.year);
  return `${period.year} through ${MONTHS[period.throughMonth - 1]}`;
}

/* ------------------------------------------------------------------ *
 * The builder
 * ------------------------------------------------------------------ */

export function buildCityRanking(
  request: CityRankingRequest, cutoff: SourceCutoff | null
): BuiltCityRanking | null {
  const period = resolvePeriod(request, cutoff);
  if (!period) return null;

  const rate = request.sort.quantity === "rate_per_100k";
  const share = request.sort.quantity === "share_pct";
  if (share && request.source !== "shr") return null;   // recognition declines this; a hand-built request must not slip through
  const direction = request.sort.direction === "asc" ? "ASC" : "DESC";
  const limit = safeCount(request.resultCount);
  const sortColumn = rate ? "rate_per_100k"
    : share ? "firearm_share_pct"
    : request.source === "shr" ? "victims" : "offenses";
  const populationConditions = request.eligibility.filter((condition) => condition.kind === "population");
  /*
   * Population is joined ONLY where the request needs it: as the denominator of a rate, or because
   * the request stated a population condition. A plain count ranking asks nothing of population, so
   * requiring a population row would exclude cities on a criterion nobody wrote.
   */
  const needsPopulation = rate || populationConditions.length > 0;

  let sql: string;
  let columns: string[];
  let completeness: CompletenessPlan | undefined;
  // The request's own conditions, for the shared decision to apply to the candidates in code. The
  // count conditions are the ones `countHaving` has already checked against the ranked offense.
  const decisionConditions = {
    populationConditions: request.eligibility
      .filter((c): c is Extract<EligibilityCondition, { kind: "population" }> => c.kind === "population")
      .map((c) => ({ comparison: c.comparison, value: safeCount(c.value) })),
    countConditions: request.eligibility
      .filter((c): c is Extract<EligibilityCondition, { kind: "count" }> => c.kind === "count")
      .map((c) => ({ comparison: c.comparison, value: safeCount(c.value) })),
    quantity: request.sort.quantity,
    limit,
    direction: (request.sort.direction === "asc" ? "asc" : "desc") as "asc" | "desc",
  };
  const notIn = (column: string, excluded: string[]) => (excluded.length ? [`${column} NOT IN (${excluded.map(quote).join(", ")})`] : []);

  const jurisdiction = request.entityLevel === "jurisdiction";
  if (request.source === "shr") {
    if (jurisdiction) throw new Error("city-ranking: refusing to build an SHR jurisdiction ranking as a city ranking");
    if (request.offense.kind !== "shr_victims") return null;
    /*
     * GC-064 / GC-061. SHR counts VICTIM records (the victims join; one incident can have several
     * victims); the only population on the source is the reporting agency's own, on its incident rows.
     *
     * MEMBERSHIP IS DECIDED BY S1 (lib/entity-authority.ts, lib/city-ranking-completeness.ts), before
     * any LIMIT and before any eligibility filter (Codex combined review, CL3). The candidates statement
     * reads the SCOPE only -- year, months, state, and the murder filter that defines the measure -- with
     * no type, population or count condition, grouped by name, state and (where the request uses
     * population) population, so an agency whose own records disagree comes back as two rows before any
     * filter can remove one of them. Membership comes from the evidence-backed classification, not from
     * the rows; eligibility is applied in code; the ranked statement names exactly the confirmed agencies
     * by ORI and must equal the ranking the candidates predict. County and Other agencies are not cities.
     *
     * No first/last month columns: the all-homicide victim licence refuses any other aggregate over
     * the counted rows, and SHR months with incidents are event presence, not reporting evidence
     * (S2, lib/source-coverage.ts). The coverage limit is stated in words instead.
     */
    const scopeWhere = [`i.year = ${period.year}`];
    if (request.offense.measure === "murder") scopeWhere.push("i.homicide_type = 'Murder'");
    if (period.throughMonth !== null) scopeWhere.push(`i.month <= ${period.throughMonth}`);
    if (request.scope.kind === "state") scopeWhere.push(`i.state = ${quote(request.scope.code)}`);
    const measureWhere = [...populationPredicates(request.eligibility, "i.population"), ...(rate ? ["i.population > 0"] : [])];
    const having = countHaving(request, "COUNT(v.id)");
    const firearm = "SUM(CASE WHEN i.weapon_group = 'Firearm' THEN 1 ELSE 0 END)";
    const measureSelect = rate
      ? ", i.population AS population, ROUND(COUNT(v.id) * 100000.0 / i.population, 2) AS rate_per_100k"
      : share ? `, ${firearm} AS firearm_victims, ROUND(100.0 * ${firearm} / COUNT(v.id), 1) AS firearm_share_pct` : "";
    const exactOrder = rate ? "COUNT(v.id) * 1.0 / i.population" : share ? `${firearm} * 1.0 / COUNT(v.id)` : "COUNT(v.id)";
    /*
     * Membership is NOT a column (Jeff's classification policy, 2026-09-30): SHR records no agency type,
     * and `incidents.agency_type` holds normalizer-derived and legacy values of unknown origin. The adapter
     * decides each candidate from the evidence-backed classification (lib/shr-agency-classification.ts)
     * and this statement ranks exactly the agencies it confirmed, by ORI -- which also leaves out every
     * disagreeing agency, since none of them is confirmed. With none confirmed the list is `(NULL)`, which
     * matches nothing.
     */
    const rankedConfirmed = (oris: string[]) =>
      "SELECT i.agency AS city, i.state AS state, i.ori AS ori" +
      ", COUNT(v.id) AS victims" + measureSelect +
      " FROM incidents i JOIN victims v ON v.incident_id = i.id" +
      ` WHERE ${[...scopeWhere, `i.ori IN (${oris.length > 0 ? oris.map(quote).join(", ") : "NULL"})`, ...measureWhere].join(" AND ")}` +
      " GROUP BY i.ori, i.agency, i.state" + (rate ? ", i.population" : "") +
      (having.length > 0 ? ` HAVING ${having.join(" AND ")}` : "") +
      ` ORDER BY ${exactOrder} ${direction}, i.ori LIMIT ${limit}`;
    columns = ["city", "state", "ori", "victims",
      ...(rate ? ["population", "rate_per_100k"] : share ? ["firearm_victims", "firearm_share_pct"] : [])];
    sql = rankedConfirmed([]);
    // Population is part of the request's identity only where the request uses it; a firearm-share
    // ranking with no population condition is not made partial by an agency's two population values.
    const population = needsPopulation ? ", i.population" : "";
    completeness = {
      source: "shr", authority: SHR_CITY_AUTHORITY, typeSource: "SHR", candidateScope: "scope-only",
      candidatesSql:
        "SELECT i.ori AS ori, i.agency AS city, i.state AS state" +
        (needsPopulation ? ", i.population AS population" : "") + ", COUNT(v.id) AS victims" +
        // A share request's statements must carry the share itself (structural-measure-unit-unmodeled).
        (share ? `, ${firearm} AS firearm_victims, ROUND(100.0 * ${firearm} / COUNT(v.id), 1) AS firearm_share_pct` : "") +
        " FROM incidents i JOIN victims v ON v.incident_id = i.id" +
        ` WHERE ${scopeWhere.join(" AND ")}` +
        ` GROUP BY i.ori, i.agency, i.state${population} ORDER BY i.ori`,
      ranked: () => { throw new Error("city-ranking: an SHR ranking names its confirmed agencies (rankedConfirmed)"); },
      rankedConfirmed, amountColumn: "victims", verifiable: true,
      unresolvedPhrase: "no evidence-backed agency type", splitFields: "name, population or state",
      ...decisionConditions,
    };
  } else if (request.source === "nibrs") {
    // Recognition declines this (Codex GC-057 ruling, option B); a hand-built request must not
    // quietly become a city ranking either.
    if (jurisdiction) throw new Error("city-ranking: refusing to build a NIBRS jurisdiction ranking as a city ranking");
    if (request.offense.kind !== "nibrs_codes" && request.offense.kind !== "nibrs_carjacking") return null;
    // Carjacking (GC-063) reads its own derived table, which has the same year/month/ori/offense_count shape and no
    // offense code; every other clause -- the agencies join, city type, population, period, scope, rate -- is shared.
    const carjacking = request.offense.kind === "nibrs_carjacking";
    const offenseTable = carjacking ? "summary_carjacking_monthly" : "summary_city_monthly";
    const codes = request.offense.kind === "nibrs_codes" ? request.offense.codes.map(quote).join(", ") : "";
    /*
     * NIBRS keeps the city name on the identity table, so this join is not optional -- but it is on
     * exactly `agencies`' declared PRIMARY KEY (ori, year), which is what stops it multiplying the
     * measure. See IDENTITY_UNIQUENESS above.
     */
    const where = [
      ...(carjacking ? [] : [`s.ucr_offense_code IN (${codes})`]),
      `s.year = ${period.year}`,
      "a.agency_type = 'City'",
      ...populationPredicates(request.eligibility, "a.population"),
    ];
    // The statement covers exactly the period the answer claims, rather than relying on the source
    // happening to stop there.
    if (period.throughMonth !== null) where.push(`s.month <= ${period.throughMonth}`);
    if (request.scope.kind === "state") where.push(`a.state = ${quote(request.scope.code)}`);
    // A rate needs its denominator to exist; this is arithmetic, not an eligibility choice.
    if (rate) where.push("a.population > 0");
    const having = countHaving(request, "SUM(s.offense_count)");
    columns = rate
      ? ["city", "state", "offenses", "population", "rate_per_100k", "first_month", "last_month"]
      : ["city", "state", "offenses", "first_month", "last_month"];
    sql =
      "SELECT a.city AS city, a.state AS state, SUM(s.offense_count) AS offenses" +
      (rate ? ", a.population AS population, ROUND(SUM(s.offense_count) * 100000.0 / a.population, 2) AS rate_per_100k" : "") +
      ", MIN(s.month) AS first_month, MAX(s.month) AS last_month" +
      ` FROM ${offenseTable} s JOIN agencies a ON a.ori = s.ori AND a.year = s.year` +
      ` WHERE ${where.join(" AND ")}` +
      " GROUP BY a.ori, a.city, a.state" + (rate ? ", a.population" : "") +
      (having.length > 0 ? ` HAVING ${having.join(" AND ")}` : "") +
      ` ORDER BY ${sortColumn} ${direction} LIMIT ${limit}`;
    /*
     * S1 for NIBRS: the same eligibility, over agencies whose type `agencies` does not record. The
     * identity table's declared key (ori, year) means an agency-year cannot carry two types, names or
     * populations here, so no filter can hide a disagreement; a second row for one agency is refused
     * by the shared decision as a broken premise. The ranked statement is unchanged.
     */
    const rankedNibrs = sql;
    const unresolvedWhere = where.map((clause) => (clause === NIBRS_CITY_AUTHORITY.eligibleSql("a") ? NIBRS_CITY_AUTHORITY.unresolvedSql("a") : clause));
    if (unresolvedWhere.join() === where.join()) throw new Error("city-ranking: the NIBRS membership predicate was not found");
    completeness = {
      source: "nibrs", authority: NIBRS_CITY_AUTHORITY, typeSource: "NIBRS", candidateScope: "unresolved-only",
      candidatesSql:
        "SELECT a.ori AS ori, a.city AS city, a.state AS state, a.agency_type AS recorded_type, a.population AS population" +
        ", SUM(s.offense_count) AS offenses" +
        ` FROM ${offenseTable} s JOIN agencies a ON a.ori = s.ori AND a.year = s.year` +
        ` WHERE ${unresolvedWhere.join(" AND ")}` +
        " GROUP BY a.ori, a.city, a.state, a.agency_type, a.population" +
        (having.length > 0 ? ` HAVING ${having.join(" AND ")}` : "") +
        " ORDER BY a.ori",
      ranked: (excluded) => {
        if (excluded.length > 0) throw new Error("city-ranking: a NIBRS agency-year cannot disagree with itself; nothing to exclude");
        return rankedNibrs;
      },
      amountColumn: "offenses", verifiable: false, ...decisionConditions,
    };
  } else if (jurisdiction) {
    /*
     * GC-057: REPORTING JURISDICTIONS, not cities. The Current source's reporting agencies of any
     * type -- no `am.type` filter, which was the unrequested restriction. Identity is carried to the
     * answer, not only the grouping: each row returns its ORI and agency type, and a label that
     * stays distinct when two agencies share a name. A rate orders by the exact ratio, not the
     * rounded display column. Everything else -- eligibility, the rate's population > 0, the limit
     * -- is the city branch's rule unchanged.
     */
    if (request.offense.kind !== "current_offense") return null;
    const where = [
      `am.offense = ${quote(request.offense.value)}`,
      `am.year = ${period.year}`,
    ];
    if (needsPopulation) where.push(...populationPredicates(request.eligibility, "ap.population"));
    if (period.throughMonth !== null) where.push(`am.month <= ${period.throughMonth}`);
    if (request.scope.kind === "state") where.push(`am.state = ${quote(request.scope.code)}`);
    if (rate) where.push("ap.population > 0");
    const having = countHaving(request, "SUM(am.count)");
    columns = rate
      ? ["ori", "jurisdiction", "state", "agency_type", "jurisdiction_label", "offenses", "population", "rate_per_100k", "first_month", "last_month"]
      : ["ori", "jurisdiction", "state", "agency_type", "jurisdiction_label", "offenses", "first_month", "last_month"];
    const exactOrder = rate ? "SUM(am.count) * 1.0 / ap.population" : "offenses";
    sql =
      "SELECT am.ori AS ori, am.agency AS jurisdiction, am.state AS state, am.type AS agency_type" +
      ", am.agency || ', ' || am.state || ' (' || am.ori || ')' AS jurisdiction_label" +
      ", SUM(am.count) AS offenses" +
      (rate ? ", ap.population AS population, ROUND(SUM(am.count) * 100000.0 / ap.population, 2) AS rate_per_100k" : "") +
      ", MIN(am.month) AS first_month, MAX(am.month) AS last_month" +
      " FROM agency_monthly am" +
      (needsPopulation ? " JOIN agency_population ap ON ap.ori = am.ori AND ap.year = am.year" : "") +
      ` WHERE ${where.join(" AND ")}` +
      " GROUP BY am.ori, am.agency, am.state, am.type" + (rate ? ", ap.population" : "") +
      (having.length > 0 ? ` HAVING ${having.join(" AND ")}` : "") +
      ` ORDER BY ${exactOrder} ${direction}, am.ori LIMIT ${limit}`;
  } else {
    if (request.offense.kind !== "current_offense") return null;
    const scope = [
      `am.offense = ${quote(request.offense.value)}`,
      `am.year = ${period.year}`,
    ];
    if (period.throughMonth !== null) scope.push(`am.month <= ${period.throughMonth}`);
    if (request.scope.kind === "state") scope.push(`am.state = ${quote(request.scope.code)}`);
    const having = countHaving(request, "SUM(am.count)");
    columns = rate
      ? ["city", "state", "offenses", "population", "rate_per_100k", "first_month", "last_month"]
      : ["city", "state", "offenses", "first_month", "last_month"];
    // The clause order is the branch's long-standing one, so an answer with nothing to exclude is the
    // same statement it always was.
    const ranked = (excluded: string[]) => {
      const where = [scope[0], scope[1], CURRENT_CITY_AUTHORITY.eligibleSql("am")];
      if (needsPopulation) where.push(...populationPredicates(request.eligibility, "ap.population"));
      where.push(...scope.slice(2));
      if (rate) where.push("ap.population > 0");
      where.push(...notIn("am.ori", excluded));
      return "SELECT am.agency AS city, am.state AS state, SUM(am.count) AS offenses" +
        (rate ? ", ap.population AS population, ROUND(SUM(am.count) * 100000.0 / ap.population, 2) AS rate_per_100k" : "") +
        ", MIN(am.month) AS first_month, MAX(am.month) AS last_month" +
        " FROM agency_monthly am" +
        (needsPopulation ? " JOIN agency_population ap ON ap.ori = am.ori AND ap.year = am.year" : "") +
        ` WHERE ${where.join(" AND ")}` +
        " GROUP BY am.ori, am.agency, am.state" + (rate ? ", ap.population" : "") +
        (having.length > 0 ? ` HAVING ${having.join(" AND ")}` : "") +
        ` ORDER BY ${sortColumn} ${direction} LIMIT ${limit}`;
    };
    sql = ranked([]);
    /*
     * S1 for Current: `agency_monthly` carries the type and name on every MONTH row, so one agency can
     * be recorded as City in some months and as nothing (or another type) in others -- and the ranked
     * statement's type filter would silently drop the other months. The candidates statement therefore
     * reads the scope only, grouped by name, state and recorded type; population comes from
     * `agency_population`, whose declared key (ori, year) gives one value per agency-year.
     */
    completeness = {
      source: "current", authority: CURRENT_CITY_AUTHORITY, typeSource: "the Current source", candidateScope: "scope-only",
      candidatesSql:
        "SELECT am.ori AS ori, am.agency AS city, am.state AS state, am.type AS recorded_type" +
        (needsPopulation ? ", ap.population AS population" : "") + ", SUM(am.count) AS offenses" +
        " FROM agency_monthly am" +
        (needsPopulation ? " LEFT JOIN agency_population ap ON ap.ori = am.ori AND ap.year = am.year" : "") +
        ` WHERE ${scope.join(" AND ")}` +
        " GROUP BY am.ori, am.agency, am.state, am.type" + (needsPopulation ? ", ap.population" : "") +
        " ORDER BY am.ori",
      ranked, amountColumn: "offenses", verifiable: false, ...decisionConditions,
    };
  }

  const scopeLabel = request.scope.kind === "state" ? ` in ${request.scope.name}` : "";
  const shr = request.source === "shr";
  const measureLabel = shr
    ? (rate ? "Victim Rate per 100,000" : share ? "Victims: Firearm Share (%)" : "Victim Count")
    : (rate ? "Rate per 100,000" : "Count");
  const order = request.sort.direction === "asc" ? "Lowest" : "Highest";
  // SHR rows are reporting agencies, some without a recorded type, so the limits describe agencies.
  const entities = jurisdiction ? "reporting jurisdictions" : shr ? "agencies" : "cities";
  const entity = jurisdiction ? "jurisdiction" : shr ? "agency" : "city";
  const title = `${jurisdiction ? "Reporting jurisdictions" : "Cities"} by ${request.offenseLabel} ${measureLabel}${scopeLabel}, ${periodPhrase(period)}`;

  const caveats = [...request.caveats];
  if (jurisdiction) {
    caveats.push(
      // Wording note: naming agency types here ("police department") trips the route's ungrounded-
      // descriptor cleanup, so the sentence points at the returned agency_type column instead.
      "These are the reporting jurisdictions in the Current source's sample: each row is one reporting " +
      "agency of whatever type (the agency_type column shows it), identified by its ORI, not a complete " +
      "city total and not every jurisdiction in the country. Agencies with the same name are listed separately."
    );
  }
  if (shr) {
    caveats.push(
      "These are homicide victim records reported to the FBI's Supplementary Homicide Reports: one incident " +
      "can have several victims, so this counts victims, not incidents.",
      "SHR records no agency type. An agency is ranked as a city only by the NIBRS database's classification of the " +
      `one NIBRS agency its identifier matches in its state, from NIBRS years up to ${period.year}: every year with a type ` +
      "must say City, years with no type are not counted, and when the latest typed year is earlier, that City is carried " +
      "forward. Where the FBI's NIBRS file gives no type, this project's NIBRS pipeline derives one from the agency's " +
      "population group (groups 1 to 7 City, 8 and 9 County). Agencies classified otherwise are not included, and an agency " +
      "without that evidence is not counted as a city.",
      ...(share ? ["The firearm share is the agency's firearm victims divided by all its victims of that offense; " +
        "victims whose weapon was not recorded as a firearm are in the total, not the firearm count."] : []),
      ...(rate ? ["Each rate uses the population SHR records for that agency. Agencies that submitted no SHR " +
        "records are not in this ranking, and an agency that reported only part of the period has a lower count."] : []),
      ...(populationConditions.length > 0 ? ["An agency with no population recorded in SHR cannot be placed against " +
        "the population limit, so it is not ranked."] : []),
      `SHR here does not show which months each agency reported: ${coverageOf("shr.incidents").absentMeaning}, ` +
      "so this ranking does not certify complete reporting.",
    );
  }
  if (period.throughMonth !== null) {
    caveats.push(
      `${period.year} runs through ${MONTHS[period.throughMonth - 1]} in this source, so this covers ` +
      "part of the year, not all of it."
    );
  }
  /*
   * DATASET FRESHNESS IS NOT RETURNED COVERAGE. Knowing the source stops at July says nothing about
   * whether a particular city reported every month up to July, and cities that reported different
   * months are not comparable on a count. So the statement returns each city's own first and last
   * reporting month, and the sentence below says exactly what those two numbers establish -- the
   * ends of each city's span -- and no more.
   *
   * An exact per-city month COUNT would be better evidence and is NOT returned: the product's
   * structural rule `structural-row-count-not-a-measure` refuses a `COUNT(DISTINCT month)` column
   * in a gated statement, because it cannot tell a declared evidence column from a row count posing
   * as the measure. Boundary months are what this family can return without changing that rule.
   */
  if (!shr) caveats.push(
    "`first_month` and `last_month` are the earliest and latest month each " + entity + " has records for " +
    `here. ${entities[0].toUpperCase()}${entities.slice(1)} with different spans are not comparable on a count, and these two numbers do not ` +
    "rule out missing months in between."
  );
  for (const condition of request.eligibility) {
    if (condition.kind === "population") {
      caveats.push(
        `Limited to ${entities} with a population ${POPULATION_PHRASE[condition.comparison]} ` +
        `${condition.value.toLocaleString("en-US")}, as requested.`
      );
    } else {
      caveats.push(
        `Limited to ${entities} with ${condition.comparison === ">" ? "more than" : "at least"} ` +
        `${condition.value.toLocaleString("en-US")} recorded ${condition.offenseLabel.toLowerCase()} offenses, as requested.`
      );
    }
  }
  caveats.push(`Ranking result limit: ${limit} rows.`);

  return {
    sql,
    title: `${order} first: ${title}`.replace(/^Highest first: /, ""),
    sortColumn,
    columns,
    caveats,
    guardrail: `deterministic-city-ranking-${request.source}`,
    period,
    entityColumn: jurisdiction ? "jurisdiction_label" : "city",
    entityLabel: jurisdiction ? "Reporting jurisdiction" : "City",
    ...(completeness ? { completeness } : {}),
  };
}

const POPULATION_PHRASE: Record<string, string> = {
  ">=": "of at least",
  ">": "above",
  "<=": "of at most",
  "<": "below",
};
