/**
 * The shadow slice (lib/nibrs-shadow) takes a question to an answer, a clarifying question or a decline as the decided
 * policy says, and its scoring (lib/answer-eval/shadow.ts) judges those outcomes. Offline: the DuckDB step is a stub
 * that returns rows shaped like the compiled query's, so this checks the pipeline and the delivered answer, never the
 * numbers (scripts/nibrs-compile-gate.ts and the runner do that against a canonical build). No database, no model.
 */
import { CIRCUMSTANCE } from "../lib/nibrs-plan/draft-layer";
import assert from "node:assert/strict";
import fs from "node:fs";
import { shadowAnswer, shadowFollowUp, type ShadowDeps, type ShadowOutcome } from "../lib/nibrs-shadow/answer";
import { jargon, UNMAPPED } from "../lib/nibrs-shadow/wording";
import { agencyLabel, agencyName, candidateLabel, loadPlaceIndex, nearestPlaceName, reportedBy, resolvePlace, STATE_NAMES } from "../lib/nibrs-shadow/places";
import { agencyPopulationSql } from "../lib/nibrs-plan/compile";
import { coveredText } from "../lib/nibrs-shadow/state-sum";
import { deliver, periodWords } from "../lib/nibrs-shadow/deliver";
import { readQuestion } from "../lib/nibrs-shadow/reading";
import { matchNibrsType } from "../lib/nibrs-question-types";
import { missingGroupings, namedGroupings } from "../lib/nibrs-shadow/named-groupings";
import { scoreShadow, sliceValues, valueDiffs } from "../lib/answer-eval/shadow";
import { compareMeaning, fbiNameFor, planToMeaning } from "../lib/answer-eval/compare";
import { gates } from "../lib/answer-eval/gates";
import type { Case } from "../lib/answer-eval/case";

