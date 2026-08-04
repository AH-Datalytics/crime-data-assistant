const RESOLVED_SUFFIX = "-resolved-on-retry";

export function mergeGuardrailTags(...tagLists: string[][]): string[] {
  return [...new Set(tagLists.flat().filter(Boolean))];
}

export function finalizeGuardrailTags(tags: string[], finalContractTags: string[]): string[] {
  const finalSet = new Set(finalContractTags.filter((tag) => tag.startsWith("contract-")));
  const seenContract = new Set<string>();
  const output: string[] = [];

  for (const rawTag of mergeGuardrailTags(tags)) {
    const baseTag = rawTag.endsWith(RESOLVED_SUFFIX)
      ? rawTag.slice(0, -RESOLVED_SUFFIX.length)
      : rawTag;
    if (!baseTag.startsWith("contract-")) {
      output.push(rawTag);
      continue;
    }
    if (seenContract.has(baseTag)) continue;
    seenContract.add(baseTag);
    output.push(finalSet.has(baseTag) ? baseTag : `${baseTag}${RESOLVED_SUFFIX}`);
  }

  for (const finalTag of finalSet) {
    if (!seenContract.has(finalTag)) output.push(finalTag);
  }
  return mergeGuardrailTags(output);
}