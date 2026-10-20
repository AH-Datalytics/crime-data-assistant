/**
 * The fuzzy place fallback must not turn ordinary English into a town nobody asked for.
 *
 * THE MEASURED DEFECT. `fuzzyFallbackMention` fuzzy-matches the 1-3 words after any of nine geo
 * prepositions (including the genitive `of`) against the shipped 16,005-entry catalog at edit
 * distance 1 for short spans. Hundreds of small towns sit one edit from an ordinary word, so `all`
 * became **Ball, LA** and `the` became **Tye, TX**. That phantom then reached the query contract as
 * the requested geography AND the sentence appended to the model's prompt ("all" appears to mean
 * Ball, LA. Use the corrected place name...), which is how GC-002's captured SQL came back filtered
 * to `ori = 'LA0401000'`.
 *
 * WHAT THE GUARD CLAIMS, precisely. It declines the fuzzy inference when a span is entirely ordinary
 * English. It does NOT prove the user never meant a place: `over` could be an ordinary word or a
 * mistyped Dover, and the earlier claim that "a typo is necessarily not a correctly spelled word" is
 * false. The trade-off is deliberate and bounded - silently assigning an unrequested city is worse
 * than withholding a weak spelling correction - and exact place matching still runs first, so a town
 * whose name IS an English word is unaffected (section C proves this with Early, TX).
 *
 * WHAT IT DOES NOT CLAIM. A curated vocabulary cannot cover every ordinary word, every language or
 * every future catalog collision. Passing the named negatives and positives below is the stopping
 * condition, not a solution to place understanding. Same-name ranking across states (section E) and
 * warn-only SQL containment stay separate, recorded concerns.
 *
 * Local only: shipped TypeScript catalog and pure functions. No database, model, network or route.
 */
