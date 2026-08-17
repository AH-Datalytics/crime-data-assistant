import type Database from "better-sqlite3";
import { classifyCurrentTrendsSqlAbsence } from "./current-trends-sql-absence";

/**
 * Why a Current Trends request came back with no value.
 *
 * The empty-result path used to say one thing for five different situations. A place we
 * do not carry, a month nobody has filed yet, a place that filed nothing that month, a
 * place that filed but supplied no figure for the offense asked about, and "we cannot
 * tell" are different answers, and only the first four may be stated as fact.
 *
 * Two rules shape everything below.
 *
 * The first is that a reason is only offered when the database can show it. Before any
 * reading of the query, the build records for every component the query touches must
 * reconcile with the live tables (that check lives in current-trends-sql-absence). Then
 * the place, the period, and the offense are each checked against real rows, separately,
 * in that order -- an empty answer to one question is never evidence for another. In
 * particular a place is only described as having filed nothing once we have confirmed
 * that other places do have rows for that period, and the offense is only blamed once we
 * have confirmed the place has other rows for the same period.
 *
 * The second is about identity, and it is where the first version was wrong three times.
 * The agency directory is not the authority on who is carried -- the importer keeps
 * monthly records whose ORI has no directory entry -- so both are consulted. Every place
 * identifier the query supplies has to agree; an ORI used to win and the name beside it
 * was dropped, which explained one place's silence as though it were another's. And a
 * sentence naming a place has to hold for every record of that place, not for whichever
 * ORI the query happened to name: Pontiac files under a replacement ORI now, and a check
 * scoped to one of its two ORIs reports a month it did file as a month it missed.
 *
 * The third is that the query is read, not parsed. Only one shape is recognised: a
 * single-table read of the monthly table whose WHERE clause is AND-joined equality tests
 * on agency, state, ORI, offense, year and month. Joins, subqueries, ranges, functions,
 * OR, IN, LIKE, HAVING, aliases and any filter not on that list end the reading, and the
 * caller is told we cannot determine the reason. Over-refusing costs a helpful sentence;
 * under-refusing invents a fact about published data.
 */

export type CurrentTrendsEmptyReasonCode =
  | "place_not_covered"
  | "period_not_covered"
  | "no_report_for_period"
  | "offense_not_reported"
  | "cannot_determine";

export type CurrentTrendsEmptyExplanation = {
  reason: CurrentTrendsEmptyReasonCode;
  /** The sentence shown to the reader. Plain English, no internal vocabulary. */
  message: string;
  /** True only for a reason established from rows. False means we are declining. */
  establishedFromData: boolean;
  /** Internal only -- for logs and proofs, never shown. */
  detail: string;
};

const CANNOT_DETERMINE_MESSAGE =
  "I can't determine safely why this request returned no value. Try asking for a single place, month, and offense.";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

function cannotDetermine(detail: string): CurrentTrendsEmptyExplanation {
  return { reason: "cannot_determine", message: CANNOT_DETERMINE_MESSAGE, establishedFromData: false, detail };
}

function stated(
  reason: Exclude<CurrentTrendsEmptyReasonCode, "cannot_determine">,
  message: string,
  detail: string,
): CurrentTrendsEmptyExplanation {
  return { reason, message, establishedFromData: true, detail };
}

/**
 * Replace the contents of every single-quoted literal with spaces, keeping the string the
 * same length so offsets still line up with the original. Structural checks then run over
 * text where no keyword or bracket can be hiding inside a value -- an agency called "Union
 * City" must not read as a UNION. Returns null for an unterminated literal.
 */
function blankLiterals(sql: string): string | null {
  let out = "";
  let inLiteral = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLiteral) {
      if (ch !== "'") { out += " "; continue; }
      if (sql[i + 1] === "'") { out += "  "; i++; continue; }
      inLiteral = false;
      out += "'";
      continue;
    }
    if (ch === "'") { inLiteral = true; out += "'"; continue; }
    out += ch;
  }
  return inLiteral ? null : out;
}

type RecognizedFilters = {
  agency: string | null;
  state: string | null;
  ori: string | null;
  offense: string | null;
  year: number | null;
  month: number | null;
};

const TEXT_FILTER_PATTERNS: ReadonlyArray<[keyof RecognizedFilters, RegExp]> = [
  ["agency", /^(?:agency_monthly\.)?agency\s*=\s*'((?:[^']|'')*)'$/i],
  ["state", /^(?:agency_monthly\.)?state\s*=\s*'((?:[^']|'')*)'$/i],
  ["ori", /^(?:agency_monthly\.)?ori\s*=\s*'((?:[^']|'')*)'$/i],
  ["offense", /^(?:agency_monthly\.)?offense\s*=\s*'((?:[^']|'')*)'$/i],
];
const YEAR_FILTER = /^(?:agency_monthly\.)?year\s*=\s*(\d{4})$/i;
const MONTH_FILTER = /^(?:agency_monthly\.)?month\s*=\s*(\d{1,2})$/i;

