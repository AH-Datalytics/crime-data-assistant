import { NextRequest, NextResponse } from "next/server";
import { getWriteDb } from "@/lib/rtci-db";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  // Simple password check
  const pw = req.nextUrl.searchParams.get("pw");
  if (pw !== process.env.ANALYTICS_PASSWORD && pw !== "NIBRSAHD" && pw !== process.env.QUERY_LOG_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
  }

  const db = getWriteDb();
  if (!db) {
    return NextResponse.json({ error: "No database" }, { status: 500, headers: CORS_HEADERS });
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
  }, { headers: CORS_HEADERS });
}
