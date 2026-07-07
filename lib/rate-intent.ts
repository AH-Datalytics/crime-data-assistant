export function asksForCountsInsteadOfRates(question: string): boolean {
  return /\b(?:numbers?|counts?|raw\s+(?:numbers?|counts?))\b[\s\S]{0,80}\b(?:instead\s+of|not|rather\s+than)\s+(?:a\s+)?rates?\b/i.test(question) ||
    /\b(?:instead\s+of|not|rather\s+than)\s+(?:a\s+)?rates?\b[\s\S]{0,80}\b(?:numbers?|counts?|raw\s+(?:numbers?|counts?))\b/i.test(question) ||
    /\bcounts?\s*,?\s*not\s+rates?\b/i.test(question) ||
    /\bnot\s+rates?\s*,?\s*(?:just\s+)?(?:numbers?|counts?)\b/i.test(question);
}

