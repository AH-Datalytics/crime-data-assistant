/**
 * Increment 7b (P69): a follow-up turn is rewritten into one complete standalone question, from the previous turn and
 * the follow-up. The rewritten question is shown above the answer (editable: an edit runs as a new question) and goes
 * through the usual reading, plan and delivery; there is no separate follow-up path. When the rewrite is uncertain the
 * app asks instead of guessing. Edits that only change the presentation (bar or line, labels, colors, sort) keep the
 * data question: the page's chart controls handle them. Only the previous turn is used.
 *
 * The rewriter sits behind an interface (previous question + follow-up -> standalone question, with its confidence) so
 * a model-backed rewriter can serve the live path, with this deterministic one as the tested baseline. The baseline
 * edits the previous question's words for the forms below and asks about everything else: it never returns a partial
 * guess.
 *   presentation  "make it a bar chart", "add labels", "sort by ..."           -> the previous question, unchanged
 *   new question  a follow-up that names its own crime and place               -> the follow-up itself
 *   rate          "make it a rate", "show rates instead of counts"             -> "<crime> rate ..." (P58, P59)
 *   change        "how much did it change?", "percent change"                  -> "(Percent) change in <crime> ... from A to B"
 *   grain         "by month", "by year", "make it quarterly" (P71)            -> the time grouping replaced or added
 *   period        "same for 2023", "2024", "remove 2025"                       -> the year replaced, added, or the range shortened
 *   place         "what about Dallas?" (P23), "compare to X", "add X", "combined"
 *   breakdown     "by offender race", "by ethnicity instead", "now by age"     -> added, or the attribute replaced
 *   pairing       "only the offenders linked to each victim"                  -> P65's wording
 *   sex           "male", "female"                                             -> the sex word replaced
 *   crime         "now murders instead"                                        -> the crime replaced
 *   columns       "add a column for population", "how many agencies reported" (P72)
 */
import { readQuestion } from "./reading";

/** A rewrite: the standalone question and how sure the rewriter is; or a question back when it is not sure. */
export type Rewrite =
  | { kind: "rewrite" | "new" | "presentation"; question: string; confidence: "certain"; how: string }
  /** P69 amendment (Jeff 2026-10-31): a model's rewrite, shown as "Did you mean ...?"; nothing runs until it is confirmed. */
  | { kind: "propose"; question: string; how: string }
  | { kind: "ask"; why: string; options: { label: string; question: string }[] };
export interface FollowUpRewriter { rewrite(previous: string, followUp: string): Rewrite }

