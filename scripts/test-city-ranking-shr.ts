/**
 * GC-064 / GC-061: SHR city rankings (homicide-victim rate; firearm share of murder victims) through
 * the city-ranking family, S1 membership and S2 coverage.
 *
 *   1. recognition: GC-064 and GC-061 exactly, their siblings, owned declines, and the minimum-count
 *      misparse ("a minimum of 30 murders" once became a population condition);
 *   2. the built statements: victims join, confirmed-city ranked statement, candidates statement;
 *   3. the adapter run on the committed SHR DDL (in memory) through a validator shaped like the
 *      route's: confirmed-only rows, an unresolved agency that could place makes the ranking PARTIAL
 *      and is named, one that cannot does not, a disagreeing agency is excluded before LIMIT, firearm
 *      shares, murder versus homicide;
 *   4. both SHR victim licences prove the built statements; wrong shapes do not;
 *   5. a ranked statement that disagrees with the candidates is refused, and a validation refusal
 *      runs nothing further.
 *
 * Expected values are written from the rows inserted here.
 */
import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { recognizeCityRanking, type CityRankingRequest } from "../lib/city-ranking";
import { buildCityRanking } from "../lib/city-ranking-builder";
import { planShrCityRanking, runShrCityRanking, type ValidatedStatement } from "../lib/city-ranking-shr";
import { proveShrVictimLicence } from "../lib/shr-murder-licence";
import { loadShrTypeEvidence, SHR_TYPE_EVIDENCE_DDL } from "../lib/shr-agency-classification";
import { validateDeterministicShrPlanSql } from "../lib/shr-authority";
import { queryContractFailureMessage } from "../lib/query-contract-validator";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) console.log(`  PASS  ${message}`);
  else { failures += 1; console.log(`  FAIL  ${message}`); }
}

const GC064 = "What cities over 100k population have highest homicide rates currently";
const GC061 = "Which 10 cities (min 30 murders) had the highest share via firearm in 2025?";
const CUTOFF = { year: 2025, month: 12, observed: true };
const ranking = (q: string) => {
  const r = recognizeCityRanking(q, "shr");
  return r && r.kind === "ranking" ? (r as CityRankingRequest) : null;
};
const declineReason = (q: string) => {
  const r = recognizeCityRanking(q, "shr");
  return r && r.kind === "unsupported" ? r.reason : null;
};

