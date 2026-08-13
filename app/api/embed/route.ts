import { NextRequest, NextResponse } from "next/server";
import { getDb, getWriteDb } from "@/lib/rtci-db";
import { getNibrsDb } from "@/lib/nibrs-db";
import { getShrDb } from "@/lib/shr-db";
import { validateAndSanitize } from "@/lib/sql-safety";
import crypto from "crypto";
import {
  emitFactualPayload,
  finalizeProof,
  type ProofFinalization,
  type SealedPayload,
} from "@/lib/proof-finalize";
import { isObserving, resolveMode } from "@/lib/proof-modes";
import {
  embedPlanFamily,
  originIsVerified,
  sharedChartsHasProof,
  verifyEmbedOrigin,
  type OriginVerdict,
} from "@/lib/embed-origin";
import { serializeChartConfigForLog } from "@/lib/chart-config-log";
import { returnedEntityKeys } from "@/lib/result-disclosure";
import type { SourceId } from "@/lib/proof-contract";

/**
 * A shared chart is a factual surface with no expiry.
 *
 * It re-executes stored SQL on every view, forever, for anyone with the link — and
 * before Stage 1 it did so with no connection to the answer it came from and no
 * validation of any kind. Handoff §4 puts it squarely inside the contract: "newly
 * created embeds require a valid originating proof, and embed reads require current
 * source health plus result/chart proof. Legacy embeds without adequate proof must not
 * be silently treated as compliant."
 *
 * WHAT STAGE 1 DOES HERE. Records, does not reject. Creation captures the originating
 * answer's proof; reads finalize the re-executed result and record what would have
 * been delivered. No user-visible behavior changes, because nothing is enforcing.
 *
 * LEGACY UNPROVED EMBEDS — the documented safe behavior. Every chart created before
 * this change has a NULL origin, and so does any created without a request id. They
 * are recorded as unproved rather than backfilled into looking compliant, and their
 * reads finalize as `decline_capability` in the hypothetical: the product cannot
 * establish where the numbers came from. Under enforcement they would stop serving.
 * That is a real coverage decision and belongs to Jeff, not to this stage.
 */

/**
 * THE CHOKEPOINT, same shape as the four query routes. Factual content is accepted
 * only as a SealedPayload; an error body asserts no facts and needs no proof.
 */
type EmbedError = { error: string };

function embedResp(data: SealedPayload<object> | EmbedError, status = 200) {
  return NextResponse.json(data, { status });
}

/** The proof source a stored chart's tab corresponds to. */
function sourceForTab(tab: string): SourceId {
  if (tab === "nibrs") return "nibrs";
  if (tab === "shr") return "shr";
  if (tab === "hate_crime") return "hate_crime";
  if (tab === "historical") return "historical";
  return "current";
}

/**
 * Whether shared_charts carries the proof columns yet.
 *
 * Detected at runtime for the same reason logQuery detects its own: schema and code
 * must be free to deploy in either order, and an unmigrated database must keep serving
 * embeds exactly as before rather than failing every save.
 */
/** Whether the proof system is observing for the source this chart belongs to. */
function observingFor(tab: string): boolean {
  return isObserving(resolveMode(sourceForTab(tab), null).mode);
}

