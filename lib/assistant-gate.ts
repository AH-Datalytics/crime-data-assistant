import { previewEnabled } from "@/lib/nibrs-shadow/preview";

/**
 * Whether /assistant and /api/assistant-query are served. Same gate as the other preview routes (never on a production
 * build), unless ASSISTANT_PUBLIC_PREVIEW=1 is set on the process: the opt-in for the shared host's /redesign beta.
 * /preview and /api/nibrs-shadow-query do not use this and stay gated.
 */
export function assistantEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return previewEnabled(env.ASSISTANT_PUBLIC_PREVIEW === "1" ? { ...env, NODE_ENV: "development" } : env);
}
