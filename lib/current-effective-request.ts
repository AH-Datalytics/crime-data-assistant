/**
 * Stage 3a, plan r1.1 F5: ONE function decides a follow-up's effective request for the Current/Historical route, so the
 * request-accounting ledger (computed early) and the model-path guardrails (route, "Step 1") read the same request and
 * cannot disagree. The precedence is the route's existing one, unchanged:
 *   1. the authoritative follow-up planner's reconstruction;
 *   2. a recognized follow-up transform (`detectFollowupTransform`);
 *   3. a composed Current amendment (GC-070, `resolveCurrentFollowupAmendment`);
 *   4. the cross-source continuation transform;
 *   5. the question as typed.
 * The question used is the reconstruction (1), else the chosen transform's `contextQuestion`, else the question as typed.
 */
import { normalizeHistoryForTab } from "./chat-history";
import { detectFollowupTransform, type FollowupTransform } from "./followup-transform";
import { buildCrossSourceFollowupTransform } from "./cross-source-followup";
import type { resolveCurrentFollowupAmendment } from "./current-followup-amendment";

export type FollowupResolver = "planner" | "transform" | "amendment" | "cross-source" | null;
type AmendmentTransform = Extract<ReturnType<typeof resolveCurrentFollowupAmendment>, { kind: "composed" }>["transform"];
export type FollowupResolution = { transform: FollowupTransform | AmendmentTransform | null; question: string; resolver: FollowupResolver };

export function resolveFollowupRequest(opts: {
  question: string;
  rawHistory: unknown;
  source: "current" | "historical";
  /** The planner's plan, only when the planner is authoritative and the plan is query-bearing. */
  authoritative: { reconstructedQuestion: string; transform: FollowupTransform | null } | null;
  amendment: ReturnType<typeof resolveCurrentFollowupAmendment>;
}): FollowupResolution {
  if (opts.authoritative) return { transform: opts.authoritative.transform, question: opts.authoritative.reconstructedQuestion, resolver: "planner" };
  const history = normalizeHistoryForTab(opts.rawHistory, opts.source);
  const detected = detectFollowupTransform(opts.question, history);
  if (detected) return { transform: detected, question: detected.contextQuestion ?? opts.question, resolver: "transform" };
  const composed = opts.amendment.kind === "composed" ? opts.amendment.transform : null;
  if (composed) return { transform: composed, question: composed.contextQuestion ?? opts.question, resolver: "amendment" };
  const cross = buildCrossSourceFollowupTransform(opts.question, opts.rawHistory, opts.source);
  if (cross) return { transform: cross, question: cross.contextQuestion ?? opts.question, resolver: "cross-source" };
  return { transform: null, question: opts.question, resolver: null };
}
