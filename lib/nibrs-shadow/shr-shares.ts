/**
 * Homicide Reports shares (P210 to P214, Engine 2.0's definitions, the coordinator's order 2026-11-22): the national (or one state's) murders by a grouping
 * the question names, as a table of the groups with their counts and shares:
 *
 *   felony murder vs argument murder           circumstances (P210)
 *   stranger vs acquaintance                    relationships (P211)
 *   intraracial / interracial, by black males   races (P212)
 *   non-firearm, via firearm                    weapons (P213)
 *
 * A share over several years (or no period named: every year the source has) is a row for each year, each year its own share (P214). The shares are
 * Homicide Reports' own counts, summed over the agencies that filed, with the coverage lines the other Homicide Reports answers carry.
 */
import { readQuestion } from "./reading";
import { SHR_FIRST_YEAR, SHR_RELATIONSHIP, type ShrBuild, type ShrFilter, type ShrQuestion } from "./shr";
import { STATE_NAMES } from "./places";

type Groups = NonNullable<ShrQuestion["breakdown"]>;
const KNOWN_RACE = "('W', 'B', 'I', 'A', 'P')";
const KEYS = "o.data_year = r.data_year AND o.source_line_no = r.source_line_no AND o.in_record";
const OFFENDER_RACE: Record<string, string> = { black: "B", white: "W", asian: "A", indian: "I", native: "I" };
const OFFENDER_SEX: Record<string, string> = { male: "M", males: "M", men: "M", man: "M", female: "F", females: "F", women: "F", woman: "F" };

type Family = { breakdown: Groups; filters: ShrFilter[]; notes: string[] } | null;

/**
 * A felony or misdemeanor request is declined whole, with the reason (Jeff 2026-11-22: "we don't count felonies as that's a charging device"): a felony and a
 * misdemeanor are classifications a prosecutor charges, and the data does not record them. Asked as a share, a comparison or a trend of murders (no partial answer).
 */
export const FELONY_WORDS = /\b(?:felony|felonies|felonious|misdemeanou?rs?)\b/i;
export function shrShareDecline(question: string): string | null {
  if (!FELONY_WORDS.test(question)) return null;
  return "This isn't available: felony and misdemeanor are charging classifications, and the data doesn't record them.";
}
/** The question without the word ("felony murders" is "murders"), or null when nothing is left to ask. */
export function withoutFelonyWords(question: string): string | null {
  // "Felony assaults" and "misdemeanor assaults" are offered as the aggravated and the simple assaults (Jeff 2026-11-22, QL-ct-c605731327); the rest lose the word.
  const named = question.replace(/\bfelony\s+assaults?\b/gi, (m) => (/s$/i.test(m) ? "aggravated assaults" : "aggravated assault"))
    .replace(/\bmisdemeanou?r\s+assaults?\b/gi, (m) => (/s$/i.test(m) ? "simple assaults" : "simple assault")).replace(/\bsimply\s+assaults?\b/gi, (m) => (/s$/i.test(m) ? "simple assaults" : "simple assault"));
  const s = named.replace(/\b(?:felony|felonies|felonious|misdemeanou?rs?)\b\s*(?:vs\.?|versus|and|or|,)?\s*/gi, "").replace(/\s{2,}/g, " ").replace(/\s+([?.!,])/g, "$1").trim();
  return s && s !== question && /[a-z]{3}/i.test(s) ? s : null;
}

