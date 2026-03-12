const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "CREATE",
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "REPLACE",
  "VACUUM",
  "REINDEX",
  "LOAD_EXTENSION",
];

function stripStringLiterals(sql: string): string {
  return sql.replace(/'[^']*'/g, "''");
}

export function validateAndSanitize(sql: string): {
  valid: boolean;
  sanitized?: string;
  error?: string;
} {
  if (!sql || !sql.trim()) {
    return { valid: false, error: "Empty SQL" };
  }

  const trimmed = sql.trim();

  // Must start with SELECT or WITH
  const firstWord = trimmed.split(/\s+/)[0].toUpperCase();
  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    return { valid: false, error: "Only SELECT queries are allowed" };
  }

  // No semicolons (prevent multi-statement)
  const withoutStrings = stripStringLiterals(trimmed);
  if (withoutStrings.includes(";")) {
    return { valid: false, error: "Multiple statements are not allowed" };
  }

  // Check forbidden keywords (word-boundary, outside string literals)
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(withoutStrings)) {
      return { valid: false, error: `Forbidden keyword: ${kw}` };
    }
  }

  // Check for dangerous functions
  const dangerousFuncs = /\b(writefile|readfile|edit|load_extension)\s*\(/i;
  if (dangerousFuncs.test(withoutStrings)) {
    return { valid: false, error: "Dangerous function detected" };
  }

  // Enforce LIMIT
  let sanitized = trimmed;
  const limitMatch = sanitized.match(/\bLIMIT\s+(\d+)/i);
  if (limitMatch) {
    const limitVal = parseInt(limitMatch[1], 10);
    if (limitVal > 1000) {
      sanitized = sanitized.replace(
        /\bLIMIT\s+\d+/i,
        "LIMIT 1000"
      );
    }
  } else {
    sanitized = sanitized.replace(/;?\s*$/, "") + " LIMIT 1000";
  }

  return { valid: true, sanitized };
}
