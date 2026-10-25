import { GENERATED_AMBIGUOUS_COUNTIES } from "./generated/ambiguous-counties";
import { GENERATED_GEO_CITIES } from "./generated/geo-cities";

export type GeoPlaceKind = "city" | "county" | "state" | "agency_alias";

export type GeoPlaceCatalogEntry = {
  id: string;
  kind: GeoPlaceKind;
  name: string;
  state?: string;
  aliases: string[];
  canonicalQuery?: string;
  source: "state-list" | "generated-county" | "generated-city" | "reviewed-trap" | "manual-alias";
  dominancePopulation?: number;
  dominancePopulationYear?: number;
  dominancePopulationSource?: "current" | "historical";
};

const STATES: { code: string; name: string; aliases?: string[] }[] = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana", aliases: ["Louisiana", "LA"] },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York", aliases: ["New York", "NY"] },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
  { code: "DC", name: "District of Columbia" },
];

const CITY_JURISDICTION_ALIAS_KEYS = new Set([
  "MD:BALTIMORE",
  "MO:ST. LOUIS",
  "VA:ALEXANDRIA",
  "VA:BRISTOL",
  "VA:BUENA VISTA",
  "VA:CHARLOTTESVILLE",
  "VA:CHESAPEAKE",
  "VA:COLONIAL HEIGHTS",
  "VA:COVINGTON",
  "VA:DANVILLE",
  "VA:EMPORIA",
  "VA:FAIRFAX",
  "VA:FALLS CHURCH",
  "VA:FRANKLIN",
  "VA:FREDERICKSBURG",
  "VA:GALAX",
  "VA:HAMPTON",
  "VA:HARRISONBURG",
  "VA:HOPEWELL",
  "VA:LEXINGTON",
  "VA:LYNCHBURG",
  "VA:MANASSAS",
  "VA:MANASSAS PARK",
  "VA:MARTINSVILLE",
  "VA:NEWPORT NEWS",
  "VA:NORFOLK",
  "VA:NORTON",
  "VA:PETERSBURG",
  "VA:POQUOSON",
  "VA:PORTSMOUTH",
  "VA:RADFORD",
  "VA:RICHMOND",
  "VA:ROANOKE",
  "VA:SALEM",
  "VA:STAUNTON",
  "VA:SUFFOLK",
  "VA:VIRGINIA BEACH",
  "VA:WAYNESBORO",
  "VA:WILLIAMSBURG",
  "VA:WINCHESTER",
]);

const REVIEWED_CITY_COUNTY: GeoPlaceCatalogEntry[] = [
  city("Alameda", "CA", ["Alameda", "Alameda, California", "Alameda CA"]),
  county("Alameda", "CA", ["Alameda", "Alameda County", "Alameda County, California", "Alameda County CA"]),
  city("Albany", "NY", ["Albany", "Albany, New York", "Albany NY"]),
  county("Albany", "NY", ["Albany", "Albany County", "Albany County, New York", "Albany County NY"]),
  city("Boise", "ID", ["Boise", "Boise, Idaho", "Boise ID"]),
  county("Boise", "ID", ["Boise", "Boise County", "Boise County, Idaho", "Boise County ID"]),
  city("Fairfax", "VA", ["Fairfax", "Fairfax, Virginia", "Fairfax VA"]),
  county("Fairfax", "VA", ["Fairfax", "Fairfax County", "Fairfax County, Virginia", "Fairfax County VA"]),
  // Complete-turn fix (2026-10-23, owner report "LAPD murder clearance rate since 1960"): the department's own names are
  // the city agency, never the county.
  city("Los Angeles", "CA", ["Los Angeles", "Los Angeles, California", "Los Angeles CA", "LA", "L.A.", "LA city", "L.A. city", "LAPD", "Los Angeles Police Department"]),
  county("Los Angeles", "CA", ["Los Angeles", "Los Angeles County", "Los Angeles County, California", "Los Angeles County CA", "LA", "LA County", "L.A. County"]),
  city("Sacramento", "CA", ["Sacramento", "Sacramento, California", "Sacramento CA"]),
  county("Sacramento", "CA", ["Sacramento", "Sacramento County", "Sacramento County, California", "Sacramento County CA"]),
  city("San Diego", "CA", ["San Diego", "San Diego, California", "San Diego CA"]),
  county("San Diego", "CA", ["San Diego", "San Diego County", "San Diego County, California", "San Diego County CA"]),
  city("El Paso", "TX", ["El Paso", "El Paso, Texas", "El Paso TX"]),
  county("El Paso", "TX", ["El Paso", "El Paso County", "El Paso County, Texas", "El Paso County TX"]),
  county("Miami-Dade", "FL", ["Miami-Dade", "Miami-Dade County", "Miami-Dade County, FL", "Miami-Dade County FL", "Miami-Dade County, Florida", "Miami-Dade County Florida"]),
];

