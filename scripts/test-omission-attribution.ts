/**
 * Omission attribution (handoff §7) and the §13 tests for it.
 *
 * THE ASYMMETRY UNDER TEST. "Jacksonville is not in this source" is a factual
 * claim about the FBI's data; "I can't include Jacksonville through this
 * comparison path" is a claim about our product. §2.4 permits the first only when
 * "a deterministic attribution probe established that fact". So the central
 * assertions here are negative ones: with no database, no probe, or a failed
 * probe, the result must NOT be a source-attributable reason — it must be
 * `unknown` or `capability_path_unavailable`.
 *
 * §7 also requires batching: "batch or cache deterministic probes rather than
 * issuing one uncached database query per omission." A 32-city comparison missing
 * 8 cities must not become 8 round trips inside a 50 ms budget, so probesRun is
 * asserted directly.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { attributeOmissions, type OmittedCandidate } from "../lib/omission-attribution";
import { isSourceAttributable, SOURCE_ATTRIBUTABLE_OMISSION_REASONS } from "../lib/proof-contract";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}\n        ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

/** A production-shaped agency_monthly fixture. */
function makeCurrentDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omission-"));
  const db = new Database(path.join(dir, "crime_data.db"));
  db.exec(`CREATE TABLE agency_monthly (
    ori TEXT, agency TEXT, state TEXT, year INTEGER, month INTEGER, offense TEXT, count INTEGER)`);
  const insert = db.prepare(
    "INSERT INTO agency_monthly (ori, agency, state, year, month, offense, count) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  // Baton Rouge: present, 2019-2023.
  for (const year of [2019, 2020, 2021, 2022, 2023]) {
    insert.run("LA0170000", "Baton Rouge", "LA", year, 6, "Murder", 5);
  }
  // Springfield exists only in IL, so a request for Springfield, MO must not match.
  insert.run("IL0810000", "Springfield", "IL", 2022, 6, "Murder", 2);
  return db;
}

function candidate(overrides: Partial<OmittedCandidate> = {}): OmittedCandidate {
  return {
    entityId: "baton-rouge-la",
    label: "Baton Rouge",
    state: "LA",
    requestedYears: [],
    ...overrides,
  };
}

console.log("\nno probe capability means no source claim");
{
  check("a null database yields unknown, never not_in_source", () => {
    // The single most important assertion in this file. Without a probe we know
    // nothing, and §7 forbids turning that into a claim about the source.
    const result = attributeOmissions([candidate({ label: "Nowhere City" })], {
      sourceId: "current",
      db: null,
      sourceYearRange: null,
      sourceHealth: "healthy",
    });
    assert.strictEqual(result.omissions[0].reason, "unknown");
    assert.strictEqual(result.omissions[0].evidence, null);
    assert.deepStrictEqual(result.unattributed, ["baton-rouge-la"]);
    assert.strictEqual(result.probesRun, 0, "no database means no probe was run");
  });

  check("an unmapped source yields unknown", () => {
    // SHR and Hate Crime have no existence probe yet. The safe direction is no
    // source claim, not a guessed one.
    const db = makeCurrentDb();
    const result = attributeOmissions([candidate({ label: "Nowhere City" })], {
      sourceId: "shr",
      db,
      sourceYearRange: null,
      sourceHealth: "healthy",
    });
    db.close();
    assert.strictEqual(result.omissions[0].reason, "unknown");
    assert.strictEqual(result.probesRun, 0);
  });

  check("a probe against a missing table yields unknown, not not_in_source", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omission-empty-"));
    const db = new Database(path.join(dir, "empty.db"));
    const result = attributeOmissions([candidate({ label: "Nowhere City" })], {
      sourceId: "current",
      db,
      sourceYearRange: null,
      sourceHealth: "healthy",
    });
    db.close();
    assert.strictEqual(result.omissions[0].reason, "unknown");
    assert.strictEqual(result.probesRun, 1, "the probe was attempted");
  });

  check("every unknown omission carries no evidence, by definition", () => {
    const result = attributeOmissions([candidate()], {
      sourceId: "current",
      db: null,
      sourceYearRange: null,
      sourceHealth: "healthy",
    });
    for (const omission of result.omissions) {
      if (omission.reason === "unknown") assert.strictEqual(omission.evidence, null);
    }
  });
}

