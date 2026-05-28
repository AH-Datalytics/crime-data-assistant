import { NextRequest, NextResponse } from "next/server";
import { getDb, getWriteDb } from "@/lib/rtci-db";
import { getNibrsDb } from "@/lib/nibrs-db";
import { getShrDb } from "@/lib/shr-db";
import { validateAndSanitize } from "@/lib/sql-safety";
import crypto from "crypto";

/**
 * POST /api/embed — save a shared chart, return its ID
 * Body: { tab, title, sql, chartConfig, chartMeta }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { tab, title, sql, chartConfig, chartMeta } = body;

    if (!tab || !sql) {
      return NextResponse.json({ error: "Missing tab or sql" }, { status: 400 });
    }

    // Validate SQL is safe (read-only)
    const check = validateAndSanitize(sql);
    if (!check.valid) {
      return NextResponse.json({ error: "Invalid SQL" }, { status: 400 });
    }

    const db = getWriteDb();
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    // Generate a short random ID (8 chars, URL-safe)
    const id = crypto.randomBytes(6).toString("base64url").slice(0, 8);

    db.prepare(
      "INSERT INTO shared_charts (id, tab, title, sql, chart_config, chart_meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      id,
      tab,
      title || null,
      sql,
      chartConfig ? JSON.stringify(chartConfig) : null,
      chartMeta ? JSON.stringify(chartMeta) : null,
      Date.now()
    );

    return NextResponse.json({ id });
  } catch (e) {
    console.error("embed POST error:", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}

/**
 * GET /api/embed?id=xxx — retrieve shared chart data and re-execute the SQL
 */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  try {
    const writeDb = getWriteDb();
    if (!writeDb) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    const row = writeDb.prepare(
      "SELECT tab, title, sql, chart_config, chart_meta FROM shared_charts WHERE id = ?"
    ).get(id) as { tab: string; title: string; sql: string; chart_config: string | null; chart_meta: string | null } | undefined;

    if (!row) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Re-validate SQL before executing
    const check = validateAndSanitize(row.sql);
    if (!check.valid) {
      return NextResponse.json({ error: "Invalid stored SQL" }, { status: 400 });
    }

    // Pick the right database based on tab
    let db;
    try {
      if (row.tab === "nibrs") {
        db = getNibrsDb();
      } else if (row.tab === "shr") {
        db = getShrDb();
      } else {
        db = getDb();
      }
    } catch {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    // Execute the SQL
    const stmt = db.prepare(check.sanitized!);
    const rows = stmt.all() as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    return NextResponse.json({
      tab: row.tab,
      title: row.title,
      sql: row.sql,
      columns,
      rows,
      chartConfig: row.chart_config ? JSON.parse(row.chart_config) : null,
      chartMeta: row.chart_meta ? JSON.parse(row.chart_meta) : null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("embed GET error:", msg);
    return NextResponse.json({ error: "Failed to load" }, { status: 500 });
  }
}
