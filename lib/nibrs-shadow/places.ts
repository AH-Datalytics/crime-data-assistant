/**
 * The shared place resolution (every source): a place named in a question -> one agency, a state, or a choice to ask
 * about. It reads scripts/fixtures/nibrs-shadow/agencies.json: the city police and county agencies of NIBRS's canonical
 * build and of the Crime Index, whatever their size (Jeff 2026-11-03: no population floor), each with the place names the agency crosswalk gives
 * it ("new york city" for New York's police) as aliases. It stands in for the app's resolveNibrsPlaces, which needs nibrs.db.
 *
 * The rule (P28, Jeff 2026-10-29): a name is asked about when it fits two or more real candidates serving 100,000+ people:
 * cities of that name in different states, a city and a county of that name ("Baltimore": the city or Baltimore County),
 * or counties of that name in different states. A name that is also a state ("Washington") always offers the state
 * beside its large cities and counties. Otherwise the most populous match is used without a question (P16: a city
 * means its principal police agency). A state named in the question narrows the candidates to that state.
 */
import fs from "node:fs";
import path from "node:path";
import type { Place } from "../nibrs-plan/plan";
import { postalState } from "../nibrs-plan/state-codes";
import { isCommonEnglishWord } from "../english-common-words";

/** `aliases`: the crosswalk's place names for the agency; `sources`: "nibrs", "crime_index" (which builds have it). */
export type Agency = { ori: string; kind: "city" | "county"; name: string; state: string; population: number; year: number; aliases?: string[]; sources?: string[] };
export type Candidate = { kind: "agency"; agency: Agency } | { kind: "state"; code: string; name: string };
export type PlaceResolution =
  | { kind: "agency"; place: Extract<Place, { kind: "agency" }>; agency: Agency }
  | { kind: "ask"; name: string; candidates: Candidate[]; more?: boolean }
  | { kind: "unresolved"; why: string; named?: boolean };

export const ASK_POPULATION = 100_000;
/** Names Jeff decided mean the city with no ask even alone (2026-11-22): "Charlotte" is Charlotte, NC, not Charlotte County, FL. */
const CITY_NAME_MEANS_CITY = new Set(["charlotte"]);
/** Same-name towns (Jeff 2026-11-03, no population floor): at most this many cities are offered, one per state. */
export const ASK_TOWNS = 3;
// A Village, Town or Borough found only by the name asks beside a smaller same-name city when it has this many people.
export const ASK_SUFFIXED = 5_000;
export const STATE_NAMES: Record<string, string> = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };
export const stateName = (code: string) => STATE_NAMES[code] ?? code;
const STATE_BY_NAME = Object.fromEntries(Object.entries(STATE_NAMES).filter(([c]) => c !== "DC").map(([c, n]) => [n.toLowerCase(), c]));

/** Names compared without case, punctuation, the St./Saint difference or a trailing "County" or "Parish" (never "Borough": Baldwin Borough, PA is a town, not Baldwin County). */
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\bsaint\b/g, "st").replace(/\s+/g, " ").trim();
const base = (s: string) => key(s).replace(/ (county|parish)$/, "");

/**
 * City agencies the index names by their department instead of their place (crime_data.db's Historical names), named
 * here by the place the FBI's Return A header gives for the ORI. A stop-gap until the common agency/place crosswalk
 * (proposed 2026-10-29) gives Census place names; add only names a labeled case needs, with that evidence.
 */
export const PLACE_NAMES: Record<string, string> = {
  TN0190100: "Nashville",   // Return A: "METROPOLITAN NASHVILLE P"; Historical: "Metropolitan Nashville Police Department"
  NV0020100: "Las Vegas",   // Return A: "LAS VEGAS METRO PD"; Historical: "Las Vegas Metropolitan Police Department"
  KY0568000: "Louisville",  // Return A: "LOUISVILLE METRO"; Historical: "Louisville Metro" (else "Louisville" finds Louisville, CO)
};
/**
 * Agencies that serve a place AND its county under a joint name: found by the place's name too, but named as they are
 * (renaming one would put another agency's name on its counts). Same evidence rule as PLACE_NAMES.
 */
/**
 * An agency's own name where the FBI's differs from what the agency is called (Jeff 2026-11-07: "the county sheriff or
 * police department", the buttons naming "Los Angeles County Sheriff's Department"; the FBI's is "... Sheriff's Office").
 */
