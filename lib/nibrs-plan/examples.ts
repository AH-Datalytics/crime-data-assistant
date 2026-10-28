/**
 * Plans for the hand-traced correctness cases (scripts/fixtures/nibrs-correctness/CASES.md) and for each plan form
 * the spec requires. They are the reader's target output for those questions; the compiler must turn each into the
 * expected answer. Bindings are omitted here (they depend on the ledger's spans); scripts/test-nibrs-plan-language.ts
 * checks shape and semantics.
 */
import type { CoveragePolicy, Grouping, NibrsPlan } from "./plan";
import { PLAN_VERSION } from "./plan";

const SEM = "nibrs-semantic/0-draft";
const ALL: CoveragePolicy = { cohort: "all_reporting", unknownMonths: "show_unknown", filteredZero: "requires_evidence" };
const COMPLETE: CoveragePolicy = { ...ALL, cohort: "complete_periods" };
const by = (dimension: string, extra: Partial<Grouping> = {}): Grouping => ({ dimension, unknown: "visible", absent: "zero", ...extra });
const base = { version: PLAN_VERSION, semanticVersion: SEM, timeBasis: "incident_date" as const, transforms: [], filters: [], defaults: [], bindings: [] };

const HOUSTON = { kind: "agency" as const, ori: "TXHPD0000", label: "Houston Police Department, TX" };
const MEMPHIS = { kind: "agency" as const, ori: "TNMPD0000", label: "Memphis Police Department, TN" };
const BALTIMORE = { kind: "agency" as const, ori: "MDBPD0000", label: "Baltimore Police Department, MD" };

/** Case N1 (a): each month's own denominator. */
export const N1: NibrsPlan = {
  ...base,
  question: "What share of murder victims were of each race and sex, per month, in Houston since 2018?",
  geography: { places: [HOUSTON], combine: "separate" },
  period: { kind: "relative", anchor: "since", from: "2018-01" },
  measures: [{ id: "victims.murder", unit: "victim", as: "murder_victims" }],
  groupings: [by("time.month"), by("victim.race"), by("victim.sex")],
  statistics: [{ kind: "count", measure: "murder_victims" }, { kind: "share", measure: "murder_victims", partition: ["time.month"] }],
  coverage: ALL,
};

/** Case N2 (b): a scoped existence filter, never a join to property. */
export const N2: NibrsPlan = {
  ...base,
  question: "Thefts from motor vehicles where a firearm was stolen, per month, in Memphis in 2024",
  geography: { places: [MEMPHIS], combine: "separate" },
  period: { kind: "absolute", from: "2024-01", to: "2024-12" },
  measures: [{ id: "offenses.theft_from_motor_vehicle", unit: "offense", as: "thefts_from_motor_vehicles" }],
  filters: [{
    kind: "exists", scope: "incident", entity: "property", attribution: "incident_level_only",
    where: [{ kind: "attribute", dimension: "property.loss_type", op: "in", values: ["7"] },
            { kind: "attribute", dimension: "property.description", op: "in", values: ["13"] }],
  }],
  groupings: [by("time.month")],
  statistics: [{ kind: "count", measure: "thefts_from_motor_vehicles" }],
  coverage: ALL,
};

/** Case N3 (c): a month range across five calendar years. */
export const N3: NibrsPlan = {
  ...base,
  question: "Car thefts in Baltimore by month, January 2022 to June 2026",
  geography: { places: [BALTIMORE], combine: "separate" },
  period: { kind: "absolute", from: "2022-01", to: "2026-06" },
  measures: [{ id: "offenses.motor_vehicle_theft", unit: "offense", as: "motor_vehicle_thefts" }],
  groupings: [by("time.month")],
  statistics: [{ kind: "count", measure: "motor_vehicle_thefts" }],
  coverage: ALL,
  defaults: [{ path: "measures[0].id", value: "offenses.motor_vehicle_theft", reason: "\"car theft\" reads as motor vehicle theft, labelled as such" }],
};

