/**
 * NIBRS-only agency aliases.
 *
 * WHY THIS IS NOT IN agency-consolidations.ts
 * -------------------------------------------
 * A ConsolidatedAgency row requires historicalAgency, historicalType and
 * historicalOri, and a lot of Historical code reads those without checking. Some
 * places need a NIBRS correction and cannot supply a truthful Historical one --
 * making those fields optional would turn a contained NIBRS fix into a refactor
 * of every Historical path that assumes they exist.
 *
 * So this registry does exactly one thing: map a city the user names to the ORI
 * that actually holds its NIBRS data. It is consulted only by the NIBRS place
 * resolver. Historical, SHR and RTCI never see it.
 *
 * WHEN TO ADD A ROW
 * -----------------
 * Only when the NIBRS city lookup cannot reach the right agency on its own. That
 * lookup filters agency_type = 'City' and population > 0, which is correct almost
 * everywhere and wrong for consolidated city-county departments that file as
 * County. A row here is a claim that a specific ORI is the agency a user means,
 * verified against FBI CDE and against the data -- not a guess from a name match.
 *
 * A row does NOT assert a merger, a predecessor, or anything about Historical.
 * If a place also needs its Historical identity corrected, that belongs in
 * agency-consolidations.ts, separately and with its own evidence.
 */

export type NibrsAgencyAlias = {
  /** The city name a user types. Matched case-insensitively, state-scoped. */
  city: string;
  /** USPS state code, upper case. */
  state: string;
  /** Verified NIBRS ORI holding this city's data. */
  nibrsOri: string;
  /** Evidence trail for this row. */
  note: string;
};

export const NIBRS_AGENCY_ALIASES: NibrsAgencyAlias[] = [
  {
    city: "Jacksonville",
    state: "FL",
    nibrsOri: "FL0160000",
    note:
      "Jacksonville and Duval County consolidated in 1968; the Jacksonville Sheriff's Office polices the merged jurisdiction and files as agency_type 'County', so the City-only city lookup could never reach it. FBI CDE (agency/byStateAbbr/FL, checked 2026-08-10) names FL0160000 \"Jacksonville Sheriff's Office\", County, Duval, is_nibrs true, nibrs_start_date 2021-01-01; it carries 1,008,920 population and 77 murders with 40 cleared by arrest for 2025. Without this row the lookup selected FL0162500 -- a 1,382-population agency sharing the mailing city -- which has no clearance rows, so Jacksonville vanished from multi-city answers without a missing-agency note (production 8375/8376). Deliberately NOT a consolidation entry: Historical splits this agency across FL0160200 (real data 1960-2020) and FL0160000 (2021-2025), and a single-successor mapping would discard the earlier six decades. See CONSOLIDATION_EXCLUSIONS in agency-consolidations.ts.",
  },
];

const BY_KEY = new Map<string, NibrsAgencyAlias>();
for (const entry of NIBRS_AGENCY_ALIASES) {
  BY_KEY.set(`${entry.state.trim().toUpperCase()}|${entry.city.trim().toUpperCase()}`, entry);
}

/** The NIBRS ORI for a city that the ordinary city lookup cannot reach, if one is registered. */
export function findNibrsAgencyAlias(
  state: string | undefined | null,
  city: string | undefined | null
): NibrsAgencyAlias | undefined {
  if (!state || !city) return undefined;
  return BY_KEY.get(`${state.trim().toUpperCase()}|${city.trim().toUpperCase()}`);
}
