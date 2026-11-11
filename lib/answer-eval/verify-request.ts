/**
 * Blind verification of new answers (process approved by Jeff, 2026-11-07: every PR's new answers are verified on the
 * runner). A request names what an answer claims (the question, its source, places, period, measure and every number
 * with where it sits in the table) and never the engine's SQL, so the queries that check it are written from the
 * build's schema and manifest alone. A request whose numbers all match becomes a qlog-verified.json entry at the
 * answer's table digest. Format: the 2026-11-06 request files.
 *
 * This certifies answers as correct, so it fails closed: a number is matched only by an independent value that is equal
 * at a tight tolerance, a result is trusted only for the request and value it names, and any ambiguity (two cells at one
 * place, a duplicate or extra checker value, an existing verification at another digest) leaves an answer unverified.
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

/** A cell's identity: its column and where it sits, as structured JSON (never a joined string that two cells could share). */
export const cellKey = (column: string, at: Record<string, unknown>) => JSON.stringify([column, Object.keys(at).sort().map((k) => [k, at[k]])]);
const requestCellKey = (id: string, column: string, at: Record<string, unknown>) => JSON.stringify([id, column, Object.keys(at).sort().map((k) => [k, at[k]])]);

/**
 * The tolerance of a match: the engine's value and the checker's, both from the same stored figures, differ only by
 * floating-point noise and by the checker computing a converted or computed rate another way (3.084 from 308.4 / 100).
 * A fixed bound, never derived from the engine's own decimals: 57 and 57.4 are different values.
 */
export function sameValue(engine: unknown, mine: unknown): boolean {
  // A value that isn't there (undefined) never matches anything, a checked blank (null) included (Codex tool review 02.2).
  if (engine === undefined || mine === undefined) return false;
  if (engine === null || mine === null) return engine === mine;
  if (typeof engine !== "number" || typeof mine !== "number" || !Number.isFinite(engine) || !Number.isFinite(mine)) return false;
  return Math.abs(engine - mine) <= 1e-6 + 1e-9 * Math.abs(engine);
}

