/**
 * The Crime Data Assistant's local preview API: POST { question, previous?, path? } -> the shadow engine's outcome for
 * the chat page (/assistant), adapted by lib/nibrs-shadow/preview.ts. 404 unless previewEnabled(): never on a
 * production build, the same gate as /api/nibrs-shadow-query and /preview.
 *
 * A follow-up (P69): with `previous` (the standalone question of the last answer), the engine's follow-up rewriter
 * turns the two into one standalone question first, and that question is what is answered and shown ("asked"). The
 * rewriter's question back is returned as a clarify; a presentation-only follow-up is returned as such, for the page
 * to redraw the chart with no data turn; a proposed rewrite (P73) is returned for the user to confirm, never run. Buttons
 * carry `path` against `asked`, with no `previous`. A decline's `detail` (for logs) is never sent: toPreview omits it.
 *
 * Where the deterministic rewriter can't tell, the model rewriter is asked live (P73, ./live-rewriter.ts): its rewrite
 * comes back as a proposal; at the spend caps the page is asked for the full question. `session` (the page's id for the
 * chat) counts calls per session.
 */
import path from "node:path";
import { NextResponse } from "next/server";
import { shadowAnswer, type ShadowDeps } from "@/lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "@/lib/nibrs-shadow/places";
import { duckdbExecutor } from "@/lib/nibrs-shadow/duckdb";
import { historicalBuildAt } from "@/lib/nibrs-shadow/historical";
import { loadNibrsRelease } from "@/lib/nibrs-shadow/release";
import { currentBuildAt } from "@/lib/nibrs-shadow/current";
import { MAX_QUESTION, follow, parseRequest, previewEnabled, toPreview } from "@/lib/nibrs-shadow/preview";
import { liveModelRewrite } from "./live-rewriter";

export const dynamic = "force-dynamic";
const notFound = () => new NextResponse("Not Found", { status: 404 });

let deps: ShadowDeps | null = null;
function shadowDeps(): ShadowDeps {
  // As /api/nibrs-shadow-query: the pinned canonical build, read-only, through the local DuckDB executor; its months run
  // through the month before its CDE release's month (P93), from the release recorded with it.
  if (deps) return deps;
  const rel = loadNibrsRelease(undefined, process.env.NIBRS_SHADOW_ROOT);
  const execute = duckdbExecutor(process.env.NIBRS_SHADOW_PYTHON ?? "python");
  deps = {
    places: loadPlaceIndex(path.join(process.cwd(), "scripts/fixtures/nibrs-shadow/agencies.json")),
    release: { id: rel.id, firstMonth: rel.firstMonth, lastMonth: rel.lastMonth, asOf: new Date().toISOString().slice(0, 10) },
    target: { root: process.env.NIBRS_SHADOW_ROOT!, builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] },
    execute,
    // Historical (P75-P79) and Current Trends: the Crime Index build, when NIBRS_HISTORICAL_ROOT names one.
    historical: historicalBuildAt(process.env.NIBRS_HISTORICAL_ROOT),
    current: currentBuildAt(process.env.NIBRS_HISTORICAL_ROOT, execute),
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
  const extra = body as { session?: unknown };
  const session = typeof extra.session === "string" ? extra.session.slice(0, 64) : "none";
  const started = Date.now();
  try {
    let asked = question, rewrite: string | null = null;
    if (previous && clicked.length === 0) {
      // The engine's live hybrid (#95): deterministic first, the model only where it asks, through the guards.
      const r = await liveModelRewrite(previous, question, session);
      // The model's question back with its checked choices: each a proposal, none run until clicked.
      if (r.kind === "choices") return NextResponse.json({ kind: "proposal", asked: question, why: r.why, options: r.options, ms: Date.now() - started });
      if (r.kind === "ask") return NextResponse.json({ kind: "rewrite-ask", why: r.why, options: r.options, ms: Date.now() - started });
      if (r.kind === "presentation") return NextResponse.json({ kind: "presentation", asked: r.question, how: r.how, ms: Date.now() - started });
      // P73: a proposed rewrite is shown as "Did you mean ...?" and runs only when the user confirms it.
      if (r.kind === "propose") return NextResponse.json({ kind: "proposal", asked: r.question, question: r.question, ms: Date.now() - started });
      asked = r.question;
      rewrite = r.kind; // "rewrite": a follow-up to the previous question; "new": a question of its own
    }
    const d = shadowDeps();
    const at = follow(shadowAnswer(asked, d), clicked);
    if (!at) return NextResponse.json({ error: "That button is no longer offered for this question." }, { status: 409 });
    // The answer contract (#98): the page builds the title, lead, notes, chart choices and offers from `presentation`.
    return NextResponse.json({ ...toPreview(at, clicked, d.places, asked), asked, rewrite, ms: Date.now() - started });
  } catch (e) {
    return NextResponse.json({ error: `The preview engine failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}