/** Anything here means the statement does more than read one table with fixed filters. */
const DISQUALIFYING_KEYWORDS =
  /\b(?:join|union|intersect|except|with|having|exists|case|over|values|insert|update|delete)\b/i;

function recognizeMonthlyLookup(sql: string): RecognizedFilters | null {
  const compact = sql.replace(/\s+/g, " ").trim().replace(/;+$/, "").trim();
  const blanked = blankLiterals(compact);
  if (blanked === null) return null;
  if (blanked.includes(";") || blanked.includes("--") || blanked.includes("/*")) return null;
  if (DISQUALIFYING_KEYWORDS.test(blanked)) return null;
  if ((blanked.match(/\bselect\b/gi) ?? []).length !== 1) return null;
  if ((blanked.match(/\bfrom\b/gi) ?? []).length !== 1) return null;

  // The lookahead rejects a table alias: nothing may sit between the table name and the
  // next clause, so `FROM agency_monthly am WHERE ...` is not recognised.
  const from = /\bfrom\s+([a-z_][a-z0-9_]*)\s*(?=\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\blimit\b|$)/i.exec(blanked);
  if (!from || from[1].toLowerCase() !== "agency_monthly") return null;

  const filters: RecognizedFilters = { agency: null, state: null, ori: null, offense: null, year: null, month: null };

  const whereStart = /\bwhere\b\s*/i.exec(blanked);
  if (!whereStart) return filters;
  const clauseStart = whereStart.index + whereStart[0].length;
  const tail = blanked.slice(clauseStart);
  const clauseEnd = clauseStart + (/\b(?:group\s+by|order\s+by|limit)\b/i.exec(tail)?.index ?? tail.length);
  const blankedWhere = blanked.slice(clauseStart, clauseEnd);
  const originalWhere = compact.slice(clauseStart, clauseEnd);

  if (/[()]/.test(blankedWhere) || /\bor\b/i.test(blankedWhere)) return null;

  const conditions: string[] = [];
  let cursor = 0;
  for (const separator of blankedWhere.matchAll(/\band\b/gi)) {
    conditions.push(originalWhere.slice(cursor, separator.index));
    cursor = separator.index + separator[0].length;
  }
  conditions.push(originalWhere.slice(cursor));

  for (const raw of conditions) {
    const condition = raw.trim();
    if (!condition) return null;

    const year = YEAR_FILTER.exec(condition);
    if (year) {
      const value = Number(year[1]);
      if (filters.year !== null && filters.year !== value) return null;
      filters.year = value;
      continue;
    }

    const month = MONTH_FILTER.exec(condition);
    if (month) {
      const value = Number(month[1]);
      if (value < 1 || value > 12) return null;
      if (filters.month !== null && filters.month !== value) return null;
      filters.month = value;
      continue;
    }

    const text = TEXT_FILTER_PATTERNS.map(([key, pattern]) => [key, pattern.exec(condition)] as const)
      .find(([, match]) => match !== null);
    if (!text || !text[1]) return null;
    const value = text[1][1].replace(/''/g, "'");
    const existing = filters[text[0]];
    if (typeof existing === "string" && existing !== value) return null;
    (filters[text[0]] as string) = value;
  }

  return filters;
}

