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
 *   (plan 2026-10-18-stack-typed-historical-rape-notes r2, stage 2a's typed answers:)
 *   T9  the model-path function's outputs are unchanged by the shared rules (pinned texts)
 *   T10 typedRapeNoteSeries: which delivered series are eligible (rape counts; the national violent count AND rate)
 *   T11 typed answers through the compiler, per delivered series: by year, single year, 2021, period total, violent rate,
 *       H6 change, H4 state ranking, a state, uncorrected, idempotent
 *   T12 typedCorrectionState: agreeing states give the state; disagreeing give "changed"; none gives false
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
  typedRapeNoteSeries, withTypedHistoricalRapeNotes, typedCorrectionState, type TypedDeliveredSeries,
} from "../lib/historical-national-rape";
import { accountHistoricalRequest } from "../lib/historical-request-accounting";
import { matchHistoricalType } from "../lib/historical-question-types";
import { compileHistoricalSpec, historicalSourceBounds } from "../lib/historical-question-compiler";
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

/* ---------------- stage 2a typed answers (plan r2) ---------------- */
check("T9: the model path's texts are pinned through the shared rules", () => {
  assert.equal(withHistoricalNationalRapeNotes(BASE, NAT_RAPE(2015, 2022), series(2015, 2022), true), `${BASE} ${N1_STATE_NATIONAL_DEFINITION} ${N3_2021_LIMITATION}`);
  assert.equal(withHistoricalNationalRapeNotes(BASE, COMPOSITE(2016, 2021), compRows(2016, 2021), true), `${BASE} ${N2_COMPOSITE_DEFINITION} ${N3_2021_LIMITATION}`);
  assert.equal(withHistoricalNationalRapeNotes(BASE, STATE_RAPE, series(2020, 2022), true), BASE); // a state's 2021: no N3
  assert.equal(withHistoricalNationalRapeNotes(`${BASE} ${N1_STATE_NATIONAL_DEFINITION}`, null, [], true), BASE);
});

const ds = (o: Partial<TypedDeliveredSeries>): TypedDeliveredSeries => ({ source: "state_national", placeKind: "national", measure: "rape", statistic: "count", years: [2016, 2017], ...o });
check("T10: eligibility of delivered series", () => {
  const [natRape, stRape, natViolent, natViolentRate, stViolent, natRapeRate, total, agencyRape, property] = typedRapeNoteSeries([
    ds({}), ds({ placeKind: "state" }), ds({ measure: "violent" }), ds({ measure: "violent", statistic: "rate_per_100k" }),
    ds({ measure: "violent", placeKind: "state" }), ds({ statistic: "rate_per_100k" }), ds({ measure: "total" }),
    ds({ source: "agency_crime", placeKind: "agency" }), ds({ measure: "property" }),
  ]);
  assert.deepEqual([natRape.rapeCount, natRape.national, natRape.violentComposite], [true, true, false]);
  assert.deepEqual([stRape.rapeCount, stRape.national], [true, false]);
  assert.equal(natViolent.violentComposite, true);
  assert.equal(natViolentRate.violentComposite, true);
  for (const none of [stViolent, natRapeRate, total, agencyRape, property]) assert.ok(!none.rapeCount && !none.violentComposite);
});

// A fixture with every column the compiler reads, 2014-2022, in the corrected or uncorrected state.
function typedFixture(correctedState: boolean): Database.Database {
  const db = new Database(":memory:");
  const ddl = fs.readFileSync("scripts/fixtures/operation-taxonomy/crime_data.ddl.sql", "utf8").split(";").map((s) => s.trim()).filter((s) => /^CREATE\s+(TABLE|INDEX)/i.test(s) && /historical_|agency_county_crosswalk/.test(s));
  for (const stmt of ddl) db.exec(stmt);
  const ins = db.prepare("INSERT INTO historical_state_national (state, year, population, murder, rape, robbery, aggravated_assault, burglary, theft, auto_theft, murder_rate, rape_rate, robbery_rate, aggravated_assault_rate, burglary_rate, theft_rate, auto_theft_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const [state, k] of [["United States", 100], ["Texas", 10], ["Ohio", 5]] as [string, number][]) {
    for (let y = 2014; y <= 2022; y += 1) {
      const rape = state === "United States" && y === 2018 ? (correctedState ? 144505 : 103321) : 1000 * k + y;
      ins.run(state, y, 1000000 * k, 10 * k, rape, 20 * k, 30 * k, 40 * k, 50 * k, 60 * k, 1, 2, 3, 4, 5, 6, 7);
    }
  }
  if (correctedState) {
    db.exec("CREATE TABLE historical_national_rape_correction (name TEXT PRIMARY KEY, applied_at TEXT, source_sha256 TEXT, years TEXT)");
    db.prepare("INSERT INTO historical_national_rape_correction VALUES ('national-rape-cius-t1-2017-2024', 'now', '551f29bd', '2017-2024')").run();
  }
  return db;
}
const NOW = new Date(Date.UTC(2023, 5, 1));
// The route's typed block without the response: each statement read with its own state, the states combined, the notes applied.
function typedAnswer(db: Database.Database, question: string): { text: string; rows: Record<string, unknown>[]; type: string; delivered: TypedDeliveredSeries[] } {
  const decision = matchHistoricalType(accountHistoricalRequest(question), { bounds: (s) => historicalSourceBounds(db, s), now: NOW });
  if (decision.kind !== "spec") throw new Error(`"${question}" did not issue a spec (${decision.kind})`);
  const states: boolean[] = [];
  const executeMany = (d: Database.Database, ss: string[]) => d.transaction(() => ss.map((x) => d.prepare(x).all() as Record<string, unknown>[]))();
  const compiled = compileHistoricalSpec(decision.spec, { db, now: NOW, execute: (sql) => { const r = executeWithCorrectionState(db, sql, 30000, { executeMany }); states.push(r.corrected); return r.rows; } });
  if (compiled.kind !== "answer") throw new Error(`"${question}" declined: ${compiled.explanation}`);
  const state = typedCorrectionState(states);
  if (state === "changed") throw new Error("state changed");
  return { text: withTypedHistoricalRapeNotes(compiled.explanation, compiled.deliveredSeries, state), rows: compiled.rows, type: decision.spec.type, delivered: compiled.deliveredSeries };
}
const CORR = typedFixture(true), UNCORR = typedFixture(false);
const ALL_NOTES = [N1_STATE_NATIONAL_DEFINITION, N2_COMPOSITE_DEFINITION, N3_2021_LIMITATION];
const has = (t: string, ...ns: string[]) => ns.every((n) => t.includes(n));
const lacks = (t: string, ...ns: string[]) => ns.every((n) => !t.includes(n));

