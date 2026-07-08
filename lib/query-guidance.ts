import { getGeoGuidanceIssues } from "./geo-guidance-lite";

export type GuidanceAction = {
  label: string;
  pattern?: string;
  replacement?: string;
  append?: string;
};

export type GuidanceWarning = {
  id: string;
  kind: "blocking" | "advisory";
  title: string;
  detail: string;
  actions?: GuidanceAction[];
};

export type HowToAskExample = {
  category: string;
  question: string;
};

export const HOW_TO_ASK_EXAMPLES: HowToAskExample[] = [
  { category: "Trends", question: "murder trend from 2019 to 2025" },
  { category: "Rates", question: "violent crime rate in Texas cities of 250k or more in 2023" },
  { category: "Places", question: "fatal shootings in Kansas City, Missouri per month from 2020 to 2024" },
  { category: "Comparability", question: "New York City vs Chicago officers per year since 1930" },
  { category: "Demographics", question: "offender age breakdown for robberies since 2020" },
];

function has(pattern: RegExp, text: string) {
  return pattern.test(text);
}

function asksGenericCrime(text: string): boolean {
  if (!/\bcrimes?\b/i.test(text)) return false;
  return !/\b(?:violent|property|hate|index|overall|all|murder|homicide|rape|robbery|assault|burglary|theft|larceny|motor\s+vehicle|auto\s+theft|arson|domestic\s+violence|dui|drug|weapons?|firearm|gun|shootings?|clearance|offender|victim|arrestee|arrest)\b/i.test(text);
}

function asksDemographicRate(text: string): boolean {
  return /\b(?:rates?|per\s*(?:capita|100k|100,?000))\b/i.test(text) &&
    /\b(?:race|racial|sex|gender|male|female|men|women|age|ages|demographic|demographics)\b/i.test(text);
}

function asksAmbiguousTheft(text: string): boolean {
  if (!/\bthefts?\b/i.test(text)) return false;
  return !/\b(?:motor\s+vehicle|auto|vehicle|car|from\s+(?:a\s+)?(?:vehicle|car|auto)|larceny\s*\/?|shoplifting|identity|retail|pocket.?picking|purse.?snatching|burglary)\s*thefts?\b|\bthefts?\s+(?:from|of|out\s+of|involving|by)\b/i.test(text);
}

