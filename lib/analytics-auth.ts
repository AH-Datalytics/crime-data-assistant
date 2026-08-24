/**
 * Authorization for the private operator analytics endpoint, as a pure function.
 *
 * WHY IT LIVES HERE rather than inline in the route: the acceptance evidence for this increment has to
 * *exercise* the decision, not assert on the route's source text. A route module drags in `next/server`
 * and path-aliased imports; this file is plain TypeScript, so a test can call it directly with every
 * rejection case. The route imports it and remains the only caller, so the route still owns its
 * fail-closed behaviour.
 *
 * WHAT EACH RULE IS FOR.
 *
 *   `credential_in_url` -- a credential in a URL is retained by server logs, proxy logs, browser history
 *   and `Referer` headers. Refused OUTRIGHT, including when it carries the correct key, because
 *   accepting it would keep teaching callers to leak it. Checked FIRST, before configuration and before
 *   the credential, so no ordering can let a correct-but-leaked key through.
 *
 *   `not_configured` -- absent or empty `ANALYTICS_PASSWORD` means there is no way in. Fail closed. The
 *   endpoint previously accepted a repository-tracked literal and an unrelated key (`QUERY_LOG_KEY`), so
 *   "no dedicated key configured" used to still be reachable.
 *
 *   Bearer only -- one credential channel, so there is nothing to get wrong at the call site.
 *
 * The caller maps EVERY failure to an identical 401. These reason codes exist for tests and server-side
 * logging; leaking them to a client would disclose whether the server is unconfigured.
 */

import { timingSafeEqual } from "node:crypto";

export type AnalyticsAuthFailure =
  | "not_configured"
  | "credential_in_url"
  | "missing_header"
  | "malformed_header"
  | "invalid_credential";

export type AnalyticsAuthResult = { ok: true } | { ok: false; reason: AnalyticsAuthFailure };

/** Query-string names that used to carry a credential. Refused wherever they appear. */
export const URL_CREDENTIAL_PARAMS = ["pw", "password", "key"] as const;

/**
 * Constant-time compare.
 *
 * `timingSafeEqual` throws on length mismatch, so unequal lengths are handled explicitly — and a
 * comparison is still performed in that branch so the work is not trivially length-dependent.
 */
function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function authorizeAnalytics(input: {
  authorization: string | null;
  hasUrlCredential: boolean;
  analyticsPassword: string | undefined;
}): AnalyticsAuthResult {
  if (input.hasUrlCredential) return { ok: false, reason: "credential_in_url" };

  const configured = input.analyticsPassword;
  if (!configured || configured.length === 0) return { ok: false, reason: "not_configured" };

  const header = input.authorization;
  if (!header) return { ok: false, reason: "missing_header" };

  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return { ok: false, reason: "malformed_header" };

  return secretEquals(match[1], configured)
    ? { ok: true }
    : { ok: false, reason: "invalid_credential" };
}
