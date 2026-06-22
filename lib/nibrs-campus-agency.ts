import type Database from "better-sqlite3";
import { STATE_NAME_TO_ABBR } from "./state-population";

export interface CampusAgencyRow {
  ori: string;
  city: string;
  state: string;
  population?: number | null;
}

export interface CampusAgencyResolution {
  oris: string[];
  rows: CampusAgencyRow[];
}

const CAMPUS_RE = /\b(?:universit(?:y|ies)|univefrsit(?:y|ies)|college|campus)\b/i;
const CAMPUS_NAME_RE = /\b(?:UN|UNIV|UNIVERSITY|COLLEGE|CAMPUS)\b/i;

const GENERIC_TOKENS = new Set([
  "A", "AN", "AND", "AT", "BACK", "BY", "CAN", "COUNT", "CRIME", "CRIMES",
  "DATA", "FOR", "FROM", "GIVE", "HISTORICAL", "IN", "ME", "MONTH",
  "MONTHLY", "NIBRS", "OF", "PRESENT", "REPORTED", "REPORTS", "SHOW",
  "THE", "TO", "TOTAL", "TREND", "TRENDS", "UNIVERSITIES", "UNIVERSITY",
  "UNIVEFRSITIES", "UNIVEFRSITY", "COLLEGE", "CAMPUS", "WITH", "YEAR",
  "YEARS",
]);

const STATE_TOKEN_TO_ABBR = new Map<string, string>(
  Object.entries(STATE_NAME_TO_ABBR).map(([name, abbr]) => [normalizeText(name), abbr])
);

export function asksCampusAgency(question: string): boolean {
  return CAMPUS_RE.test(question);
}

function normalizeText(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function stateHints(question: string): string[] {
  const normalizedQuestion = ` ${normalizeText(question)} `;
  const states: string[] = [];
  for (const [name, abbr] of Object.entries(STATE_NAME_TO_ABBR)) {
    if (new RegExp(`\\b${normalizeText(name)}\\b`).test(normalizedQuestion)) {
      states.push(abbr);
    }
  }
  return [...new Set(states)];
}

function questionTokens(question: string): string[] {
  return normalizeText(question)
    .split(" ")
    .filter((token) => token.length >= 2 && !GENERIC_TOKENS.has(token) && !/^\d+$/.test(token));
}

function tokenMatchesAgency(token: string, agencyText: string, state: string): boolean {
  if (agencyText.includes(token)) return true;
  const stateAbbr = STATE_TOKEN_TO_ABBR.get(token);
  return Boolean(stateAbbr && (stateAbbr === state || new RegExp(`\\b${stateAbbr}\\b`).test(agencyText)));
}

export function chooseCampusAgencyOris(question: string, rows: CampusAgencyRow[]): CampusAgencyResolution | null {
  if (!asksCampusAgency(question)) return null;
  const tokens = questionTokens(question);
  if (tokens.length === 0) return null;

  const hintedStates = stateHints(question);
  const byOri = new Map<string, { row: CampusAgencyRow; score: number }>();

  for (const row of rows) {
    const agencyText = normalizeText(row.city || "");
    if (!CAMPUS_NAME_RE.test(agencyText)) continue;
    if (hintedStates.length > 0 && !hintedStates.includes(row.state)) continue;

    const matched = tokens.filter((token) => tokenMatchesAgency(token, agencyText, row.state));
    const score = matched.length;
    const required = Math.min(2, tokens.length);
    if (score < required) continue;

    const current = byOri.get(row.ori);
    if (!current || score > current.score) {
      byOri.set(row.ori, { row, score });
    }
  }

  if (byOri.size === 0) return null;
  const matches = [...byOri.values()].sort((a, b) => b.score - a.score || a.row.ori.localeCompare(b.row.ori));
  return {
    oris: matches.map((match) => match.row.ori),
    rows: matches.map((match) => match.row),
  };
}

export function resolveCampusAgencyOris(db: Database.Database, question: string): CampusAgencyResolution | null {
  const hintedStates = stateHints(question);
  const params: string[] = [];
  let stateWhere = "";
  if (hintedStates.length > 0) {
    stateWhere = `AND state IN (${hintedStates.map(() => "?").join(", ")})`;
    params.push(...hintedStates);
  }

  const rows = db.prepare(`
    SELECT DISTINCT ori, city, state, population
    FROM agencies
    WHERE city IS NOT NULL
      ${stateWhere}
      AND (
        upper(city) LIKE '%UN %'
        OR upper(city) LIKE '%UN:%'
        OR upper(city) LIKE '%UNIV%'
        OR upper(city) LIKE '%UNIVERSITY%'
        OR upper(city) LIKE '%COLLEGE%'
        OR upper(city) LIKE '%CAMPUS%'
      )
  `).all(...params) as CampusAgencyRow[];

  return chooseCampusAgencyOris(question, rows);
}

export function buildCampusAgencySummarySql(oris: string[], question: string): string {
  const quotedOris = oris.map((ori) => `'${ori.replace(/'/g, "''")}'`).join(", ");
  const includeMonth = /\bmonth(?:ly)?\b/i.test(question);
  const periodColumns = includeMonth ? "s.year, s.month" : "s.year";
  const periodGroup = includeMonth ? "s.year, s.month" : "s.year";
  const periodOrder = includeMonth ? "s.year, s.month" : "s.year";

  return `SELECT ${periodColumns}, s.ori, a.city AS agency, a.state, s.ucr_offense_code, o.offense_name, SUM(s.offense_count) AS offense_count
FROM summary_city_monthly s
JOIN agencies a ON a.ori = s.ori AND a.year = s.year
LEFT JOIN nibrs_offense_codes o ON o.code = s.ucr_offense_code
WHERE s.ori IN (${quotedOris})
GROUP BY ${periodGroup}, s.ori, a.city, a.state, s.ucr_offense_code, o.offense_name
ORDER BY ${periodOrder}, s.ucr_offense_code
LIMIT 1000`;
}