/** The request for one answered label, or null for an outcome that shows no table (a clarify, a decline, a route). */
export function requestOf(label: VerifyLabel, o: Outcome): VerifyRequest | null {
  const table = o.delivered?.table;
  if (!table || !["answer", "historical", "srs", "current"].includes(o.kind)) return null;
  const groups = table.columns.map((c, i) => [c, i] as const).filter(([c]) => c.binding.kind === "grouping");
  const numbers = table.rows.flatMap((row) => table.columns.flatMap((c, i): VerifyNumber[] => (c.binding.kind !== "statistic" ? []
    : [{ column: c.header, binding: c.binding, at: Object.fromEntries(groups.map(([g, gi]) => [g.header, row[gi]])), value: row[i] }])));
  // Two cells at one column and place (a repeated header, a repeated row, two groupings with one header) can't be told
  // apart by a checker: the answer is not verifiable, not guessed.
  const keys = numbers.map((n) => cellKey(n.column, n.at));
  const ambiguous = new Set(keys).size !== keys.length || new Set(groups.map(([g]) => g.header)).size !== groups.length;
  // A value that isn't a finite number or a blank (NaN, infinity, text) would be written as null, and a checked blank
  // would then match it (Codex tool review 02.4): such an answer is not verifiable.
  const odd = numbers.some((n) => n.value !== null && !(typeof n.value === "number" && Number.isFinite(n.value)));
  const q = (o.question ?? {}) as { measure?: string; statistic?: string; agencies?: { ori: string; state?: string; label: string }[]; beside?: { kind: string; code?: string }[];
    place?: { kind: string; ori?: string; label?: string; code?: string }; places?: { kind: string; code?: string }[] };
  const geo = (p: { kind: string; code?: string }) => (p.kind === "national" ? { kind: "national", label: "United States" } : { kind: "state", state: p.code });
  const places = o.kind === "historical" ? [...(q.agencies ?? []).map((a) => ({ kind: "agency", ori: a.ori, state: a.state ?? null, label: a.label })), ...(q.beside ?? []).map(geo)]
    : o.kind === "srs" ? (q.places ?? (q.place ? [q.place] : [])).map(geo)
    // A Current Trends ranking or set lists its agencies with their ORIs, so a checker can find each one (job S4).
    : o.kind === "current" ? [...(q.place ? [q.place] : []), ...(q.agencies ?? []).map((a) => ({ kind: "agency", ori: a.ori, state: a.state ?? null, label: a.label }))]
    : ((o.plan?.geography as { places?: unknown[] } | undefined)?.places ?? []);
  const source = o.kind === "historical" ? (q.beside?.length ? (q.agencies?.length ? "crimeindex_agency+state_national" : "crimeindex_state_national") : "crimeindex_agency") : SOURCE[o.kind];
  const grain = groups.some(([g]) => g.binding.dimension === "time.year") ? "time.year" : groups.some(([g]) => g.binding.dimension === "time.month") ? "time.month" : groups.length ? null : "total";
  return {
    id: label.id, tab: label.tab, times_asked: label.times, question: label.question, follow_up_of: label.kind === "follow-up" ? label.previous : null, source,
    measure: q.measure ?? planMeasure(o.plan) ?? o.meaning?.measures?.[0]?.name ?? null, statistic: q.statistic ?? planStatistic(o.plan) ?? o.meaning?.statistic ?? null, grain, places: withoutSql(places) as unknown[],
    combine: (o.plan?.geography as { combine?: string } | undefined)?.combine ?? null, period: o.period ?? null,
    filters: o.plan ? withoutSql(o.plan.filters) ?? null : null, groupings: o.plan ? withoutSql(o.plan.groupings) ?? null : o.meaning?.groupings ?? null,
    nibrs_plan: o.plan ? withoutSql(o.plan) : null, engine_read: withoutSql(o.read ?? null), numbers, digest: tableDigest(table.rows),
    verifiable: numbers.length > 0 && !ambiguous && !odd,
    note: ambiguous ? "two cells share one column and place: not verifiable" : odd ? "a value that is not a finite number or a blank: not verifiable" : numbers.length ? "" : "no numbers shown",
  };
}

