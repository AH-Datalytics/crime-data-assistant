/**
 * S1: which entity a row IS, decided once from the source's own recorded evidence (Codex closeout
 * direction, 2026-09-29).
 *
 * Every source reports by agency. "City" is a claim about an agency, and it has three outcomes, each
 * with the evidence that decides it:
 *   - eligible:   the source RECORDS the agency as a city;
 *   - ineligible: the source records it as something else (County, Other, ...);
 *   - unresolved: the source records no type.
 * A type inferred from an agency's NAME is never evidence. `shr_agency_identity.agency_type` falls back
 * to exactly that (`inferShrAgencyType`), so it is not read here, and moving it into a catalog would not
 * give it authority.
 *
 * An unresolved agency is neither ranked as a city nor silently dropped: when it could change the
 * requested result, the result is reported as incomplete and names it (`rankingCompleteness`).
 */

export type CityMembership = "eligible" | "ineligible" | "unresolved";

export type CityAuthority = {
  /** What establishes membership, for the delivered wording and the review record. */
  evidence: string;
  /** SQL predicates over the source's own row alias. */
  eligibleSql: (alias: string) => string;
  unresolvedSql: (alias: string) => string;
  classify: (recordedType: unknown) => CityMembership;
};

/**
 * One rule, read from each source's OWN recorded type column (Codex combined review: S1 must govern
 * the Current and NIBRS city rankings too). The storage differs by source and is not unified:
 *   - SHR:     no recorded type; see SHR_CITY_AUTHORITY below (evidence-backed classification instead);
 *   - NIBRS:   `agencies.agency_type`, one row per agency-year under a declared PRIMARY KEY (ori, year);
 *   - Current: `agency_monthly.type`, on every month row, so one agency can carry several values.
 * The eligible predicate is written exactly as each branch has always written it, so an answer whose
 * candidates are all confirmed is unchanged.
 */
function recordedTypeAuthority(column: string, evidence: string): CityAuthority {
  return {
    evidence,
    eligibleSql: (a) => `${a}.${column} = 'City'`,
    unresolvedSql: (a) => `(${a}.${column} IS NULL OR ${a}.${column} = '')`,
    classify: (recordedType) => {
      if (recordedType === "City") return "eligible";
      if (recordedType == null || recordedType === "") return "unresolved";
      return "ineligible";
    },
  };
}

/**
 * SHR: NOT a recorded column. SHR records no agency type; `incidents.agency_type` holds normalizer-derived
 * and legacy values of unknown origin, so it is not read (SHR identity read and Jeff's classification
 * policy, 2026-09-30). Membership is the evidence-backed classification of lib/shr-agency-classification.ts
 * -- the NIBRS database's classification of the one NIBRS agency the SHR identifier matches in its state, for
 * the years up to the ranking year (partly derived there from population group) -- supplied per candidate by
 * the SHR adapter (`CompletenessPlan.typeOf`). `eligibleSql`/`unresolvedSql` are not used for SHR: its
 * ranked statement names the confirmed agencies by ORI instead.
 */
export const SHR_CITY_AUTHORITY: CityAuthority = {
  ...recordedTypeAuthority("agency_type", "the NIBRS database's classification of the one NIBRS agency the SHR identifier matches in its state"),
  eligibleSql: () => { throw new Error("entity-authority: SHR membership is not a column predicate; name the confirmed ORIs"); },
  unresolvedSql: () => { throw new Error("entity-authority: SHR membership is not a column predicate"); },
};
/** NIBRS: `agencies.agency_type` for the agency-year. */
export const NIBRS_CITY_AUTHORITY: CityAuthority = recordedTypeAuthority("agency_type", "the agency type NIBRS records for the agency that year");
/** Current: `agency_monthly.type` on the agency's month rows. */
export const CURRENT_CITY_AUTHORITY: CityAuthority = recordedTypeAuthority("type", "the agency type recorded on the agency's Current month rows");

export type RankedMeasure = { ori: string; label: string; measure: number };

/**
 * Is a ranking of confirmed cities the complete answer, given the unresolved candidates?
 *
 * An unresolved candidate can change the result when it would place inside the returned rows: its
 * measure is at least the last returned city's (for a highest-first ranking; at most, for lowest-first),
 * or the ranking returned fewer rows than requested, so any candidate could fill a place. A candidate
 * whose identity itself is split (two population or type records) could change the result whatever its
 * measure, so it is always relevant.
 */
export function rankingCompleteness<T extends RankedMeasure>(opts: {
  ranked: RankedMeasure[];
  limit: number;
  direction: "asc" | "desc";
  unresolved: T[];
  splitIdentities: { ori: string; label: string }[];
}): { complete: boolean; relevant: T[]; split: { ori: string; label: string }[] } {
  const full = opts.ranked.length >= opts.limit;
  const edge = full ? opts.ranked[opts.limit - 1].measure : null;
  const relevant = opts.unresolved.filter((u) => edge === null
    || (opts.direction === "desc" ? u.measure >= edge : u.measure <= edge));
  return { complete: relevant.length === 0 && opts.splitIdentities.length === 0, relevant, split: opts.splitIdentities };
}
