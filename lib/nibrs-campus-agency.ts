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

const MONTH_LABEL_CASE = `CASE s.month
  WHEN 1 THEN 'Jan'
  WHEN 2 THEN 'Feb'
  WHEN 3 THEN 'Mar'
  WHEN 4 THEN 'Apr'
  WHEN 5 THEN 'May'
  WHEN 6 THEN 'Jun'
  WHEN 7 THEN 'Jul'
  WHEN 8 THEN 'Aug'
  WHEN 9 THEN 'Sep'
  WHEN 10 THEN 'Oct'
  WHEN 11 THEN 'Nov'
  WHEN 12 THEN 'Dec'
END || ' ' || s.year`;

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

export function knownCampusAgencyResolution(question: string): CampusAgencyResolution | null {
  if (/\b(?:university\s+of\s+california|uc)\s+berke?ley\b/i.test(question)) {
    return {
      oris: ["CA0019700"],
      rows: [{ ori: "CA0019700", city: "UN OF CA: BERKELEY", state: "CA", population: 0 }],
    };
  }
  return null;
}

function normalizeText(value: string): string {
  return value
    .toUpperCase()
    .replace(/\bBERKELY\b/g, "BERKELEY")
    .replace(/\bUNIVEFRSIT(Y|IES)\b/g, "UNIVERSIT$1")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
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

function campusSpecificityPenalty(agencyText: string, questionText: string): number {
  let penalty = 0;
  for (const token of agencyText.split(" ")) {
    if (GENERIC_TOKENS.has(token) || token.length < 5) continue;
    if (/^\d+$/.test(token)) continue;
    if (!questionText.includes(token)) penalty++;
  }
  return penalty;
}

export function chooseCampusAgencyOris(question: string, rows: CampusAgencyRow[]): CampusAgencyResolution | null {
  if (!asksCampusAgency(question)) return null;
  const normalizedQuestion = normalizeText(question);
  const tokens = questionTokens(question);
  if (tokens.length === 0) return null;

  const hintedStates = stateHints(question);
  const byOri = new Map<string, { row: CampusAgencyRow; score: number; penalty: number }>();

  for (const row of rows) {
    const agencyText = normalizeText(row.city || "");
    if (!CAMPUS_NAME_RE.test(agencyText)) continue;
    if (hintedStates.length > 0 && !hintedStates.includes(row.state)) continue;

    const matched = tokens.filter((token) => tokenMatchesAgency(token, agencyText, row.state));
    const score = matched.length;
    const required = Math.min(2, tokens.length);
    if (score < required) continue;

    const penalty = campusSpecificityPenalty(agencyText, normalizedQuestion);
    const current = byOri.get(row.ori);
    if (!current || score > current.score || (score === current.score && penalty < current.penalty)) {
      byOri.set(row.ori, { row, score, penalty });
    }
  }

  if (byOri.size === 0) return null;
  const matches = [...byOri.values()].sort((a, b) =>
    b.score - a.score ||
    a.penalty - b.penalty ||
    a.row.ori.localeCompare(b.row.ori)
  );
  const bestScore = matches[0].score;
  const bestPenalty = matches[0].penalty;
  const bestMatches = matches.filter((match) => match.score === bestScore && match.penalty === bestPenalty);
  return {
    oris: bestMatches.map((match) => match.row.ori),
    rows: bestMatches.map((match) => match.row),
  };
}

export function resolveCampusAgencyOris(db: Database.Database, question: string): CampusAgencyResolution | null {
  const known = knownCampusAgencyResolution(question);
  if (known) return known;

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

function offenseFilterFromSql(sql: string | null | undefined): string {
  if (!sql) return "";
  const equals = sql.match(/\b(?:\w+\.)?ucr_offense_code\s*=\s*'([0-9A-Z]+)'/i);
  if (equals) return ` AND s.ucr_offense_code = '${equals[1].replace(/'/g, "''")}'`;

  const inList = sql.match(/\b(?:\w+\.)?ucr_offense_code\s+IN\s*\(([^)]+)\)/i);
  if (!inList) return "";
  const codes = [...inList[1].matchAll(/'([0-9A-Z]+)'/gi)].map((match) => `'${match[1].replace(/'/g, "''")}'`);
  return codes.length > 0 ? ` AND s.ucr_offense_code IN (${codes.join(", ")})` : "";
}

function offenseCodesFromSql(sql: string | null | undefined): string[] {
  if (!sql) return [];
  const equals = sql.match(/\b(?:\w+\.)?ucr_offense_code\s*=\s*'([0-9A-Z]+)'/i);
  if (equals) return [equals[1].toUpperCase()];

  const inList = sql.match(/\b(?:\w+\.)?ucr_offense_code\s+IN\s*\(([^)]+)\)/i);
  if (!inList) return [];
  return [...inList[1].matchAll(/'([0-9A-Z]+)'/gi)].map((match) => match[1].toUpperCase());
}