const MANUAL_ALIASES: GeoPlaceCatalogEntry[] = [
  city("New York City", "NY", ["New York", "NY", "NYC", "New York City", "NYPD"]),
  // Historical vocabulary pass (2026-10-24, Codex ACCEPT): the department's own initials name the city agency, as NYPD/LAPD.
  city("New Orleans", "LA", ["NOPD", "New Orleans Police Department"]),
  state("New York", "NY", ["New York", "New York State", "State of New York", "NY State"]),
  county("New York", "NY", ["New York County", "New York County, NY", "New York County NY", "New York County, New York", "New York County New York"], "manual-alias"),
  city("Washington", "DC", ["Washington", "Washington, DC", "Washington DC", "D.C.", "DC", "District of Columbia"]),
  state("Washington", "WA", ["Washington", "Washington State", "State of Washington"]),
  city("Kansas City", "MO", ["Kansas City", "KC", "KCMO", "Kansas City, Missouri", "Kansas City MO"]),
  city("Kansas City", "KS", ["Kansas City", "KC", "KCK", "Kansas City, Kansas", "Kansas City KS"]),
  city("Baltimore", "MD", ["Baltimore", "Batlimore", "Baltimore city", "Batlimore city", "Baltimore, Maryland", "Baltimore MD"]),
  county("Baltimore", "MD", ["Baltimore", "Batlimore", "Baltimore County", "Batlimore County", "Baltimore County, Maryland", "Baltimore County MD"]),
  city("St. Louis", "MO", ["St. Louis", "Saint Louis", "St Louis", "STL", "St. Louis city", "Saint Louis city", "St Louis city", "STL city", "St. Louis, Missouri", "St Louis MO"]),
  county("St. Louis", "MO", ["St. Louis", "Saint Louis", "St Louis", "STL", "St. Louis County", "Saint Louis County", "St Louis County", "STL County", "St. Louis County, Missouri", "St Louis County MO"]),
  city("Portland", "OR", ["Portland", "Portland, Oregon", "Portland OR"]),
  city("Portland", "ME", ["Portland", "Portland, Maine", "Portland ME"]),
  // Consolidated city-county governments whose common name was absent from the
  // catalog entirely, so the question could never resolve. `name` must be the exact
  // historical_agency name; lib/agency-consolidations.ts maps it back to the short
  // display name ("Athens, GA", "Butte, MT") that every tab shows.
  //
  // Bare "Athens" stays ambiguous on purpose -- there are Athens entries in eight
  // other states -- but "Athens, GA" now resolves instead of asking for a state it
  // was never able to accept.
  city("Athens", "GA", [
    "Athens", "Athens, GA", "Athens GA", "Athens, Georgia", "Athens Georgia",
    "Athens-Clarke County", "Athens Clarke County", "Athens-Clarke", "Athens Clarke",
  ]),
  // Aliases here deliberately exclude the bare hyphenated "Butte-Silver Bow": that
  // string belongs to the generated entry for the DEAD city ORI (last real year
  // 1981), and the consolidation registry already redirects it to this county.
  city("Butte", "MT", [
    "Butte", "Butte, MT", "Butte MT", "Butte, Montana", "Butte Montana",
    "Butte-Silver Bow County", "Butte Silver Bow County",
  ]),
];