const carjacking = { id: "incidents.carjacking", unit: "incident" as const, as: "carjackings" };

/** Case N4 (d): the frozen release questions. */
export const H1: NibrsPlan = {
  ...base,
  question: "carjacking per month in Memphis",
  geography: { places: [MEMPHIS], combine: "separate" },
  period: { kind: "relative", anchor: "latest_complete_year" },
  measures: [carjacking],
  groupings: [by("time.month")],
  statistics: [{ kind: "count", measure: "carjackings" }],
  coverage: ALL,
  defaults: [{ path: "period", value: "latest_complete_year", reason: "no period named; a monthly series covers the latest complete year" }],
};
export const H2: NibrsPlan = { ...H1, question: "carjackings in Memphis in 2025", period: { kind: "absolute", from: "2025-01", to: "2025-12" }, groupings: [], defaults: [] };
export const H3: NibrsPlan = { ...H1, question: "carjackings per year in Memphis from 2020 to 2025", period: { kind: "absolute", from: "2020-01", to: "2025-12" }, groupings: [by("time.year")], defaults: [] };

/** Case Z: the plan is ordinary; the compiler returns UNKNOWN for months without evidence. */
export const Z: NibrsPlan = {
  ...N1,
  question: "Justifiable homicides per month in Houston since 2018",
  measures: [{ id: "offenses.justifiable_homicide", unit: "offense", as: "justifiable_homicides" }],
  groupings: [by("time.month")],
  statistics: [{ kind: "count", measure: "justifiable_homicides" }],
};

/** Case D: the three denominator scopes are three partitions of one grouped count. */
const dBase: NibrsPlan = {
  ...base,
  question: "Share of Houston murder victims by sex, May 2021",
  geography: { places: [HOUSTON], combine: "separate" },
  period: { kind: "absolute", from: "2021-05", to: "2021-05" },
  measures: [{ id: "victims.murder", unit: "victim", as: "murder_victims" }],
  groupings: [by("victim.sex")],
  statistics: [{ kind: "share", measure: "murder_victims", partition: [] }],
  coverage: ALL,
};
export const D_WITHIN_MONTH = dBase;
export const D_WITHIN_PERIOD: NibrsPlan = {
  ...dBase, period: { kind: "absolute", from: "2021-01", to: "2021-12" },
  groupings: [by("time.month"), by("victim.sex")], statistics: [{ kind: "share", measure: "murder_victims", partition: [] }],
};
export const D_WITHIN_RACE: NibrsPlan = {
  ...dBase, groupings: [by("victim.race"), by("victim.sex")], statistics: [{ kind: "share", measure: "murder_victims", partition: ["victim.race"] }],
};

/** Case R: a rate needs complete agency-periods; 2018 comes back as a count with the rate unavailable. */
export const R: NibrsPlan = {
  ...base,
  question: "Murder victim rate per 100,000 in Houston, 2018 and 2019",
  geography: { places: [HOUSTON], combine: "separate" },
  period: { kind: "absolute", from: "2018-01", to: "2019-12" },
  measures: [{ id: "victims.murder", unit: "victim", as: "murder_victims" }],
  groupings: [by("time.year")],
  statistics: [{ kind: "count", measure: "murder_victims" }, { kind: "rate", measure: "murder_victims", per: 100000, population: "covered_population" }],
  coverage: COMPLETE,
};

/* ---- plan forms the spec requires, beyond the correctness cases ---- */

/** Several measures with different units: separate columns, never added. */
export const MULTI_MEASURE: NibrsPlan = {
  ...base,
  question: "Robberies and robbery victims and robbery arrests in Memphis in 2024",
  geography: { places: [MEMPHIS], combine: "separate" },
  period: { kind: "absolute", from: "2024-01", to: "2024-12" },
  measures: [
    { id: "offenses.robbery", unit: "offense", as: "robberies" },
    { id: "victims.robbery", unit: "victim", as: "robbery_victims" },
    { id: "arrests.robbery", unit: "arrest", as: "robbery_arrests" },
  ],
  groupings: [],
  statistics: [{ kind: "count", measure: "robberies" }, { kind: "count", measure: "robbery_victims" }, { kind: "count", measure: "robbery_arrests" }],
  coverage: ALL,
};

