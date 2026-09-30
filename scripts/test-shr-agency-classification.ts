/**
 * The approved SHR classification rule (lib/shr-agency-classification.ts), case by case, and its dated,
 * state-bound evidence read on an in-memory database built with the builder's own table definition. The real
 * builder, on database files, is scripts/test-shr-agency-type-evidence.ts. Expected values are written from the
 * rows inserted here.
 */
import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";
import Database from "better-sqlite3";
import {
  basisPhrase, classifyShrAgency, loadShrTypeEvidence, SHR_TYPE_EVIDENCE_DDL, yearsPhrase,
  type ShrTypeCandidate, type ShrTypeEvidence,
} from "../lib/shr-agency-classification";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) console.log(`  PASS  ${message}`);
  else { failures += 1; console.log(`  FAIL  ${message}`); }
}
const cand =(over: Partial<ShrTypeCandidate> = {}): ShrTypeCandidate =>
  ({ nibrsOri: "ZZ0000100", otherStateRows: 0, distinctTypes: 1, agencyType: "City", typedYears: [2024, 2025], blankYears: [], ...over });
const ev = (candidates: ShrTypeCandidate[], candidateOris = candidates.map((c) => c.nibrsOri)): ShrTypeEvidence => ({ assessed: true, candidateOris, candidates });
const reason = (x: ReturnType<typeof classifyShrAgency>) => (x.membership === "unresolved" ? x.reason : x.membership);

console.log("\n1 - the rule");
check(reason(classifyShrAgency(ev([cand()]), false, 2025)) === "evidence-not-built", "no evidence tables: unresolved, whatever the evidence would say");
check(reason(classifyShrAgency(null, true, 2025)) === "not-assessed", "an agency the build never saw: not assessed");
check(reason(classifyShrAgency(ev([], []), true, 2025)) === "no-nibrs-match", "no candidate at all: no match");
check(reason(classifyShrAgency(ev([], ["ZZ0000100"]), true, 2025)) === "no-nibrs-year", "a candidate with no row up to the year: no NIBRS year");
check(reason(classifyShrAgency(ev([cand({ otherStateRows: 1 })]), true, 2025)) === "state-conflict", "a candidate row under another state: rejected (not borrowed)");
check(reason(classifyShrAgency(ev([cand(), cand({ nibrsOri: "ZZ0000101" })]), true, 2025)) === "several-nibrs-matches", "two candidates with rows up to the year: ambiguous, never guessed");
check(reason(classifyShrAgency(ev([cand({ distinctTypes: 0, agencyType: null, typedYears: [], blankYears: [2025] })]), true, 2025)) === "blank-type", "only blank types: unresolved");
check(reason(classifyShrAgency(ev([cand({ distinctTypes: 2, typedYears: [2019, 2025] })]), true, 2025)) === "type-changed", "two types: a conflict, rejected");
check(JSON.stringify(classifyShrAgency(ev([cand()]), true, 2025)) === JSON.stringify({ membership: "eligible", agencyType: "City",
  basis: { source: "NIBRS agencies.agency_type", nibrsOri: "ZZ0000100", typedYears: [2024, 2025], blankYears: [], carriedForwardFrom: null } }),
  "one candidate, one type City, typed in the ranking year: eligible, nothing carried forward");
const carried = classifyShrAgency(ev([cand({ typedYears: [2023], blankYears: [2025] })]), true, 2025);
check(carried.membership === "eligible" && carried.basis.carriedForwardFrom === 2023 && JSON.stringify(carried.basis.blankYears) === "[2025]",
  "typed only in 2023, blank in 2025: eligible by carry-forward from 2023, and the blank year is kept, not hidden");