export const GEO_PLACE_CATALOG: GeoPlaceCatalogEntry[] = [
  ...STATES.map(({ code, name, aliases }) => state(name, code, aliases ?? [name])),
  ...MANUAL_ALIASES,
  ...REVIEWED_CITY_COUNTY,
  ...GENERATED_GEO_CITIES.filter((entry) => !isGeneratedJurisdictionDuplicate(entry.name, entry.state)).map((entry) =>
    city(entry.name, entry.state, entry.aliases, "generated-city", {
      dominancePopulation: entry.dominancePopulation,
      dominancePopulationYear: entry.dominancePopulationYear,
      dominancePopulationSource: entry.dominancePopulationSource,
    })
  ),
  ...GENERATED_AMBIGUOUS_COUNTIES.flatMap(({ name, states }) =>
    states.map((code) => county(name, code, [
      `${name} County`,
      `${name} County, ${code}`,
      `${name} County ${code}`,
      `${name} County, ${stateName(code)}`,
      `${name} County ${stateName(code)}`,
      // Louisiana counties are parishes — "Jefferson Parish" must resolve to
      // the LA county entry, not fall through to the bare "Jefferson" city group
      ...(code === "LA" ? [
        `${name} Parish`,
        `${name} Parish, LA`,
        `${name} Parish LA`,
        `${name} Parish, Louisiana`,
        `${name} Parish Louisiana`,
      ] : []),
    ], "generated-county"))
  ),
];

function city(
  name: string,
  stateCode: string,
  aliases: string[],
  source: GeoPlaceCatalogEntry["source"] = "reviewed-trap",
  metadata: Pick<GeoPlaceCatalogEntry, "dominancePopulation" | "dominancePopulationYear" | "dominancePopulationSource"> = {}
): GeoPlaceCatalogEntry {
  const cityAliases = cityJurisdictionAliases(name, stateCode, aliases);
  return {
    id: `city:${stateCode}:${slug(name)}`,
    kind: "city",
    name,
    state: stateCode,
    aliases: cityAliases,
    canonicalQuery: `${name}, ${stateCode}`,
    source,
    ...metadata,
  };
}

function cityJurisdictionAliases(name: string, stateCode: string, aliases: string[]): string[] {
  const values = new Set(aliases);
  const jurisdictionKey = `${stateCode}:${name.toUpperCase()}`;
  if (!/\bCity$/i.test(name) && CITY_JURISDICTION_ALIAS_KEYS.has(jurisdictionKey)) {
    values.add(`${name} City`);
  }
  return [...values];
}

function isGeneratedJurisdictionDuplicate(name: string, stateCode: string): boolean {
  const baseName = name.replace(/\s+city$/i, "").trim();
  return baseName !== name && CITY_JURISDICTION_ALIAS_KEYS.has(`${stateCode}:${baseName.toUpperCase()}`);
}

function county(name: string, stateCode: string, aliases: string[], source: GeoPlaceCatalogEntry["source"] = "reviewed-trap"): GeoPlaceCatalogEntry {
  return {
    id: `county:${stateCode}:${slug(name)}`,
    kind: "county",
    name: `${name} County`,
    state: stateCode,
    aliases,
    canonicalQuery: `${name} County, ${stateCode}`,
    source,
  };
}

function state(name: string, code: string, aliases: string[], source: GeoPlaceCatalogEntry["source"] = "state-list"): GeoPlaceCatalogEntry {
  return {
    id: `state:${code}`,
    kind: "state",
    name,
    state: code,
    aliases,
    canonicalQuery: name,
    source,
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function stateName(code: string): string {
  return STATES.find((state) => state.code === code)?.name ?? code;
}
