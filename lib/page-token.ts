import { createHmac } from "crypto";

const SECRET = process.env.AUTH_PASSWORD || "nibrs-page-token-secret";
const MAX_AGE_MS = 3600_000; // 1 hour

/**
 * Generate a page-load token: base64(timestamp:hmac)
 * Embedded in the page HTML, sent with every API call.
 * Bots that hit the API directly without rendering the page won't have it.
 */
export function generatePageToken(): string {
  const ts = Date.now().toString();
  const sig = createHmac("sha256", SECRET).update(ts).digest("hex").slice(0, 16);
  return Buffer.from(`${ts}:${sig}`).toString("base64");
}

/**
 * Validate a page-load token.
 * Returns true if: token is well-formed, signature matches, and not expired.
 */
export function validatePageToken(token: string | null | undefined): boolean {
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, "base64").toString();
    const [ts, sig] = decoded.split(":");
    if (!ts || !sig) return false;

    // Check signature
    const expected = createHmac("sha256", SECRET).update(ts).digest("hex").slice(0, 16);
    if (sig !== expected) return false;

    // Check age — must be between 1 second and MAX_AGE old
    const age = Date.now() - parseInt(ts);
    if (age < 1000 || age > MAX_AGE_MS) return false;

    return true;
  } catch {
    return false;
  }
}