const places = loadPlaceIndex();
const sqls: string[] = [];
/** Rows for the compiled query: every month (or year) of the period, 7 each, March 2024 unknown. */
function stub(sql: string): unknown[][] {
  sqls.push(sql);
  // Increment 4. Populations (the canonical agency file) and several agencies' monthly grids: see POP and GRID below.
  // P90: the Consistent Reporting Agencies' current populations (an agency with none has no row).
  if (/current_population/.test(sql)) return [...sql.matchAll(/'([A-Z]{2}[A-Z0-9]{7})'/g)].map((m) => [m[1], POP[m[1]] === undefined ? 100_000 : POP[m[1]]]).filter((r) => r[1] !== null);
  if (sql.includes("agency/data.parquet")) return popRows(sql);
  // A state sum's grid summed by agency and year (state-sum.ts): the stub sums its own monthly grid the same way.
  if (/repsum/.test(sql)) {
    const by = new Map<string, unknown[]>();
    for (const [ori, ym, n, st] of gridRows(sql) as [string, string, number | null, string][]) {
      const k = `${ori}|${ym.slice(0, 4)}`, rep = st === "VALUE" || st === "REPORTED_ZERO";
      const a = (by.get(k) ?? by.set(k, [ori, Number(ym.slice(0, 4)), 0, 0, 0, 0]).get(k)!) as number[];
      a[2]++; if (rep) { a[3]++; a[4] += n ?? 0; } if (st === "EVIDENCE_CONFLICT") a[5]++;
    }
    return [...by.values()];
  }
  if (/unnest\(\[.*\]\) AS ori/.test(sql)) return gridRows(sql);
  // A one-category breakdown over a period: F 30 (share 0.6), M 20 (0.4), U unknown.
  // The same with the incidents beside the count (P66): one incident had a female and a male victim (12 + 9 > 20).
  if (/cats AS/.test(sql) && !/AS period/.test(sql) && /_incidents"/.test(sql)) return [["F", 14, "VALUE", 12, "VALUE", 0.6, "VALUE"], ["M", 10, "VALUE", 9, "VALUE", 0.4, "VALUE"], ["U", null, "UNKNOWN", null, "UNKNOWN", null, "UNKNOWN"]];
  // Age groups out of order, with an age recorded as unknown and one not recorded (P86 merges them into one Unknown).
  // Offenders by their own race: Unknown the largest, still listed last (coordinator 2026-11-02).
  if (/cats AS/.test(sql) && !/AS period/.test(sql) && /ELSE f\.race END/.test(sql)) return [["U", 50, "VALUE", 0.625, "VALUE"], ["W", 10, "VALUE", 0.125, "VALUE"], ["B", 20, "VALUE", 0.25, "VALUE"]];
  if (/cats AS/.test(sql) && !/AS period/.test(sql) && /THEN 'Under 18'/.test(sql))
    return [["25-34", 20, "VALUE", 0.4, "VALUE"], ["Unknown", 5, "VALUE", 0.1, "VALUE"], ["Under 18", 15, "VALUE", 0.3, "VALUE"], [null, 10, "VALUE", 0.2, "VALUE"]];
  if (/cats AS/.test(sql) && !/AS period/.test(sql)) return [["F", 30, "VALUE", 0.6, "VALUE"], ["M", 20, "VALUE", 0.4, "VALUE"], ["U", null, "UNKNOWN", null, "UNKNOWN"]];
  const [, from, to] = /range\(DATE '(\d{4}-\d{2})-01', DATE '(\d{4}-\d{2})-01'/.exec(sql)!;
  const months: string[] = [];
  for (let y = +from.slice(0, 4), m = +from.slice(5); `${y}-${String(m).padStart(2, "0")}` <= to; m === 12 ? (y++, (m = 1)) : m++) months.push(`${y}-${String(m).padStart(2, "0")}`);
  const cell = (k: string): [number | null, string] => (k === "2024-03" ? [null, "UNKNOWN"] : [7, "VALUE"]);
  if (/AS period/.test(sql) && /substr\(ym, 1, 4\) AS period/.test(sql)) {
    const years = [...new Set(months.map((m) => m.slice(0, 4)))];
    return years.map((y) => (months.some((m) => m.startsWith(y) && cell(m)[0] === null) ? [y, null, "UNKNOWN"] : [y, 7 * months.filter((m) => m.startsWith(y)).length, "VALUE"]));
  }
  if (/AS period/.test(sql)) return months.map((m) => [m, ...cell(m)]);
  // A total with its incidents beside it (P66): the count, then the incidents (5 a month), each with its status.
  if (/_incidents"/.test(sql)) return months.some((m) => cell(m)[0] === null) ? [[null, "UNKNOWN", null, "UNKNOWN"]] : [[7 * months.length, "VALUE", 5 * months.length, "VALUE"]];
  return months.some((m) => cell(m)[0] === null) ? [[null, "UNKNOWN"]] : [[7 * months.length, "VALUE"]];
}
/** Populations by ORI (null: the FBI gives none), and Texas's city agencies. */
const POP: Record<string, number | null> = { OK0720500: 400_000, OK0550600: 700_000, KS0870300: 400_000, NC0410200: 300_000, NC0920100: null,
  TXHPD0000: 2_300_000, TXDPD0000: 1_300_000, TX2270100: 970_000, TX9999900: 0 };
const TX = { TXHPD0000: "HOUSTON", TXDPD0000: "DALLAS", TX2270100: "AUSTIN", TX9999900: "SMALLVILLE" } as Record<string, string>;
function popRows(sql: string): unknown[][] {
  const years = /data_year IN \(([\d, ]+)\)/.exec(sql)![1].split(", ").map(Number);
  // Increment 5's header universe (a state or the nation): Texas's agencies above, and two agencies of 100,000 in
  // each other state asked (SS0000001, SS0000002).
  const hdr = /u\.state_abbr IN \(([^)]*)\)/.exec(sql);
  if (hdr) {
    const states = hdr[1].split(", ").map((x) => x.slice(1, -1));
    // North Carolina: Raleigh (no FBI population) and Greensboro (300,000).
    const oris = states.flatMap((s) => (s === "TX" ? Object.keys(TX) : s === "NC" ? ["NC0920100", "NC0410200"] : [`${s}0000001`, `${s}0000002`]));
    return oris.flatMap((o) => years.map((y) => [o, y, POP[o] === undefined ? 100_000 : POP[o], o.slice(0, 2)]));
  }
  const oris = sql.includes("u.state_abbr = 'TX'") ? Object.keys(TX) : [...sql.matchAll(/'([A-Z]{2}[A-Z0-9]{7})'/g)].map((m) => m[1]);
  return oris.flatMap((o) => years.map((y) => [o, y, POP[o] ?? null, TX[o] ?? "", o.slice(0, 2)]));
}
/** An agency-month whose records conflict with its reporting status, when a test sets one. */
let CONFLICT: { ori: string; ym: string } | null = null;
/** Monthly grid: Houston 9 a month, Dallas 7, the rest 5; Greensboro unknown November-December 2025, Austin June 2024. */
function gridRows(sql: string): unknown[][] {
  const oris = /unnest\(\[(.*?)\]\) AS ori/.exec(sql)![1].split(", ").map((x) => x.slice(1, -1));
  const [, from, to] = /range\(DATE '(\d{4}-\d{2})-01', DATE '(\d{4}-\d{2})-01'/.exec(sql)!;
  const rows: unknown[][] = [];
  for (const o of oris) for (let y = +from.slice(0, 4), m = +from.slice(5); `${y}-${String(m).padStart(2, "0")}` <= to; m === 12 ? (y++, (m = 1)) : m++) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    const unknown = (o === "NC0410200" && ym >= "2025-11" && ym <= "2025-12") || (o === "TX2270100" && ym === "2024-06");
    rows.push(CONFLICT && CONFLICT.ori === o && CONFLICT.ym === ym ? [o, ym, null, "EVIDENCE_CONFLICT"]
      : unknown ? [o, ym, null, "UNKNOWN"] : [o, ym, o === "TXHPD0000" ? 9 : o === "TXDPD0000" ? 7 : 5, "VALUE"]);
  }
  return rows;
}
const deps: ShadowDeps = {
  places, release: { id: "test-release", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" },
  target: { root: "/build", builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] }, execute: stub,
};
const ask = (q: string) => shadowAnswer(q, deps);
const as = <K extends ShadowOutcome["kind"]>(o: ShadowOutcome, k: K) => { assert.equal(o.kind, k, JSON.stringify(o).slice(0, 300)); return o as Extract<ShadowOutcome, { kind: K }>; };

// Places (P16, P28): a city is its principal police agency; a name with several real candidates of 100,000+ residents
// (cities in two states, a city and a county, a state) is asked about, cities first.
const at = (v: string, text: string) => resolvePlace(places, v, text);
const ori = (r: ReturnType<typeof at>) => (r.kind === "agency" ? r.agency.ori : r.kind);
const asked = (r: ReturnType<typeof at>) => (r.kind === "ask" ? r.candidates.map((c) => candidateLabel(c, r.candidates)) : r.kind);
assert.equal(ori(at("city:Memphis:TN", "Memphis")), "TNMPD0000");
assert.deepEqual(asked(at("ambiguous:Baltimore", "Baltimore")), ["Baltimore city, Maryland", "Baltimore County, Maryland"]);
assert.deepEqual(asked(at("ambiguous:St Louis", "St Louis")), ["St. Louis city, Missouri", "St. Louis County, Missouri"], "St. Louis County, Minnesota is under 100,000");
assert.deepEqual(asked(at("ambiguous:Washington", "Washington")), ["Washington, D.C.", "Washington state", "Washington County, Oregon", "Washington County, Maryland"]);
assert.deepEqual(asked(at("ambiguous:Kansas City", "Kansas City")), ["Kansas City, Missouri", "Kansas City, Kansas"]);
assert.deepEqual(asked(at("city:Columbus:OH", "Columbus")), ["Columbus, Ohio", "Columbus, Georgia"], "the reader's filled-in state is not the question's");
assert.equal(ori(at("city:Columbus:OH", "Columbus, Ohio")), "OHCOP0000");
assert.equal(ori(at("city:Washington:DC", "Washington DC")), "DCMPD0000");
assert.equal(ori(at("county:Baltimore County:MD", "Baltimore County")), "MD0030100");
assert.equal(ori(at("city:Portland:OR", "Portland")), "OR0260200", "Portland, Maine is under 100,000");
assert.equal(at("city:Nowhere:TX", "Nowhere").kind, "unresolved");
// The shared index (coordinator 2026-11-02): the crosswalk's place names are aliases; Crime Index agencies NIBRS lacks are
// in it; an agency's own name wins over another's alias in the same state.
assert.equal(ori(at("city:New York City:NY", "New York City")), "NY0303000", "the crosswalk's \"new york city\"");
assert.equal(ori(at("county:Jefferson County:LA", "Jefferson Parish")), "LA0260000", "a Crime Index parish NIBRS lacks");
assert.equal(ori(at("county:Jefferson Parish:LA", "Jefferson Parish, Louisiana")), "LA0260000");
assert.equal(ori(at("city:Louisville:KY", "Louisville")), "KY0568000", "not the old county police's \"louisville county\"");
assert.equal(ori(at("city:Flint:MI", "Flint")), "MI2539800", "not Flint Township's mailing city \"flint\"");
// "Borough" is a town's, never a county's (Codex places review 01).
assert.equal(ori(at("ambiguous:Baldwin Borough", "Baldwin Borough")), "PA0020100");
assert.equal(ori(at("city:Freehold Borough:NJ", "Freehold Borough")), "NJ0131500");
assert.equal(ori(at("ambiguous:Middlesex Borough", "Middlesex Borough")), "NJ0121100");
assert.equal(at("ambiguous:Orleans Parish", "Orleans Parish").kind, "unresolved", "never Orleans County, New York");
assert.equal(at("county:Orleans County:LA", "Orleans Parish, Louisiana").kind, "unresolved");
// No population floor (Jeff 2026-11-03): every city and county agency is in the index, so same-name towns ask a short
// list, never dozens; a name with one clearly main city (twice the next) is that city; a city's name is a city (P16).
assert.ok(places.byName.get("clinton")!.length > 20 && places.byName.get("franklin")!.length > 20, "dozens of same-name agencies");
assert.deepEqual(asked(at("ambiguous:Springfield", "Springfield")), ["Springfield, Missouri", "Springfield, Massachusetts", "Springfield, Illinois"]);
const clinton = at("city:Clinton:IA", "Clinton");
assert.ok(clinton.kind === "ask" && clinton.candidates.length === 3 && clinton.more, "Clinton: three towns, one per state, and the rest one step away");
assert.deepEqual(asked(at("city:Greenville:SC", "Greenville")), ["Greenville, North Carolina", "Greenville city, South Carolina", "Greenville, Texas", "Greenville County, South Carolina"]);
assert.equal(ori(at("city:Franklin:TN", "Franklin")), places.byName.get("franklin")!.find((x) => x.state === "TN" && x.kind === "city")!.ori, "Franklin, Tennessee is twice any other Franklin");
assert.equal(at("city:Clinton:MI", "Clinton, Michigan").kind, "agency", "a state named settles it");
assert.equal((at("city:Clinton:MI", "Clinton, Michigan") as { agency: { kind: string } }).agency.kind, "city", "Clinton, Michigan is the city, not Clinton County");
{
  const c = as(ask("Shoplifting in Clinton in 2024"), "clarify");
  assert.equal(c.options.length, 4);
  assert.deepEqual(c.options.at(-1), { label: "Another Clinton", entry: "which city or agency" });
}

// "LA" asks Los Angeles or Louisiana; after a place it qualifies, it stays the state (coordinator 2026-11-03).
{
  const la = as(ask("LA murder trend"), "clarify");
  assert.deepEqual(la.options.map((o) => o.label), ["Los Angeles", "Louisiana"]);
  assert.notEqual(ask("Shoplifting in Baton Rouge, LA in 2024").kind, "clarify");
  assert.notEqual((ask("Shoplifting in La Crosse in 2024") as { about?: string }).about, "which LA");
  assert.notEqual((ask("Shoplifting in LA CROSSE in 2024") as { about?: string }).about, "which LA", "Codex review 01.6: a name in capitals");
}
// A misspelled large place is read as it: one large place within two edits, same first letter (coordinator 2026-11-03).
assert.equal(nearestPlaceName(places, "batlimore"), "Baltimore");
assert.equal(nearestPlaceName(places, "phialdelphia"), "Philadelphia");
assert.equal(nearestPlaceName(places, "Memphis"), null, "a place the index has is not corrected");
assert.equal(nearestPlaceName(places, "index"), null);
// Wrong places in silence (coordinator 2026-11-05, Codex's baseline findings and the query-log search).
// A misspelling never takes the state the geo resolver chose for it; words naming more than the place still do.
assert.equal(ori(at("city:Philadelphia:MS", "Philadlephia")), ori(at("city:Philadelphia:PA", "Philadelphia, Pennsylvania")), "not Philadelphia, Mississippi");
assert.equal((at("city:San Antonio:FL", "san antnio") as { agency: { state: string } }).agency.state, "TX");
assert.equal((at("city:Charlotte:NC", "City of Charlotte") as { agency: { state: string } }).agency.state, "NC");
assert.equal((at("city:Kansas City:KS", "kck") as { agency: { state: string } }).agency.state, "KS");
// A small place a letter or two from a large one asks, the large one first.
assert.deepEqual(asked(at("ambiguous:Pittsburg", "Pittsburg")), ["Pittsburgh, Pennsylvania", "Pittsburg, California"]);
assert.deepEqual(asked(at("ambiguous:Berkley", "Berkley")), ["Berkeley, California", "Berkley, Michigan"]);
assert.deepEqual(asked(at("county:Prince George County:", "prince George county")), ["Prince George's County, Maryland", "Prince George County, Virginia"]);
// A county named without its state, in several states, none large, asks: a sheriff's population is not the county's.
assert.deepEqual(asked(at("county:Mecklenburg County:", "mecklenburg county")), ["Mecklenburg County, Virginia", "Mecklenburg County, North Carolina"]);
assert.equal(ori(at("county:Harris County:", "Harris County")), places.byName.get("harris")!.find((x) => x.state === "TX" && x.kind === "county")!.ori, "one large county of the name is it");
// "<name> Police Department": the city's, unless a large county police department of the name is in another state
// (query-log scorecard 2026-11-05: Arlington, Texas or Arlington County, Virginia); an agency's noun names no state.
assert.deepEqual(asked(at("city:Arlington:TX", "Arlington Police Department")), ["Arlington, Texas", "Arlington County, Virginia"]);
assert.equal((at("city:Baltimore:MD", "Baltimore Police Department") as { agency: { kind: string } }).agency.kind, "city", "Baltimore County's police is \"Baltimore County\"");
assert.equal(ori(at("city:Los Angeles:CA", "Los Angeles Police Department")), places.byName.get("los angeles")!.find((x) => x.kind === "city" && x.state === "CA")!.ori);
assert.equal(ori(at("city:Arlington:TX", "Arlington Police Department, Texas")), places.byName.get("arlington")!.find((x) => x.kind === "city" && x.state === "TX")!.ori);
// Words before a county at the start of a question are not its name.
assert.equal((at("county:Just Show Worcester County:MD", "just show worcester county, md") as { agency: { name: string } }).agency.name, "Worcester County");
{
  // "Tarrant County, Texas" is the county, never Tarrant, Alabama; a state code in lower case counts, "in" does not.
  const county = (q: string) => readQuestion(q, 2026, "2026-09").ledger.parts.filter((p) => p.concept === "place").map((p) => p.value);
  assert.deepEqual(county("show me homicides in tarrant county, texas 2020 - 2025"), ["county:Tarrant County:TX"]);
  assert.deepEqual(county("murders in Tarrant County in 2024"), ["county:Tarrant County:"]);
  assert.deepEqual(county("number of homicides in richland county oh in 2025"), ["county:Richland County:OH"]);
  assert.deepEqual(county("Show me violent crime trends in Mecklenburg county in North Carolina between 2002 and 2024"), ["county:Mecklenburg County:NC"]);
  assert.deepEqual(county("murders in Orleans Parish in 2024"), ["county:Orleans Parish:"]);
  assert.deepEqual(county("murders in each county in Texas in 2024").filter((v) => /^county/.test(v ?? "")), []);
  // Codex place review 01: "in" is Indiana only in capitals; "South King County" keeps its "South"; a sheriff's office
  // belongs to the county.
  assert.deepEqual(county("murders in Montgomery County, in 2024"), ["county:Montgomery County:"]);
  assert.deepEqual(county("murders in Montgomery County, IN in 2024"), ["county:Montgomery County:IN"]);
  assert.deepEqual(county("violent crime for tarrant county sheriff's office, texas in 2024"), ["county:Tarrant County:TX"]);
  assert.deepEqual(county("murders in King County Sheriff's Office, Washington in 2024"), ["county:King County:WA"], "Codex place review 02");
  assert.deepEqual(county("murders in King County Sheriffs Office, Washington in 2024"), ["county:King County:WA"], "Codex place review 03");
  assert.notEqual(ask("murders of King County sheriffs in Washington in 2024").kind, "historical", "sheriffs killed are people, not the agency (Codex place review 04)");
  assert.equal(at("county:South King County:WA", "South King County, Washington").kind, "unresolved");
  assert.notEqual(ask("murders in Big Spring 2024").kind, "clarify", "Big Spring is a city, not a season");
  // A season before a year is never a place ("Spring 2024" had answered Spring Township, Pennsylvania).
  assert.deepEqual(county("murders in Spring 2024"), []);
  assert.notEqual(ask("murders in Spring 2024").kind, "historical");
}
// "in total" with the period asked: each button answers, never the same question again ("murders in Total" crashed).
{
  const c = as(ask("murders in total nationally"), "clarify");
  assert.equal(c.about, "which period");
  assert.ok(c.options.every((o) => o.entry || (o.continuation && o.continuation.kind !== "clarify")), "every button runs");
  assert.notEqual(ask("murders in Total").kind, "decline");
}

// A place's state is its postal code, never an ORI prefix (coordinator 2026-11-03: Nebraska's agencies are "NB...").
assert.ok([...places.byName.values()].flat().every((x) => x.state in STATE_NAMES), "every agency's state is a postal code");
assert.equal(ori(at("city:Omaha:NE", "Omaha, NE")), "NB0280200");
assert.equal(agencyLabel(places.byName.get("omaha")![0]), "Omaha, Nebraska");
assert.ok(agencyPopulationSql("r", { state: "NE", city: true }, [2024]).includes("IN ('NE', 'NB')"), "a state's city agencies under every header code");
assert.ok(places.byName.get("new york city")!.every((x) => x.ori === "NY0303000"));

// Shared decline wording (coordinator 2026-11-03, Historical step one causes 3 and 7): a place the index doesn't have
// says so, never P01's "figures don't answer"; asks outside the data name their limit; the nation is "the United States"
// in an offered question, never "in nationwide".
{
  // Every agency is in the index (no population floor, Jeff 2026-11-03), so the place is taken out of a copy of it.
  const noEcorse = { ...places, byName: new Map([...places.byName].filter(([k]) => k !== "ecorse")) };
  const unfound = as(shadowAnswer("Murders in Ecorse, Michigan in 2020", { ...deps, places: noEcorse }), "decline");
  assert.equal(unfound.reason, "unresolved_place");
  assert.match(unfound.explanation, /^I couldn't find "Ecorse, Michigan" among the city and county police agencies, states and the nation here\./);
  assert.equal(at("city:Ecorse:MI", "Ecorse, Michigan").kind, "agency", "a town of under 10,000 people is in the index");
  assert.doesNotMatch(unfound.explanation, /don't answer this question/);
  const outside: [string, RegExp][] = [
    ["Memphis crime on a map", /^Maps aren't available here/],
    ["US population per year since 1960", /^Population figures on their own aren't available here/],
    ["Can you give me a list of Hawaii law enforcement agencies ordered by population covered in 2024?", /^A list of agencies/],
    ["How common is cybercrime in New Hampshire?", /^Cybercrime isn't one category/],
    ["Thefts on college campuses in New Jersey in 2020", /^College and university police agencies/],
    ["Can I see a data set of all crimes by type across the US from 2020 to present", /^A whole data set isn't available here/],
  ];
  for (const [q, re] of outside) assert.match(as(ask(q), "decline").explanation, re, q);
  assert.equal(ask("College Station robberies in 2024").kind !== "decline" || !/College and university/.test((ask("College Station robberies in 2024") as { explanation: string }).explanation), true, "a place named College is not a campus");
  assert.ok(ask("Memphis population and robbery rate in 2023").kind === "decline" ? !/^Population figures/.test((ask("Memphis population and robbery rate in 2023") as { explanation: string }).explanation) : true, "population beside a crime is not the population-only limit");
  const nation = as(ask("show homicides and total violent crimes nationwide by year for 2000 to 2025"), "decline");
  assert.doesNotMatch(nation.explanation + (nation.alternative?.question ?? ""), /\bin nationwide\b/);
}

// An answer: the plan, the compiled read, the delivered table and text (source statement last, D30).
const a = as(ask("How many shoplifting offenses were there in Memphis in 2023?"), "answer");
assert.deepEqual(a.period, { from: "2023-01", to: "2023-12" });
assert.equal(a.plan.measures[0].id, "offenses.shoplifting");
assert.ok(sqls.at(-1)!.includes("'TNMPD0000'") && sqls.at(-1)!.includes("'23C'"));
assert.deepEqual(a.delivered.table.rows, [[84]]);
assert.equal(a.delivered.text[0], "Memphis, Tennessee: 84 shoplifting offenses in 2023.");
assert.equal(a.delivered.text.at(-1), "Source: FBI NIBRS.", "P63: the source, plainly");
assert.deepEqual(a.delivered.contractProblems, []);
assert.equal(a.delivered.chart, null);

// A monthly series with an unknown month: blank, named as missing (D04), never zero.
const m = as(ask("Shoplifting in Memphis by month in 2024"), "answer");
assert.equal(m.delivered.table.rows.length, 12);
assert.deepEqual(m.delivered.table.rows[2], ["2024-03", null]);
assert.ok(m.delivered.text.includes("No report is known for March 2024: shown blank, not zero."));
assert.deepEqual(m.delivered.chart, { kind: "line", x: "Month", y: ["Shoplifting offenses"] });
assert.deepEqual(m.delivered.contractProblems, []);

// P11: victims of a property crime are offenses, with the fixed sentence before the source.
const v = as(ask("How many shoplifting victims were there in Memphis in 2024?"), "answer");
assert.equal(v.plan.measures[0].unit, "offense");
// P86: carried, not shown (the title says "offenses").
assert.equal(v.delivered.text.at(-2), "Property crimes are counted by offense, not by victim.", "P86: shown, since victims were asked for");
// Person crimes stay by victim (D18); carjacking is counted by offense (D18).
assert.equal(as(ask("How many simple assaults were there in Detroit in 2023?"), "answer").plan.measures[0].id, "victims.simple_assault");
const cj = as(ask("carjackings in Memphis TN by month in 2025"), "answer");
assert.deepEqual([cj.plan.measures[0].id, cj.plan.measures[0].unit], ["offenses.carjacking", "offense"]);

// D31: a missing place, period or crime is asked about; each fixed option runs the question with that choice filled in.
const noPlace = as(ask("How many shoplifting offenses were there in 2024?"), "clarify");
assert.deepEqual(noPlace.options.map((o) => o.label), ["The United States", "A state", "A city or agency"]);
// Increment 5: the nation's shoplifting is summed over the agencies that reported (P61), with the button.
const usShop = as(noPlace.options[0].continuation!, "answer");
assert.ok(usShop.stateSum && usShop.buttons?.length === 1 && usShop.delivered.text.includes("Includes all agencies.") && !usShop.delivered.text.some((t) => /counts reported to NIBRS|territories/.test(t)));
assert.equal(noPlace.options[1].entry, "which state");
const noPeriod = as(ask("Shoplifting in Memphis"), "clarify");
assert.deepEqual(noPeriod.options.map((o) => o.label), ["The latest complete year (2025)", "This year so far", "Another year"]);
assert.deepEqual(as(noPeriod.options[0].continuation!, "answer").period, { from: "2025-01", to: "2025-12" });
const ytd = as(noPeriod.options[1].continuation!, "answer");
assert.deepEqual(ytd.period, { from: "2026-01", to: "2026-09" });
assert.ok(ytd.delivered.text.includes("The data runs through September 2026: this covers January through September 2026."), "D06: the months covered are named");
const trend = as(ask("Carjackings in Memphis by month"), "clarify");
assert.deepEqual(trend.options.map((o) => o.label), ["The last 10 complete years", "Every year available", "Another range"]);
assert.equal(as(trend.options[0].continuation!, "decline").notBuilt, true, "2016 is before this build");
assert.deepEqual(as(trend.options[1].continuation!, "answer").period, { from: "2017-01", to: "2026-09" });
// No Historical build here: no crime-kind button could run, so a plain decline, never dead buttons (coordinator 2026-11-02).
assert.match(as(ask("How many crimes were there in Detroit in 2024?"), "decline").explanation, /^This isn.t available here yet./, "no source that is not loaded is named");
const kc = as(ask("Shoplifting in Kansas City in 2024"), "clarify");
assert.deepEqual(kc.options.map((o) => o.label), ["Kansas City, Missouri", "Kansas City, Kansas"]);
assert.deepEqual(kc.options.map((o) => as(o.continuation!, "answer").plan.geography.places[0]), [
  { kind: "agency", ori: "MOKPD0000", label: "Kansas City, Missouri" }, { kind: "agency", ori: "KS1050200", label: "Kansas City, Kansas" }]);
// A city and a county of one name: a button each, and a choice is not asked again in a later question (P22).
const balt = as(ask("Shoplifting in Baltimore by month from 2022 to 2025"), "clarify");
assert.deepEqual(balt.options.map((o) => as(o.continuation!, "answer").plan.geography.places[0]), [
  { kind: "agency", ori: "MDBPD0000", label: "Baltimore, Maryland" }, { kind: "agency", ori: "MD0030100", label: "Baltimore County, Maryland" }]);
const stl = as(ask("St Louis carjackings per month"), "clarify");
assert.equal(stl.about, "which St. Louis");
const stlCity = as(stl.options[0].continuation!, "clarify");
assert.equal(stlCity.about, "which range of years", "the place is chosen; the period is asked next");
assert.equal(as(stlCity.options[1].continuation!, "answer").plan.geography.places[0].kind === "agency" && (as(stlCity.options[1].continuation!, "answer").plan.geography.places[0] as { ori: string }).ori, "MOSPD0000");
const wa = as(ask("Shoplifting in Washington in 2024"), "clarify");
assert.equal(as(wa.options[1].continuation!, "answer").plan.geography.places[0].kind, "state", "Washington state: a state sum (increment 5)");

// Declines: what the data does not record is declined before anything is asked; after the data, P24; before this build,
// not built; drug crimes (D19) are not one measure.
assert.equal(as(ask("crime by ZIP code in Chicago"), "decline").reason, "below_agency_level");
const future = as(ask("Shoplifting in Memphis in 2027"), "decline");
assert.equal(future.explanation, "2027 is not in the data; the latest month available is September 2026.");
assert.deepEqual(as(future.alternative!.continuation!, "answer").period, { from: "2026-01", to: "2026-09" });
assert.equal(as(ask("Shoplifting in Memphis in 2012"), "decline").notBuilt, true);
// D19: drug crimes are both drug measures, side by side, with their combined total (both known: 84 + 84).
const drugs = as(ask("Drug crimes in Detroit in 2023"), "answer");
assert.deepEqual(drugs.plan.measures.map((m) => m.id), ["offenses.drug_possession", "offenses.drug_equipment"]);
assert.deepEqual(drugs.delivered.table.columns.map((c) => c.header), ["Drug/narcotic violation offenses", "Drug equipment violation offenses"]);
assert.deepEqual(drugs.delivered.table.rows, [[84, 84]]);
assert.deepEqual(drugs.delivered.text.slice(0, 4), ["Drug crimes are drug/narcotic violations plus drug equipment violations.",
  "Detroit, Michigan, 2023: 84 drug/narcotic violation offenses; 84 drug equipment violation offenses.", "Reported by the Detroit Police Department.", "Together: 168 drug crimes in 2023."]);
assert.deepEqual(drugs.delivered.contractProblems, []);
assert.equal(as(ask("Drug possession in Detroit in 2023"), "answer").plan.measures.length, 1, "drug possession itself is one measure");
// A combined total is given only when every part is known (March 2024 is unknown in the stub).
const drugsMonth = as(ask("Drug crimes in Detroit in 2024"), "answer");
assert.ok(drugsMonth.delivered.text.includes("No combined total of drug crimes is given: the available evidence does not establish every part."));
assert.ok(!drugsMonth.delivered.text.some((t) => /^Together/.test(t)));
// No question is asked when every choice ends in a refusal (D28): "Shplftg" is near no crime word, so nothing reads it.
assert.equal(as(ask("Shplftg in baltimore per month, 2021-2025"), "decline").reason, "reader");

// Codex review 1: what the slice cannot deliver is declined before anything runs or is asked; P11 covers carjacking;
// a future month is named as asked; P26 asks city or state for "New York".
// Compiler increment 2: age groups (P30), named with what each holds.
const byAge = as(ask("Simple assault victims in Detroit by age in 2023"), "answer");
assert.equal(byAge.plan.groupings[0].dimension, "victim.age");
assert.ok(!byAge.delivered.text.some((t) => /^Age groups: /.test(t)), "P86: the age groups are named by their rows, not a note");
assert.deepEqual(byAge.delivered.table.rows, [["Under 18", 15, 30], ["25-34", 20, 40], ["Unknown", 15, 30]], "P86: age order, one Unknown row last");
assert.equal(byAge.delivered.table.columns[0].binding.kind === "grouping" && "ordered" in byAge.delivered.table.columns[0] && byAge.delivered.table.columns[0].ordered, true, "P86: age groups keep their order");
assert.ok(sqls.at(-1)!.includes("WHEN v.age IN ('NN', 'NB', 'BB') THEN 'Under 18'"));
// Compiler increment 1: one delivered category, with counts, each category's share of its period, and blanks named.
const bySex = as(ask("Simple assault victims in Detroit by sex in 2023"), "answer");
assert.deepEqual(bySex.delivered.table.columns.map((c) => c.header), ["Victim sex", "Simple assault victims", "Share of all simple assault victims (%)"]);
assert.ok(!("ordered" in bySex.delivered.table.columns[0]), "categories by count are not ordered");
assert.deepEqual(bySex.delivered.table.rows, [["Female", 30, 60], ["Male", 20, 40], ["Unknown", null, null]]);
assert.ok(!bySex.delivered.text.some((t) => /^Each share is/.test(t)), "P86: the share's header says what it is");
assert.ok(bySex.delivered.text.includes("Shown blank, not zero, because reporting isn't complete: Unknown."));
assert.deepEqual([bySex.delivered.contractProblems, bySex.delivered.chart], [[], null]);
assert.equal(ask("Simple assault victims in Detroit by race and sex in 2023").kind === "answer", false, "two-way breakdowns are not built");
// Weapons: multi-valued, with the overlap sentence; carjacking by offense has one location (not multi-valued, D18).
const byWeapon = as(ask("Robberies in Detroit by weapon in 2023"), "answer");
assert.deepEqual([byWeapon.plan.groupings[0].multiValue, byWeapon.delivered.answerStatements], ["each_value", ["categories_overlap"]]);
const cjLoc = as(ask("Carjackings in Detroit by location type in 2023"), "answer");
assert.deepEqual([cjLoc.plan.measures[0].id, cjLoc.plan.groupings[0].multiValue], ["offenses.carjacking", undefined]);
// P29/P49: "by men and women" -> the crimes by their offenders' sexes; one sex alone is still declined; "against" is victims.
const bySexes = as(ask("Simple assaults by men and women in Detroit in 2023"), "answer");
assert.deepEqual([bySexes.plan.filters, bySexes.plan.groupings.map((g) => `${g.dimension}:${g.multiValue}`)], [[], ["offender.sex:each_value"]]);
assert.deepEqual(bySexes.delivered.table.rows.map((r) => r[0]), ["Female", "Male", "Unknown"]);
assert.ok(sqls.at(-1)!.includes("WHEN f2.offender_seq = '00' THEN 'U'"), "P86: no offender identified is Unknown, merged in SQL");
assert.match(as(ask("Simple assaults by women in Detroit in 2023"), "decline").explanation, /^"By" a group of people means the offenders/);
// P44: offenders themselves, by their own sex.
assert.equal(as(ask("Robbery offenders in Detroit by sex in 2023"), "answer").plan.groupings[0].multiValue, undefined);
// P36: murders by strangers say so in their words.
assert.match(as(ask("Murders by strangers in Detroit in 2023"), "answer").delivered.text[0], /murder victims by a stranger in 2023/);
// P31: gun crime and stabbings, each crime in its unit with the weapon, and the total; gun violence and shooters declined.
const gun = as(ask("Gun crime in Detroit in 2023"), "answer");
assert.deepEqual(gun.plan.measures.map((m) => `${m.id}:${(m.filters?.[0] as { scope: string }).scope}`), ["victims.murder:victim", "offenses.robbery:offense", "victims.aggravated_assault:victim"]);
assert.deepEqual(gun.delivered.table.columns.map((c) => c.header), ["Murder victims with a firearm", "Robbery offenses with a firearm", "Aggravated assault victims with a firearm"]);
assert.ok(gun.delivered.text.includes("Together: 252 gun crimes in 2023."));
assert.ok(sqls.slice(-3).every((q) => q.includes("w2.weapon IN ('11', '12', '13', '14', '15')")));
const stab = as(ask("Stabbings in Detroit in 2023"), "answer");
assert.deepEqual([stab.plan.measures.length, stab.delivered.text[0]], [2, "Stabbings here are murder victims and aggravated assault victims with a knife or cutting instrument."]);
assert.match(as(ask("Gun violence in Detroit in 2023"), "decline").explanation, /non-fatal shootings/);
assert.match(as(ask("How many shooters were there in Detroit in 2023?"), "decline").explanation, /not who fired a gun, so "shooters" can.t be counted/);
// P46, P48, P50: arrests by arrest date, counted once each; "people arrested for" is arrests; "charged" is declined with
// the arrests offered.
const arr = as(ask("How many people were arrested for burglary in Detroit in 2023?"), "answer");
assert.deepEqual([arr.plan.measures[0].id, arr.plan.timeBasis, arr.delivered.answerStatements], ["arrests.burglary", "arrest_date", ["arrests_counted_once"]]);
assert.ok(sqls.at(-1)!.includes("substr(a.arrest_date, 1, 6) AS ym"));
const charged = as(ask("How many robbery suspects were charged in Detroit in 2023?"), "decline");
assert.deepEqual([charged.reason, as(charged.alternative!.continuation!, "answer").plan.measures[0].id], ["court_outcome", "arrests.robbery"]);
// Several measures by month: a column each, and the months a crime is blank named.
const two = as(ask("Carjackings and shoplifting in Detroit by month in 2024"), "answer");
assert.deepEqual(two.delivered.table.columns.map((c) => c.header), ["Month", "Carjacking offenses", "Shoplifting offenses"]);
assert.deepEqual(two.delivered.table.rows[2], ["2024-03", null, null]);
assert.deepEqual(two.delivered.chart, { kind: "line", x: "Month", y: ["Carjacking offenses", "Shoplifting offenses"] });
assert.equal(as(ask("Simple assaults against men and women in Detroit in 2023"), "answer").plan.groupings[0].dimension, "victim.sex");
assert.equal(as(ask("Shoplifting in Kansas City by ZIP code in 2024"), "decline").reason, "below_agency_level");
const cjv = as(ask("How many carjacking victims were there in Memphis in 2024?"), "answer");
assert.deepEqual([cjv.plan.measures[0].id, cjv.delivered.answerStatements], ["offenses.carjacking", ["property_counted_by_offense"]]);
assert.equal(as(ask("Shoplifting in Memphis in November 2026"), "decline").explanation, "November 2026 is not in the data; the latest month available is September 2026.");
// P52: the upload month itself is not reported.
assert.equal(as(ask("Shoplifting in Memphis in October 2026"), "decline").explanation, "October 2026 is not in the data; the latest month available is September 2026.");
assert.deepEqual(as(ask("Shoplifting in New York in 2024"), "clarify").options.map((o) => o.label), ["New York City", "New York state"]);
assert.deepEqual(as(ask("Shoplifting in Memphis by month"), "clarify").options.map((o) => o.label), ["The last 10 complete years", "Every year available", "Another range"]);

assert.equal(periodWords("2021-01", "2025-12"), "2021 to 2025");
assert.equal(periodWords("2021-03", "2025-06"), "March 2021 through June 2025");

// Scoring: a matching answer is unverified until independent values are given, then correct; a wrong value is a wrong
// answer; a not-built refusal is never scored.
const r = { firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" };
const ctx = { capability: "answer:nibrs count", era: "2021 and later" };
const label = (expected: Case["expected"]): Case => ({ id: "LS-999", group: "designed:slice-test", split: "dev", origin: { kind: "designed", ref: null }, tab: "nibrs", setup: [], question: "q", policy: [], expected, label: { status: "reviewed", drafted_by: "a", reviewed_by: "b", notes: "" } });
const shop: Case["expected"] = { action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Memphis Police Department", state: "TN" }], period: { from: "2023-01", to: "2023-12" }, measures: [{ name: "shoplifting", unit: "offense" }], filters: [], groupings: [], statistic: "count" }, values: { status: "pending_build" }, statements: ["names the agency (Memphis Police Department)", "names its source at the end"] };
assert.equal(scoreShadow(label(shop), a, r, ctx).result!.outcome, "unverified");
assert.equal(scoreShadow(label(shop), a, r, ctx, new Map([["LS-999", [{ key: "", value: 84, status: "VALUE" }]]])).result!.outcome, "correct");
const wrong = scoreShadow(label(shop), a, r, ctx, new Map([["LS-999", [{ key: "", value: 85, status: "VALUE" }]]])).result!;
assert.deepEqual([wrong.outcome, wrong.values], ["wrong_answer", "mismatch"]);
assert.equal(scoreShadow(label(shop), as(ask("Shoplifting in Memphis in 2012"), "decline"), r, ctx).result, null);
const zip = scoreShadow(label({ action: "decline", reason: "The data stops at the agency level; no source here has counts by ZIP code.", alternative: null }), as(ask("crime by ZIP code in Chicago"), "decline"), r, ctx).result!;
assert.equal(zip.outcome, "correct");
const court = scoreShadow(label({ action: "decline", reason: "Court outcomes such as convictions are not in the data.", alternative: null }), future, r, ctx).result!;
assert.equal(court.outcome, "incomplete", "a decline with the wrong reason is not correct");

// Continuations are scored like direct answers: a button's delivered number is checked against its own expected cells,
// a wrong one is a wrong answer, none given leaves it unverified; an entry must ask the part the label names.
const periodLabel = (opts: { label: string; leads_to: "answer" | "clarify"; meaning: Case["expected"] extends infer E ? (E extends { action: "answer"; meaning: infer M } ? M : never) : never | null; next_about?: string }[]): Case["expected"] => ({ action: "clarify", about: "which period", options: opts as never });
const shopIn = (period: { from: string; to: string }) => ({ ...(shop as { meaning: object }).meaning, period }) as never;
const np = periodLabel([
  { label: "The latest complete year (2025)", leads_to: "answer", meaning: shopIn({ from: "2025-01", to: "2025-12" }) },
  { label: "This year so far", leads_to: "answer", meaning: shopIn({ from: "2026-01", to: "2026-09" }) },
  { label: "Another year", leads_to: "clarify", meaning: null as never, next_about: "which year" }]);
const score = (vals?: Map<string, { key: string; value: number | null; status: string }[]>) => scoreShadow(label(np), noPeriod, r, ctx, vals).result!;
assert.deepEqual([score().outcome, score().values], ["unverified", "not measured"]);
const both = (a1: number) => new Map([["LS-999|The latest complete year (2025)", [{ key: "", value: a1, status: "VALUE" }]], ["LS-999|This year so far", [{ key: "", value: 63, status: "VALUE" }]]]);
assert.deepEqual([score(both(84)).outcome, score(both(84)).values], ["correct", "match"]);
assert.deepEqual([score(both(83)).outcome, score(both(83)).values], ["wrong_answer", "mismatch"]);
const wrongEntry = periodLabel([...(np as unknown as { options: never[] }).options.slice(0, 2), { label: "Another year", leads_to: "clarify", meaning: null as never, next_about: "which range of years" }]);
assert.equal(scoreShadow(label(wrongEntry), noPeriod, r, ctx, both(84)).result!.outcome, "incomplete");

// Codex review 2: no button answers "Shoplifting arrests in Washington" (arrests and state totals are not in the slice),
// so it declines rather than asks; a different question behind a button is a wrong answer; its text is checked; an
// answer behind a button with no values leaves the zero-wrong-answers gate NOT MEASURED.
// (Increment 2: arrests are built, so the city button answers; increment 5: the state button is a state sum.)
const waArrests = as(ask("Shoplifting arrests in Washington in 2024"), "clarify");
assert.deepEqual([waArrests.options[0].continuation?.kind, waArrests.options.find((o) => / state$/.test(o.label))?.continuation?.kind], ["answer", "answer"], "increment 5: the state button is a state sum (P61)");
const detroitInstead = periodLabel([
  { label: "The latest complete year (2025)", leads_to: "answer", meaning: { ...(shopIn({ from: "2025-01", to: "2025-12" }) as object), places: [{ kind: "agency", name: "Detroit Police Department", state: "MI" }] } as never },
  ...(np as unknown as { options: never[] }).options.slice(1)]);
assert.equal(scoreShadow(label(detroitInstead), noPeriod, r, ctx, both(84)).result!.outcome, "wrong_answer");
const mute = { ...noPeriod, options: noPeriod.options.map((o, i) => (i ? o : { ...o, continuation: { ...(o.continuation as object), delivered: { ...(o.continuation as { delivered: object }).delivered, text: ["84."] } } as never })) };
assert.equal(scoreShadow(label(np), mute, r, ctx, both(84)).result!.outcome, "incomplete", "a button's answer must still name its agency and source");
const unv = scoreShadow(label(np), noPeriod, r, ctx).result!;
assert.equal(gates([unv])[0].categories.find((x) => x.name === "wrong answers")!.status, "not measured");
// Answers behind a second question are found and checked by their path of buttons.
const stlCase = label({ action: "clarify", about: "which St. Louis", options: [
  { label: "St. Louis city, Missouri", leads_to: "clarify", meaning: null, next_about: "which range of years" },
  { label: "St. Louis County, Missouri", leads_to: "clarify", meaning: null, next_about: "which range of years" }] });
const deep = (v: number) => new Map([["LS-999|St. Louis city, Missouri|Every year available", Array.from({ length: 117 }, (_, i) => {
  const m = `${2017 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`; return { key: m, value: m === "2024-03" ? null : v, status: m === "2024-03" ? "UNKNOWN" : "VALUE" }; })]]);
assert.equal(scoreShadow(stlCase, stl, r, ctx, deep(7)).result!.values, "not measured", "the county's answers have no values");
assert.equal(scoreShadow(stlCase, stl, r, ctx, deep(6)).result!.outcome, "wrong_answer");

// Codex review 3: every delivered answer is checked, expected by the label or not, and fixed sentences are checked on
// button answers (P11 behind a period button).
const zipLabel = label({ action: "decline", reason: "The data stops at the agency level; no source here has counts by ZIP code.", alternative: null });
const zipWithAlt = { ...as(ask("crime by ZIP code in Chicago"), "decline"), alternative: { label: "this year", continuation: a } };
const zipScore = scoreShadow(zipLabel, zipWithAlt, r, ctx).result!;
assert.equal(zipScore.outcome, "unverified");
assert.equal(gates([zipScore])[0].categories.find((x) => x.name === "wrong answers")!.status, "not measured");
const victimsNoPeriod = as(ask("Shoplifting victims in Memphis"), "clarify");
const latest = as(victimsNoPeriod.options[0].continuation!, "answer");
assert.equal(latest.delivered.text.at(-2), "Property crimes are counted by offense, not by victim.");
// A statement the plan calls for but the answer does not carry is caught (P86: carried in answerStatements).
const stripped = { ...victimsNoPeriod, options: victimsNoPeriod.options.map((o, i) => (i ? o : { ...o, continuation: { ...latest, delivered: { ...latest.delivered, answerStatements: latest.delivered.answerStatements.filter((x) => x !== "property_counted_by_offense") } } })) };
const vLabel: Case = { ...label(np), question: "Shoplifting victims in Memphis" };
assert.equal(scoreShadow(vLabel, victimsNoPeriod, r, ctx, both(84)).result!.outcome, "correct");
assert.equal(scoreShadow(vLabel, stripped, r, ctx, both(84)).result!.outcome, "incomplete");

// The reading pre-pass (reader round): forecasts and court outcomes decline with their alternatives (P20, D01); a
// corrected spelling is disclosed before the source; Part I counts are left to Historical and Current Trends (P01).
const fc = as(ask("Will shoplifting go up in Memphis next year?"), "decline");
assert.deepEqual([fc.reason, fc.alternative!.label], ["forecast", "The last 10 complete years, by year"]);
assert.equal(as(fc.alternative!.continuation!, "decline").notBuilt, true, "2016 is before this build");
// A forecast verb the reader reads as a change ("increase") is dropped from the alternative too.
assert.equal(as(as(ask("Will carjackings increase in Memphis in 2027?"), "decline").alternative!.continuation!, "decline").notBuilt, true);
// Codex review 2: with the years present, the forecast's alternative reaches an annual answer (its two filled parts no
// longer share a binding); a real word is never corrected into a crime; P01 leaves a crime's details to NIBRS's limits.
const deeper: ShadowDeps = { ...deps, release: { ...deps.release, firstMonth: "2016-01" }, target: { ...deps.target, builtYears: [2016, ...deps.target.builtYears] } };
const fcAlt = as(as(shadowAnswer("Will shoplifting rise in Memphis next year?", deeper), "decline").alternative!.continuation!, "answer");
assert.deepEqual([fcAlt.period, fcAlt.plan.groupings.map((g) => g.dimension)], [{ from: "2016-01", to: "2025-12" }, ["time.year"]]);
assert.equal(as(shadowAnswer("Will shoplifting near schools rise in Memphis next year?", deeper), "decline").alternative!.continuation!.kind, "decline", "an unread qualifier stays, so the narrower alternative declines");
assert.notEqual(ask("Sample assaults in Memphis in 2023").kind, "answer");
// A Part I crime's details are NIBRS's (P01 is a plain count only): answered since increment 2.
for (const q of ["Robberies with a firearm in Memphis in 2023", "Robbery arrests in Memphis in 2023"]) as(ask(q), "answer");
assert.equal(as(ask("Shoplifting in Memphis next year"), "decline").reason, "outside_release_coverage", "P24, not a forecast");
assert.equal(as(ask("Predicting shoplifting in Memphis in 2027"), "decline").reason, "forecast");
const ct = as(ask("How many shoplifting arrests in Memphis in 2024 led to convictions?"), "decline");
assert.deepEqual([ct.reason, ct.alternative!.label], ["court_outcome", "Arrests for the same crime, place and period"]);
const typo = as(ask("Shoplfting in Memphis in 2023"), "answer");
assert.equal(typo.delivered.text.at(-2), 'Read "Shoplfting" as shoplifting.');
const burg = as(ask("Burglaries in Memphis in 2023"), "decline");
assert.match(burg.explanation, /^This isn.t available here yet./);
// P74: the nearest answerable question, shown whole on the button, run only when chosen.
assert.deepEqual(burg.alternative, { label: 'Ask instead: "Burglaries in Memphis in 2023 according to NIBRS"', question: "Burglaries in Memphis in 2023 according to NIBRS", role: "other_source", targetSource: "nibrs" });

// Breakdown scoring: rows keyed by category name, counts and statuses compared, shares checked against the independent
// count over the independent total; nibrs-model's category rows load under those keys.
const sexLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Detroit Police Department", state: "MI" }], period: { from: "2023-01", to: "2023-12" },
  measures: [{ name: "simple assault", unit: "victim" }], filters: [], groupings: ["victim sex"], statistic: "count" }, values: { status: "pending_build" }, statements: ["names its source at the end"] });
const sexCells = (male: number) => new Map([["LS-999", [{ key: "Female", value: 30, status: "VALUE", share: 60 }, { key: "Male", value: male, status: "VALUE", share: 40 }, { key: "Unknown", value: null, status: "UNKNOWN", share: null }]]]);
assert.equal(scoreShadow(sexLabel, bySex, r, ctx, sexCells(20)).result!.outcome, "correct");
assert.equal(scoreShadow(sexLabel, bySex, r, ctx, sexCells(21)).result!.outcome, "wrong_answer");
assert.equal(scoreShadow(sexLabel, bySex, r, ctx).result!.outcome, "unverified", "no values: not measured");
const loaded = sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", grouping: "total", measures: { sa: "13B" }, totals: { sa: { status: "VALUE", value: 50 } },
  rows: [{ sex: "F", sa: { status: "VALUE", value: 30 } }, { sex: "M", sa: { status: "VALUE", value: 20 } }, { sex: "U", sa: { status: "UNKNOWN", value: null } }] }) }]);
assert.deepEqual(loaded.get("LS-999"), sexCells(20).get("LS-999"));
// Codex increment-1 review: a repeated category row, or a missing share column, never scores correct; a share within a
// year is checked against that year's own independent total, and with none it is unverified, not an expected blank.
const dup = { ...bySex, delivered: { ...bySex.delivered, table: { ...bySex.delivered.table, rows: [["Male", 999, 99], ...bySex.delivered.table.rows] },
  evidence: [{ row: 0, statistic: bySex.plan.statistics[0].as, status: "VALUE" as const }, ...bySex.delivered.evidence.map((e) => ({ ...e, row: e.row + 1 }))] } };
assert.equal(scoreShadow(sexLabel, dup, r, ctx, sexCells(20)).result!.outcome, "wrong_answer");
const countOnly = { ...bySex, delivered: { ...bySex.delivered, table: { columns: bySex.delivered.table.columns.slice(0, 2), rows: bySex.delivered.table.rows.map((x) => x.slice(0, 2)) } } };
assert.notEqual(scoreShadow(sexLabel, countOnly, r, ctx, sexCells(20)).result!.outcome, "correct");
const yearly = sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-998", grouping: "year", measures: { sa: "13B" }, totals: { sa: { status: "UNKNOWN", value: null } },
  rows: [{ year: "2021", sex: "F", sa: { status: "VALUE", value: 3 } }, { year: "2021", sex: "M", sa: { status: "VALUE", value: 1 } },
    { year: "2022", sex: "F", sa: { status: "VALUE", value: 5 } }, { year: "2022", sex: "M", sa: { status: "UNKNOWN", value: null } }] }) }]).get("LS-998")!;
