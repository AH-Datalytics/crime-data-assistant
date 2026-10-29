/**
 * The shadow slice's place resolution: a city named in a question -> one city police agency (P16: the city's principal
 * police agency), or a choice to ask about. It reads scripts/fixtures/nibrs-shadow/agencies.json (city agencies of the
 * canonical build with 10,000+ residents) and stands in for the app's resolveNibrsPlaces, which needs nibrs.db.
 *
 * A city named WITH its state resolves to that state's most populous agency of the name. A city named WITHOUT its state
 * is asked about when two or more states have one of that name with at least 100,000 residents (D28: materially
 * different readings remain); otherwise it resolves to the most populous one. The 100,000 threshold is this slice's
 * proposed default, not a decided policy row.
 */
import fs from "node:fs";
import path from "node:path";
import type { Place } from "../nibrs-plan/plan";

export type Agency = { ori: string; city: string; state: string; population: number; year: number };
export type PlaceResolution =
  | { kind: "agency"; place: Extract<Place, { kind: "agency" }>; agency: Agency }
  | { kind: "ask"; city: string; candidates: Agency[] }
  | { kind: "unresolved"; why: string };

export const ASK_POPULATION = 100_000;
const STATE_NAMES: Record<string, string> = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };
export const stateName = (code: string) => STATE_NAMES[code] ?? code;

/** City names compared without case, punctuation or the St./Saint difference. */
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\bsaint\b/g, "st").replace(/\s+/g, " ").trim();

export type PlaceIndex = { byCity: Map<string, Agency[]> };
export function loadPlaceIndex(file = path.join(__dirname, "../../scripts/fixtures/nibrs-shadow/agencies.json")): PlaceIndex {
  const agencies: Agency[] = JSON.parse(fs.readFileSync(file, "utf8")).agencies;
  const byCity = new Map<string, Agency[]>();
  for (const a of agencies) (byCity.get(key(a.city)) ?? byCity.set(key(a.city), []).get(key(a.city))!).push(a);
  for (const xs of byCity.values()) xs.sort((a, b) => b.population - a.population);
  return { byCity };
}

/** The build names no agency, so the label says what is known: the city's police, and its state. */
export const agencyLabel = (a: Agency) => `${a.city} city police, ${a.state}`;
const asPlace = (a: Agency): PlaceResolution => ({ kind: "agency", place: { kind: "agency", ori: a.ori, label: agencyLabel(a) }, agency: a });

/**
 * A ledger place value ("city:Memphis:TN", "ambiguous:Baltimore") and the words the question used for it. The reader
 * fills in a state it was not given ("Columbus" -> OH), so the state counts as named only when the words say more
 * than the city.
 */
export function resolveCity(idx: PlaceIndex, value: string, text: string): PlaceResolution {
  const m = /^(?:city:(.+):([A-Z]{2})?|ambiguous:(.+))$/.exec(value);
  if (!m) return { kind: "unresolved", why: `the slice resolves cities only (${value})` };
  const city = (m[1] ?? m[3]).trim();
  const all = idx.byCity.get(key(city)) ?? [];
  if (!all.length) return { kind: "unresolved", why: `no city police agency named ${city} with 10,000+ residents in this build` };
  const stateNamed = m[2] && key(text) !== key(city);
  if (stateNamed) {
    const inState = all.filter((a) => a.state === m[2]);
    return inState.length ? asPlace(inState[0]) : { kind: "unresolved", why: `no city police agency named ${city} in ${stateName(m[2]!)}` };
  }
  // The most populous of each state, then: ask when two or more states have a large one.
  const perState = all.filter((a, i) => all.findIndex((b) => b.state === a.state) === i);
  const large = perState.filter((a) => a.population >= ASK_POPULATION);
  return large.length >= 2 ? { kind: "ask", city, candidates: large } : asPlace(all[0]);
}
