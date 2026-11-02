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
 *  13  a single-period answer has no reporting-change caveat and no consistent-agencies offer, in the presentation
 *      and in the buttons the page renders
 *  14  every offer runs: a button path the outcome follows, or a question that answers
 *  15  nothing the engine says is lost: every line of its text is the restated headline or reporter line, in the
 *      lead, or in the notes
 *  16  the coverage columns never change the chart: the same answer with and without them has the same chart options
 */
import assert from "node:assert/strict";
import { chartOptionsOf, csvOf, joinAmp, leadOf, notesOf, pngSpecOf, PROFILES, titleOf, NOTE_TEXT, type ChoicePresentation, type Presentation,
  type SourceId, type SourceProfile } from "../lib/answer-contract/contract";
import { shadowAnswer, type ShadowDeps, type ShadowOutcome } from "../lib/nibrs-shadow/answer";
import { presentationOf, sourceOf } from "../lib/nibrs-shadow/presentation";
import { follow, toPreview } from "../lib/nibrs-shadow/preview";
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
    rows.push(/^[A-Z]{2}0000002$/.test(o) && y < 2024 ? [o, ym, null, "UNKNOWN"] : [o, ym, 5, "VALUE"]);
  }
  return rows;
}
function stateSum(sql: string): unknown[][] | null {
  if (sql.includes("agency/data.parquet")) {
    const years = /data_year IN \(([\d, ]+)\)/.exec(sql)![1].split(", ").map(Number);
    const hdr = /u\.state_abbr IN \(([^)]*)\)/.exec(sql);
    // Kansas, and Nebraska, whose second agency has no FBI population (no rate can be given).
    const st = hdr ? hdr[1].split(", ")[0].slice(1, -1) : "KS";
    const oris = hdr ? [`${st}0000001`, `${st}0000002`] : [...sql.matchAll(/'([A-Z]{2}[A-Z0-9]{7})'/g)].map((m) => m[1]);
    const pop = (o: string) => (o === "NE0000002" ? null : 100_000);
    return oris.flatMap((o) => years.map((y) => (hdr ? [o, y, pop(o), st] : [o, y, pop(o), "", o.slice(0, 2)])));
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
  // A breakdown by month, quarter or year (coordinator 2026-11-02): each period's categories, Unknown the largest.
  if (/cats AS/.test(sql) && /AS period/.test(sql)) {
    const periods = /'-Q'/.test(sql) ? [...new Set(months.map((m) => `${m.slice(0, 4)}-Q${Math.floor((Number(m.slice(5, 7)) - 1) / 3) + 1}`))]
      : /substr\(ym, 1, 4\) AS period/.test(sql) ? [...new Set(months.map((m) => m.slice(0, 4)))] : months;
    return periods.flatMap((p) => [[p, "U", 40, "VALUE", 0.444, "VALUE"], [p, "F", 30, "VALUE", 0.333, "VALUE"], [p, "M", 20, "VALUE", 0.222, "VALUE"]]);
  }
  if (/substr\(ym, 1, 4\) AS period/.test(sql)) return [...new Set(months.map((m) => m.slice(0, 4)))].map((y) => [y, 7 * months.filter((m) => m.startsWith(y)).length, "VALUE"]);
  if (/AS period/.test(sql)) return months.map((m) => [m, 7, "VALUE"]);
  return [[7 * months.length, "VALUE"]];
}
// Historical stub: Memphis's murders and robberies as published, 2022-2023.
function crimeIndex(sql: string): unknown[][] {
  if (/agency_clearances/.test(sql)) return [];
  const years = /year IN \((\d{4}), (\d{4})\)/.exec(sql);
  const rows = [[2022, 252, 40.3, 624944], [2023, 351, 57.0, 616061]];
  // Every agency asked gets the same figures (several places side by side).
  const oris = [...sql.matchAll(/'([A-Z]{2}[A-Z0-9]{7})'/g)].map((m) => m[1]);
  return oris.flatMap((o) => rows.filter(([y]) => !years || y === Number(years[1]) || y === Number(years[2])).map(([y, t, c, p]) => (years ? [y, t] : [o, y, t, c, p])));
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
    "Shoplifting in Kansas by year from 2023 to 2024, only agencies that reported every month", "Drug crimes in Memphis in 2024",
    "Shoplifting in Memphis in March 2024",
    // Codex contract confirmation 01: a missing rate keeps its explanation beside the agencies column; the way back
    // from a typed consistent view stays on NIBRS.
    "Shoplifting rate in Nebraska in 2024, with the number of agencies reporting",
    "Murder in Kansas by year from 2023 to 2024, only agencies that reported every month",
    // Jeff 2026-11-02: a breakdown by month or quarter (Unknown last within each period; the month order kept).
    "Simple assault victims in Memphis by sex and month in 2024", "Simple assault victims in Memphis by sex by quarter in 2024",
    "Simple assault victims in Memphis by sex and year from 2023 to 2024",
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
const answerOf = (o: ShadowOutcome): { table: ResultTable; text: string[]; headline?: string } | null => (o.kind === "answer" || o.kind === "historical" || o.kind === "srs" ? o.delivered : null);

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
    const p = presentationOf(o, places, { question: q, path: [] }) as Presentation;
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
    // Every text field shown: title, lead, offers, notes, the table's headers and text cells, the legend labels, and the
    // engine's own lines (coordinator 2026-11-02: "resident" anywhere is a failure).
    const words = [shown(p), ...d.table.columns.map((x) => x.header), ...d.table.rows.flatMap((r) => r.filter((v) => typeof v === "string")), ...Object.values(p.series), ...d.text].join(" ");
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
      else if (o.kind === "answer" && col.binding.kind === "grouping") {
        const dim = col.binding.dimension;
        const bins = o.plan.groupings.find((g) => g.dimension === dim)?.bins?.map((b) => b.label) ?? [];
        const per = new Map<string, number[]>();
        t.rows.forEach((r, j) => { const k = timeI >= 0 ? String(r[timeI]) : ""; if (bins.includes(vals[j])) per.set(k, [...(per.get(k) ?? []), bins.indexOf(vals[j])]); });
        for (const ix of per.values()) check(ix.every((x, j) => j === 0 || x > ix[j - 1]), `5 ${tag}: ${h} bins out of order`);
      }
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
    if (per.from.slice(0, 4) === per.to.slice(0, 4)) {
      check(!p.offers.some((x) => x.role === "consistent_agencies" || x.role === "all_agencies" || /\bchange\b/.test(x.text?.before ?? "")), `13 ${tag}: a change caveat or consistent offer on one period`);
      const shownButtons = toPreview(o, [], places, q);
      check(!(shownButtons.kind === "answer" && shownButtons.buttons.some((b) => b.label === "Consistent Reporting Agencies")), `13 ${tag}: the page still renders the consistent-agencies button`);
    }
    // 14
    for (const off of p.offers) {
      if ("path" in off.run) {
        const r = follow(o, off.run.path);
        check(r !== null, `14 ${tag}: offer "${off.label}" path does not resolve`);
      } else if ("question" in off.run) {
        const r = shadowAnswer(off.run.question, deps);
        check(r.kind !== "decline" && (r.kind === "clarify" || sourceOf(r) === off.targetSource), `14 ${tag}: offer "${off.label}" question ${r.kind === "decline" ? "declines" : `lands on ${sourceOf(r)}, not ${off.targetSource}`}`);
      } else check(!!off.run.input, `14 ${tag}: offer "${off.label}" asks for nothing`);
    }
    // 15
    const said = new Set([...leadOf(p).sentences, ...notesOf(p)]);
    const headline = (d as { headline?: string }).headline ?? d.text[0];
    for (const line of d.text)
      check(said.has(line) || (line === headline && t.rows.some((r) => r.some((v) => typeof v === "number"))) || /^(?:Reported by|Figures for) /.test(line), `15 ${tag}: engine line lost: "${line}"`);
    // 12
    const dims = t.columns.flatMap((c) => (c.binding.kind === "grouping" ? [c.binding.dimension] : []));
    check(!missingGroupings(q, dims).length, `12 ${tag}: breakdown dropped (${missingGroupings(q, dims).join(", ")})`);
    // 6
    const c = p.chart;
    const hasTime = t.columns.some((x) => x.binding.kind === "grouping" && x.binding.dimension.startsWith("time."));
    check(!(p.lead.kind === "single" && c.allowed.length), `6 ${tag}: a chart for a single number`);
    check(!c.allowed.includes("line") || hasTime, `6 ${tag}: a line with no time grouping`);
    check(!(c.allowed.includes("stacked_bar") || c.allowed.includes("stacked_100")) || c.exclusive === true, `6 ${tag}: stacked when not exclusive`);
    const catDims = t.columns.flatMap((x) => (x.binding.kind === "grouping" && !x.binding.dimension.startsWith("time.") && !x.binding.dimension.startsWith("geo.") ? [x.binding.dimension] : []));
    const profExclusive = catDims.length > 0 && catDims.every((dm) => prof.breakdowns.some((b) => b.dimension === dm && b.exclusive));
    check(!(c.allowed.includes("stacked_bar") || c.allowed.includes("stacked_100")) || profExclusive, `6 ${tag}: stacked though the profile doesn't mark every breakdown exclusive`);
    check(c.default === null || c.allowed.includes(c.default), `6 ${tag}: default not allowed`);
    const tableOnly = o.kind === "answer" ? o.plan.statistics.filter((x) => ["agencies", "coverage", "population", "incidents"].includes(x.kind)).map((x) => x.as) : [];
    check(JSON.stringify(c) === JSON.stringify(chartOptionsOf(t, p.ordered, tableOnly)), `6 ${tag}: chart options not the shared builder's`);
    // Legend labels in the title's form: no colon, no measure words after the place.
    for (const [h, label] of Object.entries(p.series)) check(t.columns.some((x) => x.header === h) && !label.includes(":"), `6 ${tag}: series label "${label}" for "${h}"`);
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
const ks = presentationOf(shadowAnswer("Shoplifting in Kansas by year from 2023 to 2024", deps), places, { question: "Shoplifting in Kansas by year from 2023 to 2024", path: [] }) as Presentation;
check(ks.offers.some((o) => o.role === "consistent_agencies" && o.text?.link === "see only the Consistent Reporting Agencies"
  && /^Not every agency reported in every year/.test(o.text.before) && o.text.after === " that reported every month from January 2023 through December 2024."), "P88 offer missing");
const ksEvery = presentationOf(shadowAnswer("Shoplifting in Kansas by year from 2023 to 2024, only agencies that reported every month", deps), places, { question: "Shoplifting in Kansas by year from 2023 to 2024, only agencies that reported every month", path: [] }) as Presentation;
// The way back from the consistent view, reached by its button: one step back along the path.
const viaButton = shadowAnswer("Shoplifting in Kansas by year from 2023 to 2024", deps);
const clicked = follow(viaButton, ["Consistent Reporting Agencies"])!;
const back = (presentationOf(clicked, places, { question: "Shoplifting in Kansas by year from 2023 to 2024", path: ["Consistent Reporting Agencies"] }) as Presentation).offers.find((x) => x.role === "all_agencies");
check(!!back && "path" in back.run && back.run.path.length === 0 && follow(viaButton, back.run.path) === viaButton, "the way back by path");
check(ksEvery.offers.some((o) => o.role === "all_agencies" && o.text?.before === "This counts only the 1 Consistent Reporting Agency that reported every month. " && o.text.link === "See all reporting agencies instead"), "the way back missing");
// A series whose first months have no report starts at the first reported one, and the engine says so in the words the
// page shows (owner 2026-10-31; engine-side 2026-11-02).
{
  const gap = (sql: string) => { const r = deps.execute(sql); return /AS period/.test(sql) && !/cats AS/.test(sql) ? r.map((x, i) => (i < 2 ? [x[0], null, "UNKNOWN"] : x)) : r; };
  const o = shadowAnswer("Shoplifting in Memphis by month in 2024", { ...deps, execute: gap });
  const rows = o.kind === "answer" ? o.delivered.table.rows : [];
  const p = presentationOf(o, places) as Presentation;
  check(rows[0]?.[0] === "2024-03" && rows.length === 10, `the leading gap is left out: ${JSON.stringify(rows.slice(0, 2))}`);
  check(notesOf(p).includes("No report is known for January 2024 to February 2024, so the chart and table start at March 2024."), `the leading-gap note: ${notesOf(p).join(" / ")}`);
}
// 16: the coverage columns are table-only (coordinator 2026-11-02).
for (const [plain, withCov] of [["Shoplifting in Kansas by year from 2023 to 2024", "Shoplifting in Kansas by year from 2023 to 2024, with the number of agencies reporting"],
  ["Shoplifting in Kansas in 2024", "Shoplifting in Kansas in 2024, with the number of agencies reporting"]]) {
  const a = presentationOf(shadowAnswer(plain, deps), places) as Presentation, b = presentationOf(shadowAnswer(withCov, deps), places) as Presentation;
  check(JSON.stringify(a.chart) === JSON.stringify(b.chart) && b.coverage.requested && !a.coverage.requested, `16 "${withCov}": the coverage columns changed the chart`);
}
// Places compared by year: each column's legend label is the place in the title's form.
{
  const p = presentationOf(shadowAnswer("Murders in Memphis and Nashville by year from 2022 to 2023", deps), places) as Presentation;
  check(JSON.stringify(Object.values(p.series ?? {})) === JSON.stringify(["Memphis, TN", "Nashville, TN"]), `series labels: ${JSON.stringify(p.series)}`);
}
// Codex month review 01.1: a quarter running past the release's last month is blank, never a sum of fewer months.
{
  const o = shadowAnswer("Simple assault victims in Memphis by sex by quarter in 2026", { ...deps, release: { ...deps.release, lastMonth: "2026-08" } });
  const rows = o.kind === "answer" ? o.delivered.table.rows : [];
  check(rows.length > 0 && rows.filter((r) => r[0] === "2026-Q3").every((r) => r[2] === null) && rows.filter((r) => r[0] === "2026-Q2").every((r) => typeof r[2] === "number"), `a quarter past the cutoff: ${JSON.stringify(rows)}`);
}
const ks1 = presentationOf(shadowAnswer("Shoplifting in Kansas in 2024", deps), places) as Presentation;
check(!ks1.offers.length && ks1.lead.kind === "single", "one year: no consistent-agencies offer, and a single number");
// A one-row answer with coverage columns beside it is still a single number (the redesign had guessed this).
const ksCov = presentationOf(shadowAnswer("Shoplifting in Kansas in 2024, with the number of agencies reporting", deps), places) as Presentation;
check(ksCov.lead.kind === "single" && ksCov.coverage.requested && !ksCov.offers.length, "one year with coverage columns: a single number, no offer");

// Codex contract confirmation 01.1: a missing result keeps its explanation even with numbers beside it (the agencies
// reporting): the rate blanked, its headline must stay a note.
{
  const o = shadowAnswer("Shoplifting rate in Nebraska in 2024, with the number of agencies reporting", deps);
  if (o.kind !== "answer") fail.push("missing-rate fixture did not answer");
  else {
    const blank = { ...o, delivered: { ...o.delivered, headline: "Nebraska: no rate is given for 2024.", text: ["Nebraska: no rate is given for 2024.", ...o.delivered.text.slice(1)],
      table: { ...o.delivered.table, rows: o.delivered.table.rows.map((r) => [null, ...r.slice(1)]) } } };
    const p = presentationOf(blank, places, { question: "q", path: [] }) as Presentation;
    check(notesOf(p).includes("Nebraska: no rate is given for 2024.") && p.lead.kind === "described", "a blank rate beside the agencies column lost its explanation");
  }
}
assert.deepEqual(fail, [], fail.join("\n"));
console.log(`answer conformance: ${Object.values(FIXTURES).flat().length} answers and ${CHOICES.length} choices from ${Object.keys(PROFILES).length} sources pass the 16 checks`);
