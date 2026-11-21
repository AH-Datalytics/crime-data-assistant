/**
 * The first line of an answer (Jeff 2026-11-18, the headline style rule). An answer that is just text (one figure, no chart) opens
 * with a full sentence; one with a table or chart opens with a Title Case title that reads the question back, then sentence notes,
 * then the source line. A one-row answer of several columns (a change between years) opens with its sentence and keeps its table.
 *
 * A place in a sentence is named short ("Chicago"), with its state ("Kansas City, Missouri") only when another city of that name
 * in another state serves 100,000 or more (the place index's own rule for asking which one); a state is its name; the nation is
 * "The United States". A name takes 's to show it owns the figure ("Texas's", "Colorado's"); the nation, whose possessive reads
 * badly, says "had a ... rate of".
 */
import { ASK_POPULATION, loadPlaceIndex, type PlaceIndex } from "./places";
import { titleCase } from "./titles";

let index: PlaceIndex | null = null;
const places = () => (index ??= loadPlaceIndex());
/** The place index's name key: no case or punctuation, "Saint" as "St", no trailing "County" or "Parish". */
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\bsaint\b/g, "st").replace(/\s+/g, " ").trim().replace(/ (county|parish)$/, "");

export type Subject = { text: string; nation?: true };

/** An agency as a subject: its short name, or its label with the state when another place of that name and kind has 100,000 or more people. */
export function agencySubject(label: string, ori?: string): Subject {
  const short = label.split(",")[0].trim();
  if (short === label.trim()) return { text: short };
  const mine = ori ? places().byName.get(key(short))?.find((a) => a.ori === ori) : undefined;
  const others = (places().byName.get(key(short)) ?? []).filter((a) => a.ori !== ori && (mine ? a.kind === mine.kind && a.state !== mine.state : true) && a.population >= ASK_POPULATION);
  return { text: others.length ? label : short };
}
export const stateSubject = (name: string): Subject => ({ text: name });
export const nationSubject: Subject = { text: "The United States", nation: true };
/** A subject as a title's place: agencies by their label ("Atlanta, Georgia"), the nation as "United States". */
export const titlePlace = (s: string) => (s === "The United States" ? "United States" : s);

export const possessive = (name: string) => `${name}'s`;
/** The thing a rate counts, one: "robbery offenses" as "robbery offense", "burglaries" as "burglary" ("a robbery offense rate"). */
export const rateNoun = (plural: string) => plural.replace(/ies$/, "y").replace(/([^s])s$/, "$1");
/** "Chicago's violent crime rate in 2024 was 539.8 per 100,000." / "The United States had a violent crime rate of 327.6 per 100,000 in 2025." */
export function rateSentence(who: Subject, measure: string, when: string, rate: string, prep = "in"): string {
  return who.nation ? `${who.text} had a ${measure} rate of ${rate} per 100,000 ${prep} ${when}.` : `${possessive(who.text)} ${measure} rate ${prep} ${when} was ${rate} per 100,000.`;
}
/** "Dallas had 181 murders in 2024." (`prep` "from" for "from January through March 2026") */
export const countSentence = (who: Subject, n: string, words: string, when: string, prep = "in") => `${who.text} had ${n} ${words} ${prep} ${when}.`;
/** "Chicago had 461 murders in 2024 and 346 in 2025, a change of -115 (-24.9%)." */
export function changeSentence(who: Subject, words: string, e: string, l: string, E: string, L: string, change: string, pct: number | null): string {
  return `${who.text} had ${e} ${words} in ${E} and ${l} in ${L}, a change of ${change}${pct !== null ? ` (${pct > 0 ? "+" : ""}${pct}%)` : ""}.`;
}
/** "Chicago's violent crime rate was 539.8 per 100,000 in 2024 and 420.4 in 2025, a change of -119.4 (-22.1%)." */
export function rateChangeSentence(who: Subject, measure: string, e: string, l: string, E: string, L: string, change: string, pct: number | null): string {
  const tail = `a change of ${change}${pct !== null ? ` (${pct > 0 ? "+" : ""}${pct}%)` : ""}.`;
  return who.nation ? `${who.text} had a ${measure} rate of ${e} per 100,000 in ${E} and ${l} in ${L}, ${tail}`
    : `${possessive(who.text)} ${measure} rate was ${e} per 100,000 in ${E} and ${l} in ${L}, ${tail}`;
}
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const abbr = (m: string) => m.slice(0, 3);
const monthIndex = (m: string) => MONTHS_LONG.findIndex((x) => x.toLowerCase() === m.toLowerCase());
/**
 * The timeframe of a title, short (Jeff 2026-11-21): "2024", "2019-2026", "Jan-Oct 2026", "Jan 2019-Oct 2026", "Year to Date 2026".
 * Takes the period as the answers word it ("2019 to 2026", "January through October 2026"); anything else is kept as it is.
 */
export function titleTimeframe(period: string): string {
  const p = period.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4}) Year to Date$/i.exec(p))) return `Year to Date ${m[1]}`;
  if (/^\d{4}$/.test(p)) return p;
  if ((m = /^(\d{4}) to (\d{4})$/.exec(p))) return `${m[1]}-${m[2]}`;
  if ((m = /^([A-Za-z]+) (?:through|to) ([A-Za-z]+) (\d{4})$/i.exec(p)) && monthIndex(m[1]) >= 0 && monthIndex(m[2]) >= 0)
    return monthIndex(m[1]) === 0 && monthIndex(m[2]) === 11 ? m[3] : `${abbr(m[1])}-${abbr(m[2])} ${m[3]}`;
  if ((m = /^([A-Za-z]+) (\d{4}) (?:through|to) ([A-Za-z]+) (\d{4})$/i.exec(p)) && monthIndex(m[1]) >= 0 && monthIndex(m[3]) >= 0)
    return monthIndex(m[1]) === 0 && monthIndex(m[3]) === 11 ? (m[2] === m[4] ? m[2] : `${m[2]}-${m[4]}`)
      : m[2] === m[4] ? `${abbr(m[1])}-${abbr(m[3])} ${m[2]}` : `${abbr(m[1])} ${m[2]}-${abbr(m[3])} ${m[4]}`;
  if ((m = /^([A-Za-z]+) (\d{4})$/.exec(p)) && monthIndex(m[1]) >= 0) return `${abbr(m[1])} ${m[2]}`;
  return p;
}
/**
 * "Atlanta, Georgia Murders Per Year, 2016-2025": the place, what is counted, the period (per month, per year, per quarter, rolling over
 * 12 months, or by the breakdown's name), then the timeframe, short (Jeff 2026-11-21: PLACE, OFFENSE, PERIOD, TIMEFRAME).
 */
export function seriesTitle(period: string, what: string, grouping: string, place: string): string {
  let words = what;
  let rolling: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(.*?),? Rolling (\d+)-Month (Totals|Averages per Month)$/i.exec(words))) { words = m[1]; rolling = /^Totals$/i.test(m[3]) ? `Rolling Over ${m[2]} Months` : `Rolling Average Over ${m[2]} Months`; }
  else if ((m = /^Rolling (\d+)-Month (.+)$/i.exec(words))) { words = m[2]; rolling = `Rolling Over ${m[1]} Months`; }
  const g = grouping.trim();
  const time = /^(month|year|quarter)$/i.exec(g);
  const grain = rolling ?? (time ? `Per ${titleCase(time[1])}` : `by ${titleCase(g)}`);
  const head = [place ? titlePlace(place) : "", titleCase(words)].filter(Boolean).join(" ");
  return `${head} ${grain}, ${titleTimeframe(period)}`;
}
