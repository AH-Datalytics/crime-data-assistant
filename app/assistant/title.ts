/**
 * Chart titles for the Crime Data Assistant (Jeff, 2026-11-01), built from the engine's plan, never by reformatting its
 * answer sentence: "Memphis, TN Shoplifting Offenses by Month & Clearance Status, 2024".
 *   place first (a city with its two-letter state, a state by name, "United States"), no colon;
 *   Title Case with short words lowercase ("by", "of", "per", "in"); "&" for "and"; ", <period>" last; no period.
 * The subtitle says only what the title doesn't and is essential: a rolling window, a partial last year.
 * Savant (nibrs-savant, Spotlight) also puts the place first ("Nashville, TN Carjacking"); its year cells read
 * "2026 (Partial)".
 */
import type { NibrsPlan } from "@/lib/nibrs-plan/plan";
import { CATEGORY, measureWords, periodWords } from "@/lib/nibrs-shadow/deliver";
import { STATE_NAMES } from "@/lib/nibrs-shadow/places";

const SMALL = new Set(["a", "an", "the", "and", "or", "of", "by", "per", "in", "on", "at", "to", "for", "with", "from", "vs", "as", "into"]);
const CODE_BY_STATE = Object.fromEntries(Object.entries(STATE_NAMES).map(([c, n]) => [n, c]));

/** Title Case: every word capitalized except short ones (not first); "and" becomes "&"; words already capitalized keep their case. */
export function titleCase(s: string): string {
  return s.split(/\s+/).filter(Boolean).map((w, i) => {
    const bare = w.toLowerCase();
    if (bare === "and") return "&";
    if (i > 0 && SMALL.has(bare)) return bare;
    return w.split(/([/-])/).map((p) => (/^[a-z]/.test(p) ? p[0].toUpperCase() + p.slice(1) : p)).join("");
  }).join(" ");
}

const join = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} & ${xs[xs.length - 1]}`);

/** "Memphis, Tennessee" -> "Memphis, TN"; a state by its name; the nation as "United States". */
function placeName(p: NibrsPlan["geography"]["places"][number]): string {
  if (p.kind === "national") return "United States";
  if (p.kind === "state") return STATE_NAMES[p.code] ?? p.code;
  if (p.kind === "agency" || p.kind === "county") {
    const m = /^(.*), ([A-Za-z .]+)$/.exec(p.label);
    return m && CODE_BY_STATE[m[2]] ? `${m[1]}, ${CODE_BY_STATE[m[2]]}` : p.label;
  }
  return p.within.kind === "state" ? (STATE_NAMES[p.within.code] ?? p.within.code) : "United States";
}

const GROUPING: Record<string, string> = { "time.month": "month", "time.quarter": "quarter", "time.year": "year" };

export type Titles = { title: string; subtitle: string | null; partialYear: string | null };

/** The chart title, subtitle and partial last year for an answer's plan and the period it covers. */
export function titlesFor(plan: NibrsPlan, period: { from: string; to: string }, opts: { rolling?: number | null } = {}): Titles {
  const places = join(plan.geography.places.map(placeName));
  const measures = join(plan.measures.map((m) => titleCase(measureWords(plan, m))));
  const rate = plan.statistics.find((s) => s.kind === "rate");
  // A grouping's own person is dropped when the measure already names it ("Murder Victims by Race", not "by Victim Race").
  const units = new Set<string>(plan.measures.map((m) => m.unit));
  const groups = plan.groupings.map((g) => {
    const h = GROUPING[g.dimension] ?? CATEGORY[g.dimension]?.header ?? g.dimension.split(".").pop()!.replace(/_/g, " ");
    const who = /^(Victim|Offender|Arrestee) (.+)$/.exec(h);
    return who && (units.has(who[1].toLowerCase()) || (who[1] === "Arrestee" && (units.has("arrest") || units.has("arrestee")))) ? who[2] : h;
  });
  const yearly = plan.groupings.some((g) => g.dimension === "time.year");
  // By year, the title gives years ("2019–2026"); a partial last year is named in the subtitle.
  const when = (plan.period as { kind?: string; years?: number[] }).kind === "years" && (plan.period as { years?: number[] }).years
    ? join((plan.period as { years: number[] }).years.map(String))
    : yearly ? (period.from.slice(0, 4) === period.to.slice(0, 4) ? period.from.slice(0, 4) : `${period.from.slice(0, 4)}–${period.to.slice(0, 4)}`)
    : periodWords(period.from, period.to).replace(/ (?:to|through) /g, "–");
  const title = `${places} ${measures}${rate ? ` per ${rate.kind === "rate" ? rate.per.toLocaleString("en-US") : "100,000"}` : ""}${groups.length ? ` by ${titleCase(join(groups))}` : ""}, ${titleCase(when)}`;

  // The last year is partial when the period ends before December (the data runs through the release's last month).
  const partialYear = yearly && !period.to.endsWith("-12") ? period.to.slice(0, 4) : null;
  const sub: string[] = [];
  // No "Sum of Reporting Agencies" (Jeff, 2026-11-01): the lead says what is summed; a subtitle only for something short
  // and essential.
  if (opts.rolling) sub.push(`Rolling ${opts.rolling}-Month Totals`);
  if (partialYear) sub.push(`${partialYear} (Partial): ${titleCase(periodWords(`${partialYear}-01`, period.to).replace(/ (?:to|through) /g, "–"))}`);
  return { title, subtitle: sub.length ? sub.join(", ") : null, partialYear };
}
/**
 * A title for any answer, from the engine's headline when no plan gives one (Jeff, 2026-11-02: "every graph needs a
 * title"; Historical's and the historical file's answers have no NIBRS plan): "Memphis, Tennessee: robberies by year,
 * 1990 through 2024." becomes "Memphis, TN Robberies by Year, 1990–2024"; "Memphis, Tennessee and Nashville, Tennessee:
 * robberies by year, 2015 through 2024." becomes "Memphis, TN & Nashville, TN Robberies by Year, 2015–2024". A headline
 * that doesn't read as "<place>: <what>, <period>." is kept as it is, its final period dropped.
 */
export function headlineTitle(headline: string): string {
  const h = headline.trim().replace(/\.$/, "");
  const m = /^(.+?): (.+?), ((?:[A-Z][a-z]+ )?\d{4}(?: (?:to|through) (?:[A-Z][a-z]+ )?\d{4})?)(?:,.*)?$/.exec(h);
  if (!m) return h;
  const places = m[1].split(/ and /).map((p) => {
    const c = /^(.*), ([A-Za-z .]+)$/.exec(p.trim());
    return c && CODE_BY_STATE[c[2]] ? `${c[1]}, ${CODE_BY_STATE[c[2]]}` : p.trim();
  });
  return `${join(places)} ${titleCase(m[2])}, ${titleCase(m[3].replace(/ (?:to|through) /, "–"))}`;
}
