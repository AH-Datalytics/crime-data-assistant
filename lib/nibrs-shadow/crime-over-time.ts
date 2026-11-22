/**
 * Crime in a place over time (Coordinator 2026-11-21, Jeff approved; shape agreed with Engine 2.0; extends P148): "crime",
 * "overall crime", "all crimes" or a crime trend for one or several places, by year (Crime Index) or by month (Current
 * Trends), as violent crime and property crime beside their sum (the Part I total) and the seven Part I offenses.
 *
 * No statement of its own: the answer is built from the answers the same question already gets for each of the nine
 * measures, lined up by period (and place). So the source, the period, the published totals, every blank cell and every
 * note are those answers' own. One source per answer: the nine must be answers of the same kind (Crime Index by year,
 * or Current Trends by month), each a period series for the same places; otherwise null and the question keeps the path
 * it has today. A blank cell is a blank cell (the legacy rape gap), never a reason to decline.
 *
 * Columns: the period (or Place, then the period), Violent crime, Property crime, Part I crime (counts only: their sum,
 * blank when either is; omitted for rates, Engine 2.0 2026-11-21: summed rounded rates are not the Part I rate), then
 * Murder, Rape, Robbery, Aggravated assault, Burglary, Larceny-theft, Motor vehicle theft. The chart is violent and
 * property crime (one place) or violent crime, one line per place (several): COMPOSITE_TABLE_ONLY.
 */
import type { ResultTable } from "../nibrs-plan/result";

export const COMPOSITE_PARTS: { measure: string; words: string; as: string; header: string }[] = [
  { measure: "violent_crime", words: "violent crime", as: "violent", header: "Violent crime" },
  { measure: "property_crime", words: "property crime", as: "property", header: "Property crime" },
  { measure: "murder", words: "murder", as: "murder", header: "Murder" },
  { measure: "rape", words: "rape", as: "rape", header: "Rape" },
  { measure: "robbery", words: "robbery", as: "robbery", header: "Robbery" },
  { measure: "aggravated_assault", words: "aggravated assault", as: "aggravated_assault", header: "Aggravated assault" },
  { measure: "burglary", words: "burglary", as: "burglary", header: "Burglary" },
  { measure: "theft", words: "larceny", as: "theft", header: "Larceny-theft" },
  { measure: "motor_vehicle_theft", words: "motor vehicle theft", as: "motor_vehicle_theft", header: "Motor vehicle theft" },
];
/** Statistics of a composite shown in the table only (chartOptionsOf's tableOnly): the Part I sum and the seven offenses. */
export const COMPOSITE_TABLE_ONLY = ["part_one", ...COMPOSITE_PARTS.slice(2).map((p) => p.as)];
/** Several places: the chart is violent crime only, one line per place (P186). */
export const COMPOSITE_TABLE_ONLY_SEVERAL = [...COMPOSITE_TABLE_ONLY, "property"];
export const COMPOSITE_SEVERAL_NOTE = "The chart shows violent crime; the table has every column.";
/** A delivered table is a composite when it has the violent and property columns this module writes. */
export const isComposite = (t: ResultTable) => ["violent", "property"].every((as) => t.columns.some((c) => c.binding.kind === "statistic" && c.binding.as === as));
/** The statistics a table shows but never charts: a composite's (several places when it has a Place column); none otherwise. */
export const compositeTableOnly = (t: ResultTable): string[] => (!isComposite(t) ? []
  : t.columns.some((c) => c.binding.kind === "grouping" && c.binding.dimension.startsWith("geo.")) ? COMPOSITE_TABLE_ONLY_SEVERAL : COMPOSITE_TABLE_ONLY);

const SOURCE = "Source: Crime Index.";
type Column = ResultTable["columns"][number];
export type PartAnswer = { kind: string; delivered: { table: ResultTable; text: string[] }; meaning: { measures: unknown[] } & Record<string, unknown>; question?: unknown } & Record<string, unknown>;
type Series = { kind: string; periodCol: Column; placeCol: Column | null; places: string[]; cells: Map<string, number | null> };
const key = (place: string, period: string) => `${place}\u0000${period}`;

