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
  | { kind: "ask"; why: string; options: { label: string; question: string }[] };
export interface FollowUpRewriter { rewrite(previous: string, followUp: string): Rewrite }

const COUNT: Record<number, string> = { 3: "three", 4: "four", 5: "five", 6: "six" };
const YEAR = /\b(19|20)\d{2}\b/;
const lcFirst = (s: string) => s.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase());
const ucFirst = (s: string) => s.replace(/^([a-z])/, (c) => c.toUpperCase());
const clean = (s: string) => s.replace(/\s{2,}/g, " ").replace(/\s+([,?.!])/g, "$1").trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ask = (why: string, options: { label: string; question: string }[] = []): Rewrite => ({ kind: "ask", why, options });
const ok = (question: string, how: string, kind: "rewrite" | "new" | "presentation" = "rewrite"): Rewrite => ({ kind, question: clean(question), confidence: "certain", how });

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

export const deterministicRewriter: FollowUpRewriter = {
  rewrite(previous: string, followUp: string): Rewrite {
    const prev = previous.trim();
    const raw = followUp.trim();
    // The follow-up's own words, without lead-ins and "instead".
    const f = raw.replace(/^(?:ok(?:ay)?|now|and|also|then|so|please|can you|could you)\b[,\s]*/i, "").replace(/\s*\binstead\b/i, "").replace(/[?.!\s]+$/, "").trim();
    const fl = f.toLowerCase();
    const prevParts = partsOf(prev);

    // Presentation only: the same data question (P69); the page's chart controls change the chart.
    if (/\b(?:bar|line|pie|column|area)\s+(?:chart|graph)\b|\b(?:chart|graph|plot)\b|\blabels?\b|\bcolou?rs?\b|\bsort(?:ed)?\b|\blegend\b|\baxis\b/i.test(fl)
      && !/\b(?:rate|population|agencies|by (?:year|month|quarter|race|sex|age|ethnicity))\b/i.test(fl))
      return ok(prev, "presentation only: the data question is unchanged", "presentation");

    // A complete question of its own (its own crime and place): asked as it is, nothing inherited.
    const own = partsOf(raw);
    if (own.measures.length && own.places.length) return ok(raw, "a complete question of its own", "new");

    // P72: supporting columns.
    if (/\bpopulation\b/.test(fl) && /\b(?:add|show|include|with|column)\b/.test(fl))
      return /\brate\b/i.test(prev) ? ok(`${prev.replace(/[?.]\s*$/, "")}, with a column showing the population used to calculate the rate`, "P72: the population used for the rate")
        : ask("A population column goes with a rate (P72); the previous answer has no rate.");
    if (/\bhow many agencies (?:reported|report)|\bagencies reporting\b/.test(fl)) {
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
    if (/\bquarter(?:ly|s)?\b/.test(fl)) {
      if (/\bby month\b/i.test(prev)) return ok(prev.replace(/\bby month\b/i, "by quarter"), "P71: quarters as sums of months");
      return YEAR.test(prev) ? ok(beforePeriod(prev, "by quarter"), "P71: quarters as sums of months") : ask("Which period to show by quarter.");
    }
    const grain = /^(?:(?:show it |break it down |split it )?by (month|year)|(monthly|annually|yearly|per month|per year|each month|each year))$/i.exec(f);
    if (grain) {
      const g = /month/i.test(grain[1] ?? grain[2]) ? "month" : "year";
      if (/\bby (?:month|year|quarter)\b/i.test(prev)) return ok(prev.replace(/\bby (?:month|year|quarter)\b/i, `by ${g}`), "the time grain replaced");
      return ok(beforePeriod(prev, `by ${g}`), "the time grain added");
    }

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
    if (/\bonly\b.*\boffenders?\b.*\blinked\b|\blinked offenders?\b|\bwho (?:killed|attacked) (?:them|each victim)\b/.test(fl)) {
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
      if (!has) return ask(`Whether "${sx[1]}" means victims, offenders or arrestees.`);
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
      const yearOnly = /^(?:in\s+)?((?:19|20)\d{2})$/i.exec(target.trim());
      const newPlace = t.places.length ? target.replace(/\s+in\s+(?:19|20)\d{2}$/i, "").replace(/^the\s+/i, "").trim() : null;
      const newYear = yearOnly?.[1] ?? /\bin\s+((?:19|20)\d{2})$/i.exec(target)?.[1] ?? null;
      if (!newPlace && !newYear) return ask(`What "${target}" changes in the previous question.`);
      let q = prev;
      if (newPlace) {
        const pw = placeWords(prev, prevParts.places);
        if (!pw) return ask("Where to put the new place.");
        if (adding) {
          const list = prevParts.places.length > 1 ? pw.text.replace(/\s+and\s+(?=[^,]*$)/, ", ") : pw.text;
          q = `${q.slice(0, pw.at)}${list} and ${newPlace}${q.slice(pw.at + pw.text.length)}`;
        } else if (prevParts.places.length > 1) {
          const list = pw.text.replace(/\s+and\s+(?=[^,]*$)/, ", ");
          return ask(`Whether ${newPlace} replaces ${pw.text} or is added to them.`, [
            { label: `${newPlace} only`, question: clean(`${prev.slice(0, pw.at)}${newPlace}${prev.slice(pw.at + pw.text.length)}`) },
            { label: `Add ${newPlace}; show all ${COUNT[prevParts.places.length + 1] ?? prevParts.places.length + 1} separately`, question: clean(`${prev.slice(0, pw.at)}${list} and ${newPlace}${prev.slice(pw.at + pw.text.length)}`) }]);
        } else q = `${q.slice(0, pw.at)}${newPlace}${q.slice(pw.at + pw.text.length)}`;
      }
      if (newYear) {
        const one = /\b(in|during)\s+((?:19|20)\d{2})\b/i.exec(q);
        if (/\bfrom\s+(?:19|20)\d{2}\s+(?:to|through)\b|\bsince\b|\band\s+(?:19|20)\d{2}\b/i.test(q)) return ask(`Whether ${newYear} replaces the whole period or is added to it.`);
        q = one ? q.replace(one[0], `${one[1]} ${newYear}`) : `${q.replace(/[?.]\s*$/, "")} in ${newYear}`;
      }
      return ok(q, adding ? "a place added" : newPlace && newYear ? "the place and year replaced" : newPlace ? "the place replaced" : "the year replaced or added");
    }

    // A crime in place of the previous one ("now murders instead").
    const cr = partsOf(`${ucFirst(f)} in Memphis in 2024`);
    if (cr.measures.length === 1 && /\binstead\b/i.test(raw) || (cr.measures.length === 1 && cr.all.every((p) => ["measure", "place", "period", "filler"].includes(p.concept)) && f.split(/\s+/).length <= 3)) {
      const m = prevParts.measures[0];
      if (!m || prevParts.measures.length !== 1 || prev.indexOf(m.text) < 0) return ask("Which crime to replace.");
      const word = /^[A-Z]/.test(prev.slice(prev.indexOf(m.text))) ? ucFirst(f) : f;
      return ok(prev.replace(m.text, word), "the crime replaced");
    }
    return ask("The follow-up could not be placed in the previous question with certainty; ask the full question.");
  },
};
