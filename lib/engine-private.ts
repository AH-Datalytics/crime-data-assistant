/**
 * The private flag of the engine switch (stage 1): only a browser that holds the owner's cookie is sent to the engine; everyone else gets the site exactly as before. The cookie is
 * a keyed hash of a fixed label under ENGINE_PRIVATE_KEY (an owner-held secret, set in the server's environment); the key is never the cookie, and with no key configured the flag does not
 * exist (every engine route answers 404). The route that sets the cookie takes the key once, in a link only the owner has.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const ENGINE_COOKIE = "nibrs_engine";
const LABEL = "nibrs-engine-private-v1";

export function engineCookieValue(env: Record<string, string | undefined> = process.env): string | null {
  const key = env.ENGINE_PRIVATE_KEY;
  if (!key || key.length < 16) return null;
  return createHmac("sha256", key).update(LABEL).digest("hex");
}

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** True when the cookie value is the one the configured key gives. */
export function isEnginePrivate(cookie: string | undefined | null, env: Record<string, string | undefined> = process.env): boolean {
  const want = engineCookieValue(env);
  return !!want && typeof cookie === "string" && same(cookie, want);
}

/** True when the link's key is the configured key (the one-time link that sets the cookie). */
export function isEngineKey(given: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const key = env.ENGINE_PRIVATE_KEY;
  return !!key && key.length >= 16 && typeof given === "string" && same(given, key);
}