assert.deepEqual(yearly.map((x) => [x.key, x.share]), [["2021|Female", 75], ["2021|Male", 25], ["2022|Female", undefined], ["2022|Male", null]]);

// Several measures: each column is checked against the expected measure naming its codes and unit, wherever it sits.
const drugLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Detroit Police Department", state: "MI" }], period: { from: "2023-01", to: "2023-12" },
  measures: [{ name: "drug/narcotic violation", unit: "offense" }, { name: "drug equipment violation", unit: "offense" }], filters: [], groupings: [], statistic: "count" }, values: { status: "pending_build" },
  statements: ["gives the combined drug-crimes total (drug/narcotic plus drug equipment offenses)", "names its source at the end"] });
const drugValues = (a: number, b: number) => sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", grouping: "total",
  measures: { equipment_35B: "offense segments (02) with code 35B", narcotic_35A: "offense segments (02) with code 35A" },
  totals: { equipment_35B: { status: "VALUE", value: b }, narcotic_35A: { status: "VALUE", value: a } }, rows: null }) }]);
assert.equal(scoreShadow(drugLabel, drugs, r, ctx, drugValues(84, 84)).result!.outcome, "correct");
assert.equal(scoreShadow(drugLabel, drugs, r, ctx, drugValues(84, 85)).result!.outcome, "wrong_answer");
// A total sentence that does not add the table's cells fails its statement.
const badSum = { ...drugs, delivered: { ...drugs.delivered, text: drugs.delivered.text.map((t) => t.replace("168", "170")) } };
assert.notEqual(scoreShadow(drugLabel, badSum, r, ctx, drugValues(84, 84)).result!.outcome, "correct");
// By month: a cell per measure per month.
const monthly = sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", grouping: "month", measures: { cj: "carjacking offenses (120, motor vehicle taken)", sh: "offense segments with code 23C" },
  totals: {}, rows: [{ month: "2024-01", cj: { status: "VALUE", value: 2 }, sh: { status: "VALUE", value: 9 } }] }) }]).get("LS-999")!;
