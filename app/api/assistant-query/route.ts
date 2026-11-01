/**
 * The Crime Data Assistant's local preview API: POST { question, previous?, path? } -> the shadow engine's outcome for
 * the chat page (/assistant), adapted by lib/nibrs-shadow/preview.ts. 404 unless previewEnabled(): never on a
 * production build, the same gate as /api/nibrs-shadow-query and /preview.
 *
 * A follow-up (P69): with `previous` (the standalone question of the last answer), the engine's follow-up rewriter
 * turns the two into one standalone question first, and that question is what is answered and shown ("asked"). The
 * rewriter's question back is returned as a clarify; a presentation-only follow-up is returned as such, for the page
 * to redraw the chart with no data turn. Buttons carry `path` against `asked`, with no `previous`.
 */
import path from "node:path";
import { NextResponse } from "next/server";
import { shadowAnswer, type ShadowDeps } from "@/lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "@/lib/nibrs-shadow/places";
import { duckdbExecutor } from "@/lib/nibrs-shadow/duckdb";
import { deterministicRewriter } from "@/lib/nibrs-shadow/follow-up";
import { MAX_QUESTION, follow, parseRequest, previewEnabled, toPreview } from "@/lib/nibrs-shadow/preview";

export const dynamic = "force-dynamic";
const notFound = () => new NextResponse("Not Found", { status: 404 });

let deps: ShadowDeps | null = null;
function shadowDeps(): ShadowDeps {
  // As /api/nibrs-shadow-query: the pinned canonical build, read-only, through the local DuckDB executor.
  deps ??= {
    places: loadPlaceIndex(path.join(process.cwd(), "scripts/fixtures/nibrs-shadow/agencies.json")),
    release: { id: process.env.NIBRS_SHADOW_RELEASE ?? "20261028-test5", firstMonth: "2017-01", lastMonth: process.env.NIBRS_SHADOW_LAST_MONTH ?? "2026-09", asOf: new Date().toISOString().slice(0, 10) },
    target: { root: process.env.NIBRS_SHADOW_ROOT!, builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] },
    execute: duckdbExecutor(process.env.NIBRS_SHADOW_PYTHON ?? "python"),
  };
  return deps;
}

export async function GET() {
  return previewEnabled() ? NextResponse.json({ ok: true }) : notFound();
}

export async function POST(req: Request) {
  if (!previewEnabled()) return notFound();
  const body = await req.json().catch(() => null);
  const parsed = parseRequest(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const raw = (body as { previous?: unknown }).previous;
  const previous = typeof raw === "string" && raw.trim() && raw.length <= MAX_QUESTION ? raw.trim() : null;
  const { question, path: clicked } = parsed;
  const started = Date.now();
  try {
    let asked = question;
    if (previous && clicked.length === 0) {
      const r = deterministicRewriter.rewrite(previous, question);
      if (r.kind === "ask") return NextResponse.json({ kind: "rewrite-ask", why: r.why, options: r.options, ms: Date.now() - started });
      if (r.kind === "presentation") return NextResponse.json({ kind: "presentation", asked: r.question, how: r.how, ms: Date.now() - started });
      asked = r.question;
    }
    const at = follow(shadowAnswer(asked, shadowDeps()), clicked);
    if (!at) return NextResponse.json({ error: "That button is no longer offered for this question." }, { status: 409 });
    return NextResponse.json({ ...toPreview(at, clicked), asked, ms: Date.now() - started });
  } catch (e) {
    return NextResponse.json({ error: `The preview engine failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}
