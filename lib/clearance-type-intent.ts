/**
 * Recognize requests for clearance-method categories (arrest, exceptional
 * reasons, and uncleared), including an offense phrase between "clearance"
 * and "by type".
 *
 * Keep this shared: routing, capability checks, contract enforcement, and the
 * deterministic builder must agree or a correctly routed request can still
 * fall through to an unsafe model query.
 */
export function asksClearanceTypeBreakdown(question: string): boolean {
  const q = question.trim();
  if (/\bcleared?\s+by\s*(?:arrest|exception(?:al)?)/i.test(q) ||
      /\b(?:arrest|exception(?:al)?)\s*(?:clearance|means)/i.test(q) ||
      /\bexception(?:al)?\s*(?:clearance|clear)/i.test(q) ||
      /\bclearance\s+types?\b/i.test(q) ||
      /\btypes?\s+of\s+clearance\b/i.test(q) ||
      /\bprosecution\s*(?:declined|refused)/i.test(q)) {
    return true;
  }

  // "clearance rates for crimes by type" asks for offense categories, not
  // clearance methods. Exclude rate/percent immediately after "clearance".
  return /\bclearances?\b(?!\s+(?:rates?|percent(?:age)?s?|pct\b))[^?!.;]{0,80}\bby\s+(?:the\s+)?(?:clearance\s+)?types?\b/i.test(q);
}