assert.deepEqual(monthly.map((x) => [x.key, x.value, x.measure]), [["2024-01", 2, "cj: carjacking offenses (120, motor vehicle taken)"], ["2024-01", 9, "sh: offense segments with code 23C"]]);

// Codex review 02: compositions that would silently change what was asked are declined or kept whole.
assert.match(as(ask("Female simple assault victims by men and women in Detroit in 2023"), "decline").explanation, /victims restricted by sex/);
assert.match(as(ask("Drug crimes and shoplifting in Detroit in 2024"), "decline").explanation, /drug equipment violations. beside other crimes/);
for (const q of ["Gun crimes and murders in Detroit in 2024", "Stabbings and murders in Detroit in 2024"]) assert.match(as(ask(q), "decline").explanation, /beside other crimes/, q);
assert.match(as(ask("Robberies with a handgun in Detroit in 2023"), "answer").delivered.text[0], /robbery offenses with a weapon recorded as Handgun/);
assert.equal(ask("Simple assaults by men and men in Detroit in 2023").kind, "decline");
const chargedFor = as(ask("How many people were charged for shoplifting in Detroit in 2024?"), "decline");
assert.equal(as(chargedFor.alternative!.continuation!, "answer").plan.measures[0].id, "arrests.shoplifting");
// The combined total is checked exactly: 2520 is not 252 (gun crime stub: 84 each).
const gunLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Detroit Police Department", state: "MI" }], period: { from: "2023-01", to: "2023-12" },
  measures: [{ name: "murder", unit: "victim" }, { name: "robbery", unit: "offense" }, { name: "aggravated assault", unit: "victim" }], filters: ["weapon: firearm"], groupings: [], statistic: "count" },
  values: { status: "pending_build" }, statements: ["gives the gun-crime total (firearm murder victims plus firearm robbery offenses plus firearm aggravated assault victims)"] });
const gunDiffs = (g: typeof gun) => scoreShadow(gunLabel, g, r, ctx).result!.diffs.filter((d) => d.field === "statement" && d.kind === "material");
assert.equal(gunDiffs(gun).length, 0);
assert.equal(gunDiffs({ ...gun, delivered: { ...gun.delivered, text: gun.delivered.text.map((t) => t.replace("252", "2520")) } }).length, 1);

// Codex P51 review: a known 0 denominator gives an expected blank share (not unverified); a share UNAVAILABLE for that
// reason is not a missing month.
const zeroDen = sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", grouping: "year", category: "sex", measures: { sa: "13B" }, totals: { sa: { status: "VALUE", value: 1 } },
  rows: [{ year: "2023", sex: "F", sa: { status: "VALUE", value: 1 } }, { year: "2024", sex: "F", sa: { status: "VALUE", value: 0 } }] }) }]).get("LS-999")!;
assert.deepEqual(zeroDen.map((x) => [x.key, x.share]), [["2023|Female", 100], ["2024|Female", null]]);
const unavailable = { ...bySex, delivered: { ...bySex.delivered, table: { ...bySex.delivered.table, rows: [["Female", 0, null]] },
  evidence: [{ row: 0, statistic: bySex.plan.statistics[0].as, status: "VALUE" as const }, { row: 0, statistic: bySex.plan.statistics[1].as, status: "UNAVAILABLE" as const }] } };
const missingLabel = label({ ...(sexLabel.expected as object), statements: ["names any months with no data as missing, not zero"] } as never);
assert.equal(scoreShadow(missingLabel, unavailable, r, ctx).result!.diffs.filter((d) => d.field === "statement" && d.kind === "material").length, 0);

// Increment 3 (time). The stub gives 7 per month, March 2024 unknown.
const chg = as(ask("Change in shoplifting in Detroit from 2022 to 2023"), "answer");
assert.deepEqual(chg.delivered.table.columns.map((c) => c.header), ["Shoplifting offenses, 2022", "Shoplifting offenses, 2023", "Change", "Percent change (%)"]);
assert.deepEqual(chg.delivered.table.rows, [[84, 84, 0, 0]]);
assert.ok(chg.delivered.text.includes("84 in 2022 and 84 in 2023: a change of 0 (0%)."));
// P54: no comparison year -> the year before; D17: no change from a year with a month unknown, the month named (D04).
const goUp = as(ask("Did shoplifting go up in Detroit in 2024?"), "answer");
assert.deepEqual(goUp.delivered.table.rows, [[84, null, null, null]]);
assert.ok(goUp.delivered.text.includes("No report is known for March 2024, so the 2024 total is not established and no change is given."));
assert.ok(!goUp.delivered.text.some((t) => /a change of/.test(t)));
// This year against last year: the same months, through the latest month (P52, D06).
const ytdCmp = as(ask("Is shoplifting in Detroit up this year compared with last year?"), "answer");
assert.deepEqual(ytdCmp.period, { from: "2025-01", to: "2026-09" });
assert.ok(ytdCmp.delivered.text.includes("Compares the same months of each year: January through September."));
assert.deepEqual(ytdCmp.delivered.table.rows, [[63, 63, 0, 0]]);
// "Compared with" and "percent change" read; a change with a NIBRS filter is a comparison too.
for (const q of ["Shoplifting in Detroit in 2023 compared with 2022", "Percent change in shoplifting in Detroit from 2022 to 2023", "Change in robberies with a firearm in Detroit from 2022 to 2023"])
  assert.equal(as(ask(q), "answer").plan.transforms[0].kind, "period_comparison", q);
// A change of several crimes or of a breakdown is not built.
assert.equal(ask("Change in shoplifting and burglary in Detroit from 2022 to 2023").kind, "decline");
// A set of years: only those years, grouped by year.
const sepYears = as(ask("Shoplifting in Detroit in 2019 and 2023"), "answer");
assert.deepEqual([sepYears.plan.period, sepYears.delivered.text[0]], [{ kind: "years", years: [2019, 2023] }, "Detroit, Michigan: shoplifting offenses by year, 2019 and 2023."]);
assert.ok(sqls.at(-1)!.includes("IN ('2019', '2023')"));
// Rolling windows reach back before the period; a window holding March 2024 is blank, never a shorter sum.
const roll = as(ask("Rolling 12-month shoplifting in Detroit since 2024"), "answer");
const rollRow = (ym: string) => roll.delivered.table.rows.find((r) => r[0] === ym)![1];
assert.deepEqual([rollRow("2024-02"), rollRow("2024-03"), rollRow("2025-02"), rollRow("2025-03")], [84, null, null, 84]);
assert.ok(!roll.delivered.text.some((t) => /^Each month's figure/.test(t)), "P86: the rolling header says what it is");
assert.ok(roll.delivered.text.some((t) => /^No report is known for March 2024: every window containing one of those months is shown blank/.test(t)));
// P56: the last 12 months, one total, months named.
const last12 = as(ask("Shoplifting in Detroit over the last 12 months"), "answer");
assert.deepEqual([last12.period, last12.plan.groupings, last12.delivered.text[0]], [{ from: "2025-10", to: "2026-09" }, [], "Detroit, Michigan: 84 shoplifting offenses in October 2025 through September 2026."]);
// Charlotte: found by its place name, named as its agency; a bare "Charlotte" is a city and a county (P28).
assert.match(as(ask("Shoplifting in Charlotte, North Carolina in 2023"), "answer").delivered.text[0], /^Charlotte, North Carolina/);
assert.equal(ask("Shoplifting in Charlotte in 2023").kind, "clarify");

// Codex increment-3 review. A future comparison declines with an alternative that answers its label (no recursion); a
// forecast's alternative is the trend it names; the reader's own change form keeps P01.
for (const q of ["Did shoplifting go up in Detroit in 2028?", "Change in shoplifting in Detroit from 2027 to 2028"]) {
  const d = as(ask(q), "decline");
  assert.equal(d.reason, "outside_release_coverage", q);
}
const fcCmp = as(ask("Will shoplifting increase in Detroit in 2027 compared with 2026?"), "decline");
assert.equal(fcCmp.reason, "forecast");
const fcAltCmp = as(fcCmp.alternative!.continuation!, "decline");
assert.deepEqual([fcAltCmp.notBuilt, /2016 to 2025/.test(fcAltCmp.explanation)], [true, true], "the trend alternative is the last 10 complete years (before this build), not the forecast's comparison");
assert.match(as(ask("Did burglaries increase in Detroit from 2022 to 2023?"), "decline").explanation, /^This isn.t available here yet./);
// Scoring: the comparison's periods are checked against the label; prose must be the templates with the table's numbers;
// a rolling answer must show every displayed month.
const lab309 = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Detroit Police Department", state: "MI" }], period: { from: "2022-01", to: "2023-06" },
  measures: [{ name: "shoplifting", unit: "offense" }], filters: ["the same months of each year: January through June"], groupings: ["year"], statistic: "change" },
  values: { status: "pending_build" }, statements: ["gives both counts, the change and the percent change, with no adjectives", "names the months compared"] });
const half = as(ask("Shoplifting in Detroit January through June 2023 compared with January through June 2022"), "answer");
const material = (o: typeof half, c: Case) => scoreShadow(c, o, r, ctx).result!.diffs.filter((d) => d.kind === "material").map((d) => d.field);
assert.deepEqual(material(half, lab309), []);
const t0 = half.plan.transforms[0] as Extract<typeof half.plan.transforms[number], { kind: "period_comparison" }>;
const shifted = { ...half, plan: { ...half.plan, transforms: [{ ...t0, earlier: { ...t0.earlier, to: "2022-03" } }] } };
assert.ok(material(shifted, lab309).includes("comparison"), "an earlier period of January-March is not January-June");
const lab304 = label({ ...(lab309.expected as object), meaning: { ...(lab309.expected as { meaning: object }).meaning, period: { from: "2022-01", to: "2023-12" }, filters: [] } } as never);
const whole = as(ask("Change in shoplifting in Detroit from 2022 to 2023"), "answer");
assert.deepEqual(material(whole, lab304), []);
const lie = { ...whole, delivered: { ...whole.delivered, text: whole.delivered.text.map((x) => (/a change of/.test(x) ? "999 in 2022 and 1 in 2023: a catastrophic increase." : x)) } };
assert.ok(material(lie, lab304).includes("statement"), "prose that is not the table's numbers fails");
const rollLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Detroit Police Department", state: "MI" }], period: { rule: "2024 through the latest month in the data" },
  measures: [{ name: "shoplifting", unit: "offense" }], filters: [], groupings: ["month (rolling 12-month total ending that month)"], statistic: "count" },
  values: { status: "pending_build" }, statements: ["shows the windows ending March 2024 through February 2025 as missing (each contains March 2024), never zero or a shorter-window total"] });
assert.ok(!material(roll, rollLabel).includes("statement"));
const kept = roll.delivered.table.rows.map((row, i) => [row, i] as const).filter(([row]) => row[1] !== null);
const omitted = { ...roll, delivered: { ...roll.delivered, table: { ...roll.delivered.table, rows: kept.map(([row]) => row) },
  evidence: kept.map(([, i], j) => ({ ...roll.delivered.evidence[i], row: j })) } };
assert.ok(material(omitted, rollLabel).includes("statement"), "leaving the missing windows out does not pass");

// Batch 6 (time): a change's cells, a rolling series and a set of years load from their files and score the answers.
const v6 = (j: object) => sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", measures: { m: "x" }, rows: null, ...j }) }]).get("LS-999")!;
const chgCells = v6({ grouping: "change", periods: [{ from: "2022-01", to: "2022-12", total: { status: "VALUE", value: 84 } }, { from: "2023-01", to: "2023-12", total: { status: "VALUE", value: 84 } }],
  change: { change: 0, percent_change: 0 } });
assert.equal(scoreShadow(lab304, whole, r, ctx, new Map([["LS-999", chgCells]])).result!.values, "match");
const wrongChg = chgCells.map((c) => (c.key === "change" ? { ...c, value: 1 } : c));
assert.equal(scoreShadow(lab304, whole, r, ctx, new Map([["LS-999", wrongChg]])).result!.outcome, "wrong_answer");
// A second, wrong comparison row with valid-looking evidence never scores correct.
const extraRow = { ...whole, delivered: { ...whole.delivered, table: { ...whole.delivered.table, rows: [...whole.delivered.table.rows, [999, 1, -998, -99.9]] },
  evidence: [...whole.delivered.evidence, ...whole.delivered.evidence.map((e) => ({ ...e, row: 1 }))] } };
assert.equal(scoreShadow(lab304, extraRow, r, ctx, new Map([["LS-999", chgCells]])).result!.outcome, "wrong_answer");
assert.deepEqual(v6({ grouping: "change", periods: [{ from: "2022-01", to: "2022-12", total: { status: "VALUE", value: 0 } }, { from: "2023-01", to: "2023-12", total: { status: "VALUE", value: 6 } }],
  change: { change: 6, percent_change: null, percent_reason: "zero base (P55)" } }).at(-1), { key: "pct_change", value: null, status: "UNAVAILABLE" });
assert.deepEqual(v6({ grouping: "rolling", periods: [], rolling: [{ month: "2024-02", total: { status: "VALUE", value: 84 } }, { month: "2024-03", total: { status: "UNKNOWN", value: null, observed: 77 } }] }),
  [{ key: "2024-02", value: 84, status: "VALUE" }, { key: "2024-03", value: null, status: "UNKNOWN" }]);
assert.deepEqual(v6({ grouping: "years", periods: [{ from: "2019-01", to: "2019-12", total: { status: "VALUE", value: 1 } }, { from: "2024-01", to: "2024-12", total: { status: "VALUE", value: 2 } }] }).map((c) => c.key), ["2019", "2024"]);

// Batch 5's category fields and codes: the file names its field; age and unknown-offender codes map to NIBRSAI's labels;
// a multi-valued field's categories are never summed into a share's denominator.
const v5 = (category: string, rows: unknown[], extra = {}) => sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", grouping: "total", category,
  measures: { m: "x" }, totals: { m: { status: "VALUE", value: 10 } }, rows, ...extra }) }]).get("LS-999")!;
assert.deepEqual(v5("age_group", [{ age_group: "under_18", m: { status: "VALUE", value: 4 } }, { age_group: "00", m: { status: "VALUE", value: 1 } }, { age_group: " ", m: { status: "VALUE", value: 1 } }]).map((x) => [x.key, x.share]),
  [["Under 18", 40], ["Unknown", 20]]);
// Codex guard review 01.2: overlapping categories (an offense's offenders) merged into one Unknown are not summed: the
// cell is left unverified, never judged against a double count.
assert.deepEqual(v5("offender_sex", [{ offender_sex: " ", m: { status: "VALUE", value: 1 } }, { offender_sex: "U", m: { status: "VALUE", value: 1 } }, { offender_sex: "M", m: { status: "VALUE", value: 9 } },
  { offender_sex: "seq_00", m: { status: "VALUE", value: 2 } }]).map((x) => [x.key, !!x.unverifiable]), [["Unknown", true], ["Male", false]], "the Unknown row required, its value not judged; Male kept");