/**
 * POST /api/embed — save a shared chart, return its ID
 * Body: { tab, title, sql, chartConfig, chartMeta, requestId? }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { tab, title, sql, chartConfig, chartMeta } = body;
    const requestId = typeof body?.requestId === "string" ? body.requestId.slice(0, 64) : null;

    if (!tab || !sql) {
      return embedResp({ error: "Missing tab or sql" }, 400);
    }

    // Validate SQL is safe (read-only)
    const check = validateAndSanitize(sql);
    if (!check.valid) {
      return embedResp({ error: "Invalid SQL" }, 400);
    }

    const db = getWriteDb();
    if (!db) {
      return embedResp({ error: "Database unavailable" }, 500);
    }

    // Generate a short random ID (8 chars, URL-safe)
    const id = crypto.randomBytes(6).toString("base64url").slice(0, 8);

    // OFF IS INERT, INCLUDING HERE. §9.1: `off` "performs no request-path work and has
    // no effect". A first revision ran the origin lookup and wrote origin_request_id
    // regardless of mode, so an off-mode deployment produced shared_charts rows the
    // baseline release would never write. No lookup, no proof columns, when off.
    const observing = observingFor(tab);
    const withProof = observing && sharedChartsHasProof(db);
    const origin: OriginVerdict | null = observing
      ? verifyEmbedOrigin(db, {
          requestId,
          tab,
          sql,
          // Serialized through the same allowlist the answer's own capture used, so the
          // two are comparable rather than being raw objects that differ by key order.
          chartConfigJson: chartConfig ? serializeChartConfigForLog(chartConfig, []) : null,
        })
      : null;

    const columns = ["id", "tab", "title", "sql", "chart_config", "chart_meta", "created_at"];
    const values: unknown[] = [
      id,
      tab,
      title || null,
      sql,
      chartConfig ? JSON.stringify(chartConfig) : null,
      chartMeta ? JSON.stringify(chartMeta) : null,
      Date.now(),
    ];
    if (withProof && origin) {
      columns.push(
        "origin_request_id",
        "origin_delivery_action",
        "origin_proof_mode",
        "origin_state",
      );
      values.push(requestId, origin.deliveryAction, origin.proofMode, origin.state);
    }

    db.prepare(
      `INSERT INTO shared_charts (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...values);

    if (origin && !originIsVerified(origin)) {
      // Recorded, not blocked. Stage 1 is shadow; §4's "must not be silently treated as
      // compliant" is satisfied by origin_state being stored and by the read path
      // finalizing on it.
      console.warn(`[embed] chart ${id} created with an unverified origin (${origin.state}): ${origin.reason}`);
    }

    return embedResp({ id } as SealedPayload<{ id: string }>);
  } catch (e) {
    console.error("embed POST error:", e);
    return embedResp({ error: "Failed to save" }, 500);
  }
}

/**
 * GET /api/embed?id=xxx — retrieve shared chart data and re-execute the SQL
 */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return embedResp({ error: "Missing id" }, 400);
  }

  try {
    const writeDb = getWriteDb();
    if (!writeDb) {
      return embedResp({ error: "Database unavailable" }, 500);
    }

    const withProof = sharedChartsHasProof(writeDb);
    const selectColumns = withProof
      ? "tab, title, sql, chart_config, chart_meta, origin_request_id, origin_delivery_action, origin_state"
      : "tab, title, sql, chart_config, chart_meta";
    const row = writeDb.prepare(
      `SELECT ${selectColumns} FROM shared_charts WHERE id = ?`,
    ).get(id) as {
      tab: string;
      title: string;
      sql: string;
      chart_config: string | null;
      chart_meta: string | null;
      origin_request_id?: string | null;
      origin_delivery_action?: string | null;
      origin_state?: string | null;
    } | undefined;

    if (!row) {
      return embedResp({ error: "Not found" }, 404);
    }

    // Re-validate SQL before executing
    const check = validateAndSanitize(row.sql);
    if (!check.valid) {
      return embedResp({ error: "Invalid stored SQL" }, 400);
    }

    // Pick the right database based on tab
    let db;
    try {
      if (row.tab === "nibrs") {
        db = getNibrsDb();
      } else if (row.tab === "shr") {
        db = getShrDb();
      } else {
        db = getDb();
      }
    } catch {
      return embedResp({ error: "Database unavailable" }, 500);
    }
    if (!db) {
      return embedResp({ error: "Database unavailable" }, 500);
    }

    // Execute the SQL
    const stmt = db.prepare(check.sanitized!);
    const rows = stmt.all() as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    // PROOF FINALIZATION FOR THE READ. Runs before the payload is constructed, on the
    // rows that will actually be returned.
    //
    // There is no question text here -- an embed is a saved artifact, not a request --
    // so the title stands in for it. That means the typed plan is thin and most checks
    // report `unknown`, which is the truthful state: nobody asked anything, and the
    // stored SQL is being replayed on faith.
    // THE ORIGIN VERDICT PARTICIPATES IN THE READ'S PROOF, rather than only in a log
    // line. A first revision assigned `embed-replay` whenever origin_request_id was
    // merely non-null, so a forged or unmatched origin was indistinguishable from a
    // verified one in the recorded evidence. The stored origin_state is the verdict
    // reached at creation, when the artifact and the logged answer were both in hand.
    const originVerdict: OriginVerdict = {
      state: (row.origin_state as OriginVerdict["state"]) ?? "absent",
      reason: `origin recorded at creation as '${row.origin_state ?? "absent"}'`,
      deliveryAction: row.origin_delivery_action ?? null,
      proofMode: null,
    };
    const originatingProven = originIsVerified(originVerdict);
    const finalization: ProofFinalization = finalizeProof({
      sourceId: sourceForTab(row.tab),
      question: row.title || "",
      sql: check.sanitized!,
      rows,
      columns,
      truncated: false,
      // An embed replays SQL it did not author. Even when the originating answer was
      // deterministic, this read has no token of its own, so derivation stays absent
      // rather than inheriting a claim from a different request.
      planFamily: embedPlanFamily(originVerdict),
      // Carried into the digest so a reviewer sees the provenance state alongside the
      // result, not only in a log line that scrolls away.
      guardrails: [`embed-origin-${originVerdict.state}`],
      returnedEntities: returnedEntityKeys(rows),
      hasChart: Boolean(row.chart_config),
      // A chart whose originating answer was never proven cannot have chart data
      // proven now: the bindings it was drawn from are gone.
      chartFromBindings: false,
      intendedAction: rows.length > 0 ? "answer" : "decline_data",
      db: null,
    });

    // GATED ON OBSERVATION, NOT JUST ON THE SCHEMA. §9.1 says `off` "performs no
    // request-path work and has no effect", and an UPDATE is an effect -- an
    // off-mode deployment must leave shared_charts byte-identical to what the
    // baseline release writes, exactly as proofLogFields() does for query_log.
    if (withProof && isObserving(finalization.mode)) {
      // Rolling summary rather than a row per read -- see the migration script for why
      // this does not go to query_log. Best-effort: a failed bookkeeping write must
      // never cost a viewer their chart.
      try {
        writeDb
          .prepare("UPDATE shared_charts SET last_read_delivery_action = ?, last_read_at = ? WHERE id = ?")
          .run(finalization.hypotheticalAction, Date.now(), id);
      } catch (error) {
        console.warn("[embed] last-read proof summary not recorded:", error instanceof Error ? error.message : String(error));
      }
    }

    if (!originatingProven) {
      console.warn(`[embed] serving chart ${id} with an unverified origin (${originVerdict.state})`);
    }

    return embedResp(
      emitFactualPayload(finalization, {
        tab: row.tab,
        title: row.title,
        sql: row.sql,
        columns,
        rows,
        chartConfig: row.chart_config ? JSON.parse(row.chart_config) : null,
        chartMeta: row.chart_meta ? JSON.parse(row.chart_meta) : null,
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("embed GET error:", msg);
    return embedResp({ error: "Failed to load" }, 500);
  }
}
