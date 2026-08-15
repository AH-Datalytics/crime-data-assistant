/**
 * GENERATED FILE -- DO NOT EDIT BY HAND.
 *
 * Produced by `npx tsx scripts/generate-source-health-inventory.ts` from the derived operation
 * catalogs. `scripts/test-source-health-inventory.ts` asserts this file is byte-identical to what
 * the generator emits, so a hand edit fails the suite: three hand-authored inventories were wrong
 * before this one.
 *
 * Capabilities: 52 (51 operation-backed + 1 sweep-only).
 * Policy authored: 1. Authorization-eligible: 0.
 *
 * Nothing here authorizes anything. `authorizationEligible` is false until every policy field is
 * authored in `scripts/fixtures/operation-taxonomy/capability-policy.json`, which is Stage 2B work.
 */
import type { SourceId } from "./sources";
import { getDb } from "./rtci-db";
import { getNibrsDb } from "./nibrs-db";
import { getShrDb } from "./shr-db";
import { getHateCrimeDb } from "./hc-db";

export type Db = import("better-sqlite3").Database;
/** A handle and the path it was actually opened from, acquired together. */
export type OpenedDatabase = { db: Db; resolvedPath: string };
export type DatabaseProvider = { acquire: () => OpenedDatabase | null };
export type TableRequirement = { name: string; requiredColumns: string[]; minRows: number };
/**
 * A derived table and the upstream it must agree with.
 *
 * keyColumn is STATED, not inferred. Taking the derived table's first required column as the join
 * key made a semantic relationship depend on alphabetical ordering -- correct for sample_agencies
 * only because sorting happens to put ori first.
 */
export type DependencyRule = { derived: string; upstream: string; keyColumn: string; generationColumn?: string };
export type SemanticDependency = {
  table: string; requiredColumns: string[]; qualifies: string;
  keyColumn: string; yearColumn: string; versionColumn?: string;
  /**
   * Whether the qualifying table is a COMPLETE ledger or a SPARSE exception table.
   *
   * This is not a detail. `agency_year_reliability` is sparse: its builder inserts a row only for a
   * detected finding (scripts/build-agency-year-reliability.ts, inside `for (const finding of
   * findings)`), so an absent agency-year normally means no anomaly was recorded. Requiring every
   * qualified row to have a qualifying row would therefore degrade nearly every real capability
   * holding ordinary unflagged crime data.
   *
   *   complete -> every qualified row must have a qualifying row
   *   sparse   -> existing flags must be VALID; absence is not a defect, and build completeness
   *               cannot be established from row presence or MAX(year) at all, because a recent year
   *               may legitimately produce zero flags. It needs generation/receipt evidence.
   */
  coverage: "complete" | "sparse";
};
export type CapabilityPolicy = {
  /**
   * Discriminated, so an authored "no year dimension" is an ANSWER rather than an absence. It was
   * once the string "none", normalised to null on import, which made a considered decision
   * indistinguishable from never having been asked.
   */
  coverage:
    | { kind: "column"; table: string; yearColumn: string; justification?: string }
    | { kind: "none"; reason: string }
    | null;
  /**
   * A rule is DRAFT PROSE (a string) or BOUND ({ rule, boundTo }). NEITHER AUTHORIZES TODAY: there
   * is no catalog to resolve boundTo against, no resolver and no runtime consumer of it, so no
   * integrity rule can be executed and every capability is ineligible. The bound shape exists so
   * that drafts written now need not be rewritten when machinery that runs a rule lands; until then
   * it records an intention, not a check. lib/capability-policy.ts holds the one predicate.
   */
  integrity: (string | { rule: string; boundTo: string })[] | null;
  /** Discriminated, so a conditional cannot be written without its condition. */
  availability: { kind: "always" } | { kind: "conditional"; condition: string } | null;
  receiptOwner: string | null;
  evidence: string;
  /**
   * Present only on policy migrated from before the workbook existed. It has no human answer and no
   * confirmation behind it, so it authorizes nothing whatever its fields contain.
   */
  origin?: "legacy";
};
export type CapabilitySpec = {
  capabilityId: string;              // the registry key; identity, not a label
  artifact: SourceId | "crime_data";
  database: DatabaseProvider;
  /** Read while RESOLVING/CONSTRUCTING; absent from the emitted SQL. */
  preparationTables: TableRequirement[];
  tables: TableRequirement[];
  /** Empty until Task 3 authors dependency rules; the regression asserts they stay empty. */
  dependencies: DependencyRule[];
  semanticDependencies: SemanticDependency[];
  /**
   * The env-var name that gates probing, PINNED here so a variable in ops config traces back to its
   * capability. Consumers read this; they must not re-derive it.
   */
  flagKey: string;
  /** Hand-authored policy, copied from capability-policy.json. null means "not yet authored". */
  policy: CapabilityPolicy | null;
  /** Computed from the policy, never set by hand. False unless every policy field is authored. */
  authorizationEligible: boolean;
};

