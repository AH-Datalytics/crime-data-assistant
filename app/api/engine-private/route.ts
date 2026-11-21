/**
 * The private flag's own route (stage 1): GET /api/engine-private
 *   ?key=<ENGINE_PRIVATE_KEY>  sets the owner's cookie (httpOnly, 30 days) and answers { enabled: true }
 *   ?off=1                      clears the cookie
 *   (no parameter)              { enabled: boolean }: whether THIS browser holds the cookie, for the page to choose its path
 * With no ENGINE_PRIVATE_KEY configured the whole route is a 404: the flag does not exist.
 */
import { NextRequest, NextResponse } from "next/server";
import { ENGINE_COOKIE, engineCookieValue, isEngineKey, isEnginePrivate } from "@/lib/engine-private";

export const dynamic = "force-dynamic";
const THIRTY_DAYS = 30 * 24 * 3600;

export async function GET(req: NextRequest) {
  const value = engineCookieValue();
  if (!value) return new NextResponse("Not Found", { status: 404 });
  const url = req.nextUrl;
  if (url.searchParams.get("off") === "1") {
    const res = NextResponse.json({ enabled: false });
    res.cookies.set(ENGINE_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    return res;
  }
  if (url.searchParams.has("key")) {
    if (!isEngineKey(url.searchParams.get("key"))) return new NextResponse("Not Found", { status: 404 });
    const res = NextResponse.json({ enabled: true });
    res.cookies.set(ENGINE_COOKIE, value, { httpOnly: true, sameSite: "lax", path: "/", maxAge: THIRTY_DAYS, secure: process.env.NODE_ENV === "production" });
    return res;
  }
  return NextResponse.json({ enabled: isEnginePrivate(req.cookies.get(ENGINE_COOKIE)?.value) });
}
