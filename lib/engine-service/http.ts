/**
 * The engine service's HTTP face: 127.0.0.1 only (the caller binds it), a shared token on every request but /health, small JSON bodies, the pool behind it.
 *
 *   GET  /health   no token: { ok, uptime..., pool stats, info } for the process manager and the route's health check
 *   POST /answer   x-engine-token: <token>; body EngineRequest; reply EngineResult with the status protocol.statusOf gives
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { EnginePool } from "./pool";
import { MAX_BODY_BYTES, parseEngineRequest, statusOf, type EngineResult } from "./protocol";

export type ServerOptions = { pool: EnginePool; token: string; /** What the service reports about itself (release id, cubes loaded); filled in by the workers. */ info?: () => Record<string, unknown>; startedAt?: number };

const send = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
};
const fail = (kind: "bad_request" | "error", message: string): EngineResult => ({ ok: false, kind, message });

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readBody(req: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false; tooLarge: boolean }> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return; // what is left of an oversized body is read and dropped; the connection is closed after the answer
      size += c.length;
      if (size > MAX_BODY_BYTES) { over = true; chunks.length = 0; resolve({ ok: false, tooLarge: true }); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => resolve({ ok: false, tooLarge: false }));
  });
}

export function createEngineServer(o: ServerOptions): Server {
  if (!o.token || o.token.length < 16) throw new Error("engine service: ENGINE_TOKEN must be set and at least 16 characters");
  return createServer(async (req, res) => {
    try {
      const url = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && url === "/health") return send(res, 200, { ok: true, startedAt: o.startedAt ?? null, pool: o.pool.stats(), ...(o.info ? { info: o.info() } : {}) });
      if (req.method === "POST" && url === "/answer") {
        const given = req.headers["x-engine-token"];
        if (typeof given !== "string" || !sameToken(given, o.token)) return send(res, 401, fail("error", "Not authorized."));
        const body = await readBody(req);
        if (!body.ok) {
          if (body.tooLarge) res.on("finish", () => req.destroy());
          return send(res, body.tooLarge ? 413 : 400, fail("bad_request", body.tooLarge ? "The request is too large." : "The request could not be read."));
        }
        let json: unknown;
        try { json = JSON.parse(body.text); } catch { return send(res, 400, fail("bad_request", "The request is not JSON.")); }
        const parsed = parseEngineRequest(json);
        if ("error" in parsed) return send(res, 400, fail("bad_request", parsed.error));
        const result = await o.pool.submit(parsed);
        return send(res, statusOf(result), result);
      }
      send(res, 404, fail("error", "Not found."));
    } catch (e) {
      send(res, 500, fail("error", `The engine service failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });
}