export const AGENCY_NAMES: Record<string, string> = {
  CA0190000: "Los Angeles County Sheriff's Department",
};
const EXTRA_ALIASES: Record<string, string[]> = { KY0340200: ["LFUCPD", "Lexington Police Department", "Lexington-Fayette Urban County Police Department"] };
export const PLACE_ALIASES: Record<string, string> = {
  MT0470000: "Butte",   // B1: "Butte, MT" is Butte-Silver Bow County (the consolidated city-county; its own FBI name is the Sheriff's Office)
  NJ0040800: "Camden",   // B1: "Camden, NJ" is the Camden County Police Department (the city's police), not the county Sheriff's Office
  NC0600100: "Charlotte",   // Historical: "Charlotte-Mecklenburg Police Department" (else "Charlotte, North Carolina" finds no agency)
};

/**
 * `names`: each ORI's FBI name (scripts/fixtures/nibrs-shadow/agency-names.json); `returnA`: the ORIs whose name is
 * Return A's 24-character short name, not a department name.
 */
export type PlaceIndex = { byName: Map<string, Agency[]>; names: Map<string, string>; returnA: Set<string> };
// Fixtures resolve from the working directory (the repository root), as the routes resolve agencies.json: a Next bundle
// has no source __dirname (assistant preview findings, 2026-10-31).
const NAMES_FILE = path.join(process.cwd(), "scripts/fixtures/nibrs-shadow/agency-names.json");
export function loadPlaceIndex(file = path.join(process.cwd(), "scripts/fixtures/nibrs-shadow/agencies.json")): PlaceIndex {
  const namesFile = JSON.parse(fs.readFileSync(NAMES_FILE, "utf8")) as { names: Record<string, string>; return_a?: string[] };
  const names = new Map<string, string>([...Object.entries(namesFile.names), ...Object.entries(AGENCY_NAMES)]);
  const returnA = new Set(namesFile.return_a ?? []);
  // An index row with no name (", Indiana", ", Illinois") cannot be named in an answer: never found, not even by its alias (Engine 2.0 review item 4).
  const agencies: Agency[] = JSON.parse(fs.readFileSync(file, "utf8")).agencies.filter((a: Agency) => (a.name ?? "").trim() !== "").map((a: Agency) => ({ ...a, state: postalState(a.state), ...(PLACE_NAMES[a.ori] ? { name: PLACE_NAMES[a.ori] } : {}) }));
  const byName = new Map<string, Agency[]>();
  const add = (name: string, a: Agency) => (byName.get(base(name)) ?? byName.set(base(name), []).get(base(name))!).push(a);
  for (const a of agencies) { add(a.name, a); if (PLACE_ALIASES[a.ori]) add(PLACE_ALIASES[a.ori], a); }
  // B1: the department's own initials and full name (the index names the agency "Lexington"); extra aliases only, the label stays the agency's.
  for (const a of agencies) for (const al of EXTRA_ALIASES[a.ori] ?? []) add(al, a);
  // The crosswalk's aliases, unless the name is another agency's own in that state (after PLACE_NAMES): "louisville"
  // stays Louisville Metro's, not the old Jefferson County police's ("louisville county").
  const owned = new Set(agencies.map((a) => `${base(a.name)}|${a.state}`));
  for (const a of agencies) for (const al of new Set((a.aliases ?? []).map(base))) if (al !== base(a.name) && !owned.has(`${al}|${a.state}`)) add(al, a);
  for (const xs of byName.values()) xs.sort((a, b) => b.population - a.population);
  return { byName, names, returnA };
}

/** Edit distance with adjacent transposition (optimal string alignment). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
/**
 * A misspelled large place ("batlimore", "phialdelphia", "el paos"): the one city or county name of 100,000+ people
 * within two edits (one for a name under six letters), same first letter; null when none or several are that close.
 */
export function nearestPlaceName(idx: PlaceIndex, name: string, strict = false): string | null {
  const k = base(name);
  if (k.length < 4 || idx.byName.has(k)) return null;
  // `strict`, for a word the reader didn't read as a place (coordinator 2026-11-05, "Philadlephia murders 2024"): seven
  // or more letters, not a common English word, one edit from a city of 100,000+. The query log's unread words had
  // "line" (Lane), "columns" (Columbus), "median" (Meridian) and "dollar" (Dallas) within the looser limit; "bolder"
  // (Boulder) is six (Codex spelling review 01).
  if (strict && (k.length < 7 || isCommonEnglishWord(k))) return null;
  const limit = strict ? 1 : k.length < 6 ? 1 : 2;
  const near = [...idx.byName.entries()].filter(([n, xs]) => n[0] === k[0] && xs[0].population >= ASK_POPULATION && Math.abs(n.length - k.length) <= limit && distance(n, k) <= limit
    && (!strict || (xs.some((x) => x.kind === "city" && x.population >= ASK_POPULATION)
      // A plural is a word, not a place: "garlands" is not Garland (Codex spelling review 02).
      && !(k.endsWith("s") && !n.endsWith("s")))));
  // The place's name (the city's, when there is one): "Baltimore", which then asks the city or the county (P28).
  return near.length === 1 ? (near[0][1].find((x) => x.kind === "city") ?? near[0][1][0]).name : null;
}

