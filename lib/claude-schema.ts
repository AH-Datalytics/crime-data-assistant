import { z } from "zod";

/**
 * Zod schema for Claude's JSON response.
 * Validates and coerces the parsed JSON into a safe shape.
 * Fields are capped at reasonable lengths to prevent prompt injection.
 */

const MAX_SQL_LENGTH = 4000;
const MAX_EXPLANATION_LENGTH = 4000;
const MAX_TITLE_LENGTH = 200;
const MAX_AXIS_LENGTH = 200;
const MAX_LABEL_LENGTH = 200;

const annotationSchema = z.object({
  axis: z.enum(["x", "y"]),
  value: z.union([z.string(), z.number()]),
  label: z.string().max(MAX_LABEL_LENGTH).optional(),
  color: z.string().max(20).optional(),
});

export const claudeResponseSchema = z.object({
  sql: z.string().max(MAX_SQL_LENGTH).nullable(),
  explanation: z.string().max(MAX_EXPLANATION_LENGTH),
  chartHint: z.enum(["bar", "line", "pie", "stacked_bar", "scatter", "none"]).catch("none"),
  xAxis: z.string().max(MAX_AXIS_LENGTH).catch(""),
  yAxis: z.string().max(MAX_AXIS_LENGTH).catch(""),
  title: z.string().max(MAX_TITLE_LENGTH).catch(""),
  colors: z.array(z.string().max(20)).max(20).optional(),
  yAxisLabel: z.string().max(MAX_LABEL_LENGTH).optional(),
  xAxisLabel: z.string().max(MAX_LABEL_LENGTH).optional(),
  annotations: z.array(annotationSchema).max(10).optional(),
});

export type ValidatedClaudeResponse = z.infer<typeof claudeResponseSchema>;

/**
 * Validate a parsed JSON object against the ClaudeResponse schema.
 * Returns the validated/coerced object, or null if validation fails.
 */
export function validateClaudeResponse(
  parsed: unknown
): ValidatedClaudeResponse | null {
  const result = claudeResponseSchema.safeParse(parsed);
  if (result.success) return result.data;
  console.warn("[claude-schema] Validation failed:", result.error.issues.map(i => `${i.path}: ${i.message}`).join(", "));
  return null;
}
