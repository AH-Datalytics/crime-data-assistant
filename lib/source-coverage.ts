/**
 * S2: what an ABSENT row means, declared per table (Codex closeout direction, 2026-09-29).
 *
 * This RECORDS what is known; it creates no evidence. Every entry defaults to "unknown": a row that is
 * not there is neither a zero nor proof of non-reporting. Where a source keeps separate month evidence,
 * the entry names it and says what it actually measures, and a consumer may use it only for that
 * question (did an agency have offense records in each month), never for another (whether an offense
 * category was complete, or whether an agency submitted reports). Stage B and GC-042 do not close by
 * these declarations.
 *
 * NO PRODUCER CLAIM (Codex combined review, CL4). The repository holds a summary builder, but nothing
 * retained links it to the database that is served, so the absent-row sentences below state what is
 * observed -- no row -- and that its meaning is unknown. They do not describe how the rows were made.
 */

export type CoverageDeclaration = {
  /** Always "unknown" here: no table in this list is known to store a zero for an absent group. */
  absentRow: "unknown";
  /** The table that records month evidence per agency, if the source has one. */
  reportingEvidence: string | null;
  /** What that evidence counts, in delivered wording. It is not a record of report submission. */
  evidenceMeasures: string | null;
  /** Why absence is unknown, in delivered wording. */
  absentMeaning: string;
};

export const SOURCE_COVERAGE: Record<string, CoverageDeclaration> = {
  // SHR incidents carry one row per recorded homicide; nothing records which months an agency submitted.
  "shr.incidents": {
    absentRow: "unknown",
    reportingEvidence: null,
    evidenceMeasures: null,
    absentMeaning: "a month with no recorded homicide and a month that was not reported look the same",
  },
  // Month evidence per agency is kept separately in nibrs_agency_completeness: the number of months in
  // which the agency has at least one recorded offense (lib/nibrs-claude.ts documents the column).
  "nibrs.summary_victim_city_monthly": {
    absentRow: "unknown",
    reportingEvidence: "nibrs_agency_completeness",
    evidenceMeasures: "months with at least one recorded offense",
    absentMeaning: "no row was found, and what a missing row means in this source is not established: it may mean none occurred, none was recorded under that offense, or none was reported",
  },
  "nibrs.summary_city_monthly": {
    absentRow: "unknown",
    reportingEvidence: "nibrs_agency_completeness",
    evidenceMeasures: "months with at least one recorded offense",
    absentMeaning: "no row was found, and what a missing row means in this source is not established: it may mean none occurred, none was recorded under that offense, or none was reported",
  },
};

export function coverageOf(table: string): CoverageDeclaration {
  const entry = SOURCE_COVERAGE[table];
  if (!entry) throw new Error(`source-coverage: no declaration for ${table}`);
  return entry;
}

/**
 * The three month-evidence states, which never collapse (Codex combined review, CL4):
 *   twelve           the evidence row exists and records all 12 months;
 *   fewer            the evidence row exists and records fewer (an observed count, stated as such);
 *   not-established  there is no evidence row, so 12 months cannot be confirmed -- this is NOT an
 *                    observation that the agency failed to report, and is never worded as one.
 */
export type MonthEvidence =
  | { state: "twelve" }
  | { state: "fewer"; months: number }
  | { state: "not-established" };

export function monthEvidence(rows: Record<string, unknown>[], ori: string, year: number): MonthEvidence {
  const row = rows.find((r) => r.ori === ori && Number(r.year) === year);
  if (!row || row.months_reported == null || !Number.isFinite(Number(row.months_reported))) return { state: "not-established" };
  const months = Number(row.months_reported);
  return months >= 12 ? { state: "twelve" } : { state: "fewer", months };
}
