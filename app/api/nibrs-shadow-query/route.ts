/**
 * The private preview's API (local only): POST { question, path? } -> the shadow engine's outcome, adapted for the UI
 * (lib/nibrs-shadow/preview.ts). 404 unless previewEnabled(): never on a production build. Reads the canonical build at
 * NIBRS_SHADOW_ROOT read-only, through the local DuckDB executor (Python with duckdb at NIBRS_SHADOW_PYTHON).
 */
import path from "node:path";
import { NextResponse } from "next/server";
import { shadowAnswer, type ShadowDeps } from "@/lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "@/lib/nibrs-shadow/places";
import { duckdbExecutor } from "@/lib/nibrs-shadow/duckdb";
import { follow, previewEnabled, toPreview } from "@/lib/nibrs-shadow/preview";

export const dynamic = "force-dynamic";
const notFound = () => new NextResponse("Not Found", { status: 404 });

let deps: ShadowDeps | null = null;
function shadowDeps(): ShadowDeps {
  // The pinned build (agreed with nibrs-model): its id is in every answer's source statement. P52: the upload month
  // (2026-10) is not reported.
  deps ??= {
    // The bundled route has no source __dirname: the index is read from the project root.
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
  const body = (await req.json().catch(() => null)) as { question?: unknown; path?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim().slice(0, 500) : "";
  const path = Array.isArray(body?.path) && body.path.every((x) => typeof x === "string") ? (body.path as string[]) : [];
  if (!question) return NextResponse.json({ error: "Ask a question." }, { status: 400 });
  try {
    const at = follow(shadowAnswer(question, shadowDeps()), path);
    if (!at) return NextResponse.json({ error: "That button is no longer offered for this question." }, { status: 409 });
    return NextResponse.json(toPreview(at, path));
  } catch (e) {
    return NextResponse.json({ error: `The preview engine failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}
