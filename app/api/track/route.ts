import { NextRequest, NextResponse } from "next/server";
import { getWriteDb } from "@/lib/rtci-db";

/**
 * Lightweight visitor tracking endpoint.
 * Logs page views with referrer, UTM params, and session info.
 * No IP addresses or geo data collected.
 */

// Create table on first request
let tableReady = false;

function ensureTable() {
  if (tableReady) return;
  const db = getWriteDb();
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS visitor_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT,
      referrer TEXT,
      referrer_domain TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_content TEXT,
      landing_page TEXT,
      tab TEXT,
      event TEXT DEFAULT 'pageview',
      screen_width INTEGER,
      user_agent TEXT
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_visitor_ts ON visitor_log(ts)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_visitor_referrer ON visitor_log(referrer_domain)`
  );
  tableReady = true;
}

export async function POST(req: NextRequest) {
  try {
    ensureTable();
    const db = getWriteDb();
    if (!db) {
      return NextResponse.json({ ok: true });
    }

    const body = await req.json();

    const referrer = (body.referrer || "").substring(0, 2000);
    let referrerDomain = "";
    if (referrer) {
      try {
        referrerDomain = new URL(referrer).hostname;
      } catch {
        referrerDomain = referrer.substring(0, 200);
      }
    }

    db.prepare(
      `INSERT INTO visitor_log (ts, session_id, referrer, referrer_domain, utm_source, utm_medium, utm_campaign, utm_content, landing_page, tab, event, screen_width, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      Date.now(),
      (body.sessionId || "").substring(0, 64),
      referrer,
      referrerDomain,
      (body.utm_source || "").substring(0, 200),
      (body.utm_medium || "").substring(0, 200),
      (body.utm_campaign || "").substring(0, 200),
      (body.utm_content || "").substring(0, 200),
      (body.landingPage || "").substring(0, 500),
      (body.tab || "").substring(0, 50),
      (body.event || "pageview").substring(0, 50),
      typeof body.screenWidth === "number" ? body.screenWidth : null,
      (body.userAgent || "").substring(0, 500)
    );

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[track] Error:", e);
    return NextResponse.json({ ok: true });
  }
}
