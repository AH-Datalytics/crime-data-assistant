/*
 * Request accounting, stage 2b (NIBRS), plan r1.1 task 3: the closed list of supported question types N1-N7
 * (lib/nibrs-question-types.ts). Each question is read into one spec, or a named decline or clarification; no part is
 * dropped or swapped. The compiled answers are checked end to end on the declared fixture by the 2b route witness; these
 * checks pin the matcher's decisions. No database, no route.
 */
import "./offline-evidence-guard";
import { accountNibrsRequest } from "../lib/nibrs-request-accounting";
import { matchNibrsType, type NibrsTypeDecision } from "../lib/nibrs-question-types";

let checks = 0;
let failures = 0;
function check(ok: boolean, label: string): void {
  checks += 1;
  if (!ok) { failures += 1; console.log(`  FAIL  ${label}`); } else if (!process.env.QUIET) console.log(`  PASS  ${label}`);
}
const decide = (q: string): NibrsTypeDecision => matchNibrsType(accountNibrsRequest(q));
const spec = (q: string) => { const d = decide(q); return d.kind === "spec" ? d.spec : null; };

// ---- N1 / N2: series ----
const s1 = spec("total robberies in Fort Worth, Texas from 2022 to 2025");
check(s1?.type === "series" && s1.grain === "total" && s1.measures.join() === "robbery", "\"total ... from 2022 to 2025\" is one period total");
const s2 = spec("robberies in Fort Worth, Texas by month in 2025");
check(s2?.type === "series" && s2.grain === "month", "by month is the month grain");
const s3 = spec("rolling 12-month robberies in Fort Worth, Texas for 2025");
check(s3?.type === "series" && s3.grain === "rolling", "rolling 12-month is the rolling grain");
const s4 = spec("robbery offenders in Fort Worth, Texas in 2025");
check(s4?.type === "series" && s4.unit === "offenders", "a stated unit is carried into the spec, never swapped");
const s5 = spec("robberies in Fort Worth, Texas and in Texas in 2025");
check(s5?.type === "series" && s5.places.length === 2 && s5.places.some((p) => p.kind === "state"), "N2: an agency and a state are each a place");
const s6 = spec("female robbery offenders under 18 in Fort Worth, Texas in 2025");
check(s6?.type === "series" && s6.filters.includes("sex:F") && s6.filters.includes("age:Under 18"), "N4: both filters are kept");

// ---- N3 / N5 breakdowns ----
const b1 = spec("robbery offenders in Fort Worth, Texas in 2025 by age group");
check(b1?.type === "breakdown" && b1.dim === "age" && b1.unit === "offenders", "N3: one breakdown in the stated unit");
check(decide("robbery offenders in Fort Worth, Texas in 2025 by age group and sex").kind === "decline", "two breakdowns are declined, never one dropped");
check(decide("murder victims in Fort Worth, Texas by weapon type by month in 2025").kind === "decline", "a monthly breakdown is declined (yearly tables)");
const b2 = spec("Fort Worth, Texas rape clearances by type in 2025");
check(b2?.type === "breakdown" && b2.dim === "clearance-type", "N5: clearances by type");
// Owner 2026-10-25: "by exception" with the type breakdown narrows it to the exceptional types; it is not a conflict.
{
  const ex = spec("virginia murder clearances by exception by type in 2025");
  check(ex?.type === "breakdown" && ex.dim === "clearance-type" && ex.filters.includes("clearance:exceptional"), `exceptional clearances by type is answered, narrowed to the exceptional types (${JSON.stringify(ex)})`);
  const ex2 = spec("Fort Worth, Texas rape clearances by type of exceptional clearance in 2025");
  check(ex2?.type === "breakdown" && ex2.dim === "clearance-type", "control: 'by type of exceptional' is the type breakdown");
  const conflict = decide("Fort Worth, Texas rape clearances by type for victims refused to cooperate in 2025");
  check(conflict.kind !== "spec", "control: a real restriction on the type breakdown still declines");
  const method = decide("Fort Worth, Texas rape clearances by arrest vs exception by exception in 2025");
  check(method.kind !== "spec" || (method.spec.type === "breakdown" && !method.spec.filters.includes("clearance:exceptional")) || method.spec.type !== "breakdown", "control: the method breakdown never silently keeps an exceptional-only restriction");
}
const b3 = spec("homicides nationally in 2025 by race of victim and race of offender");
check(b3?.type === "breakdown" && b3.dim === "victim-offender-race", "the victim-by-offender race cross-tab is one declared dimension");

// ---- shares (r1.1 R3) ----
const sh1 = spec("what share of robbery offenders in Fort Worth, Texas were under 18 in 2025?");
check(sh1?.type === "share" && sh1.subset.join() === "age:Under 18" && sh1.population.length === 0, "the subset is what follows \"were\"");
const sh2 = spec("share of rape clearances in Fort Worth, Texas in 2025 that were prosecution declined");
check(sh2?.type === "share" && sh2.denominator === "clearances", "\"share of rape clearances\" divides by clearances");
const sh3 = spec("what share of rapes in Fort Worth, Texas in 2025 were cleared because prosecution was declined?");
check(sh3?.type === "share" && sh3.denominator === "units", "\"share of rapes ... cleared because\" divides by offenses");
check(decide("prosecution declined share for rape in Fort Worth, Texas in 2025").kind === "clarify", "a share whose words don't settle the denominator is clarified, never guessed");

// ---- N6 rankings ----
const r1 = spec("top 3 cities in Texas with at least 100,000 people by murder clearance rate in 2025");
check(r1?.type === "rank" && r1.statistic === "clearance_rate" && r1.rank?.n === 3 && r1.min?.op === ">=" && r1.min.amount === 100000, "a clearance ranking keeps its size and its floor");
const r2 = spec("which state has the highest murder rate in 2025?");
check(r2?.type === "rank" && r2.entity === "state" && r2.rank?.n === 1, "\"which state has the highest\" is the top 1");

// ---- N7 change ----
const c1 = spec("change in robberies in Fort Worth, Texas from 2023 to 2025");
check(c1?.type === "change" && c1.earlier === 2023 && c1.later === 2025, "N7: the earlier year is the base");

// ---- families ----
check(spec("domestic violence incidents in Texas in 2025")?.type === "series", "DV is a series");
const f1 = spec("intimate partner violence incidents in Texas in 2025");
check(f1?.type === "series" && f1.measures.join() === "domestic_violence" && f1.filters.includes("dv:intimate_partner"), "intimate partner violence is DV with its category");
const f2 = spec("marijuana possession incidents in Fort Worth, Texas in 2025");
check(f2?.type === "series" && f2.filters.includes("drug:E"), "a drug type is a filter on drug possession");
check(spec("anti-Jewish hate crimes in Fort Worth, Texas in 2025")?.type === "series", "a bias motivation is a hate-crime filter");

// ---- the final gate: a leftover part declines the whole request ----
const d1 = decide("robberies in Fort Worth, Texas in 2025 and their median value per incident");
check(d1.kind === "decline" || d1.kind === "clarify", "an unconsumed part is never dropped");
const t1 = decide("how many robberies were there in Fort Worth, Texas in 2025, and why?");
check(t1.kind === "spec" && Boolean(t1.explainLimitation), "a numeric ask with why is answered with the why limitation stated (L7)");

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
