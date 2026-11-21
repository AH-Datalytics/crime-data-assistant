/**
 * The web route's client for the engine service (127.0.0.1): one POST per question with the shared token. A service that cannot be reached, that answers too slowly, or that sends
 * something unreadable is reported as a plain "unavailable" result: the route shows it as such and never falls back to the old engine.
 */
import type { EngineRequest, EngineResult } from "./engine-service/protocol";

export type EngineClientConfig = { url: string; token: string; timeoutMs: number };

export function engineClientConfig(env: Record<string, string | undefined> = process.env): EngineClientConfig | null {
  const token = env.ENGINE_TOKEN;
  if (!token || token.length < 16) return null;
  // The route waits a little longer than the service's own per-question limit, so the service's "timeout" answer arrives before this one gives up.
  const service = Number(env.ENGINE_TIMEOUT_MS ?? "120000");
  return { url: (env.ENGINE_SERVICE_URL ?? "http://127.0.0.1:8420").replace(/\/+$/, ""), token, timeoutMs: (Number.isFinite(service) && service > 0 ? service : 120000) + 10000 };
}

export async function callEngine(req: EngineRequest, cfg: EngineClientConfig | null, fetchImpl: typeof fetch = fetch): Promise<EngineResult> {
  const unavailable = (message: string): EngineResult => ({ ok: false, kind: "unavailable", message });
  if (!cfg) return unavailable("The engine is not configured on this server.");
  try {
    const res = await fetchImpl(`${cfg.url}/answer`, { method: "POST", headers: { "content-type": "application/json", "x-engine-token": cfg.token }, body: JSON.stringify(req), signal: AbortSignal.timeout(cfg.timeoutMs) });
    const body = await res.json().catch(() => null) as EngineResult | null;
    if (body && typeof body === "object" && typeof (body as { ok?: unknown }).ok === "boolean") return body;
    return unavailable("The engine sent an answer this page cannot read.");
  } catch (e) {
    return unavailable(e instanceof Error && e.name === "TimeoutError" ? "The engine did not answer in time." : "The engine is not reachable right now.");
  }
}
