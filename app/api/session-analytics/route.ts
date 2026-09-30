import { NextRequest, NextResponse } from "next/server";
import { getWriteDb } from "@/lib/rtci-db";
import { authorizeAnalytics, URL_CREDENTIAL_PARAMS } from "@/lib/analytics-auth";

/**
 * PRIVATE OPERATOR ENDPOINT. It returns query-log-derived session detail -- session ids, per-session
 * timing, and the questions people asked -- so it is not public even though the site is.
 *
 * WHAT THIS REPLACED, AND WHY EACH PART WENT.
 *
 *   `?pw=` QUERY PARAMETER. A credential in a URL is retained by server logs, proxy logs, browser
 *   history and `Referer` headers. It is now REFUSED OUTRIGHT -- including when it carries the correct
 *   key -- because accepting it would keep teaching callers to leak it.
 *
 *   A HARDCODED LITERAL. The previous check accepted a password committed to this repository, on a route
 *   that `middleware.ts` always-allows. Anyone who could read the repo could read session analytics.
 *
 *   `QUERY_LOG_KEY`. Accepting a second, unrelated credential widened the blast radius of that key for
 *   no benefit. `/api/query-log` already requires its own key with no fallback; this route now does the
 *   same with its own.
 *
 *   WILDCARD CORS. `Access-Control-Allow-Origin: *` let any origin read the response from a browser.
 *   The only consumer is the same-origin `/analytics` page, so no CORS headers are emitted and the
 *   public preflight is gone.
 *
 * FAIL CLOSED. With `ANALYTICS_PASSWORD` absent or empty there is no way in. The 401 body is identical
 * for every rejection reason, so a caller cannot learn from it whether the server is unconfigured, sent
 * the wrong header shape, or simply guessed wrong.
 *
 * The decision itself lives in `lib/analytics-auth.ts` so the acceptance tests can EXERCISE every
 * rejection case directly instead of asserting on this file's source text. This route is its only
 * caller and still owns the fail-closed behaviour.
 */

/** Every rejection looks the same from outside. The reason stays server-side. */
function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const auth = authorizeAnalytics({
    authorization: req.headers.get("authorization"),
    hasUrlCredential: URL_CREDENTIAL_PARAMS.some((p) => params.has(p)),
    analyticsPassword: process.env.ANALYTICS_PASSWORD,
  });
  if (!auth.ok) return unauthorized();

  const db = getWriteDb();
  if (!db) {
    return NextResponse.json({ error: "No database" }, { status: 500 });
  }

  const days = parseInt(req.nextUrl.searchParams.get("days") || "30");
  const since = Date.now() - days * 86400000;

  // Queries per day
  const queriesPerDay = db.prepare(`
    SELECT date(ts/1000, 'unixepoch') as day, COUNT(*) as queries, COUNT(DISTINCT session_id) as sessions
    FROM query_log WHERE ts > ? GROUP BY day ORDER BY day
  `).all(since);

  // Tab breakdown
  const tabBreakdown = db.prepare(`
    SELECT tab, COUNT(*) as queries FROM query_log WHERE ts > ? GROUP BY tab ORDER BY queries DESC
  `).all(since);

  // Sessions with query counts
  const sessionDetails = db.prepare(`
    SELECT session_id, COUNT(*) as queries, MIN(ts) as first_query, MAX(ts) as last_query,
      GROUP_CONCAT(DISTINCT tab) as tabs_used,
      ROUND((MAX(ts) - MIN(ts)) / 1000.0) as duration_sec
    FROM query_log WHERE ts > ? AND session_id IS NOT NULL AND session_id != ''
    GROUP BY session_id ORDER BY first_query DESC LIMIT 100
  `).all(since);

  // Queries per session distribution
  const sessionDistribution = db.prepare(`
    SELECT queries_bucket, COUNT(*) as sessions FROM (
      SELECT session_id,
        CASE
          WHEN COUNT(*) = 1 THEN '1'
          WHEN COUNT(*) BETWEEN 2 AND 3 THEN '2-3'
          WHEN COUNT(*) BETWEEN 4 AND 6 THEN '4-6'
          WHEN COUNT(*) BETWEEN 7 AND 10 THEN '7-10'
          ELSE '11+'
        END as queries_bucket
      FROM query_log WHERE ts > ? AND session_id IS NOT NULL AND session_id != ''
      GROUP BY session_id
    ) GROUP BY queries_bucket
  `).all(since);

  // Error rate
  const errorRate = db.prepare(`
    SELECT COUNT(*) as total, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as errors
    FROM query_log WHERE ts > ?
  `).get(since);

  // Top questions
  const topQuestions = db.prepare(`
    SELECT question, COUNT(*) as cnt, tab FROM query_log WHERE ts > ? GROUP BY question ORDER BY cnt DESC LIMIT 20
  `).all(since);

  // Visitor log stats (referrers, devices)
  let referrers: unknown[] = [];
  let devices: unknown[] = [];
  let visitorsPerDay: unknown[] = [];
  try {
    referrers = db.prepare(`
      SELECT referrer_domain, COUNT(*) as visits FROM visitor_log
      WHERE ts > ? AND referrer_domain IS NOT NULL AND referrer_domain != ''
      GROUP BY referrer_domain ORDER BY visits DESC LIMIT 20
    `).all(since);

    devices = db.prepare(`
      SELECT
        CASE WHEN screen_width < 768 THEN 'Mobile' WHEN screen_width < 1024 THEN 'Tablet' ELSE 'Desktop' END as device,
        COUNT(*) as visits
      FROM visitor_log WHERE ts > ? AND screen_width IS NOT NULL
      GROUP BY device ORDER BY visits DESC
    `).all(since);

    visitorsPerDay = db.prepare(`
      SELECT date(ts/1000, 'unixepoch') as day, COUNT(*) as visits, COUNT(DISTINCT session_id) as unique_sessions
      FROM visitor_log WHERE ts > ? GROUP BY day ORDER BY day
    `).all(since);
  } catch {
    // visitor_log may not exist yet
  }

  return NextResponse.json({
    queriesPerDay,
    tabBreakdown,
    sessionDetails,
    sessionDistribution,
    errorRate,
    topQuestions,
    referrers,
    devices,
    visitorsPerDay,
  });
}
