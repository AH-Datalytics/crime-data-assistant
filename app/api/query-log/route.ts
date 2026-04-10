import { NextRequest, NextResponse } from "next/server";
import { getWriteDb } from "@/lib/rtci-db";

const LOG_KEY = process.env.QUERY_LOG_KEY;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);

  const key = url.searchParams.get("key") || "";
  if (!LOG_KEY || key !== LOG_KEY) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }

  const limit = parseInt(url.searchParams.get("limit") || "100", 10);
  const filter = url.searchParams.get("filter") || "all";
  const tabFilter = url.searchParams.get("tab") || "all";

  const db = getWriteDb();
  if (!db) {
    return NextResponse.json(
      { rows: [], stats: { total: 0, ok: 0, errors: 0, avgMs: null, recentAvgMs: null, recentMedianMs: null } },
      { headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }

  const conditions: string[] = [];
  if (filter === "ok") conditions.push("error IS NULL AND sql IS NOT NULL");
  else if (filter === "err") conditions.push("error IS NOT NULL");
  else if (filter === "nosql") conditions.push("sql IS NULL AND error IS NULL");

  if (tabFilter !== "all") conditions.push(`tab = '${tabFilter.replace(/'/g, "")}'`);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limitClause = limit > 0 ? `LIMIT ${limit}` : "";

  const rows = db
    .prepare(
      `SELECT id, ts, tab, question, sql, rows, error, ms, response FROM query_log ${where} ORDER BY id DESC ${limitClause}`
    )
    .all();

  const statsRow = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN error IS NULL AND sql IS NOT NULL THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
              AVG(CASE WHEN error IS NULL THEN ms END) AS avg_ms
       FROM query_log ${where}`
    )
    .get() as { total: number; ok: number; errors: number; avg_ms: number | null };

  const recentRows = db
    .prepare(
      `SELECT ms FROM query_log WHERE error IS NULL AND ms IS NOT NULL ORDER BY id DESC LIMIT 20`
    )
    .all() as { ms: number }[];

  let recentAvgMs: number | null = null;
  let recentMedianMs: number | null = null;
  if (recentRows.length > 0) {
    const vals = recentRows.map((r) => r.ms).sort((a, b) => a - b);
    const n = vals.length;
    recentAvgMs = Math.round(vals.reduce((s, v) => s + v, 0) / n);
    const mid = Math.floor(n / 2);
    recentMedianMs =
      n % 2 === 1 ? vals[mid] : Math.floor((vals[mid - 1] + vals[mid]) / 2);
  }

  // Tab breakdown
  const tabStats = db
    .prepare(
      `SELECT tab, COUNT(*) AS cnt FROM query_log GROUP BY tab ORDER BY cnt DESC`
    )
    .all();

  return NextResponse.json(
    {
      rows,
      stats: {
        total: statsRow.total,
        ok: statsRow.ok,
        errors: statsRow.errors,
        avgMs: statsRow.avg_ms ? Math.round(statsRow.avg_ms) : null,
        recentAvgMs,
        recentMedianMs,
        tabBreakdown: tabStats,
      },
    },
    { headers: { "Access-Control-Allow-Origin": "*" } }
  );
}