export function getQueryGuidanceWarnings(input: string): GuidanceWarning[] {
  const text = input.trim();
  if (!text) return [];

  const warnings: GuidanceWarning[] = [...getGeoGuidanceIssues(text)];

  if (asksDemographicRate(text)) {
    warnings.push({
      id: "demographic-rate-denominator",
      kind: "advisory",
      title: "The FBI data does not include matching population denominators for demographic groups",
      detail: "",
      actions: [
        { label: "Use victim counts by race and sex", pattern: "\\brates?\\b", replacement: "counts" },
        { label: "Use offender counts by race and sex", pattern: "\\brates?\\b", replacement: "counts" },
        { label: "Use victim age breakdown", pattern: "\\brates?\\b", replacement: "breakdown" },
        { label: "Use offender age breakdown", pattern: "\\brates?\\b", replacement: "breakdown" },
      ],
    });
  }

  if (asksGenericCrime(text)) {
    warnings.push({
      id: "generic-crime-type",
      kind: "advisory",
      title: "Crime can mean different measures",
      detail: "For a cleaner answer, choose a crime type or category before running the query.",
      actions: [
        { label: "Use violent crime", pattern: "\\bcrimes?\\b", replacement: "violent crime" },
        { label: "Use property crime", pattern: "\\bcrimes?\\b", replacement: "property crime" },
        { label: "Use murder", pattern: "\\bcrimes?\\b", replacement: "murder" },
        { label: "Use rape", pattern: "\\bcrimes?\\b", replacement: "rape" },
        { label: "Use robbery", pattern: "\\bcrimes?\\b", replacement: "robbery" },
        { label: "Use aggravated assault", pattern: "\\bcrimes?\\b", replacement: "aggravated assault" },
        { label: "Use burglary", pattern: "\\bcrimes?\\b", replacement: "burglary" },
        { label: "Use larceny/theft", pattern: "\\bcrimes?\\b", replacement: "larceny/theft" },
        { label: "Use motor vehicle theft", pattern: "\\bcrimes?\\b", replacement: "motor vehicle theft" },
      ],
    });
  }

  if (has(/\bgun\s+violence\b/i, text) && !has(/\b(fatal|nonfatal|firearm\s+(homicides?|assaults?|injur(?:y|ies)))\b/i, text)) {
    warnings.push({
      id: "gun-violence",
      kind: "blocking",
      title: "The FBI does not systemically track all shootings",
      detail: "You can query fatal shootings specifically or aggravated assaults with a firearm as a broader measure.",
      actions: [
        { label: "Use fatal shootings", pattern: "\\bgun\\s+violence\\b", replacement: "fatal shootings" },
        { label: "Use aggravated assaults with a firearm", pattern: "\\bgun\\s+violence\\b", replacement: "aggravated assaults with a firearm" },
      ],
    });
  }

  if (has(/\bshootings?\b/i, text) && !has(/\b(fatal|nonfatal|firearm\s+(homicides?|assaults?|injur(?:y|ies)))\b/i, text)) {
    warnings.push({
      id: "shooting-scope",
      kind: "blocking",
      title: "The FBI does not systemically track all shootings",
      detail: "You can query fatal shootings specifically or aggravated assaults with a firearm as a broader measure.",
      actions: [
        { label: "Use fatal shootings", pattern: "\\bshootings?\\b", replacement: "fatal shootings" },
        { label: "Use aggravated assaults with a firearm", pattern: "\\bshootings?\\b", replacement: "aggravated assaults with a firearm" },
      ],
    });
  }

  if (has(/\bassaults?\b/i, text) && !has(/\b(aggravated|simple|intimidation|sexual|domestic|dv|firearm|gun|knife|weapon)\s+assaults?\b|\bassaults?\s+(with|involving|by)\b/i, text)) {
    warnings.push({
      id: "assault-type",
      kind: "advisory",
      title: "Assault needs a type",
      detail: "Assault can mean different offense types. Pick aggravated assault, simple assault, or ask for all assault categories.",
      actions: [
        { label: "All assault categories", pattern: "\\bassaults?\\b", replacement: "all assault categories" },
        { label: "Aggravated assault", pattern: "\\bassaults?\\b", replacement: "aggravated assault" },
        { label: "Simple assault", pattern: "\\bassaults?\\b", replacement: "simple assault" },
      ],
    });
  }

  if (asksAmbiguousTheft(text)) {
    warnings.push({
      id: "theft-type",
      kind: "advisory",
      title: "Theft can mean different offense types",
      detail: "For a cleaner answer, choose larceny/theft, motor vehicle theft, or theft from vehicle.",
      actions: [
        { label: "Use larceny/theft", pattern: "\\bthefts?\\b", replacement: "larceny/theft" },
        { label: "Use motor vehicle theft", pattern: "\\bthefts?\\b", replacement: "motor vehicle theft" },
        { label: "Use theft from vehicle", pattern: "\\bthefts?\\b", replacement: "theft from vehicle" },
      ],
    });
  }

  if (has(/\b(consistent|continuous)\s+report(?:er|ers|ing)|\breported\s+all\s+12\s+months\b/i, text)) {
    warnings.push({
      id: "consistent-reporters",
      kind: "advisory",
      title: "Consistent reporting means 12 months",
      detail: "An agency counts as consistent for a year only if it reported all 12 months in that year.",
    });
  }

  return warnings;
}

export function hasBlockingQueryGuidanceWarnings(input: string): boolean {
  return getQueryGuidanceWarnings(input).some((warning) => warning.kind === "blocking");
}

export function applyGuidanceAction(input: string, action: GuidanceAction): string {
  const trimmed = input.trim();
  if (!trimmed) return action.replacement ?? action.append ?? input;

  let next = input;
  if (action.pattern && action.replacement) {
    const pattern = new RegExp(action.pattern, "i");
    next = input.replace(pattern, action.replacement);
  }

  if (next === input && action.append) {
    next = `${trimmed} ${action.append}`;
  }

  return next;
}