console.log("\n1 - recognition");
{
  const r = ranking(GC064);
  check(!!r && r.offense.kind === "shr_victims" && r.offense.measure === "homicide" && r.sort.quantity === "rate_per_100k"
    && r.sort.direction === "desc" && r.period.kind === "latest_with_data" && r.resultCount === 20 && r.entityLevel === "city"
    && JSON.stringify(r.eligibility) === JSON.stringify([{ kind: "population", comparison: ">", value: 100000 }]),
    "GC-064: all homicide victims, rate per 100,000, highest first, latest observed year, 20 rows, population > 100,000");
  check(!!r && r.caveats.some((c) => /plus negligent manslaughter/.test(c)), "GC-064 carries the all-homicide sentence");
  const m = ranking("What cities over 100k population have the highest murder rates currently");
  check(!!m && m.offense.kind === "shr_victims" && m.offense.measure === "murder" && m.caveats.length === 0, "murder: murder victims, no all-homicide sentence");
  const y = ranking("What cities over 100k population had the highest homicide rates in 2024");
  check(!!y && y.period.kind === "explicit" && y.period.year === 2024, "an explicit year is kept");
  const g = ranking(GC061);
  check(!!g && g.sort.quantity === "share_pct" && g.offense.kind === "shr_victims" && g.offense.measure === "murder"
    && g.resultCount === 10 && g.period.kind === "explicit" && g.period.year === 2025
    && JSON.stringify(g.eligibility.map((e) => [e.kind, e.comparison, e.value])) === JSON.stringify([["count", ">=", 30]]),
    `GC-061: firearm share of murder victims, 10 rows, murders >= 30, 2025 (${JSON.stringify(g?.eligibility)})`);
  check(declineReason("Which 10 cities had the highest firearm share of homicides in 2025?") === "share-homicide-unsupported",
    "firearm share of all homicides: declined in owned words (the all-homicide licence cannot prove the firearm numerator)");
  const g5 = ranking("Which 5 cities with at least 50 murders had the highest percentage of murders committed with a firearm in 2025?");
  check(!!g5 && g5.sort.quantity === "share_pct" && g5.resultCount === 5 && g5.offense.kind === "shr_victims" && g5.offense.measure === "murder",
    "a murder-share sibling in other words is recognized");
  check(recognizeCityRanking(GC061, "nibrs")?.kind !== "ranking", "a firearm share is not built on NIBRS");
  // Demonstrated misparse on the pre-change recognizer: population >= 30 instead of murders >= 30.
  const minCount = recognizeCityRanking("Which cities with a minimum of 30 murders had the most murders in 2024?", "current");
  check(!!minCount && minCount.kind === "ranking"
    && JSON.stringify((minCount as CityRankingRequest).eligibility.map((e) => [e.kind, e.comparison, e.value])) === JSON.stringify([["count", ">=", 30]]),
    `"a minimum of 30 murders" is a count condition, not a population one (${JSON.stringify((minCount as CityRankingRequest | null)?.eligibility)})`);
  check(declineReason("What cities over 100k population have the highest murder and homicide rates currently") !== null, "murders and homicides together: declined");
  check(declineReason("Rank cities by murder rate, homicides, currently") === "shr-measure-conflict", "murder and homicides both claimed: owned measure conflict");
  check(declineReason("What cities over 100k population have the highest homicide rates currently in 2024") === "period-conflict", "currently plus a year: owned period conflict");
  check(declineReason("Which jurisdictions have the highest homicide rates currently") === "jurisdiction-unavailable-shr", "jurisdictions: declined, not built as cities");
  check(declineReason("What cities over 100k population have the highest homicide incident rates currently") !== null, "homicide incidents: declined (victims are what this ranks)");
  check(declineReason("Which cities have the highest killing rates currently") !== null, "killings: not resolved to either measure");
  check(declineReason("Which 10 cities had the highest firearm share rate of murders in 2025?") !== null, "a share with a stated rate: declined as a unit contradiction");
}