assert.deepEqual(v5("offender_sex", [{ offender_sex: "00", m: { status: "VALUE", value: 3 } }, { offender_sex: "M", m: { status: "VALUE", value: 9 } }]).map((x) => [x.key, x.share]),
  [["Unknown", 30], ["Male", 90]]);
const weaponYear = sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", grouping: "year", category: "weapon", measures: { m: "x" }, totals: { m: { status: "VALUE", value: 10 } },
  rows: [{ year: "2023", weapon: "12", m: { status: "VALUE", value: 8 } }, { year: "2023", weapon: "40", m: { status: "VALUE", value: 7 } }] }) }]).get("LS-999")!;
assert.deepEqual(weaponYear.map((x) => [x.key, x.share]), [["2023|Handgun", undefined], ["2023|Personal Weapons", undefined]], "overlapping categories are never summed");

// Increment 4: several agencies, combined totals, rates (P58, P59) and rankings (P60), on the grid and population stubs.
const ok4 = (q: string) => { const o = as(ask(q), "answer"); assert.deepEqual(o.delivered.contractProblems, [], q); return o; };
const tulsaOkc = ok4("Shoplifting in Tulsa and Oklahoma City in 2024");
assert.deepEqual(tulsaOkc.delivered.table.rows, [["Tulsa Police Department", 60], ["Oklahoma City Police Department", 60]]);
assert.equal(tulsaOkc.delivered.text[0], "Tulsa, Oklahoma and Oklahoma City, Oklahoma: shoplifting offenses by agency, 2024.");
assert.ok(sqls.some((s) => s.includes("unnest(['OK0550600', 'OK0720500']) AS ori")), "one grid query for both agencies");
const combinedTotal = ok4("Shoplifting in Tulsa and Oklahoma City combined in 2024");
assert.deepEqual(combinedTotal.delivered.table.rows, [[120]]);
assert.equal(combinedTotal.delivered.text[0], "Tulsa, Oklahoma and Oklahoma City, Oklahoma, combined: 120 shoplifting offenses in 2024.");
assert.deepEqual(ok4("Shoplifting in Tulsa Police Department, Tulsa, and Oklahoma City combined in 2024").delivered.table.rows, [[120]], "an agency named twice is counted once");
// A combined total needs every month of every agency (D6): Greensboro's unknown months blank the total, never a part-sum.
const gr = ok4("Shoplifting in Greensboro and Raleigh combined in 2025");
assert.deepEqual(gr.delivered.table.rows, [[null]]);
assert.ok(gr.delivered.text.includes("No report is known for November 2025 to December 2025 for Greensboro, North Carolina."));
// Rates: count over the FBI population, per 100,000; none from a missing or zero population (never 0 or infinite).
assert.deepEqual(ok4("Shoplifting rate in Wichita in 2024").delivered.table.rows, [[15]]);
const raleigh = ok4("Shoplifting rate in Raleigh in 2024");
assert.deepEqual(raleigh.delivered.table.rows, [[null]]);
assert.equal(raleigh.delivered.evidence[0].status, "UNAVAILABLE");
// A combined rate is the summed counts over the summed populations; a missing population blanks it.
assert.deepEqual(ok4("Shoplifting rate in Tulsa and Oklahoma City combined in 2024").delivered.table.rows, [[10.9]]);
assert.deepEqual(ok4("Shoplifting rate in Wichita and Raleigh combined in 2024").delivered.table.rows, [[null]]);
// P59: a part year's rate is for those months, not annualized.
const partYearRate = ok4("Shoplifting rate in Wichita this year");
assert.deepEqual(partYearRate.delivered.table.rows, [[11.3]], "45 offenses in January-September 2026 over 400,000");
assert.ok(partYearRate.delivered.text.some((t) => t.includes("not annualized")));
// P60: only full-year reporters are ranked; the rest are named with their months; no population is not ranked by rate.
const tx = ok4("Which Texas cities had the most shoplifting in 2024?");
assert.deepEqual(tx.delivered.table.rows, [["Houston Police Department", 108], ["Dallas Police Department", 84], ["TX9999900", 60]]);
assert.ok(tx.delivered.text.includes("Not ranked because they didn't report all 12 months of 2024: Austin Police Department (11 months)."));
const txRate = ok4("Which Texas cities had the highest shoplifting rate in 2024?");
assert.deepEqual(txRate.delivered.table.rows, [["Dallas Police Department", 6.5], ["Houston Police Department", 4.7]]);
assert.ok(txRate.delivered.text.includes("Not ranked because the FBI gives no population: TX9999900."));
assert.equal(as(ask("Which large Texas cities had the most shoplifting in 2024?"), "answer").delivered.table.rows.length, 2, "P08: 250,000 or more");
// Scoring increment 4: a ranking's filters, ranked statistic and P60 statements; a rate's denominator.
const year24 = { from: "2024-01", to: "2024-12" };
const txLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "state", name: "Texas", state: "TX" }], period: year24, measures: [{ name: "shoplifting", unit: "offense" }],
  filters: ["city agencies", "agencies that reported every month of 2024"], groupings: ["agency"], statistic: "count", rank: { by: "count", direction: "top", limit: 20 } }, values: { status: "pending_build" },
  statements: ["shows exactly 3 agencies", "ranks only agencies that reported all 12 months of 2024, and names those left out with their months reported; no button to include them, and they appear in neither the chart nor the table (P60)",
    "orders ties alphabetically by agency name", "adds no other eligibility filter", "names its source at the end"] });
assert.deepEqual(material(tx, txLabel), []);
assert.ok(material({ ...tx, delivered: { ...tx.delivered, text: tx.delivered.text.filter((t) => !t.startsWith("Ranked:")) } }, txLabel).includes("statement"), "the P60 rule must be said");
assert.ok(material({ ...tx, delivered: { ...tx.delivered, table: { ...tx.delivered.table, rows: [["Houston Police Department", 108], ["Dallas Police Department", 84]] } } }, txLabel).includes("statement"), "the row count is checked");
assert.ok(material(tx, label({ ...txLabel.expected!, meaning: { ...(txLabel.expected as { meaning: object }).meaning, rank: { by: "rate", direction: "top", limit: 20 } } } as Case["expected"])).includes("rank by"));
assert.ok(material(tx, label({ ...txLabel.expected!, meaning: { ...(txLabel.expected as { meaning: object }).meaning, filters: ["city agencies"] } } as Case["expected"])).includes("filters"), "the reporters rule is a filter of every ranking");
const okRates = ok4("Shoplifting rates in Tulsa and Oklahoma City in 2024");
const ratesLabel = (denominator: string) => label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Tulsa Police Department", state: "OK" }, { kind: "agency", name: "Oklahoma City Police Department", state: "OK" }],
  period: year24, measures: [{ name: "shoplifting", unit: "offense" }], filters: [], groupings: [], statistic: "rate", combine: "separate", denominator }, values: { status: "pending_build" },
  statements: ["gives each agency's rate over its own population", "names the agency (Tulsa Police Department)", "names the agency (Oklahoma City Police Department)", "names its source at the end"] });
assert.deepEqual(material(okRates, ratesLabel("each agency's residents (the FBI's agency population), per 100,000")), []);
assert.ok(material(okRates, ratesLabel("the two agencies' residents together (the FBI's agency populations), per 100,000")).includes("denominator"));

const wichita = ok4("Shoplifting rate in Wichita in 2024");
const wichitaLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Wichita Police Department", state: "KS" }], period: year24, measures: [{ name: "shoplifting", unit: "offense" }], filters: [], groupings: [], statistic: "rate",
  denominator: "residents of the Wichita Police Department's jurisdiction (the FBI's agency population), per 100,000" }, values: { status: "pending_build" },
  statements: ["gives the rate per 100,000 residents and names the population and its year", "names the agency (Wichita Police Department)", "names its source at the end"] });
assert.deepEqual(material(wichita, wichitaLabel), [], "the population sentence is any line, not the last");
assert.ok(material({ ...wichita, delivered: { ...wichita.delivered, text: wichita.delivered.text.filter((t) => !t.startsWith("Rates are")) } }, wichitaLabel).includes("statement"));
// Batch 7 values: a ranking's agencies by FBI name (or the ORI when the FBI gives none), its value and its place; a rate.
const v7 = (o: object) => sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", measures: { shoplifting: "23C" }, ...o }) }]);
const austinOut = [{ ori: "TX2270100", agency_name: "Austin Police Department", months_reported: Array(11).fill("2024") }];
const rankFile = (order: [string | null, string, number][], left = austinOut) => v7({ grouping: "ranking", ranked_by: "count",
  result: order.map(([agency_name, ori, count], i) => ({ agency_name, ori, count, rate: null, position: i + 1 })), left_out_months_unknown: left });
const scoredTx = (ev: ReturnType<typeof v7>) => scoreShadow(txLabel, tx, r, ctx, ev).result!;
assert.equal(scoredTx(rankFile([["Houston Police Department", "TXHPD0000", 108], ["Dallas Police Department", "TXDPD0000", 84], [null, "TX9999900", 60]])).values, "match");
const swapped = scoredTx(rankFile([["Dallas Police Department", "TXDPD0000", 84], ["Houston Police Department", "TXHPD0000", 108], [null, "TX9999900", 60]]));
assert.deepEqual([swapped.values, swapped.diffs.some((d) => d.field === "position Houston Police Department")], ["mismatch", true], "the order is checked");
assert.equal(scoreShadow(wichitaLabel, wichita, r, ctx, v7({ grouping: "rate", agencies: [{ agency_name: "Wichita Police Department", total: { status: "VALUE", value: 60 }, rate: { status: "VALUE", value: 15 } }] })).result!.values, "match");
assert.equal(scoreShadow(wichitaLabel, wichita, r, ctx, v7({ grouping: "rate", agencies: [{ agency_name: "Wichita Police Department", total: { status: "VALUE", value: 60 }, rate: { status: "VALUE", value: 15.1 } }] })).result!.values, "mismatch");
// Increment 7b (LS-424): one agency's rate file also gives its count, for a follow-up that asks for the count.
assert.deepEqual(v7({ grouping: "rate", agencies: [{ agency_name: "Wichita Police Department", total: { status: "VALUE", value: 60 }, rate: { status: "VALUE", value: 15 } }] }).get("LS-999|count"),
  [{ key: "", value: 60, status: "VALUE" }]);

// A label's agency in other words than the FBI's is the same agency; another agency is not.
assert.equal(fbiNameFor("Portland Police Bureau", "OR0260200"), "Portland Police Department");
assert.equal(fbiNameFor("Washington Metropolitan Police Department", "DCMPD0000"), "Washington Police Department");
assert.equal(fbiNameFor("Nashville Police Department", "TNMPD0000"), null);

// Codex review 02's findings, each a regression.
// 1. A set of years is those years only.
const setYears = as(ask("Shoplifting rate in Wichita in 2019 and 2023"), "answer");
assert.deepEqual(setYears.delivered.table.rows.map((x) => x[0]), ["2019", "2023"]);
assert.ok(setYears.delivered.text[0].includes("2019 and 2023"));
// 2. A conflict refuses a ranking (D6); it is never read as a month not reported.
CONFLICT = { ori: "TXHPD0000", ym: "2024-02" };
assert.match(as(ask("Which Texas cities had the most shoplifting in 2024?"), "decline").explanation, /disagree with its record of which months it reported, so no ranking is given/);
CONFLICT = null;
// 3. The same agency twice, by month: the time grouping keeps its binding.
assert.equal(ask("Shoplifting in Tulsa Police Department and Tulsa by month in 2023").kind, "answer");
// 4. "Combined" of several crimes is declined, never answered as separate numbers.
assert.match(as(ask("Shoplifting and carjackings combined in Detroit in 2023"), "decline").explanation, /combined/);
// 5. The combined headline's number must be the table's.
const combinedLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Tulsa Police Department", state: "OK" }, { kind: "agency", name: "Oklahoma City Police Department", state: "OK" }],
  period: year24, measures: [{ name: "shoplifting", unit: "offense" }], filters: [], groupings: [], statistic: "count", combine: "combined" }, values: { status: "pending_build" }, statements: ["gives one total of both agencies", "names its source at the end"] });
assert.deepEqual(material(combinedTotal, combinedLabel), []);
assert.ok(material({ ...combinedTotal, delivered: { ...combinedTotal.delivered, text: [combinedTotal.delivered.text[0].replace("120", "999"), ...combinedTotal.delivered.text.slice(1)] } }, combinedLabel).includes("statement"));
// 6. The left-out line must be there, with each agency's months.
const hide = (t: string[]) => scoreShadow(txLabel, { ...tx, delivered: { ...tx.delivered, text: t } }, r, ctx,
  rankFile([["Houston Police Department", "TXHPD0000", 108], ["Dallas Police Department", "TXDPD0000", 84], [null, "TX9999900", 60]])).result!.values;
assert.equal(hide(tx.delivered.text.filter((t) => !t.startsWith("Not ranked"))), "mismatch", "a missing left-out line");
assert.equal(hide(tx.delivered.text.map((t) => t.replace("(11 months)", "(10 months)"))), "mismatch", "a wrong month count");
// Return A short names (Jeff 2026-10-30) say so, and are never "the <name> Police Department".
assert.equal(agencyName(places, "AK0014700"), "Kake (FBI Return A name)");
assert.equal(reportedBy([agencyName(places, "AK0014700")]), "Reported by Kake (FBI Return A name).");
assert.equal(reportedBy([agencyName(places, "TNMPD0000")]), "Reported by the Memphis Police Department.");
// 7. A sheriff's office is never matched to a police department.
assert.equal(fbiNameFor("Wichita Sheriff Office", "KS0870300"), null);
// Re-check A: several agencies by year are declined, never answered with the first agency alone.
assert.equal(ask("Shoplifting in Tulsa and Oklahoma City combined by year from 2021 to 2024").kind, "decline");
// Re-check B: one agency named twice, "combined", is that agency once.
assert.equal(ask("Shoplifting in Tulsa Police Department and Tulsa combined in 2024").kind, "answer");
// Review 04: several crimes "combined" is declined even when one agency is named twice.
assert.match(as(ask("Shoplifting and carjackings combined in Tulsa Police Department and Tulsa in 2023"), "decline").explanation, /combined/);
// Re-check C: more than five left out: the count and five distinct names, each with its months.
const six = ["A", "B", "C", "D", "E", "F"].map((x, i) => ({ ori: `TX000000${i}`, agency_name: `${x} Police Department`, months_reported: Array(i + 1).fill("2024") }));
const sixLine = (names: string[]) => `Not ranked because they didn't report all 12 months of 2024: 6 agencies, the largest ${names.join(", ")}.`;
const withLine = (line: string, left: typeof six) => scoreShadow(txLabel, { ...tx, delivered: { ...tx.delivered, text: tx.delivered.text.map((t) => (t.startsWith("Not ranked") ? line : t)) } }, r, ctx,
  rankFile([["Houston Police Department", "TXHPD0000", 108], ["Dallas Police Department", "TXDPD0000", 84], [null, "TX9999900", 60]], left)).result!.values;
assert.equal(withLine(sixLine(six.slice(0, 5).map((a, i) => `${a.agency_name} (${i + 1} month${i ? "s" : ""})`)), six), "match", "the first name follows \"the largest\"");
const twoOut = six.slice(0, 2);
assert.equal(withLine(`Not ranked because they didn't report all 12 months of 2024: A Police Department (1 month), A Police Department (1 month).`, twoOut), "mismatch", "names are distinct");
// 8. A blank rate says why: no population is not months unknown.
assert.match(raleigh.delivered.text[0], /because the FBI gives no 2024 population for the /);

// Increment 5. A Part I offense for a state or the nation, completed years: the historical file (P53), "Source: Crime Index."
// (P63), with what it read; the covered part of a span with the rest named (D04, P14); a change (P54).
const srs = (q: string) => { const o = ask(q); assert.equal(o.kind, "srs", `${q}: ${JSON.stringify(o).slice(0, 200)}`); return o as Extract<ShadowOutcome, { kind: "srs" }>; };
const txRob = srs("Robberies in Texas in 2024");
assert.deepEqual([txRob.delivered.table.rows, txRob.delivered.text, txRob.read.column, txRob.read.uids], [[[19935]], ["Texas: 19,935 robberies in 2024.", "Source: Crime Index."], "robbery_total", ["tx_2024"]]);
assert.deepEqual(srs("Burglary rate in Ohio in 2022").delivered.table.rows, [[259.5]]);
assert.equal(srs("Violent crime in California in 2024").read.column, "violent_total", "the file's own sum, never re-added");
assert.deepEqual(srs("Did robberies go up in Georgia in 2025?").delivered.table.rows, [[4426, 3799, -627, -14.2]]);
assert.deepEqual(srs("Murder clearance rate in the US in 2023").delivered.table.rows, [[57.8]]);
const span = srs("Robberies in Texas by year from 1955 to 1965");
assert.deepEqual(span.delivered.table.rows.map((x) => x[0]), ["1960", "1961", "1962", "1963", "1964", "1965"]);
assert.ok(span.delivered.text.includes("State figures in the data cover 1960 through 2025; 1955 through 1959 are outside them."));
assert.equal(as(ask("Robberies in Texas in 1955"), "decline").reason, "outside_release_coverage");
assert.equal(as(ask("Aggravated assault clearance rate in Ohio in 2023"), "decline").reason, "not_recorded_in_nibrs", "P18");
assert.match(as(ask("Carjacking clearance rate in Texas in 2024"), "decline").explanation, /no state clearance rate.*not yet decided/);
// Routes (P53): the current year to Current Trends, murders by relationship to Homicide Reports; named, not run.
assert.deepEqual([ask("Robberies in Texas this year").kind, (ask("Robberies in Texas this year") as { source: string }).source], ["route", "rtci"]);
assert.equal((ask("Murders in the US by victim-offender relationship in 2023") as { source?: string }).source, "shr");
// Increment 6 (P57): a Part I clearance rate for an agency in a completed year is Historical's, named, not run.
assert.equal((ask("Robbery clearance rate in Atlanta in 2023") as { source?: string }).source, "historical");
// Increment 6: plans. A clearance breakdown in a list with a period; the share cleared as the cleared units (with their
// incidents) over all units; arrests through the incident as every arrest on an incident with the condition. The plans
// only: the stub returns no rows.
const planOf = (q: string) => { const o = shadowAnswer(q, { ...deps, execute: () => [] }); return o.kind === "answer" ? o.plan : (assert.fail(`${q}: ${JSON.stringify(o).slice(0, 300)}`) as never); };
assert.deepEqual(planOf("Memphis shoplifting by year and clearance status, 2023 to 2024").groupings.map((g) => g.dimension), ["time.year", "offense.clearance_status"]);
assert.deepEqual(planOf("Memphis shoplifting by clearance type and year, 2023 to 2024").groupings.map((g) => g.dimension), ["time.year", "offense.clearance_type"]);
assert.deepEqual(planOf("What share of shoplifting offenses in Memphis in 2024 were cleared?").statistics.map((s) => s.kind), ["count", "incidents", "count", "ratio"]);
const through = planOf("Arrests in Memphis in 2024 for incidents that included a robbery");
assert.deepEqual([through.measures[0].id, through.timeBasis, JSON.stringify(through.filters[0])], ["arrests.all_crime", "arrest_date",
  JSON.stringify({ kind: "exists", scope: "incident", entity: "offense", where: [{ kind: "attribute", dimension: "offense.offense", op: "in", values: ["120"] }] })]);
