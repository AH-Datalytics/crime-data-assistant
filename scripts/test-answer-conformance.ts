/**
 * The cross-source conformance test (coordinator, 2026-11-02): every live source's answers pass the same checks
 * through the same builders (lib/answer-contract), and each source's profile shows up as declared. Adding a source
 * means adding its fixtures here; a source that fails any check can't be added. Offline and fast (seconds): stub
 * executors, no database, no model. Not the accuracy pilot.
 *
 *   1  title: present, Savant format (place first, Title Case, "&", no colon, no final period)
 *   2  lead: "These are ..." or the single number's sentence; no "Showing"; a described lead has no figures
 *   3  at most one caveat, never repeated in the notes
 *   4  notes: the keep list and the answer's own lines, the source line last; no banned words anywhere shown
 *   5  order: a column in `ordered` keeps its natural order (time ascending; bins in order); in EVERY category column
 *      the not-known categories (Unknown, Not recorded, ...) come after the known ones, and Unknown at most once
 *   6  chart: none for a single number; a line only with a time grouping; stacked only when exclusive
 *   7  coverage columns present if and only if requested
 *   8  exports: the CSV is the table; the PNG has the title, the chart's default and the source line
 *   9  every offer and button has a role and a source; another source only as a choice, a nearest question or another source's
 *  10  every live source's profile is complete (no field missing or defaulted)
 *  11  no offer or note the source's profile doesn't support
 *  12  every breakdown the question names is in the answer (never silently dropped)
 *  13  a single-period answer has no reporting-change caveat and no consistent-agencies offer
 */
import assert from "node:assert/strict";
import { chartOptionsOf, csvOf, joinAmp, leadOf, notesOf, pngSpecOf, PROFILES, titleOf, NOTE_TEXT, type ChoicePresentation, type Presentation,
  type SourceId, type SourceProfile } from "../lib/answer-contract/contract";
import { shadowAnswer, type ShadowDeps, type ShadowOutcome } from "../lib/nibrs-shadow/answer";
import { presentationOf } from "../lib/nibrs-shadow/presentation";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { BANNED } from "../lib/nibrs-shadow/wording";
import { UNKNOWN_NAMES } from "../lib/nibrs-shadow/deliver";
import { missingGroupings } from "../lib/nibrs-shadow/named-groupings";
import type { HistoricalBuild } from "../lib/nibrs-shadow/historical";
import type { ResultTable } from "../lib/nibrs-plan/result";

const places = loadPlaceIndex();

