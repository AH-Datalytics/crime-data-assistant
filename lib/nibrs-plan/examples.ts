/**
 * Plans for the hand-traced correctness cases (scripts/fixtures/nibrs-correctness/CASES.md), the reader cases G1-G6,
 * and every form of today's typed specs (lib/nibrs-question-types.ts N1-N7). They are the reader's target output; the
 * compiler must turn each into the expected answer. scripts/test-nibrs-plan-language.ts checks them.
 */
import type { Coverage, Grouping, NibrsPlan, PartRef, ReaderOutcome } from "./plan";
import { PLAN_VERSION } from "./plan";

export const SEMANTIC_VERSION = "nibrs-semantic/0-draft";
const ALL: Coverage = { cohort: "all_reporting", unknownMonths: "show_unknown", filteredZero: "requires_evidence" };
const SAME: Coverage = { ...ALL, cohort: "same_agencies" };
const by = (dimension: string, extra: Partial<Grouping> = {}): Grouping => ({ dimension, unknown: "visible", absent: "show", ...extra });
const base = { version: PLAN_VERSION, semanticVersion: SEMANTIC_VERSION, timeBasis: "incident_date" as const, transforms: [], filters: [], defaults: [], bindings: [] };
const year = (y: number) => ({ kind: "absolute" as const, from: `${y}-01`, to: `${y}-12` });

const HOUSTON = { kind: "agency" as const, ori: "TXHPD0000", label: "Houston Police Department, TX" };
const MEMPHIS = { kind: "agency" as const, ori: "TNMPD0000", label: "Memphis Police Department, TN" };
const BALTIMORE = { kind: "agency" as const, ori: "MDBPD0000", label: "Baltimore Police Department, MD" };
const STOLEN_FIREARM = {
  kind: "exists" as const, scope: "incident", entity: "property", attribution: "incident_level_only" as const,
  where: [{ kind: "attribute" as const, dimension: "property.loss_type", op: "in" as const, values: ["7"] },
          { kind: "attribute" as const, dimension: "property.description", op: "in" as const, values: ["13"] }],
};

/* ------------------------------------------------------------------ the correctness cases ------------------------- */

/** N1 (a): each month's own denominator; unknown race and sex visible. */
export const N1: NibrsPlan = {
  ...base,
  question: "What share of murder victims were of each race and sex, per month, in Houston since 2018?",
  geography: { places: [HOUSTON], combine: "separate" },
  period: { kind: "since", from: "2018-01" },
  measures: [{ id: "victims.murder", unit: "victim", as: "murder_victims" }],
  groupings: [by("time.month"), by("victim.race"), by("victim.sex")],
  statistics: [{ kind: "count", as: "victims", measure: "murder_victims" }, { kind: "share", as: "share_of_month", measure: "murder_victims", within: ["time.month"] }],
  coverage: ALL,
};

/** N2 (b): a scoped existence filter over property, attributed to the incident only. */
export const N2: NibrsPlan = {
  ...base,
  question: "Thefts from motor vehicles where a firearm was stolen, per month, in Memphis in 2024",
  geography: { places: [MEMPHIS], combine: "separate" },
  period: year(2024),
  measures: [{ id: "offenses.theft_from_motor_vehicle", unit: "offense", as: "thefts_from_motor_vehicles" }],
  filters: [STOLEN_FIREARM],
  groupings: [by("time.month")],
  statistics: [{ kind: "count", as: "count", measure: "thefts_from_motor_vehicles" }],
  coverage: ALL,
};

const p = (concept: string, value: string, text: string, span: [number, number]): PartRef => ({ concept, value, text, span, clause: 0, inherited: false });
export const N3_PARTS: PartRef[] = [
  p("measure", "motor_vehicle_theft", "Car thefts", [0, 10]),
  p("place", "city:Baltimore:MD", "Baltimore", [14, 23]),
  p("grain", "month", "by month", [24, 32]),
  p("period", "monthrange:2022-01:2026-06", "January 2022 to June 2026", [34, 59]),
];

