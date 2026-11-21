/**
 * Engine question (stage 1 of the engine switch): POST { question, tab?, path?, previous?, sessionId, pageToken } -> the engine service's answer in the shape the private preview
 * uses, or a plain busy / timeout / unavailable message. 404 for every browser without the owner's private cookie (lib/engine-private.ts). Behind the site login like every route.
 * The logic is lib/engine-route.ts (tested with fakes); this file only wires the real rate limit, session limit, page token, engine client and query log.
 */
import { NextRequest, NextResponse } from "next/server";
import { callEngine, engineClientConfig } from "@/lib/engine-client";
import { ENGINE_COOKIE, isEnginePrivate } from "@/lib/engine-private";
import { handleEngineQuery } from "@/lib/engine-route";
import { logNibrsQuery } from "@/lib/nibrs-db";
import { validatePageToken } from "@/lib/page-token";
import { checkRateLimit } from "@/lib/rate-limit";
import { checkSessionLimit, maybeCleanup } from "@/lib/captcha";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  maybeCleanup();
  const reply = await handleEngineQuery(body, {
    isPrivate: isEnginePrivate(req.cookies.get(ENGINE_COOKIE)?.value),
    ip,
    validatePageToken,
    rateLimit: checkRateLimit,
    sessionLimit: checkSessionLimit,
    call: (r) => callEngine(r, engineClientConfig()),
    log: (row) => { logNibrsQuery(row.question, row.sql, row.rowCount, row.error, row.ms, row.response, row.guardrails, row.model, row.sessionId); },
    clock: () => performance.now(),
  });
  return NextResponse.json(reply.json, { status: reply.status });
}