console.log("\nsource-attributable reasons always carry probe evidence");
{
  const db = makeCurrentDb();

  check("a genuinely absent agency is not_in_source WITH evidence", () => {
    const result = attributeOmissions([candidate({ entityId: "nowhere", label: "Nowhere City", state: "LA" })], {
      sourceId: "current",
      db,
      sourceYearRange: null,
      sourceHealth: "healthy",
    });
    const omission = result.omissions[0];
    assert.strictEqual(omission.reason, "not_in_source");
    assert.ok(omission.evidence, "a source claim must carry evidence");
    assert.match(omission.evidence!, /probe: no row in agency_monthly/);
  });

  check("a name present only in another state is not_in_source for the requested state", () => {
    // Answering with another state's agency is worse than omitting it, so this is
    // recorded as absent-for-the-request rather than as a match.
    const result = attributeOmissions([candidate({ entityId: "springfield-mo", label: "Springfield", state: "MO" })], {
      sourceId: "current",
      db,
      sourceYearRange: null,
      sourceHealth: "healthy",
    });
    assert.strictEqual(result.omissions[0].reason, "not_in_source");
    assert.match(result.omissions[0].evidence!, /only in IL, not MO/);
  });

  check("present in source but not for the requested year is nonreporting_period", () => {
    const result = attributeOmissions(
      [candidate({ requestedYears: [2015, 2016] })],
      { sourceId: "current", db, sourceYearRange: null, sourceHealth: "healthy" },
    );
    assert.strictEqual(result.omissions[0].reason, "nonreporting_period");
    assert.match(result.omissions[0].evidence!, /no data for requested year\(s\) 2015, 2016/);
  });

  check("present and in range but absent from the result is a CAPABILITY claim", () => {
    // The honest fallback. The entity exists and the years overlap, so the cause is
    // in our query path -- which must never be phrased as a source limitation.
    const result = attributeOmissions(
      [candidate({ requestedYears: [2021] })],
      { sourceId: "current", db, sourceYearRange: null, sourceHealth: "healthy" },
    );
    assert.strictEqual(result.omissions[0].reason, "capability_path_unavailable");
    assert.strictEqual(isSourceAttributable(result.omissions[0].reason), false);
  });

  check("every source-attributable result in this suite had evidence", () => {
    const cases: OmittedCandidate[] = [
      candidate({ entityId: "a", label: "Nowhere City", state: "LA" }),
      candidate({ entityId: "b", label: "Springfield", state: "MO" }),
      candidate({ entityId: "c", requestedYears: [1990] }),
    ];
    const result = attributeOmissions(cases, {
      sourceId: "current",
      db,
      sourceYearRange: null,
      sourceHealth: "healthy",
    });
    for (const omission of result.omissions) {
      if ((SOURCE_ATTRIBUTABLE_OMISSION_REASONS as readonly string[]).includes(omission.reason)) {
        assert.ok(omission.evidence && omission.evidence.trim(), `${omission.reason} had no evidence`);
      }
    }
  });

  db.close();
}

