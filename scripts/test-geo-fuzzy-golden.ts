/**
 * The fuzzy place search (lib/geo-fuzzy.ts) answers exactly what it answered before it was made fast: the same candidates, in the same
 * order, with the same distances, for a fixed set of inputs (a sample of the catalog's own aliases, each with a letter dropped and with two
 * letters swapped, and the misspellings of the query log). The expected answers in scripts/fixtures/geo-fuzzy-golden.json were written by
 * the search before the change (`npx tsx scripts/test-geo-fuzzy-golden.ts --write`, only ever run on a version known to be right).
 * No database, no model, no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fuzzyResolvePlace } from "../lib/geo-fuzzy";
import { GEO_PLACE_CATALOG } from "../lib/geo-place-catalog";

const FILE = path.join(process.cwd(), "scripts/fixtures/geo-fuzzy-golden.json");

/** A deterministic input set: every 270th alias with a letter dropped and with two letters swapped, plus named misspellings. */
function inputs(): string[] {
  const out: string[] = ["aleghany", "aleghany county", "anne arundal county", "anne arundal", "prince George county", "prince georges", "wilimington nc", "balitmore", "philadlephia", "san antnio",
    "fontina", "concorde", "lgbtq", "urban areas", "kansass city", "mecklenberg county", "st louis", "louiville", "cincinatti", "jacksonvile"];
  const aliases = GEO_PLACE_CATALOG.flatMap((e) => e.aliases);
  for (let i = 0; i < aliases.length; i += 270) {
    const a = aliases[i];
    if (a.length < 5) continue;
    const k = Math.floor(a.length / 2);
    out.push(a.slice(0, k) + a.slice(k + 1));
    out.push(a.slice(0, k - 1) + a[k] + a[k - 1] + a.slice(k + 1));
  }
  return [...new Set(out)];
}
const view = (text: string) => {
  const r = fuzzyResolvePlace(text);
  return { c: r.candidates.map((x) => [x.entry.id, x.alias, x.distance, Math.round(x.score * 1e6) / 1e6]), b: r.best?.entry.id ?? null, ok: r.confident, ask: r.needsConfirmation };
};

if (process.argv.includes("--write")) {
  const all = Object.fromEntries(inputs().map((t) => [t, view(t)]));
  fs.writeFileSync(FILE, JSON.stringify(all));
  console.log(`wrote ${Object.keys(all).length} expected answers to ${FILE}`);
} else {
  const golden = JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, ReturnType<typeof view>>;
  const names = Object.keys(golden);
  assert.ok(names.length > 500, "the golden set is the sample, not a stub");
  for (const t of names) assert.deepEqual(view(t), golden[t], `fuzzy result for "${t}"`);
  // A second pass (the results are remembered) gives the same again.
  for (const t of names.slice(0, 50)) assert.deepEqual(view(t), golden[t], `remembered result for "${t}"`);
  console.log(`geo fuzzy: ${names.length} inputs give exactly the answers they gave before the search was made fast`);
}