const COUNT: Record<number, string> = { 3: "three", 4: "four", 5: "five", 6: "six" };
const YEAR = /\b(19|20)\d{2}\b/;
const lcFirst = (s: string) => s.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase());
const ucFirst = (s: string) => s.replace(/^([a-z])/, (c) => c.toUpperCase());
const clean = (s: string) => s.replace(/\s{2,}/g, " ").replace(/\s+([,?.!])/g, "$1").trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ask = (why: string, options: { label: string; question: string }[] = []): Rewrite => ({ kind: "ask", why, options });
/** A follow-up that changes the last question in no way the rules can tell (plain wording, P74). */
export const PLACE_ASK = "I couldn't tell how this changes your last question. Ask the whole question, for example \"robberies in Denver in 2024\".";
const ok = (question: string, how: string, kind: "rewrite" | "new" | "presentation" = "rewrite"): Rewrite => ({ kind, question: clean(question), confidence: "certain", how });
/** Filler words a complete question of its own may hold; any other unrecognized word makes it a follow-up to ask about. */
const NEW_FILLER = new Set(["in", "of", "were", "was", "there", "the", "a", "an", "is", "are", "did", "during", "total"]);
/** Presentation-only follow-ups, each the whole follow-up (lower case, lead-ins and final punctuation removed). */
const PRESENTATION = [
  /^(?:(?:make|show|turn|change|switch|display|draw|put)\s+(?:it|this|that|them)?\s*(?:as|into|to|in)?\s*)?(?:(?:a|an)\s+)?(?:(?:bar|line|pie|column|area)\s+(?:chart|graph)|chart|graph)$/,
  /^(?:chart|graph|plot)\s+(?:it|this|that|them)$/,
  /^(?:add|show|remove|hide|include|drop)\s+(?:the\s+)?(?:data\s+|axis\s+)?(?:labels?|legend|gridlines?)$/,
  /^sort(?:ed)?\s+(?:it\s+|them\s+)?(?:by\s+)?(?:value|count|size|name|(?:largest|smallest|highest|lowest)(?:\s+first)?|ascending|descending)$/,
  // A color only ("make the lines quarterly" is not one: Codex 7b-04 re-check 2).
  /^(?:change|make)\s+(?:the\s+)?(?:colou?rs?|bars|lines?|graph|chart)\s+(?:to\s+)?(?:red|orange|yellow|green|blue|purple|pink|brown|black|gr[ae]y|teal|navy|dark|darker|light|lighter)$/,
  // Chart and table commands from the preview (coordinator, 2026-11-01): "as bars", "show as a line", "table only".
  /^(?:(?:show|display|make|put|draw)\s+(?:it\s+|this\s+|that\s+|them\s+)?)?(?:as|in)\s+(?:a\s+)?(?:bars?|lines?|columns?|a\s+table|table|pie)$/,
  /^(?:(?:show|display)\s+(?:the\s+|a\s+)?)?(?:table|chart|graph)(?:\s+only)?$|^(?:just|only)\s+(?:the\s+)?(?:table|chart|graph)$/,
  /^(?:hide|remove|no)\s+(?:the\s+)?(?:chart|graph|table)$/,
];

