/**
 * Shared helpers for detecting and stripping internal scaffold text
 * that leaks from system prompts into user-facing responses.
 *
 * Used by both app/api/query/route.ts and app/api/nibrs-query/route.ts.
 */

const INTERNAL_SCAFFOLD_RE = /\bEntities in results\b/i;

export function containsInternalScaffold(
  value: string | null | undefined
): boolean {
  return INTERNAL_SCAFFOLD_RE.test(value || "");
}

export function stripInternalScaffold(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !INTERNAL_SCAFFOLD_RE.test(line))
    .join("\n")
    .trim();
}