assert.equal(planOf("Arrests in Memphis in 2024 for incidents where a firearm was stolen").measures[0].id, "arrests.all_crime");
// Codex increment-6 review 02. (1) A restricted clearance rate never routes with its restriction dropped.
assert.notEqual(ask("Robbery clearance rate in Atlanta in 2023 where a firearm was stolen").kind, "route");
// (2) A car is an automobile (03), not every vehicle.
const carWhere = (planOf("Motor vehicle thefts in Dallas in 2024 where a car was recovered").filters[0] as { where: { dimension: string; values: string[] }[] }).where;
assert.deepEqual(carWhere.find((w) => w.dimension === "property.description")!.values, ["03"]);
// (3) The share cleared's roles are read from the plan only against a denominator of the label's own measure.
const shareView = planToMeaning(planOf("What share of shoplifting offenses in Memphis in 2024 were cleared?"), { kind: "absolute", from: "2024-01", to: "2024-12" });
const shareLabel = (denominator: string) => ({ source: "nibrs", filters: ["cleared (by arrest or exceptional means)"], groupings: [], statistic: "share", denominator,
  places: [{ kind: "agency", name: "Memphis Police Department", state: "TN" }], period: { from: "2024-01", to: "2024-12" }, measures: [{ name: "shoplifting", unit: "offense" }] }) as unknown as Parameters<typeof compareMeaning>[0];
const rel = { firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" };
assert.deepEqual(compareMeaning(shareLabel("all shoplifting offenses in the period"), shareView, rel), []);
assert.ok(compareMeaning(shareLabel("all robbery offenses in the period"), shareView, rel).some((x) => x.field === "share roles" && x.kind === "unverified"));
// A NIBRS-only crime for a state (P61), on the stub: every reported month summed (Austin's 11 months included), the
// disclaimer, and the button's fixed every-month set; the rate over the agencies counted (P62); "according to NIBRS".
const txCj = as(ask("Carjackings in Texas in 2024"), "answer");
const first = (o: ShadowOutcome) => as(o, "answer").delivered.table.rows.map((x) => x[0]);
assert.deepEqual(txCj.delivered.table.rows, [[307]], "Houston 108 + Dallas 84 + Austin 55 (11 months) + 60");
// P87 (Jeff 2026-11-01): the agencies and the population they cover are columns only when asked for; carried in stateSum.
assert.deepEqual(txCj.delivered.table.columns.map((c) => c.header), ["Carjacking offenses"]);
assert.ok(!txCj.delivered.text.some((t) => /residents covered|share of residents|Residents covered/i.test(t)), txCj.delivered.text.join(" / "));
assert.equal(txCj.buttons![0].label, "Consistent Reporting Agencies");
assert.deepEqual(txCj.stateSum!.years.map((y) => [y.agencies, y.partial, y.every.agencies, y.every.sum]), [[4, 1, 3, 252]]);
// One short note line, then the source (Jeff 2026-11-01).
// Jeff (2026-11-01): his note, then the source; nothing else.
assert.deepEqual(txCj.delivered.text.slice(1), ["Includes all agencies.", "Source: FBI NIBRS."]);
const txEvery = txCj.buttons![0].continuation as Extract<ShadowOutcome, { kind: "answer" }>;
assert.deepEqual([txEvery.plan.coverage.cohort, txEvery.delivered.table.rows], ["same_agencies", [[252]]]);
assert.deepEqual(txEvery.delivered.table.columns.map((c) => c.header), ["Carjacking offenses"]);
// The fixed set named with its whole span (Jeff 2026-11-01), never a bare "every month".
assert.match(txEvery.delivered.text[0], /counting only the 3 Consistent Reporting Agencies that reported every month from January 2024 through December 2024\.$/);
assert.deepEqual(first(ask("Carjackings in Texas in 2024, only agencies that reported every month")), [252], "the button's question, typed");
assert.deepEqual(first(ask("Carjacking rate in Texas in 2024")), [6.7], "307 per 4,570,000 residents of the agencies counted");
assert.equal(as(ask("Robberies in Texas in 2024 according to NIBRS"), "answer").plan.source, "nibrs", "P01: the source asked for in words");
// Scoring increment 5: the historical file's values with their column and row; a route verifies routing only; a state
// sum's view, rows and disclaimer figures.
const year24b = { from: "2024-01", to: "2024-12" };
const srsLabel = label({ action: "answer", meaning: { source: "historical", places: [{ kind: "state", name: "Texas", state: "TX" }], period: year24b, measures: [{ name: "robbery", unit: "offense" }], filters: [], groupings: [], statistic: "count" },
  values: { status: "pending_build" }, statements: ["names the state (Texas)", "ends with the source line \"Source: Crime Index.\" (P63)"] });
const srsV = (value: number, column = "robbery_total") => sliceValues([{ name: "V", json: JSON.stringify({ basis: "crime_index_snapshot", nibrsai_cases: "LS-999", values: [{ uid: "tx_2024", year: 2024, column, value: String(value) }] }) }]);
assert.equal(scoreShadow(srsLabel, txRob, r, ctx, srsV(19935)).result!.outcome, "correct");
assert.equal(scoreShadow(srsLabel, txRob, r, ctx, srsV(19936)).result!.outcome, "wrong_answer");
assert.equal(scoreShadow(srsLabel, txRob, r, ctx, srsV(19935, "robbery_capita")).result!.outcome, "wrong_answer", "provenance: the column read");
// A file listing supporting values after the answer's own (a sum's parts) scores on the first value of the year.
const withParts = sliceValues([{ name: "V", json: JSON.stringify({ basis: "crime_index_snapshot", nibrsai_cases: "LS-999", values: [{ uid: "tx_2024", year: 2024, column: "robbery_total", value: "19935" }, { uid: "tx_2024", year: 2024, column: "murder_total", value: "1" }] }) }]);
assert.equal(scoreShadow(srsLabel, txRob, r, ctx, withParts).result!.outcome, "correct");
const routeLabel = label({ action: "answer", meaning: { source: "rtci", places: [{ kind: "state", name: "Texas", state: "TX" }], period: { rule: "year to date through the latest reported month" }, measures: [{ name: "robbery", unit: "offense" }], filters: [], groupings: [], statistic: "count" }, values: { status: "pending_build" }, statements: [] });
assert.equal(scoreShadow(routeLabel, ask("Robberies in Texas this year"), r, ctx).result!.outcome, "unverified", "a route verifies the routing only");
const sumV = (sum: number, agencies = 4) => sliceValues([{ name: "V", json: JSON.stringify({ basis: "raw", nibrsai_cases: "LS-999", by_year: [{ year: 2024, agencies_counted: agencies, partial_reporters: 1, all_months_sum: sum, every_month_agencies_sum: 252,
  coverage: { any_month: { agencies, share: txCj.stateSum!.years[0].share }, every_month: { agencies: 3, share: txCj.stateSum!.years[0].every.share } } }] }) }]);
const sumLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "state", name: "Texas", state: "TX" }], period: year24b, measures: [{ name: "carjacking", unit: "offense" }], filters: [], groupings: [], statistic: "count", cohort: "all_reporting" }, values: { status: "pending_build" },
  statements: ["states how many agencies are counted, what share of residents they cover, and that agencies reporting only some months are included (P61)", "offers a button to show only agencies that reported every month of the period; clicking it keeps Texas, carjackings and 2024 and counts only the agencies that reported all 12 months (P61)", "ends with the source line \"Source: FBI NIBRS.\" (P63)"] });
{ const sc = scoreShadow(sumLabel, txCj, r, ctx, sumV(307)).result!; assert.equal(sc.outcome, "correct", JSON.stringify(sc.diffs)); }
assert.equal(scoreShadow(sumLabel, txCj, r, ctx, sumV(306)).result!.values, "mismatch");
assert.equal(scoreShadow(sumLabel, txCj, r, ctx, sumV(307, 5)).result!.values, "mismatch", "the disclaimer's agencies are checked");
assert.ok(material({ ...txCj, buttons: [] }, sumLabel).includes("statement"), "the button must be there");

// Codex increment-5 review 2's findings, each a regression.
// 1. The historical file has whole years only: a month or a part-year comparison is declined, never answered as years.
assert.notEqual(ask("Robberies in Texas by month in 2024").kind, "srs");
assert.notEqual(ask("Robberies in Texas from January to June 2024 compared with January to June 2023").kind, "srs");
// 2. The every-month cohort survives source selection: a Part I crime with it is a NIBRS state sum over that set.
const txRobEvery = ask("Robberies in Texas in 2024, only agencies that reported every month");
assert.ok(txRobEvery.kind === "answer" && txRobEvery.plan.coverage.cohort === "same_agencies", JSON.stringify(txRobEvery).slice(0, 160));
// 3. Incidents are not the file's unit.
assert.notEqual(ask("Murder incidents in Texas in 2024").kind, "srs");
// 4. A conflict month is not summed, and is said; the agency leaves the every-month set.
CONFLICT = { ori: "TXHPD0000", ym: "2024-02" };
const txConflict = as(ask("Carjackings in Texas in 2024"), "answer");
assert.deepEqual([first(txConflict), txConflict.stateSum!.years[0].conflicts, txConflict.stateSum!.years[0].every.agencies], [[298], 1, 2]);
// Jeff (2026-11-01): one note only; a conflict month is still not counted (the figures above), no longer said.
assert.ok(!txConflict.delivered.text.some((t) => /disagree/.test(t)), txConflict.delivered.text.join(" / "));
CONFLICT = null;
// 5. A missing population is never 0: no rate, and the share covered is a lower bound.
assert.match(as(ask("Shoplifting rate in North Carolina in 2024"), "answer").delivered.text[0], /no rate is given for 2024, because 1 of the agencies counted have no FBI population/);
const nc = as(ask("Shoplifting in North Carolina in 2024, with the number of agencies reporting"), "answer");
assert.match(String(nc.delivered.table.rows[0][2]), /^≥[\d.]+%$/, "a lower bound is marked in its cell");
assert.deepEqual(nc.delivered.text.slice(1), ["Includes all agencies.", "Source: FBI NIBRS."]);
// 6. A span reaching this year: its completed years, this year named; a future year is declined.
const toNow = srs("Robberies in Texas by year from 2020 to 2026");
assert.deepEqual([toNow.delivered.table.rows.map((x) => x[0]), toNow.delivered.text[1]], [["2020", "2021", "2022", "2023", "2024", "2025"], "2026 is this year: its figures come from Current Trends (Crime Index) and are not included here."]);
assert.equal(ask("Robberies in Texas in 2027").kind, "decline");
// 7. "According to NIBRS" overrides the Homicide Reports route (P01).
assert.notEqual(ask("Murders in the US by victim-offender relationship in 2023 according to NIBRS").kind, "route");
// 8. By year, one year: the Year cell is there.
assert.deepEqual(as(ask("Carjackings in Texas by year in 2024"), "answer").delivered.table.rows, [["2024", 307]]);
// 9. The disclaimer's figures are read in their roles: "14 agencies" never passes for 4.
const txCjA = as(ask("Carjackings in Texas in 2024, with the number of agencies reporting"), "answer");
const share24 = `${txCjA.stateSum!.years[0].share.toFixed(1)}%`;
assert.deepEqual(txCjA.delivered.table.rows, [[307, 4, share24]], "asked for: 4 agencies reporting; their population covered");
assert.equal(material(txCjA, sumLabel).includes("statement"), false);
const wrongCount = { ...txCjA, delivered: { ...txCjA.delivered, table: { ...txCjA.delivered.table, rows: [[307, 14, share24]] } } };
assert.ok(material(wrongCount, sumLabel).includes("statement"));
// Codex review 03. 1: the every-month view over years qualifies a missing population too.
const ncEvery = as(ask("Shoplifting in North Carolina by year from 2023 to 2024, only agencies that reported every month, with the number of agencies reporting"), "answer");
assert.ok(ncEvery.delivered.table.rows.every((r) => /^≥[\d.]+%$/.test(String(r[3]))), JSON.stringify(ncEvery.delivered.table.rows));
assert.ok(ncEvery.delivered.text.includes("Includes only agencies that reported complete data."));
// 2: a span from this year into the future is declined, never routed as this year alone.
assert.equal(as(ask("Robberies in Texas by year from 2026 to 2027"), "decline").reason, "outside_release_coverage");

