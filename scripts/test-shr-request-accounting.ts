/*
 * SHR request accounting (stage 1, task 2): every case is PAIRED -- an unsupported or unknown
 * condition is refused at recognition, and its supported counterpart is not. Pure recognition: no
 * database, no route, no model.
 */
import { accountShrRequest, shrRecognitionRefusal, SHR_IMMIGRATION_NOT_RECORDED, SHR_OVERDOSE_NOT_RECORDED } from "../lib/shr-request-accounting";

let checks = 0;
let failures = 0;
function check(ok: boolean, label: string): void {
  checks += 1;
  if (!ok) { failures += 1; console.log(`  FAIL  ${label}`); } else console.log(`  PASS  ${label}`);
}
const refusal = (q: string, opts = {}) => shrRecognitionRefusal(accountShrRequest(q, opts));
const parts = (q: string) => accountShrRequest(q).evidence();
const conceptOf = (q: string, text: string) => parts(q).find((p) => p.text === text);

/** [refused, supported counterpart, what the refusal must name] */
const PAIRS: [string, string, RegExp][] = [
  ["murder via banana in Texas in 2025", "murder via knife in Texas in 2025", /couldn't interpret "via banana" as a weapon/],
  ["murders using a banana in Texas", "murders using a gun in Texas", /couldn't interpret "using a banana" as a weapon/],
  ["homicide victims in Alabama in 2025 limited to immigrants", "homicide victims in Alabama in 2025 limited to female victims", /don't record immigration or citizenship status/],
  ["homicide victims in Alabama in 2025 who were legal immigrants", "homicide victims in Alabama in 2025 who were female", /don't record immigration or citizenship status/],
  ["immigrant homicide victims", "female homicide victims", /don't record immigration/],
  ["murders of undocumented migrants in Texas", "murders of black men in Texas", /don't record immigration/],
  ["homicides of non-citizens in California in 2022", "homicides of children in California in 2022", /don't record immigration/],
  ["murder victims by citizenship status in Florida", "murder victims by race in Florida", /don't record immigration/],
  ["homicides in Alabama in 2025 reported by ICE", "homicides in Alabama in 2025 reported by Houston police", /couldn't identify "ICE" as a reporting agency/],
  ["number of homicides in Alabama in 2025 according to ICE", "number of homicides in Alabama in 2025 according to sheriffs", /couldn't identify "ICE"/],
  ["number of homicides by ICE in Alabama in 2025", "number of homicides by firearm in Alabama in 2025", /couldn't identify "ICE"/],
  ["homicides in Alabama in 2025 recorded by Immigration and Customs Enforcement", "homicides in Alabama in 2025 recorded by Mobile police", /couldn't identify "Immigration and Customs Enforcement"/],
  ["homicides in Alabama for a report limited to immigrants", "homicides in Alabama for an immigration research report", /don't record immigration/],
  ["murders in Texas in 2025 frobnicated", "murders in Texas in 2025", /couldn't interpret "frobnicated"/],
  ["left-handed murder victims in Texas", "male murder victims in Texas", /couldn't interpret "left-handed"/],
  ["murders in Texas on Tuesdays", "murders in Texas in June", /couldn't interpret/],
];

for (const [bad, good, names] of PAIRS) {
  const r = refusal(bad);
  check(r !== null && names.test(r.explanation), `refused, naming it: "${bad}" -> ${r?.explanation.slice(0, 120)}`);
  const g = refusal(good);
  check(g === null, `counterpart not refused at recognition: "${good}"${g ? " -> " + g.explanation : ""}`);
}

check(refusal("number of homicides in Alabama in 2025 regardless of immigration status") === null, "an explicit non-restriction (regardless of immigration status) is context");
check(refusal("immigration-status homicide victims in Alabama in 2025")?.explanation.includes("don't record immigration") === true, "hyphenated immigration-status is the not-recorded concept");
check(refusal("in Alabama in 2025, how many immigrants were homicide victims")?.explanation === SHR_IMMIGRATION_NOT_RECORDED, "a leading place preposition is context; only the not-recorded sentence remains");

// Recognized-but-unsupported shapes are NOT refused at recognition: the owning path keeps its wording.
for (const q of [
  "homicides in Alabama in summer 2025", "homicides in Alabama in Q2 2025", "homicides in baldwin county al in 2025 excluding Bay Minette",
  "murder rate per capita in Texas", "homicides in Alabama in fiscal year 2025", "murders in Texas by year since 2010",
  "Which 10 cities (min 30 murders) had the highest share via firearm in 2025?", "median age of fatal shooting victims per year",
  "number of homicides in nowhere county al in 2025", "murders in Smallville",
]) {
  const r = refusal(q);
  check(r === null, `recognized shape left to its path: "${q}"${r ? " -> " + r.explanation : ""}`);
}

// Relationship values that look like employment or orientation are recognized, never denied.
for (const [q, text] of [
  ["murders of employees by their employers", "of employees"],
  ["homicides involving same-sex partners in 2020", "involving same-sex partners"],
  ["homicides in a homosexual relationship in Ohio", "homosexual relationship"],
] as const) {
  const p = parts(q).find((e) => e.text.includes(text.split(" ").pop()!));
  check(p?.concept === "relationship" && refusal(q) === null, `relationship value recognized: "${q}" (${p?.concept}:${p?.text})`);
}
check(refusal("murders of unemployed victims in Ohio") !== null, "employment STATUS (not a relationship value) is not invented as recognized");

// The not-recorded wording is the evidence-backed sentence, once, even with two mentions.
{
  const r = refusal("immigrant victims killed by undocumented offenders in Texas");
  check(r !== null && r.explanation.split(SHR_IMMIGRATION_NOT_RECORDED).length === 2, "one not-recorded sentence for two mentions");
}

// A purpose clause cannot swallow a restriction; a topical one is context.
check(conceptOf("homicides in Alabama in 2025 for an ICE hockey research report", "for an ICE hockey research report")?.state === "context", "ICE inside a whole purpose clause is context");
check(refusal("homicides in Alabama in 2025 for a report on immigrants") !== null, "\"for a report on immigrants\" is not a purpose clause; immigrants is refused");

// Connectors are recognized parts (never filler), so and/or reach the planner.
check(conceptOf("murders in Texas or Ohio", "or")?.concept === "connector", "\"or\" is a connector part");
check(conceptOf("firearm and knife murders in Ohio", "and")?.concept === "connector", "\"and\" is a connector part");
check(conceptOf("murders in Texas not in 2025", "not")?.concept === "connector", "\"not\" is a connector part, never filler");

// State codes: a code after a place is a place; an English word after a place is not.
check(conceptOf("number of homicides in baldwin county al in 2025", "baldwin county al")?.concept === "place", "catalog county with code");
check(conceptOf("homicides in mobile county al in 2025", "al")?.concept === "place", "code after an unresolved county");
check(conceptOf("homicides in Texas in 2025", "in 2025")?.concept === "period", "\"in\" after a place is not Indiana");
check(conceptOf("Number of overdose deaths in NJ since 1990", "NJ")?.concept === "place", "upper-case code after a preposition");

// A known-agency callback resolves residue that names an SHR agency.
{
  const q = "Fatal shootings for METROPOLITAN NASHVILLE P by year";
  const known = accountShrRequest(q, { knownAgency: (t) => t.toUpperCase() === "METROPOLITAN NASHVILLE P" }).evidence();
  check(known.some((p) => p.rule === "place:shr-agency" && p.text === "METROPOLITAN NASHVILLE P"), "an SHR agency name is a place via the agency index");
}

// Cross-turn: a follow-up fragment carries the earlier turn's conditions unless it restates that kind.
{
  const earlier = ["female firearm murder victims in Texas in 2025"];
  const l = accountShrRequest("what about 2024?", { earlierTurns: earlier });
  const inherited = l.parts.filter((p) => p.inherited).map((p) => p.concept).sort();
  check(JSON.stringify(inherited) === JSON.stringify(["measure", "place", "role", "sex", "weapon"]), `a fragment inherits every unrestated condition: ${inherited}`);
  check(!l.parts.some((p) => p.inherited && p.concept === "period"), "a restated year replaces the earlier year");
  const ohio = accountShrRequest("what about Ohio?", { earlierTurns: earlier });
  check(!ohio.parts.some((p) => p.inherited && p.concept === "place") && ohio.parts.some((p) => p.inherited && p.concept === "period"), "a restated place replaces the earlier place; the year carries");
  const standalone = accountShrRequest("murders in Ohio in 2022", { earlierTurns: earlier });
  check(!standalone.parts.some((p) => p.inherited), "a full new question inherits nothing");
  const refusedBefore = shrRecognitionRefusal(accountShrRequest("what about 2024?", { earlierTurns: ["homicide victims in Alabama in 2025 limited to immigrants"] }));
  check(refusedBefore !== null && refusedBefore.explanation === SHR_IMMIGRATION_NOT_RECORDED, "an earlier not-recorded restriction refuses the follow-up too");
  check(accountShrRequest("what about 2024?", { earlierTurns: earlier }).undischarged().length === 0, "inherited parts do not count as undischarged obligations");
  // Correction r1 (Codex #4): a breakdown never replaces a restriction of the same kind.
  const byYear = accountShrRequest("what about by year?", { earlierTurns: earlier });
  check(byYear.parts.some((p) => p.inherited && p.concept === "period" && /2025/.test(p.text)), "\"what about by year?\" keeps the earlier \"in 2025\"");
  const byWeapon = accountShrRequest("what about by weapon?", { earlierTurns: earlier });
  check(byWeapon.parts.some((p) => p.inherited && p.concept === "weapon" && /firearm/i.test(p.text)), "\"what about by weapon?\" keeps the earlier \"firearm\"");
  const knives = accountShrRequest("what about knives?", { earlierTurns: earlier });
  check(!knives.parts.some((p) => p.inherited && p.concept === "weapon"), "a restated weapon restriction replaces the earlier one");
  const monthly = accountShrRequest("what about by month?", { earlierTurns: ["murders in Texas by year in 2025"] });
  check(!monthly.parts.some((p) => p.inherited && /by year/i.test(p.text)) && monthly.parts.some((p) => p.inherited && /2025/.test(p.text)), "a new grouping replaces the old grouping and keeps the year");
}

// Answer batch A (2026-10-20). GC-106: overdose deaths are not a weapon; they are declined, never answered as
// Narcotics/Drugs homicides. The narcotics weapon and drug-related controls are unchanged.
{
  for (const q of ["Number of overdose deaths in NJ since 1990", "drug overdoses in Ohio", "opioid overdose deaths in Florida in 2020", "how many people died of an overdose in Texas"]) {
    const l = accountShrRequest(q);
    const r = shrRecognitionRefusal(l);
    check(r?.explanation === SHR_OVERDOSE_NOT_RECORDED, `overdose is not recorded: "${q}"`);
    check(!l.parts.some((p) => p.concept === "weapon"), `overdose is never read as a weapon: "${q}"`);
  }
  check(/do not provide a count of all overdose deaths/.test(SHR_OVERDOSE_NOT_RECORDED) && !/\d/.test(SHR_OVERDOSE_NOT_RECORDED), "the overdose limitation offers no number");
  const narcotics = accountShrRequest("homicides with narcotics in NJ");
  check(shrRecognitionRefusal(narcotics) === null && narcotics.parts.some((p) => p.concept === "weapon" && /narcotics/.test(p.text)), "homicides with narcotics stay the drug weapon");
  const related = accountShrRequest("drug-related homicides in Ohio in 2020");
  check(shrRecognitionRefusal(related) === null, "drug-related homicides are unchanged");
}
// GC-026 / GC-078: the questions as asked, with only the user's own (empty) history, carry no instruction text.
{
  const chicago = shrRecognitionRefusal(accountShrRequest("arrest rate by race for robbery in Chicago", { earlierTurns: [] }));
  check(chicago?.parts.map((p) => p.text).join("|") === "arrest", "GC-026 with no earlier turns: only \"arrest\" is unread (no instruction text)");
  check(shrRecognitionRefusal(accountShrRequest("Trends in crime in Mesa, Arizona, since 2017", { earlierTurns: [] })) === null, "GC-078 with no earlier turns: nothing is refused");
}

// Bounded fix (2026-10-23): filler-only refusals from logged traffic now read; substantive words still refuse by name.
for (const q of [
  "can you rank order cities by the number of homicides in 2025?", // L8971
  "number of male homicides by race over time", // L9287
  "What states have seen an increase in murder rates over the past 7 years?", // L2953
  "show the share of homicide incidents when the offender is a juvenile by victim-offender relationship", // L6308
  "show me annual counts of offenders by age from 1986 through 2025", // L3401
]) check(refusal(q) === null, `filler only, now read: "${q}"`);
for (const [q, word] of [
  ["share of 2025 murders with an identified suspect by race of the victim", "identified"], // L9237
  ["What is the murder rate of non-firearms per year since 2010?", "non-"], // L5490
  ["Show the count of offenders instead of victims", "instead"], // L3124
  ["show the same chart for only men", "same"], // L9286
  ["What share of homicides in South Carolina have been deemed justifiable since 2015?", "deemed"], // L4072
] as const) check(refusal(q)?.parts.some((p) => p.text.includes(word)) === true, `substantive word still refuses: "${word}" in "${q}"`);
{
  // "where" is a link only: a negation after it is the same recognized exclusion as after "who were", never filler.
  const neg = (q: string) => accountShrRequest(q).parts.filter((p) => p.text === "not").map((p) => `${p.concept}/${p.state}`).join();
  check(neg("share of murders where the victim was not black") === neg("share of murders of victims who were not black") && !neg("share of murders where the victim was not black").includes("context"), "a negation after \"where\" is the recognized exclusion, not filler");
}

// Every character is accounted for, and nothing is undischarged.
for (const q of ["murder via banana in Texas in 2025", "How many murders were reported by sheriffs in Missouri in 2026?", "Homicide Victims (All Homicides), Baldwin County Sheriff's Office, AL, 2025"]) {
  const l = accountShrRequest(q);
  check(l.residue().length === 0 && l.undischarged().length === 0, `fully accounted: "${q}"`);
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