/** Top 5 cities per month, among cities of 250,000 or more: top-N within each period over an agency set. */
export const TOP_N_PER_MONTH: NibrsPlan = {
  ...base,
  question: "Which 5 cities of 250,000 or more had the most motor vehicle thefts each month in 2025?",
  geography: { places: [{ kind: "agency_set", where: [{ field: "agency.population", op: ">=", value: 250000 }, { field: "agency.type", op: "in", value: ["city"] }], within: { kind: "national" } }], combine: "separate" },
  period: { kind: "absolute", from: "2025-01", to: "2025-12" },
  measures: [{ id: "offenses.motor_vehicle_theft", unit: "offense", as: "motor_vehicle_thefts" }],
  groupings: [by("time.month"), by("geo.agency")],
  statistics: [{ kind: "count", measure: "motor_vehicle_thefts" }],
  transforms: [{ kind: "top_n", n: 5, by: "motor_vehicle_thefts", direction: "top", per: ["time.month"] }],
  coverage: ALL,
};

/** Rolling 12-month murders, nationally: a window over known months only. */
export const ROLLING: NibrsPlan = {
  ...base,
  question: "Rolling 12-month murder victims nationally since 2021",
  geography: { places: [{ kind: "national" }], combine: "separate" },
  period: { kind: "relative", anchor: "since", from: "2021-01" },
  measures: [{ id: "victims.murder", unit: "victim", as: "murder_victims" }],
  groupings: [by("time.month")],
  statistics: [{ kind: "count", measure: "murder_victims" }],
  transforms: [{ kind: "rolling", months: 12, aggregate: "sum" }],
  coverage: ALL,
};

/** Change between two years in a same-agencies cohort, so participation change is not read as crime change. */
export const SAME_AGENCIES_CHANGE: NibrsPlan = {
  ...base,
  question: "How did aggravated assault victims change in Texas from 2023 to 2025, same agencies?",
  geography: { places: [{ kind: "state", code: "TX" }], combine: "separate" },
  period: { kind: "absolute", from: "2023-01", to: "2025-12" },
  measures: [{ id: "victims.aggravated_assault", unit: "victim", as: "aggravated_assault_victims" }],
  groupings: [],
  statistics: [{ kind: "count", measure: "aggravated_assault_victims" }],
  transforms: [{ kind: "period_comparison", earlier: { kind: "absolute", from: "2023-01", to: "2023-12" }, later: { kind: "absolute", from: "2025-01", to: "2025-12" }, outputs: ["earlier", "later", "change", "pct_change"] }],
  coverage: { ...ALL, cohort: "same_agencies" },
};

/** A 1:n grouping: murders by weapon, each weapon counted (an offense can record up to three). */
export const MULTI_VALUE_GROUPING: NibrsPlan = {
  ...base,
  question: "Murders by weapon in Houston in 2024",
  geography: { places: [HOUSTON], combine: "separate" },
  period: { kind: "absolute", from: "2024-01", to: "2024-12" },
  measures: [{ id: "offenses.murder", unit: "offense", as: "murder_offenses" }],
  groupings: [by("offense_weapon.weapon", { multiValue: "each_value" })],
  statistics: [{ kind: "count", measure: "murder_offenses" }],
  coverage: ALL,
};

export const EXAMPLES: Record<string, NibrsPlan> = {
  N1, N2, N3, H1, H2, H3, Z, D_WITHIN_MONTH, D_WITHIN_PERIOD, D_WITHIN_RACE, R,
  MULTI_MEASURE, TOP_N_PER_MONTH, ROLLING, SAME_AGENCIES_CHANGE, MULTI_VALUE_GROUPING,
};
