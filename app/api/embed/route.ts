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
import { queryLogHasColumn } from "@/lib/query-log-columns";
import { isObserving } from "@/lib/proof-modes";
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
function sharedChartsHasProof(db: object): boolean {
  try {
    const rows = (db as { prepare: (sql: string) => { all: () => Array<{ name: string }> } })
      .prepare("PRAGMA table_info(shared_charts)")
      .all();
    const names = new Set(rows.map((row) => row.name));
    return names.has("origin_request_id") && names.has("last_read_delivery_action");
  } catch {
    return false;
  }
}

/**
 * The originating answer's recorded proof, looked up by the request id the client
 * carries back from the response that produced the chart.
 *
 * Returns nulls when the link is absent or the row cannot be found — which is the
 * legacy-unproved case, and must stay distinguishable from "found and it passed".
 */
function originProof(
  db: ReturnType<typeof getWriteDb>,
  requestId: string | null,
): { deliveryAction: string | null; proofMode: string | null } {
  if (!db || !requestId) return { deliveryAction: null, proofMode: null };
  if (!queryLogHasColumn(db, "delivery_action") || !queryLogHasColumn(db, "request_id")) {
    return { deliveryAction: null, proofMode: null };
  }
  try {
    const row = db
      .prepare("SELECT delivery_action, proof_mode FROM query_log WHERE request_id = ? ORDER BY id DESC LIMIT 1")
      .get(requestId) as { delivery_action: string | null; proof_mode: string | null } | undefined;
    return {
      deliveryAction: row?.delivery_action ?? null,
      proofMode: row?.proof_mode ?? null,
    };
  } catch {
    return { deliveryAction: null, proofMode: null };
  }
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

    const origin = originProof(db, requestId);
    const withProof = sharedChartsHasProof(db);

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
    if (withProof) {
      columns.push("origin_request_id", "origin_delivery_action", "origin_proof_mode");
      values.push(requestId, origin.deliveryAction, origin.proofMode);
    }

    db.prepare(
      `INSERT INTO shared_charts (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...values);

    if (!origin.deliveryAction) {
      // Recorded, not blocked. Stage 1 is shadow; §4's "must not be silently treated
      // as compliant" is satisfied by the NULL being visible and by the read path
      // finalizing these as unproved.
      console.warn(`[embed] chart ${id} created with no originating proof (requestId=${requestId ?? "absent"})`);
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
      ? "tab, title, sql, chart_config, chart_meta, origin_request_id, origin_delivery_action"
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
    const originatingProven = row.origin_delivery_action === "answer" ||
      row.origin_delivery_action === "answer_limited_scope";
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
      planFamily: withProof && row.origin_request_id ? "embed-replay" : "embed-legacy-unproved",
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
      console.warn(`[embed] serving chart ${id} whose originating answer was not proven (origin=${row.origin_delivery_action ?? "absent"})`);
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
