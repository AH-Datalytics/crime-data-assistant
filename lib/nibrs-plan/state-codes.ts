/**
 * State codes (coordinator 2026-11-03): a place's state is always its postal code. The FBI's ORI prefix, and the NIBRS
 * batch header's state, differ from it for Nebraska ("NB") and Guam ("GM"), so an ORI prefix or a header state is never
 * a label or a filter value by itself: it goes through postalState, and a filter on header states uses headerStates.
 */
export const ORI_PREFIX_STATES: Readonly<Record<string, string>> = { NB: "NE", GM: "GU" };

/** The postal code for an ORI prefix or a header state: "NB" -> "NE"; any other code as given. */
export const postalState = (code: string): string => ORI_PREFIX_STATES[code] ?? code;

/** The header states a postal code is filed under: "NE" -> ["NE", "NB"]; any other code alone. */
export const headerStates = (postal: string): string[] => [postal, ...Object.keys(ORI_PREFIX_STATES).filter((k) => ORI_PREFIX_STATES[k] === postal)];

/** SQL for a header-state column as its postal code: CASE col WHEN 'NB' THEN 'NE' ... ELSE col END. */
export const postalStateSql = (col: string): string =>
  `CASE ${col} ${Object.entries(ORI_PREFIX_STATES).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(" ")} ELSE ${col} END`;