function yearFilterFromSql(sql: string | null | undefined): string {
  if (!sql) return "";
  const source = sql.replace(/\s+/g, " ");
  const filters: string[] = [];

  const between = source.match(/\b(?:\w+\.)?year\s+BETWEEN\s+(\d{4})\s+AND\s+(\d{4})/i);
  if (between) filters.push(`s.year BETWEEN ${between[1]} AND ${between[2]}`);

  const gte = source.match(/\b(?:\w+\.)?year\s*>=\s*(\d{4})/i);
  if (gte && !between) filters.push(`s.year >= ${gte[1]}`);

  const lte = source.match(/\b(?:\w+\.)?year\s*<=\s*(\d{4})/i);
  if (lte && !between) filters.push(`s.year <= ${lte[1]}`);

  const eq = source.match(/\b(?:\w+\.)?year\s*=\s*(\d{4})/i);
  if (eq && !between && !gte && !lte) filters.push(`s.year = ${eq[1]}`);

  return filters.length > 0 ? ` AND ${filters.join(" AND ")}` : "";
}

function safeSqlAlias(value: string): string | null {
  const alias = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  if (!alias || /^\d/.test(alias)) return null;
  if (["year", "month", "period", "ori", "agency", "state", "ucr_offense_code", "offense_name"].includes(alias)) return null;
  return alias;
}

export function campusAgencyMetricAliasFromSql(sourceSql: string | null | undefined, question = ""): string {
  const sourceAlias = sourceSql?.match(/\bSUM\s*\(\s*(?:\w+\.)?offense_count\s*\)\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)/i)?.[1];
  const safeSourceAlias = sourceAlias ? safeSqlAlias(sourceAlias) : null;
  if (safeSourceAlias && safeSourceAlias !== "offense_count") return safeSourceAlias;

  const text = normalizeText(question);
  if (/\bVEHICLE\b/.test(text) && /\bBURGLAR/.test(text)) return "vehicle_burglaries";
  if (/\bBURGLAR/.test(text)) return "burglaries";
  if (/\bMOTOR\b/.test(text) && /\bVEHICLE\b/.test(text) && /\bTHEFT\b/.test(text)) return "motor_vehicle_thefts";
  if (/\bROBBER/.test(text)) return "robberies";
  if (/\bASSAULT/.test(text)) return "assaults";
  return "offense_count";
}

export function campusAgencyChartAxesFromSql(sourceSql: string | null | undefined, question: string): { xAxis: string; yAxis: string } | null {
  if (offenseCodesFromSql(sourceSql).length !== 1) return null;
  return {
    xAxis: /\bmonth(?:ly)?\b/i.test(question) ? "period" : "year",
    yAxis: campusAgencyMetricAliasFromSql(sourceSql, question),
  };
}

export function campusAgencyDisplayName(row: CampusAgencyRow): string {
  const normalized = normalizeText(row.city || "");
  if (normalized === "UN OF CA BERKELEY" || normalized === "UNIVERSITY OF CALIFORNIA BERKELEY") {
    return "UC Berkeley";
  }
  return (row.city || "the campus agency")
    .toLowerCase()
    .replace(/\bun\b/g, "University")
    .replace(/\bca\b/g, "California")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function hasLiteralCampusOri(sql: string): boolean {
  return /\b(?:\w+\.)?ori\s*=\s*'[A-Z0-9]{7,9}'/i.test(sql) ||
    /\b(?:\w+\.)?ori\s+IN\s*\((?!\s*SELECT)[^)]*'[A-Z0-9]{7,9}'/i.test(sql);
}

export function shouldResolveCampusAgencySql(question: string, sql: string): boolean {
  if (!asksCampusAgency(question)) return false;
  if (hasLiteralCampusOri(sql)) return false;
  if (!/\bsummary_city_monthly\b/i.test(sql)) return false;
  return /\bagencies\b/i.test(sql) || /\bcity\s+(?:=|LIKE)\s*'/i.test(sql);
}

export function buildCampusAgencySummarySql(oris: string[], question: string, sourceSql?: string | null): string {
  const quotedOris = oris.map((ori) => `'${ori.replace(/'/g, "''")}'`).join(", ");
  const includeMonth = /\bmonth(?:ly)?\b/i.test(question);
  const offenseFilter = offenseFilterFromSql(sourceSql);
  const yearFilter = yearFilterFromSql(sourceSql);
  const offenseCodes = offenseCodesFromSql(sourceSql);

  if (offenseCodes.length === 1) {
    const metricAlias = campusAgencyMetricAliasFromSql(sourceSql, question);
    const periodColumn = includeMonth ? `${MONTH_LABEL_CASE} AS period` : "s.year";
    const periodGroup = includeMonth ? "s.year, s.month" : "s.year";
    const periodOrder = includeMonth ? "s.year, s.month" : "s.year";

    return `SELECT ${periodColumn}, SUM(s.offense_count) AS ${metricAlias}
FROM summary_city_monthly s
WHERE s.ori IN (${quotedOris})
${offenseFilter}
${yearFilter}
GROUP BY ${periodGroup}
ORDER BY ${periodOrder}
LIMIT 1000`;
  }

  const periodColumns = includeMonth ? "s.year, s.month" : "s.year";
  const periodGroup = includeMonth ? "s.year, s.month" : "s.year";
  const periodOrder = includeMonth ? "s.year, s.month" : "s.year";

  return `SELECT ${periodColumns}, s.ucr_offense_code, o.offense_name, SUM(s.offense_count) AS offense_count
FROM summary_city_monthly s
LEFT JOIN nibrs_offense_codes o ON o.code = s.ucr_offense_code
WHERE s.ori IN (${quotedOris})
${offenseFilter}
${yearFilter}
GROUP BY ${periodGroup}, s.ucr_offense_code, o.offense_name
ORDER BY ${periodOrder}, s.ucr_offense_code
LIMIT 1000`;
}
