import { NextRequest, NextResponse } from "next/server";

const TOKEN_SECRET = process.env.AUTH_PASSWORD || "nibrs-dev-secret";

async function hmacSha256(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyToken(token: string): Promise<boolean> {
  const parts = token.split(":");
  if (parts.length !== 3) return false;
  const [prefix, expiresStr, hmac] = parts;
  const payload = `${prefix}:${expiresStr}`;
  const expected = await hmacSha256(TOKEN_SECRET, payload);
  if (hmac !== expected) return false;
  if (Date.now() > parseInt(expiresStr, 10)) return false;
  return true;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Always allow auth endpoint, query-log (has its own key), and static assets
  if (pathname === "/api/auth" || pathname === "/api/query-log" || pathname === "/api/session-analytics" || pathname === "/api/page-token" || pathname.startsWith("/_next") || pathname === "/favicon.ico" || pathname === "/icon.svg") {
    return NextResponse.next();
  }

  // Skip auth if no password configured (local dev)
  if (!process.env.AUTH_PASSWORD) {
    return NextResponse.next();
  }

  const token = req.cookies.get("nibrs_auth")?.value;
  const valid = token ? await verifyToken(token) : false;

  // API routes: return 401
  if (pathname.startsWith("/api/")) {
    if (!valid) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  // Page routes: redirect to login
  if (!valid) {
    if (pathname === "/login") return NextResponse.next();
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