console.log("\n2 - the built statements");
const gcRequest = ranking(GC064);
const murderRequest = ranking("What cities over 100k population have the highest murder rates currently");
const built = gcRequest ? buildCityRanking(gcRequest, CUTOFF) : null;
const builtMurder = murderRequest ? buildCityRanking(murderRequest, CUTOFF) : null;
const builtShare = ranking(GC061) ? buildCityRanking(ranking(GC061)!, CUTOFF) : null;
check(!!built?.completeness && !!builtMurder?.completeness && !!builtShare?.completeness, "GC-064, its murder form and GC-061 build SHR statements");
if (built?.completeness && builtMurder && builtShare?.completeness) {
  check(/FROM incidents i JOIN victims v ON v\.incident_id = i\.id/.test(built.sql) && /COUNT\(v\.id\)/.test(built.sql), "counts victims through the victims join");
  check(!/agency_type/.test(built.sql) && /i\.ori IN \(NULL\)/.test(built.sql),
    "policy: the ranked statement never reads incidents.agency_type; before membership is decided it names no agency");
  const cand = built.completeness.candidatesSql;
  check(!/agency_type|population [<>]|HAVING|LIMIT/.test(cand) && /GROUP BY i\.ori, i\.agency, i\.state, i\.population ORDER BY/.test(cand)
    && /i\.year = 2025/.test(cand), "CL3 + policy: the candidates statement reads the scope only (no type, population, count or LIMIT), grouped so records that disagree return separately, and reads no legacy type");
  check(!/i\.population/.test(builtShare.completeness.candidatesSql) && /i\.homicide_type = 'Murder'/.test(builtShare.completeness.candidatesSql),
    "a firearm-share ranking with no population condition does not group by population (a second population is not its conflict)");
  check(/i\.population > 100000/.test(built.sql) && /i\.population > 0/.test(built.sql) && /i\.year = 2025/.test(built.sql), "population limit, denominator present, period");
  check(!/homicide_type/.test(built.sql) && /i\.homicide_type = 'Murder'/.test(builtMurder.sql), "all homicides has no type filter; murder has it");
  check(!/MIN\(|MAX\(|HAVING/.test(built.sql) && /LIMIT 20$/.test(built.sql), "no month aggregates, no unrequested HAVING, limit 20");
  check(/i\.homicide_type = 'Murder'/.test(builtShare.sql) && /HAVING COUNT\(v\.id\) >= 30/.test(builtShare.sql)
    && /i\.weapon_group = 'Firearm'/.test(builtShare.sql) && /LIMIT 10$/.test(builtShare.sql), "GC-061: murder filter, count >= 30, firearm numerator, limit 10");
  check(/i\.ori IN \('X1', 'Y1'\)/.test(built.completeness.rankedConfirmed!(["X1", "Y1"])) && built.completeness.rankedConfirmed!([]) === built.sql,
    "the ranked statement names the confirmed agencies by ORI; with none it names none");
  let threw = false; try { built.completeness.ranked([]); } catch { threw = true; }
  check(threw, "the column-predicate ranking is not available for SHR (membership is not a column)");
  const partial = buildCityRanking(ranking(GC064)!, { year: 2026, month: 3, observed: true })!;
  check(/i\.month <= 3/.test(partial.sql) && partial.caveats.some((c) => /2026 runs through March/.test(c)), "a partial latest year is limited and said so");
  check(buildCityRanking(ranking(GC064)!, { year: 2026, month: 3, observed: false }) === null, "an unobserved cutoff establishes no period");
  const unavailable = planShrCityRanking(GC064, { year: 2026, month: 3, observed: false });
  check(unavailable?.kind === "unavailable" && /Name the year/.test(unavailable.explanation), "the SHR plan owns that as a limitation");
  check(built.caveats.some((c) => /^SHR records no agency type\. An agency is ranked as a city only by the NIBRS database's classification of the one NIBRS agency its identifier matches in its state, from NIBRS years up to 2025: every year with a type must say City, years with no type are not counted, and when the latest typed year is earlier, that City is carried forward\. Where the FBI's NIBRS file gives no type, this project's NIBRS pipeline derives one from the agency's population group/.test(c))
    && !built.caveats.some((c) => /every year it reported/.test(c))
    && !built.caveats.some((c) => /SHR records as City/.test(c))
    && built.caveats.some((c) => /no population recorded/.test(c)) && built.caveats.some((c) => /does not certify complete reporting/.test(c))
    && built.caveats.some((c) => /victims, not incidents/.test(c)), "the answer states membership, unknown population, coverage and unit");
}

console.log("\n3 - the adapter on the committed SHR DDL");
type Opts = { pair?: boolean; negligent?: boolean; firearm?: number; population2?: number };
function shrDb() {
  const db = new Database(":memory:");
  db.exec(readFileSync("scripts/fixtures/operation-taxonomy/shr.ddl.sql", "utf8"));
  let id = 0, vid = 0;
  // `legacy` is the incidents.agency_type LABEL (normalizer-derived or legacy, origin unknown). The policy never
  // reads it, so the fixture sets it to mislead: agencies that are not cities carry City, and a city carries none.
  const add = (ori: string, agency: string, legacy: string | null, population: number | null, year: number, victims: number, opts: Opts = {}) => {
    const type = legacy;
    let placed = 0, n = 0;
    while (placed < victims) {
      const iid = ++id;
      const pop = opts.population2 !== undefined && n === 0 ? opts.population2 : population;
      db.prepare("INSERT INTO incidents (id, year, month, state, ori, agency, population, agency_type, homicide_type, weapon_group) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(iid, year, (n % 12) + 1, "ZZ", ori, agency, pop, type, opts.negligent && n === 0 ? "Manslaughter by negligence" : "Murder",
          n < (opts.firearm ?? 0) ? "Firearm" : "Knife");
      const c = opts.pair && n === 1 && victims - placed >= 2 ? 2 : 1;
      for (let k = 1; k <= c; k++) db.prepare("INSERT INTO victims (id, incident_id, victim_num) VALUES (?,?,?)").run(++vid, iid, k);
      placed += c; n++;
    }
  };
  // The evidence the policy reads (the builder's tables, lib/shr-agency-classification.ts), per agency.
  db.exec(SHR_TYPE_EVIDENCE_DDL);
  // `bound`: one candidate NIBRS agency with these typed years; `ambiguous`: two candidates, both with 2025 rows;
  // `unbound`: no candidate. All rows in the agency's own state (the state/year cases are in test-shr-agency-type-evidence.ts).
  const evidence = (ori: string, spec: { bound: Record<number, string> } | "ambiguous" | "unbound") => {
    const rows: [string, number, string][] = spec === "unbound" ? [] : spec === "ambiguous" ? [[`${ori}00`, 2025, "City"], [`${ori}01`, 2025, "County"]]
      : Object.entries(spec.bound).map(([year, type]) => [`${ori}00`, Number(year), type]);
    db.prepare("INSERT INTO shr_agency_type_binding (ori, state, candidate_oris, built_at) VALUES (?, 'ZZ', ?, 'fixture')")
      .run(ori, JSON.stringify([...new Set(rows.map((r) => r[0]))]));
    for (const [nibrsOri, year, type] of rows) {
      db.prepare("INSERT INTO shr_agency_type_evidence (ori, state, nibrs_ori, year, nibrs_state, agency_type, source) VALUES (?, 'ZZ', ?, ?, 'ZZ', ?, 'NIBRS agencies.agency_type')")
        .run(ori, nibrsOri, year, type);
    }
  };
  const city = { bound: { 2024: "City", 2025: "City" } };
  return { db, add, evidence, city };
}
const deps = (db: Database.Database, question: string, seen: string[] = []) =>
  ({ validate: validator(db, question, seen), typeEvidence: (year: number) => loadShrTypeEvidence(db, year) });
const validator = (db: Database.Database, question: string, seen: string[] = []) => (statement: string): ValidatedStatement | null => {
  seen.push(statement);
  const contract = validateDeterministicShrPlanSql({ question, sql: statement });
  if (queryContractFailureMessage(contract)) return null;
  return { sql: contract.sql, rows: () => db.prepare(contract.sql).all() as Record<string, unknown>[] };
};
const rowsOf = (out: ReturnType<typeof runShrCityRanking>) => out.kind === "answer" ? out.rows.map((r) => [r.ori, r.victims, r.rate_per_100k ?? r.firearm_share_pct]) : null;
{
  const { db, add, evidence, city } = shrDb();
  // legacy label (ignored)     ↓                     evidence (read) ↓
  add("A1", "Alpha", "", 200000, 2025, 100, { pair: true, negligent: true }); evidence("A1", city);       // 50.0 city
  add("B1", "Beta", "City", 300000, 2025, 120);      evidence("B1", "ambiguous");                         // 40.0 several NIBRS agencies
  add("C1", "Gamma County", "City", 400000, 2025, 300); evidence("C1", { bound: { 2024: "County", 2025: "County" } }); // 75.0 County
  add("D1", "Delta U", "City", 150000, 2025, 150);   evidence("D1", { bound: { 2025: "University or College" } });  // 100.0 not a city
  add("E1", "Epsilon", "City", 90000, 2025, 90);     evidence("E1", city);                                // below the population limit
  add("F1", "Phi", "City", null, 2025, 90);          evidence("F1", city);                                // no population
  add("G1", "Gamma", "City", 250000, 2025, 50);      evidence("G1", "unbound");                           // 20.0 no NIBRS agency
  add("H1", "Eta", null, 500000, 2025, 150);         evidence("H1", city);                                // 30.0 city
  add("S1", "Sigma", "City", 200000, 2025, 200, { population2: 210000 }); evidence("S1", city);           // two recorded populations
  add("K1", "Kappa", "City", 200000, 2025, 30);      evidence("K1", { bound: { 2024: "County", 2025: "City" } }); // 15.0 type changed: conflict
  add("L1", "Lambda", "City", 200000, 2025, 24);     evidence("L1", "unbound");                           // 12.0 legacy City, no evidence
  add("M1", "Mu", "City", 200000, 2025, 20);         evidence("M1", { bound: { 2026: "City" } });          // 10.0 City only AFTER the year
  add("N1", "Nu", "City", 200000, 2025, 18);                                                              // 9.0 never assessed
  add("A1", "Alpha", "", 200000, 2024, 400);                                                              // other year
  const plan = planShrCityRanking(GC064, CUTOFF);
  check(plan?.kind === "deterministic", "GC-064 plans deterministically");
  if (plan?.kind === "deterministic") {
    const seen: string[] = [];
    const out = runShrCityRanking(plan, deps(db, GC064, seen));
    check(JSON.stringify(rowsOf(out)) === JSON.stringify([["A1", 100, 50], ["H1", 150, 30]]),
      `policy: only evidence-backed cities rank (Alpha and Eta carry no legacy City label; every legacy-City non-city is left out), disagreeing S1 excluded before LIMIT: ${JSON.stringify(rowsOf(out))}`);
    check(out.kind === "answer" && !out.complete && out.title.startsWith("Partial ranking: ") && /\(confirmed cities only\)$/.test(out.title),
      "fewer than 20 confirmed rows with unresolved candidates: titled partial");
    check(out.kind === "answer" && /with no evidence-backed agency type would place within it/.test(out.explanation)
      && /Beta, ZZ \(40, would rank 2nd\)/.test(out.explanation) && /Gamma, ZZ \(20, would rank 4th\)/.test(out.explanation)
      && /Kappa, ZZ \(15, would rank 5th\)/.test(out.explanation) && /Lambda, ZZ \(12, would rank 6th\)/.test(out.explanation)
      && /Mu, ZZ \(10, would rank 7th\)/.test(out.explanation) && /Nu, ZZ \(9, would rank 8th\)/.test(out.explanation),
      "every unresolved agency that could place is named with its value and place");
    check(out.kind === "answer"
      && /Why they are not classified: /.test(out.explanation)
      && /Beta, ZZ — its identifier matches several NIBRS agencies in those years/.test(out.explanation)
      && /Gamma, ZZ and Lambda, ZZ — its identifier matches no NIBRS agency in its state/.test(out.explanation)
      && /Kappa, ZZ — NIBRS recorded more than one type for it in those years/.test(out.explanation)
      && /Mu, ZZ — no NIBRS agency matching its identifier has a year in its state up to the ranking year/.test(out.explanation)
      && /Nu, ZZ — the agency was not in the evidence build/.test(out.explanation),
      "policy: each named agency's reason is stated -- ambiguous identifier, no match (a legacy City label does not help), conflict, a later year does not count, not assessed");
    check(out.kind === "answer" && /Where each ranked city's classification comes from \(the NIBRS database's type for the one NIBRS agency its identifier matches\): Alpha, ZZ and Eta, ZZ — City in 2024 and 2025\./.test(out.explanation),
      "policy: each ranked city's own classification basis is disclosed (agencies sharing a basis grouped)");
    check(out.kind === "answer" && /Sigma, ZZ \(S1\) has conflicting records in SHR for this period \(more than one name, population or state\)/.test(out.explanation), "the disagreeing agency is named, not ranked");
    check(out.kind === "answer" && !/Gamma County|Delta U|Epsilon|Phi\b/.test(out.explanation), "County, not-a-city, below-limit and no-population agencies are not presented as candidates");
    check(seen.length === 2 && /i\.ori IN \('A1', 'H1'\)/.test(seen[1]) && !/agency_type/.test(seen.join(" ")),
      `two statements validated and run (candidates, ranked by confirmed ORI), neither reading agency_type: ${seen.length}`);
  }
  // Ranked to two rows: an unresolved agency below the last place cannot change the result.
  const two = planShrCityRanking("Which 2 cities over 100k population have the highest homicide rates currently", CUTOFF);
  if (two?.kind === "deterministic") {
    const out = runShrCityRanking(two, deps(db, "Which 2 cities over 100k population have the highest homicide rates currently"));
    check(out.kind === "answer" && out.relevantUnresolved.map((r) => r.ori).join() === "B1" && !/Gamma, ZZ/.test(out.explanation),
      "with two rows, Beta (40) could place above Eta (30) and is named; Gamma (20) could not and is not");
  } else check(false, "the two-row sibling plans");
  const murder = planShrCityRanking("What cities over 100k population have the highest murder rates currently", CUTOFF);
  if (murder?.kind === "deterministic") {
    const out = runShrCityRanking(murder, deps(db, "What cities over 100k population have the highest murder rates currently"));
    check(out.kind === "answer" && out.rows[0]?.ori === "A1" && out.rows[0]?.victims === 99, "murder drops the negligent-manslaughter victim (99, not 100)");
  } else check(false, "the murder sibling plans");
  // A 2024 ranking uses only the years up to 2024: Kappa's 2024 type is County alone, so it is not a city then.
  const y2024 = planShrCityRanking("What cities over 100k population had the highest homicide rates in 2024", CUTOFF);
  if (y2024?.kind === "deterministic") {
    const out = runShrCityRanking(y2024, deps(db, "What cities over 100k population had the highest homicide rates in 2024"));
    check(out.kind === "answer" && JSON.stringify(rowsOf(out)) === JSON.stringify([["A1", 400, 200]]) && /Alpha, ZZ — City in 2024\./.test(out.explanation),
      `the period basis is the ranking year's: ${out.kind === "answer" ? JSON.stringify(rowsOf(out)) : out.kind}`);
  } else check(false, "the 2024 sibling plans");
  db.close();
}
{
  // The evidence was never built (production today): nothing is confirmed, and the answer says why.
  const { db, add } = shrDb();
  db.exec("DROP TABLE shr_agency_type_evidence; DROP TABLE shr_agency_type_binding;");
  add("A1", "Alpha", "City", 200000, 2025, 100);
  add("H1", "Eta", "City", 500000, 2025, 150);
  const plan = planShrCityRanking(GC064, CUTOFF);
  if (plan?.kind === "deterministic") {
    const seen: string[] = [];
    const out = runShrCityRanking(plan, deps(db, GC064, seen));
    check(out.kind === "answer" && out.rows.length === 0 && !out.complete && /^Partial ranking/.test(out.title)
      && /No evidence-backed agency types have been built for SHR yet, so no agency is confirmed as a city here\./.test(out.explanation)
      && /Eta, ZZ \(30, would rank 2nd\)/.test(out.explanation) && /Alpha, ZZ \(50, would rank 1st\)/.test(out.explanation)
      && /i\.ori IN \(NULL\)/.test(seen[1] ?? ""),
      "unsupported counterpart: without evidence, legacy City labels rank nothing; every agency is named as unresolved, the reason given");
  } else check(false, "the no-evidence case plans");
  db.close();
}
{
  // Complete (the useful ranking): every agency without evidence sits below the last confirmed place.
  const { db, add, evidence, city } = shrDb();
  add("A1", "Alpha", "City", 200000, 2025, 100); evidence("A1", city);
  add("H1", "Eta", "City", 500000, 2025, 150);   evidence("H1", city);
  add("G1", "Gamma", "City", 250000, 2025, 50);  evidence("G1", "unbound");
  const q = "Which 2 cities over 100k population have the highest homicide rates currently";
  const plan = planShrCityRanking(q, CUTOFF);
  if (plan?.kind === "deterministic") {
    const out = runShrCityRanking(plan, deps(db, q));
    check(out.kind === "answer" && out.complete && !/^Partial/.test(out.title) && !/incomplete/.test(out.explanation)
      && JSON.stringify(rowsOf(out)) === JSON.stringify([["A1", 100, 50], ["H1", 150, 30]]) && /Alpha, ZZ and Eta, ZZ — City in 2024 and 2025\./.test(out.explanation),
      "useful ranking: both places filled by evidence-backed cities, no unresolved agency can place -- complete, not partial, basis stated");
    // CL3, the Codex route counterexample in miniature: Alpha gains records at a population BELOW the
    // limit. A filter-first candidates read would never see them; the scope-only read does.
    add("A1", "Alpha", "City", 50000, 2025, 100);
    const split = runShrCityRanking(plan, deps(db, q));
    check(split.kind === "answer" && !split.complete && !split.rows.some((r) => r.ori === "A1")
      && /Alpha, ZZ \(A1\) has conflicting records in SHR/.test(split.explanation) && /^Partial ranking/.test(split.title),
      `CL3: a split whose other records fall below the population filter is found, excluded and named: ${split.kind === "answer" ? JSON.stringify(rowsOf(split)) : split.kind}`);
  } else check(false, "the complete case plans");
  db.close();
}
{
  // GC-061 on the frozen fixture's shape: firearm share among cities with at least 30 murders.
  const { db, add, evidence, city } = shrDb();
  add("T1", "Tau", "City", null, 2025, 51, { firearm: 41 });     evidence("T1", city);        // 80.4
  add("T2", "Upsilon", "City", null, 2025, 40, { firearm: 36 }); evidence("T2", city);        // 90.0
  add("T3", "Omega", "City", null, 2025, 29, { firearm: 29 });   evidence("T3", city);        // 100.0 but below 30 murders
  add("T4", "Psi", "City", null, 2025, 60, { firearm: 30 });     evidence("T4", "ambiguous"); // 50.0, legacy City but no evidence
  const plan = planShrCityRanking(GC061, CUTOFF);
  if (plan?.kind === "deterministic") {
    const out = runShrCityRanking(plan, deps(db, GC061));
    check(JSON.stringify(rowsOf(out)) === JSON.stringify([["T2", 40, 90], ["T1", 51, 80.4]]),
      `GC-061: firearm shares, ordered, count >= 30 applied: ${JSON.stringify(rowsOf(out))}`);
    check(out.kind === "answer" && out.rows[1]?.firearm_victims === 41, "the numerator is returned beside the share");
    check(out.kind === "answer" && /Psi, ZZ \(50%, would rank 3rd\)/.test(out.explanation) && !out.complete,
      "an agency without evidence (despite its legacy City label) within the 10 rows makes the share ranking partial");
    check(out.kind === "answer" && /firearm victims divided by all its victims/.test(out.explanation), "the share is defined in the answer");
  } else check(false, "GC-061 plans deterministically");
  db.close();
}

console.log("\n4 - both victim licences prove the built statements; wrong shapes do not");
if (built?.completeness && builtMurder && builtShare?.completeness) {
  check(proveShrVictimLicence(built.sql, "homicide").proved && proveShrVictimLicence(built.completeness.candidatesSql, "homicide").proved
    && proveShrVictimLicence(builtMurder.sql, "murder").proved, "fact licences: ranked and candidates statements proved");
  const v1 = validateDeterministicShrPlanSql({ question: GC064, sql: built.sql });
  const v2 = validateDeterministicShrPlanSql({ question: GC064, sql: built.completeness.candidatesSql });
  const v3 = validateDeterministicShrPlanSql({ question: GC061, sql: builtShare.completeness.candidatesSql });
  check(!queryContractFailureMessage(v1) && !queryContractFailureMessage(v2) && !queryContractFailureMessage(v3), "the route's deterministic validation passes them");
  const incidents = built.sql.replace("COUNT(v.id) AS victims", "COUNT(DISTINCT i.id) AS victims");
  check(!proveShrVictimLicence(incidents, "homicide").proved, "counting incidents as victims is refused");
  check(!proveShrVictimLicence(builtMurder.sql, "homicide").proved, "a murder-filtered count is refused for an all-homicide question");
  const withMonths = built.sql.replace(" FROM incidents", ", MIN(i.month) AS first_month FROM incidents");
  check(!proveShrVictimLicence(withMonths, "homicide").proved, "why no month columns: the all-homicide licence refuses them");
}

console.log("\n5 - disagreement and refusal are owned failures");
{
  const { db, add, evidence, city } = shrDb();
  add("A1", "Alpha", "City", 200000, 2025, 100); evidence("A1", city);
  add("H1", "Eta", "City", 500000, 2025, 150);   evidence("H1", city);
  const plan = planShrCityRanking(GC064, CUTOFF);
  if (plan?.kind === "deterministic") {
    const typeEvidence = (year: number) => loadShrTypeEvidence(db, year);
    // The ranked statement returns something the candidates do not predict: refused, not delivered.
    const lying = (alter: (rows: Record<string, unknown>[]) => Record<string, unknown>[]) => (statement: string): ValidatedStatement | null => {
      const v = validator(db, GC064)(statement);
      if (!v || !/LIMIT \d+$/.test(statement)) return v;           // the candidates statement is left alone
      return { sql: v.sql, rows: () => alter(v.rows()) };
    };
    check(runShrCityRanking(plan, { validate: lying((rows) => rows.reverse()), typeEvidence }).kind === "refused", "a ranked result in a different order from the candidates is refused");
    // Every figure where the prediction puts it, but under another agency's ORI: only the identity check can see it.
    check(runShrCityRanking(plan, { validate: lying((rows) => rows.map((r, i) => (i === 0 ? { ...r, ori: "ZZ-OTHER" } : r))), typeEvidence }).kind === "refused",
      "a ranked result naming a different agency with the predicted figures is refused (identity is compared, not only values)");
    // Same agencies, same order, one figure different: the check compares values, not only ORI order.
    check(runShrCityRanking(plan, { validate: lying((rows) => rows.map((r, i) => (i === 0 ? { ...r, victims: Number(r.victims) + 1 } : r))), typeEvidence }).kind === "refused",
      "a ranked result whose figures differ from the candidates is refused (values are compared, not only order)");
    check(runShrCityRanking(plan, { validate: lying((rows) => rows.map((r, i) => (i === 1 ? { ...r, population: Number(r.population) - 1 } : r))), typeEvidence }).kind === "refused",
      "a ranked result whose population differs from the candidates is refused");
    const seen: string[] = [];
    const refuseAll = (statement: string) => { seen.push(statement); return null; };
    check(runShrCityRanking(plan, { validate: refuseAll, typeEvidence }).kind === "refused" && seen.length === 1, "a validation refusal runs nothing further");
  } else check(false, "GC-064 plans for the refusal checks");
  db.close();
}

console.log(`\n${checks - failures}/${checks} passed; offline guard: ${deniedDatabaseOpens().length} denied database opens, ${deniedNetworkCalls().length} network calls`);
if (failures > 0) process.exit(1);