/** N3 (c): a month range across five calendar years, with its request accounting. */
export const N3: NibrsPlan = {
  ...base,
  question: "Car thefts in Baltimore by month, January 2022 to June 2026",
  geography: { places: [BALTIMORE], combine: "separate" },
  period: { kind: "absolute", from: "2022-01", to: "2026-06" },
  measures: [{ id: "offenses.motor_vehicle_theft", unit: "offense", as: "motor_vehicle_thefts" }],
  groupings: [by("time.month")],
  statistics: [{ kind: "count", as: "count", measure: "motor_vehicle_thefts" }],
  coverage: ALL,
  defaults: [{ path: "measures[0]", value: "offenses.motor_vehicle_theft", reason: "\"car theft\" reads as motor vehicle theft, labelled as such" }],
  bindings: [
    { part: N3_PARTS[0], path: "measures[0]" }, { part: N3_PARTS[1], path: "geography.places[0]" },
    { part: N3_PARTS[2], path: "groupings[0]" }, { part: N3_PARTS[3], path: "period" },
  ],
};

const carjacking = { id: "incidents.carjacking", unit: "incident" as const, as: "carjackings" };
/** N4 (d): the frozen release questions. H1's default is the release-level calendar rule, declared. */
export const H1: NibrsPlan = {
  ...base,
  question: "carjacking per month in Memphis",
  geography: { places: [MEMPHIS], combine: "separate" },
  period: { kind: "latest_calendar_year_in_release" },
  measures: [carjacking],
  groupings: [by("time.month")],
  statistics: [{ kind: "count", as: "count", measure: "carjackings" }],
  coverage: ALL,
  defaults: [{ path: "period", value: "latest_calendar_year_in_release", reason: "no period named: a monthly series covers the latest calendar year whose December the release holds (today's rule)" }],
};
export const H2: NibrsPlan = { ...H1, question: "carjackings in Memphis in 2025", period: year(2025), groupings: [], defaults: [] };
export const H3: NibrsPlan = { ...H1, question: "carjackings per year in Memphis from 2020 to 2025", period: { kind: "absolute", from: "2020-01", to: "2025-12" }, groupings: [by("time.year")], defaults: [] };

/** Z: an ordinary plan; months without evidence come back UNKNOWN from the compiler. */
export const Z: NibrsPlan = {
  ...N1, question: "Justifiable homicides per month in Houston since 2018",
  measures: [{ id: "offenses.justifiable_homicide", unit: "offense", as: "justifiable_homicides" }],
  groupings: [by("time.month")], statistics: [{ kind: "count", as: "count", measure: "justifiable_homicides" }],
};

/** D: the three denominator scopes are three `within` choices over one grouped count. */
const dBase: NibrsPlan = {
  ...base,
  question: "Share of Houston murder victims by sex, May 2021",
  geography: { places: [HOUSTON], combine: "separate" },
  period: { kind: "absolute", from: "2021-05", to: "2021-05" },
  measures: [{ id: "victims.murder", unit: "victim", as: "murder_victims" }],
  groupings: [by("victim.sex")],
  statistics: [{ kind: "share", as: "share", measure: "murder_victims", within: [] }],
  coverage: ALL,
};
export const D_WITHIN_MONTH = dBase;
export const D_WITHIN_PERIOD: NibrsPlan = { ...dBase, period: year(2021), groupings: [by("time.month"), by("victim.sex")] };
export const D_WITHIN_RACE: NibrsPlan = { ...dBase, groupings: [by("victim.race"), by("victim.sex")], statistics: [{ kind: "share", as: "share", measure: "murder_victims", within: ["victim.race"] }] };

/** R: count and rate; the rate's evidence-complete eligibility is fixed, so 2018 and (for now) 2019 come back unavailable. */
export const R: NibrsPlan = {
  ...base,
  question: "Murder victim rate per 100,000 in Houston, 2018 and 2019",
  geography: { places: [HOUSTON], combine: "separate" },
  period: { kind: "absolute", from: "2018-01", to: "2019-12" },
  measures: [{ id: "victims.murder", unit: "victim", as: "murder_victims" }],
  groupings: [by("time.year")],
  statistics: [{ kind: "count", as: "count", measure: "murder_victims" }, { kind: "rate", as: "rate", measure: "murder_victims", per: 100000 }],
  coverage: ALL,
};