/** Acquire a handle and the path it resolved to in one call, or nothing. */
function open(get: () => Db | null): OpenedDatabase | null {
  try {
    const db = get();
    return db ? { db, resolvedPath: db.name } : null;
  } catch {
    return null;
  }
}

/**
 * Each capability owns its provider, so no route has to hand a database over -- and a capability
 * cannot be evaluated against a handle that belongs to a different artifact.
 */
const PROVIDERS: Record<string, DatabaseProvider> = {
  crime_data: { acquire: () => open(() => getDb()) },
  nibrs: { acquire: () => open(() => getNibrsDb()) },
  shr: { acquire: () => open(() => getShrDb()) },
  hate_crime: { acquire: () => open(() => getHateCrimeDb()) },
};

/** Capabilities no deterministic operation reaches; evaluated by the digest-time sweep (Task 11). */
export const SWEEP_ONLY: readonly string[] = ["crime_data::national_monthly::sweep"];

export const CAPABILITY_INVENTORY: readonly CapabilitySpec[] = [
  {
    capabilityId: "crime_data::agencies+agency_county_crosswalk::agencies(agency,national_sample,ori)|agency_county_crosswalk(county_fips,county_key,ori,ori9,state)",
    artifact: "crime_data",
    database: PROVIDERS["crime_data"],
    preparationTables: [],
    tables: [
      { name: "agencies", requiredColumns: ["agency","national_sample","ori"], minRows: 1 },
      { name: "agency_county_crosswalk", requiredColumns: ["county_fips","county_key","ori","ori9","state"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_CRIME_DATA_F5810DD4",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "crime_data::agencies+agency_monthly+historical_agency+historical_agency_clearance+historical_agency_crime+historical_agency_population::historical_agency(agency,ori,state,type)|historical_agency_clearance(assault_clr,burglary_clr,motor_vehicle_theft_clr,murder_clr,ori,property_clr,rape_clr,robbery_clr,theft_clr,violent_clr,year)|historical_agency_crime(assault,burglary,motor_vehicle_theft,murder,ori,property,rape,robbery,theft,violent,year)|historical_agency_population(ori,population,year)",
    artifact: "crime_data",
    database: PROVIDERS["crime_data"],
    preparationTables: [
      { name: "agencies", requiredColumns: [], minRows: 0 },
      { name: "agency_monthly", requiredColumns: [], minRows: 0 },
    ],
    tables: [
      { name: "historical_agency", requiredColumns: ["agency","ori","state","type"], minRows: 1 },
      { name: "historical_agency_clearance", requiredColumns: ["assault_clr","burglary_clr","motor_vehicle_theft_clr","murder_clr","ori","property_clr","rape_clr","robbery_clr","theft_clr","violent_clr","year"], minRows: 1 },
      { name: "historical_agency_crime", requiredColumns: ["assault","burglary","motor_vehicle_theft","murder","ori","property","rape","robbery","theft","violent","year"], minRows: 1 },
      { name: "historical_agency_population", requiredColumns: ["ori","population","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_CRIME_DATA_86002873",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "crime_data::agencies::agencies(agency,national_sample,ori)",
    artifact: "crime_data",
    database: PROVIDERS["crime_data"],
    preparationTables: [],
    tables: [
      { name: "agencies", requiredColumns: ["agency","national_sample","ori"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_CRIME_DATA_D5ABAC76",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "crime_data::agencies::agencies(national_sample,state)",
    artifact: "crime_data",
    database: PROVIDERS["crime_data"],
    preparationTables: [],
    tables: [
      { name: "agencies", requiredColumns: ["national_sample","state"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_CRIME_DATA_46140621",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "crime_data::agency_county_crosswalk+historical_agency::agency_county_crosswalk(county_fips,county_key,ori,ori9,state)|historical_agency(agency,ori)",
    artifact: "crime_data",
    database: PROVIDERS["crime_data"],
    preparationTables: [],
    tables: [
      { name: "agency_county_crosswalk", requiredColumns: ["county_fips","county_key","ori","ori9","state"], minRows: 1 },
      { name: "historical_agency", requiredColumns: ["agency","ori"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_CRIME_DATA_DAB6C4DC",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "crime_data::agency_monthly+agency_population+sample_agencies::agency_monthly(count,offense,ori,year)|agency_population(ori,population,year)|sample_agencies(ori,state)",
    artifact: "crime_data",
    database: PROVIDERS["crime_data"],
    preparationTables: [],
    tables: [
      { name: "agency_monthly", requiredColumns: ["count","offense","ori","year"], minRows: 1 },
      { name: "agency_population", requiredColumns: ["ori","population","year"], minRows: 1 },
      { name: "sample_agencies", requiredColumns: ["ori","state"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_CRIME_DATA_DACFADC6",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "crime_data::agency_monthly+agency_population::agency_monthly(agency,count,offense,ori,state,type,year)|agency_population(ori,year)",
    artifact: "crime_data",
    database: PROVIDERS["crime_data"],
    preparationTables: [],
    tables: [
      { name: "agency_monthly", requiredColumns: ["agency","count","offense","ori","state","type","year"], minRows: 1 },
      { name: "agency_population", requiredColumns: ["ori","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_CRIME_DATA_3D59EECB",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "crime_data::agency_monthly::agency_monthly(year)",
    artifact: "crime_data",
    database: PROVIDERS["crime_data"],
    preparationTables: [],
    tables: [
      { name: "agency_monthly", requiredColumns: ["year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_CRIME_DATA_650892B1",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "crime_data::historical_agency+historical_agency_clearance+historical_agency_crime+historical_staffing::historical_agency(agency,ori,state,type)|historical_agency_clearance(ori,year)|historical_agency_crime(ori,year)|historical_staffing(ori,year)",
    artifact: "crime_data",
    database: PROVIDERS["crime_data"],
    preparationTables: [],
    tables: [
      { name: "historical_agency", requiredColumns: ["agency","ori","state","type"], minRows: 1 },
      { name: "historical_agency_clearance", requiredColumns: ["ori","year"], minRows: 1 },
      { name: "historical_agency_crime", requiredColumns: ["ori","year"], minRows: 1 },
      { name: "historical_staffing", requiredColumns: ["ori","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_CRIME_DATA_FD384D4F",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "crime_data::historical_agency+historical_agency_crime+historical_agency_population::historical_agency(agency,ori,state,type)|historical_agency_crime(murder,ori,year)|historical_agency_population(ori,year)",
    artifact: "crime_data",
    database: PROVIDERS["crime_data"],
    preparationTables: [],
    tables: [
      { name: "historical_agency", requiredColumns: ["agency","ori","state","type"], minRows: 1 },
      { name: "historical_agency_crime", requiredColumns: ["murder","ori","year"], minRows: 1 },
      { name: "historical_agency_population", requiredColumns: ["ori","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_CRIME_DATA_444728E8",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "crime_data::historical_agency+historical_agency_crime::historical_agency(agency,ori,state,type)|historical_agency_crime(ori,violent,year)",
    artifact: "crime_data",
    database: PROVIDERS["crime_data"],
    preparationTables: [],
    tables: [
      { name: "historical_agency", requiredColumns: ["agency","ori","state","type"], minRows: 1 },
      { name: "historical_agency_crime", requiredColumns: ["ori","violent","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_CRIME_DATA_DDB846E2",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "crime_data::historical_agency::historical_agency(agency,ori)",
    artifact: "crime_data",
    database: PROVIDERS["crime_data"],
    preparationTables: [],
    tables: [
      { name: "historical_agency", requiredColumns: ["agency","ori"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_CRIME_DATA_0D468E42",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "crime_data::historical_agency_crime+historical_state_national::historical_agency_crime(year)|historical_state_national(year)",
    artifact: "crime_data",
    database: PROVIDERS["crime_data"],
    preparationTables: [],
    tables: [
      { name: "historical_agency_crime", requiredColumns: ["year"], minRows: 1 },
      { name: "historical_state_national", requiredColumns: ["year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_CRIME_DATA_3E9D80CE",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "crime_data::historical_state_national::historical_state_national(aggravated_assault,aggravated_assault_rate,auto_theft,auto_theft_rate,burglary,burglary_rate,murder,murder_rate,population,rape,rape_rate,robbery,robbery_rate,state,theft,theft_rate,year)",
    artifact: "crime_data",
    database: PROVIDERS["crime_data"],
    preparationTables: [],
    tables: [
      { name: "historical_state_national", requiredColumns: ["aggravated_assault","aggravated_assault_rate","auto_theft","auto_theft_rate","burglary","burglary_rate","murder","murder_rate","population","rape","rape_rate","robbery","robbery_rate","state","theft","theft_rate","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_CRIME_DATA_C18771F1",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "crime_data::historical_state_national::historical_state_national(state)",
    artifact: "crime_data",
    database: PROVIDERS["crime_data"],
    preparationTables: [],
    tables: [
      { name: "historical_state_national", requiredColumns: ["state"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_CRIME_DATA_17087F69",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "hate_crime::agency_county_crosswalk+hate_crime_incidents::agency_county_crosswalk(county_fips,county_key,ori,ori9,state)|hate_crime_incidents(ori)",
    artifact: "hate_crime",
    database: PROVIDERS["hate_crime"],
    preparationTables: [],
    tables: [
      { name: "agency_county_crosswalk", requiredColumns: ["county_fips","county_key","ori","ori9","state"], minRows: 1 },
      { name: "hate_crime_incidents", requiredColumns: ["ori"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_HATE_CRIME_162DA0E1",
    policy: {
          "coverage": null,
          "integrity": null,
          "availability": {
                "kind": "conditional",
                "condition": "Requires agency_county_crosswalk in the hate_crime artifact. The table is absent from production hate_crime.db as of 2026-08-13, so this capability is unavailable in production while being structurally sound. Conditionally unavailable is not unhealthy; the builder decides at runtime."
          },
          "receiptOwner": null,
          "evidence": "Both artifact states are exercised by this suite: with the crosswalk absent, entitySql (lib/metadata-coverage.ts:457) takes the SQL-less exit and the case hate_crime:metadata-agency-directory-county records terminalKind=unavailable, sealing no capability; with the crosswalk present, the same operation reaches this contract. coverage, integrity and receiptOwner remain unauthored: a directory count has no year dimension to base coverage on, no integrity rule has been decided for the crosswalk, and receipt ownership is Stage 2B.",
          "origin": "legacy"
    },
    authorizationEligible: false,
  },
  {
    capabilityId: "hate_crime::hate_crime_incidents::hate_crime_incidents(ori)",
    artifact: "hate_crime",
    database: PROVIDERS["hate_crime"],
    preparationTables: [],
    tables: [
      { name: "hate_crime_incidents", requiredColumns: ["ori"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_HATE_CRIME_6180AF3F",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "hate_crime::hate_crime_participation::hate_crime_participation(reporting_agencies,state)",
    artifact: "hate_crime",
    database: PROVIDERS["hate_crime"],
    preparationTables: [],
    tables: [
      { name: "hate_crime_participation", requiredColumns: ["reporting_agencies","state"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_HATE_CRIME_B2D238C0",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "hate_crime::hate_crime_participation::hate_crime_participation(year)",
    artifact: "hate_crime",
    database: PROVIDERS["hate_crime"],
    preparationTables: [],
    tables: [
      { name: "hate_crime_participation", requiredColumns: ["year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_HATE_CRIME_59221F57",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::agencies+agency_county_crosswalk+summary_arrestee_demographics::agencies(ori,year)|agency_county_crosswalk(county_key,ori,ori9,state)|summary_arrestee_demographics(arrestee_count,ori,race,ucr_arrest_offense,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "agencies", requiredColumns: ["ori","year"], minRows: 1 },
      { name: "agency_county_crosswalk", requiredColumns: ["county_key","ori","ori9","state"], minRows: 1 },
      { name: "summary_arrestee_demographics", requiredColumns: ["arrestee_count","ori","race","ucr_arrest_offense","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_37D598AF",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::agencies+agency_county_crosswalk+summary_offender_demographics::agencies(ori,year)|agency_county_crosswalk(county_key,ori,ori9,state)|summary_offender_demographics(offender_count,ori,race,ucr_offense_code,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "agencies", requiredColumns: ["ori","year"], minRows: 1 },
      { name: "agency_county_crosswalk", requiredColumns: ["county_key","ori","ori9","state"], minRows: 1 },
      { name: "summary_offender_demographics", requiredColumns: ["offender_count","ori","race","ucr_offense_code","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_455CE9B2",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::agencies+agency_county_crosswalk+summary_victim_city_monthly::agencies(ori,year)|agency_county_crosswalk(county_key,ori,ori9,state)|summary_victim_city_monthly(ori,ucr_offense_code,victim_count,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "agencies", requiredColumns: ["ori","year"], minRows: 1 },
      { name: "agency_county_crosswalk", requiredColumns: ["county_key","ori","ori9","state"], minRows: 1 },
      { name: "summary_victim_city_monthly", requiredColumns: ["ori","ucr_offense_code","victim_count","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_8A25856C",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::agencies+agency_county_crosswalk+summary_victim_demographics::agencies(ori,year)|agency_county_crosswalk(county_key,ori,ori9,state)|summary_victim_demographics(ori,race,ucr_offense_code,victim_count,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "agencies", requiredColumns: ["ori","year"], minRows: 1 },
      { name: "agency_county_crosswalk", requiredColumns: ["county_key","ori","ori9","state"], minRows: 1 },
      { name: "summary_victim_demographics", requiredColumns: ["ori","race","ucr_offense_code","victim_count","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_75CD65B8",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::agencies+agency_county_crosswalk::agencies(ori)|agency_county_crosswalk(county_fips,county_key,ori,ori9,state)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "agencies", requiredColumns: ["ori"], minRows: 1 },
      { name: "agency_county_crosswalk", requiredColumns: ["county_fips","county_key","ori","ori9","state"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_CE3E49D9",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::agencies+nibrs_agency_completeness+summary_city_monthly+summary_victim_city_monthly::agencies(ori,population,year)|nibrs_agency_completeness(months_reported,ori,year)|summary_city_monthly(month,offense_count,ori,ucr_offense_code,year)|summary_victim_city_monthly(ori,ucr_offense_code,victim_count,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "agencies", requiredColumns: ["ori","population","year"], minRows: 1 },
      { name: "nibrs_agency_completeness", requiredColumns: ["months_reported","ori","year"], minRows: 1 },
      { name: "summary_city_monthly", requiredColumns: ["month","offense_count","ori","ucr_offense_code","year"], minRows: 1 },
      { name: "summary_victim_city_monthly", requiredColumns: ["ori","ucr_offense_code","victim_count","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_1703CC39",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::agencies+nibrs_agency_completeness+summary_city_monthly+summary_victim_city_monthly::agencies(ori,population,year)|nibrs_agency_completeness(months_reported,ori,year)|summary_city_monthly(month,ori,year)|summary_victim_city_monthly(ori,ucr_offense_code,victim_count,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "agencies", requiredColumns: ["ori","population","year"], minRows: 1 },
      { name: "nibrs_agency_completeness", requiredColumns: ["months_reported","ori","year"], minRows: 1 },
      { name: "summary_city_monthly", requiredColumns: ["month","ori","year"], minRows: 1 },
      { name: "summary_victim_city_monthly", requiredColumns: ["ori","ucr_offense_code","victim_count","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_393A2E53",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::agencies+nibrs_agency_completeness+summary_city_monthly::nibrs_agency_completeness(months_reported,ori,year)|summary_city_monthly(month,offense_count,ori,ucr_offense_code,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [
      { name: "agencies", requiredColumns: [], minRows: 0 },
    ],
    tables: [
      { name: "nibrs_agency_completeness", requiredColumns: ["months_reported","ori","year"], minRows: 1 },
      { name: "summary_city_monthly", requiredColumns: ["month","offense_count","ori","ucr_offense_code","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_DCB88465",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::agencies+summary_clearance_type::agencies(agency_type,city,ori,population,state,year)|summary_clearance_type(cleared_by_arrest,cleared_exceptional,ori,total_offenses,ucr_offense_code,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "agencies", requiredColumns: ["agency_type","city","ori","population","state","year"], minRows: 1 },
      { name: "summary_clearance_type", requiredColumns: ["cleared_by_arrest","cleared_exceptional","ori","total_offenses","ucr_offense_code","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_88FD3545",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::agencies::agencies(ori)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "agencies", requiredColumns: ["ori"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_E9B525A7",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::agencies::agencies(state)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "agencies", requiredColumns: ["state"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_7DD054A1",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::agencies::agencies(year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "agencies", requiredColumns: ["year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_6192F2D6",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::nibrs_agency_completeness+summary_arrestee_demographics::nibrs_agency_completeness(months_reported,ori,year)|summary_arrestee_demographics(arrestee_count,ori,race,ucr_arrest_offense,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "nibrs_agency_completeness", requiredColumns: ["months_reported","ori","year"], minRows: 1 },
      { name: "summary_arrestee_demographics", requiredColumns: ["arrestee_count","ori","race","ucr_arrest_offense","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_FE22F5C6",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::nibrs_agency_completeness+summary_offender_demographics::nibrs_agency_completeness(months_reported,ori,year)|summary_offender_demographics(offender_count,ori,race,ucr_offense_code,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "nibrs_agency_completeness", requiredColumns: ["months_reported","ori","year"], minRows: 1 },
      { name: "summary_offender_demographics", requiredColumns: ["offender_count","ori","race","ucr_offense_code","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_2ABC75E2",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::nibrs_agency_completeness+summary_victim_city_monthly::nibrs_agency_completeness(months_reported,ori,year)|summary_victim_city_monthly(month,ori,ucr_offense_code,victim_count,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "nibrs_agency_completeness", requiredColumns: ["months_reported","ori","year"], minRows: 1 },
      { name: "summary_victim_city_monthly", requiredColumns: ["month","ori","ucr_offense_code","victim_count","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_6C2F129B",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::nibrs_agency_completeness+summary_victim_demographics::nibrs_agency_completeness(months_reported,ori,year)|summary_victim_demographics(ori,race,ucr_offense_code,victim_count,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "nibrs_agency_completeness", requiredColumns: ["months_reported","ori","year"], minRows: 1 },
      { name: "summary_victim_demographics", requiredColumns: ["ori","race","ucr_offense_code","victim_count","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_B2022146",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::nibrs_consistent_reporters+summary_arrestee_demographics::nibrs_consistent_reporters(end_year,ori,start_year)|summary_arrestee_demographics(arrestee_count,ori,race,ucr_arrest_offense,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "nibrs_consistent_reporters", requiredColumns: ["end_year","ori","start_year"], minRows: 1 },
      { name: "summary_arrestee_demographics", requiredColumns: ["arrestee_count","ori","race","ucr_arrest_offense","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_4395E4E9",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::nibrs_consistent_reporters+summary_offender_demographics::nibrs_consistent_reporters(end_year,ori,start_year)|summary_offender_demographics(offender_count,ori,race,ucr_offense_code,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "nibrs_consistent_reporters", requiredColumns: ["end_year","ori","start_year"], minRows: 1 },
      { name: "summary_offender_demographics", requiredColumns: ["offender_count","ori","race","ucr_offense_code","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_23B2C145",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::nibrs_consistent_reporters+summary_victim_city_monthly::nibrs_consistent_reporters(end_year,ori,start_year)|summary_victim_city_monthly(ori,ucr_offense_code,victim_count,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "nibrs_consistent_reporters", requiredColumns: ["end_year","ori","start_year"], minRows: 1 },
      { name: "summary_victim_city_monthly", requiredColumns: ["ori","ucr_offense_code","victim_count","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_0038475A",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::nibrs_consistent_reporters+summary_victim_demographics::nibrs_consistent_reporters(end_year,ori,start_year)|summary_victim_demographics(ori,race,ucr_offense_code,victim_count,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "nibrs_consistent_reporters", requiredColumns: ["end_year","ori","start_year"], minRows: 1 },
      { name: "summary_victim_demographics", requiredColumns: ["ori","race","ucr_offense_code","victim_count","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_01DA4F40",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::rollup.national_summary_arrestee_demographics::rollup.national_summary_arrestee_demographics(age_group,arrestee_count,race,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "rollup.national_summary_arrestee_demographics", requiredColumns: ["age_group","arrestee_count","race","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_6DD8A434",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::rollup.national_summary_arrestee_demographics::rollup.national_summary_arrestee_demographics(arrestee_count,ucr_arrest_offense,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "rollup.national_summary_arrestee_demographics", requiredColumns: ["arrestee_count","ucr_arrest_offense","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_E58BBE84",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::rollup.state_summary_arrestee_demographics::rollup.state_summary_arrestee_demographics(age_group,arrestee_count,race,state,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "rollup.state_summary_arrestee_demographics", requiredColumns: ["age_group","arrestee_count","race","state","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_9218E874",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::summary_clearance_detail::summary_clearance_detail(cleared_A,cleared_B,cleared_C,cleared_D,cleared_E,cleared_by_arrest,state,total_offenses,ucr_offense_code,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "summary_clearance_detail", requiredColumns: ["cleared_A","cleared_B","cleared_C","cleared_D","cleared_E","cleared_by_arrest","state","total_offenses","ucr_offense_code","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_94042681",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::summary_clearance_type::summary_clearance_type(cleared_by_arrest,cleared_exceptional,ori,total_offenses,ucr_offense_code,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "summary_clearance_type", requiredColumns: ["cleared_by_arrest","cleared_exceptional","ori","total_offenses","ucr_offense_code","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_C439D6E1",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::summary_juvenile_offender_incidents::summary_juvenile_offender_incidents(incident_count,offense_scope,state,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "summary_juvenile_offender_incidents", requiredColumns: ["incident_count","offense_scope","state","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_942E6E86",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "nibrs::summary_victim_circumstance+summary_victim_state_monthly::summary_victim_circumstance(circumstance_code,state,ucr_offense_code,victim_count,year)|summary_victim_state_monthly(state,ucr_offense_code,victim_count,year)",
    artifact: "nibrs",
    database: PROVIDERS["nibrs"],
    preparationTables: [],
    tables: [
      { name: "summary_victim_circumstance", requiredColumns: ["circumstance_code","state","ucr_offense_code","victim_count","year"], minRows: 1 },
      { name: "summary_victim_state_monthly", requiredColumns: ["state","ucr_offense_code","victim_count","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_NIBRS_1F22C7CF",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "shr::agency_county_crosswalk+incidents::agency_county_crosswalk(county_fips,county_key,ori,state)|incidents(ori)",
    artifact: "shr",
    database: PROVIDERS["shr"],
    preparationTables: [],
    tables: [
      { name: "agency_county_crosswalk", requiredColumns: ["county_fips","county_key","ori","state"], minRows: 1 },
      { name: "incidents", requiredColumns: ["ori"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_SHR_26605B46",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "shr::incidents+shr_agency_alias+shr_agency_identity+victims::incidents(homicide_type,id,ori,weapon_group,year)|victims(incident_id)",
    artifact: "shr",
    database: PROVIDERS["shr"],
    preparationTables: [
      { name: "shr_agency_alias", requiredColumns: [], minRows: 0 },
      { name: "shr_agency_identity", requiredColumns: [], minRows: 0 },
    ],
    tables: [
      { name: "incidents", requiredColumns: ["homicide_type","id","ori","weapon_group","year"], minRows: 1 },
      { name: "victims", requiredColumns: ["incident_id"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_SHR_E35007D9",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "shr::incidents::incidents(ori)",
    artifact: "shr",
    database: PROVIDERS["shr"],
    preparationTables: [],
    tables: [
      { name: "incidents", requiredColumns: ["ori"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_SHR_1E4E6C67",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "shr::incidents::incidents(state)",
    artifact: "shr",
    database: PROVIDERS["shr"],
    preparationTables: [],
    tables: [
      { name: "incidents", requiredColumns: ["state"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_SHR_F4DEE05F",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "shr::incidents::incidents(year)",
    artifact: "shr",
    database: PROVIDERS["shr"],
    preparationTables: [],
    tables: [
      { name: "incidents", requiredColumns: ["year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_SHR_81AD8F31",
    policy: null,
    authorizationEligible: false,
  },
  {
    capabilityId: "crime_data::national_monthly::sweep",
    artifact: "crime_data",
    database: PROVIDERS["crime_data"],
    preparationTables: [],
    tables: [
      { name: "national_monthly", requiredColumns: ["agency_count","count","month","offense","year"], minRows: 1 },
    ],
    dependencies: [],
    semanticDependencies: [],
    flagKey: "PROOF_CAPABILITY_CRIME_DATA_9AF903DD",
    policy: null,
    authorizationEligible: false,
  },
];

const BY_ID = new Map(CAPABILITY_INVENTORY.map((spec) => [spec.capabilityId, spec]));

/**
 * Look a capability up by its structural id.
 *
 * There is no `specFor(source, label)` overload on purpose: a short per-source label is not
 * identity, because two capabilities can share a table set.
 */
export function specFor(capabilityId: string): CapabilitySpec | null {
  return BY_ID.get(capabilityId) ?? null;
}
