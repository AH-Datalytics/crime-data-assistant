/**
 * Blind verification of new answers (process approved by Jeff, 2026-11-07: every PR's new answers are verified on the
 * runner). A request names what an answer claims (the question, its source, places, period, measure and every number
 * with where it sits in the table) and never the engine's SQL, so the queries that check it are written from the
 * build's schema and manifest alone. A request whose numbers all match becomes a qlog-verified.json entry at the
 * answer's table digest. Format: the 2026-11-06 request files.
 */
import { tableDigest } from "./table-digest";

export type VerifyLabel = { id: string; tab: string; kind: string; times: number; question: string; previous: string | null };
export type VerifyNumber = { column: string; binding: unknown; at: Record<string, unknown>; value: unknown };
export type VerifyRequest = {
  id: string; tab: string; times_asked: number; question: string; follow_up_of: string | null; source: string;
  measure: string | null; statistic: string | null; grain: string | null; places: unknown[]; combine: string | null;
  period: { from: string; to: string } | null; filters: unknown; groupings: unknown; nibrs_plan: unknown; engine_read: unknown;
  numbers: VerifyNumber[]; digest: string; verifiable: boolean; note: string;
};

type Column = { binding: { kind: string; dimension?: string; as?: string }; header: string };
type Table = { columns: Column[]; rows: unknown[][] };
// The outcome as the shadow engine returns it; only the fields a request names are read.
type Outcome = { kind: string; delivered?: { table?: Table; text?: string[] }; period?: { from: string; to: string }; meaning?: { measures?: { name: string }[]; statistic?: string; places?: unknown[]; groupings?: string[] };
  question?: Record<string, unknown>; read?: unknown; plan?: Record<string, unknown> };

/** Anything named "sql" is left out, at any depth: a request never shows the engine's query. */
function withoutSql(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutSql);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !/sql/i.test(k)).map(([k, x]) => [k, withoutSql(x)]));
  return v;
}

// A NIBRS answer's measure and statistic live in its plan: the first measure's name and the first statistic's kind, plus
// its transforms ("count" with a "rolling" transform is the rolling count, so the checker is told).
const planMeasure = (plan?: Record<string, unknown>) => ((plan?.measures as { as?: string; id?: string }[] | undefined)?.[0]?.as ?? (plan?.measures as { id?: string }[] | undefined)?.[0]?.id) ?? null;
const planStatistic = (plan?: Record<string, unknown>) => {
  const kind = (plan?.statistics as { kind?: string }[] | undefined)?.[0]?.kind;
  const transforms = ((plan?.transforms as { kind?: string }[] | undefined) ?? []).map((t) => t.kind).filter(Boolean);
  return kind ? [kind, ...transforms].join("+") : null;
};

const SOURCE: Record<string, string> = { answer: "nibrs", srs: "crimeindex_state_national", current: "current_trends" };

/** The request for one answered label, or null for an outcome that shows no table (a clarify, a decline, a route). */
export function requestOf(label: VerifyLabel, o: Outcome): VerifyRequest | null {
  const table = o.delivered?.table;
  if (!table || !["answer", "historical", "srs", "current"].includes(o.kind)) return null;
  const groups = table.columns.map((c, i) => [c, i] as const).filter(([c]) => c.binding.kind === "grouping");
  const numbers = table.rows.flatMap((row) => table.columns.flatMap((c, i): VerifyNumber[] => (c.binding.kind !== "statistic" ? []
    : [{ column: c.header, binding: c.binding, at: Object.fromEntries(groups.map(([g, gi]) => [g.header, row[gi]])), value: row[i] }])));
  const q = (o.question ?? {}) as { measure?: string; statistic?: string; agencies?: { ori: string; state?: string; label: string }[]; beside?: { kind: string; code?: string }[];
    place?: { kind: string; ori?: string; label?: string; code?: string }; places?: { kind: string; code?: string }[] };
  const geo = (p: { kind: string; code?: string }) => (p.kind === "national" ? { kind: "national", label: "United States" } : { kind: "state", state: p.code });
  const places = o.kind === "historical" ? [...(q.agencies ?? []).map((a) => ({ kind: "agency", ori: a.ori, state: a.state ?? null, label: a.label })), ...(q.beside ?? []).map(geo)]
    : o.kind === "srs" ? (q.places ?? (q.place ? [q.place] : [])).map(geo)
    : o.kind === "current" ? (q.place ? [q.place] : [])
    : ((o.plan?.geography as { places?: unknown[] } | undefined)?.places ?? []);
  const source = o.kind === "historical" ? (q.beside?.length ? (q.agencies?.length ? "crimeindex_agency+state_national" : "crimeindex_state_national") : "crimeindex_agency") : SOURCE[o.kind];
  const grain = groups.some(([g]) => g.binding.dimension === "time.year") ? "time.year" : groups.some(([g]) => g.binding.dimension === "time.month") ? "time.month" : groups.length ? null : "total";
  return {
    id: label.id, tab: label.tab, times_asked: label.times, question: label.question, follow_up_of: label.kind === "follow-up" ? label.previous : null, source,
    measure: q.measure ?? planMeasure(o.plan) ?? o.meaning?.measures?.[0]?.name ?? null, statistic: q.statistic ?? planStatistic(o.plan) ?? o.meaning?.statistic ?? null, grain, places: withoutSql(places) as unknown[],
    combine: (o.plan?.geography as { combine?: string } | undefined)?.combine ?? null, period: o.period ?? null,
    filters: o.plan ? withoutSql(o.plan.filters) ?? null : null, groupings: o.plan ? withoutSql(o.plan.groupings) ?? null : o.meaning?.groupings ?? null,
    nibrs_plan: o.plan ? withoutSql(o.plan) : null, engine_read: withoutSql(o.read ?? null), numbers, digest: tableDigest(table.rows),
    verifiable: numbers.length > 0, note: numbers.length ? "" : "no numbers shown",
  };
}