/* S1-S5 over the synthetic state ZZ (fixtures/nibrs-correctness/synthetic). */
const ZZ = { kind: "state" as const, code: "ZZ" };
const q1 = { kind: "absolute" as const, from: "2025-01", to: "2025-03" };
export const S1: NibrsPlan = {
  ...base, question: "Murder victims by agency and month in ZZ, January-March 2025",
  geography: { places: [ZZ], combine: "separate" }, period: q1,
  measures: [{ id: "victims.murder", unit: "victim", as: "murder_victims" }, { id: "victims.murder", unit: "victim", as: "female_murder_victims", filters: [{ kind: "attribute", dimension: "victim.sex", op: "in", values: ["F"] }] }],
  groupings: [by("geo.agency"), by("time.month")],
  statistics: [{ kind: "count", as: "victims", measure: "murder_victims" }, { kind: "count", as: "female_victims", measure: "female_murder_victims" }],
  coverage: ALL,
};
export const S2: NibrsPlan = { ...S1, question: "Murder victims per month in ZZ, January-March 2025", measures: [S1.measures[0]], groupings: [by("time.month")], statistics: [S1.statistics[0]] };
export const S3: NibrsPlan = {
  ...S2, question: "Change in murder victims in ZZ from January to March 2025, same agencies", groupings: [],
  transforms: [{ kind: "period_comparison", of: ["victims"], earlier: { kind: "absolute", from: "2025-01", to: "2025-01" }, later: { kind: "absolute", from: "2025-03", to: "2025-03" }, outputs: ["earlier", "later", "change"] }],
  coverage: SAME,
};
export const S4: NibrsPlan = {
  ...S2, question: "Murder victim rate per 100,000 in ZZ and by agency, January-March 2025", groupings: [by("geo.agency")],
  statistics: [{ kind: "count", as: "victims", measure: "murder_victims" }, { kind: "rate", as: "rate", measure: "murder_victims", per: 100000 }],
};
export const S5: NibrsPlan = {
  ...S2, question: "Female murder victims per 100,000 residents in City A, January-March 2025",
  geography: { places: [{ kind: "agency", ori: "ZZ0000A00", label: "City A" }], combine: "separate" },
  measures: [{ id: "victims.murder", unit: "victim", as: "female_murder_victims", filters: [{ kind: "attribute", dimension: "victim.sex", op: "in", values: ["F"] }] }],
  groupings: [], statistics: [{ kind: "rate", as: "rate", measure: "female_murder_victims", per: 100000 }],
};

/* ------------------------------------------------------------------ today's typed forms ----------------------------- */

/** SeriesSpec with several measures in different units: separate columns, never added. */
export const MULTI_MEASURE: NibrsPlan = {
  ...base, question: "Robberies, robbery victims and robbery arrests in Memphis in 2024",
  geography: { places: [MEMPHIS], combine: "separate" }, period: year(2024),
  measures: [{ id: "offenses.robbery", unit: "offense", as: "robberies" }, { id: "victims.robbery", unit: "victim", as: "robbery_victims" }, { id: "arrests.robbery", unit: "arrest", as: "robbery_arrests" }],
  groupings: [],
  statistics: [{ kind: "count", as: "c_robberies", measure: "robberies" }, { kind: "count", as: "c_victims", measure: "robbery_victims" }, { kind: "count", as: "c_arrests", measure: "robbery_arrests" }],
  coverage: ALL,
};

/** SeriesSpec over named places side by side (N2 of today), each its own row. */
export const NAMED_PLACES: NibrsPlan = {
  ...base, question: "Murders in Houston and Memphis in 2024",
  geography: { places: [HOUSTON, MEMPHIS], combine: "separate" }, period: year(2024),
  measures: [{ id: "victims.murder", unit: "victim", as: "murder_victims" }],
  groupings: [by("geo.place")], statistics: [{ kind: "count", as: "count", measure: "murder_victims" }], coverage: ALL,
};

/** SeriesSpec with noncontiguous years ("2019 and 2024"). */
export const SEPARATE_YEARS: NibrsPlan = { ...NAMED_PLACES, question: "Murders in Houston in 2019 and 2024", geography: { places: [HOUSTON], combine: "separate" }, period: { kind: "years", years: [2019, 2024] }, groupings: [by("time.year")] };

