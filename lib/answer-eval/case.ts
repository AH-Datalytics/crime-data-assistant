/**
 * The labeled interaction set (spec: docs/superpowers/specs/2026-10-28-answer-eval-labeled-set.md): what a
 * professional answer to each question is, labeled independently of any candidate's output. A case expects one of
 * three actions (answer, ask, decline) and the exact meaning behind it. The runner compares a candidate against it.
 */
import { z } from "zod";

export const SourceId = z.enum(["nibrs", "rtci", "historical", "shr", "hate_crime"]);
export const Tab = z.enum(["nibrs", "current", "historical", "shr", "hate_crime", "auto"]);

const Place = z.strictObject({
  kind: z.enum(["national", "state", "agency", "city", "county"]),
  name: z.string().min(1),          // "United States", "Texas", "Houston Police Department", "Cook County"
  state: z.string().regex(/^[A-Z]{2}$/).optional(),
});

/** The exact meaning of an answer, in source-neutral terms the runner maps a candidate's plan onto. */
export const Meaning = z.strictObject({
  source: SourceId,
  places: z.array(Place).min(1),
  combine: z.enum(["separate", "combined"]).optional(),
  /** Months inclusive, or a named rule whose months depend on the release ("latest complete year"). */
  period: z.union([z.strictObject({ from: z.string().regex(/^\d{4}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}$/) }), z.strictObject({ rule: z.string().min(1) })]),
  measures: z.array(z.strictObject({ name: z.string().min(1), unit: z.string().min(1) })).min(1),
  filters: z.array(z.string()),
  groupings: z.array(z.string()),
  statistic: z.enum(["count", "rate", "share", "ratio", "average", "median", "change", "rank", "list"]),
  denominator: z.string().optional(),
  cohort: z.enum(["all_reporting", "same_agencies", "source_sample"]).optional(),
  rank: z.strictObject({ by: z.string(), direction: z.enum(["top", "bottom"]), limit: z.number().int().positive().nullable() }).optional(),
});

const Option = z.strictObject({
  label: z.string().min(1),
  /**
   * What clicking it must do: the original question with this choice filled in (never asked again). "clarify" when
   * the question is still missing another part (D31 asks one part at a time): `next_about` names that part, and
   * `meaning` is null until it is answered.
   */
  leads_to: z.enum(["answer", "decline", "clarify"]),
  meaning: Meaning.nullable(),
  next_about: z.string().min(1).optional(),
});

export const Expected = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("answer"),
    meaning: Meaning,
    /** Independent expected numbers, or why there are none yet. */
    values: z.strictObject({
      status: z.enum(["verified", "pending_build", "not_checkable"]),
      source: z.string().optional(),     // where the verified values come from (a correctness case, an archive extract)
      cells: z.array(z.strictObject({ key: z.record(z.string(), z.union([z.string(), z.number()])), value: z.number().nullable() })).optional(),
    }),
    /** Sentences the answer must carry (gist), e.g. "names the sheriff's agency", "names the months covered". */
    statements: z.array(z.string()).default([]),
  }),
  z.strictObject({
    action: z.literal("clarify"),
    about: z.string().min(1),
    options: z.array(Option).min(2),
  }),
  z.strictObject({
    action: z.literal("decline"),
    /** The truthful reason, in plain words. */
    reason: z.string().min(1),
    /** The nearest answerable question the app offers (it must be runnable), or null when none genuinely exists. */
    alternative: Meaning.nullable(),
  }),
]);

export const Case = z.strictObject({
  id: z.string().regex(/^LS-\d{3}$/),
  /** Paraphrases and turns of one conversation share a group, so a split never separates them. */
  group: z.string().min(1),
  split: z.enum(["dev", "heldout"]),
  origin: z.strictObject({ kind: z.enum(["gold", "replay", "designed"]), ref: z.string().nullable() }),
  tab: Tab,
  /** Earlier turns, unscored; a failed setup makes the case inconclusive. */
  setup: z.array(z.strictObject({ question: z.string().min(1), tab: Tab })),
  question: z.string().min(1),
  /**
   * P69 (increment 7b): a follow-up's rewrite, from the last setup turn and the question: the one standalone question the
   * app shows above its answer (editable) and then answers; null when the rewrite is uncertain and the app asks instead.
   * For a presentation-only turn ("make it a bar chart") it is the retained data question, shown as the caption and not
   * submitted again. Absent for a question that is not a follow-up.
   */
  rewrite: z.string().min(1).nullable().optional(),
  /** A button press answering an earlier case's clarifying question. */
  button: z.strictObject({ answers: z.string().regex(/^LS-\d{3}$/), option: z.string().min(1) }).optional(),
  /** Policy rows the expectation depends on (docs/policy/nibrsai-answer-policy.csv). An open row leaves it unscored. */
  policy: z.array(z.string().regex(/^[PD]\d{2}$/)),
  expected: Expected.nullable(),
  label: z.strictObject({
    status: z.enum(["unlabeled", "drafted", "reviewed", "unresolved"]),
    drafted_by: z.string().nullable(),
    reviewed_by: z.string().nullable(),
    notes: z.string(),
  }),
});

export type Case = z.infer<typeof Case>;
export type Meaning = z.infer<typeof Meaning>;

/** A case is scored only when its label is reviewed and every policy row it depends on is decided. */
export function scorable(c: Case, openPolicy: Set<string>): { scored: boolean; why?: string } {
  if (c.label.status !== "reviewed" || !c.expected) return { scored: false, why: `label ${c.label.status}` };
  const open = c.policy.filter((p) => openPolicy.has(p));
  return open.length ? { scored: false, why: `waits on policy ${open.join(", ")}` } : { scored: true };
}
