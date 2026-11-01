/**
 * Plain wording for every user-facing string of the shadow (P74, Jeff 2026-11-01: "The answers need to be much, much
 * more crystal clear for users"; design: docs/superpowers/specs/2026-11-01-plain-wording.md, Codex design check
 * applied). A decline, a question back, a button and a note:
 *   - say in plain words what the data records ("Clearances are recorded for each offense");
 *   - say why the question can't be answered as asked;
 *   - offer the nearest answerable question as a button whenever one exists;
 *   - never use engine vocabulary.
 * `jargon` finds engine vocabulary (the tests fail when any reaches user-facing text); `plainReaderText` rewords the
 * reader's refusals, which come from modules shared with the live routes and so are reworded here, not there.
 */

/**
 * Engine vocabulary: targeted words and phrases, each with what it is, checked against examples in the tests (plain
 * English such as "the data records past crime" and "reading the table" passes). Words the user typed, quoted back in
 * double quotes, are not checked.
 */
export const BANNED: { re: RegExp; what: string }[] = [
  { re: /\bslice\b/i, what: "slice" },
  { re: /\bshadow\b/i, what: "shadow" },
  { re: /\b[PDFGRSAC]\d{1,3}\b/, what: "a policy or rule id" },
  { re: /\bv0\b/i, what: "v0" },
  { re: /\btyped reading\b|\bno (?:typed )?reading\b|\bthis reading\b|\bplan form\b/i, what: "an engine reading" },
  { re: /\binterpret(?:s|ed|ing)?\b/i, what: "interpret" },
  { re: /\bappl(?:y|ied|ies)\b/i, what: "apply" },
  { re: /\bunits?\b/i, what: "unit" },
  { re: /\boffense records\b|\boffender records\b|\bNIBRS records\b(?! (?:crimes|past))|\brecords? (?:of|for) (?:each|one|the)\b/i, what: "record (as a noun)" },
  { re: /\bdimensions?\b|\bfields?\b|\bsegments?\b|\bledger\b|\bcompil(?:e|ed|er|es|ing)\b|\bthe plan\b|\bplans?\b(?= (?:did|form|language))|\bthe reader\b|\bbindings?\b|\bvalidat\w*/i, what: "an engine word" },
  // snake_case, dotted ids and lowerCamelCase; a name such as "McGregor" is not a code name.
  { re: /\b[a-z]+_[a-z_]+\b|\b[a-z]{3,}\.[a-z_]{3,}\b|\b[a-z]+[A-Z]\w*\b/, what: "a code name" },
  { re: /\bnot in the slice\b|\bnot built\b|\bincrement\b|\bexecutable definition\b/i, what: "build status" },
];

/**
 * What a user reads when a part of the engine can't answer this combination: a compiler, validation or contract reason
 * is kept in the decline's `detail` for logs, never shown.
 */
export const NOT_YET = "I can't answer this combination yet. Try a simpler version, for example one crime in one place for one year.";

/** The text a check sees: the user's own words, quoted back, are left out. */
const unquoted = (text: string) => text.replace(/"[^"]*"/g, '""');
/** The engine words in a user-facing string, or [] when it is plain. */
export function jargon(text: string): string[] {
  const t = unquoted(text);
  return BANNED.filter((b) => b.re.test(t)).map((b) => b.what);
}

/* ---------------------------------------------- the reader's text, reworded at the shadow's boundary -------------- */