/** The grouping a question asks for, or null when it is not one of these shares. */
export function shrShareFamily(question: string): Family {
  const q = question.replace(/\s+/g, " ");
  const murderWord = /\b(?:murders?|homicides?|killings?)\b/i.test(q);
  if (!murderWord || /\b(?:cleared|clearance|arrests?|arrested|cities|city|agencies|per\s+100,?000|rate)\b/i.test(q)) return null;
  // A share, a proportion or a comparison; a plain count ("murders from arguments in Houston") keeps its own path.
  const shareWord = /\b(?:shares?|percent(?:age)?|proportion|portion|vs\.?|versus)\b|%/i.test(q);
  const both = (a: RegExp, b: RegExp) => a.test(q) && b.test(q);
  // P210 (Jeff 2026-11-22: felonies are a charging device and are not counted): arguments only; "felony" and "misdemeanor" are declined by shrShareDecline.
  if (/\barguments?\b/i.test(q) && (shareWord || /\b(?:other\s+circumstances?|circumstances?)\b/i.test(q)) && !/\b(?:felony|felonies|misdemeanou?rs?)\b/i.test(q))
    return { breakdown: { dim: "circumstance", header: "Circumstance", words: "circumstance", groups: [
      { label: "Arguments", codes: ["44", "45"] }, { label: "Undetermined", codes: ["99"] }], rest: "Other circumstances" },
      filters: [], notes: ["Arguments are arguments over money or property and other arguments; every other circumstance the agencies recorded is in \"Other circumstances\"."] };
  // P211: stranger and acquaintance.
  if (/\b(?:strangers?|acquaintances?|knew\s+(?:their|the)\s+(?:killer|murderer|offender)|known\s+to\s+the\s+victim)\b/i.test(q) && (shareWord || both(/\bstrangers?\b/i, /\bacquaintances?\b/i) || /\bknew\b/i.test(q)))
    return { breakdown: { dim: "relationship", header: "Relationship to the offender", words: "the victim's relationship to the offender", groups: [
      { label: "Stranger", codes: ["ST"] }, { label: "Acquaintance", codes: ["AQ"] },
      { label: "Other known to the victim", codes: Object.keys(SHR_RELATIONSHIP).filter((c) => !["ST", "AQ", "UN"].includes(c)) }, { label: "Unknown", codes: ["UN"] }], rest: "Not recorded" },
      filters: [], notes: ["Acquaintance is the FBI's own category; friends, neighbors, employees and the rest known to the victim are in \"Other known to the victim\"."] };
  // P212: the same race or not; murders by an offender's race and sex.
  if (/\b(?:intra-?\s?racial|inter-?\s?racial|same[- ]race|different[- ]races?)\b/i.test(q))
    return { breakdown: { dim: "victim.race", header: "Races of the victim and the offender", words: "whether the victim and the offender are of the same race", shareOfGroups: true, groups: [
      { label: "Same race (intraracial)", codes: [], when: `p.in_record AND p.race IN ${KNOWN_RACE} AND EXISTS (SELECT 1 FROM {shr_offender} o WHERE ${KEYS} AND o.race = p.race)` },
      { label: "Different races (interracial)", codes: [], when: `p.in_record AND p.race IN ${KNOWN_RACE} AND EXISTS (SELECT 1 FROM {shr_offender} o WHERE ${KEYS} AND o.race IN ${KNOWN_RACE})` }],
      rest: "Race not known for the victim or the offender" }, filters: [],
      notes: ["Only murders in which both the victim's race and the first offender's race are known are classed; the shares are of those, and the murders left out are on the last line."] };
  const by = /\b(?:commit+ed|carried\s+out|done|killed|murdered)\s+by\s+(black|white|asian|indian|native)s?(?:\s+(males?|men|females?|women))?\b/i.exec(q)
    ?? /\bby\s+(black|white|asian)s?\s+(males?|men|females?|women)\b/i.exec(q);
  if (by && shareWord) {
    const race = OFFENDER_RACE[by[1].toLowerCase()], sex = by[2] ? OFFENDER_SEX[by[2].toLowerCase()] : null;
    const victimRace = /\b(white|black|asian)\s+(?:homicides?|murders?|victims?)\b/i.exec(q)?.[1];
    const label = `${by[1][0].toUpperCase()}${by[1].slice(1).toLowerCase()}${sex ? (sex === "M" ? " male" : " female") : ""} offender`;
    const known = `o.race IN ${KNOWN_RACE}`;
    return { breakdown: { dim: "offender.race", header: "Offender", words: sex ? "the offender's race and sex" : "the offender's race", shareOfGroups: false, groups: [
      { label, codes: [], when: `EXISTS (SELECT 1 FROM {shr_offender} o WHERE ${KEYS} AND o.race = '${race}'${sex ? ` AND o.sex = '${sex}'` : ""})` },
      { label: "Other offender", codes: [], when: `EXISTS (SELECT 1 FROM {shr_offender} o WHERE ${KEYS} AND ${known})` }], rest: "Offender not known" },
      filters: victimRace ? [{ dim: "victim.race", codes: [OFFENDER_RACE[victimRace.toLowerCase()]] }] : [],
      notes: ["The offender is the first offender recorded; the murders whose offender's race is not known are their own line."] };
  }
  // P213: non-firearm and firearm.
  if ((/\bnon-?\s?firearms?\b|\bwithout\s+(?:a\s+)?firearms?\b|\bnot\s+(?:with|by)\s+(?:a\s+)?firearms?\b/i.test(q))
    || (shareWord && /\b(?:commit+ed|come|came|killed|done)\s+(?:via|with|by|using)\s+(?:a\s+)?(?:firearms?|guns?)\b/i.test(q)))
    return { breakdown: { dim: "weapon", header: "Weapon", words: "weapon", groups: [{ label: "Firearm", codes: ["11", "12", "13", "14", "15"] }], rest: "Non-firearm" },
      filters: [], notes: ["Firearms are the five firearm codes (type not stated, handgun, rifle, shotgun, other gun). \"Other or unknown weapon\" cannot be split between firearm and not, so it is counted as non-firearm."] };
  return null;
}