check(classifyShrAgency(ev([cand({ agencyType: "County" })]), true, 2025).membership === "ineligible", "one type County: ineligible, on the same evidence standard");
check(basisPhrase("City", { source: "s", nibrsOri: "o", typedYears: [2023], blankYears: [2025], carriedForwardFrom: 2023 }) === "City in 2023; no type in 2025; carried forward from 2023"
  && yearsPhrase([2020, 2021, 2023, 2024, 2025]) === "5 years between 2020 and 2025" && yearsPhrase([2024, 2025]) === "2024 and 2025",
  "the disclosed basis names the typed years, the blank years and the carry-forward; a long list says how many, never implying the gaps");

console.log("\n2 - the evidence read (dated and state-bound)");
{
  const db = new Database(":memory:");
  check(loadShrTypeEvidence(db, 2025).built === false, "missing tables: the evidence was never built");
  db.exec(SHR_TYPE_EVIDENCE_DDL);
  const b = db.prepare("INSERT INTO shr_agency_type_binding (ori, state, candidate_oris, built_at) VALUES (?, 'ZZ', ?, 'fixture')");
  const e = db.prepare("INSERT INTO shr_agency_type_evidence (ori, state, nibrs_ori, year, nibrs_state, agency_type, source) VALUES (?, 'ZZ', ?, ?, ?, ?, 'NIBRS agencies.agency_type')");
  b.run("A1", '["A100"]'); for (const [y, t] of [[2023, "City"], [2024, "City"], [2025, ""], [2026, "County"]] as const) e.run("A1", "A100", y, "ZZ", t);
  e.run("X1", "X100", 2024, "ZZ", "City");     // evidence with no assessment row: not trusted
  const at2025 = loadShrTypeEvidence(db, 2025).byAgency.get("A1|ZZ");
  check(JSON.stringify(at2025?.candidates) === JSON.stringify([{ nibrsOri: "A100", otherStateRows: 0, distinctTypes: 1, agencyType: "City", typedYears: [2023, 2024], blankYears: [2025] }]),
    `rows up to the ranking year only (2026 County ignored), typed and blank years kept apart: ${JSON.stringify(at2025?.candidates)}`);
  check(classifyShrAgency(at2025 ?? null, true, 2025).membership === "eligible", "so A1 is a city for 2025 (typed through 2024, carried forward)");
  check(reason(classifyShrAgency(loadShrTypeEvidence(db, 2026).byAgency.get("A1|ZZ") ?? null, true, 2026)) === "type-changed", "and for 2026 its County year is a conflict");
  check(!loadShrTypeEvidence(db, 2025).byAgency.has("X1|ZZ"), "evidence without an assessment row is ignored");
  // Year-bound selection: B1's second identifier has an old other-state row and a same-state row only in 2026.
  b.run("B1", '["B100","B199"]');
  e.run("B1", "B100", 2025, "ZZ", "City");
  e.run("B1", "B199", 2024, "YY", "City"); e.run("B1", "B199", 2026, "ZZ", "County");
  const b2025 = loadShrTypeEvidence(db, 2025).byAgency.get("B1|ZZ");
  check(JSON.stringify(b2025?.candidates.map((c) => c.nibrsOri)) === '["B100"]' && classifyShrAgency(b2025 ?? null, true, 2025).membership === "eligible",
    "an identifier with a same-state row only AFTER the year is not a candidate for that year, and its older other-state row is not assessed");
  const b2026 = loadShrTypeEvidence(db, 2026).byAgency.get("B1|ZZ");
  check(JSON.stringify(b2026?.candidates.map((c) => [c.nibrsOri, c.otherStateRows])) === '[["B100",0],["B199",1]]' && reason(classifyShrAgency(b2026 ?? null, true, 2026)) === "state-conflict",
    "for the year it does appear, it is a candidate and its other-state row through that year is counted and refused");
  let threw = false; try { loadShrTypeEvidence(db, 2025.5); } catch { threw = true; }
  check(threw, "a non-integer year is refused");
  db.close();
}


console.log(`\n${checks - failures}/${checks} passed; offline guard: ${deniedDatabaseOpens().length} denied database opens, ${deniedNetworkCalls().length} network calls`);
if (failures > 0) process.exit(1);