/** Clearance rate (today's N5 series): cleared offenses over offenses, both unit offense. */
export const CLEARANCE_RATE: NibrsPlan = {
  ...base, question: "Murder clearance rate in Memphis in 2024",
  geography: { places: [MEMPHIS], combine: "separate" }, period: year(2024),
  measures: [{ id: "offenses.murder", unit: "offense", as: "murders" }, { id: "offenses.murder_cleared", unit: "offense", as: "murders_cleared" }],
  groupings: [], statistics: [{ kind: "ratio", as: "clearance_rate", numerator: "murders_cleared", denominator: "murders" }], coverage: ALL,
};

/** ShareSpec, denominator offenses: "what share of rapes were cleared because prosecution was declined". */
export const SUBSET_SHARE: NibrsPlan = {
  ...CLEARANCE_RATE, question: "What share of rapes in Memphis in 2024 were cleared because prosecution was declined?",
  measures: [{ id: "offenses.rape", unit: "offense", as: "rapes" }, { id: "offenses.rape_cleared", unit: "offense", as: "rapes_cleared_declined", filters: [{ kind: "attribute", dimension: "offense.exceptional_clearance", op: "in", values: ["B"] }] }],
  statistics: [{ kind: "ratio", as: "share", numerator: "rapes_cleared_declined", denominator: "rapes" }],
};

/** ShareSpec, denominator clearances: "what share of rape clearances were prosecution declined". */
export const CLEARANCE_SHARE: NibrsPlan = {
  ...SUBSET_SHARE, question: "What share of rape clearances in Memphis in 2024 were prosecution declined?",
  measures: [{ id: "offenses.rape_cleared", unit: "offense", as: "rapes_cleared" }, { id: "offenses.rape_cleared", unit: "offense", as: "rapes_cleared_declined", filters: [{ kind: "attribute", dimension: "offense.exceptional_clearance", op: "in", values: ["B"] }] }],
  statistics: [{ kind: "ratio", as: "share", numerator: "rapes_cleared_declined", denominator: "rapes_cleared" }],
};

/** BreakdownSpec on clearance type (today's N5 breakdown), with shares of all clearances. */
export const CLEARANCE_BREAKDOWN: NibrsPlan = {
  ...CLEARANCE_SHARE, question: "Virginia murder clearances by exception type in 2025",
  geography: { places: [{ kind: "state", code: "VA" }], combine: "separate" }, period: year(2025),
  measures: [{ id: "offenses.murder_cleared", unit: "offense", as: "murders_cleared", filters: [{ kind: "attribute", dimension: "offense.exceptional_clearance", op: "in", values: ["A", "B", "C", "D", "E"] }] }],
  groupings: [by("offense.exceptional_clearance")],
  statistics: [{ kind: "count", as: "count", measure: "murders_cleared" }, { kind: "share", as: "share", measure: "murders_cleared", within: [] }],
};

/** BreakdownSpec by offender age (bins; unknown and special codes stay their own categories), by year. */
export const AGE_BREAKDOWN: NibrsPlan = {
  ...base, question: "Car thefts in Baltimore by offender age by year, 2022 to 2025",
  geography: { places: [BALTIMORE], combine: "separate" }, period: { kind: "absolute", from: "2022-01", to: "2025-12" },
  measures: [{ id: "offenders.motor_vehicle_theft", unit: "offender", as: "offenders" }],
  groupings: [by("time.year"), by("offender.age", { bins: [{ label: "under 18", from: 1, to: 17 }, { label: "18-24", from: 18, to: 24 }, { label: "25 and over", from: 25, to: 99 }] })],
  statistics: [{ kind: "count", as: "count", measure: "offenders" }, { kind: "share", as: "share_of_year", measure: "offenders", within: ["time.year"] }],
  coverage: ALL,
};

/** Group B arrests by arrest date (DUI is a Group B offense: arrest records only). */
export const GROUP_B_ARRESTS: NibrsPlan = {
  ...base, question: "DUI arrests per month in Memphis in 2024", timeBasis: "arrest_date",
  geography: { places: [MEMPHIS], combine: "separate" }, period: year(2024),
  measures: [{ id: "group_b_arrests.dui", unit: "group_b_arrest", as: "dui_arrests" }],
  groupings: [by("time.month")], statistics: [{ kind: "count", as: "count", measure: "dui_arrests" }], coverage: ALL,
};

