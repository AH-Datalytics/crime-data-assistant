/**
 * Historical national rape fix: the delivered disclosures and the one-snapshot correction state, written BEFORE the code
 * (preregistered in audit/historical-national-rape-fix-2026-10-13/; plan r4 + Codex clarifications).
 *
 *   T1 readCorrectionState: no marker table -> false; marker + 2018 = 144505 -> true; marker + 2018 wrong -> false
 *   T2 executeWithCorrectionState: ONE many-statement read carrying the answer SQL and the state statements, split back into
 *      rows and state; real runs on a corrected and an uncorrected fixture
 *   T3 N1 (rape-count series on historical_state_national crossing 2016/2017): present when corrected; today's exact text when
 *      not; 2010-2015 -> today's text; agency series -> unchanged
 *   T4 N2 (national violent composite crossing 2016/2017): present when corrected; absent when not; 2018-2020, 1990-2016 absent
 *   T5 N3 (2021): national rape 2020-2022 and a 2021 single year -> present; 2017-2019 -> absent; not corrected -> absent;
 *      composite 2020-2022 -> present
 *   T6 idempotent: twice -> one copy; a text carrying a note in an uncorrected state is stripped of it
 *   T7 the Historical cache data version differs between the two states; other tabs are not given one
 *   T8 applyResultDisclosures: with the input it applies the notes; without it the output is byte-identical
 *
 * Run: npx tsx scripts/test-historical-national-rape.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  N1_STATE_NATIONAL_DEFINITION, N2_COMPOSITE_DEFINITION, N3_2021_LIMITATION, CORRECTION_STATE_SQL,
  readCorrectionState, executeWithCorrectionState, withHistoricalNationalRapeNotes, historicalCacheValidity,
} from "../lib/historical-national-rape";
import { applyResultDisclosures } from "../lib/result-disclosure";
import { cacheValiditySignature } from "../lib/proof-cache-validity";

let passed = 0, failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL  ${name} -- ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hnr-ts-"));
function fixture(name: string, opts: { marker: boolean; rape2018: number }): string {
  const file = path.join(tmp, `${name}.db`);
  const db = new Database(file);
  db.exec("CREATE TABLE historical_state_national (state TEXT, year INTEGER, population INTEGER, rape INTEGER, PRIMARY KEY (state, year))");
  db.prepare("INSERT INTO historical_state_national VALUES ('United States', 2018, 327167434, ?)").run(opts.rape2018);
  db.prepare("INSERT INTO historical_state_national VALUES ('United States', 2017, 325719178, 136646)").run();
  if (opts.marker) {
    db.exec("CREATE TABLE historical_national_rape_correction (name TEXT PRIMARY KEY, applied_at TEXT, source_sha256 TEXT, years TEXT)");
    db.prepare("INSERT INTO historical_national_rape_correction VALUES ('national-rape-cius-t1-2017-2024', 'now', '551f29bd', '2017-2024')").run();
  }
  db.close();
  return file;
}

const corrected = fixture("corrected", { marker: true, rape2018: 144505 });
const uncorrected = fixture("uncorrected", { marker: false, rape2018: 103321 });
const wrongValue = fixture("wrong", { marker: true, rape2018: 103321 });

check("T1: no marker table -> false", () => assert.equal(readCorrectionState(new Database(uncorrected, { readonly: true })), false));
check("T1: marker + 2018 = 144505 -> true", () => assert.equal(readCorrectionState(new Database(corrected, { readonly: true })), true));
check("T1: marker + 2018 wrong -> false", () => assert.equal(readCorrectionState(new Database(wrongValue, { readonly: true })), false));

check("T2: one many-statement read carries the answer SQL and the state statements", () => {
  const calls: string[][] = [];
  const db = new Database(corrected, { readonly: true });
  const answer = "SELECT year, rape FROM historical_state_national WHERE state = 'United States' ORDER BY year";
  const out = executeWithCorrectionState(db, answer, 30000, {
    executeMany: (_db, statements) => {
      calls.push(statements);
      return statements.map((s) => db.prepare(s).all() as Record<string, unknown>[]);
    },
  });
  assert.equal(calls.length, 1, `executeMany called ${calls.length} times`);
  assert.deepEqual(calls[0], [answer, ...CORRECTION_STATE_SQL]);
  assert.equal(out.corrected, true);
  assert.deepEqual(out.rows.map((r) => r.year), [2017, 2018]);
});
check("T2: real run on the corrected fixture -> rows and true", () => {
  const db = new Database(corrected, { readonly: true });
  const out = executeWithCorrectionState(db, "SELECT year, rape FROM historical_state_national ORDER BY year");
  assert.equal(out.corrected, true);
  assert.equal(out.rows.length, 2);
});
check("T2: real run on the uncorrected fixture -> rows and false", () => {
  const db = new Database(uncorrected, { readonly: true });
  const out = executeWithCorrectionState(db, "SELECT year, rape FROM historical_state_national ORDER BY year");
  assert.equal(out.corrected, false);
  assert.equal(out.rows.length, 2);
});

const series = (from: number, to: number, extra: Record<string, unknown> = {}) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ year: from + i, rape: 100000 + i, ...extra }));
const NAT_RAPE = (from: number, to: number) =>
  `SELECT year, rape FROM historical_state_national WHERE state = 'United States' AND year BETWEEN ${from} AND ${to} ORDER BY year`;
const STATE_RAPE = "SELECT year, rape FROM historical_state_national WHERE state = 'Texas' AND year BETWEEN 2015 AND 2019 ORDER BY year";
const AGENCY_RAPE = "SELECT hac.year, hac.rape FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = 'Chicago' AND hac.year BETWEEN 2015 AND 2019 ORDER BY hac.year";
const COMPOSITE = (from: number, to: number) =>
  `SELECT year, murder + rape + robbery + aggravated_assault AS violent FROM historical_state_national WHERE state = 'United States' AND year BETWEEN ${from} AND ${to} ORDER BY year`;
const compRows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ year: from + i, violent: 1200000 + i }));
const BASE = "Model text.";

check("T3: N1 on a national 2016-2019 rape series when corrected", () =>
  assert.ok(withHistoricalNationalRapeNotes(BASE, NAT_RAPE(2016, 2019), series(2016, 2019), true).includes(N1_STATE_NATIONAL_DEFINITION)));
check("T3: N1 on a state 2015-2019 rape series when corrected", () =>
  assert.ok(withHistoricalNationalRapeNotes(BASE, STATE_RAPE, series(2015, 2019), true).includes(N1_STATE_NATIONAL_DEFINITION)));
check("T3: not corrected -> today's exact text", () =>
  assert.equal(withHistoricalNationalRapeNotes(BASE, NAT_RAPE(2016, 2019), series(2016, 2019), false), BASE));
check("T3: 2010-2015 -> today's text", () =>
  assert.equal(withHistoricalNationalRapeNotes(BASE, NAT_RAPE(2010, 2015), series(2010, 2015), true), BASE));
check("T3: agency series -> unchanged", () =>
  assert.equal(withHistoricalNationalRapeNotes(BASE, AGENCY_RAPE, series(2015, 2019), true), BASE));

check("T4: N2 on the composite 2016-2018 when corrected", () =>
  assert.ok(withHistoricalNationalRapeNotes(BASE, COMPOSITE(2016, 2018), compRows(2016, 2018), true).includes(N2_COMPOSITE_DEFINITION)));
check("T4: composite 2016-2018 not corrected -> absent", () =>
  assert.equal(withHistoricalNationalRapeNotes(BASE, COMPOSITE(2016, 2018), compRows(2016, 2018), false), BASE));
check("T4: composite 2018-2020 -> no N2", () =>
  assert.ok(!withHistoricalNationalRapeNotes(BASE, COMPOSITE(2018, 2020), compRows(2018, 2020), true).includes(N2_COMPOSITE_DEFINITION)));
check("T4: composite 1990-2016 -> absent", () =>
  assert.equal(withHistoricalNationalRapeNotes(BASE, COMPOSITE(1990, 2016), compRows(1990, 2016), true), BASE));

check("T5: N3 on national rape 2020-2022 when corrected", () =>
  assert.ok(withHistoricalNationalRapeNotes(BASE, NAT_RAPE(2020, 2022), series(2020, 2022), true).includes(N3_2021_LIMITATION)));
check("T5: N3 on a national 2021 single year when corrected", () =>
  assert.ok(withHistoricalNationalRapeNotes(BASE, NAT_RAPE(2021, 2021), series(2021, 2021), true).includes(N3_2021_LIMITATION)));
check("T5: national rape 2017-2019 -> no N3", () =>
  assert.ok(!withHistoricalNationalRapeNotes(BASE, NAT_RAPE(2017, 2019), series(2017, 2019), true).includes(N3_2021_LIMITATION)));
check("T5: national rape 2020-2022 not corrected -> absent", () =>
  assert.equal(withHistoricalNationalRapeNotes(BASE, NAT_RAPE(2020, 2022), series(2020, 2022), false), BASE));
check("T5: composite 2020-2022 when corrected -> N3", () =>
  assert.ok(withHistoricalNationalRapeNotes(BASE, COMPOSITE(2020, 2022), compRows(2020, 2022), true).includes(N3_2021_LIMITATION)));
check("T5: a state series 2020-2022 -> no N3 (national only)", () =>
  assert.ok(!withHistoricalNationalRapeNotes(BASE, STATE_RAPE.replace("2015 AND 2019", "2020 AND 2022"), series(2020, 2022), true).includes(N3_2021_LIMITATION)));

check("T6: applying twice gives one copy of each note", () => {
  const once = withHistoricalNationalRapeNotes(BASE, NAT_RAPE(2016, 2022), series(2016, 2022), true);
  const twice = withHistoricalNationalRapeNotes(once, NAT_RAPE(2016, 2022), series(2016, 2022), true);
  assert.equal(twice, once);
  assert.equal(twice.split(N1_STATE_NATIONAL_DEFINITION).length, 2);
  assert.equal(twice.split(N3_2021_LIMITATION).length, 2);
});
check("T6: a text carrying the notes in an uncorrected state is stripped of them", () => {
  const withNotes = withHistoricalNationalRapeNotes(BASE, NAT_RAPE(2016, 2022), series(2016, 2022), true);
  assert.equal(withHistoricalNationalRapeNotes(withNotes, NAT_RAPE(2016, 2022), series(2016, 2022), false), BASE);
});

// Amendment 3: the key keeps today's signature while uncorrected (in every proof mode) and adds a mode-independent suffix
// once corrected.
check("T7: uncorrected = base exactly (base undefined, as in off mode today)", () => {
  const base = cacheValiditySignature("historical", null, {});
  assert.equal(base, undefined);
  assert.equal(historicalCacheValidity(base, false), base);
});
check("T7: uncorrected = base exactly (base defined)", () => assert.equal(historicalCacheValidity("p1|c:abc|d:unknown", false), "p1|c:abc|d:unknown"));
check("T7: corrected differs from uncorrected", () => {
  const base = cacheValiditySignature("historical", null, {});
  assert.notEqual(historicalCacheValidity(base, true), historicalCacheValidity(base, false));
});
check("T7: the corrected key is the same under off and shadow (invariant 14)", () => {
  const off = cacheValiditySignature("historical", null, { PROOF_MODE: "off" });
  const shadow = cacheValiditySignature("historical", null, { PROOF_MODE: "shadow" });
  assert.equal(off, shadow, "the base itself must already agree between off and shadow");
  assert.equal(historicalCacheValidity(off, true), historicalCacheValidity(shadow, true));
});

check("T8: applyResultDisclosures applies the notes with the input", () => {
  const out = applyResultDisclosures({ explanation: BASE, question: "national rapes 2016 to 2019", sql: NAT_RAPE(2016, 2019), rows: series(2016, 2019), tab: "historical", historicalNationalRapeCorrected: true });
  assert.ok(out.includes(N1_STATE_NATIONAL_DEFINITION));
});
check("T8: without the input the output is byte-identical to the input-free call", () => {
  const args = { explanation: BASE, question: "national rapes 2016 to 2019", sql: NAT_RAPE(2016, 2019), rows: series(2016, 2019), tab: "historical" };
  const plain = applyResultDisclosures(args);
  assert.ok(!plain.includes(N1_STATE_NATIONAL_DEFINITION));
  assert.equal(applyResultDisclosures({ ...args, historicalNationalRapeCorrected: undefined }), plain);
});

console.log(`\nhistorical national rape: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
