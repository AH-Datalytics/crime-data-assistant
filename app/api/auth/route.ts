import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";

const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";
const TOKEN_SECRET = process.env.AUTH_PASSWORD || "nibrs-dev-secret";

function makeToken(): string {
  const expires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  const payload = `nibrs:${expires}`;
  const hmac = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex");
  return `${payload}:${hmac}`;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const password = body?.password?.trim();

  if (!AUTH_PASSWORD) {
    // No password configured — allow access (local dev)
    const token = makeToken();
    const cookieStore = await cookies();
    cookieStore.set("nibrs_auth", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 86400,
      path: "/",
    });
    return NextResponse.json({ success: true });
  }

  if (password !== AUTH_PASSWORD) {
    return NextResponse.json({ success: false, error: "Wrong password" }, { status: 401 });
  }

  const token = makeToken();
  const cookieStore = await cookies();
  cookieStore.set("nibrs_auth", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 86400,
    path: "/",
  });

  return NextResponse.json({ success: true });
}