/** Property value: total and average stolen value (today's total_value / average_value statistics). */
export const PROPERTY_VALUE: NibrsPlan = {
  ...base, question: "Total and average value of stolen vehicles in Baltimore in 2024",
  geography: { places: [BALTIMORE], combine: "separate" }, period: year(2024),
  measures: [
    { id: "property.stolen_value", unit: "dollars", as: "stolen_dollars", filters: [{ kind: "attribute", dimension: "property.description", op: "in", values: ["03"] }] },
    { id: "property.stolen_segments", unit: "property_segment", as: "stolen_segments", filters: [{ kind: "attribute", dimension: "property.description", op: "in", values: ["03"] }] },
  ],
  groupings: [],
  statistics: [{ kind: "count", as: "total_value", measure: "stolen_dollars" }, { kind: "ratio", as: "average_value", numerator: "stolen_dollars", denominator: "stolen_segments" }],
  coverage: ALL,
};

/** RankSpec: states by rate, every state ordered (no number given: limit null). */
export const RANKED_RATES: NibrsPlan = {
  ...base, question: "Rank states by murder rate in 2024",
  geography: { places: [{ kind: "national" }], combine: "separate" }, period: year(2024),
  measures: [{ id: "victims.murder", unit: "victim", as: "murder_victims" }],
  groupings: [by("geo.state")],
  statistics: [{ kind: "count", as: "count", measure: "murder_victims" }, { kind: "rate", as: "rate", measure: "murder_victims", per: 100000 }],
  transforms: [{ kind: "rank", by: "rate", direction: "top", per: [], limit: null }],
  coverage: ALL,
};

/** Top 5 cities of 250,000 or more each month: rank within each period over an agency set. */
export const TOP_N_PER_MONTH: NibrsPlan = {
  ...base, question: "Which 5 cities of 250,000 or more had the most motor vehicle thefts each month in 2025?",
  geography: { places: [{ kind: "agency_set", where: [{ field: "agency.population", op: ">=", value: 250000 }, { field: "agency.type", op: "in", value: ["city"] }], within: { kind: "national" } }], combine: "separate" },
  period: year(2025),
  measures: [{ id: "offenses.motor_vehicle_theft", unit: "offense", as: "motor_vehicle_thefts" }],
  groupings: [by("time.month"), by("geo.agency")],
  statistics: [{ kind: "count", as: "count", measure: "motor_vehicle_thefts" }],
  transforms: [{ kind: "rank", by: "count", direction: "top", per: ["time.month"], limit: 5 }],
  coverage: ALL,
};

/** Rolling 12-month national murders. */
export const ROLLING: NibrsPlan = {
  ...base, question: "Rolling 12-month murder victims nationally since 2021",
  geography: { places: [{ kind: "national" }], combine: "separate" }, period: { kind: "since", from: "2021-01" },
  measures: [{ id: "victims.murder", unit: "victim", as: "murder_victims" }],
  groupings: [by("time.month")], statistics: [{ kind: "count", as: "count", measure: "murder_victims" }],
  transforms: [{ kind: "rolling", of: ["count"], months: 12 }], coverage: ALL,
};

/** ChangeSpec in a same-agencies cohort. */
export const SAME_AGENCIES_CHANGE: NibrsPlan = {
  ...base, question: "How did aggravated assault victims change in Texas from 2023 to 2025, same agencies?",
  geography: { places: [{ kind: "state", code: "TX" }], combine: "separate" }, period: { kind: "absolute", from: "2023-01", to: "2025-12" },
  measures: [{ id: "victims.aggravated_assault", unit: "victim", as: "victims" }],
  groupings: [], statistics: [{ kind: "count", as: "count", measure: "victims" }],
  transforms: [{ kind: "period_comparison", of: ["count"], earlier: year(2023), later: year(2025), outputs: ["earlier", "later", "change", "pct_change"] }],
  coverage: SAME,
};

/** A 1:n grouping: murders by weapon, each weapon counted; shares use distinct offenses as the denominator. */
export const MULTI_VALUE_GROUPING: NibrsPlan = {
  ...base, question: "Murders by weapon in Houston in 2024",
  geography: { places: [HOUSTON], combine: "separate" }, period: year(2024),
  measures: [{ id: "offenses.murder", unit: "offense", as: "murders" }],
  groupings: [by("offense_weapon.weapon", { multiValue: "each_value" })],
  statistics: [{ kind: "count", as: "count", measure: "murders" }, { kind: "share", as: "share", measure: "murders", within: [] }],
  coverage: ALL,
};

