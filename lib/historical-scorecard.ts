import type Database from "better-sqlite3";
import { resolveGeoPlaces } from "./geo-place-resolver";
import { detectAgencyScorecardQuestion } from "./scorecard-format";
import {
  buildAgencyScorecard, unavailableScorecard, STALE_SCORECARD_YEARS, SCORECARD_COLUMNS,
  type AgencyScorecardResult, type AgencyScorecardRow,
} from "./agency-scorecard";

/**
 * Shared Historical scorecard entry point. Dispatches a scorecard question to the
 * agency, state, or national builder; the route calls this instead of the agency
 * builder directly.
 *
 * State and national cards come from `historical_state_national` -- the FBI's own
 * published aggregates -- and NEVER from summing `historical_agency_crime` rows. Agency
 * coverage varies by year (Florida's UCR participation collapsed in 2021, for example),
 * so a sum over agencies undercounts by whatever failed to report that year and the
 * undercount changes year to year. The FBI's estimates account for non-reporting
 * agencies; a hand-rolled sum does not.
 */
export function buildHistoricalScorecard(db: Database.Database, question: string): AgencyScorecardResult | null {
  if (!detectAgencyScorecardQuestion(question)) return null;

  const resolution = resolveGeoPlaces(question);
  const allCandidates = resolution.mentions.flatMap((mention) => mention.candidates);
  const cityCandidates = allCandidates.filter((candidate) => candidate.kind === "city" && candidate.state);
  const stateCandidates = allCandidates.filter((candidate) => candidate.kind === "state" && candidate.state);

  // Ambiguous between a city and a state ("Washington", bare "New York"): ask which
  // scope rather than returning the city-only message, which reads as a non-sequitur
  // when one of the readings is a perfectly valid state request.
  if (resolution.mentions.some((mention) => mention.requiresClarification)) {
    if (cityCandidates.length > 0 && stateCandidates.length > 0) {
      const name = resolution.mentions.find((mention) => mention.requiresClarification)?.text ?? "that place";
      return unavailableScorecard(
        "Scorecard Needs Clarification",
        `"${name}" could mean a city or a state. Ask for the city (for example "${name} City scorecard" with its state) or the state (for example "${name} State scorecard").`
      );
    }
    // City-only ambiguity (Portland OR vs ME) keeps the agency builder's own handling.
    return buildAgencyScorecard(db, question);
  }

  // A city mention wins over an incidental state mention ("Toledo, Ohio scorecard"
  // resolves as the city). The agency builder re-resolves internally; delegating the
  // whole question keeps its consolidation and reliability behavior byte-identical.
  if (cityCandidates.length > 0) return buildAgencyScorecard(db, question);

  if (stateCandidates.length === 1) {
    return buildStateScorecard(db, stateCandidates[0].name);
  }
  if (stateCandidates.length > 1) {
    return unavailableScorecard(
      "Scorecard Needs Clarification",
      "I can build a scorecard for one state at a time. Please name a single state, city, or ask for the national scorecard."
    );
  }

  // No geographic mention at all: national phrasing, then a bare state abbreviation.
  if (detectNationalScorecardQuestion(question)) return buildNationalScorecard(db);
  const bareState = bareStateAbbreviation(question);
  if (bareState) return buildStateScorecard(db, bareState);

  return unavailableScorecard(
    "Scorecard Needs Clarification",
    "I need a place for a scorecard: a city and state, a state, or \"national\" for the United States."
  );
}

/**
 * National phrasing. "US" is matched case-sensitively on purpose: the pronoun "us" is
 * common in questions ("give us a Toledo scorecard") and this function is only reached
 * when no city or state resolved, so an uppercase US/USA/U.S. is the remaining signal.
 */
export function detectNationalScorecardQuestion(question: string): boolean {
  if (/\b(?:national|nationwide|united states)\b/i.test(question)) return true;
  if (/\bUSA?\b/.test(question)) return true;
  return /\bU\.S\.(?:A\.?)?/i.test(question);
}

const STATE_CODE_TO_NAME: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

/**
 * Bare uppercase state code ("OH scorecard") when nothing else resolved. Uppercase-only
 * on purpose -- "oh", "in", "me", "or", "hi" are ordinary words. Codes that double as
 * city aliases in the geo catalog (LA, NY) never reach this function, because the
 * resolver already produced candidates for them.
 */
function bareStateAbbreviation(question: string): string | null {
  const matches = question.match(/\b[A-Z]{2}\b/g) ?? [];
  const codes = [...new Set(matches.filter((code) => code in STATE_CODE_TO_NAME))];
  return codes.length === 1 ? STATE_CODE_TO_NAME[codes[0]] : null;
}

/**
 * Offense rows for aggregate (state/national) cards, mapped to the columns of
 * `historical_state_national`. Labels match the agency card exactly so the two card
 * kinds read as one product; "Motor Vehicle Theft" is this table's `auto_theft`.
 */
const AGGREGATE_COMPONENTS = [
  { label: "Murder", count: "murder", rate: "murder_rate", group: "violent" },
  { label: "Rape", count: "rape", rate: "rape_rate", group: "violent" },
  { label: "Robbery", count: "robbery", rate: "robbery_rate", group: "violent" },
  { label: "Aggravated Assault", count: "aggravated_assault", rate: "aggravated_assault_rate", group: "violent" },
  { label: "Burglary", count: "burglary", rate: "burglary_rate", group: "property" },
  { label: "Theft", count: "theft", rate: "theft_rate", group: "property" },
  { label: "Motor Vehicle Theft", count: "auto_theft", rate: "auto_theft_rate", group: "property" },
] as const;

