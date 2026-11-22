/**
 * P234 (Jeff 2026-11-22): a question about what a source is gets one fixed text for that source, flat and factual, with the
 * latest year or month filled from the release so the text stays true after each monthly update. Nothing else is added: no
 * source line, no figures. Reader only: no SQL, no counting.
 *
 * Which source: the one the question names ("what is NIBRS", "what are Homicide Reports"). A question that names none ("what data do
 * you have") takes the tab it is asked on (deps.tab), and without a tab it is not read here. A source this app does not hold
 * ("what is LEOKA") is answered "I don't have a description of that" with the list of sources.
 */
import { monthName } from "./deliver";

export type SourceTab = "historical" | "current" | "nibrs" | "shr" | "hate_crime";
/** The latest data of each source the texts mention; a source without a release here has no text to give. */
export type SourceLatest = { historicalYear?: number | null; nibrsMonth?: string | null; shrMonth?: string | null; currentMonth?: string | null; hateYear?: number | null };
export type SourceDescriptionQuestion = { source: SourceTab | null; other: string | null };

export const SOURCE_LIST = "Crime Index - Historical, Crime Index - Current, NIBRS, Homicide Reports and Hate crimes";
export const NO_DESCRIPTION = `I don't have a description of that. The sources here are ${SOURCE_LIST}.`;

const NAMES: { tab: SourceTab; re: RegExp }[] = [
  { tab: "nibrs", re: /\bnibrs\b|\bnational\s+incident[-\s]based\b/i },
  { tab: "shr", re: /\bhomicide\s+reports?\b|\bshr\b|\bsupplementary\s+homicide\b/i },
  { tab: "hate_crime", re: /\bhate[-\s]crimes?(?:\s+(?:statistics|data|reports?|tab))?\b/i },
  { tab: "current", re: /\bcrime\s+index\s*[-–—:]?\s*current\b|\bcurrent\s+(?:trends|crime\s+index)\b|\brtci\b|\breal[-\s]time\s+crime\s+index\b/i },
  { tab: "historical", re: /\bcrime\s+index\s*[-–—:]?\s*historical\b|\bhistorical\s+(?:library|crime\s+index|data|tab)\b|\bucr\b|\buniform\s+crime\s+report/i },
];
/** Sources that exist elsewhere but are not held here. */
const OTHERS = /\b(?:leoka|asr|police\s+employee|cargo\s+theft|human\s+trafficking|arson\s+data|ncvs|national\s+crime\s+victimization(?:\s+survey)?)\b/i;

const ASK = String.raw`(?:what(?:'s|\s+is)\s+the\s+(?:scope|coverage)\s+of|what(?:'s|\s+is|\s+are)|whats|tell\s+me\s+about|describe|explain|what\s+does\s+.+?\s+(?:cover|include|contain|hold|have))`;
/** "what is X", "tell me about X", "describe X", "what is the scope of the X data (you have)": one short question about the source alone. */
const ABOUT = new RegExp(String.raw`^\s*(?:(?:please|hi|hello|hey)[,\s]+)?(?:can\s+you\s+|could\s+you\s+)?${ASK}\b`, "i");
/** No source named: "what data do you have", "what does this tab cover", "what is this data". */
const UNNAMED = /^\s*(?:(?:please|hi|hello|hey)[,\s]+)?(?:what\s+(?:data|information|stats|statistics|numbers)\s+(?:do|does|can)\s+(?:you|this|the\s+(?:tab|site|tool|app))\s+(?:have|hold|contain|cover|include|show|offer)|what\s+(?:is|are|does)\s+(?:this|the)\s+(?:data(?:set)?|tab|source|data\s+source)(?:\s+(?:cover|include|contain|hold|have))?|what\s+does\s+(?:this|the)\s+(?:tab|data(?:set)?)\s+(?:cover|include|contain|hold|have)|what(?:'s|\s+is)\s+in\s+(?:this|the)\s+(?:data(?:set)?|tab)|describe\s+(?:this|the)\s+(?:data(?:set)?|tab|source)|what(?:'s|\s+is)\s+the\s+(?:source|origin)\s+of\s+(?:this|the)\s+(?:data(?:set)?|tab)|where\s+does\s+(?:this|the)\s+data\s+come\s+from)\s*[?.!]*\s*$/i;
/** A figure, a place or a period asked with it is that figure's question, not this one. */
const FIGURE = /\b(?:19|20)\d{2}\b|\b(?:how\s+many|rate|trend|count|number\s+of|total|compare|clearance|top\s+\d+|highest|lowest|rank)\b/i;

