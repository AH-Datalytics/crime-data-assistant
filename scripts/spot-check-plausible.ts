/**
 * Spot-check the both_plausible mismatch bucket.
 * For each sampled query, evaluate whether the user's tab gives:
 *   - full: can fully answer the query
 *   - partial: can answer but with caveats (fewer years, fewer agencies, missing detail)
 *   - unsuitable: would fail or give misleading results
 *
 * Run: npx tsx scripts/spot-check-plausible.ts
 */

import { readFileSync } from "fs";
import { autoRoute, isFollowUp, parseIntent, recommendTabs, type TabId } from "../lib/tab-suggest";

const csv = readFileSync("audit/full-query-log.csv", "utf8");
const rows = csv.split("\n").filter(l => l.trim()).map(line => {
  const match = line.match(/^(\d+),(\w*),\"?(.+?)\"?$/);
  if (!match) return null;
  return { id: parseInt(match[1]), userTab: match[2] as TabId, question: match[3].replace(/^"|"$/g, "") };
}).filter(Boolean) as { id: number; userTab: TabId; question: string }[];

// Dataset capability summaries for evaluating answer quality
const DATASET_LIMITS: Record<TabId, {
  yearRange: string;
  agencies: string;
  offenses: string;
  demographics: boolean;
  monthly: boolean;
  county: boolean;
  stateRates: boolean;
}> = {
  current: { yearRange: "2017–present", agencies: "~700", offenses: "Part I UCR", demographics: false, monthly: true, county: false, stateRates: false },
  historical: { yearRange: "1930–2024", agencies: "10,000+", offenses: "Part I UCR", demographics: false, monthly: false, county: true, stateRates: true },
  nibrs: { yearRange: "1991–present", agencies: "10,000+", offenses: "All 52+ NIBRS", demographics: true, monthly: true, county: false, stateRates: false },
  shr: { yearRange: "1976–2024", agencies: "10,000+", offenses: "Homicide only", demographics: true, monthly: true, county: false, stateRates: false },
  hate_crime: { yearRange: "1991–present", agencies: "~15,000", offenses: "Bias-motivated", demographics: true, monthly: false, county: false, stateRates: false },
};

type AnswerQuality = "full" | "partial" | "unsuitable";

function evaluateAnswerQuality(question: string, tab: TabId): { quality: AnswerQuality; caveat: string } {
  const intent = parseIntent(question);
  const ds = DATASET_LIMITS[tab];

  // Check offense compatibility
  const NIBRS_ONLY = new Set(["carjacking", "vehicle_burglary", "theft_from_vehicle", "dui", "dwi", "trespass",
    "disorderly_conduct", "drug_offense", "fraud", "embezzlement", "vandalism", "intimidation",
    "simple_assault", "kidnapping", "human_trafficking", "identity_theft"]);
  const HOMICIDE = new Set(["murder", "homicide", "manslaughter"]);
  const PART1 = new Set(["murder", "rape", "robbery", "aggravated_assault", "burglary", "theft",
    "larceny", "motor_vehicle_theft", "auto_theft", "arson", "violent_crime", "property_crime"]);

  if (intent.offense) {
    if (tab === "shr" && !HOMICIDE.has(intent.offense)) {
      return { quality: "unsuitable", caveat: `SHR only has homicide data, not ${intent.offense}` };
    }
    if ((tab === "current" || tab === "historical") && NIBRS_ONLY.has(intent.offense)) {
      return { quality: "unsuitable", caveat: `${intent.offense} is NIBRS-only, not in ${tab}` };
    }
  }

  // Check required attributes
  const demoAttrs = ["weapon", "firearm", "victim_race", "victim_sex", "offender_demographics",
    "arrest_demographics", "relationship", "circumstance", "drug_type", "bias",
    "location_type", "clearance_type", "time_of_day", "domestic_violence", "carjacking"];
  const missingAttrs = intent.requiredAttributes.filter(a => {
    if (tab === "current") return demoAttrs.includes(a) || a === "staffing" || a === "clearance_rate";
    if (tab === "historical") return demoAttrs.includes(a) && a !== "clearance_rate" && a !== "staffing";
    if (tab === "shr") return ["arrest_demographics", "drug_type", "bias", "location_type", "clearance_type", "time_of_day", "carjacking"].includes(a);
    return false; // NIBRS has everything except staffing
  });

  if (missingAttrs.length > 0) {
    return { quality: "unsuitable", caveat: `Missing ${missingAttrs.join(", ")} on ${tab}` };
  }

  // Check time range coverage
  const yearStart: Record<TabId, number> = { current: 2017, historical: 1930, nibrs: 1991, shr: 1976, hate_crime: 1991 };
  if (intent.timeRange.start !== null && intent.timeRange.start < yearStart[tab]) {
    const gap = yearStart[tab] - intent.timeRange.start;
    if (gap > 10) {
      return { quality: "partial", caveat: `Requested ${intent.timeRange.start}, but ${tab} starts at ${yearStart[tab]} (${gap}yr gap)` };
    }
    if (gap > 3) {
      return { quality: "partial", caveat: `Partial coverage: ${tab} starts ${yearStart[tab]}, missing ${gap} years` };
    }
  }

  // Check granularity
  if (intent.granularity === "monthly" && tab === "historical") {
    return { quality: "partial", caveat: "Historical is annual-only; monthly requested" };
  }

  // Check agency coverage
  if (tab === "current" && intent.measure === "ranking") {
    return { quality: "partial", caveat: "Current Trends only has ~700 agencies — rankings are incomplete" };
  }

  // County
  if (intent.geography.type === "county" && tab !== "historical") {
    return { quality: "partial", caveat: `${tab} lacks structured county-level data` };
  }

  return { quality: "full", caveat: "Can fully answer this query" };
}

// Collect both_plausible mismatches
interface SpotCheck {
  id: number;
  question: string;
  userTab: TabId;
  routerTab: TabId;
  userQuality: AnswerQuality;
  userCaveat: string;
  routerQuality: AnswerQuality;
  routerCaveat: string;
  userScore: number;
  routerScore: number;
}

const checks: SpotCheck[] = [];

for (const row of rows) {
  if (row.question.length < 3) continue;
  if (isFollowUp(row.question)) continue;

  const route = autoRoute(row.question);
  if (!route || route.source === row.userTab) continue;

  // Check if both_plausible
  const recs = recommendTabs(row.question);
  const recTabs = recs.map(r => r.tab);
  if (!recTabs.includes(row.userTab)) continue;
  const userScore = recs.find(r => r.tab === row.userTab)?.score || 0;
  const topScore = recs[0]?.score || 0;
  if (userScore < topScore * 0.7) continue;

  const userEval = evaluateAnswerQuality(row.question, row.userTab);
  const routerEval = evaluateAnswerQuality(row.question, route.source);

  checks.push({
    id: row.id,
    question: row.question.substring(0, 90),
    userTab: row.userTab,
    routerTab: route.source,
    userQuality: userEval.quality,
    userCaveat: userEval.caveat,
    routerQuality: routerEval.quality,
    routerCaveat: routerEval.caveat,
    userScore,
    routerScore: topScore,
  });
}

// Aggregate by quality pattern
const patterns: Record<string, number> = {};
for (const c of checks) {
  const key = `user=${c.userQuality} router=${c.routerQuality}`;
  patterns[key] = (patterns[key] || 0) + 1;
}

console.log(`\n${"═".repeat(70)}`);
console.log(`BOTH_PLAUSIBLE SPOT CHECK — ${checks.length} cases`);
console.log(`${"═".repeat(70)}`);

console.log(`\n═══ Answer Quality Patterns ═══`);
for (const [pat, count] of Object.entries(patterns).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${pat.padEnd(35)} ${count} (${(100 * count / checks.length).toFixed(1)}%)`);
}

// Direction breakdown within each quality pattern
console.log(`\n═══ Direction Breakdown ═══`);
const dirByQuality: Record<string, Record<string, number>> = {};
for (const c of checks) {
  const key = `user=${c.userQuality} router=${c.routerQuality}`;
  if (!dirByQuality[key]) dirByQuality[key] = {};
  const dir = `${c.userTab}→${c.routerTab}`;
  dirByQuality[key][dir] = (dirByQuality[key][dir] || 0) + 1;
}
for (const [pat, dirs] of Object.entries(dirByQuality).sort((a, b) => Object.values(b[1]).reduce((s, v) => s + v, 0) - Object.values(a[1]).reduce((s, v) => s + v, 0))) {
  console.log(`\n  ${pat}:`);
  for (const [dir, count] of Object.entries(dirs).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`    ${dir.padEnd(25)} ${count}`);
  }
}

// Samples of each quality pattern
for (const pat of Object.keys(patterns).sort((a, b) => (patterns[b] || 0) - (patterns[a] || 0))) {
  const samples = checks.filter(c => `user=${c.userQuality} router=${c.routerQuality}` === pat);
  console.log(`\n═══ ${pat} — samples (first 8 of ${samples.length}) ═══`);
  for (const c of samples.slice(0, 8)) {
    console.log(`  #${c.id}: user=${c.userTab}(${c.userScore}) router=${c.routerTab}(${c.routerScore})`);
    console.log(`    Q: "${c.question}"`);
    console.log(`    User:   [${c.userQuality}] ${c.userCaveat}`);
    console.log(`    Router: [${c.routerQuality}] ${c.routerCaveat}`);
  }
}

console.log(`\n${"═".repeat(70)}`);
console.log(`SPOT CHECK COMPLETE`);
console.log(`${"═".repeat(70)}`);