/** One checked number (the 2026-11-06 results format). */
export type VerifyResult = { request: string; column: string; at: Record<string, unknown>; engine: unknown; result: string; mine?: unknown };

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
 * The checker's values against the engine's, one result per number and one per anything unexpected. A result is
 * "matched" (the two are equal at the tolerance of `sameValue`, or both missing), "mismatch", "no value" (the checker
 * wrote none), "duplicate value" (it wrote the cell more than once: none of them is trusted) or "extra cell" (it wrote
 * a cell the request doesn't show). `problems` lists checker output for requests that don't exist.
 */
export function compareExpected(requests: VerifyRequest[], expected: Expected[]): { results: VerifyResult[]; problems: string[] } {
  const key = requestCellKey;
  const byCell = new Map<string, Expected[]>();
  for (const e of expected) byCell.set(key(e.id, e.column, e.at), [...(byCell.get(key(e.id, e.column, e.at)) ?? []), e]);
  const known = new Map(requests.map((q) => [q.id, q]));
  const results: VerifyResult[] = [];
  const wanted = new Set<string>();
  for (const q of requests.filter((x) => x.verifiable)) {
    for (const n of q.numbers) {
      const k = key(q.id, n.column, n.at);
      wanted.add(k);
      const got = byCell.get(k) ?? [];
      const ev = n.value;
      if (!got.length || (got.length === 1 && !Object.prototype.hasOwnProperty.call(got[0], "value"))) results.push({ request: q.id, column: n.column, at: n.at, engine: ev, result: "no value" });
      else if (got.length > 1) results.push({ request: q.id, column: n.column, at: n.at, engine: ev, result: "duplicate value", mine: got.map((g) => g.value) });
      else results.push({ request: q.id, column: n.column, at: n.at, engine: ev, result: sameValue(ev, got[0].value) ? "matched" : "mismatch", mine: got[0].value });
    }
  }
  const problems: string[] = [];
  for (const [k, got] of byCell) {
    if (wanted.has(k)) continue;
    const id = got[0].id;
    if (!known.has(id)) { const p = `checker output for an unknown request ${id}`; if (!problems.includes(p)) problems.push(p); continue; }
    results.push({ request: id, column: got[0].column, at: got[0].at, engine: null, result: "extra cell", mine: got[0].value });
  }
  return { results, problems };
}

/**
 * The qlog-verified.json entries for the requests every number of which matched. Each result is checked against the
 * request being applied, never trusted for its label: it must name a cell the request shows, carry the engine value
 * that request shows, and its own value must equal it at `sameValue` (the "matched" word alone is not enough). One
 * result per number; anything missing, extra, duplicate or different leaves the request unverified (in `unmatched`).
 */
export function verifiedEntries(requests: VerifyRequest[], results: VerifyResult[], meta: { by: string; batch: string; date: string }):
  { entries: Record<string, { digest: string; by: string; batch: string; numbers: number; date: string }>; unmatched: { id: string; why: string }[] } {
  const byRequest = new Map<string, VerifyResult[]>();
  for (const r of results) byRequest.set(r.request, [...(byRequest.get(r.request) ?? []), r]);
  const entries: Record<string, { digest: string; by: string; batch: string; numbers: number; date: string }> = {};
  const unmatched: { id: string; why: string }[] = [];
  for (const q of requests) {
    if (!q.verifiable) { unmatched.push({ id: q.id, why: q.note || "not verifiable" }); continue; }
    const got = byRequest.get(q.id) ?? [];
    const cells = new Map(q.numbers.map((n) => [cellKey(n.column, n.at), n]));
    const seen = new Map<string, VerifyResult[]>();
    for (const r of got) seen.set(cellKey(r.column, r.at), [...(seen.get(cellKey(r.column, r.at)) ?? []), r]);
    const missing = [...cells.keys()].filter((k) => !seen.has(k)).length;
    const extra = [...seen.keys()].filter((k) => !cells.has(k)).length;
    const duplicate = [...seen.values()].filter((v) => v.length > 1).length;
    // The result must be for this answer's value exactly (Codex tool review 02.1: an old result for 57 never verifies
    // 57.0000005), carry its own checked value explicitly, and that value must match.
    const own = (r: VerifyResult, k: "engine" | "mine") => Object.prototype.hasOwnProperty.call(r, k);
    const wrong = [...cells].filter(([k, n]) => { const r = seen.get(k)?.[0]; return r && seen.get(k)!.length === 1
      && !(own(r, "engine") && own(r, "mine") && r.engine === n.value && sameValue(n.value, r.mine) && r.result === "matched"); }).length;
    const why = missing ? `${missing} numbers with no result` : extra ? `${extra} results for numbers the answer doesn't show` : duplicate ? "duplicate results" : wrong ? `${wrong} not matched` : "";
    if (why) unmatched.push({ id: q.id, why });
    else entries[q.id] = { digest: q.digest, ...meta, numbers: q.numbers.filter((n) => n.value !== null && n.value !== undefined).length };
  }
  return { entries, unmatched };
}

export type VerifiedEntry = { digest: string; by?: string; batch?: string; numbers?: number; date?: string };

/**
 * Adding entries to the verified file: an id already verified at the same digest is left as it is; one verified at
 * another digest is a conflict and is not replaced unless named in `replace` (an owner's decision, said on the command).
 */
export function mergeVerified(existing: Record<string, VerifiedEntry>, entries: Record<string, VerifiedEntry>, replace: string[] = []):
  { merged: Record<string, VerifiedEntry>; added: string[]; unchanged: string[]; conflicts: string[]; replaced: string[] } {
  const merged = { ...existing };
  const added: string[] = [], unchanged: string[] = [], conflicts: string[] = [], replaced: string[] = [];
  for (const [id, e] of Object.entries(entries)) {
    const had = existing[id];
    if (!had) { merged[id] = e; added.push(id); }
    else if (had.digest === e.digest) unchanged.push(id);
    else if (replace.includes(id)) { merged[id] = e; replaced.push(id); }
    else conflicts.push(id);
  }
  return { merged, added, unchanged, conflicts, replaced };
}
