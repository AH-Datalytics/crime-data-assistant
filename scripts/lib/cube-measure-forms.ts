/**
 * The question forms of the cube measure guard (scripts/gen-cube-measure-checks.ts writes the approvals from them; scripts/test-cube-measure-guard.ts re-checks them): the plain noun the reader
 * takes for each measure, and the forms asked about it, in a family each (victims, offenders, arrests, offenses, incidents).
 */
import { MEASURE_LABEL } from "../../lib/nibrs-question-types";
void MEASURE_LABEL;
/** Every measure the engine's vocabulary knows, and the labels the reader understands them by (a plural first). */
export const MEASURE_NOUNS: Record<string, string[]> = {
  person_crimes: ["violent crimes", "crimes against persons"], against_property: ["property crimes"], murder: ["murders"], homicide: ["homicides"], homicide_all: ["all homicides"],
  rape: ["rapes"], robbery: ["robberies"], aggravated_assault: ["aggravated assaults"], simple_assault: ["simple assaults"], sex_offense: ["sex offenses"],
  burglary: ["burglaries"], theft_from_motor_vehicle: ["thefts from motor vehicles"], motor_vehicle_theft: ["motor vehicle thefts"], shoplifting: ["shoplifting offenses", "shoplifting"],
  theft: ["thefts", "larceny"], arson: ["arsons"], drug_possession: ["drug possession offenses"], dui: ["DUIs"], violent_crime: ["violent crimes"], property_crime: ["property crimes"],
  intimidation: ["intimidation offenses"], assault_offenses: ["assault offenses"], disorderly_conduct: ["disorderly conduct offenses"], drunkenness: ["drunkenness offenses"],
  liquor_law: ["liquor law violations"], curfew_loitering: ["curfew and loitering offenses"], trespass: ["trespass offenses"], family_offense_nonviolent: ["nonviolent family offenses"],
  peeping_tom: ["peeping tom offenses"], bad_checks: ["bad check offenses"], runaway: ["runaways"], all_other_offenses: ["all other offenses"], weapon_law: ["weapon law violations"],
  drug_equipment: ["drug equipment violations"], drug_crimes: ["drug crimes"], all_crime: ["crimes"],
};
/** The question forms tried for every measure, with the place and year filled in: people (victims, offenders, arrests) by an attribute, and offenses and incidents by an attribute. */
export type Form = { family: "victims" | "offenders" | "arrests" | "offenses" | "incidents"; q: string };
export const FORMS = (n: string, place: string, year: number): Form[] => {
  const at = `in ${place} in ${year}`;
  const f = (family: Form["family"], q: string): Form => ({ family, q });
  return [
    f("victims", `${n} victims by sex ${at}`), f("victims", `${n} victims by race ${at}`), f("victims", `${n} victims by ethnicity ${at}`), f("victims", `${n} victims by age group ${at}`),
    f("offenders", `${n} offenders by sex ${at}`), f("offenders", `${n} offenders by race ${at}`), f("offenders", `${n} offenders by ethnicity ${at}`), f("offenders", `${n} offenders by age group ${at}`),
    f("arrests", `${n} arrests by sex ${at}`), f("arrests", `${n} arrests by race ${at}`), f("arrests", `${n} arrests by ethnicity ${at}`), f("arrests", `${n} arrests by age group ${at}`), f("arrests", `juvenile ${n} arrests ${at}`),
    f("offenses", `${n} by time of day ${at}`), f("offenses", `${n} by location ${at}`), f("offenses", `${n} by weapon ${at}`), f("offenses", `${n} with a firearm ${at}`),
    f("incidents", `${n} incidents by time of day ${at}`), f("incidents", `${n} incidents by clearance type ${at}`),
  ];
};
export const YEAR = 2024;
export const MEMPHIS = "Memphis, Tennessee";

