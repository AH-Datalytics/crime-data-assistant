/**
 * Linear-time text sanitization helpers.
 *
 * These replace regex patterns like /```[\s\S]*?```/ and /\{[\s\S]*"sql"[\s\S]*\}/
 * that cause catastrophic backtracking on long model output (especially Sonnet's
 * 500-2000 char explanations vs Haiku's ~200 char).
 *
 * Every function here is O(n) worst-case — no regex backtracking.
 */

/**
 * Remove all markdown code fences and their contents.
 * Handles unclosed fences by removing from the opening ``` to end of string.
 * Uses array-of-chunks + join instead of repeated slice+concat.
 */
export function removeCodeFences(text: string): string {
  const chunks: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    const openIdx = text.indexOf("```", pos);
    if (openIdx === -1) {
      chunks.push(text.slice(pos));
      break;
    }
    // Keep everything before the opening fence
    chunks.push(text.slice(pos, openIdx));

    const closeIdx = text.indexOf("```", openIdx + 3);
    if (closeIdx === -1) {
      // Unclosed fence — drop from here to end
      break;
    }
    // Skip past the closing fence
    pos = closeIdx + 3;
  }

  return chunks.join("");
}

/**
 * Extract content from markdown code fences (for JSON parsing).
 * Returns array of trimmed inner strings from each ```...``` block.
 * Skips optional "json" language tag after opening fence.
 */
export function extractCodeFenceCandidates(text: string): string[] {
  const candidates: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    const openIdx = text.indexOf("```", pos);
    if (openIdx === -1) break;

    let contentStart = openIdx + 3;
    // Skip optional "json" tag and any whitespace/newline before content
    const tagSlice = text.slice(contentStart, contentStart + 10);
    const tagMatch = tagSlice.match(/^json\s*|^\s*/);
    if (tagMatch) contentStart += tagMatch[0].length;

    const closeIdx = text.indexOf("```", contentStart);
    if (closeIdx === -1) break;

    const inner = text.slice(contentStart, closeIdx).trim();
    if (inner.length > 0) candidates.push(inner);

    pos = closeIdx + 3;
  }

  return candidates;
}

/**
 * Remove JSON-like blocks that contain a "sql" key.
 * Linear scan: walk character by character tracking brace depth.
 * Only removes top-level {...} blocks where "sql" appears between
 * the opening and closing brace. O(n) worst-case.
 *
 * Note: because this uses depth-aware brace matching, nested objects
 * like {"outer":{"sql":"..."}} ARE removed (the whole outer block).
 * That's the right behavior for user-facing cleanup — we never want
 * to show raw JSON with SQL to the user.
 */
export function removeJsonWithSqlKey(text: string): string {
  const chunks: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    const braceIdx = text.indexOf("{", pos);
    if (braceIdx === -1) {
      chunks.push(text.slice(pos));
      break;
    }

    // Find the matching closing brace (depth-aware)
    let depth = 1;
    let i = braceIdx + 1;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }

    if (depth > 0) {
      // Unclosed brace — no match possible, keep everything
      chunks.push(text.slice(pos));
      break;
    }

    // i is now one past the closing brace
    const block = text.slice(braceIdx, i);
    if (block.includes('"sql"')) {
      // Remove this block — keep text before it
      chunks.push(text.slice(pos, braceIdx));
    } else {
      // Keep the block
      chunks.push(text.slice(pos, i));
    }
    pos = i;
  }

  return chunks.join("");
}