/**
 * Who reported the figures: the agency's FBI name (Jeff 2026-10-30: "Reported by the Denver Police Department"), never
 * one built from a city and a type, nor the build's city (a mailing city, so possibly another agency's). Without one,
 * the ORI. A Return A short name says so ("Kake (FBI Return A name)"), never expanded into a department name.
 */
export const RETURN_A = " (FBI Return A name)";
export function agencyName(idx: PlaceIndex, ori: string): string {
  const n = idx.names.get(ori);
  return n === undefined ? ori : idx.returnA.has(ori) ? `${n}${RETURN_A}` : n;
}
/** "Reported by the Denver Police Department." / "... the Tulsa Police Department and the Oklahoma City Police Department." / "Reported by Kake (FBI Return A name)." */
export function reportedBy(names: string[]): string {
  const the = names.map((n) => (/^[A-Z]{2}[A-Z0-9]{7}$/.test(n) ? `agency ${n} (no FBI name in the archived sources)` : n.endsWith(RETURN_A) ? n : `the ${n}`));
  return `Reported by ${the.length > 2 ? `${the.slice(0, -1).join(", ")} and ${the[the.length - 1]}` : the.join(" and ")}.`;
}

/** A place's name in an answer (Jeff 2026-10-30): "Denver, Colorado", "Baltimore County, Maryland", "Washington, D.C."; the agency is named on the next line (reportedBy). */
export const agencyLabel = (a: Agency) => `${PLACE_ALIASES[a.ori] ?? a.name}, ${a.state === "DC" ? "D.C." : stateName(a.state)}`;
const asPlace = (a: Agency): PlaceResolution => ({ kind: "agency", place: { kind: "agency", ori: a.ori, label: agencyLabel(a) }, agency: a });
/** A button's label for a candidate: "Kansas City, Missouri"; "Baltimore city, Maryland" beside "Baltimore County, Maryland"; "Washington state". */
export function candidateLabel(c: Candidate, all: Candidate[], idx?: PlaceIndex): string {
  if (c.kind === "state") return `${c.name} state`;
  const a = c.agency;
  const countyToo = a.kind === "city" && all.some((x) => x.kind === "agency" && x.agency.kind === "county" && x.agency.state === a.state);
  // A city's police beside its county's sheriff in one state (Jeff 2026-11-07, Los Angeles: "the county sheriff or
  // police department"): each button names the agency ("Los Angeles Police Department", "Los Angeles County Sheriff's
  // Department"), where both names are known (not Return A short names). A county police department beside the city's
  // ("Baltimore County, Maryland") keeps the place's name.
  const nameOf = (x: Agency) => (idx && !idx.returnA.has(x.ori) ? idx.names.get(x.ori) : undefined);
  const city = all.find((x) => x.kind === "agency" && x.agency.kind === "city" && x.agency.state === a.state);
  const county = all.find((x) => x.kind === "agency" && x.agency.kind === "county" && x.agency.state === a.state);
  if (city?.kind === "agency" && county?.kind === "agency" && /\bsheriff/i.test(nameOf(county.agency) ?? "") && nameOf(city.agency) && nameOf(a)) return nameOf(a)!;
  if (a.kind === "city" && stateName(a.state) === a.name) return `${a.name} City`;   // "New York City" beside "New York state" (P26)
  return `${a.name}${countyToo ? " city" : ""}, ${a.state === "DC" ? "D.C." : stateName(a.state)}`;
}

/**
 * A ledger place value ("city:Memphis:TN", "county:Baltimore County:MD", "ambiguous:Baltimore") and the words the
 * question used for it. The reader fills in a state it was not given ("Columbus" -> OH), so a state counts as named
 * only when the words say more than the name.
 */