import { resolveGeoPlaces } from "../lib/geo-place-resolver";
import { buildQueryContract } from "../lib/query-contract";
import { geoCorrectionHint } from "../lib/geo-correction";
import { asksSubCityGeography } from "../lib/capability-overrides";
import { COMMON_ENGLISH_WORD_COUNT, isCommonEnglishWord } from "../lib/english-common-words";
import { CODEBOOK_WORD_COUNT, CODEBOOK_WORD_LIST, PRODUCT_TERM_COUNT, isCrimeVocabularyWord } from "../lib/crime-vocabulary";
import fs from "node:fs";
import path from "node:path";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${message}`); }
}

/** One place identity, name AND state — a name alone does not establish geography. */
function identity(question: string): string | null {
  const m = resolveGeoPlaces(question).mentions[0];
  const c = m?.candidates[0];
  if (!c) return null;
  return `${c.name}${c.state ? ", " + c.state : ""}`;
}
function mentionCount(question: string): number {
  return resolveGeoPlaces(question).mentions.length;
}

const GC_001 = "give me the share of all rape clearances that were prosecution declined in 2025 by state";
const GC_002 = "give me the share of all rape clearances that were prosecution declined in 2025";
const GC_010 = "Please show me a graph of the violent crime rate back to 1930 and also the U.S. prison population going back that far (or as far as possible)";

/* ------------------------------------------------------------------ */
/*  A - the captured questions, end to end: resolver, contract, hint   */
/* ------------------------------------------------------------------ */
console.log("A - the captured questions");

for (const [id, q] of [["GC-001", GC_001], ["GC-002", GC_002]] as const) {
  console.log(`  ${id}: mentions=${mentionCount(q)} identity=${identity(q) ?? "(none)"} hint=${geoCorrectionHint(q) ? "present" : "null"}`);
  check(mentionCount(q) === 0, `${id}: no place may be invented from "all"`);
  check(identity(q) !== "Ball, LA", `${id}: must not resolve to Ball, LA`);
  check(geoCorrectionHint(q) === null, `${id}: the model must not be told to use a phantom place`);
}

{
  // The repair must remove the phantom WITHOUT discarding what the question really asked for.
  const c = buildQueryContract(GC_001, "nibrs");
  console.log(`  GC-001 contract: geography=${c?.geography.kind}/${c?.geography.name} breakdowns=${JSON.stringify(c?.breakdowns)}`);
  check(c?.geography.kind === "unknown", `GC-001: contract geography must be unknown (got ${c?.geography.kind}/${c?.geography.name})`);
  check(c?.geography.name === null, "GC-001: contract must name no place");
  check((c?.breakdowns ?? []).includes("state"), "GC-001: the by-state breakdown must survive");
}
{
  // GC-010's contract was already national; the phantom was only in the prompt. Its compound
  // handling stays failing and is NOT claimed fixed here.
  const c = buildQueryContract(GC_010, "historical");
  console.log(`  GC-010 contract: geography=${c?.geography.kind}/${c?.geography.name} hint=${geoCorrectionHint(GC_010) ? "present" : "null"}`);
  check(c?.geography.kind === "national", `GC-010: contract must stay national (got ${c?.geography.kind})`);
  check(geoCorrectionHint(GC_010) === null, "GC-010: no Tye hint may be sent to the model");
  check(mentionCount(GC_010) === 0 || identity(GC_010) !== "Tye, TX", "GC-010: must not resolve to Tye, TX");
}

/* ------------------------------------------------------------------ */
/*  B - every anchor, and the scope phrases                            */
/* ------------------------------------------------------------------ */
console.log("");
console.log("B - all nine geo prepositions, and ordinary scope phrases");

const ANCHORS = ["in", "for", "across", "near", "around", "within", "at", "of", "throughout"];
for (const p of ANCHORS) {
  const q = `show murders ${p} all cities in 2024`;
  check(mentionCount(q) === 0, `anchor "${p}": "all cities" must not resolve (got ${identity(q) ?? "none"})`);
}

const SCOPE_PHRASES = [
  "murders in large cities in 2024",          // violates test-geo-place-resolver.ts:165's stated intent today
  "show murders in the largest cities in 2024",
  "give me murders across all states in 2024",
  "give me murders for all agencies in 2024",
  "how many murders were reported in all of 2024",
  "murders in the biggest cities in 2024",
];
for (const q of SCOPE_PHRASES) {
  check(mentionCount(q) === 0, `scope phrase must not resolve to a town: ${JSON.stringify(q)} -> ${identity(q) ?? "none"}`);
}

/* ------------------------------------------------------------------ */
/*  C - the measured collision list, retained in full                  */
/* ------------------------------------------------------------------ */
console.log("");
console.log("C - the measured collisions, at phrase level");

/*
 * MEASURED, not screened: each word below produced a CONFIDENT single mention through
 * `resolveGeoPlaces("murders in <word> in 2024")` before this guard existed. The list is retained
 * here rather than reported as a count so a catalog regeneration cannot silently re-open one.
 */
const PHANTOM_WORDS: Array<[string, string]> = [
  ["the", "Tye, TX"], ["with", "Witt, IL"], ["one", "Ione, CA"], ["all", "Ball, LA"],
  ["would", "Gould, AR"], ["make", "Kake, AK"], ["like", "Luke, MD"], ["know", "Knox, IN"],
  ["take", "Kake, AK"], ["could", "Gould, AR"], ["see", "Lee, MA"], ["now", "Bow, NH"],
  ["only", "Onley, VA"], ["over", "Dover, AR"], ["also", "Alto, GA"], ["work", "York, AL"],
  ["first", "Forest, MS"], ["even", "Eden, NC"], ["most", "Post, TX"], ["was", "War, WV"],
  ["has", "Hays, KS"], ["made", "Meade, KS"], ["many", "Man, WV"], ["own", "Owen, WI"],
  ["little", "Lytle, TX"], ["large", "Largo, FL"], ["too", "Tool, TX"], ["enough", "Enoch, UT"],
  ["behind", "Bend, OR"], ["beyond", "Bend, OR"], ["past", "Post, TX"], ["per", "Peru, IL"],
];
/*
 * These six produced a mention that ASKED the user to confirm a town. Suppressing them matters for
 * the same reason: ordinary language must not become a place-clarification request.
 */
const CLARIFY_WORDS: Array<[string, string]> = [
  ["almost", "Almont, MI"], ["still", "Estill, SC"], ["where", "Ware, MA"],
  ["during", "Suring, WI"], ["below", "Bell, CA"], ["toward", "Coward, SC"],
];

let stillPhantom: string[] = [];
for (const [w, was] of [...PHANTOM_WORDS, ...CLARIFY_WORDS]) {
  const q = `murders in ${w} in 2024`;
  const got = identity(q);
  if (mentionCount(q) !== 0) stillPhantom.push(`${w} -> ${got} (was ${was})`);
}
check(stillPhantom.length === 0,
  `all ${PHANTOM_WORDS.length + CLARIFY_WORDS.length} measured collisions must be gone; still resolving: ${JSON.stringify(stillPhantom)}`);
console.log(`  measured collisions: ${PHANTOM_WORDS.length} confident + ${CLARIFY_WORDS.length} clarify-only; still resolving: ${stillPhantom.length}`);

/*
 * THE EXACT-MATCH DISTINCTION, and why this is not a word ban. `early` is an ordinary English word
 * AND a real town, so it is in the vocabulary — yet it must keep resolving, because the exact
 * matcher runs first and the fuzzy fallback fires only when exact matching finds nothing. Same for
 * Reading, Mobile and Enterprise in section D.
 */
check(identity("murders in early in 2024") === "Early, TX",
  `exact control: "early" must still resolve to Early, TX (got ${identity("murders in early in 2024") ?? "none"})`);

/* ------------------------------------------------------------------ */
/*  D - explicit place references, with city AND state                 */
/* ------------------------------------------------------------------ */
console.log("");
console.log("D - explicit places keep resolving (exact path)");

const EXACT_PLACES: Array<[string, string]> = [
  ["murders in Ball, LA in 2024", "Ball, LA"],
  ["murders in Tye, TX in 2024", "Tye, TX"],
  ["murders in Ward, AR in 2024", "Ward, AR"],
  ["murders in Largo, FL in 2024", "Largo, FL"],
  ["murders in New Orleans, LA in 2024", "New Orleans, LA"],
  ["murders in Reading, PA in 2024", "Reading, PA"],
  ["murders in Mobile, AL in 2024", "Mobile, AL"],
  ["murders in Enterprise, AL in 2024", "Enterprise, AL"],
];
for (const [q, want] of EXACT_PLACES) {
  const got = identity(q);
  check(got === want, `${JSON.stringify(q)} must resolve to ${want} (got ${got ?? "none"})`);
}

/* ------------------------------------------------------------------ */
/*  E - supported typo corrections, with city AND state                */
/* ------------------------------------------------------------------ */
console.log("");
console.log("E - supported typo corrections survive");

const TYPOS: Array<[string, string]> = [
  ["murders in new orlens in 2024", "New Orleans, LA"],
  ["murders in chicagoo in 2023", "Chicago, IL"],
  ["murders in phenix in 2024", "Phoenix, AZ"],
  ["murders in detriot in 2024", "Detroit, MI"],
  ["murders in atlnta in 2024", "Atlanta, GA"],
  ["new orlens crime rate", "New Orleans, LA"],
];
for (const [q, want] of TYPOS) {
  const got = identity(q);
  check(got === want, `${JSON.stringify(q)} must still resolve to ${want} (got ${got ?? "none"})`);
}

/*
 * DISCLOSED, UNCHANGED, AND NOT CERTIFIED CORRECT. `san antnio` and `philadelpia` reach a town of
 * that name in the WRONG STATE, because fuzzy candidate ranking ignores population. That is a
 * separate defect with its own existing test; the only property asserted here is that this guard
 * does not change it. The state is printed, never asserted as right.
 */
for (const [q, note] of [
  ["car theft in san antnio 2021", "existing test asserts the NAME only"],
  ["murders in philadelpia in 2024", "same ranking limitation"],
] as const) {
  const got = identity(q);
  console.log(`  UNCHANGED, not certified: ${JSON.stringify(q)} -> ${got ?? "none"}  (${note})`);
  check(got !== null, `${JSON.stringify(q)} must keep resolving exactly as before this guard`);
}
/*
 * `bal` does NOT resolve through the public resolver today (a raw fuzzy candidate is not an accepted
 * resolver result). Unchanged is the requirement; making it resolve is not part of this repair.
 */
console.log(`  baseline, unchanged: "murders in bal in 2024" -> ${identity("murders in bal in 2024") ?? "none"}`);
check(mentionCount("murders in bal in 2024") === 0, '"bal" must stay unresolved, as it was before this guard');

/* ------------------------------------------------------------------ */
/*  F - the correction hint sent to the model                          */
/* ------------------------------------------------------------------ */
console.log("");
console.log("F - correction hints");

check(/New Orleans, LA/.test(geoCorrectionHint("murders in new orlens in 2024") ?? ""),
  `a real typo must still produce its hint (got ${JSON.stringify(geoCorrectionHint("murders in new orlens in 2024"))})`);
/*
 * `chicagoo` produces NO hint, and always did: `geoCorrectionHint` skips a mention whose canonical
 * name already appears in the question, and "chicago" is a substring of "chicagoo". Unchanged null
 * is the baseline here, not a successful positive.
 */
check(geoCorrectionHint("murders in chicagoo in 2023") === null,
  "chicagoo's hint stays null (canonical name is a substring of the typo) — baseline, not a positive");
for (const w of ["all", "the", "large", "most"]) {
  const q = `murders in ${w} cities in 2024`;
  check(geoCorrectionHint(q) === null, `no phantom hint for ${JSON.stringify(q)} (got ${JSON.stringify(geoCorrectionHint(q))})`);
}

/* ------------------------------------------------------------------ */
/*  G - the accepted Ward behaviour is untouched                       */
/* ------------------------------------------------------------------ */
console.log("");
console.log("G - Ward: the real town resolves, sub-city stays refused");

{
  const q = "how many murders were there in Ward 3 in New Orleans in 2024";
  check(identity(q) === "New Orleans, LA", `Ward 3 question must still resolve the city (got ${identity(q) ?? "none"})`);
  // Resolving the city does NOT make ward-level data answerable — the accepted sub-city predicate
  // must still recognise this question. The full behaviour suite is test-subcity-ward-behavior.ts.
  check(asksSubCityGeography(q) === true, "the Ward 3 question must still be recognised as sub-city geography");
  check(asksSubCityGeography("murders in Ward, AR in 2024") === false,
    "the real town Ward, AR must not be treated as sub-city geography");
}

/* ------------------------------------------------------------------ */
/*  H - the vocabulary itself                                          */
/* ------------------------------------------------------------------ */
console.log("");
console.log("H - the vocabulary is language, frozen and bounded");

console.log(`  entries: ${COMMON_ENGLISH_WORD_COUNT}`);
// Pinned so the list cannot grow quietly into an unbounded dictionary project. Changing it is a
// deliberate edit with a reason, not a side effect.
check(COMMON_ENGLISH_WORD_COUNT === 473, `vocabulary size must be 473 (got ${COMMON_ENGLISH_WORD_COUNT})`);
check(COMMON_ENGLISH_WORD_COUNT < 1000, "the vocabulary must stay a curated list, not a dictionary");
// It holds language, not town names. None of these belongs in it.
for (const place of ["ball", "tye", "ward", "largo", "chicago", "houston", "orleans", "dover", "post", "war"]) {
  check(!isCommonEnglishWord(place), `"${place}" is a place name and must not be in the vocabulary`);
}
// A word can be both ordinary English and a real town. "early" is in the vocabulary because it is
// ordinary English — and section C proves Early, TX still resolves, because exact matching runs
// first. That overlap is the intended design, not an exception.
check(isCommonEnglishWord("early") === true, '"early" belongs in the vocabulary as ordinary English');
check(isCommonEnglishWord("") === false, "an empty token must never count as a common word");
check(isCommonEnglishWord("all cities") === false, "the predicate takes one token, not a phrase");
check(isCommonEnglishWord("ALL") === true, "lookup must be case-insensitive, matching the resolver's token keys");

/* ------------------------------------------------------------------ */
/*  I - crime/data vocabulary (lib/crime-vocabulary.ts, 2026-10-20)    */
/* ------------------------------------------------------------------ */
console.log("");
console.log("I - crime/data vocabulary is not a spelling correction");

{
  // I1. The frozen codebook words equal a fresh extraction from the shipped CDE fixtures, by the documented rule.
  const DIR = path.join(__dirname, "fixtures", "cde");
  const COLUMNS: Record<string, string[]> = {
    "NIBRS_OFFENSE_TYPE.csv": ["offense_name", "crime_against", "offense_category_name"],
    "NIBRS_WEAPON_TYPE.csv": ["weapon_name"], "NIBRS_LOCATION_TYPE.csv": ["location_name"],
    "NIBRS_BIAS_LIST.csv": ["bias_category", "bias_desc"], "NIBRS_VICTIM_TYPE.csv": ["victim_type_name"],
    "NIBRS_RELATIONSHIP.csv": ["relationship_name"], "NIBRS_CLEARED_EXCEPT.csv": ["cleared_except_name"],
    "NIBRS_PROP_DESC_TYPE.csv": ["prop_desc_name"], "NIBRS_PROP_LOSS_TYPE.csv": ["prop_loss_name"],
    "NIBRS_SUSPECTED_DRUG_TYPE.csv": ["suspected_drug_name"], "NIBRS_ETHNICITY.csv": ["ethnicity_name"], "REF_RACE.csv": ["race_desc"],
  };
  const parseCsv = (text: string): Record<string, string>[] => {
    const rows: string[][] = []; let row: string[] = []; let f = ""; let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
      else if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; } else f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    const [h, ...rest] = rows.filter((r) => r.some((x) => x !== ""));
    return rest.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""])));
  };
  const labels: string[] = [];
  for (const [file, cols] of Object.entries(COLUMNS)) for (const r of parseCsv(fs.readFileSync(path.join(DIR, file), "utf8"))) for (const c of cols) labels.push(r[c]);
  const shr = JSON.parse(fs.readFileSync(path.join(DIR, "shr-codebook.json"), "utf8"));
  for (const k of ["weapon", "relationship", "circumstance"]) for (const v of Object.values(shr[k] as Record<string, unknown>)) labels.push(typeof v === "string" ? v : String((v as { name?: string }).name ?? ""));
  const fresh = new Set<string>(); const exactPlaces = new Set<string>();
  for (const l of labels) for (const w of l.toLowerCase().split(/[^a-z]+/)) {
    if (w.length < 3 || isCommonEnglishWord(w) || fresh.has(w) || exactPlaces.has(w)) continue;
    const exact = resolveGeoPlaces(w).mentions.some((m) => m.candidates.length > 0 && !/fuzzy/i.test(m.reason ?? "") && m.text.toLowerCase() === w);
    if (exact) exactPlaces.add(w); else fresh.add(w);
  }
  const frozen = [...CODEBOOK_WORD_LIST].sort().join(" ");
  check(frozen === [...fresh].sort().join(" "), "the frozen codebook words must equal a fresh extraction from scripts/fixtures/cde");
  check([...exactPlaces].sort().join(" ") === "alaska arab center foster friend garden mission pacific register rifle temple",
    `the excluded exact-place words changed: ${[...exactPlaces].sort().join(" ")}`);
  // I2. Bounded and separate: the ordinary-English list (with its second consumer) is unchanged.
  check(CODEBOOK_WORD_COUNT === 499, `codebook words must be 499 (got ${CODEBOOK_WORD_COUNT})`);
  check(PRODUCT_TERM_COUNT === 12, `product terms must be 12 (got ${PRODUCT_TERM_COUNT})`);
  check(!isCommonEnglishWord("hate") && !isCommonEnglishWord("crime"), "the ordinary-English list must be unchanged (its SHR consumer is out of scope)");
  for (const place of ["alaska", "rifle", "temple", "taft", "fate", "crane", "americus"]) check(!isCrimeVocabularyWord(place), `"${place}" is a place name and must not be crime vocabulary`);
  check(isCrimeVocabularyWord("thefts") && isCrimeVocabularyWord("robberies") && isCrimeVocabularyWord("crimes"), "simple plurals must count");
  check(!isCrimeVocabularyWord("") && !isCrimeVocabularyWord("hate crime"), "one token only; empty never matches");

  // I3. The measured phantoms (probe, 2026-10-20): no correction hint and no fuzzy place for any of them.
  const words = ["hate", "crime", "crimes", "theft", "thefts", "drugs", "gambling", "clearance", "arsons", "auto", "bank", "park", "gang", "guns", "adult", "age", "america", "ori"];
  const templates = ["Number of {w} by year", "Show the trend of {w} since 2015", "What were the locations of {w} crimes in 2023?",
    "Rise in {w} since 2020", "Increase in {w} nationally", "Data for {w} in 2023", "Changes in {w} over time", "Percent of {w} involving guns"];
  for (const w of words) for (const t of templates) {
    const q = t.replace("{w}", w);
    check(geoCorrectionHint(q) === null, `no correction hint for "${q}" (got ${geoCorrectionHint(q)})`);
    check(identity(q) === null, `no place for "${q}" (got ${identity(q)})`);
  }
  // I4. Real questions from the production query log that the live release turned into phantom towns.
  for (const q of ["What were the most common locations of hate crimes in 2023?", "Show me trends in hate crime",
    "What is the trend for crime on transit systems?", "I want to learn about racial disparities in clearance rates",
    "which 5 cities saw the biggest swings in auto thefts from 2021 to 2023?", "homicide rates for gender and race",
    "trend for white collar property crime", "show me the change in non-violent crimes from 2000 to 2015",
    "number of homicides for non-Hispanic Whites and non-Hispanic Blacks", "What is the crime rate in America?"]) {
    check(geoCorrectionHint(q) === null, `no phantom correction for "${q}" (got ${geoCorrectionHint(q)})`);
  }
  // I5. Exact places that share these words still resolve; real typos are still corrected.
  for (const [q, want] of [["theft in Taft, CA", "Taft, CA"], ["hate crimes in Fate, TX", "Fate, TX"], ["crime in Crane, MO", "Crane, MO"],
    ["Crime in Americus, GA", "Americus, GA"], ["drug arrests in Driggs, ID", "Driggs, ID"], ["murders in new orlens", "New Orleans, LA"]] as const) {
    check(identity(q) === want, `"${q}" must resolve to ${want} (got ${identity(q) ?? "none"})`);
  }
  check(/New Orleans, LA/.test(geoCorrectionHint("murders in new orlens") ?? ""), "a real typo must still get its correction hint");
}

console.log("");
console.log(`checks: ${checks}   failures: ${failures}`);
if (failures > 0) { console.log("RESULT: FAIL"); process.exit(1); }
console.log("RESULT: PASS");