console.log("\nreasons decided without a query");
{
  const db = makeCurrentDb();

  check("a source checked and reported degraded outranks everything else", () => {
    // An entity may be perfectly present in a source we currently cannot trust, so
    // health is answered first and never becomes a claim about the data.
    const result = attributeOmissions([candidate({ label: "Nowhere City" })], {
      sourceId: "current",
      db,
      sourceYearRange: null,
      sourceHealth: "degraded",
    });
    assert.strictEqual(result.omissions[0].reason, "source_unhealthy");
    assert.match(result.omissions[0].evidence!, /health check ran and reported degraded/);
    assert.strictEqual(isSourceAttributable("source_unhealthy"), false);
  });

  check("a consolidated agency is consolidation_mapping from the static table", () => {
    // §13 consolidation cases. Decided from the repository's own table, so its
    // evidence is that entry -- no query needed.
    const result = attributeOmissions(
      [candidate({ entityId: "louisville-ky", label: "Louisville", state: "KY" })],
      { sourceId: "current", db, sourceYearRange: null, sourceHealth: "healthy" },
    );
    assert.strictEqual(result.omissions[0].reason, "consolidation_mapping");
    assert.match(result.omissions[0].evidence!, /agency-consolidations/);
  });

  check("an explicit consolidation exclusion is a capability claim", () => {
    // Jacksonville is on CONSOLIDATION_EXCLUSIONS. §2.4's worked example phrases it
    // as a product limitation: "Jacksonville cannot currently be included through
    // this comparison path; I can run it separately."
    const result = attributeOmissions(
      [candidate({ entityId: "jacksonville-fl", label: "Jacksonville", state: "FL" })],
      { sourceId: "current", db, sourceYearRange: null, sourceHealth: "healthy" },
    );
    assert.strictEqual(result.omissions[0].reason, "capability_path_unavailable");
    assert.match(result.omissions[0].evidence!, /consolidation exclusion/);
  });

  check("a year outside the source's declared range is outside_source_years", () => {
    const result = attributeOmissions(
      [candidate({ entityId: "old", label: "Nowhere City", requestedYears: [1925] })],
      { sourceId: "current", db, sourceYearRange: { min: 2017, max: 2025 }, sourceHealth: "healthy" },
    );
    assert.strictEqual(result.omissions[0].reason, "outside_source_years");
    assert.match(result.omissions[0].evidence!, /covers 2017-2025/);
  });

  check("a partially in-range request is NOT dismissed as outside_source_years", () => {
    // Only when EVERY requested year falls outside. A request spanning the boundary
    // is a limited-scope answer, not an absent entity.
    const result = attributeOmissions(
      [candidate({ entityId: "span", label: "Nowhere City", requestedYears: [2015, 2020] })],
      { sourceId: "current", db, sourceYearRange: { min: 2017, max: 2025 }, sourceHealth: "healthy" },
    );
    assert.notStrictEqual(result.omissions[0].reason, "outside_source_years");
  });

  db.close();
}

console.log("\nbatching");
{
  const db = makeCurrentDb();

  check("32 candidates cost ONE probe, not 32", () => {
    const candidates: OmittedCandidate[] = Array.from({ length: 32 }, (_, i) => ({
      entityId: `city-${i}`,
      label: `City ${i}`,
      state: "LA",
      requestedYears: [],
    }));
    const result = attributeOmissions(candidates, {
      sourceId: "current",
      db,
      sourceYearRange: null,
      sourceHealth: "healthy",
    });
    assert.strictEqual(result.probesRun, 1, "§7 requires batched probes");
    assert.strictEqual(result.omissions.length, 32, "every candidate must be attributed");
  });

  check("an empty candidate list runs no probe at all", () => {
    const result = attributeOmissions([], {
      sourceId: "current",
      db,
      sourceYearRange: null,
      sourceHealth: "healthy",
    });
    assert.deepStrictEqual(result.omissions, []);
    assert.strictEqual(result.probesRun, 0);
  });

  check("batched attribution completes well inside the latency budget", () => {
    // §11 allows <50 ms median for the whole proof step, of which attribution is
    // one part. Generous bound; the point is to catch an accidental per-candidate
    // query, which would show up here as orders of magnitude.
    const candidates: OmittedCandidate[] = Array.from({ length: 32 }, (_, i) => ({
      entityId: `c${i}`,
      label: `City ${i}`,
      state: "LA",
      requestedYears: [2020],
    }));
    const started = Date.now();
    attributeOmissions(candidates, { sourceId: "current", db, sourceYearRange: null, sourceHealth: "healthy" });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 200, `attribution of 32 candidates took ${elapsed}ms`);
  });

  db.close();
}

console.log("\nnever throws on the request path");
{
  check("a closed database degrades to unknown rather than throwing", () => {
    const db = makeCurrentDb();
    db.close();
    let result;
    assert.doesNotThrow(() => {
      result = attributeOmissions([candidate()], {
        sourceId: "current",
        db,
        sourceYearRange: null,
        sourceHealth: "healthy",
      });
    });
    assert.strictEqual(result!.omissions[0].reason, "unknown");
  });

  check("a candidate with an empty label does not throw", () => {
    const db = makeCurrentDb();
    assert.doesNotThrow(() => {
      attributeOmissions([candidate({ label: "", entityId: "" })], {
        sourceId: "current",
        db,
        sourceYearRange: null,
        sourceHealth: "healthy",
      });
    });
    db.close();
  });
}

console.log(`\nomission attribution tests: ${passed} passed`);
if (process.exitCode) {
  console.log("omission attribution tests: FAILED");
} else {
  console.log("omission attribution tests: passed");
}
