/**
 * One-time replay of logged Historical queries through the reliability disclosure
 * matcher -- Codex's replacement for a week of passive observation before deploying
 * the user-facing caveat.
 *
 * For every logged historical-tab query that produced SQL, re-execute that SQL
 * readonly against the crime database (with the reliability table built) and ask the
 * matcher whether the answer would now carry a caveat. Reports the hit rate, which
 * agencies and offences fire, and every distinct note text for eyeballing.
 *
 * Usage: npx tsx scripts/replay-reliability-disclosures.ts <query_log.db> [crime_data.db]
 * Not part of npm test.
 */
import Database from "better-sqlite3";
import { reliabilityDisclosureNote } from "../lib/reliability-disclosure";

const logPath = process.argv[2];
const dbPath = process.argv[3] || process.env.RTCI_DB_PATH || "crime_data.db";
if (!logPath) {
  console.error("usage: npx tsx scripts/replay-reliability-disclosures.ts <query_log.db> [crime_data.db]");
  process.exit(1);
}

const logDb = new Database(logPath, { readonly: true });
const db = new Database(dbPath, { readonly: true });

const logged = logDb.prepare(`
  SELECT id, ts, question, sql FROM query_log
  WHERE tab = 'historical' AND sql IS NOT NULL AND sql != ''
  ORDER BY id
`).all() as { id: number; ts: string; question: string; sql: string }[];

let replayed = 0, failed = 0, caveated = 0;
const notes = new Map<string, { count: number; sample: string; firstTs: string }>();

for (const entry of logged) {
  let rows: Record<string, unknown>[];
  try {
    // Readonly connection; cap rows the same way the route caps display rows.
    rows = db.prepare(entry.sql).all().slice(0, 500) as Record<string, unknown>[];
  } catch {
    failed += 1; // schema drift in old logged SQL is expected; skip, count, move on
    continue;
  }
  replayed += 1;
  let note: string | null = null;
  try {
    note = reliabilityDisclosureNote(db, entry.question, entry.sql, rows, "historical");
  } catch (err) {
    console.error(`  matcher threw on #${entry.id}: ${String(err).slice(0, 120)}`);
    continue;
  }
  if (note) {
    caveated += 1;
    const existing = notes.get(note);
    if (existing) existing.count += 1;
    else notes.set(note, { count: 1, sample: entry.question.slice(0, 90), firstTs: entry.ts });
  }
}

console.log(`\n[replay] logged historical queries with SQL: ${logged.length}`);
console.log(`[replay] re-executed cleanly: ${replayed}   (failed to execute: ${failed} -- old SQL vs current schema, expected)`);
console.log(`[replay] would now carry a reliability caveat: ${caveated} (${(100 * caveated / Math.max(1, replayed)).toFixed(1)}% of replayed)`);
console.log(`[replay] distinct note texts: ${notes.size}\n`);
for (const [note, meta] of [...notes.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  x${String(meta.count).padEnd(4)} ${note}`);
  console.log(`        e.g. "${meta.sample}" (first: ${meta.firstTs})`);
}
logDb.close();
db.close();