const q = (x: string) => `"${x.trim()}"`;
/** The reader's reasons ("I can't apply "X": <reason> I haven't answered ..."), each as a plain sentence naming X. */
export const REASONS: Record<string, (x: string) => string> = {
  "I report what NIBRS records; I can't explain causes.": () => "The data shows how many crimes were reported; it can't say why they rose or fell.",
  "that is answered only by its own fixed path, which couldn't answer this request.": (x) => `Comparing with ${q(x)} isn't available yet.`,
  "one counting unit per question; ask for victims, offenders, arrests or offenses separately.": () => "I can count victims, offenders, arrests or offenses, one at a time; this question asks for more than one.",
  "I couldn't resolve that place to one NIBRS agency, a state or the nation.": (x) => `I couldn't find ${q(x)} as a police agency, a state or the nation.`,
  "I couldn't read that as a period.": (x) => `I couldn't tell which period ${q(x)} means.`,
  "I give one breakdown per answer; ask for one breakdown at a time.": (x) => `I can break the numbers down one way at a time; ${q(x)} would be a second breakdown.`,
  "rates are given per 100,000 people.": () => "Rates are given per 100,000 residents.",
  "I rank places by a level, not by a change, in this version.": () => "Places can be ranked by their numbers, not yet by how much they changed.",
  "I can apply one minimum population (\"at least\" or \"over\"), not a maximum.": () => "A ranking can take one minimum population (\"at least\" or \"over\"), not a maximum.",
  "a ranking covers the nation or one state.": () => "A ranking covers the cities of one state or of the nation.",
  "a ranking covers a full year.": () => "A ranking covers one full year.",
  "states are ranked without a population minimum.": () => "States are ranked without a population minimum.",
  "a state ranking covers every state; it can't be limited to one place.": () => "A ranking of states covers every state; it can't be limited to one place.",
  "a combined category counts victims and offenses together, and states aren't ranked on a mixed count in this version.": () => "This group of crimes counts victims for some crimes and offenses for others, so states can't be ranked on it yet.",
  "rankings count each offense in its standard unit (victims for crimes against persons, offenses otherwise); a ranking in another unit isn't built.": () => "Rankings count victims for crimes against people and offenses for other crimes; other counts aren't available for rankings yet.",
  "a ranking of only part of an offense isn't built.": () => "Rankings of part of a crime (for example only robberies with a firearm) aren't available yet.",
  "I compare one measure for one place between two named years (for example \"from 2023 to 2025\").": () => "I can compare one crime in one place between two years, for example \"from 2023 to 2025\".",
  "a share covers one period as a whole; ask for each year on its own.": () => "A share covers one period as a whole; ask for each year on its own.",
  "one period per answer.": (x) => `I can answer for one period at a time; ${q(x)} would be a second one.`,
  "rates are given for complete years, not for single months.": () => "Rates are given for whole years, not single months.",
  "a rate over several years is given per year; ask without \"total\" for one rate per year.": () => "A rate over several years is given for each year; ask without \"total\" to see one rate per year.",
  "breakdowns come from yearly tables; monthly or rolling breakdowns aren't available.": () => "Breakdowns are available by year, not by month or as rolling totals.",
  "breakdowns come from yearly tables; a breakdown for part of a year isn't available.": () => "Breakdowns are available for whole years, not for part of a year.",
  "a breakdown covers one year or one range of years; ask for each year on its own.": () => "A breakdown covers one year or one range of years; ask for each year on its own.",
  "clearance figures count offense records, not other units.": (x) => `Clearances are recorded for each offense, not for each person, so they can't be counted by ${q(x)}.`,
  "NIBRS's clearance tables don't record it, so a clearance share can't be restricted by it.": (x) => `Clearances aren't recorded with ${q(x)}, so a share of clearances can't be limited by it.`,
  "NIBRS's clearance tables don't record it, so a clearance breakdown can't be restricted by it.": (x) => `Clearances aren't recorded with ${q(x)}, so clearances can't be broken down by it.`,
  "this answer type doesn't list every place.": () => "This kind of answer doesn't list every place.",
  "comparisons are answered as named places side by side; ask for the places and the years.": () => "To compare, name the places and the years, for example \"Memphis and Nashville in 2024\".",
  "that time grain isn't available for this answer.": (x) => `${q(x)} isn't available for this kind of answer.`,
  "clearance figures need an offense, one place and a year.": () => "Clearances need a crime, one place and a year.",
  "I couldn't use it in a supported question type.": (x) => `I couldn't use ${q(x)} in this question.`,
  "I can't look an agency up by its ORI code here; please ask by the agency's name.": () => "I can't look up an agency by its FBI code; please ask by the agency's name.",
  "that asks for two rankings at once (which offense and which place); ask for one ranking at a time.": () => "That asks for two rankings at once (which crime and which place); ask for one ranking at a time.",
  "I can't turn that into specific years; please give the years (for example \"from 2020 to 2023\").": () => "I can't tell which years that means; please give the years, for example \"from 2020 to 2023\".",
  "a per-capita rate for a demographic group needs population denominators by race, sex or age that the FBI data does not include. I can show raw counts, or the group's share of reported victims, offenders or arrestees.":
    () => "A rate for a group of people needs population figures by race, sex or age, which the FBI data doesn't include. I can show counts, or the group's share of reported victims, offenders or arrestees.",
};
const APPLY = /^I can't apply "([^"]+)": ([\s\S]+?)\s*I haven't answered with a number that leaves it out\.$/;
const UNREAD = /^I couldn't interpret "([^"]+)" in this question/;
/** The reader's "doesn't record W, so I can't apply X" sentences: known by their opening, reworded word for word. */
const NOT_RECORDED = /^(?:NIBRS doesn't record|NIBRS does not track shootings as a category|Current Trends doesn't track|Historical doesn't record)/;

/**
 * One reader part as plain text: an unread phrase (said together with the others), a sentence, or, for a sentence this
 * module does not know, a plain fallback; `unmapped` carries the original so the tests fail on it.
 */
export function plainPart(p: { text: string; explanation?: string }): { unread?: string; sentence?: string; unmapped?: string } {
  const e = (p.explanation ?? "").trim();
  if (!e || UNREAD.test(e)) return { unread: (UNREAD.exec(e)?.[1] ?? p.text).trim() };
  const a = APPLY.exec(e);
  if (a) {
    const r = REASONS[a[2].trim()];
    return r ? { sentence: r(a[1]) } : { sentence: `I couldn't use ${q(a[1])} in this question.`, unmapped: e };
  }
  if (NOT_RECORDED.test(e))
    return { sentence: e.replace(/\s*I haven't answered with a number that leaves it out\./g, "").replace(/,? so I can't apply "([^"]+)"/g, (_m, x) => `, so "${x}" can't be counted`)
      .replace(/\bdoesn't record\b/g, "doesn't include").replace(/\bdoes not track\b/g, "doesn't count").replace(/; it records\b/g, "; it covers") };
  return { sentence: `I couldn't use ${q(p.text)} in this question.`, unmapped: e };
}

/** Unknown reader sentences met so far: the user saw a plain fallback; the tests read this and fail on any. */
export const UNMAPPED: string[] = [];

/** The reader's refusal for a question, in plain words: unread phrases first, then the other reasons. */
export function plainReaderText(parts: { text: string; explanation?: string }[]): string {
  const unread: string[] = [], sentences: string[] = [];
  for (const p of parts) {
    const x = plainPart(p);
    if (x.unmapped) UNMAPPED.push(x.unmapped);
    if (x.unread) { if (!unread.includes(x.unread)) unread.push(x.unread); }
    else if (x.sentence && !sentences.includes(x.sentence)) sentences.push(x.sentence);
  }
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).map(q).join(", ")} or ${q(xs[xs.length - 1])}` : q(xs[0]));
  return [...(unread.length ? [`I didn't understand ${list(unread)}.`] : []), ...sentences, ...(unread.length ? ["Try asking it another way."] : [])].join(" ");
}
