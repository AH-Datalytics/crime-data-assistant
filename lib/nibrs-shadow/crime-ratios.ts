/**
 * P207 (Jeff 2026-11-22, "Compute it"): a ratio of two crimes ("murder-to-robbery ratio", "ratio of robbery to aggravated assault").
 *
 * No statement of its own: the counts of each crime named are the answers the same question already gets for that crime (the ratio
 * words replaced by the crime), lined up by place and period. Per place per period the ratio is A divided by B, two decimals, with
 * both counts beside it. Several ratios are several columns of one table. A period where B is zero or either count is blank has no
 * ratio, and a line says so. One source for every count (P14): the answers must be series of the same kind, places and periods,
 * with the same source line; otherwise null and the question keeps the path it has.
 */
import type { ResultTable } from "../nibrs-plan/result";
import { seriesOf, type PartAnswer } from "./crime-over-time";

type Column = ResultTable["columns"][number];
type Crime = { key: string; asked: string; plural: string; title: RegExp; header: string };
const CRIMES: Crime[] = [
  { key: "murder", asked: "murders?|homicides?", plural: "murders", title: /\bMurders?\b/i, header: "Murders" },
  { key: "rape", asked: "rapes?", plural: "rapes", title: /\bRapes?\b/i, header: "Rapes" },
  { key: "robbery", asked: "robber(?:y|ies)", plural: "robberies", title: /\bRobber(?:y|ies)\b/i, header: "Robberies" },
  { key: "aggravated_assault", asked: "aggravated\\s+assaults?|agg\\.?\\s+assaults?|assaults?", plural: "aggravated assaults", title: /\bAggravated Assaults?\b/i, header: "Aggravated assaults" },
  { key: "burglary", asked: "burglar(?:y|ies)", plural: "burglaries", title: /\bBurglar(?:y|ies)\b/i, header: "Burglaries" },
  { key: "theft", asked: "larceny(?:[-\\s]thefts?)?|thefts?", plural: "larceny-thefts", title: /\bLarceny[-\s]Thefts?\b/i, header: "Larceny-thefts" },
  { key: "motor_vehicle_theft", asked: "motor\\s+vehicle\\s+thefts?|auto\\s+thefts?", plural: "motor vehicle thefts", title: /\bMotor Vehicle Thefts?\b/i, header: "Motor vehicle thefts" },
];
const ANY = CRIMES.map((c) => c.asked).sort((a, b) => b.length - a.length).join("|");
const PAIR = String.raw`(${ANY})(?:\s*-\s*to\s*-\s*|\s*-\s*|\s+to\s+|\s+per\s+)(${ANY})`;
const PAIRLIST = new RegExp(String.raw`\b${PAIR}(?:\s*(?:,|and|&)\s*(?:and\s+)?${PAIR})*\s+ratios?\b`, "i");
const PAIR_G = new RegExp(PAIR, "gi");
const RATIO_OF = new RegExp(String.raw`\bratios?\s+of\s+(${ANY})\s+(?:to|per|and)\s+(${ANY})\b`, "i");
const crimeOf = (w: string) => CRIMES.find((c) => new RegExp(String.raw`^(?:${c.asked})$`, "i").test(w.trim()))!;

/** The question's own lead-in and list punctuation, in words the reader knows: "Can you return the murders for A; B for the years 2010 to 2025?" is "murders in A, B by year from 2010 to 2025?". */
const plainAsk = (q: string) => q
  .replace(/^\s*(?:can|could|would)\s+you\s+(?:please\s+)?(?:return|show|give|provide|get|pull|chart|plot)(?:\s+me)?(?:\s+the)?\s+/i, "")
  .replace(/^\s*(?:please\s+)?(?:return|show|give|provide|get|pull|chart|plot)(?:\s+me)?(?:\s+the)?\s+/i, "")
  .replace(/\s*;\s*/g, ", ")
  .replace(/\s+for\s+the\s+years?\s+(\d{4})\s*(?:to|through|-|–)\s*(\d{4})/i, " by year from $1 to $2")
  .replace(/\s+for\s+(?=[A-Z])/, " in ")
  .replace(/\s+/g, " ").trim();

export type RatioAsk = { pairs: [Crime, Crime][]; crimes: Crime[]; withCrime: (c: Crime) => string };

