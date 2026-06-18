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

const STATES: { code: string; name: string }[] = [
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
  { code: "LA", name: "Louisiana" },
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
  { code: "NY", name: "New York" },
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

const REVIEWED_CITY_COUNTY: GeoPlaceCatalogEntry[] = [
  city("Alameda", "CA", ["Alameda", "Alameda, California", "Alameda CA"]),
  county("Alameda", "CA", ["Alameda", "Alameda County", "Alameda County, California", "Alameda County CA"]),
  city("Albany", "NY", ["Albany", "Albany, New York", "Albany NY"]),
  county("Albany", "NY", ["Albany", "Albany County", "Albany County, New York", "Albany County NY"]),
  city("Boise", "ID", ["Boise", "Boise, Idaho", "Boise ID"]),
  county("Boise", "ID", ["Boise", "Boise County", "Boise County, Idaho", "Boise County ID"]),
  city("Fairfax", "VA", ["Fairfax", "Fairfax, Virginia", "Fairfax VA"]),
  county("Fairfax", "VA", ["Fairfax", "Fairfax County", "Fairfax County, Virginia", "Fairfax County VA"]),
  city("Los Angeles", "CA", ["Los Angeles", "Los Angeles, California", "Los Angeles CA"]),
  county("Los Angeles", "CA", ["Los Angeles", "Los Angeles County", "Los Angeles County, California", "Los Angeles County CA"]),
  city("Sacramento", "CA", ["Sacramento", "Sacramento, California", "Sacramento CA"]),
  county("Sacramento", "CA", ["Sacramento", "Sacramento County", "Sacramento County, California", "Sacramento County CA"]),
  city("San Diego", "CA", ["San Diego", "San Diego, California", "San Diego CA"]),
  county("San Diego", "CA", ["San Diego", "San Diego County", "San Diego County, California", "San Diego County CA"]),
  city("El Paso", "TX", ["El Paso", "El Paso, Texas", "El Paso TX"]),
  county("El Paso", "TX", ["El Paso", "El Paso County", "El Paso County, Texas", "El Paso County TX"]),
  county("Miami-Dade", "FL", ["Miami-Dade", "Miami-Dade County", "Miami-Dade County, FL", "Miami-Dade County FL", "Miami-Dade County, Florida", "Miami-Dade County Florida"]),
];

const MANUAL_ALIASES: GeoPlaceCatalogEntry[] = [
  city("New York City", "NY", ["New York", "NYC", "New York City", "NYPD"]),
  state("New York", "NY", ["New York", "New York State", "State of New York", "NY State"]),
  county("New York", "NY", ["New York County", "New York County, NY", "New York County NY", "New York County, New York", "New York County New York"], "manual-alias"),
  city("Washington", "DC", ["Washington", "Washington, DC", "Washington DC", "D.C.", "DC", "District of Columbia"]),
  state("Washington", "WA", ["Washington", "Washington State", "State of Washington"]),
  city("Kansas City", "MO", ["Kansas City", "KCMO", "Kansas City, Missouri", "Kansas City MO"]),
  city("Kansas City", "KS", ["Kansas City", "KCK", "Kansas City, Kansas", "Kansas City KS"]),
  city("Baltimore city", "MD", ["Baltimore", "Baltimore city", "Baltimore, Maryland", "Baltimore MD"]),
  county("Baltimore", "MD", ["Baltimore", "Baltimore County", "Baltimore County, Maryland", "Baltimore County MD"]),
  city("St. Louis city", "MO", ["St. Louis", "Saint Louis", "St Louis", "St. Louis city", "Saint Louis city", "St Louis city", "St. Louis, Missouri", "St Louis MO"]),
  county("St. Louis", "MO", ["St. Louis", "Saint Louis", "St Louis", "St. Louis County", "Saint Louis County", "St Louis County", "St. Louis County, Missouri", "St Louis County MO"]),
  city("Portland", "OR", ["Portland", "Portland, Oregon", "Portland OR"]),
  city("Portland", "ME", ["Portland", "Portland, Maine", "Portland ME"]),
];

export const GEO_PLACE_CATALOG: GeoPlaceCatalogEntry[] = [
  ...STATES.map(({ code, name }) => state(name, code, [name])),
  ...MANUAL_ALIASES,
  ...REVIEWED_CITY_COUNTY,
  ...GENERATED_GEO_CITIES.map((entry) =>
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
  return {
    id: `city:${stateCode}:${slug(name)}`,
    kind: "city",
    name,
    state: stateCode,
    aliases,
    canonicalQuery: `${name}, ${stateCode}`,
    source,
    ...metadata,
  };
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