/** Relationship x offender age: both read through the same victim-offender pair row, never a cross product. */
export const PAIRED_RELATIONSHIP: NibrsPlan = {
  ...base, question: "Murder victims by relationship to offender and offender age, Houston 2024",
  geography: { places: [HOUSTON], combine: "separate" }, period: year(2024),
  measures: [{ id: "victim_offender.murder", unit: "victim_offender", as: "pairs" }],
  groupings: [by("victim_offender.relationship"), by("victim_offender.offender_age", { bins: [{ label: "under 18", from: 1, to: 17 }, { label: "18 and over", from: 18, to: 99 }] })],
  statistics: [{ kind: "count", as: "count", measure: "pairs" }], coverage: ALL,
};

/** Two places combined into one total: the deduplicated union of their agencies. */
export const COMBINED_PLACES: NibrsPlan = {
  ...NAMED_PLACES, question: "Total murders in Maryland and Baltimore combined in 2024",
  geography: { places: [{ kind: "state", code: "MD" }, BALTIMORE], combine: "combined" }, groupings: [],
};

/* ------------------------------------------------------------------ reader outcomes G1-G6 -------------------------- */

const g = (concept: string, value: string | null, text: string, span: [number, number]): PartRef => ({ concept, value, text, span, clause: 0, inherited: false });
const G1_PLAN: NibrsPlan = { ...NAMED_PLACES, question: "murders in the US in 2024", geography: { places: [{ kind: "national" }], combine: "separate" }, groupings: [] };
export const G1: ReaderOutcome = { kind: "plan", plan: G1_PLAN };
/** ORIs here are illustrative placeholders, not looked up. */
export const G2: ReaderOutcome = {
  kind: "clarify", question: "Which Springfield?", parts: [g("place", null, "Springfield", [11, 22])],
  options: [
    { label: "Springfield Police Department, IL", plan: { ...G1_PLAN, question: "murders in Springfield, IL in 2024", geography: { places: [{ kind: "agency", ori: "IL0000000", label: "Springfield Police Department, IL" }], combine: "separate" } } },
    { label: "Springfield Police Department, MO", plan: { ...G1_PLAN, question: "murders in Springfield, MO in 2024", geography: { places: [{ kind: "agency", ori: "MO0000000", label: "Springfield Police Department, MO" }], combine: "separate" } } },
  ],
};
export const G3: ReaderOutcome = { kind: "plan", plan: { ...N2, question: "thefts from cars where a firearm was stolen in Memphis in 2024", groupings: [] } };
export const G4: ReaderOutcome = { kind: "plan", plan: N3 };
export const G5: ReaderOutcome = { kind: "limitation", reason: "not_recorded_in_nibrs", parts: [g("filter", null, "undocumented immigrants", [52, 75])], explanation: "NIBRS does not record immigration status." };
export const G6: ReaderOutcome = { kind: "limitation", reason: "explanation_requested", parts: [g("explain", null, "why", [0, 3])], explanation: "NIBRS records reported offenses, not their causes." };

export const EXAMPLES: Record<string, NibrsPlan> = {
  N1, N2, N3, H1, H2, H3, Z, D_WITHIN_MONTH, D_WITHIN_PERIOD, D_WITHIN_RACE, R, S1, S2, S3, S4, S5,
  MULTI_MEASURE, NAMED_PLACES, SEPARATE_YEARS, CLEARANCE_RATE, SUBSET_SHARE, CLEARANCE_SHARE, CLEARANCE_BREAKDOWN,
  AGE_BREAKDOWN, GROUP_B_ARRESTS, PROPERTY_VALUE, RANKED_RATES, TOP_N_PER_MONTH, ROLLING, SAME_AGENCIES_CHANGE,
  MULTI_VALUE_GROUPING, PAIRED_RELATIONSHIP, COMBINED_PLACES,
};
export const OUTCOMES: Record<string, ReaderOutcome> = { G1, G2, G3, G4, G5, G6 };
