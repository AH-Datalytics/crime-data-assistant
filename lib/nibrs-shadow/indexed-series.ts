/**
 * P206 (Jeff 2026-11-22, "Compute it"): a series "indexed to 100 in <year>" ("indexed to <year>", "indexed to the earliest date").
 *
 * No statement of its own: the plain question (the index words taken out) is answered as usual, and when that answer is a period
 * series (Crime Index by year, Current Trends rolling months), each place's figure in a period is divided by its own figure in the
 * base period, times 100, one decimal. The table keeps the raw figures beside the index and one line says how. A place whose base
 * figure is blank or zero has no index, and a line says so. Source and rules are the plain series' own (P01, P14, P154); any other
 * answer (a decline, an ask, a ranking) is returned as null so the question keeps the path it has.
 */
import type { ResultTable } from "../nibrs-plan/result";
import { seriesOf, type PartAnswer } from "./crime-over-time";

export const INDEXED = /,?\s*\b(?:(?:both|each)\s+)?(?:are\s+)?(?:indexed|benchmarked)\s+(?:to|at)\s+(?:100\s+(?:in|at|for|=)\s+)?(?:the\s+)?(earliest\s+(?:date|period|year|point)(?:\s+(?:you\s+have|available|with\s+data))?|\d{4}(?:\s+levels?)?)\b(?:\s*\((?:i\.e\.|e\.g\.)[^)]*\))?/i;

type Column = ResultTable["columns"][number];

/** The index words and the base asked: "earliest" or a year; null when the question has none. */
export function readIndexed(question: string): { plain: string; base: "earliest" | string } | null {
  const m = INDEXED.exec(question);
  if (!m) return null;
  const plain = question.replace(m[0], " ").replace(/\bfor\s+the\s+cit(?:y|ies)\s+(?=[A-Z])/, "for ").replace(/\s+/g, " ").replace(/\s+([?.!,])/g, "$1").trim();
  return { plain, base: /earliest/i.test(m[1]) ? "earliest" : m[1].slice(0, 4) };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** The indexed answer for a plain series answer, or null when it is not a series this can index. */
export function composeIndexed(a: PartAnswer, base: "earliest" | string, rolling: boolean): PartAnswer | null {
  const s = seriesOf(a);
  if (!s) return null;
  const grain = s.periodCol.binding.kind === "grouping" ? s.periodCol.binding.dimension : "";
  const yearly = grain === "time.year";
  if (!yearly && !(grain === "time.month" && rolling)) return null;
  const periods = [...new Set([...s.cells.keys()].map((k) => k.split("\u0000")[1]))].sort();
  const at = (p: string, period: string) => s.cells.get(`${p}\u0000${period}`) ?? null;
  // The base period: the year named (a rolling twelve-month figure: the one ending that December), or the first period every place has.
  let basePeriod: string | undefined;
  if (base === "earliest") basePeriod = periods.find((p) => s.places.every((pl) => at(pl, p) !== null));
  else basePeriod = yearly ? periods.find((p) => p === base || p.startsWith(base)) : periods.find((p) => p === `${base}-12`);
  if (!basePeriod) return null;
  const baseOf = new Map(s.places.map((pl) => [pl, at(pl, basePeriod!)]));
  const noIndex = s.places.filter((pl) => { const b = baseOf.get(pl); return b === null || b === undefined || b === 0; });
  if (noIndex.length === s.places.length) return null;
  const several = s.places.length > 1;
  const index = (pl: string, period: string) => {
    const b = baseOf.get(pl), v = at(pl, period);
    return b && v !== null ? round1((v / b) * 100) : null;
  };
  const baseLabel = base === "earliest" ? basePeriod : base;
  const statHeader = (pl: string) => (a.delivered.table.columns.length > 1 ? (a.delivered.table.columns[several ? s.places.indexOf(pl) + 1 : 1].header) : "Figure");
  const columns: Column[] = [s.periodCol];
  s.places.forEach((pl, i) => {
    columns.push({ binding: { kind: "statistic", as: `value_${i}` }, header: several ? `${pl}: figure` : statHeader(pl) });
    columns.push({ binding: { kind: "statistic", as: `index_${i}` }, header: several ? `${pl}: index (${baseLabel} = 100)` : `Index (${baseLabel} = 100)` });
  });
  const rows = periods.map((period) => [period, ...s.places.flatMap((pl, i) => [at(pl, period), index(pl, period)])]);
  const text = [...a.delivered.text];
  const src = text.length && /^Source:/.test(text[text.length - 1]) ? text.pop()! : null;
  text[0] = `${text[0]}, Indexed to 100 in ${baseLabel}`;
  text.push(`Each place's figure divided by its own ${baseLabel} figure, times 100.`);
  if (noIndex.length) text.push(`${noIndex.join(" and ")} ${noIndex.length > 1 ? "have" : "has"} no ${baseLabel} figure, so no index.`);
  if (src) text.push(src);
  return { ...a, delivered: { ...a.delivered, table: { columns, rows } as ResultTable, text } };
}