/** One checked number (the 2026-11-06 results format). */
export type VerifyResult = { request: string; column: string; at: Record<string, unknown>; engine: unknown; result: string; mine?: unknown };

/**
 * The qlog-verified.json entries for the requests every number of which matched: each number in the request has one
 * result, and every result is "matched". Anything missing, extra or not matched leaves the request unverified (named
 * in `unmatched`, with why).
 */
export function verifiedEntries(requests: VerifyRequest[], results: VerifyResult[], meta: { by: string; batch: string; date: string }):
  { entries: Record<string, { digest: string; by: string; batch: string; numbers: number; date: string }>; unmatched: { id: string; why: string }[] } {
  const key = (column: string, at: Record<string, unknown>) => `${column}|${JSON.stringify(Object.keys(at).sort().map((k) => [k, at[k]]))}`;
  const byRequest = new Map<string, VerifyResult[]>();
  for (const r of results) byRequest.set(r.request, [...(byRequest.get(r.request) ?? []), r]);
  const entries: Record<string, { digest: string; by: string; batch: string; numbers: number; date: string }> = {};
  const unmatched: { id: string; why: string }[] = [];
  for (const q of requests.filter((x) => x.verifiable)) {
    const got = byRequest.get(q.id) ?? [];
    const wanted = new Set(q.numbers.map((n) => key(n.column, n.at)));
    const seen = new Map(got.map((r) => [key(r.column, r.at), r]));
    const missing = [...wanted].filter((k) => !seen.has(k));
    const extra = [...seen.keys()].filter((k) => !wanted.has(k));
    const failed = got.filter((r) => r.result !== "matched");
    if (missing.length || extra.length || failed.length || got.length !== q.numbers.length)
      unmatched.push({ id: q.id, why: missing.length ? `${missing.length} numbers with no result` : extra.length ? `${extra.length} results for numbers the answer doesn't show` : failed.length ? `${failed.length} not matched` : "duplicate results" });
    else entries[q.id] = { digest: q.digest, ...meta, numbers: q.numbers.filter((n) => n.value !== null && n.value !== undefined).length };
  }
  return { entries, unmatched };
}

/**
 * What the blind checker sees (the 2026-11-06 prompt): the question, the figure family, measure, statistic, grain,
 * places, period and, for each cell, its column and where it sits, never the engine's value, digest, plan or reading.
 */
export function blindOf(q: VerifyRequest): Record<string, unknown> {
  return { id: q.id, tab: q.tab, question: q.question, follow_up_of: q.follow_up_of, source: q.source, measure: q.measure, statistic: q.statistic, grain: q.grain,
    places: q.places, combine: q.combine, period: q.period, cells: q.numbers.map((n) => ({ column: n.column, at: n.at })) };
}

/** One value the checker wrote for a cell (the 2026-11-06 checker output). */
export type Expected = { id: string; column: string; at: Record<string, unknown>; value: number | null; how?: string };

/**
 * The checker's values against the engine's, one result per number: "matched" when both are missing, or both are
 * numbers equal at the engine value's own decimals (57 and 57.0, 3.084 and 3.0840000001); "mismatch" otherwise; "no value"
 * when the checker wrote none for a cell.
 */
export function compareExpected(requests: VerifyRequest[], expected: Expected[]): VerifyResult[] {
  const key = (id: string, column: string, at: Record<string, unknown>) => `${id}|${column}|${JSON.stringify(Object.keys(at).sort().map((k) => [k, at[k]]))}`;
  const mine = new Map(expected.map((e) => [key(e.id, e.column, e.at), e]));
  const decimals = (v: number) => (String(v).split(".")[1] ?? "").length;
  return requests.filter((q) => q.verifiable).flatMap((q) => q.numbers.map((n): VerifyResult => {
    const e = mine.get(key(q.id, n.column, n.at));
    if (!e) return { request: q.id, column: n.column, at: n.at, engine: n.value, result: "no value" };
    const ev = n.value === undefined ? null : (n.value as number | null);
    const ok = ev === null || e.value === null ? ev === e.value : Number(e.value.toFixed(decimals(ev))) === ev;
    return { request: q.id, column: n.column, at: n.at, engine: ev, result: ok ? "matched" : "mismatch", mine: e.value };
  }));
}
