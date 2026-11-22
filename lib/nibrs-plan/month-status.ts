/**
 * Which agency-months reported their crimes (P51, P121; Jeff's batch 2 of the audit, 2026-11-22; the independent review of PR 347).
 *
 * agency_month_status (Model's build) calls a month REPORTED_CRIMES when it has any row at all, Group A offenses or Group B arrests, and REPORTED_ZERO when
 * the agency's zero report (the zero flag set and no incident rows at all) is the only evidence. For a crime counted from Group A segments:
 *   - a month with Group A rows reported (REPORTED_CRIMES);
 *   - a month with only Group B arrest rows did NOT report, whatever the zero flag says: unknown, blank with the gap sentence, never a 0;
 *   - a formal zero report (no rows at all) is a reported 0: it counts as 0 in one agency's own total, and adds nothing to a sum.
 * The Consistent Reporting Agencies need a Group A row in every month (a zero report or a Group B-only month excludes the agency): that is the VALUE
 * cell in the grid, which only a month with Group A rows (or offense rows, P183) gives.
 * Arrests keep the status as built: a Group B arrest is that month's arrest report.
 *
 * One expression for the compiler, the coverage questions and the first-reported-month offer, so they cannot disagree.
 */
/** The status of the month for a crime count: REPORTED_CRIMES (Group A rows), REPORTED_ZERO (a formal zero report), UNKNOWN (including Group B rows only). */
export const CRIME_MONTH_STATUS = "CASE WHEN status = 'REPORTED_CRIMES' AND coalesce(group_a_rows, 0) = 0 THEN 'UNKNOWN' ELSE status END";
/** A condition: the month reported its crimes (Group A rows or a zero report). */
export const CRIME_MONTH_REPORTED = `(${CRIME_MONTH_STATUS}) IN ('REPORTED_CRIMES', 'REPORTED_ZERO')`;
/** A condition: the month reported at all, for an arrest question (the status as built). */
export const ARREST_MONTH_REPORTED = "status IN ('REPORTED_CRIMES', 'REPORTED_ZERO')";