// Increment 7: people (P29, P30, P44, P49, P65). The reading pre-pass takes the people wording; the plan carries it.
{
  const rq = (q: string) => readQuestion(q, 2026, "2026-09");
  assert.deepEqual(rq("Aggravated assaults in Memphis in 2024 by offender race").people, { by: { who: "offender", attr: "race", paired: false }, where: [], ask: null });
  assert.deepEqual(rq("Murder victims in Memphis in 2024 by the race of the offender who killed them").people?.by, { who: "offender", attr: "race", paired: true });
  assert.deepEqual(rq("Aggravated assaults by juveniles in Memphis in 2024").people?.where, [{ who: "offender", attr: "age", range: [1, 17], paired: false }]);
  assert.deepEqual(rq("Aggravated assaults against juveniles in Memphis in 2024").people?.where, [{ who: "victim", attr: "age", range: [1, 17], paired: false }]);
  assert.deepEqual(rq("Juvenile arrests for robbery in Detroit in 2024").people?.where, [{ who: "arrestee", attr: "age", range: [1, 17], paired: false }]);
  assert.equal(rq("Arrests in Denver in 2023 by arrestee race").text, "All crime arrests in Denver in 2023");
  assert.equal(rq("Murders by young adults in Memphis in 2024").people?.ask, "young adults");
  // "By juveniles" is read, so it is no longer an unread offender group (P29's decline).
  assert.equal(rq("Aggravated assaults by juveniles in Memphis in 2024").offenders, false);
  const g = (q: string) => planOf(q).groupings.map((x) => `${x.dimension}${x.multiValue ? "*" : ""}${x.bins ? "[bins]" : ""}`);
  const f = (q: string) => JSON.stringify(planOf(q).filters);
  assert.deepEqual(g("Aggravated assaults in Memphis in 2024 by offender race"), ["offender.race*"]);
  assert.deepEqual(g("Robberies in Detroit in 2024 by offender age"), ["offender.age*[bins]"]);
  assert.deepEqual(g("According to NIBRS, murder victims in Memphis in 2024 by the race of the offender who killed them"), ["victim_offender.offender_race*"]);
  assert.deepEqual(g("Arrests in Denver in 2023 by arrestee age"), ["arrestee.age[bins]"]);
  assert.match(f("Aggravated assaults by juveniles in Memphis in 2024"), /"scope":"incident","entity":"offender".*"offender.age","op":"between","values":\[1,17\]/);
  assert.match(f("Aggravated assaults against juveniles in Memphis in 2024"), /"dimension":"victim.age","op":"between"/);
  assert.match(f("Aggravated assault victims of offenders who were under 18, in Memphis in 2024, by victim race"), /"scope":"victim","entity":"victim_offender".*"victim_offender.offender_age"/);
  assert.match(f("Offenders in aggravated assaults in Memphis in 2024 by sex, where the victim was a stranger"), /"scope":"offender","entity":"victim_offender".*"values":\["ST"\]/);
  // Codex 05: "by victim race" for victims is the victims' own breakdown, answered.
  assert.deepEqual(g("Aggravated assault victims in Memphis in 2024, by victim race"), ["victim.race"]);
  // Codex 04.2: a victim's attribute on arrests is declined, never answered as the arrestee's.
  assert.match(as(ask("Arrests in Denver in 2023 by victim race"), "decline").explanation, /a victim's race for arrests/);
  // Element 31 (coordinator 2026-11-04): a breakdown of victims; a filter on murder or aggravated assault victims, named
  // and with the unknown-circumstance note; other crimes declined; a state's murder by circumstance is Homicide Reports'.
  {
    const by = as(ask("Murder victims in Memphis by circumstance in 2024"), "answer");
    assert.ok(by.plan.groupings.some((x) => x.dimension === "victim_circumstance.circumstance" && x.multiValue === "each_value"));
    // Code 06 is held back until the domestic violence note (Jeff 2026-11-04): no row, no name, its count in a plain note
    // with no DV wording; and no filter can name it.
    {
      const stats = by.plan.statistics.map((x) => x.as);
      const cols = ["victim_circumstance.circumstance", ...stats.flatMap((x) => [x, `${x}_status`])];
      const row = (c: string, n: number) => [c, ...stats.flatMap((x, i) => [i === 0 ? n : n / 251, "VALUE"])];
      const d = deliver(by.plan, { from: "2024-01", to: "2024-12" }, "2024-12", cols, [row("01", 54), row("06", 3), row("10", 170)], [], "r", [], null);
      assert.deepEqual(d.table.rows.map((r) => r[0]), ["Argument", "Unknown circumstances"]);
      assert.ok(d.text.includes("One circumstance category is left out of this table for now: 3 murder victims were recorded under it."), JSON.stringify(d.text));
      assert.ok(!/lover|domestic|intimate|partner/i.test(JSON.stringify(d)), "no DV wording, no FBI name for 06");
      assert.ok(!("06" in CIRCUMSTANCE));
    }
    const f = as(ask("Gang-related murders in Memphis in 2024"), "answer");
    assert.ok(f.plan.filters.some((x) => x.kind === "exists" && x.entity === "victim_circumstance"));
    assert.ok(f.delivered.text[0].includes("where the circumstance was gangland (organized crime involvement) or juvenile gang"));
    assert.ok(f.delivered.answerStatements.includes("circumstance_unknown"));
    assert.match(as(ask("Gang-related robberies in Memphis in 2024"), "decline").explanation, /recorded for murder and aggravated assault victims/);
    assert.equal(as(ask("Gang-related murders in Tennessee in 2024"), "route").source, "shr");
    // Codex circumstance review 01.1: an offered question keeps the circumstance, or none is offered.
    const fb = ask("Gang-related aggravated assaults in Memphis by sex and race in 2024");
    if (fb.kind === "decline" && fb.alternative) assert.match(fb.alternative.question ?? "", /gang-related/i);
  }
  // P53 (Codex state-categories review 01.2): murder by a Homicide Report detail for a state or the nation, NIBRS not
  // named, is Homicide Reports'; named, NIBRS sums it.
  assert.equal(as(ask("Murder victims in Tennessee by race in 2024"), "route").source, "shr");
  assert.equal(ask("Murder victims in Tennessee by race in 2024, according to NIBRS").kind, "answer");
  assert.notEqual(ask("Murders in Tennessee in 2024 by clearance type").kind, "route", "a clearance is not a Homicide Report detail");
  // A detail selected, not only broken down (query-log scorecard 2026-11-04): a state's female victims, the nation's
  // handgun murders; a city stays NIBRS's, and so does a state with NIBRS named.
  assert.equal(as(ask("How many murders of females were there in Minnesota in 2023"), "route").source, "shr");
  assert.equal(as(ask("Handgun murders in the United States in 2024"), "route").source, "shr");
  assert.equal(ask("Female murder victims in Memphis in 2023").kind, "answer");
  assert.equal(ask("Murders of females in Minnesota in 2023 according to NIBRS").kind, "answer");
  // Codex P53 review 01: only when every filter is such a detail, and only for victims.
  assert.notEqual(ask("Female murder victims in Texas in 2024 cleared by arrest").kind, "route");
  assert.notEqual(ask("Female murder offenders in Ohio in 2022").kind, "route");
  // Reader cluster 2: a change over a span ("changed since 2020", "over the past 5 years") is the series over it;
  // "trended"/"trending" read as "trend"; two named years stay a comparison.
  for (const q of ["How has robbery changed in Denver since 2020?", "How have robberies in Denver trended since 2020?", "Is the Denver robbery rate trending up over the past 5 years?"]) {
    const o = ask(q);
    assert.ok(!(o.kind === "decline" && /didn't understand|couldn't tell|two named years|two years/.test(o.explanation)), `${q}: ${JSON.stringify(o).slice(0, 160)}`);
  }
  // Reader cluster 3: a year to the latest data ("2015 to present", "to the most recent month") is "since" that year;
  // "as far back as you can", "full history", "historical", "all available years" are every year (D5).
  for (const q of ["Denver robberies 2018 to present", "Denver robberies from 2018 to the most recent data", "Denver robberies as far back as you can", "the full history of robberies in Denver", "historical robbery counts in Denver"]) {
    const o = ask(q);
    assert.ok(!(o.kind === "decline" && /didn't understand|couldn't tell/.test(o.explanation)), `${q}: ${JSON.stringify(o).slice(0, 160)}`);
  }
  // "Current trend" (Jeff 2026-11-05): Current Trends' recent months, by month from January of last year; never declined
  // for "current".
  {
    const o = ask("What are the current robbery trends in Denver?");
    assert.ok(!(o.kind === "decline" && /didn't understand/.test(o.explanation)), JSON.stringify(o).slice(0, 200));
    if (o.kind === "answer") assert.ok(o.plan.groupings.some((g) => g.dimension === "time.month"), "by month");
  }
  // Redesign case: a place outside the U.S. is declined plainly (never a U.S. place). (An unknown U.S.-looking place,
  // "Zzyzxville", still asks which place, as on dev: a "couldn't find" rule is a later item.)
  assert.match(as(ask("robberies in Paris, France in 2025"), "decline").explanation, /U\.S\. law enforcement agencies only/);
  assert.notEqual(ask("robberies in New Mexico in 2024").kind, "decline");
  // Codex re-check: a country name that continues a U.S. place name is never declined as foreign.
  for (const q of ["murders in Mexico Missouri in 2024", "murders in Brazil Indiana in 2024", "murders in China Grove, Texas in 2024", "murders in New  Mexico in 2024"])
    assert.ok(!/U\.S\. law enforcement agencies only/.test(JSON.stringify(ask(q))), q);
  // Codex reader-change review 01: a percent change over a span is never answered as counts.
  for (const q of ["What is the % change in robberies in Denver since 2019?", "percent change in robberies in Denver since 2019"]) assert.notEqual(ask(q).kind, "answer", q);
  // Reader cluster 1 and P94 (Jeff 2026-11-05): a rolling window of any length named is read and computed at that
  // length; an average is the window's total over its months, labeled as an average; no length named asks which.
  for (const q of ["Pittsburgh murders rolling over 12 months since 2018", "Denver robberies 12 months rolling since 2020", "Denver robberies on a rolling 12 month basis since 2020", "Denver robberies 12m rolling since 2020"]) {
    const o = ask(q);
    assert.ok(!(o.kind === "decline" && /didn't understand|couldn't tell/.test(o.explanation)), `${q}: ${JSON.stringify(o).slice(0, 160)}`);
  }
  {
    const six = ask("Denver robberies rolling over 6 months since 2025");
    if (six.kind === "answer") assert.ok(six.plan.transforms.some((t) => t.kind === "rolling" && t.months === 6) && six.delivered.text[0].includes("rolling 6-month totals"), JSON.stringify(six.delivered.text));
    else assert.ok(!(six.kind === "decline" && /didn't understand/.test(six.explanation)), JSON.stringify(six).slice(0, 200));
    const avg = ask("Denver robberies 3-month rolling average since 2025");
    if (avg.kind === "answer") assert.ok(avg.delivered.text[0].includes("rolling 3-month averages") && avg.delivered.table.columns.some((c) => /average per month/.test(c.header)), JSON.stringify(avg.delivered.text));
    assert.equal(as(ask("Denver robberies rolling average since 2025"), "clarify").about, "which rolling window");
    // Codex P94 review 01: a length the engine can't compute is asked about, never 12; a 1-month window runs.
    assert.equal(as(ask("Denver robberies rolling 0 months since 2025"), "clarify").about, "which rolling window");
    assert.ok(!(ask("Denver robberies rolling 1-month since 2025").kind === "decline"));
  }
  // P32: "sex offenses", "sex crimes", "sexual assaults" ask which (rape; all sex offenses), each button running.
  for (const q of ["Sex crimes in Denver in 2023", "Sexual assaults in Ohio in 2024"]) {
    const c = as(ask(q), "clarify");
    assert.equal(c.about, "which sex offenses");
    // Only buttons that run are offered: rape from Crime Index where it is loaded, all sex offenses from NIBRS.
    assert.ok(c.options.some((o) => o.label === "All sex offenses") && c.options.every((o) => ["Rape", "All sex offenses"].includes(o.label)), JSON.stringify(c.options.map((o) => o.label)));
    assert.ok(c.options.every((o) => o.continuation && o.continuation.kind !== "decline"), q);
  }
  // Codex P32 review 01: "forcible sex offenses" is read and asked about (not all six codes); kits are not an offense.
  assert.equal(as(ask("forcible sex offenses in Denver in 2023"), "clarify").about, "which sex offenses");
  assert.notEqual(ask("all sex offenses in Denver in 2023").kind, "clarify");
  assert.ok(!(ask("sexual assault kits in Denver in 2023").kind === "clarify"));
  for (const q of ["crime and murder rates in Chicago in 2024", "murder and crime in Chicago in 2024", "crime and drug possession in Chicago in 2024", "crime rates and aggravated assault rates in Chicago in 2024"]) {
    const o = ask(q);
    assert.ok(o.kind === "clarify" ? o.about === "which kind of crime" : o.kind === "decline" && /isn't one category/.test(o.explanation), q);
  }
  assert.ok(!/isn't one category/.test(JSON.stringify(ask("murders and crimes against persons in Chicago in 2024"))));
  // D09 beside another crime: the bare "crime" is never dropped; the crime named is offered on its own.
  {
    const o = ask("murder and crime in Chicago in 2024");
    // (Its alternative, the crime named on its own, is offered where it runs: Crime Index is not loaded in these tests.)
    assert.ok(o.kind === "clarify" ? o.about === "which kind of crime" : o.kind === "decline" && /isn't one category/.test(o.explanation), JSON.stringify(o).slice(0, 200));
  }
  // A people breakdown for a state is NIBRS's sum by category (coordinator 2026-11-04), never the historical file's.
  {
    const o = as(ask("Aggravated assaults in Tennessee in 2024 by offender sex"), "answer");
    assert.ok(o.plan.groupings.some((x) => /offender_sex|offender\.sex/.test(x.dimension)) && o.stateSum && o.delivered.text.at(-1) === "Source: FBI NIBRS.");
  }
  // "Young adults" and "attackers" are asked about, with buttons that keep the rest of the question (P22).
  assert.deepEqual(as(ask("Murders by young adults in Memphis in 2024"), "clarify").options.map((o) => o.label), ["18 to 24", "18 to 29"]);
  assert.deepEqual(as(ask("How many attackers were there in aggravated assaults in Detroit in 2024?"), "clarify").options.map((o) => o.label), ["Offenders", "People arrested"]);
}

// Increment 7b. P71: each quarter is the sum of its three months; a quarter with a month not known (March 2024 in the
// stub) is blank and named incomplete, never shown as a whole quarter.
{
  const qa = as(ask("Shoplifting in Memphis by quarter in 2024"), "answer");
  assert.deepEqual(qa.plan.groupings.map((g) => g.dimension), ["time.quarter"]);
  assert.deepEqual(qa.delivered.table.rows, [["2024-Q1", null], ["2024-Q2", 21], ["2024-Q3", 21], ["2024-Q4", 21]]);
  assert.ok(!qa.delivered.text.some((t) => /^Each quarter's figure/.test(t)), "P86: no quarter note");
  assert.ok(qa.delivered.text.some((t) => /^Incomplete: Q1 2024/.test(t)), qa.delivered.text.join("\n"));
  assert.equal(as(ask("Shoplifting rate in Memphis by quarter in 2024"), "decline").kind, "decline");
  // Codex 7b-04.3: quarters never widen the period asked (a set of years; a period starting or ending inside a quarter).
  assert.match(as(ask("Shoplifting in Memphis by quarter in 2021 and 2024"), "decline").explanation, /quarters of a set of years/);
  assert.match(as(ask("Shoplifting in Memphis by quarter from February 2024 to December 2024"), "decline").explanation, /starts or ends inside a quarter/);
  // Codex 7b-04.4: both supporting columns at once are declined, never one dropped.
  assert.match(as(ask("Shoplifting rate in Kansas in 2024, with a column showing the population used to calculate the rate, with the number of agencies reporting"), "decline").explanation,
    /population and the agencies reporting together/);
  // P72: the population a rate divides by, in its own column beside the unchanged rate.
  const pa = as(ask("Shoplifting rate in Wichita in 2024, with a column showing the population used to calculate the rate"), "answer");
  const plain = as(ask("Shoplifting rate in Wichita in 2024"), "answer");
  assert.deepEqual(pa.delivered.table.columns.map((c) => c.header), [...plain.delivered.table.columns.map((c) => c.header), "Population"]);
  assert.deepEqual(pa.delivered.table.rows, [[plain.delivered.table.rows[0][0], 400_000]]);
  assert.ok(pa.plan.statistics.some((s) => s.kind === "population" && s.of === plain.plan.statistics[0].as));
  // Codex 7b-04.6: the population column is checked against the independent file's population, not found in the text.
  const popFile = (population: number) => v7({ grouping: "rate", agencies: [{ agency_name: "Wichita Police Department", population, total: { status: "VALUE", value: 60 }, rate: { status: "VALUE", value: 15 } }] });
  assert.equal(scoreShadow(wichitaLabel, pa, r, ctx, popFile(400_000)).result!.values, "match");
  assert.equal(scoreShadow(wichitaLabel, pa, r, ctx, popFile(15)).result!.values, "mismatch");
  assert.equal(as(ask("Shoplifting in Wichita in 2024, with a column showing the population used to calculate the rate"), "decline").explanation,
    "A population column goes with a rate; this answer has no rate.");
  // P72: the agencies reporting beside a state total, the answer's own cohort; never beside an agency.
  const ka = as(ask("Shoplifting in Kansas in 2024, with the number of agencies reporting"), "answer");
  // Asked for (P87): the agencies and the population they cover, once each, in both views.
  assert.deepEqual(ka.delivered.table.columns.map((c) => c.header), ["Shoplifting offenses", "Agencies reporting", "Population covered"]);
  assert.deepEqual(ka.delivered.table.rows[0].slice(1), [ka.stateSum!.years[0].agencies, coveredText(ka.stateSum!.years[0].share, ka.stateSum!.years[0].noPopulation > 0)]);
  const every = as(ka.buttons![0].continuation!, "answer");
  assert.equal(every.delivered.table.rows[0][1], ka.stateSum!.years[0].every.agencies);
  assert.equal(as(ask("Shoplifting in Wichita in 2024, with the number of agencies reporting"), "decline").explanation,
    "The number of agencies reporting goes with a state or national total.");
}

// P74 (Jeff 2026-11-01: "much, much more crystal clear"): every case question, setup and follow-up, and every button
// behind them three levels deep, on the stub: no user-facing string (a decline, a question back, a button, an answer's
// text, a column header, a table's text cell) holds engine words, and no reader sentence went unmapped. An exception is
// a failure of its own, never a passing string.
{
  const casesFile = JSON.parse(fs.readFileSync("scripts/fixtures/answer-eval/cases.json", "utf8"));
  const all = (casesFile.cases ?? casesFile) as Case[];
  const bad: string[] = [], errors: string[] = [];
  const seen = new Set<string>();
  const check = (text: string | undefined, where: string) => {
    if (!text || seen.has(text)) return;
    seen.add(text);
    const j = jargon(text);
    if (j.length) bad.push(`${where}: [${j.join(", ")}] ${text}`);
  };
  const walk = (o: ShadowOutcome | undefined, where: string, depth: number): void => {
    if (!o) return;
    const opts = o.kind === "clarify" ? o.options : o.kind === "decline" ? (o.alternative ? [o.alternative] : []) : o.kind === "answer" ? o.buttons ?? [] : [];
    if (o.kind === "decline" || o.kind === "route") check(o.explanation, where);
    if (o.kind === "clarify") check(o.about, where);
    if (o.kind === "answer") {
      for (const t of o.delivered.text) check(t, where);
      for (const c of o.delivered.table.columns) check(c.header, where);
      for (const r of o.delivered.table.rows) for (const v of r) if (typeof v === "string") check(v, where);
    }
    for (const x of opts) { check(x.label, where); check(x.question, where); if (depth < 3) walk(x.continuation, `${where} > ${x.label}`, depth + 1); }
  };
  const noNextStep: string[] = [];
  const nextStep = (o: ShadowOutcome, where: string) => {
    if (o.kind === "decline" && !o.notBuilt && !o.alternative && !/\bfor example\b|\bask for\b|\bname the\b|\btry\b/i.test(o.explanation)) noNextStep.push(`${where}: ${o.explanation}`);
  };
  UNMAPPED.length = 0;
  for (const c of all) {
    const turns: [string, () => ShadowOutcome][] = [...(c.setup ?? []).map((s): [string, () => ShadowOutcome] => [`${c.id} setup`, () => ask(s.question)]),
      [c.id, () => (c.setup?.length && c.rewrite !== undefined ? (shadowFollowUp(c.setup[c.setup.length - 1].question, c.question, deps) as ShadowOutcome) : ask(c.question))]];
    for (const [where, run] of turns) {
      try { const o = run(); walk(o, where, 0); nextStep(o, where); } catch (e) { errors.push(`${where}: ${String(e).slice(0, 160)}`); }
    }
  }
  // Questions no case asks: the preview findings' and the Codex review's inputs, and the coordinator's weak declines.
  for (const q of ["Rape clearances by type by victim in Memphis in 2024", "Robberies where a firearm was seized in Memphis in 2024", "Burglaries in Memphis in 2023",
    "Shoplifting and carjackings combined in Memphis in 2024", "aggravated assault victims by weapon in Detroit in 2023", "murders rolling over 12 months in Detroit in 2024",
    "fentanyl offenses in Detroit in 2024", "Did shoplifting go up in Detroit from 2022 to 2023?", "Simple assault victims in Detroit by race and sex in 2023",
    "Shoplifting in Memphis in 2024 and in 2025", "Which Texas cities had the biggest increase in robberies in 2024?", "robberies in Denver compared with peer agencies in 2024"]) {
    try { const o = ask(q); walk(o, q, 0); nextStep(o, q); } catch (e) { errors.push(`${q}: ${String(e).slice(0, 160)}`); }
  }
  // Jeff's rule (coordinator, 2026-11-01): every decline offers a concrete next step, a button or a working example.
  assert.deepEqual(noNextStep, [], "every decline offers a button or an example");
  assert.ok(seen.size > 300, `the walk covers the strings (${seen.size})`);
  assert.deepEqual(errors, [], "no case question throws");
  assert.deepEqual(bad, [], "no engine words reach a user");
  assert.deepEqual(UNMAPPED, [], "every reader sentence has a plain wording");
  // Jeff's example (Codex preview-blockers review 1): the reader's own reason, reworded, never "didn't understand".
  assert.match(as(ask("Rape clearances by type by victim in Memphis in 2024"), "decline").explanation, /^Clearances are recorded for each offense, not for each person, so they can't be counted by "victim"\./);
}

// Jeff (2026-11-01): "it assumes everything is a follow up." A turn that stands on its own is a new question, answered
// as a first question would be, whatever came before; never "could not be placed ... ask the full question".
{
  const chicago = shadowFollowUp("Shoplifting in Memphis by year from 2021 to 2024", "Murders in Chicago in 2024", deps);
  assert.equal(chicago.rewriteKind, "new");
  assert.deepEqual({ ...chicago, rewrite: undefined, rewriteKind: undefined }, { ...ask("Murders in Chicago in 2024"), rewrite: undefined, rewriteKind: undefined });
  const det = shadowFollowUp("Murder victims in Houston by race in 2024", "Did shoplifting go up in Detroit from 2022 to 2023?", deps);
  assert.equal(det.rewriteKind, "new");
  assert.ok(det.kind !== "clarify" || !/could not be placed/.test(det.about), "never 'could not be placed' for a question of its own");
  // A new question with no period, after one with a period: that period is offered as a button, never assumed.
  const shop = shadowFollowUp("Shoplifting in Memphis in 2023", "Shoplifting in Detroit", deps);
  assert.equal(shop.rewriteKind, "new");
  const offered = shop.kind === "answer" ? shop.buttons ?? [] : shop.kind === "clarify" ? shop.options : shop.kind === "decline" && shop.alternative ? [shop.alternative] : [];
  assert.ok(offered.some((b) => b.question === "Shoplifting in Detroit in 2023" && !b.continuation), JSON.stringify(offered));
  // A turn that points back stays a follow-up.
  assert.equal(shadowFollowUp("Shoplifting in Memphis in 2024", "what about Nashville?", deps).rewriteKind, "rewrite");
  // Codex review 1: a comparison is never answered as a single place; it stays on the follow-up path (asked or proposed).
  for (const f of ["How does that compare to shoplifting in Nashville in 2024?", "Can you compare shoplifting in Nashville in 2024?"]) {
    const cmp = shadowFollowUp("Shoplifting in Memphis in 2024", f, deps);
    assert.notEqual(cmp.rewriteKind, "new", f);
    assert.ok(cmp.kind !== "answer" || cmp.plan.geography.places.length > 1, `no single-place answer: ${f}`);
  }
}

// Jeff (2026-11-01): stacked and 100% charts only when honest. A category grouping says whether its categories are
// exclusive (sum to the total): one per kind. Time and place groupings carry no flag.
{
  const flag = (q: string) => as(ask(q), "answer").delivered.table.columns.filter((c) => c.binding.kind === "grouping").map((c) => [(c.binding as { dimension: string }).dimension, "exclusive" in c ? c.exclusive : "none"]);
  assert.deepEqual(flag("Simple assault victims in Detroit by sex in 2023"), [["victim.sex", true]]);
  assert.deepEqual(flag("Aggravated assault victims in Memphis in 2024 by race"), [["victim.race", true]]);
  assert.deepEqual(flag("Robberies in Memphis in 2024 by weapon"), [["offense_weapon.weapon", false]]);                 // a crime can have several weapons
  assert.deepEqual(flag("Aggravated assault victims in Memphis in 2024 by offender race"), [["offender.race", false]]);  // an incident's several offenders (P49)
  assert.deepEqual(flag("Simple assault victims in Detroit in 2023 by relationship to the offender"), [["victim_offender.relationship", false]]);
  assert.deepEqual(flag("Shoplifting in Memphis by month in 2024"), [["time.month", "none"]]);
  // The grouping's flag is for the primary count; the incidents beside it (P66) carry their own. Codex review 01 (P1):
  // the cleared victims' incidents overlap across sexes; a clearance grouping is of the incident, so its incidents sum.
  const incidents = (q: string) => (as(ask(q), "answer").delivered.table.columns.find((c) => c.header === "Incidents") as { exclusive?: boolean }).exclusive;
  assert.deepEqual(flag("Simple assault victims in Detroit by sex in 2023 that were cleared"), [["victim.sex", true]]);
  assert.equal(incidents("Simple assault victims in Detroit by sex in 2023 that were cleared"), false);
  assert.deepEqual(flag("Carjacking offenses in Memphis by clearance status in 2024"), [["offense.clearance_status", true]]);
  assert.equal(incidents("Carjacking offenses in Memphis by clearance status in 2024"), true);
  // Exclusive exactly when the overlap note is not given.
  for (const q of ["Robberies in Memphis in 2024 by weapon", "Simple assault victims in Detroit by sex in 2023"]) {
    const a = as(ask(q), "answer");
    const cat = a.delivered.table.columns.find((c) => c.binding.kind === "grouping" && "exclusive" in c) as { exclusive: boolean };
    assert.equal(cat.exclusive, !a.delivered.answerStatements.includes("categories_overlap"), q);
  }
}

// Jeff (2026-11-01): never a percent contrasted with a rate, and never "resident" (banned wording, wording.ts).
{
  const text = (q: string) => as(ask(q), "answer").delivered.text.join(" / ");
  assert.doesNotMatch(text("Simple assault victims in Detroit by sex in 2023"), /not a rate|resident/);
  assert.doesNotMatch(text("Shoplifting rate in Wichita in 2024"), /resident/);
  assert.ok(jargon("Shoplifting per 100,000 residents").length > 0 && jargon("a percent, not a rate").length > 0, "both banned");
  for (const t of ["Sorry, I can't answer that.", "I apologize", "Unfortunately the data", "I'm afraid not"]) assert.ok(jargon(t).length > 0, `apology banned: ${t}`);
}

// The nearest question that works, the breakdown kept (coordinator, 2026-11-01): victims by weapon as offenses by
// weapon; "cleared" read into the crime's name asked as "that were cleared".
{
  const weapon = as(ask("Murder victims in Memphis in 2024 by weapon"), "decline");
  assert.match(weapon.explanation, /^Weapons are recorded for each offense, not for each victim/);
  assert.equal(weapon.alternative?.question, "Murder offenses in Memphis in 2024 by weapon");
  const cleared = as(ask("Homicide victims cleared in Memphis 2024"), "decline");
  assert.equal(cleared.alternative?.question, "Homicide victims in Memphis 2024 that were cleared");
  assert.equal(as(ask("Aggravated assaults cleared in Memphis in 2024"), "decline").alternative?.question, "Aggravated assaults in Memphis in 2024 that were cleared");
  // Codex decline review 01 (P2): a button keeps the conditions the reader set aside from its text.
  const two = ask("Shoplifting in Memphis in 2024 and in 2025 that were cleared");
  const twoQs = two.kind === "clarify" ? two.options.map((x) => x.question) : two.kind === "decline" && two.alternative ? [two.alternative.question] : [];
  assert.ok(twoQs.every((t) => !t || /that were cleared/.test(t)), JSON.stringify(twoQs));
  const wc = ask("Murder victims in Memphis in 2024 by weapon that were cleared");
  assert.ok(wc.kind !== "decline" || !wc.alternative?.question || /cleared/.test(wc.alternative.question), JSON.stringify(wc).slice(0, 300));
  // Follow-up options: only those the reader reads whole ("...victims with a female offender" is two counting units).
  const fem = shadowFollowUp("Simple assault victims in Memphis in 2024", "female", deps);
  assert.ok(fem.kind === "clarify" && fem.options.every((x) => x.label !== "Count female offenders"), JSON.stringify(fem).slice(0, 400));
}
// Jeff (2026-11-01): the Consistent Reporting Agencies are one set, complete for every month of the WHOLE span asked,
// used for every year; never a per-year every-month set. Austin misses June 2024 only: it is out of the set for 2023 too.
{
  const span = as(ask("Carjackings in Texas by year from 2023 to 2024, with the number of agencies reporting"), "answer");
  const ev = as(span.buttons![0].continuation!, "answer");
  assert.equal(span.stateSum!.everyAgencies, 3);
  assert.deepEqual(ev.delivered.table.rows.map((r) => r[2]), [3, 3], "the same set each year");
  assert.match(ev.delivered.text[0], /only the 3 Consistent Reporting Agencies that reported every month from January 2023 through December 2024\.$/);
  assert.ok(span.stateSum!.years.find((y) => y.year === 2023)!.agencies > 3, "Austin reported 2023 in full, yet is not in the set");
}
// P83, P84 (Jeff 2026-11-01): gun violence offers gun crime; car break-ins say how they are counted.
{
  const gv = as(ask("Gun violence in Memphis in 2024"), "decline");
  assert.match(gv.explanation, /no counts of non-fatal shootings/);
  assert.equal(gv.alternative?.question, "Gun crime in Memphis in 2024");
  assert.ok(as(ask("Car break-ins in Memphis in 2024"), "answer").delivered.text.includes("Car break-ins are counted as theft from motor vehicles."));
  assert.ok(!as(ask("Theft from motor vehicles in Memphis in 2024"), "answer").delivered.text.some((t) => /Car break-ins/.test(t)));
  // Codex coverage review 01.1: the gun-crime button keeps every condition asked, or is not offered.
  const gvc = as(ask("Gun violence in Texas in 2024, only agencies that reported every month"), "decline");
  assert.ok(!gvc.alternative || /only agencies that reported every month/.test(gvc.alternative.question ?? ""), JSON.stringify(gvc.alternative));
  // Never more than 100% covered (Jeff 2026-11-01): the agencies' own population estimates can sum past the place's.
  assert.equal(coveredText(100.1, false), "100.0%");
  assert.equal(coveredText(84.06, true), "≥84.1%");
  // Codex coverage review 01.2: the button's coverage columns are checked too, whatever the label asks (shown when asked, P87).
  const tampered = { ...txCjA, buttons: txCjA.buttons!.map((x) => ({ ...x, continuation: { ...(x.continuation as Extract<ShadowOutcome, { kind: "answer" }>),
    delivered: { ...(x.continuation as Extract<ShadowOutcome, { kind: "answer" }>).delivered, table: { ...(x.continuation as Extract<ShadowOutcome, { kind: "answer" }>).delivered.table, rows: [[252, 999, "99.9%"]] } } } })) };
  assert.equal(scoreShadow(sumLabel, tampered as ShadowOutcome, r, ctx, sumV(307)).result!.values, "mismatch");
}
// Jeff (2026-11-01), his exact question: "vs" joins places, and an offered question must answer and keep every place
// and crime asked; never one built by deleting words ("chicago memphis carjackings per year since 2022").
{
  const jeff = ask("chicago vs memphis carjackings per year since 2022");
  assert.ok(jeff.kind !== "decline" || !jeff.alternative || /chicago/i.test(jeff.alternative.question ?? "") && /memphis/i.test(jeff.alternative.question ?? ""), JSON.stringify(jeff).slice(0, 300));
  assert.ok(jeff.kind !== "decline" || !/^This isn't available yet: to compare/i.test(jeff.explanation), "vs is read as places side by side");
  const cmp = ask("Chicago compared to Memphis carjackings in 2024");
  assert.ok(cmp.kind === "answer" && cmp.plan.geography.places.length === 2, JSON.stringify(cmp).slice(0, 200));
}
// A period starting before the data: the covered part, to the month asked, never widened (Codex period review 01.1).
{
  const before = as(ask("Shoplifting in Memphis from January 2016 to March 2024"), "decline");
  const cont = before.alternative?.continuation;
  assert.ok(cont && cont.kind === "answer" && cont.period.from === "2017-01" && cont.period.to === "2024-03", JSON.stringify(before.alternative).slice(0, 300));
  assert.equal(readQuestion("Chicago robberies after 2010", 2026, "2026-09").ledger.parts.find((p) => p.concept === "period")?.value, "since:2011", "after 2010 starts with 2011");
}
// Coordinator 2026-11-02 (the redesign's retest of #96). 1: a breakdown the question names is never dropped.
{
  assert.deepEqual(namedGroupings("Robbery offenders in Memphis by age and year from 2022 to 2024").map((g) => g.word), ["year", "age"]);
  assert.deepEqual(namedGroupings("Robbery rate per 100,000 in Memphis in 2024, by men and women").map((g) => g.word), []);
  assert.deepEqual(missingGroupings("Robbery offenders in Memphis by age and year from 2022 to 2024", ["offender.age"]), ["year"]);
  assert.deepEqual(missingGroupings("Shoplifting in Memphis per month in 2024", ["time.month"]), []);
  // Codex guard review 01: how often agencies reported is not a breakdown; a comma or parenthesis before the period
  // ends the phrase, never hides it; "had" is not a request for the agencies reporting.
  assert.deepEqual(namedGroupings("Shoplifting in Texas by year from 2023 to 2024, only agencies that reported each month").map((g) => g.word), ["year"]);
  assert.deepEqual(missingGroupings("Robbery offenders in Detroit by age and year, 2022 to 2024", ["offender.age"]), ["year"]);
  assert.deepEqual(namedGroupings("How many robberies did Detroit report each year from 2022 to 2024?").map((g) => g.word), ["year"]);
  assert.deepEqual(missingGroupings("Robbery offenders in Detroit by age and year (2022 to 2024)", ["offender.age"]), ["year"]);
  assert.equal((readQuestion("How many agencies had shoplifting in Kansas in 2024", 2026, "2026-09").ledger as unknown as { column: unknown }).column, null);
  assert.equal((readQuestion("How many agencies reported shoplifting in Kansas in 2024", 2026, "2026-09").ledger as unknown as { column: unknown }).column, "agencies");
  // (Age by year itself is read in test-nibrs-shadow-reading; this stub has no year-by-category rows.)
  // 2: one Unknown row, last, even when it is the largest; no offender identified counted in it in SQL.
  const race = as(ask("Robbery offenders in Detroit by race in 2023"), "answer");
  assert.deepEqual(race.delivered.table.rows.map((r) => r[0]), ["Black", "White", "Unknown"]);
  // 3: the agencies reporting, asked in other words.
  for (const q of ["how many agencies reported shoplifting in Kansas in 2024", "agencies reporting shoplifting in Kansas in 2024", "shoplifting in Kansas in 2024 with coverage"])
    assert.deepEqual(as(ask(q), "answer").delivered.table.columns.map((c) => c.header), ["Shoplifting offenses", "Agencies reporting", "Population covered"], q);
}
// Codex month review 02.1: the leading-gap exemption applies only where delivery trims (its first row reported); an
// answer of unknown months that leaves rows out is still a mismatch.
{
  const base = as(ask("Shoplifting in Detroit by month in 2024"), "answer");
  const st = base.plan.statistics[0].as;
  const allBlank = { ...base, delivered: { ...base.delivered, table: { ...base.delivered.table, rows: [["2024-12", null]] }, evidence: [{ row: 0, statistic: st, status: "UNKNOWN" as const }] } };
  const want = Array.from({ length: 12 }, (_, i) => ({ key: `2024-${String(i + 1).padStart(2, "0")}`, value: null, status: "UNKNOWN" }));
  assert.equal(valueDiffs("", allBlank, want).values, "mismatch");
  const trimmed = { ...base, delivered: { ...base.delivered, table: { ...base.delivered.table, rows: [["2024-03", 7]] }, evidence: [{ row: 0, statistic: st, status: "VALUE" as const }] } };
  const wantTrim = [{ key: "2024-01", value: null, status: "UNKNOWN" }, { key: "2024-02", value: null, status: "UNKNOWN" }, { key: "2024-03", value: 7, status: "VALUE" }];
  assert.equal(valueDiffs("", trimmed, wantTrim).values, "match", "a real leading gap, trimmed");
  // Zero categories (ZERO_CATEGORIES): a known 0 listed on one side only is no difference, but never with a share that
  // is not 0 (Codex scorer check 01).
  const sexes = as(ask("Simple assault victims in Detroit by sex in 2023"), "answer");
  const cs = sexes.plan.statistics.map((s) => s.as);
  const withZero = (share: number) => ({ ...sexes, delivered: { ...sexes.delivered,
    table: { ...sexes.delivered.table, rows: [["Female", 30, 60], ["Male", 20, 40], ["Non-binary", 0, share]] },
    evidence: [0, 1, 2].flatMap((row) => cs.map((statistic) => ({ row, statistic, status: "VALUE" as const }))) } });
  const wantSexes = [{ key: "Female", value: 30, status: "VALUE", share: 60 }, { key: "Male", value: 20, status: "VALUE", share: 40 }];
  assert.equal(valueDiffs("", withZero(0), wantSexes).values, "match", "a 0 category listed: the same as left out");
  assert.equal(valueDiffs("", withZero(99), wantSexes).values, "mismatch", "a 0 count with a 99% share is wrong");
}
// Jeff 2026-11-02 ("we can't breakdown by month?"): the shadow answers a breakdown by month or quarter from the monthly
// build; the live route's reader (yearly summary tables) still declines it.
{
  const led = readQuestion("Aggravated assault victims in Nashville by sex and month in 2023", 2026, "2026-09").ledger;
  assert.equal(matchNibrsType(led).kind, "decline", "live: unchanged");
  const d = matchNibrsType(led, { monthlyBreakdowns: true });
  assert.ok(d.kind === "spec" && d.spec.type === "breakdown" && d.spec.byMonth === true, JSON.stringify(d));
  assert.equal(matchNibrsType(readQuestion("Aggravated assault victims in Nashville by sex by year by month in 2023", 2026, "2026-09").ledger, { monthlyBreakdowns: true }).kind, "decline", "by year and by month at once");
}

console.log("nibrs shadow: answers, clarifications and declines follow the slice's policy; scoring judges them");
