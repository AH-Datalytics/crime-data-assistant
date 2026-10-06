/**
 * AGENCY+RANK batch, Chicago comparability (completion plan, outcome A; owner clarification 2026-10-05:
 * "Chicago Agg assaults is a very specific Chicago reporting post-nibrs issue").
 *
 * Established, read-only evidence (audit/fbi-master-refresh-2026-10-05, retained R7): the live Historical
 * library's Chicago Police Department row (ILCPD0000) has aggravated assault 15,789 (2023) and 16,084 (2024),
 * then 2,503 (2025). The builder reads rows through 2024 from its pre-2025 base file (provenance not established)
 * and 2025 from a separate RETA 2025 input (live linkage to a specific file not independently sealed). Nothing
 * establishes which count is right, the exact affected dates or a replacement value.
 *
 * So this states a COMPARABILITY LIMITATION and changes nothing else: no figure is replaced, adjusted, withheld
 * or re-sourced, and no other agency, offense or tab is touched. It applies only when a Historical answer's
 * executed SQL reads `historical_agency_crime`, its measure depends on assault (the `assault` column or the
 * `violent` total that includes it), Chicago is in the request or the returned rows, and the answer spans
 * the 2024/2025 boundary. Idempotent: the exact note is added once.
 */

export const CHICAGO_ASSAULT_COMPARABILITY_NOTE =
  "Chicago's aggravated assault figures for 2024 and earlier years and for 2025 come from different source files and " +
  "are not comparable; this is a known Chicago reporting issue following its move to NIBRS. The change between " +
  "them, and in any violent-crime total that includes aggravated assault, should not be read as a change in crime. " +
  "Corrected Chicago figures are not available here.";

const CHICAGO_ORI = "ILCPD0000";
const LAST_BASE_YEAR = 2024;

const literalsOf = (sql: string) => [...sql.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
const isChicagoName = (value: unknown) => typeof value === "string" && /^\s*chicago(?:\s*,\s*il(?:linois)?)?\s*$/i.test(value);

function namesChicago(sql: string, rows: Record<string, unknown>[]): boolean {
  if (literalsOf(sql).some((lit) => lit.toUpperCase() === CHICAGO_ORI || isChicagoName(lit))) return true;
  return rows.some((row) => Object.values(row).some((v) => v === CHICAGO_ORI || isChicagoName(v)))
    || rows.some((row) => Object.keys(row).some((k) => /^chicago(?:_|$)/i.test(k)));
}

function spansBoundary(sql: string, rows: Record<string, unknown>[]): boolean {
  const rowYears = rows.map((r) => Number(r.year)).filter((y) => Number.isInteger(y) && y >= 1900);
  const years = rowYears.length > 0
    ? rowYears
    : [...sql.replace(/'(?:[^']|'')*'/g, "''").matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
  return years.some((y) => y <= LAST_BASE_YEAR) && years.some((y) => y > LAST_BASE_YEAR);
}

export function chicagoAssaultComparabilityNote(sql: string | null | undefined, rows: Record<string, unknown>[]): string | null {
  if (!sql || !Array.isArray(rows) || rows.length === 0) return null;
  const code = sql.replace(/'(?:[^']|'')*'/g, "''");
  if (!/\bhistorical_agency_crime\b/i.test(code)) return null;
  if (!/\b(?:assault|aggravated_assault|violent)\b/i.test(code)) return null;
  if (!namesChicago(sql, rows) || !spansBoundary(sql, rows)) return null;
  return CHICAGO_ASSAULT_COMPARABILITY_NOTE;
}

/**
 * Correction F2 (Codex :36392): on this boundary the model's interpretation is not kept. A model sentence such as
 * "Chicago experienced an 84.4% reduction in aggravated assault crime" asserts exactly the reading the limitation
 * says not to make, so a note appended after it contradicts the answer instead of correcting it. For a model-path
 * Historical answer the boundary applies to, this is the application's own narrative -- a neutral description of
 * the returned stored figures plus the limitation -- used by every version (first, refined, retry, fallback, cache),
 * like the GC-085 and composite descriptions. Rows, SQL and figures are unchanged; nothing is computed or corrected.
 */
export function chicagoAssaultNarrative(tab: string, sql: string | null | undefined, rows: Record<string, unknown>[]): string | null {
  if (tab !== "historical" || !chicagoAssaultComparabilityNote(sql, rows)) return null;
  const code = String(sql).replace(/'(?:[^']|'')*'/g, "''");
  const other = /\b(?:murder|rape|robbery|property|burglary|theft|motor_vehicle_theft)\b/i.test(code);
  const assault = /\b(?:assault|aggravated_assault)\b/i.test(code);
  const violent = /\bviolent\b/i.test(code);
  const measure = other ? "crime" : assault && violent ? "aggravated assault and violent crime" : assault ? "aggravated assault" : "violent crime";
  const nonChicagoLiteral = literalsOf(String(sql)).some((lit) => {
    const v = lit.trim();
    return v !== "" && v.toUpperCase() !== CHICAGO_ORI && !isChicagoName(v) && !/^il(linois)?$/i.test(v) && !/^city$/i.test(v);
  });
  const nonChicagoRow = rows.some((row) => Object.entries(row).some(([k, v]) =>
    (/^(?:ori|agency|agency_name|city|place|place_label)$/i.test(k) && typeof v === "string" && v !== CHICAGO_ORI && !isChicagoName(v))
    || (/(?:^|_)(?:assault|violent)/i.test(k) && !/^chicago/i.test(k) && !/^(?:assault|aggravated_assault|violent|violent_crime)s?$/i.test(k))));
  const who = nonChicagoLiteral || nonChicagoRow ? "the requested agencies, including Chicago" : "Chicago";
  const years = rows.map((r) => Number(r.year)).filter((y) => Number.isInteger(y) && y >= 1900);
  const sqlYears = [...code.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
  const span = years.length > 0 ? years : sqlYears;
  const lo = Math.min(...span), hi = Math.max(...span);
  const period = lo === hi ? `${lo}` : `${lo}–${hi}`;
  return `Historical library ${measure} figures for ${who}, ${period}, as stored. ${CHICAGO_ASSAULT_COMPARABILITY_NOTE}`;
}

export function withChicagoAssaultComparability(explanation: string, sql: string | null | undefined, rows: Record<string, unknown>[]): string {
  const note = chicagoAssaultComparabilityNote(sql, rows);
  if (!note || explanation.includes(note)) return explanation;
  return `${explanation.trimEnd()}\n\n${note}`;
}
