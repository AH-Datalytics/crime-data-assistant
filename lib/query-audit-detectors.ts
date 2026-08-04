export interface QueryAuditRow {
  id?: number;
  query_log_id?: number;
  ts?: number;
  question?: string | null;
  sql?: string | null;
  response?: string | null;
  rows?: number | string | null;
  guardrails?: string | null;
  query_contract?: string | null;
  tab?: string | null;
  /** Loaded by the runner from source columns; never hard-coded by a detector. */
  canonicalValues?: string[];
}

export interface QueryAuditFinding {
  detectorId: string;
  category: string;
  severity: "low" | "medium" | "high";
  finding: string;
  proposedFix: string;
}

export interface QueryAuditDetector {
  id: string;
  category: string;
  severity: QueryAuditFinding["severity"];
  proposedFix: string;
  detect: (row: QueryAuditRow) => QueryAuditFinding | null;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const sqlText = (row: QueryAuditRow) => text(row.sql).toLowerCase();
const answerText = (row: QueryAuditRow) => text(row.response);
const questionText = (row: QueryAuditRow) => text(row.question);
const finding = (d: QueryAuditDetector, row: QueryAuditRow, message: string): QueryAuditFinding => ({
  detectorId: d.id,
  category: d.category,
  severity: d.severity,
  finding: message,
  proposedFix: d.proposedFix,
});

const qualifiers: Array<{ name: string; question: RegExp; evidence: RegExp }> = [
  { name: "police involvement", question: /\bpolice\b|officer[- ]involved|law enforcement/i, evidence: /circumstance|felon killed by police|officer[- ]involved|law enforcement/i },
  { name: "domestic/intimate partner", question: /domestic|intimate partner|spouse|girlfriend|boyfriend/i, evidence: /relationship|domestic|intimate|wife|husband|girlfriend|boyfriend/i },
  { name: "gang", question: /\bgangs?\b/i, evidence: /gang/i },
  { name: "juvenile", question: /juvenile|minor|under[- ]age/i, evidence: /juvenile|minor|age\s*(<|<=|between)/i },
  { name: "stranger", question: /strangers?/i, evidence: /stranger/i },
  { name: "self-defense", question: /self[- ]defen[cs]e/i, evidence: /self[- ]defen[cs]e/i },
  { name: "mass shooting", question: /mass shootings?/i, evidence: /mass|victims?\s*(>=|>|between)/i },
  { name: "drug involvement", question: /drug[- ]related|drug involvement/i, evidence: /drug|narcotic/i },
  { name: "attempted", question: /attempted/i, evidence: /attempted|attempt/i },
  { name: "cleared", question: /cleared|clearance/i, evidence: /clearance|cleared/i },
];

const D1: QueryAuditDetector = {
  id: "D1", category: "qualifier-drop", severity: "high",
  proposedFix: "Carry salient user qualifiers into the deterministic query contract and validate them against the final SQL.",
  detect(row) {
    const q = questionText(row); const combined = `${sqlText(row)} ${answerText(row)}`;
    const dropped = qualifiers.find((item) => item.question.test(q) && !item.evidence.test(combined));
    return dropped ? finding(this, row, `Question qualifier '${dropped.name}' is absent from both the SQL and the delivered explanation.`) : null;
  },
};

const D2: QueryAuditDetector = {
  id: "D2", category: "place-mismatch", severity: "high",
  proposedFix: "Build the narrative geography from the resolved query context and compare it with the final SQL scope.",
  detect(row) {
    const response = answerText(row);
    const placeholder = /(?:cities? in (?:the )?dataset(?: city)?|the dataset city|that city)/i.test(response);
    const specificAgency = /\b(?:ori|agency)\s*=\s*['\"][^'\"]+['\"]|\b(?:ori|agency)\s+IN\s*\(/i.test(text(row.sql));
    return placeholder && specificAgency ? finding(this, row, "Narrative uses a generic dataset-city placeholder while SQL targets a specific agency.") : null;
  },
};

const D3: QueryAuditDetector = {
  id: "D3", category: "grain-mismatch", severity: "medium",
  proposedFix: "Derive the claimed time grain from the final SQL and render only a matching narrative.",
  detect(row) {
    const sql = sqlText(row); const response = answerText(row).toLowerCase();
    const claimsRolling = /rolling|moving average|trailing\s+(?:\d+[- ]month|year)/i.test(response);
    const claimsMonthly = /monthly|per month|each month|by month/i.test(response);
    const claimsAnnual = /annual|yearly|per year|each year|by year/i.test(response);
    const hasWindow = /rows\s+between\s+\d+\s+preceding/i.test(sql);
    const hasMonthlyShape = /\bmonth\b|data_month/.test(sql) && /group\s+by[\s\S]{0,180}\bmonth\b/i.test(sql);
    const multiOffenseWindow = hasWindow && /national_monthly/.test(sql) && /\boffense\s+in\s*\([^)]{1,120},/i.test(sql) && !/group\s+by[\s\S]{0,180}\bmonth\b/i.test(sql);
    if ((claimsRolling && (!hasWindow || multiOffenseWindow)) || (claimsMonthly && !hasMonthlyShape) || (claimsAnnual && hasMonthlyShape && !claimsRolling)) {
      return finding(this, row, "Narrative time-grain claim does not match the SQL's temporal structure.");
    }
    return null;
  },
};

const D4: QueryAuditDetector = {
  id: "D4", category: "year-range-mismatch", severity: "medium",
  proposedFix: "Derive the displayed year range from returned rows or SQL bounds rather than model-authored prose.",
  detect(row) {
    const responseYears = [...answerText(row).matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
    if (responseYears.length === 0) return null;
    const sql = sqlText(row);
    const lower = [...sql.matchAll(/year\s*(?:>=|>)\s*['"]?((?:19|20)\d{2})/gi)].map((m) => Number(m[1]));
    const upper = [...sql.matchAll(/year\s*(?:<=|<)\s*['"]?((?:19|20)\d{2})/gi)].map((m) => Number(m[1]));
    const min = lower.length ? Math.min(...lower) : null; const max = upper.length ? Math.max(...upper) : null;
    const outside = responseYears.some((year) => (min !== null && year < min) || (max !== null && year > max));
    return outside ? finding(this, row, "Narrative names a year outside the bounds expressed by the SQL.") : null;
  },
};

const D5: QueryAuditDetector = {
  id: "D5", category: "metric-aggregate-mismatch", severity: "high",
  proposedFix: "Require a denominator or ratio expression before describing a result as a rate, share, or percentage.",
  detect(row) {
    const response = answerText(row).toLowerCase(); const sql = sqlText(row);
    const rate = /\brate\b|per\s+100\s*,?\s*000|per\s+capita/i.test(response);
    const share = /\bshare\b|\bpercent(?:age)?\b|%/i.test(response);
    const denominator = /population|\bper\b|\/|100\s*\.0|rate/.test(sql);
    const ratio = /\/|100\s*\*|round\s*\(/.test(sql);
    const monthlyGroup = /group\s+by[\s\S]{0,180}\b(?:month|data_month)\b/i.test(sql);
    const fanoutShape = /join\s+agency_population|from\s+agency_population/.test(sql)
      && /sum\s*\(\s*(?:[a-z_]+\.)?population\s*\)/.test(sql)
      && !monthlyGroup
      && !/max\s*\(\s*case\s+when|select\s+distinct\s+ori|dedup/i.test(sql);
    if ((rate && !denominator) || (share && !ratio) || fanoutShape) return finding(this, row, fanoutShape
      ? "Rate denominator is summed across a non-monthly agency-population join and may fan out per agency-month."
      : "Narrative claims a rate or share that the SQL does not calculate.");
    return null;
  },
};

const D6: QueryAuditDetector = {
  id: "D6", category: "malformed-label", severity: "medium",
  proposedFix: "Carry canonical source labels alongside pivot keys and use them when rendering comparison disclosures.",
  detect(row) {
    const response = answerText(row); const values = row.canonicalValues || [];
    for (const canonical of values) {
      const normalized = canonical.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (!normalized || canonical.replace(/[^a-z0-9 ]/gi, "").toLowerCase() === normalized) continue;
      const candidate = response.split(/[,:;|]/).map((part) => part.trim()).find((part) => part.replace(/[^a-z0-9]/gi, "").toLowerCase() === normalized && part !== canonical);
      if (candidate) return finding(this, row, `Narrative label '${candidate}' is a mangled form of canonical source value '${canonical}'.`);
    }
    return null;
  },
};

const D7: QueryAuditDetector = {
  id: "D7", category: "refusal-on-answerable", severity: "high",
  proposedFix: "Use deterministic capability answers or retry query generation when the stored contract has geography, metric, and period.",
  detect(row) {
    const response = answerText(row); const refusal = /couldn't build a reliable query|could not build a reliable query|unable to (?:build|generate) (?:a )?query|no reliable query/i.test(response);
    const contract = text(row.query_contract).toLowerCase();
    const hasContract = /(?:geograph|place|agency|metric|offense|period|year|time)/.test(contract) || (/\b(?:in|for)\s+[a-z][a-z .'-]+\b/i.test(questionText(row)) && /\b(?:19|20)\d{2}\b/.test(questionText(row)));
    return refusal && hasContract ? finding(this, row, "A refusal was delivered even though the request contains a resolvable geography, metric, and period.") : null;
  },
};

const D8: QueryAuditDetector = {
  id: "D8", category: "unresolved-contract-tag", severity: "high",
  proposedFix: "Finalize contract tags against the SQL that actually produced the delivered result; retain resolved retries with an explicit suffix.",
  detect(row) {
    const tags = text(row.guardrails).split(",").map((tag) => tag.trim()).filter(Boolean);
    const delivered = Number(row.rows) > 0 && !/couldn't build a reliable query|could not build a reliable query/i.test(answerText(row));
    const unresolved = tags.find((tag) => tag.startsWith("contract-") && !tag.endsWith("-resolved-on-retry"));
    return delivered && unresolved ? finding(this, row, `Delivered answer retains unresolved contract tag '${unresolved}'.`) : null;
  },
};

export const QUERY_AUDIT_DETECTORS: QueryAuditDetector[] = [D1, D2, D3, D4, D5, D6, D7, D8];

export function detectQueryAuditFindings(row: QueryAuditRow): QueryAuditFinding[] {
  return QUERY_AUDIT_DETECTORS.flatMap((detector) => {
    const result = detector.detect(row);
    return result ? [result] : [];
  });
}