/** The clause-0 parts the reader finds in a question: measures, places, periods (their words as asked). */
function partsOf(q: string) {
  const parts = readQuestion(q, 2026).ledger.parts.filter((p) => p.clause === 0 && p.state !== "context");
  const of = (c: string) => parts.filter((p) => p.concept === c);
  return { measures: of("measure").filter((p) => p.value !== "unspecified"), places: of("place"), periods: of("period"), all: parts };
}
/** The previous question's period phrase: " in 2024", " from 2021 to 2025", " by year from ...", " since 2019". */
const PERIOD_AT = /\s(?:in|from|since|during)\s+(?:(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(?:19|20)\d{2}\b/i;
/** Insert words before the period phrase (or at the end, before a final "?"). */
function beforePeriod(q: string, words: string): string {
  const m = PERIOD_AT.exec(q);
  if (m) return `${q.slice(0, m.index)} ${words}${q.slice(m.index)}`;
  return q.replace(/\s*\?*\s*$/, "") + ` ${words}`;
}
/** The words naming the previous question's places, from the first place to the last ("Tulsa and Oklahoma City"). */
function placeWords(q: string, places: { text: string }[]): { at: number; text: string } | null {
  if (!places.length) return null;
  const first = q.indexOf(places[0].text), lastP = places[places.length - 1].text, last = q.lastIndexOf(lastP);
  return first < 0 || last < 0 ? null : { at: first, text: q.slice(first, last + lastP.length) };
}

/**
 * Jeff (2026-11-01, testing the preview): "The follow up doesn't work well, it assumes everything is a follow up." A turn
 * is a NEW question unless there is evidence it is a follow-up (real conversations: most later turns are complete new
 * questions). It stands alone when the reader finds a crime and a place in it (the period defaults as a first
 * question's does) and nothing in it points back at the previous answer: no opening such as "same", "and", "also",
 * "instead", "what about", "now", "make it", "show it", "compare", and no "same", "instead", "those", "them", "again",
 * "too", "as well" or "alongside" anywhere. A turn missing the crime or the place (a bare place, year or category) is a
 * follow-up.
 */
const BACK_LEAD = /^(?:(?:ok(?:ay)?|so|then|please|but)\b[,\s]*)*(?:same|and|also|plus|instead|what about|how about|compare|vs\.?|versus|add|now|make (?:it|this|that)|show (?:it|this|that|them|the same)|do (?:the same|that|it)|for that|by)\b/i;
// A comparison anywhere ("How does that compare to shoplifting in Nashville?") relates the turn to the previous answer:
// answered on its own it would drop the comparison (Codex review of the new-question default, 1).
const BACK_WORD = /\b(?:same|instead|those|these|them|that one|previous|above|again|too|as well|also|alongside|side by side|for comparison|compar(?:e|ed|es|ing|ison)|vs\.?|versus|against|relative to|than)\b/i;
export function standsAlone(turn: string): boolean {
  const t = turn.trim();
  if (BACK_LEAD.test(t) || BACK_WORD.test(t)) return false;
  const own = partsOf(t);
  return own.measures.length > 0 && own.places.length > 0;
}

export const deterministicRewriter: FollowUpRewriter = {
  rewrite(previous: string, followUp: string): Rewrite {
    const prev = previous.trim();
    const raw = followUp.trim();
    // The follow-up's own words, without lead-ins and "instead". An additive lead-in ("also 2023", "and Nashville") keeps
    // its meaning: the rest is read as "add ...", which only a place or a year completes (Codex 7b-04 re-check 1).
    const unled = raw.replace(/^(?:(?:ok(?:ay)?|now|then|so|please|can you|could you)\b[,\s]*)+/i, "");
    const additive = /^(?:and|also|plus|as well as)\b[,\s]*/i.exec(unled);
    let f = unled.slice(additive ? additive[0].length : 0).replace(/\s*\binstead\b/i, "").replace(/[?.!\s]+$/, "").trim();
    if (additive) f = `add ${f}`;
    const fl = f.toLowerCase();
    const prevParts = partsOf(prev);

    // Every form below must take the whole follow-up: a form found inside longer words ("make it a bar chart for 2023")
    // would drop the rest, so it is asked about (Codex 7b-04.1).
    // Presentation only: the same data question (P69); the page's chart controls change the chart.
    if (PRESENTATION.some((r) => r.test(fl))) return ok(prev, "presentation only: the data question is unchanged", "presentation");

    // A complete question of its own (its own crime, place and period): asked as it is, nothing inherited. Without its
    // own period ("now murders in Nashville instead") it leans on the previous one, so it is not complete.
    // Every word read: beside what the reader recognizes, only an opener, punctuation or a plain filler word. Anything
    // else ("include", "using the same", "side by side", "for comparison") may relate it to the previous answer, so it is
    // asked about (Codex 7b-04 fourth and fifth passes).
    const own = partsOf(unled);
    const plain = readQuestion(unled, 2026).ledger.parts.filter((p) => p.clause === 0).every((p) => p.state === "recognized" || p.concept === "opener"
      || p.concept === "punctuation" || (p.concept === "filler" && NEW_FILLER.has(p.text.toLowerCase())));
    // A comparative or additive opening ("compare shoplifting in Nashville in 2023") relates it to the previous one.
    if (own.measures.length && own.places.length && own.periods.length && !/\binstead\b/i.test(raw) && plain
      && !/^(?:compare|vs\.?|versus|against|add|and|also|plus|as well as|with)\b/i.test(unled)
      // Words that point back at the previous answer ("alongside that") make it not a question of its own (Codex 7b-04 third pass).
      && !/\b(?:that|this|those|these|it|them|previous|before|above|alongside|compare[ds]?|versus|vs|against|instead|also|too|as well)\b/i.test(unled))
      return ok(raw, "a complete question of its own", "new");

    // Only now, for a follow-up that changes the previous question: that question must be one of its own. A follow-up
    // ("Make it per capita") names no crime or place, and only the turn before it would say what it changes (real
    // conversations, hand check #13). A complete new question, above, does not depend on it.
    if (!prevParts.measures.length && !prevParts.places.length) return ask("The previous question was itself a change to an earlier one; ask the full question.");

    // P72: supporting columns, one at a time (both together are not built: Codex 7b-04.4).
    const popCol = /^(?:(?:add|show|include|give)\s+(?:me\s+)?(?:a\s+|the\s+)?(?:column\s+(?:for|with|showing)\s+(?:the\s+)?)?population(?:\s+column)?|(?:with|and)\s+(?:the\s+)?population|what(?:'s| is| was) the population(?: used)?)$/.test(fl);
    const agCol = /^(?:how many agencies (?:reported|report(?:ing|ed)?)|(?:add|show|include)\s+(?:the\s+)?(?:number of\s+)?agencies reporting|(?:with\s+)?(?:the\s+)?number of agencies reporting)$/.test(fl);
    // The reader's own column flag, whatever the punctuation (Codex 7b-04 re-check 4).
    if ((popCol || agCol) && (readQuestion(prev, 2026).ledger as { column?: string | null }).column)
      return ask("The previous answer already has a supporting column; both together are not built yet (P72).");
    if (popCol)
      return /\brate\b/i.test(prev) ? ok(`${prev.replace(/[?.]\s*$/, "")}, with a column showing the population used to calculate the rate`, "P72: the population used for the rate")
        : ask("A population column goes with a rate (P72); the previous answer has no rate.");
    if (agCol) {
      const geo = prevParts.places.some((p) => p.value === "national" || /^state:/.test(p.value ?? ""));
      return geo ? ok(`${prev.replace(/[?.]\s*$/, "")}, with the number of agencies reporting`, "P72: agencies reporting, for a state or national total")
        : ask("The number of agencies reporting goes with a state or national total (P72).");
    }

    // A rate in place of a count (P58, P59).
    if (/^(?:make (?:it|this|that) (?:a |into a )?rates?|(?:show|give)(?: me)? (?:the )?rates?(?: of| instead of counts| rather than counts)?|rates?|per capita|as a rate|per 100,?000(?: residents)?)$/i.test(f.replace(/\s+instead of counts$/i, ""))
      || /^show rates instead of counts$/i.test(raw.replace(/[?.!]+$/, ""))) {
      if (/\brate\b|per (?:capita|100)/i.test(prev)) return ask("The previous answer is already a rate.");
      const m = prevParts.measures[0];
      if (!m || prevParts.measures.length !== 1 || prev.indexOf(m.text) < 0) return ask("Which crime's rate is meant.");
      const at = prev.indexOf(m.text) + m.text.length;
      return ok(`${prev.slice(0, at)} rate${prev.slice(at)}`, "a count becomes a rate");
    }

    // Counts in place of a rate.
    if (/^(?:show |give me |make (?:it|this|that) )?(?:the )?(?:raw )?counts?(?: instead| rather than rates?)?$/i.test(f)) {
      const r = /\s+rates?\b(?:\s+per\s+100,?000(?:\s+residents)?)?|\s+per\s+(?:capita|100,?000(?:\s+residents)?)\b/i.exec(prev);
      return r ? ok(prev.replace(r[0], ""), "a rate becomes a count") : ask("The previous answer is already a count.");
    }
    // A change between the first and last periods of the previous answer (P54, P55).
    const chg = /^(?:(?:what(?:'s| is| was) the |the )?(percent(?:age)?|%) change|(?:how much did (?:it|they|that) change|what(?:'s| is| was) the change|(?:the )?change))$/i.exec(f);
    if (chg) {
      const r = /\bfrom\s+((?:19|20)\d{2})\s+(?:to|through)\s+((?:19|20)\d{2})\b/i.exec(prev);
      if (!r) return ask("Which two periods to compare.");
      const body = lcFirst(prev.replace(/\s+by\s+year\b/i, "").replace(/[?.]\s*$/, ""));
      return ok(`${chg[1] ? "Percent change" : "Change"} in ${body}`, "the first and last periods of the previous answer");
    }

    // The time grain: quarters (P71), months, years.
    if (/^(?:(?:make|show|turn|break|split|put)\s+(?:it|this|that|them)\s+(?:down\s+)?(?:by\s+quarters?|quarterly|into\s+quarters|in\s+quarters)|(?:show it\s+|break it down\s+)?(?:by|per|each)\s+quarters?|quarterly|(?:by\s+)?quarters)$/.test(fl)) {
      // The grain is replaced, never stacked ("by year by quarter": Codex 7b-04 re-check 3).
      if (/\bby (?:month|year)\b/i.test(prev)) return ok(prev.replace(/\bby (?:month|year)\b/i, "by quarter"), "P71: quarters as sums of months");
      if (/\bby\s+(?:quarter|day|week)\b|\bmonthly\b|\byearly\b|\bannual(?:ly)?\b/i.test(prev)) return ask("How the quarters relate to the previous answer's time grain.");
      return YEAR.test(prev) ? ok(beforePeriod(prev, "by quarter"), "P71: quarters as sums of months") : ask("Which period to show by quarter.");
    }
    const grain = /^(?:(?:show it |break it down |split it )?by (month|year)|(monthly|annually|yearly|per month|per year|each month|each year))$/i.exec(f);
    if (grain) {
      const g = /month/i.test(grain[1] ?? grain[2]) ? "month" : "year";
      if (/\bby (?:month|year|quarter)\b/i.test(prev)) return ok(prev.replace(/\bby (?:month|year|quarter)\b/i, `by ${g}`), "the time grain replaced");
      return ok(beforePeriod(prev, `by ${g}`), "the time grain added");
    }

    // "show 10 years", "the seven-year trend", "past 5 years": the last N complete years by year, from the release
    // (the reader reads "over the last N years"); the previous period and time grain are replaced, the rest kept.
    // Only whole-year periods are replaced; months, "since" or relative words are asked about. "go back further" asks.
    const lastN = /^(?:(?:show|give)(?:\s+me)?\s+)?(?:the\s+)?(?:(?:last|past)\s+)?(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)[\s-]+years?(?:\s+trend)?$/i.exec(f);
    if (lastN) {
      const n = /^\d+$/.test(lastN[1]) ? Number(lastN[1]) : ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].indexOf(lastN[1].toLowerCase()) + 2;
      const period = /\s+(?:from\s+(?:19|20)\d{2}\s+(?:to|through)\s+(?:19|20)\d{2}|in\s+(?:19|20)\d{2})\b/i.exec(prev);
      // The previous period must be exactly the one phrase replaced: one year or one range ("in 2023 and 2024" asks).
      const whole = prevParts.periods.length === 1 && /^(?:year|range):/.test(String(prevParts.periods[0].value));
      if (n < 2 || n > 20 || !period || !whole || /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|since|so far|year to date|this year|last year)\b/i.test(prev))
        return ask(`Which ${n}-year period to show.`);
      const body = prev.replace(period[0], "").replace(/\s+by\s+(?:month|year|quarter)\b/i, "").replace(/[?.]\s*$/, "");
      return ok(`${body} by year over the last ${n} years`, "the last N complete years, by year");
    }
    if (/^(?:can you\s+)?(?:go|show)\s+(?:me\s+)?(?:back\s+)?further(?:\s+back)?(?:\s+in\s+time)?$/i.test(f)) return ask("How far back to go.");

    // "remove 2025": a range shortened at either end (P69's guidance; F4).
    const rm = /^(?:remove|drop|exclude|without|take out|leave out)\s+((?:19|20)\d{2})$/i.exec(f);
    if (rm) {
      const y = Number(rm[1]);
      const r = /\bfrom\s+((?:19|20)\d{2})\s+(to|through)\s+((?:19|20)\d{2})\b/i.exec(prev);
      if (r && Number(r[3]) === y && Number(r[1]) < y) return ok(prev.replace(r[0], `from ${r[1]} ${r[2]} ${y - 1}`), "the range shortened at its end");
      if (r && Number(r[1]) === y && Number(r[3]) > y) return ok(prev.replace(r[0], `from ${y + 1} ${r[2]} ${r[3]}`), "the range shortened at its start");
      return ask(`Removing ${y} from this period.`);
    }

    // Breakdowns: added, or the attribute replaced (keeping whose it is unless the follow-up says).
    const by = /^(?:by|break (?:it )?down by|split by)\s+(?:the\s+)?(offenders?|arrestees?|victims?)?(?:'s|s')?\s*(race|sex|gender|ethnicity|age)(?:\s+groups?)?$/i.exec(f);
    if (by) {
      const attr = by[2].toLowerCase() === "gender" ? "sex" : by[2].toLowerCase();
      const has = /\bby\s+(?:the\s+)?(offender|arrestee|victim)?\s*(race|sex|gender|ethnicity|age)(?:\s+groups?)?\b/i.exec(prev);
      if (has) return ok(prev.replace(has[0], `by ${by[1] ? `${by[1].toLowerCase().replace(/s$/, "")} ` : has[1] ? `${has[1]} ` : ""}${attr}`), "the breakdown's attribute replaced");
      return ok(`${prev.replace(/[?.]\s*$/, "")} by ${by[1] ? `${by[1].toLowerCase().replace(/s$/, "")} ` : ""}${attr}`, "a breakdown added");
    }
    // P65's pairing named by the follow-up.
    if (/^(?:(?:use|show|count)\s+)?only\s+(?:the\s+)?offenders?\s+linked\s+to\s+(?:each|the)\s+victims?$|^(?:use\s+)?(?:only\s+)?(?:the\s+)?linked\s+offenders?(?:\s+only)?$|^(?:by\s+)?(?:the\s+)?(?:offenders?\s+)?who\s+(?:killed|attacked)\s+(?:them|each victim)$/.test(fl)) {
      const has = /\bby\s+offender\s+(race|sex|ethnicity|age)\b/i.exec(prev);
      if (!has) return ask("Which offender breakdown to link to each victim.");
      const verb = /\bmurder|homicide|killed\b/i.test(prev) ? "killed" : "attacked";
      return ok(prev.replace(has[0], `by the ${has[1].toLowerCase()} of the offender who ${verb} them`), "P65's pairing named");
    }
    // The other sex.
    const sx = /^(male|female|men|women)$/i.exec(f);
    if (sx) {
      const want = /^(male|men)$/i.test(sx[1]) ? "male" : "female";
      const has = /\b(male|female)\b/i.exec(prev);
      // One sex word only: with two ("female victims with female offenders") which one is meant is asked (Codex 7b-04 seventh pass).
      // Asked with a button for each reading, each a complete question (coordinator, 2026-11-01).
      const sexes = [...prev.matchAll(/\b(?:male|female)\b/gi)];
      if (sexes.length > 1) return ask(`Which "${sexes.map((w) => w[0]).join('" or "')}" should be ${want}?`, sexes.map((w) => {
        const q = `${prev.slice(0, w.index)}${w[0][0] === w[0][0].toUpperCase() ? ucFirst(want) : want}${prev.slice(w.index! + w[0].length)}`;
        return { label: q, question: q };
      }));
      if (!has || (prev.match(/\b(?:men|women|boys|girls)\b/gi) ?? []).length) {
        const base = prev.trim().replace(/[?.!]+$/, "");
        // Each button says what it counts: "with a female offender" counts the female offenders (Codex decline review 01).
        // The shadow offers only the ones the reader reads whole.
        const label = { victim: `Count ${want} victims`, offender: `Count ${want} offenders`, arrestee: `Count arrests of ${want}s` };
        return ask(`Do you mean ${want} victims, offenders or arrestees?`,
          (["victim", "offender", "arrestee"] as const).map((who) => ({ label: label[who], question: `${base} with a ${want} ${who}` })));
      }
      const word = has[1][0] === has[1][0].toUpperCase() ? ucFirst(want) : want;
      return ok(prev.replace(has[0], word), "the sex replaced");
    }

    // "combined": the same places as one total.
    if (/^(?:combined|combine (?:them|those|these)|(?:all )?together|as one total)$/i.test(f)) {
      if (prevParts.places.length < 2) return ask("Which places to combine.");
      return /\bcombined\b/i.test(prev) ? ask("The places are already combined.") : ok(beforePeriod(prev, "combined"), "the same places as one total");
    }

    // Place and period: "what about Dallas?", "what about Denver in 2023?", "same for 2023", "2024", "compare to X", "add X".
    const pp = /^(?:(?:what|how) about|same (?:thing )?for|do|(?:and )?for|(compare (?:it |this |that )?(?:to|with)|add|plus|and|vs\.?|versus))\s+(.+)$/i.exec(f);
    // A bare place ("washington state", "minneapolis"), or a place and year, is read as "what about ..." (P23): the
    // follow-up's words must be nothing but that place (and year).
    const bare = (() => {
      if (pp) return null;
      const t = partsOf(`Shoplifting in ${f}`);
      return t.places.length === 1 && t.all.every((p) => ["measure", "place", "period", "filler"].includes(p.concept)) && t.measures.every((m) => m.text === "Shoplifting") ? f : null;
    })();
    const target = pp ? pp[2] : /^(?:in\s+)?(?:19|20)\d{2}$/i.test(f) ? f : bare;
    if (target !== null) {
      const adding = !!pp?.[1];
      const t = partsOf(`Shoplifting in ${target}`);
      // Nothing but a place and a year: "what about Nashville by month" would drop "by month" (Codex 7b-04.1).
      if (!t.all.every((p) => ["measure", "place", "period", "filler"].includes(p.concept)) || t.measures.some((m) => m.text !== "Shoplifting") || t.places.length > 1
        || !/^(?:the\s+)?[^\d]*?(?:\s+in\s+(?:19|20)\d{2})?$|^(?:in\s+)?(?:19|20)\d{2}$/i.test(target.trim()))
        return ask(`What "${target}" changes in the previous question.`);
      const yearOnly = /^(?:in\s+)?((?:19|20)\d{2})$/i.exec(target.trim());
      const newPlace = t.places.length ? target.replace(/\s+in\s+(?:19|20)\d{2}$/i, "").replace(/^the\s+/i, "").trim() : null;
      const newYear = yearOnly?.[1] ?? /\bin\s+((?:19|20)\d{2})$/i.exec(target)?.[1] ?? null;
      if (!newPlace && !newYear) return ask(`What "${target}" changes in the previous question.`);
      // The new place is exactly the place the reader found: other words ("combined with Knoxville") would be dropped
      // or misplaced (Codex 7b-04 sixth pass).
      if (newPlace && (t.places.length !== 1 || newPlace.toLowerCase() !== t.places[0].text.replace(/^the\s+/i, "").toLowerCase()))
        return ask(`What "${target}" changes in the previous question.`);
      let q = prev;
      if (newPlace) {
        const pw = placeWords(prev, prevParts.places);
        if (!pw) return ask("Where to put the new place.");
        // Places joined by "and", never commas: "Tulsa, Oklahoma City" reads as Tulsa, Oklahoma and a stray "City".
        const list = pw.text;
        // A place compared with or added to a combined group: one more in the total, or the group against it? Asked
        // (Codex 7b-04 third pass: "compare to Knoxville" must never join a combined total).
        if (adding && /\bcombined\b/i.test(prev)) return ask(`Whether ${newPlace} joins the combined total or is shown beside it.`);
        if (adding) {
          q =`${q.slice(0, pw.at)}${list} and ${newPlace}${q.slice(pw.at + pw.text.length)}`;
        } else if (prevParts.places.length > 1 && newYear) {
          // A new place and a new year after several places: the options would have to carry both; asked plainly.
          return ask(`Whether ${newPlace} in ${newYear} replaces ${pw.text} or is added to them, and for which period.`);
        } else if (prevParts.places.length > 1) {
          // Each option's question says exactly what its label says: "separately" never keeps "combined" (Codex 7b-04
          // fourth pass), and a combined group can instead take the new place into its total.
          const n = COUNT[prevParts.places.length + 1] ?? prevParts.places.length + 1;
          const withNew = `${prev.slice(0, pw.at)}${list} and ${newPlace}${prev.slice(pw.at + pw.text.length)}`;
          const combinedPrev = /\s+combined\b/i.test(prev);
          return ask(`Whether ${newPlace} replaces ${pw.text} or is added to them.`, [
            { label: `${newPlace} only`, question: clean(`${prev.slice(0, pw.at)}${newPlace}${prev.slice(pw.at + pw.text.length)}`.replace(/\s+combined\b/i, "")) },
            { label: `Add ${newPlace}; show all ${n} separately`, question: clean(withNew.replace(/\s+combined\b/i, "")) },
            ...(combinedPrev ? [{ label: `Add ${newPlace} to the combined total`, question: clean(withNew) }] : [])]);
        } else if (/^state:/.test(String(t.places[0].value)) && !adding && !/\binstead\b/i.test(raw) && !/^state:|^national/.test(String(prevParts.places[0].value))) {
          // A state after a city, with no "instead" (which replaces, as before; Codex review of the rule fixes, 1): a bare
          // state names an ambiguous city's state (real conversations: "Missouri" answering "which Springfield?"); any
          // other wording ("what about Missouri"), a year, or a city already placed asks which is meant.
          if (bare !== null && /^ambiguous:/.test(String(prevParts.places[0].value)) && !newYear)
            q = `${q.slice(0, pw.at)}${pw.text}, ${newPlace}${q.slice(pw.at + pw.text.length)}`;
          else return ask(`Whether ${newPlace} means the state or ${pw.text} in ${newPlace}.`);
        } else q = `${q.slice(0, pw.at)}${newPlace}${q.slice(pw.at + pw.text.length)}`;
      }
      if (newYear) {
        // Only a period of one whole year ("in 2024") is replaced or added to; a range, a set of years, months or
        // relative words are asked about (Codex 7b-04.2). A question with no period takes the year.
        const one = /\b(in|during)\s+((?:19|20)\d{2})\b(?!\s+(?:to|through|and)\b)/i.exec(q);
        const monthBefore = one && /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s*$/i.test(q.slice(0, one.index + one[1].length + 1));
        const otherPeriod = /\bfrom\s+(?:19|20)\d{2}\b|\bsince\b|\band\s+(?:19|20)\d{2}\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(?:this|last|past)\s+(?:year|month|\d+)|\bso far\b|\byear to date\b/i.test(q);
        if (otherPeriod || monthBefore || (!one && (YEAR.test(q) || prevParts.periods.length))) return ask(`Whether ${newYear} replaces the whole period or is added to it.`);
        if (adding && newPlace) return ask(`Whether ${newYear} replaces the period for ${newPlace} or is added to it.`);
        if (adding) {
          if (!one) return ask(`Which period ${newYear} is added to.`);
          if (one[2] === newYear) return ask(`${newYear} is already the period asked.`);
          const ys = [one[2], newYear].sort();
          q = q.replace(one[0], `${one[1]} ${ys[0]} and ${ys[1]}`);
        } else q = one ? q.replace(one[0], `${one[1]} ${newYear}`) : `${q.replace(/[?.]\s*$/, "")} in ${newYear}`;
      }
      return ok(q, adding ? (newPlace ? "a place added" : "a year added") : newPlace && newYear ? "the place and year replaced" : newPlace ? "the place replaced" : "the year replaced or added");
    }

    // A crime in place of the previous one ("now murders instead").
    const cr = partsOf(`${ucFirst(f)} in Memphis in 2024`);
    // Nothing else: "murders in Nashville instead" would drop Nashville (Codex 7b-04.1).
    const onlyCrime = cr.measures.length === 1 && cr.places.length === 1 && cr.periods.length <= 1 && !YEAR.test(f)
      && cr.all.every((p) => ["measure", "place", "period", "filler"].includes(p.concept));
    if (onlyCrime && (/\binstead\b/i.test(raw) || f.split(/\s+/).length <= 3)) {
      const m = prevParts.measures[0];
      if (!m || prevParts.measures.length !== 1 || prev.indexOf(m.text) < 0) return ask("Which crime to replace.");
      const word = /^[A-Z]/.test(prev.slice(prev.indexOf(m.text))) ? ucFirst(f) : f;
      return ok(prev.replace(m.text, word), "the crime replaced");
    }
    return ask(PLACE_ASK);
  },
};