/** The question for the nation or a state, its period as a row per year (several years, or none named: every year the source has), or null. */
export function shrShareQuestion(question: string, build: ShrBuild): ShrQuestion | null {
  const fam = shrShareFamily(question);
  if (!fam) return null;
  const r = readQuestion(question, Number(build.latestMonth.slice(0, 4)), build.latestMonth);
  const parts = r.ledger.parts.filter((p) => p.clause === 0);
  const places = parts.filter((p) => p.concept === "place");
  if (places.length > 1) return null;
  const pv = String(places[0]?.value ?? "national");
  const stateName = /^state:(.+)$/.exec(pv)?.[1];
  const code = stateName ? Object.entries(STATE_NAMES).find(([, n]) => n.toLowerCase() === stateName.toLowerCase())?.[0] : undefined;
  if (places.length && pv !== "national" && !code) return null;
  const latest = Number(build.latestMonth.slice(0, 4));
  const periods = parts.filter((p) => p.concept === "period");
  if (periods.length > 1) return null;
  let fromY = SHR_FIRST_YEAR, toY = latest, askedFrom: string | undefined;
  let grain: ShrQuestion["grain"] = "year";
  const notes = [...fam.notes];
  if (periods.length) {
    const v = /^(?:(year):(\d{4})|(range):(\d{4}):(\d{4})|(since):(\d{4}))$/.exec(String(periods[0].value));
    if (!v) return null;
    if (v[1]) { fromY = toY = Number(v[2]); grain = parts.some((p) => p.concept === "grain" && p.value === "year") ? "year" : "total"; }
    else if (v[3]) { fromY = Number(v[4]); toY = Number(v[5]); }
    else { fromY = Number(v[7]); }
    if (fromY < SHR_FIRST_YEAR) { askedFrom = String(fromY); fromY = SHR_FIRST_YEAR; }
    if (toY > latest) toY = latest;
    if (fromY > toY) return null;
  } else notes.push(`No years were given, so every year in the data is shown: ${SHR_FIRST_YEAR} through ${latest}.`);
  if (!places.length) notes.push("No place was named, so the United States is shown.");
  const to = toY >= latest ? build.latestMonth : `${toY}-12`;
  return { measure: /\bhomicides?\b/i.test(question) && !/\bmurders?\b/i.test(question) ? "homicide" : "murder", unit: "victims", place: code ? { kind: "state", code } : { kind: "national" },
    from: `${fromY}-01`, to, grain, filters: fam.filters, breakdown: fam.breakdown, share: true, ...(askedFrom ? { askedFrom } : {}), notes };
}