/**
 * "Westlake, Florida": the agency of that name in that state in the place index (the one source of truth for the cities the build has), or null.
 * A city named with its state is never the same name in another state (coordinator 2026-11-22: Westlake, Florida answered Westlake, Ohio).
 * A city of the name is preferred to a county's agency of it.
 */
export function agencyInState(idx: PlaceIndex, name: string, stateCode: string): Agency | null {
  const pool = (idx.byName.get(base(name)) ?? []).filter((a) => a.state === stateCode);
  return pool.find((a) => a.kind === "city") ?? pool[0] ?? null;
}
export const stateCodeOf = (name: string): string | undefined => STATE_BY_NAME[name.toLowerCase()] ?? (/^district of columbia$/i.test(name) ? "DC" : undefined);
const REQUEST_WORD =/^(?:just|only|show|me|compare|using|use|calculate|give|tell|get|find|list|display|plot|chart|graph|see|view|what|about|data|now|please|also|then|so|ok|okay)\s+\S/i;
export function resolvePlace(idx: PlaceIndex, value: string, text: string, inList = false): PlaceResolution {
  const m = /^(?:(city|county):(.+):([A-Z]{2})?|ambiguous:(.+))$/.exec(value);
  if (!m) return { kind: "unresolved", why: `the slice resolves cities and counties only (${value})` };
  let name = (m[2] ?? m[4]).trim();
  // A county read with the words before it at the start of a question ("just show worcester county", "Compare Jefferson
  // Parish"): the county the index has, without them.
  // Request words only: "South King County" is not King County (Codex place review 01).
  if (m[1] === "county") while (!idx.byName.has(base(name)) && REQUEST_WORD.test(name)) name = name.replace(/^\S+\s+/, "");
  // B1: "Cook County police department" names the county's agency (its FBI name is the Sheriff's Office); the department words are not part of the name.
  if (m[1] === "county" && !idx.byName.has(base(name))) name = name.replace(/\s+(?:police(?:\s+department)?|sheriff(?:'?s)?(?:\s+(?:office|department))?)$/i, "");
  // B1: Orleans Parish is the City of New Orleans (a consolidated city-parish): its figures are the New Orleans Police Department's, never Orleans County, New York.
  if (/^orleans parish$/.test(key(name)) && (!m[3] || m[3] === "LA")) { const nopd = (idx.byName.get("new orleans") ?? []).find((a) => a.state === "LA" && a.kind === "city"); if (nopd) return asPlace(nopd); }
  const countyNamed = m[1] === "county" || / (county|parish)$/.test(key(name));
  const words = key(text).replace(/ (city|county)$/, "");
  // Exactly the name and "Police (Department)" names no state ("Arlington Police Department"); anything more still does
  // ("Salem City Police Department" is Salem, Virginia; Codex place review 07).
  const policeOnly = key(text).replace(/ police( department)?$/, "") === base(name) && / police( department)?$/.test(key(text));
  // Never a state the geo resolver chose for a misspelling: "Philadlephia" had answered Philadelphia, Mississippi
  // (coordinator 2026-11-05).
  // The words naming more than the place ("Columbus, Ohio", "kcmo", "City of Charlotte") name its state; a misspelling of
  // the name alone does not ("philadlephia", "san antnio").
  const stateNamed = m[3] && words !== base(name) && distance(words, base(name)) > 2 && !policeOnly ? m[3] : null;
  // A parish is Louisiana's (Codex places review 02: "Orleans Parish" had found Orleans County, New York).
  const parish = / parish$/.test(key(name)) || /\bparish\b/.test(key(text));
  let pool = (idx.byName.get(base(name)) ?? []).filter((a) => (!countyNamed || a.kind === "county" || (m[1] === "city" && a.kind === "city" && base(a.name) === base(name))) && (!stateNamed || a.state === stateNamed) && (!parish || a.state === "LA"));
  // "Baltimore city", "Los Angeles Police Department": the city's agency; "Los Angeles County Sheriff": the county's.
  // "LAPD" is the Los Angeles Police Department: the department's own initials name the city agency (2026-10-23 fix).
  // "The city of San Diego" names the city, not the county's sheriff: P16 (a city name means the city's principal police agency) settles
  // the city-or-county ask of P28, which asks only when the wording leaves the readings open.
  const cityOf = /^(?:the )?city of /.test(key(text)) && !countyNamed;
  // B1: "Cook County police department" is a county named: its police are the county's agency, not a city's.
  const countyPolice0 = countyNamed && / county( police( department)?)?$/.test(key(text));
  if ((/ city$|\bpolice\b/.test(key(text)) && !countyPolice0) || key(text) === "lapd" || cityOf) {
    const cities = pool.filter((a) => a.kind === "city");
    // A large county police department of the name in another state is another "<name> police" ("Arlington Police
    // Department": Arlington, Texas or Arlington County, Virginia's): which (query-log scorecard, 2026-11-05). In the
    // city's own state the county's is "<name> County" ("Baltimore Police Department" is the city's).
    const countyPolice = /\bpolice\b/.test(key(text)) && !countyNamed && !stateNamed
      ? pool.filter((a) => a.kind === "county" && a.population >= ASK_POPULATION && /\bpolice\b/i.test(idx.names.get(a.ori) ?? "") && !cities.some((c) => c.state === a.state))
      : [];
    const bigCity = cities.find((a) => a.population >= ASK_POPULATION);
    if (bigCity && countyPolice.length) return { kind: "ask", name, candidates: [bigCity, ...countyPolice].map((a): Candidate => ({ kind: "agency", agency: a })) };
    pool = cities;
  } else if (/\bsheriff/.test(key(text))) pool = pool.filter((a) => a.kind === "county");
  // `named`: the words name a real place (with its state, or as a county), not a word the reader took for one ("index").
  if (!pool.length) return { kind: "unresolved", why: `no city or county agency named ${name}${stateNamed ? ` in ${stateName(stateNamed)}` : ""} in this build`, named: !!stateNamed || countyNamed };
  // The most populous agency of each kind in each state; the large ones are the real candidates.
  const firsts = pool.filter((a, i) => pool.findIndex((b) => b.kind === a.kind && b.state === a.state) === i);
  // Buttons, most likely first: cities, then counties, each by population; the state (when the name is one) second.
  const large: Candidate[] = firsts.filter((a) => a.population >= ASK_POPULATION)
    .sort((x, y) => (x.kind === y.kind ? y.population - x.population : x.kind === "city" ? -1 : 1)).map((a) => ({ kind: "agency", agency: a }));
  const asState = !countyNamed && !stateNamed ? STATE_BY_NAME[base(name)] : undefined;
  if (asState) large.splice(1, 0, { kind: "state", code: asState, name: stateName(asState) });
  // One large city beside large places that are not cities (Jeff 2026-11-22): a city's name means its police (P16). Alone,
  // when the others are counties in other states and no state ("Charlotte" is Charlotte, NC, not Charlotte County, FL);
  // within a list of places also when the county is in the city's own state or the name is a state too ("Baltimore",
  // "Los Angeles", "St. Louis" beside other cities: P196; "Washington" is DC). Two large cities still ask (Kansas City, Richmond).
  const bigCities = large.filter((c) => c.kind === "agency" && c.agency.kind === "city");
  if (large.length >= 2 && bigCities.length === 1 && !countyNamed && !stateNamed) {
    const city = (bigCities[0] as Extract<Candidate, { kind: "agency" }>).agency;
    // Alone, only the names Jeff decided ("Charlotte"); every other city-and-county pair still asks by P28.
    const alone = CITY_NAME_MEANS_CITY.has(base(name)) && !large.some((c) => c.kind === "state" || (c.kind === "agency" && c.agency.kind === "county" && c.agency.state === city.state));
    if (inList || alone) return asPlace(city);
  }
  // Cause A (Coordinator 2026-11-24): a city read with its state ("Los Angeles, CA") is the city's principal police agency (P16); the county's sheriff of the
  // same state is not asked about. Only a city of exactly that name in that state; a county read as one, and a name without a state, are unchanged.
  if (m[1] === "city" && stateNamed && !countyNamed) {
    const own = firsts.find((a) => a.kind === "city" && base(a.name) === base(name) && a.population >= ASK_POPULATION);
    if (own) return asPlace(own);
  }
  // A bare state name beside only small same-name towns ("California" is California, PA: 4,981 people; "Kansas", "Nevada",
  // "Oregon") is never silently the town: the state or the town (Engine 2.0 review of ca2f4f3b; the old same-name-towns ask
  // had caught these by accident).
  if (asState && large.length === 1 && !stateNamed) {
    const town = pool.find((a) => a.kind === "city") ?? pool[0];
    if (town) return { kind: "ask", name, candidates: [{ kind: "agency", agency: town }, large[0]] };
  }
  // The name's own cities: an agency named exactly that, a large one, or one the crosswalk names. A "Smith Township" found only by the
  // alias "smith" is a town of a different name, never preferred to a city of the name by population alone (Engine 2.0 review item 3).
  const ownCity = (a: Agency) => a.kind === "city" && (base(a.name).replace(/ /g, "") === base(name).replace(/ /g, "") || a.population >= ASK_POPULATION || !!PLACE_ALIASES[a.ori]);
  const bestCity = () => pool.find(ownCity) ?? pool.find((a) => a.kind === "city");
  // One large county beside only small places of the name (Osceola County, FL; Osceola, AR): never silently the small place alone (Engine 2.0
  // review item 2). Within a list the city still wins (P196); those names are listed for Jeff.
  if (large.length === 1 && !inList && !asState && !countyNamed && !stateNamed && large[0].kind === "agency" && large[0].agency.kind === "county") {
    const town = bestCity();
    if (town) return { kind: "ask", name, candidates: [large[0], { kind: "agency", agency: town }] };
  }
  if (large.length >= 2) return { kind: "ask", name, candidates: large };
  // A small place one or two letters from a large one ("Pittsburg", "Berkley", "prince George county"): which, the large
  // one first (coordinator 2026-11-05, query-log search): never the small place in silence.
  if (!large.length && !stateNamed) {
    const k = base(name), limit = k.length < 6 ? 1 : 2;
    const near = [...idx.byName.entries()].filter(([n, xs]) => n !== k && n[0] === k[0] && Math.abs(n.length - k.length) <= limit && distance(n, k) <= limit)
      .map(([, xs]) => xs.filter((a) => a.population >= ASK_POPULATION && (!countyNamed || a.kind === "county")).sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "city" ? -1 : 1))[0])
      .filter((a): a is Agency => !!a)
      .filter((a, i, all) => all.findIndex((b) => b.ori === a.ori) === i);   // "prince george s" and "prince georges": one agency
    const own = countyNamed ? pool[0] : pool.find((a) => a.kind === "city") ?? pool[0];
    if (near.length === 1) return { kind: "ask", name, candidates: [{ kind: "agency", agency: near[0] }, { kind: "agency", agency: own }] };
  }
  // No "twice the next town" ask (removed 2026-11-22): P28 asks only when two or more same-name places have 100,000+;
  // otherwise the most populous city, with no ask ("Jackson" is Jackson, MS).
  // A county named without its state, in several states, none large ("Mecklenburg County": Virginia's sheriff serves
  // more people than North Carolina's): which. A sheriff's population is not the county's.
  const counties = firsts.filter((a) => a.kind === "county").sort((x, y) => y.population - x.population);
  if (countyNamed && !stateNamed && !large.length && counties.length >= 2)
    return { kind: "ask", name, candidates: counties.slice(0, ASK_TOWNS).map((a): Candidate => ({ kind: "agency", agency: a })), more: counties.length > ASK_TOWNS };
  // No question: a city's name means its principal police agency (P16), so the most populous city agency of that name,
  // unless the words name a county (or the only large candidate is the county asked by name). "Clinton" is the city of
  // Clinton, not Clinton County, New York; with every agency in the index (Jeff 2026-11-03) small cities share names
  // with large counties far more often.
  if (!countyNamed) {
    const own = pool.find(ownCity);
    if (own) {
      // A bigger Village, Town or Borough found only by the name ("Hempstead Village", NY, 59,748 beside Hempstead, TX, 6,983): which, never the
      // small city in silence (Jeff 2026-11-23, "Ask in those cases"). A township stays behind the city (item 3); under 5,000 people is no ask.
      const suffixed = pool.find((a) => a.kind === "city" && a !== own && !ownCity(a) && !/township/i.test(a.name) && a.population >= ASK_SUFFIXED && a.population > own.population);
      if (suffixed) return { kind: "ask", name, candidates: [suffixed, own].map((a): Candidate => ({ kind: "agency", agency: a })) };
      return asPlace(own);
    }
    // Only towns found by an alias, several of them ("Bedminster": Bedminster Township, NJ or PA): which, never the biggest in silence.
    const towns = pool.filter((a) => a.kind === "city" && pool.findIndex((b) => b.kind === "city" && b.state === a.state) === pool.indexOf(a));
    if (towns.length >= 2) return { kind: "ask", name, candidates: towns.slice(0, ASK_TOWNS).map((a): Candidate => ({ kind: "agency", agency: a })), more: towns.length > ASK_TOWNS };
  }
  return asPlace(countyNamed ? pool[0] : pool.find((a) => a.kind === "city") ?? pool[0]);
}
