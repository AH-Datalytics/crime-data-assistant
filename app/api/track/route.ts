import { NextRequest, NextResponse } from "next/server";
import { getWriteDb } from "@/lib/rtci-db";

/**
 * Lightweight visitor tracking endpoint.
 * Logs page views with referrer, UTM params, session info, and geo data.
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
      user_agent TEXT,
      ip TEXT,
      city TEXT,
      region TEXT,
      country TEXT
    )
  `);
  // Add geo columns if table already existed without them
  const cols = db.prepare("PRAGMA table_info(visitor_log)").all() as { name: string }[];
  const colNames = new Set(cols.map(c => c.name));
  if (!colNames.has("ip")) db.exec("ALTER TABLE visitor_log ADD COLUMN ip TEXT");
  if (!colNames.has("city")) db.exec("ALTER TABLE visitor_log ADD COLUMN city TEXT");
  if (!colNames.has("region")) db.exec("ALTER TABLE visitor_log ADD COLUMN region TEXT");
  if (!colNames.has("country")) db.exec("ALTER TABLE visitor_log ADD COLUMN country TEXT");

  db.exec(`CREATE INDEX IF NOT EXISTS idx_visitor_ts ON visitor_log(ts)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_visitor_referrer ON visitor_log(referrer_domain)`
  );
  tableReady = true;
}

/** Lookup city/region/country from IP via ipwho.is (free HTTPS, 10K/month) */
async function geoLookup(ip: string): Promise<{ city: string; region: string; country: string } | null> {
  if (!ip || ip === "unknown" || ip === "127.0.0.1" || ip === "::1") return null;
  try {
    const res = await fetch(`https://ipwho.is/${ip}`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json() as { success?: boolean; city?: string; region?: string; country?: string };
    if (data.success && data.city) {
      return { city: data.city || "", region: data.region || "", country: data.country || "" };
    }
  } catch { /* timeout or network error — skip silently */ }
  return null;
}

// Cache geo results per IP to avoid redundant lookups
const geoCache = new Map<string, { city: string; region: string; country: string } | null>();

export async function POST(req: NextRequest) {
  try {
    ensureTable();
    const db = getWriteDb();
    if (!db) {
      return NextResponse.json({ ok: true });
    }

    const body = await req.json();
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";

    const referrer = (body.referrer || "").substring(0, 2000);
    let referrerDomain = "";
    if (referrer) {
      try {
        referrerDomain = new URL(referrer).hostname;
      } catch {
        referrerDomain = referrer.substring(0, 200);
      }
    }

    // Geo lookup — only on pageview, async with cache
    let geo: { city: string; region: string; country: string } | null = null;
    const event = (body.event || "pageview").substring(0, 50);
    if (event === "pageview" && ip !== "unknown") {
      if (geoCache.has(ip)) {
        geo = geoCache.get(ip) || null;
      } else {
        geo = await geoLookup(ip);
        geoCache.set(ip, geo);
        // Keep cache from growing unbounded
        if (geoCache.size > 5000) {
          const first = geoCache.keys().next().value;
          if (first) geoCache.delete(first);
        }
      }
    }

    db.prepare(
      `INSERT INTO visitor_log (ts, session_id, referrer, referrer_domain, utm_source, utm_medium, utm_campaign, utm_content, landing_page, tab, event, screen_width, user_agent, city, region, country)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      event,
      body.screenWidth || null,
      (req.headers.get("user-agent") || "").substring(0, 500),
      geo?.city || null,
      geo?.region || null,
      geo?.country || null
    );

    return NextResponse.json({ ok: true });
  } catch {
    // Never fail — tracking should be invisible
    return NextResponse.json({ ok: true });
  }
}
