/**
 * Which agency-months reported their crimes (P51, P121; the coordinator 2026-11-22, QL-ct-f960533ecf; the independent review of PR 347).
 *
 * agency_month_status (Model's build) calls a month REPORTED_CRIMES when it has any row at all, Group A offenses or Group B arrests, and REPORTED_ZERO when
 * the agency's zero report is the only evidence. A month with only Group B arrest rows is not a crime report: for a crime counted from Group A segments it
 * did not report (unknown, blank with the gap sentence, never a 0) unless the agency's own zero report is in it (zero_flag Y: a reported zero). The flag
 * ab_flag is not tested: with rows present it is set by the rows themselves (Model's evidence_class ROWS), so testing it would drop real zero reports.
 * Arrests keep the status as built: a Group B arrest is that month's arrest report.
 *
 * One expression for the compiler, the coverage questions and the first-reported-month offer, so they cannot disagree.
 */
/** The status of the month for a crime count: REPORTED_CRIMES (Group A rows), REPORTED_ZERO (a zero report, with or without Group B rows), UNKNOWN. */
export const CRIME_MONTH_STATUS = "CASE WHEN status = 'REPORTED_CRIMES' AND coalesce(group_a_rows, 0) = 0 THEN CASE WHEN coalesce(zero_flag, 'N') = 'Y' THEN 'REPORTED_ZERO' ELSE 'UNKNOWN' END ELSE status END";
/** A condition: the month reported its crimes (Group A rows or a zero report). */
export const CRIME_MONTH_REPORTED = `(${CRIME_MONTH_STATUS}) IN ('REPORTED_CRIMES', 'REPORTED_ZERO')`;
/** A condition: the month reported at all, for an arrest question (the status as built). */
export const ARREST_MONTH_REPORTED = "status IN ('REPORTED_CRIMES', 'REPORTED_ZERO')";
