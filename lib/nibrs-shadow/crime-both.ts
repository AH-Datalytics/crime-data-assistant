/**
 * P182 for two or more places (Coordinator 2026-11-22): "crimes in Washington DC compared to Baltimore" with no kind of crime named is
 * violent crime and property crime for each place. The compiler has no two-measure statement for several places, so, like the crime-over-time
 * composite, no statement of its own: the violent crime answer and the property crime answer the same question already gets are lined up.
 * Each is either a total by place (Agency | value) or a period series (several places side by side or long); the two must be the same shape,
 * kind, places, periods and source line, else null and the question keeps the path it has. Cells are the answers' own (a blank stays blank).
 */
import type { ResultTable } from "../nibrs-plan/result";
import { seriesOf, type PartAnswer } from "./crime-over-time";

type Column = ResultTable["columns"][number];
const stat = (c: Column | undefined) => !!c && c.binding.kind === "statistic";
const geo = (c: Column | undefined) => !!c && c.binding.kind === "grouping" && c.binding.dimension.startsWith("geo.");
const val = (v: unknown) => (typeof v === "number" ? v : null);
const src = (a: PartAnswer) => a.delivered.text[a.delivered.text.length - 1];
const TITLE = /\bViolent Crimes?(\s+Rates?)?\b/i;

/** The violent and property crime answers as one answer with both columns, or null. */
export function composeBoth(violent: PartAnswer, property: PartAnswer): PartAnswer | null {
  if (violent.kind !== property.kind || src(violent) !== src(property) || !/^Source:/.test(src(violent))) return null;
  const vc = violent.delivered.table.columns, pc = property.delivered.table.columns;
  const rate = /\brate|per 100,?000/i.test(vc[vc.length - 1]?.header ?? "") ? " per 100,000" : "";
  let columns: Column[], rows: (string | number | null)[][];
  if (vc.length === 2 && geo(vc[0]) && stat(vc[1]) && pc.length === 2 && geo(pc[0]) && stat(pc[1])) {
    // A total by place.
    const pv = new Map(property.delivered.table.rows.map((r) => [String(r[0]), val(r[1])]));
    const names = violent.delivered.table.rows.map((r) => String(r[0]));
    if (new Set(names).size !== names.length || names.length !== pv.size || names.some((n) => !pv.has(n))) return null;
    columns = [vc[0], { binding: { kind: "statistic", as: "violent_n" }, header: `Violent crime${rate}` }, { binding: { kind: "statistic", as: "property_n" }, header: `Property crime${rate}` }];
    rows = violent.delivered.table.rows.map((r) => [String(r[0]), val(r[1]), pv.get(String(r[0])) ?? null]);
  } else {
    const sv = seriesOf(violent), sp = seriesOf(property);
    if (!sv || !sp || sv.places.length < 2 || sv.places.length !== sp.places.length || sv.places.some((p, i) => p !== sp.places[i])) return null;
    const grain = sv.periodCol.binding.kind === "grouping" ? sv.periodCol.binding.dimension : "";
    if (!sp.periodCol.binding.kind || (sp.periodCol.binding.kind === "grouping" && sp.periodCol.binding.dimension !== grain)) return null;
    const periods = [...new Set([...sv.cells.keys(), ...sp.cells.keys()].map((k) => k.split("\u0000")[1]))].sort();
    columns = [sv.placeCol!, sv.periodCol, { binding: { kind: "statistic", as: "violent" }, header: `Violent crime${rate}` }, { binding: { kind: "statistic", as: "property" }, header: `Property crime${rate}` }];
    rows = sv.places.flatMap((pl) => periods.map((p) => [pl, p, sv.cells.get(`${pl}\u0000${p}`) ?? null, sp.cells.get(`${pl}\u0000${p}`) ?? null]));
  }
  if (rows.every((r) => r.slice(-2).every((x) => x === null))) return null;
  const title0 = violent.delivered.text[0] ?? "";
  const title = title0.replace(TITLE, (_m, r: string | undefined) => `Violent and Property Crime${r ? " Rate" : ""}`);
  if (title === title0) return null;
  const lines: string[] = [];
  for (const a of [violent, property]) for (const t of a.delivered.text.slice(1, -1)) if (!lines.includes(t)) lines.push(t);
  return {
    ...violent,
    meaning: { ...violent.meaning, measures: [...violent.meaning.measures, ...property.meaning.measures] },
    delivered: { ...violent.delivered, table: { columns, rows } as ResultTable, text: [title, ...lines, src(violent)] },
  };
}
