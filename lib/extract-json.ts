/**
 * Robustly extract a JSON object from Claude's text response.
 *
 * Claude sometimes outputs:
 *   - A bare JSON object (ideal)
 *   - JSON inside ```json ... ``` fences
 *   - Narrative text followed by a revised JSON block
 *   - Multiple JSON blocks (model self-corrects mid-response)
 *
 * Strategy: collect all candidate JSON strings (fenced blocks first,
 * then bare brace-delimited objects), try parsing each from LAST to FIRST
 * (the last block is the model's final/revised answer), return the first
 * that parses successfully.
 */
export function extractJson(text: string): unknown | null {
  const candidates: string[] = [];

  // 1. Collect all ```json ... ``` or ``` ... ``` fenced blocks
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const inner = m[1].trim();
    if (inner.startsWith("{")) candidates.push(inner);
  }

  // 2. Collect all top-level {...} objects using brace depth tracking
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  // 3. Try candidates from last to first (model's final answer wins)
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // not valid JSON, try next
    }
  }

  return null;
}
