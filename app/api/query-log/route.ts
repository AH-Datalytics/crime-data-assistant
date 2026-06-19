import { NextRequest, NextResponse } from "next/server";
import { getDb, getWriteDb } from "@/lib/rtci-db";
import { getNibrsDb } from "@/lib/nibrs-db";
import { getShrDb } from "@/lib/shr-db";
import { getHateCrimeDb } from "@/lib/hc-db";
import { recommendTabs, isFollowUp } from "@/lib/tab-suggest";

const LOG_KEY = process.env.QUERY_LOG_KEY;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

interface DailyImpactRow {
  ts: number;
  tab: string | null;
  question: string | null;
  has_sql: number;
  rows: number | null;
  has_error: number;
  has_guardrails: number;
  response_len: number;
  ms: number | null;
}

/**
 * Per-day impact metrics. Definitions:
 * - properly routed: capability router (lib/tab-suggest autoRoute) agrees the
 *   query's tab is the primary recommendation or a listed alternative.
 *   Follow-ups and questions the router has no opinion on are "unassessed"
 *   and excluded from the routed %.
 * - likely correct: no error AND (returned data rows, OR a substantive text
 *   answer ≥60 chars for no-SQL meta/clarification responses). Zero-row SQL
 *   results and empty responses are excluded — heuristic, not ground truth.
 */
function computeDailyImpact(db: ReturnType<typeof getWriteDb>, days: number, tzMin: number) {
  if (!db) return [];
  const cutoffMs = Date.now() - days * 86400_000;
  const rows = db
    .prepare(
      `SELECT ts, tab, question,
              CASE WHEN sql IS NOT NULL THEN 1 ELSE 0 END AS has_sql,
              rows,
              CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END AS has_error,
              CASE WHEN guardrails IS NOT NULL AND guardrails != '' THEN 1 ELSE 0 END AS has_guardrails,
              COALESCE(LENGTH(response), 0) AS response_len,
              ms
       FROM query_log WHERE ts >= ? ORDER BY ts`
    )
    .all(cutoffMs) as DailyImpactRow[];

  type DayAgg = {
    day: string;
    total: number;
    errors: number;
    zeroData: number;
    withData: number;
    textAnswer: number;
    noAnswer: number;
    guardrails: number;
    routedOk: number;
    routedMismatch: number;
    routedUnassessed: number;
    likelyCorrect: number;
    msSum: number;
    msCount: number;
  };
  const byDay = new Map<string, DayAgg>();

  for (const r of rows) {
    const day = new Date(r.ts - tzMin * 60_000).toISOString().slice(0, 10);
    let agg = byDay.get(day);
    if (!agg) {
      agg = {
        day, total: 0, errors: 0, zeroData: 0, withData: 0, textAnswer: 0,
        noAnswer: 0, guardrails: 0, routedOk: 0, routedMismatch: 0,
        routedUnassessed: 0, likelyCorrect: 0, msSum: 0, msCount: 0,
      };
      byDay.set(day, agg);
    }
    agg.total++;
    if (r.has_guardrails) agg.guardrails++;
    if (r.ms != null) { agg.msSum += r.ms; agg.msCount++; }

    // Outcome classification
    if (r.has_error) agg.errors++;
    else if (r.has_sql && (r.rows ?? 0) > 0) { agg.withData++; agg.likelyCorrect++; }
    else if (r.has_sql) agg.zeroData++;
    else if (r.response_len >= 60) { agg.textAnswer++; agg.likelyCorrect++; }
    else agg.noAnswer++;

    // Routing assessment: tab counts as properly routed when it is the
    // capability router's top recommendation or within 2 points of it
    // (a genuine near-tie). Follow-ups and weak router opinions (top
    // score < 6) are unassessed.
    const q = r.question || "";
    // Anaphoric short questions ("show this with LA", "can you show the rate")
    // and tab-scoped availability questions ("do you have data for NYC?") are
    // context-dependent — the router can't judge them.
    const anaphoric = /\b(this|these|those)\b/i.test(q) && q.length < 90;
    const availability = /\b(do you have|is there (any )?data|what data do you)\b/i.test(q);
    if (!q || !r.tab || isFollowUp(q) || anaphoric || availability) { agg.routedUnassessed++; continue; }
    let recs: ReturnType<typeof recommendTabs> = [];
    try { recs = recommendTabs(q); } catch { /* router error → unassessed */ }
    const top = recs[0];
    if (!top || top.score < 6) agg.routedUnassessed++;
    else if (recs.some((rec) => rec.tab === r.tab && rec.score >= top.score - 2)) agg.routedOk++;
    else agg.routedMismatch++;
  }

  return [...byDay.values()]
    .sort((a, b) => b.day.localeCompare(a.day))
    .map(({ msSum, msCount, ...d }) => ({
      ...d,
      avgMs: msCount > 0 ? Math.round(msSum / msCount) : null,
    }));
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);

  // Require explicit QUERY_LOG_KEY env var — no default fallback
  const key = url.searchParams.get("key") || "";
  if (!LOG_KEY || key !== LOG_KEY) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: CORS_HEADERS }
    );
  }

  if (url.searchParams.get("daily") === "1") {
    const days = Math.min(parseInt(url.searchParams.get("days") || "30", 10) || 30, 365);
    const tzMin = parseInt(url.searchParams.get("tzMin") || "0", 10) || 0;
    const daily = computeDailyImpact(getWriteDb(), days, tzMin);
    return NextResponse.json({ daily }, { headers: CORS_HEADERS });
  }

  const limit = parseInt(url.searchParams.get("limit") || "100", 10);
  const filter = url.searchParams.get("filter") || "all";
  const tabFilter = url.searchParams.get("tab") || "all";

  const db = getWriteDb();
  if (!db) {
    return NextResponse.json(
      { rows: [], stats: { total: 0, ok: 0, errors: 0, avgMs: null, recentAvgMs: null, recentMedianMs: null } },
      { headers: CORS_HEADERS }
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
      `SELECT id, ts, tab, question, sql, rows, error, ms, response, guardrails, routing_confidence, routing_mode, routing_reason, query_guidance FROM query_log ${where} ORDER BY id DESC ${limitClause}`
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

  return NextResponse.json({
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
  }, { headers: CORS_HEADERS });
}

/** Re-run a logged SQL query against the appropriate database */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const key = body?.key || "";
    if (!LOG_KEY || key !== LOG_KEY) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
    }

    const sql = body?.sql as string;
    const tab = body?.tab as string;
    if (!sql || !tab) {
      return NextResponse.json({ error: "Missing sql or tab" }, { status: 400, headers: CORS_HEADERS });
    }

    // Only allow SELECT queries
    const firstWord = sql.trim().split(/\s+/)[0].toUpperCase();
    if (firstWord !== "SELECT" && firstWord !== "WITH") {
      return NextResponse.json({ error: "Only SELECT queries allowed" }, { status: 400, headers: CORS_HEADERS });
    }

    let db;
    if (tab === "nibrs") {
      db = getNibrsDb();
    } else if (tab === "shr") {
      db = getShrDb();
    } else if (tab === "hate_crime") {
      db = getHateCrimeDb();
    } else {
      db = getDb();
    }

    if (!db) {
      return NextResponse.json({ error: "Database not available" }, { status: 500, headers: CORS_HEADERS });
    }

    const rows = db.prepare(sql).all() as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    return NextResponse.json({ columns, rows: rows.slice(0, 500) }, { headers: CORS_HEADERS });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS_HEADERS });
  }
}
