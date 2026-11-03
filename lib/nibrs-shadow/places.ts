/**
 * The shared place resolution (every source): a place named in a question -> one agency, a state, or a choice to ask
 * about. It reads scripts/fixtures/nibrs-shadow/agencies.json: the city police and county agencies of NIBRS's canonical
 * build and of the Crime Index with populations of 10,000 or more, each with the place names the agency crosswalk gives
 * it ("new york city" for New York's police) as aliases. It stands in for the app's resolveNibrsPlaces, which needs nibrs.db.
 *
 * The rule (P28, Jeff 2026-10-29): a name is asked about when it fits two or more real candidates of 100,000+ residents:
 * cities of that name in different states, a city and a county of that name ("Baltimore": the city or Baltimore County),
 * or counties of that name in different states. A name that is also a state ("Washington") always offers the state
 * beside its large cities and counties. Otherwise the most populous match is used without a question (P16: a city
 * means its principal police agency). A state named in the question narrows the candidates to that state.
 */
import fs from "node:fs";
import path from "node:path";
import type { Place } from "../nibrs-plan/plan";

/** `aliases`: the crosswalk's place names for the agency; `sources`: "nibrs", "crime_index" (which builds have it). */
export type Agency = { ori: string; kind: "city" | "county"; name: string; state: string; population: number; year: number; aliases?: string[]; sources?: string[] };
export type Candidate = { kind: "agency"; agency: Agency } | { kind: "state"; code: string; name: string };
export type PlaceResolution =
  | { kind: "agency"; place: Extract<Place, { kind: "agency" }>; agency: Agency }
  | { kind: "ask"; name: string; candidates: Candidate[] }
  | { kind: "unresolved"; why: string };

export const ASK_POPULATION = 100_000;
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
export const PLACE_ALIASES: Record<string, string> = {
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
  const names = new Map<string, string>(Object.entries(namesFile.names));
  const returnA = new Set(namesFile.return_a ?? []);
  const agencies: Agency[] = JSON.parse(fs.readFileSync(file, "utf8")).agencies.map((a: Agency) => (PLACE_NAMES[a.ori] ? { ...a, name: PLACE_NAMES[a.ori] } : a));
  const byName = new Map<string, Agency[]>();
  const add = (name: string, a: Agency) => (byName.get(base(name)) ?? byName.set(base(name), []).get(base(name))!).push(a);
  for (const a of agencies) { add(a.name, a); if (PLACE_ALIASES[a.ori]) add(PLACE_ALIASES[a.ori], a); }
  // The crosswalk's aliases, unless the name is another agency's own in that state (after PLACE_NAMES): "louisville"
  // stays Louisville Metro's, not the old Jefferson County police's ("louisville county").
  const owned = new Set(agencies.map((a) => `${base(a.name)}|${a.state}`));
  for (const a of agencies) for (const al of new Set((a.aliases ?? []).map(base))) if (al !== base(a.name) && !owned.has(`${al}|${a.state}`)) add(al, a);
  for (const xs of byName.values()) xs.sort((a, b) => b.population - a.population);
  return { byName, names, returnA };
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
export function candidateLabel(c: Candidate, all: Candidate[]): string {
  if (c.kind === "state") return `${c.name} state`;
  const a = c.agency;
  const countyToo = a.kind === "city" && all.some((x) => x.kind === "agency" && x.agency.kind === "county" && x.agency.state === a.state);
  if (a.kind === "city" && stateName(a.state) === a.name) return `${a.name} City`;   // "New York City" beside "New York state" (P26)
  return `${a.name}${countyToo ? " city" : ""}, ${a.state === "DC" ? "D.C." : stateName(a.state)}`;
}

/**
 * A ledger place value ("city:Memphis:TN", "county:Baltimore County:MD", "ambiguous:Baltimore") and the words the
 * question used for it. The reader fills in a state it was not given ("Columbus" -> OH), so a state counts as named
 * only when the words say more than the name.
 */
export function resolvePlace(idx: PlaceIndex, value: string, text: string): PlaceResolution {
  const m = /^(?:(city|county):(.+):([A-Z]{2})?|ambiguous:(.+))$/.exec(value);
  if (!m) return { kind: "unresolved", why: `the slice resolves cities and counties only (${value})` };
  const name = (m[2] ?? m[4]).trim();
  const countyNamed = m[1] === "county" || / (county|parish)$/.test(key(name));
  const words = key(text).replace(/ (city|county)$/, "");
  const stateNamed = m[3] && words !== base(name) ? m[3] : null;
  let pool = (idx.byName.get(base(name)) ?? []).filter((a) => (!countyNamed || a.kind === "county") && (!stateNamed || a.state === stateNamed));
  // "Baltimore city", "Los Angeles Police Department": the city's agency; "Los Angeles County Sheriff": the county's.
  if (/ city$|\bpolice\b/.test(key(text))) pool = pool.filter((a) => a.kind === "city");
  else if (/\bsheriff/.test(key(text))) pool = pool.filter((a) => a.kind === "county");
  if (!pool.length) return { kind: "unresolved", why: `no city or county agency named ${name}${stateNamed ? ` in ${stateName(stateNamed)}` : ""} with a population of 10,000 or more in this build` };
  // The most populous agency of each kind in each state; the large ones are the real candidates.
  const firsts = pool.filter((a, i) => pool.findIndex((b) => b.kind === a.kind && b.state === a.state) === i);
  // Buttons, most likely first: cities, then counties, each by population; the state (when the name is one) second.
  const large: Candidate[] = firsts.filter((a) => a.population >= ASK_POPULATION)
    .sort((x, y) => (x.kind === y.kind ? y.population - x.population : x.kind === "city" ? -1 : 1)).map((a) => ({ kind: "agency", agency: a }));
  const asState = !countyNamed && !stateNamed ? STATE_BY_NAME[base(name)] : undefined;
  if (asState) large.splice(1, 0, { kind: "state", code: asState, name: stateName(asState) });
  return large.length >= 2 ? { kind: "ask", name, candidates: large } : asPlace(pool[0]);
}