check("T11: H1 national rape 2015-2019 by year -> N1 only, 2018 = 144,505", () => {
  const a = typedAnswer(CORR, "rapes in the United States by year from 2015 to 2019");
  assert.equal(a.rows.find((r) => r.year === 2018)?.value, 144505);
  assert.ok(has(a.text, N1_STATE_NATIONAL_DEFINITION) && lacks(a.text, N2_COMPOSITE_DEFINITION, N3_2021_LIMITATION), a.text);
});
check("T11: H1 national rape 2018 -> no N1, no N3", () => {
  const a = typedAnswer(CORR, "rapes in the United States in 2018");
  assert.ok(lacks(a.text, ...ALL_NOTES), a.text);
});
check("T11: H1 national rape 2020-2022 -> N3, no N1", () => {
  const a = typedAnswer(CORR, "rapes in the United States by year from 2020 to 2022");
  assert.ok(has(a.text, N3_2021_LIMITATION) && lacks(a.text, N1_STATE_NATIONAL_DEFINITION), a.text);
});
check("T11: H1 period total of national rapes 2015-2019 -> N1 (the sum adds both definitions)", () => {
  const a = typedAnswer(CORR, "total rapes in the United States from 2015 to 2019");
  assert.ok("period" in a.rows[0], JSON.stringify(a.rows[0]));
  assert.deepEqual(a.delivered[0].years, [2015, 2016, 2017, 2018, 2019]);
  assert.ok(has(a.text, N1_STATE_NATIONAL_DEFINITION) && lacks(a.text, N3_2021_LIMITATION), a.text);
});
check("T11: H1 national violent crime rate 2016-2018 -> N2", () => {
  const a = typedAnswer(CORR, "violent crime rate in the United States by year from 2016 to 2018");
  assert.equal(a.delivered[0].statistic, "rate_per_100k");
  assert.ok(has(a.text, N2_COMPOSITE_DEFINITION) && lacks(a.text, N1_STATE_NATIONAL_DEFINITION), a.text);
});
check("T11: H6 national rape change 2016 to 2018 -> N1", () => {
  const a = typedAnswer(CORR, "change in rapes in the United States from 2016 to 2018");
  assert.equal(a.type, "H6");
  assert.ok(has(a.text, N1_STATE_NATIONAL_DEFINITION), a.text);
});
check("T11: H4 state ranking of rape counts in 2021 -> no N3 (state rows are not national)", () => {
  const a = typedAnswer(CORR, "top 2 states by rapes in 2021");
  assert.equal(a.type, "H4");
  assert.ok(a.delivered.length > 0 && a.delivered.every((d) => d.placeKind === "state"));
  assert.ok(lacks(a.text, ...ALL_NOTES), a.text);
});
check("T11: Texas rape 2015-2019 -> N1; 2020-2022 -> no N3", () => {
  assert.ok(has(typedAnswer(CORR, "rapes in Texas by year from 2015 to 2019").text, N1_STATE_NATIONAL_DEFINITION));
  assert.ok(lacks(typedAnswer(CORR, "rapes in Texas by year from 2020 to 2022").text, ...ALL_NOTES));
});
check("T11: uncorrected -> no note on any of them, and the old 2018 value", () => {
  for (const q of ["rapes in the United States by year from 2015 to 2019", "rapes in the United States by year from 2020 to 2022", "total rapes in the United States from 2015 to 2019", "violent crime rate in the United States by year from 2016 to 2018"]) {
    const a = typedAnswer(UNCORR, q);
    assert.ok(lacks(a.text, ...ALL_NOTES), `${q}: ${a.text}`);
  }
  assert.equal(typedAnswer(UNCORR, "rapes in the United States by year from 2015 to 2019").rows.find((r) => r.year === 2018)?.value, 103321);
});
check("T11: idempotent, and a stale note is stripped when uncorrected", () => {
  const delivered = [ds({ years: [2015, 2016, 2017] })];
  const once = withTypedHistoricalRapeNotes(BASE, delivered, true);
  assert.ok(once.includes(N1_STATE_NATIONAL_DEFINITION));
  assert.equal(withTypedHistoricalRapeNotes(once, delivered, true), once);
  assert.equal(withTypedHistoricalRapeNotes(once, delivered, false), BASE);
});
check("T12: typedCorrectionState", () => {
  assert.equal(typedCorrectionState([true, true]), true);
  assert.equal(typedCorrectionState([false, false, false]), false);
  assert.equal(typedCorrectionState([true, false]), "changed");
  assert.equal(typedCorrectionState([]), false);
});

console.log(`\nhistorical national rape: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
