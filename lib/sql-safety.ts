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
  return sql.replace(/'(?:''|[^'])*'/g, "''");
}

export function validateAndSanitize(sql: string, opts?: { maxLimit?: number }): {
  valid: boolean;
  sanitized?: string;
  error?: string;
} {
  const maxLimit = opts?.maxLimit ?? 1000;
  if (!sql || !sql.trim()) {
    return { valid: false, error: "Empty SQL" };
  }

  const trimmed = sql.trim().replace(/;+\s*$/, "");

  // Must start with SELECT or WITH
  const firstWord = trimmed.split(/\s+/)[0].toUpperCase();
  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    return { valid: false, error: "Only SELECT queries are allowed" };
  }

  // No semicolons (prevent multi-statement). A single trailing semicolon is
  // normalized above because models and deterministic templates sometimes add
  // one even though it is not a second statement.
  const withoutStrings = stripStringLiterals(trimmed);
  if (withoutStrings.includes(";")) {
    return { valid: false, error: "Multiple statements are not allowed" };
  }

  // Check forbidden keywords (word-boundary, outside string literals)
  // Special handling for DROP — only flag if followed by TABLE/INDEX/VIEW/TRIGGER
  // (not when used as a column alias like "as drop" or "drop DESC")
  for (const kw of FORBIDDEN_KEYWORDS) {
    let re: RegExp;
    if (kw === "DROP") {
      re = /\bDROP\s+(TABLE|INDEX|VIEW|TRIGGER)\b/i;
    } else {
      re = new RegExp(`\\b${kw}\\b`, "i");
    }
    if (re.test(withoutStrings)) {
      return { valid: false, error: `Forbidden keyword: ${kw}` };
    }
  }

  // Check for dangerous functions
  const dangerousFuncs = /\b(writefile|readfile|edit|load_extension)\s*\(/i;
  if (dangerousFuncs.test(withoutStrings)) {
    return { valid: false, error: "Dangerous function detected" };
  }

  let sanitized = trimmed;
  const limitMatch = sanitized.match(/\bLIMIT\s+(\d+)/i);
  if (limitMatch) {
    const limitVal = parseInt(limitMatch[1], 10);
    if (limitVal > maxLimit) {
      sanitized = sanitized.replace(
        /\bLIMIT\s+\d+/i,
        `LIMIT ${maxLimit}`
      );
    }
  } else {
    sanitized = sanitized.replace(/;?\s*$/, "") + ` LIMIT ${maxLimit}`;
  }

  return { valid: true, sanitized };
}