/** The ratios asked and a way to ask the same question for one crime; null when the question names no ratio of two crimes. */
export function readRatios(question: string): RatioAsk | null {
  if (/\b(?:rates?|per\s+100,?000|percent|percentage)\b/i.test(question)) return null;
  let m = PAIRLIST.exec(question);
  let found: string;
  const pairs: [Crime, Crime][] = [];
  if (m) {
    found = m[0];
    for (const p of found.matchAll(PAIR_G)) pairs.push([crimeOf(p[1]), crimeOf(p[2])]);
  } else {
    m = RATIO_OF.exec(question);
    if (!m) return null;
    found = m[0];
    pairs.push([crimeOf(m[1]), crimeOf(m[2])]);
  }
  if (!pairs.length || pairs.some(([a, b]) => a.key === b.key)) return null;
  const crimes: Crime[] = [];
  for (const [a, b] of pairs) for (const c of [a, b]) if (!crimes.includes(c)) crimes.push(c);
  const at = question.indexOf(found);
  return { pairs, crimes, withCrime: (c) => plainAsk(`${question.slice(0, at)}${c.plural}${question.slice(at + found.length)}`) };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const ONE: Record<string, string> = { murder: "Murder", rape: "Rape", robbery: "Robbery", aggravated_assault: "Aggravated assault", burglary: "Burglary", theft: "Larceny-theft", motor_vehicle_theft: "Motor vehicle theft" };
const label = (c: Crime) => ONE[c.key];
const ratioName = (a: Crime, b: Crime) => `${label(a)}-to-${label(b).toLowerCase()} ratio`;

/** The ratio table from one answer per crime (in `ask.crimes` order), or null when they are not series of one source for the same places and periods. */
export function composeRatios(ask: RatioAsk, answers: PartAnswer[]): PartAnswer | null {
  if (answers.length !== ask.crimes.length) return null;
  const series = answers.map(seriesOf);
  if (series.some((s) => !s)) return null;
  const all = series as NonNullable<(typeof series)[number]>[];
  const first = all[0];
  const grain = first.periodCol.binding.kind === "grouping" ? first.periodCol.binding.dimension : "";
  const src = (a: PartAnswer) => a.delivered.text[a.delivered.text.length - 1];
  if (!all.every((s, i) => s.kind === first.kind && s.periodCol.binding.kind === "grouping" && s.periodCol.binding.dimension === grain
    && s.places.length === first.places.length && s.places.every((p, j) => p === first.places[j]) && src(answers[i]) === src(answers[0]))) return null;
  const periods = [...new Set(all.flatMap((s) => [...s.cells.keys()].map((k) => k.split("\u0000")[1])))].sort();
  const several = first.places.length > 1;
  const at = (i: number, place: string, period: string) => all[i].cells.get(`${place}\u0000${period}`) ?? null;
  const idx = (c: Crime) => ask.crimes.indexOf(c);
  const rows: (string | number | null)[][] = [];
  let noRatio = false;
  for (const place of first.places) for (const period of periods) {
    const counts = ask.crimes.map((_, i) => at(i, place, period));
    const ratios = ask.pairs.map(([a, b]) => {
      const x = counts[idx(a)], y = counts[idx(b)];
      if (x === null || y === null || y === 0) { noRatio = true; return null; }
      return round2(x / y);
    });
    rows.push([...(several ? [place] : []), period, ...counts, ...ratios]);
  }
  const lead = several ? 2 : 1;
  if (rows.every((r) => r.slice(lead + ask.crimes.length).every((x) => x === null))) return null;
  const columns: Column[] = [...(several ? [first.placeCol!] : []), first.periodCol,
    ...ask.crimes.map((c, i) => ({ binding: { kind: "statistic" as const, as: `count_${i}` }, header: c.header })),
    ...ask.pairs.map(([a, b], i) => ({ binding: { kind: "statistic" as const, as: `ratio_${i}` }, header: ratioName(a, b) }))];
  // Title: the first answer's, its crime replaced by the ratios asked.
  const title0 = answers[0].delivered.text[0] ?? "";
  const named = ask.pairs.map(([a, b]) => `${label(a)}-to-${label(b).replace(/\b(\w)/g, (m) => m.toUpperCase())} Ratio`).join(", ");
  const title = title0.replace(ask.crimes[0].title, named).replace(/\s+Per Year\b/i, " Per Year");
  if (title === title0) return null;
  const lines: string[] = [];
  for (const a of answers) for (const t of a.delivered.text.slice(1, -1)) if (!lines.includes(t)) lines.push(t);
  if (noRatio) lines.push("A ratio is blank where the second count is zero or either count is blank.");
  const base = answers[0];
  return {
    ...base,
    meaning: { ...base.meaning, measures: answers.flatMap((a) => a.meaning.measures) },
    delivered: { ...base.delivered, table: { columns, rows } as ResultTable, text: [title, ...lines, src(answers[0])] },
  };
}