/** Keep a value from a SQL literal printable and short before it reaches a sentence. */
function safeLabel(value: string, max = 60): string {
  return value.replace(/[^A-Za-z0-9 .,'&/-]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function periodLabel(year: number, month: number | null): string {
  return month === null ? String(year) : `${MONTH_NAMES[month - 1]} ${year}`;
}

type Coverage = { lo: number; hi: number };

function coverageOf(db: Database.Database): Coverage | null {
  const row = db.prepare("SELECT MIN(year * 100 + month) AS lo, MAX(year * 100 + month) AS hi FROM agency_monthly")
    .get() as { lo: number | null; hi: number | null } | undefined;
  if (!row || row.lo === null || row.hi === null) return null;
  return { lo: row.lo, hi: row.hi };
}

function coverageSentence(coverage: Coverage): string {
  const label = (ordinal: number) => periodLabel(Math.floor(ordinal / 100), ordinal % 100);
  return ` Current Trends covers ${label(coverage.lo)} through ${label(coverage.hi)}.`;
}

function periodIsOutsideCoverage(coverage: Coverage, year: number, month: number | null): boolean {
  if (month === null) return year < Math.floor(coverage.lo / 100) || year > Math.floor(coverage.hi / 100);
  const requested = year * 100 + month;
  return requested < coverage.lo || requested > coverage.hi;
}

type PlaceRecord = { ori: string; agency: string; state: string };
type Predicate = { clause: string; params: string[] };

/**
 * Who Current Trends carries, as far as identity goes.
 *
 * The agency directory alone is not the authority. The importer deliberately keeps
 * monthly records whose ORI has no directory entry -- Pontiac files under MI6367300
 * while the directory still lists MI631900X -- so a place present only in the monthly
 * records is carried, and reading the directory alone called it uncarried. Both are
 * consulted, and a name that spans two ORIs yields both of them.
 */
function lookupPlaces(db: Database.Database, predicate: Predicate): PlaceRecord[] {
  // The clause is assembled from fixed strings below; every value is bound.
  return db.prepare(`
    SELECT DISTINCT ori, agency, state FROM (
      SELECT ori, agency, state FROM agencies
      UNION ALL
      SELECT ori, agency, state FROM agency_monthly
    ) WHERE ${predicate.clause}
  `).all(...predicate.params) as PlaceRecord[];
}

/**
 * The query's own place filters, as a predicate, plus the identity claims it makes.
 *
 * `all` is every place filter the query used, and it is what later row counts are scoped
 * by, so those counts see exactly the records the query saw -- including records under a
 * replacement ORI that a canonical lookup would have missed.
 *
 * `units` are the independent claims about which place this is: an ORI, and a name (which
 * only identifies a place together with its state, when the query gave one). They exist to
 * tell two different empty outcomes apart. If no unit matches anything, nothing in Current
 * Trends answers to any identifier the query gave, and we may say the place is not carried.
 * If some unit matches but their conjunction does not, the identifiers contradict each
 * other; which one is wrong is not knowable, so no reason is offered.
 */
function placeFilters(filters: RecognizedFilters): { all: Predicate | null; units: Predicate[] } {
  const supplied: Predicate[] = [];
  if (filters.ori !== null) supplied.push({ clause: "upper(ori) = upper(?)", params: [filters.ori] });
  if (filters.agency !== null) supplied.push({ clause: "upper(agency) = upper(?)", params: [filters.agency] });
  if (filters.state !== null) supplied.push({ clause: "upper(state) = upper(?)", params: [filters.state] });
  if (supplied.length === 0) return { all: null, units: [] };

  const units: Predicate[] = [];
  if (filters.ori !== null) units.push({ clause: "upper(ori) = upper(?)", params: [filters.ori] });
  if (filters.agency !== null) {
    units.push(filters.state === null
      ? { clause: "upper(agency) = upper(?)", params: [filters.agency] }
      : { clause: "upper(agency) = upper(?) AND upper(state) = upper(?)", params: [filters.agency, filters.state] });
  }
  if (units.length === 0 && filters.state !== null) {
    units.push({ clause: "upper(state) = upper(?)", params: [filters.state] });
  }

  return {
    all: {
      clause: supplied.map((part) => `(${part.clause})`).join(" AND "),
      params: supplied.flatMap((part) => part.params),
    },
    units,
  };
}

/** How many monthly records a place has for a period, optionally narrowed to one offense. */
function countRows(
  db: Database.Database,
  place: Predicate,
  year: number,
  month: number | null,
  offense: string | null,
): number {
  const clauses = [`(${place.clause})`, "year = ?"];
  const params: (string | number)[] = [...place.params, year];
  if (month !== null) { clauses.push("month = ?"); params.push(month); }
  if (offense !== null) { clauses.push("upper(offense) = upper(?)"); params.push(offense); }
  const row = db.prepare(`SELECT COUNT(*) AS n FROM agency_monthly WHERE ${clauses.join(" AND ")}`)
    .get(...params) as { n: number };
  return Number(row.n);
}

function requestedPlaceLabel(filters: RecognizedFilters): string {
  if (filters.agency !== null) {
    const agency = safeLabel(filters.agency);
    const state = filters.state === null ? "" : safeLabel(filters.state, 24);
    if (!agency) return "that agency";
    return state ? `${agency}, ${state}` : agency;
  }
  if (filters.ori !== null) return "that agency";
  const state = filters.state === null ? "" : safeLabel(filters.state, 24);
  return state ? `any agency in ${state}` : "that place";
}

/**
 * Explain a Current Trends result that carried no value, either because no rows came back
 * or because every value in them was blank. Never called for a result that carried a
 * figure -- an explicitly reported zero is a value and keeps its own meaning.
 */
export function explainEmptyCurrentTrendsResult(
  db: Database.Database,
  sql: string,
): CurrentTrendsEmptyExplanation {
  const absence = classifyCurrentTrendsSqlAbsence(db, sql, 0);
  if (absence.state !== "not_in_source_snapshot") {
    return cannotDetermine(`build evidence does not support a statement: ${absence.reason}`);
  }

  const filters = recognizeMonthlyLookup(sql);
  if (!filters) return cannotDetermine("the query is not one of the shapes this check can read");

  try {
    const { all: placeWhere, units } = placeFilters(filters);
    let placeIdentity: { agency: string; state: string } | null = null;

    if (placeWhere) {
      const matches = lookupPlaces(db, placeWhere);
      if (matches.length === 0) {
        // Nothing answers to every identifier at once. Whether that is a place we do not
        // carry or a query whose identifiers disagree depends on the identifiers alone.
        const anyUnitMatches = units.some((unit) => lookupPlaces(db, unit).length > 0);
        if (anyUnitMatches) {
          return cannotDetermine("the place filters in the query do not agree with each other");
        }
        const requested = requestedPlaceLabel(filters);
        return stated(
          "place_not_covered",
          `Current Trends does not include ${requested}.`,
          `nothing carried matches ${requested}`,
        );
      }
      // A name that spans two ORIs is still one place to name, so long as every record
      // agrees on what to call it.
      const names = new Set(matches.map((match) => `${match.agency}|${match.state}`));
      if (names.size === 1) placeIdentity = { agency: matches[0].agency, state: matches[0].state };
    }

    if (filters.year === null) return cannotDetermine("the query does not fix a single year");

    const coverage = coverageOf(db);
    if (!coverage) return cannotDetermine("no period is present to compare against");

    // The overall span is checked before any agency's own history, so a month nobody has
    // filed yet is never reported as one place failing to file.
    const periodHeld = filters.month === null
      ? db.prepare("SELECT 1 FROM agency_monthly WHERE year = ? LIMIT 1").get(filters.year)
      : db.prepare("SELECT 1 FROM agency_monthly WHERE year = ? AND month = ? LIMIT 1").get(filters.year, filters.month);
    if (!periodHeld) {
      const label = periodLabel(filters.year, filters.month);
      const span = periodIsOutsideCoverage(coverage, filters.year, filters.month) ? coverageSentence(coverage) : "";
      return stated(
        "period_not_covered",
        `${label} is not available in Current Trends.${span}`,
        `no row anywhere covers ${label}`,
      );
    }

    // Naming one place requires that the query named one: a state on its own is a scope,
    // and a name every record does not agree on cannot be put in a sentence.
    const identifiesOnePlace = filters.ori !== null || filters.agency !== null;
    if (!identifiesOnePlace || placeIdentity === null) {
      return cannotDetermine("the query does not name one place to report on");
    }
    const placeLabel = `${placeIdentity.agency}, ${placeIdentity.state}`;
    const period = periodLabel(filters.year, filters.month);

    // Counted over the whole place, not over the query's filters. A sentence naming
    // Pontiac has to be true of every Pontiac record: a query scoped to the replacement
    // ORI returns nothing for April, but Pontiac did file April under the ORI it replaced,
    // and "Pontiac filed no report for April" would be false. When the place did file what
    // was asked for and the query still came back empty, the query was narrower than the
    // place it named, and no reason is offered.
    const wholePlace: Predicate = {
      clause: "upper(agency) = upper(?) AND upper(state) = upper(?)",
      params: [placeIdentity.agency, placeIdentity.state],
    };
    const periodRows = countRows(db, wholePlace, filters.year, filters.month, null);
    if (periodRows === 0) {
      return stated(
        "no_report_for_period",
        `Current Trends has no report from ${placeLabel} for ${period}. A missing report is not the same as a count of zero.`,
        `no record of ${placeLabel}, under any of its ORIs, has a row for ${period}`,
      );
    }

    // Only now, with other rows for the same place and period confirmed present, can the
    // gap be attributed to the offense that was asked about.
    if (filters.offense === null) return cannotDetermine("the query does not fix a single offense");
    const offenseRows = countRows(db, wholePlace, filters.year, filters.month, filters.offense);
    if (offenseRows === 0) {
      const offense = safeLabel(filters.offense, 40).toLowerCase() || "requested";
      return stated(
        "offense_not_reported",
        `Current Trends has no ${offense} value from ${placeLabel} for ${period}. A missing value is not the same as a count of zero.`,
        `${placeLabel} filed for ${period} but supplied no ${offense} figure`,
      );
    }

    // The rows the query asked for are present, so the empty result has some other cause.
    return cannotDetermine("the requested rows exist, so the empty result is unexplained");
  } catch (error) {
    return cannotDetermine(`the check could not complete: ${(error as Error).message}`);
  }
}