const AGGREGATE_SELECT_COLUMNS = AGGREGATE_COMPONENTS.flatMap((c) => [c.count, c.rate]).join(", ");

function aggregateRowSql(stateName: string, year: number | null): string {
  const yearClause = year == null ? "" : ` AND year = ${year}`;
  return `SELECT year, population, ${AGGREGATE_SELECT_COLUMNS} FROM historical_state_national WHERE state = '${stateName.replace(/'/g, "''")}'${yearClause} ORDER BY year DESC LIMIT 1`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Sum a group's stored values; null if ANY component is missing, never a partial sum. */
function groupTotal(row: Record<string, number | null>, group: "violent" | "property", field: "count" | "rate"): number | null {
  let total = 0;
  for (const component of AGGREGATE_COMPONENTS) {
    if (component.group !== group) continue;
    const value = row[field === "count" ? component.count : component.rate];
    if (value == null) return null;
    total += value;
  }
  return total;
}

function changePct(current: number | null, previous: number | null): number | null {
  // NULL or non-positive prior is UNKNOWN, not zero: "no change" and "cannot know"
  // are different claims, and a fake 0.0% is the worse of the two errors.
  if (current == null || previous == null || previous <= 0) return null;
  return round1((current - previous) * 100 / previous);
}

function buildAggregateScorecard(
  db: Database.Database,
  stateName: string,
  scope: "state" | "national"
): AgencyScorecardResult {
  const completenessWhere = AGGREGATE_COMPONENTS
    .flatMap((c) => [`${c.count} IS NOT NULL`, `${c.rate} IS NOT NULL`])
    .join(" AND ");
  const latest = db.prepare(`
    SELECT MAX(year) AS year FROM historical_state_national
    WHERE state = ? AND population > 0 AND ${completenessWhere}
  `).get(stateName) as { year: number | null };

  if (latest.year == null) {
    return unavailableScorecard(
      `${stateName} Scorecard`,
      `${stateName} has no year in the FBI state-level series with a valid population and complete offense counts and rates.`,
      stateName, scope
    );
  }

  // Same honesty rule as agency cards: a card that looks current must be current.
  // The reference point is this TABLE's own max year (2024 today), not the agency
  // file's -- state estimates publish on a different cycle than agency submissions.
  const tableMax = (db.prepare("SELECT MAX(year) AS year FROM historical_state_national").get() as { year: number | null }).year;
  if (tableMax != null && latest.year < tableMax - STALE_SCORECARD_YEARS) {
    return unavailableScorecard(
      `${stateName} Scorecard`,
      `${stateName} has no recent year of complete FBI state-level data. Its most recent complete year is ${latest.year}, which is too far behind ${tableMax} to present as a current scorecard.`,
      stateName, scope
    );
  }

  const year = latest.year;
  const sql = aggregateRowSql(stateName, year);
  const data = db.prepare(sql).get() as Record<string, number | null>;
  const previous = db.prepare(aggregateRowSql(stateName, year - 1)).get() as Record<string, number | null> | undefined;

  const rows: AgencyScorecardRow[] = [];
  const pushRow = (label: string, count: number | null, rate: number | null, previousCount: number | null, section?: boolean) => {
    rows.push({
      offense: label,
      offenses: count,
      rate_per_100k: rate == null ? null : round1(rate),
      // The FBI publishes no state-level clearance data in this series. National
      // clearance exists elsewhere but is omitted too, so every aggregate card has one
      // consistent, comparable layout; agency cards keep clearance.
      clearance_rate: null,
      offense_change_pct: changePct(count, previousCount),
      ...(section ? { section: true } : {}),
    });
  };

  pushRow("Violent Crime", groupTotal(data, "violent", "count"), groupTotal(data, "violent", "rate"),
    previous ? groupTotal(previous, "violent", "count") : null, true);
  for (const c of AGGREGATE_COMPONENTS.filter((x) => x.group === "violent")) {
    pushRow(c.label, data[c.count], data[c.rate], previous?.[c.count] ?? null);
  }
  pushRow("Property Crime", groupTotal(data, "property", "count"), groupTotal(data, "property", "rate"),
    previous ? groupTotal(previous, "property", "count") : null, true);
  for (const c of AGGREGATE_COMPONENTS.filter((x) => x.group === "property")) {
    pushRow(c.label, data[c.count], data[c.rate], previous?.[c.count] ?? null);
  }

  const scopeNoun = scope === "national" ? "national" : "state-level";
  return {
    title: `${stateName} Scorecard (${year})`,
    explanation: `${stateName} crime scorecard from official FBI ${scopeNoun} estimates for ${year}, the latest FBI reporting year. Clearance rates are not shown: the FBI does not publish state-level clearance data in this series, so aggregate scorecards omit the column entirely rather than implying it is merely missing.`,
    // clearance_rate is dropped from the column contract, not just the rendered card:
    // these columns feed the CSV export, and a permanently blank clearance column in a
    // download implies the data exists and is merely missing.
    columns: SCORECARD_COLUMNS.filter((column) => column !== "clearance_rate"),
    rows,
    year,
    sql,
    agencyLabel: stateName,
    scope,
    yearStatus: "latest",
    statusText: `${year} · Latest FBI reporting year`,
    newerExcludedYear: null,
    showClearance: false,
  };
}

export function buildStateScorecard(db: Database.Database, stateName: string): AgencyScorecardResult {
  return buildAggregateScorecard(db, stateName, "state");
}

export function buildNationalScorecard(db: Database.Database): AgencyScorecardResult {
  // The FBI's own national estimate row -- never a sum over states or agencies.
  return buildAggregateScorecard(db, "United States", "national");
}