// A state sum (Kansas): two agencies of 100,000; the second starts reporting in 2024, so participation changes (P88).
function grid(sql: string): [string, string, number | null, string][] {
  const oris = /unnest\(\[(.*?)\]\) AS ori/.exec(sql)![1].split(", ").map((x) => x.slice(1, -1));
  const [, from, to] = /range\(DATE '(\d{4}-\d{2})-01', DATE '(\d{4}-\d{2})-01'/.exec(sql)!;
  const rows: [string, string, number | null, string][] = [];
  for (const o of oris) for (let y = +from.slice(0, 4), m = +from.slice(5); `${y}-${String(m).padStart(2, "0")}` <= to; m === 12 ? (y++, (m = 1)) : m++) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    rows.push(o === "KS0000002" && y < 2024 ? [o, ym, null, "UNKNOWN"] : [o, ym, 5, "VALUE"]);
  }
  return rows;
}
function stateSum(sql: string): unknown[][] | null {
  if (sql.includes("agency/data.parquet")) {
    const years = /data_year IN \(([\d, ]+)\)/.exec(sql)![1].split(", ").map(Number);
    const hdr = /u\.state_abbr IN \(([^)]*)\)/.exec(sql);
    const oris = hdr ? ["KS0000001", "KS0000002"] : [...sql.matchAll(/'([A-Z]{2}[A-Z0-9]{7})'/g)].map((m) => m[1]);
    return oris.flatMap((o) => years.map((y) => (hdr ? [o, y, 100_000, "KS"] : [o, y, 100_000, "", o.slice(0, 2)])));
  }
  if (/repsum/.test(sql)) {
    const by = new Map<string, number[] & unknown[]>();
    for (const [o, ym, n, st] of grid(sql)) {
      const k = `${o}|${ym.slice(0, 4)}`;
      const a = by.get(k) ?? (by.set(k, [o, Number(ym.slice(0, 4)), 0, 0, 0, 0] as never), by.get(k)!);
      (a as number[])[2]++; if (st === "VALUE") { (a as number[])[3]++; (a as number[])[4] += n ?? 0; }
    }
    return [...by.values()];
  }
  if (/unnest\(\[.*\]\) AS ori/.test(sql)) return grid(sql);
  return null;
}
// NIBRS stub: 7 a month; categories F/M/U; age groups out of order with both unknowns; weapon codes.
function nibrs(sql: string): unknown[][] {
  const s = stateSum(sql);
  if (s) return s;
  if (/cats AS/.test(sql) && !/AS period/.test(sql) && /THEN 'Under 18'/.test(sql))
    return [["25-34", 20, "VALUE", 0.4, "VALUE"], ["Unknown", 15, "VALUE", 0.3, "VALUE"], ["Under 18", 15, "VALUE", 0.3, "VALUE"]];
  // Unknown the largest, so its place last is the ordering rule, not its count.
  if (/cats AS/.test(sql) && !/AS period/.test(sql)) return [["U", 40, "VALUE", 0.444, "VALUE"], ["F", 30, "VALUE", 0.333, "VALUE"], ["M", 20, "VALUE", 0.222, "VALUE"]];
  const [, from, to] = /range\(DATE '(\d{4}-\d{2})-01', DATE '(\d{4}-\d{2})-01'/.exec(sql)!;
  const months: string[] = [];
  for (let y = +from.slice(0, 4), m = +from.slice(5); `${y}-${String(m).padStart(2, "0")}` <= to; m === 12 ? (y++, (m = 1)) : m++) months.push(`${y}-${String(m).padStart(2, "0")}`);
  if (/substr\(ym, 1, 4\) AS period/.test(sql)) return [...new Set(months.map((m) => m.slice(0, 4)))].map((y) => [y, 7 * months.filter((m) => m.startsWith(y)).length, "VALUE"]);
  if (/AS period/.test(sql)) return months.map((m) => [m, 7, "VALUE"]);
  return [[7 * months.length, "VALUE"]];
}
// Historical stub: Memphis's murders and robberies as published, 2022-2023.
function crimeIndex(sql: string): unknown[][] {
  if (/agency_clearances/.test(sql)) return [];
  const years = /year IN \((\d{4}), (\d{4})\)/.exec(sql);
  const rows = [[2022, 252, 40.3, 624944], [2023, 351, 57.0, 616061]];
  return /TNMPD0000/.test(sql) ? rows.filter(([y]) => !years || y === Number(years[1]) || y === Number(years[2])).map(([y, t, c, p]) => (years ? [y, t] : ["TNMPD0000", y, t, c, p])) : [];
}
const build: HistoricalBuild = { root: "/ci", release: "crimeindex-20261101", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1960 };
const deps: ShadowDeps = { places, release: { id: "t", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" },
  target: { root: "/b", builtYears: [2022, 2023, 2024, 2025, 2026] }, execute: (sql: string) => (/crimeindex|agency_crime|agency_clearances/.test(sql) ? crimeIndex(sql) : nibrs(sql)), historical: build } as ShadowDeps;

/** Fixtures for each live source: the questions its answers are checked on. */
const FIXTURES: Record<string, string[]> = {
  nibrs: [
    "Shoplifting in Memphis in 2024", "Shoplifting in Memphis by month in 2024", "Shoplifting in Memphis by year from 2022 to 2025",
    "Simple assault victims in Memphis by sex in 2024", "Simple assault victims in Memphis by age in 2024", "Robberies in Memphis in 2024 by weapon",
    "Rolling 12-month shoplifting in Memphis since 2024", "Memphis robberies per month in 2024",
    "Shoplifting in Kansas by year from 2023 to 2024", "Shoplifting in Kansas in 2024, with the number of agencies reporting",
    "Shoplifting in Kansas by year from 2023 to 2024, only agencies that reported every month",
  ],
  historical: ["Murders in Memphis in 2023", "Murders in Memphis by year from 2022 to 2023", "Murder rate in Memphis in 2023"],
};
/** Choices and declines: their buttons are checked (9, 11). */
const CHOICES = ["Memphis crime in 2024", "Memphis crime per month in 2024", "Shoplifting in Memphis in 2027", "Shoplifting in Kansas City in 2024"];

/** RFC 4180 rows: quoted fields with doubled quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else f += ch;
  }
  return rows;
}
const SMALL = new Set(["by", "of", "per", "in", "on", "at", "to", "for", "with", "from", "vs", "as", "the", "a", "an", "or", "into"]);
const fail: string[] = [];
const check = (ok: boolean, what: string) => { if (!ok) fail.push(what); };
const shown = (p: Presentation) => [titleOf(p.titleParts).title, titleOf(p.titleParts).subtitle ?? "", ...leadOf(p).sentences,
  ...p.offers.flatMap((o) => (o.text ? [o.text.before + o.text.link + o.text.after] : [])), ...notesOf(p)].join(" ");
const answerOf = (o: ShadowOutcome): { table: ResultTable } | null => (o.kind === "answer" || o.kind === "historical" || o.kind === "srs" ? o.delivered : null);

// 10: complete profiles, every field filled, for each live source.
const FIELDS: (keyof SourceProfile)[] = ["units", "grain", "coverage", "rateBasis", "breakdowns", "caveats", "name"];
for (const [id, prof] of Object.entries(PROFILES) as [SourceId, SourceProfile][]) {
  for (const f of FIELDS) check(prof[f] !== undefined && prof[f] !== null, `10 ${id}: profile field ${f} missing`);
  check(prof.units.length > 0 && !!prof.name.short && !!prof.name.long && /^Source: .+\.$/.test(prof.name.sourceLine) && !!prof.name.reportedToLong, `10 ${id}: profile names or units empty`);
  check(id in FIXTURES, `10 ${id}: a live source with no fixtures`);
}

const sourcesSeen = new Set<string>();
for (const [want, questions] of Object.entries(FIXTURES)) {
  for (const q of questions) {
    const o = shadowAnswer(q, deps);
    const d = answerOf(o);
    if (!d) { fail.push(`fixture "${q}" did not answer (${o.kind}${o.kind === "decline" ? `: ${o.explanation}` : ""})`); continue; }
    const p = presentationOf(o, places) as Presentation;
    const tag = `[${p.source}] "${q}"`;
    sourcesSeen.add(p.source);
    check(p.source === want, `${tag}: answered from ${p.source}, fixture is ${want}'s`);
    const prof = PROFILES[p.source]!;
    // 1
    const { title } = titleOf(p.titleParts);
    check(!!title && title.startsWith(`${joinAmp(p.titleParts.places)} `) && !title.includes(":") && !/\.$/.test(title) && !/\band\b/.test(title)
      && title.slice(joinAmp(p.titleParts.places).length + 1).split(/\s+/).every((w, i) => i === 0 ? /^[A-Z0-9&–(]/.test(w) : SMALL.has(w) || /^[A-Z0-9&–(]/.test(w)), `1 ${tag}: title "${title}"`);
    // 2
    const lead = leadOf(p).sentences[0];
    check(p.lead.kind === "single" ? /\d/.test(lead) && !/^These are/.test(lead) : /^These are /.test(lead) && !/\d/.test(lead.replace(/\b(?:19|20)\d{2}\b|\b\d+-month\b|100,000/g, "")), `2 ${tag}: lead "${lead}"`);
    check(!/\bShowing\b/.test(lead), `2 ${tag}: "Showing" opener`);
    // 3
    check(leadOf(p).sentences.length <= 2 && (!p.caveat || (!p.notes.keys.includes(p.caveat) && !notesOf(p).includes(NOTE_TEXT[p.caveat as keyof typeof NOTE_TEXT]))), `3 ${tag}: more than one caveat, or repeated`);
    // 4
    const notes = notesOf(p);
    check(notes[notes.length - 1] === prof.name.sourceLine && notes.filter((n) => /^Source: /.test(n)).length === 1, `4 ${tag}: source line`);
    const words = shown(p);
    for (const b of BANNED) check(!b.re.test(words), `4 ${tag}: banned (${b.what})`);
    check(!/\bresidents?\b/i.test(words) && !/\b(?:sorry|apologi[sz]e|unfortunately|I'm afraid)\b/i.test(words), `4 ${tag}: banned word`);
    // 5
    const t = d.table;
    for (const h of p.ordered) {
      const i = t.columns.findIndex((c) => c.header === h);
      const col = t.columns[i];
      const vals = t.rows.map((r) => String(r[i]));
      const timeI = t.columns.findIndex((c) => c.binding.kind === "grouping" && c.binding.dimension.startsWith("time."));
      if (col.binding.kind === "grouping" && col.binding.dimension.startsWith("time.")) check(vals.every((v, j) => j === 0 || v >= vals[j - 1]), `5 ${tag}: ${h} out of order`);
      void timeI;
    }
    // Every category column, ordered or by count: the not-known categories last within each period, Unknown once.
    const timeCol = t.columns.findIndex((c) => c.binding.kind === "grouping" && c.binding.dimension.startsWith("time."));
    t.columns.forEach((col, i) => {
      if (col.binding.kind !== "grouping" || col.binding.dimension.startsWith("time.") || col.binding.dimension.startsWith("geo.")) return;
      const per = new Map<string, string[]>();
      t.rows.forEach((r) => { const k = timeCol >= 0 ? String(r[timeCol]) : ""; per.set(k, [...(per.get(k) ?? []), String(r[i])]); });
      for (const ls of per.values()) {
        const firstUnknown = ls.findIndex((v) => UNKNOWN_NAMES.has(v));
        check(ls.filter((v) => v === "Unknown").length <= 1 && (firstUnknown < 0 || ls.slice(firstUnknown).every((v) => UNKNOWN_NAMES.has(v))), `5 ${tag}: ${col.header}: not-known categories not last (${ls.join(", ")})`);
      }
    });
    // 13
    const per = (o as { period: { from: string; to: string } }).period;
    if (per.from.slice(0, 4) === per.to.slice(0, 4))
      check(!p.offers.some((x) => x.role === "consistent_agencies" || x.role === "all_agencies" || /change/.test(x.text?.before ?? "")), `13 ${tag}: a change caveat or consistent offer on one period`);
    // 12
    const dims = t.columns.flatMap((c) => (c.binding.kind === "grouping" ? [c.binding.dimension] : []));
    check(!missingGroupings(q, dims).length, `12 ${tag}: breakdown dropped (${missingGroupings(q, dims).join(", ")})`);
    // 6
    const c = p.chart;
    const hasTime = t.columns.some((x) => x.binding.kind === "grouping" && x.binding.dimension.startsWith("time."));
    check(!(p.lead.kind === "single" && c.allowed.length), `6 ${tag}: a chart for a single number`);
    check(!c.allowed.includes("line") || hasTime, `6 ${tag}: a line with no time grouping`);
    check(!(c.allowed.includes("stacked_bar") || c.allowed.includes("stacked_100")) || c.exclusive === true, `6 ${tag}: stacked when not exclusive`);
    check(c.default === null || c.allowed.includes(c.default), `6 ${tag}: default not allowed`);
    check(JSON.stringify(c) === JSON.stringify(chartOptionsOf(t, p.ordered)), `6 ${tag}: chart options not the shared builder's`);
    // 7
    const covCols = t.columns.some((x) => ["Agencies reporting", "Consistent Reporting Agencies", "Population covered"].includes(x.header));
    check(covCols === p.coverage.requested, `7 ${tag}: coverage columns ${covCols} but requested ${p.coverage.requested}`);
    // 8
    const csv = parseCsv(csvOf(t));
    check(JSON.stringify(csv) === JSON.stringify([t.columns.map((x) => x.header), ...t.rows.map((r) => r.map((v) => (v === null ? "" : String(v))))]), `8 ${tag}: CSV is not the table`);
    const png = pngSpecOf(p, t);
    check(png.title === title && png.sourceLine === prof.name.sourceLine && png.chart === c.default, `8 ${tag}: PNG spec`);
    // 9, 11
    for (const off of p.offers) {
      check(!!off.role && !!off.targetSource, `9 ${tag}: offer without role or source`);
      check(off.targetSource === p.source || ["other_source", "nearest_question", "choice"].includes(off.role), `9 ${tag}: ${off.role} to ${off.targetSource}`);
      check(!["consistent_agencies", "all_agencies"].includes(off.role) || !!prof.coverage.cohortView, `11 ${tag}: ${off.role} on a source with no consistent view`);
    }
    for (const k of [...(p.caveat ? [p.caveat] : []), ...p.notes.keys]) check(prof.caveats.includes(k), `11 ${tag}: note ${k} not in ${p.source}'s profile`);
    check(!p.titleParts.ratePer || prof.rateBasis !== undefined, `11 ${tag}: a rate with no rate basis`);
  }
}
for (const q of CHOICES) {
  const o = shadowAnswer(q, deps);
  const p = presentationOf(o, places) as ChoicePresentation;
  if (!("buttons" in p)) { fail.push(`choice fixture "${q}" answered`); continue; }
  for (const b of p.buttons) {
    check(!!b.role && !!b.targetSource, `9 "${q}": button without role or source`);
    check(b.targetSource === p.source || ["other_source", "nearest_question", "choice", "ask_instead"].includes(b.role), `9 "${q}": ${b.role} to ${b.targetSource}`);
    check(b.targetSource in PROFILES || ["rtci", "shr"].includes(b.targetSource), `9 "${q}": button to ${b.targetSource}`);
  }
}
for (const id of Object.keys(PROFILES)) check(sourcesSeen.has(id), `10 ${id}: no fixture answered from it`);

// The offers the checks above judge are really there (so 9 and 11 are not vacuous): past P88's threshold, the
// Consistent Reporting Agencies offer in Jeff's words; in that view, the way back; one year, the button without words.
const ks = presentationOf(shadowAnswer("Shoplifting in Kansas by year from 2023 to 2024", deps), places) as Presentation;
check(ks.offers.some((o) => o.role === "consistent_agencies" && o.text?.link === "see only the Consistent Reporting Agencies"
  && /^Not every agency reported in every year/.test(o.text.before) && o.text.after === " that reported every month from January 2023 through December 2024."), "P88 offer missing");
const ksEvery = presentationOf(shadowAnswer("Shoplifting in Kansas by year from 2023 to 2024, only agencies that reported every month", deps), places) as Presentation;
check(ksEvery.offers.some((o) => o.role === "all_agencies" && o.text?.before === "This counts only the 1 Consistent Reporting Agency that reported every month. " && o.text.link === "See all reporting agencies instead"), "the way back missing");
const ks1 = presentationOf(shadowAnswer("Shoplifting in Kansas in 2024", deps), places) as Presentation;
check(!ks1.offers.length && ks1.lead.kind === "single", "one year: no consistent-agencies offer, and a single number");
// A one-row answer with coverage columns beside it is still a single number (the redesign had guessed this).
const ksCov = presentationOf(shadowAnswer("Shoplifting in Kansas in 2024, with the number of agencies reporting", deps), places) as Presentation;
check(ksCov.lead.kind === "single" && ksCov.coverage.requested && !ksCov.offers.length, "one year with coverage columns: a single number, no offer");

assert.deepEqual(fail, [], fail.join("\n"));
console.log(`answer conformance: ${Object.values(FIXTURES).flat().length} answers and ${CHOICES.length} choices from ${Object.keys(PROFILES).length} sources pass the 13 checks`);
