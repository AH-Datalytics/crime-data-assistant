export const STATE_NAME_TO_ABBR: Record<string, string> = {
  Alabama: "AL",
  Alaska: "AK",
  Arizona: "AZ",
  Arkansas: "AR",
  California: "CA",
  Colorado: "CO",
  Connecticut: "CT",
  Delaware: "DE",
  "District of Columbia": "DC",
  Florida: "FL",
  Georgia: "GA",
  Hawaii: "HI",
  Idaho: "ID",
  Illinois: "IL",
  Indiana: "IN",
  Iowa: "IA",
  Kansas: "KS",
  Kentucky: "KY",
  Louisiana: "LA",
  Maine: "ME",
  Maryland: "MD",
  Massachusetts: "MA",
  Michigan: "MI",
  Minnesota: "MN",
  Mississippi: "MS",
  Missouri: "MO",
  Montana: "MT",
  Nebraska: "NE",
  Nevada: "NV",
  "New Hampshire": "NH",
  "New Jersey": "NJ",
  "New Mexico": "NM",
  "New York": "NY",
  "North Carolina": "NC",
  "North Dakota": "ND",
  Ohio: "OH",
  Oklahoma: "OK",
  Oregon: "OR",
  Pennsylvania: "PA",
  "Rhode Island": "RI",
  "South Carolina": "SC",
  "South Dakota": "SD",
  Tennessee: "TN",
  Texas: "TX",
  Utah: "UT",
  Vermont: "VT",
  Virginia: "VA",
  Washington: "WA",
  "West Virginia": "WV",
  Wisconsin: "WI",
  Wyoming: "WY",
  "United States": "US",
};

const NORMALIZED_STATE_NAME_TO_ABBR = new Map(
  Object.entries(STATE_NAME_TO_ABBR).map(([name, abbr]) => [normalizeStateName(name), abbr])
);

export interface HistoricalPopulationRow {
  state: string;
  year: number;
  population: number;
}

export interface StatePopulationRow {
  state: string;
  state_name: string;
  year: number;
  population: number;
  source: string;
}

export function normalizeStateName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function stateNameToAbbr(name: string): string | null {
  return NORMALIZED_STATE_NAME_TO_ABBR.get(normalizeStateName(name)) || null;
}

export function buildStatePopulationRows(
  rows: HistoricalPopulationRow[],
  source = "Historical Library historical_state_national population"
): StatePopulationRow[] {
  return rows
    .map((row) => {
      const state = stateNameToAbbr(row.state);
      if (!state || !Number.isFinite(row.year) || !Number.isFinite(row.population) || row.population <= 0) {
        return null;
      }
      return {
        state,
        state_name: row.state.trim().replace(/\s+/g, " "),
        year: row.year,
        population: row.population,
        source,
      };
    })
    .filter((row): row is StatePopulationRow => row !== null)
    .sort((a, b) => a.state.localeCompare(b.state) || a.year - b.year);
}