/**
 * One measure's answer as a series: a period column and one value (one place); a period column and one value per place
 * (Crime Index several agencies, `x.<i>`); or Place, period and one value (Current Trends several agencies). Null for any
 * other table (a ranking, a total, a breakdown).
 */
function seriesOf(a: PartAnswer): Series | null {
  const cols = a.delivered.table.columns, rows = a.delivered.table.rows;
  const isTime = (c: Column | undefined) => !!c && c.binding.kind === "grouping" && /^time\.(?:year|month)$/.test(c.binding.dimension);
  const stat = (c: Column) => c.binding.kind === "statistic";
  const val = (v: unknown) => (typeof v === "number" ? v : null);
  // [place, period, value] for every cell, and the table's shape.
  let cells: [string, string, number | null][], periodCol: Column, placeCol: Column | null, places: string[];
  if (isTime(cols[0]) && cols.length === 2 && stat(cols[1])) {
    cells = rows.map((r) => ["", String(r[0]), val(r[1])]);
    periodCol = cols[0]; placeCol = null; places = [""];
  } else if (isTime(cols[0]) && cols.length > 2 && cols.slice(1).every(stat)) {
    // Several places side by side: each column's place, by the question's agencies or the header before ": ".
    const agencies = ((a.question as { agencies?: { name: string }[] } | undefined)?.agencies) ?? [];
    places = cols.slice(1).map((c, i) => (agencies.length === cols.length - 1 ? agencies[i].name : c.header.split(": ")[0]));
    cells = rows.flatMap((r) => places.map((p, i): [string, string, number | null] => [p, String(r[0]), val(r[i + 1])]));
    periodCol = cols[0]; placeCol = { binding: { kind: "grouping", dimension: "geo.agency" }, header: "Place" };
  } else if (cols.length === 3 && cols[0].binding.kind === "grouping" && cols[0].binding.dimension.startsWith("geo.") && isTime(cols[1]) && stat(cols[2])) {
    cells = rows.map((r) => [String(r[0]), String(r[1]), val(r[2])]);
    periodCol = cols[1]; placeCol = cols[0]; places = [...new Set(cells.map((c) => c[0]))];
  } else return null;
  if (new Set(places).size !== places.length) return null;
  // A period twice for one place is not a series: one of the two would be dropped silently, so null and the question keeps its path.
  const map = new Map<string, number | null>();
  for (const [p, period, v] of cells) { if (map.has(key(p, period))) return null; map.set(key(p, period), v); }
  return { kind: a.kind, periodCol, placeCol, places, cells: map };
}

/**
 * The composite of the nine answers (in COMPOSITE_PARTS order), or null when they are not series of one source for the
 * same places at the same grain; `{ kind: "none" }` when every cell is blank. `rate`: the answers are rates (no Part I).
 */