/**
 * The source description the words ask, or null. `hasMeasure` / `hasPlace`: the reader found a crime, or a place other than a state,
 * in the question ("what is the NIBRS murder rate" is a figure, never this).
 */
export function readSourceDescription(question: string, hasMeasure: boolean, hasPlace: boolean): SourceDescriptionQuestion | null {
  const t = question.trim();
  // "hate crime" is itself read as a crime: for a named source the words left over decide (below); the reader's finds bar only the unnamed forms.
  if (!t || FIGURE.test(t) || t.split(/\s+/).length > 14 || (t.match(/\?/g) ?? []).length > 1) return null;
  if (UNNAMED.test(t)) return hasMeasure || hasPlace ? null : { source: null, other: null };
  if (!ABOUT.test(t)) return null;
  const named = NAMES.filter((n) => n.re.test(t));
  // "what is the difference between NIBRS and SHR" names two sources: not one description.
  if (named.length > 1) return null;
  if (named.length === 1) {
    // "what are NIBRS agencies / offenses / victims" asks about a part of the data (definitions, coverage), not the source itself.
    const rest = t.replace(named[0].re, " ").replace(ABOUT, " ").replace(/\b(?:the|a|an|data|dataset|database|source|tab|statistics|stats|reports?|you|have|hold|contain|cover|include|please|here|this|that|of|about|is|are|for|in)\b|[?.!,]/gi, " ").replace(/\s+/g, " ").trim();
    return rest ? null : { source: named[0].tab, other: null };
  }
  const other = OTHERS.exec(t);
  if (other) return { source: null, other: other[0] };
  return null;
}

/** The fixed texts (P234 row, Jeff 2026-11-22); [most recent year], [most recent month], [last month] and [last year] are filled from the release. */
export function sourceText(tab: SourceTab, latest: SourceLatest): string | null {
  switch (tab) {
    case "historical":
      return latest.historicalYear == null ? null
        : `Crime Index - Historical holds yearly counts of crimes, law enforcement staffing, and clearances. Police agencies report the figures to the FBI. It has no detail on victims, offenders or weapons, and it has no monthly counts. Crime and staffing data for many agencies is available from 1930 to ${latest.historicalYear} while state and national estimates are available from 1960 on.`;
    case "current":
      return !latest.currentMonth ? null
        : `Crime Index - Current holds monthly counts of crime and clearances from 2017 to ${monthName(latest.currentMonth)} for city agencies of 50,000 or more and county agencies of 100,000 or more. Police agencies report these preliminary figures which give an approximate of national crime trends. It has no detail on victims, offenders or weapons.`;
    case "nibrs":
      return !latest.nibrsMonth ? null
        : `NIBRS is the FBI's National Incident-Based Reporting System. Police agencies report each crime incident to the FBI: the offenses, victims, offenders, weapons, arrests and clearances. The data here run by month from 1991 for some agencies through ${monthName(latest.nibrsMonth)}. It covers only agencies that report through NIBRS, so a state or year can have few agencies or none. It leaves out crimes not reported to police.`;
    case "shr":
      return !latest.shrMonth ? null
        : `Homicide Reports comes from the FBI's Supplementary Homicide Reports. Police agencies report data on murders to the FBI with details of the victim, the offender, the weapon and the circumstances. The data here run from 1985 through ${monthName(latest.shrMonth)}. It covers murder and non-negligent manslaughter only. It leaves out agencies that did not report in a year, and it has no other crimes.`;
    case "hate_crime":
      return latest.hateYear == null ? null
        : `Hate crime data come from FBI Hate Crime Statistics. Police agencies report to the FBI the incidents they classify as motivated by bias, with the bias type, the offense and the location. The data run from 1991 through ${latest.hateYear}. Reporting is voluntary, so agencies that did not report are missing. Incidents not reported to police or not classified as bias-motivated are left out.`;
  }
}

/** The one sentence to give for a read question: the source's text, or the no-description sentence with the source list. */
export function describeSource(q: SourceDescriptionQuestion, tab: SourceTab | undefined, latest: SourceLatest): string {
  const which = q.source ?? (q.other ? null : tab ?? null);
  if (!which) return NO_DESCRIPTION;
  return sourceText(which, latest) ?? NO_DESCRIPTION;
}
