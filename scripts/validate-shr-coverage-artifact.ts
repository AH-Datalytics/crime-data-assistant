import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";

const artifactPath = process.argv[2];
if (!artifactPath || !fs.existsSync(artifactPath)) {
  throw new Error("Usage: npx tsx scripts/validate-shr-coverage-artifact.ts PATH");
}

const db = new Database(artifactPath, { readonly: true });
try {
  const integrity = db.pragma("quick_check") as Array<{ quick_check: string }>;
  assert.deepEqual(integrity, [{ quick_check: "ok" }]);

  const invariants = db.prepare(`
    SELECT
      SUM(CASE WHEN shr_victims > 0 AND display_value IS NULL THEN 1 ELSE 0 END) AS positive_hidden,
      SUM(CASE WHEN display_value = 0 AND display_status <> 'validated_zero' THEN 1 ELSE 0 END) AS invalid_zero,
      SUM(CASE WHEN shr_victims = 0 AND comparison_status = 'pre2021_matched' THEN 1 ELSE 0 END) AS zero_matched
    FROM shr_return_a_comparison
  `).get() as { positive_hidden: number; invalid_zero: number; zero_matched: number };
  assert.deepEqual(invariants, { positive_hidden: 0, invalid_zero: 0, zero_matched: 0 });

  const comparisonStatuses = db.prepare(`
    SELECT comparison_status AS status, COUNT(*) AS rows,
           SUM(CASE WHEN shr_victims > 0 THEN 1 ELSE 0 END) AS positive_rows,
           SUM(shr_victims) AS victims
    FROM shr_return_a_comparison
    GROUP BY comparison_status ORDER BY rows DESC
  `).all();
  const displayStatuses = db.prepare(`
    SELECT display_status AS status, COUNT(*) AS rows, SUM(shr_victims) AS victims
    FROM shr_return_a_comparison
    GROUP BY display_status ORDER BY rows DESC
  `).all();
  const chicago = db.prepare(`
    SELECT c.year, c.shr_victims, c.display_value, c.display_status,
           c.caveat_code, c.comparison_status, c.months_with_records
    FROM shr_return_a_comparison c
    JOIN shr_agency_identity a ON a.ori = c.shr_ori AND a.state = c.state
    WHERE a.canonical_agency LIKE '%Chicago%' AND c.year BETWEEN 2022 AND 2024
    ORDER BY c.year
  `).all();

  console.log(JSON.stringify({ artifactPath, integrity: "ok", invariants, comparisonStatuses, displayStatuses, chicago }));
} finally {
  db.close();
}