export function composeCrimeOverTime(answers: PartAnswer[], rate: boolean): PartAnswer | { kind: "none"; label: string } | null {
  if (answers.length !== COMPOSITE_PARTS.length) return null;
  const series = answers.map(seriesOf);
  if (series.some((s) => !s)) return null;
  const all = series as Series[];
  const first = all[0];
  const grain = first.periodCol.binding.kind === "grouping" ? first.periodCol.binding.dimension : "";
  if (!all.every((s) => s.kind === first.kind && s.periodCol.binding.kind === "grouping" && s.periodCol.binding.dimension === grain
    && s.places.length === first.places.length && s.places.every((p, i) => p === first.places[i]))) return null;
  // The periods of every series (a series may start later: its own answer says where it starts), in order.
  const periods = [...new Set(all.flatMap((s) => [...s.cells.keys()].map((k) => k.split("\u0000")[1])))].sort();
  const several = first.places.length > 1;
  const at = (s: Series, place: string, period: string) => s.cells.get(key(place, period)) ?? null;
  const rows: (string | number | null)[][] = [];
  for (const place of first.places) for (const period of periods) {
    const v = at(all[0], place, period), p = at(all[1], place, period);
    rows.push([...(several ? [place] : []), period, v, p, ...(rate ? [] : [v !== null && p !== null ? v + p : null]), ...all.slice(2).map((s) => at(s, place, period))]);
  }
  const lead = several ? 2 : 1;
  if (rows.every((r) => r.slice(lead).every((x) => x === null))) {
    const q = answers[0].question as { place?: { label?: string }; agencies?: { label: string }[] } | undefined;
    return { kind: "none", label: several ? "these places" : q?.place?.label ?? q?.agencies?.[0]?.label ?? (answers[0].delivered.text[0] ?? "").split(" Violent")[0] };
  }
  const head = (h: string) => (rate ? `${h} per 100,000` : h);
  const columns: Column[] = [...(several ? [first.placeCol!] : []), first.periodCol,
    ...COMPOSITE_PARTS.slice(0, 2).map((x) => ({ binding: { kind: "statistic" as const, as: x.as }, header: head(x.header) })),
    ...(rate ? [] : [{ binding: { kind: "statistic" as const, as: "part_one" }, header: "Part I crime" }]),
    ...COMPOSITE_PARTS.slice(2).map((x) => ({ binding: { kind: "statistic" as const, as: x.as }, header: head(x.header) }))];
  // Title: the violent answer's, naming violent and property crime.
  const title0 = answers[0].delivered.text[0] ?? "";
  const title = title0.replace(/\bViolent Crimes?( Rates?)? Per\b/i, (_m, r: string | undefined) => `Violent and Property Crime${r ? " Rate" : ""} Per`);
  if (title === title0) return null;
  // Notes: every answer's lines after its title, the source last. A line every answer has is said once; another line keeps
  // the crime it names, or is prefixed with its column when it names none (Engine 2.0 2026-11-21, note b).
  const notes: string[] = [];
  const own = answers.map((a) => a.delivered.text.slice(1).filter((t) => t !== SOURCE));
  const NAMES = /\b(?:violent|property|murders?|rapes?|robber(?:y|ies)|aggravated assaults?|assaults?|burglar(?:y|ies)|larceny|thefts?|motor vehicle)\b/i;
  own.forEach((lines, i) => {
    for (const t of lines) {
      const shared = own.every((o) => o.includes(t));
      const line = shared || NAMES.test(t) ? t : `${COMPOSITE_PARTS[i].header}: ${t}`;
      if (!notes.includes(line)) notes.push(line);
    }
  });
  // Lines the same but for the one crime they name are one line naming the crimes ("Crime Index has no violent crime, murder and
  // robbery figures for Houston, Texas in 1931, shown blank."), with no crime named when every column's line is there.
  const CRIME = /\b(motor vehicle theft|aggravated assault|violent crime|property crime|murder|rape|robbery|burglary|theft)\b/gi;
  const templateOf = (t: string) => { const found = t.match(CRIME); return found && found.length === 1 ? { crime: found[0], template: t.replace(CRIME, "{}").replace(/\{\} (figure|rate)s?\b/, "{} $1") } : null; };
  const byTemplate = new Map<string, string[]>();
  for (const t of notes) { const x = templateOf(t); if (x) byTemplate.set(x.template, [...(byTemplate.get(x.template) ?? []), x.crime]); }
  const and = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const merged: string[] = [];
  for (const t of notes) {
    const x = templateOf(t);
    const crimes = x ? byTemplate.get(x.template) : undefined;
    if (!x || !crimes || crimes.length === 1) { if (!x || crimes) merged.push(t); continue; }
    byTemplate.delete(x.template);   // said once, at its first line
    merged.push(crimes.length === COMPOSITE_PARTS.length ? x.template.replace(/\{\} (figure|rate)\b/, "$1s").replace("{} ", "")
      : x.template.replace(/\{\} (figure|rate)\b/, `${and(crimes)} $1s`).replace("{}", and(crimes)));
  }
  notes.splice(0, notes.length, ...merged);
  if (several) notes.push(COMPOSITE_SEVERAL_NOTE);
  const base = answers[0];
  return {
    ...base,
    meaning: { ...base.meaning, measures: answers.flatMap((a) => a.meaning.measures) },
    delivered: { ...base.delivered, table: { columns, rows }, text: [title, ...notes, SOURCE] },
  };
}
