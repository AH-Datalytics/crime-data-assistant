import { NextRequest, NextResponse } from "next/server";
import { verifyTurnstile, grantCaptchaCredit } from "@/lib/captcha";

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";

  try {
    const body = await req.json();
    const token = body?.token as string;
    const sessionId = body?.sessionId as string;

    if (!token || !sessionId) {
      return NextResponse.json({ success: false, error: "Missing token or session" }, { status: 400 });
    }

    const ok = await verifyTurnstile(token, ip);
    if (!ok) {
      return NextResponse.json({ success: false, error: "Verification failed" }, { status: 403 });
    }

    grantCaptchaCredit(sessionId);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false, error: "Verification error" }, { status: 500 });
  }
}
