/**
 * Categorize router mismatches into actionable buckets.
 * Run: npx tsx scripts/bucket-mismatches.ts
 *
 * Buckets:
 *   follow_up     — Session continuation with no standalone intent
 *   both_plausible — Generic query where user's tab AND router's tab both work
 *   router_correct — Router's tab objectively better (required attribute/offense)
 *   user_sticky    — User stayed on their tab; query is ambiguous but not wrong
 *   unsupported    — Query involves concepts we don't track
 */

import { readFileSync } from "fs";
import { autoRoute, isFollowUp, parseIntent, recommendTabs, type TabId } from "../lib/tab-suggest";

const csv = readFileSync("audit/full-query-log.csv", "utf8");
const rows = csv.split("\n").filter(l => l.trim()).map(line => {
  const match = line.match(/^(\d+),(\w*),\"?(.+?)\"?$/);
  if (!match) return null;
  return { id: parseInt(match[1]), userTab: match[2] as TabId, question: match[3].replace(/^"|"$/g, "") };
}).filter(Boolean) as { id: number; userTab: TabId; question: string }[];

// Uses isFollowUp() from lib/tab-suggest.ts (imported above)

// ── Bucketing logic ──

type Bucket = "follow_up" | "both_plausible" | "router_correct" | "user_sticky" | "unsupported";

interface BucketedMismatch {
  id: number;
  question: string;
  userTab: TabId;
  routerTab: TabId;
  confidence: string;
  bucket: Bucket;
  reason: string;
}

const NIBRS_ONLY_OFFENSES = new Set([
  "carjacking", "vehicle_burglary", "theft_from_vehicle",
  "dui", "dwi", "trespass", "disorderly_conduct", "curfew",
  "liquor_law", "drug_offense", "fraud", "embezzlement", "vandalism",
  "intimidation", "simple_assault", "kidnapping",
  "human_trafficking", "animal_cruelty", "extortion",
  "gambling", "prostitution", "pornography",
  "stolen_property", "weapon_law_violation", "identity_theft",
]);

const HOMICIDE_OFFENSES = new Set(["murder", "homicide", "manslaughter", "killing"]);

const DEMOGRAPHIC_ATTRS = new Set([
  "weapon", "firearm", "victim_race", "victim_sex", "victim_age",
  "offender_demographics", "offender_race", "offender_sex",
  "arrest_demographics", "arrestee_race", "arrestee_sex",
  "relationship", "circumstance", "drug_type", "bias",
  "location_type", "clearance_type", "time_of_day",
  "domestic_violence", "carjacking", "incident_level",
]);

function bucketMismatch(row: { id: number; userTab: TabId; question: string }, routerTab: TabId, confidence: string): BucketedMismatch {
  const q = row.question;
  const intent = parseIntent(q);

  // 1. Follow-up?
  if (isFollowUp(q)) {
    return { id: row.id, question: q, userTab: row.userTab, routerTab, confidence, bucket: "follow_up", reason: "Session continuation — no standalone routing intent" };
  }

  // 2. Unsupported?
  if (intent.unsupportedConcepts.length > 0) {
    return { id: row.id, question: q, userTab: row.userTab, routerTab, confidence, bucket: "unsupported", reason: `Unsupported: ${intent.unsupportedConcepts.join(", ")}` };
  }

  // 3. Router clearly correct? (required attribute/offense forces a specific tab)
  // NIBRS-only offense but user was on Current/Historical
  if (intent.offense && NIBRS_ONLY_OFFENSES.has(intent.offense) && row.userTab !== "nibrs" && routerTab === "nibrs") {
    return { id: row.id, question: q, userTab: row.userTab, routerTab, confidence, bucket: "router_correct", reason: `${intent.offense} is NIBRS-only` };
  }
  // Requires demographic attributes but user was on Current/Historical
  const hasDemoAttr = intent.requiredAttributes.some(a => DEMOGRAPHIC_ATTRS.has(a));
  if (hasDemoAttr && (row.userTab === "current" || row.userTab === "historical") && (routerTab === "nibrs" || routerTab === "shr")) {
    return { id: row.id, question: q, userTab: row.userTab, routerTab, confidence, bucket: "router_correct", reason: `Needs ${intent.requiredAttributes.filter(a => DEMOGRAPHIC_ATTRS.has(a)).join("+")} — only on ${routerTab}` };
  }
  // Staffing but user not on Historical
  if (intent.requiredAttributes.includes("staffing") && row.userTab !== "historical" && routerTab === "historical") {
    return { id: row.id, question: q, userTab: row.userTab, routerTab, confidence, bucket: "router_correct", reason: "Staffing only on Historical" };
  }
  // Homicide + relationship/circumstance but user not on SHR
  if (intent.offense && HOMICIDE_OFFENSES.has(intent.offense) &&
      intent.requiredAttributes.some(a => ["relationship", "circumstance"].includes(a)) &&
      row.userTab !== "shr" && routerTab === "shr") {
    return { id: row.id, question: q, userTab: row.userTab, routerTab, confidence, bucket: "router_correct", reason: "Homicide + relationship/circumstance → SHR" };
  }
  // Hate crime but user not on NIBRS
  if (intent.requiredAttributes.includes("bias") && row.userTab !== "nibrs" && routerTab === "nibrs") {
    return { id: row.id, question: q, userTab: row.userTab, routerTab, confidence, bucket: "router_correct", reason: "Hate crime/bias only on NIBRS" };
  }

  // 4. Both plausible? (user's tab is in the recommendation set)
  const recs = recommendTabs(q);
  const recTabs = recs.map(r => r.tab);
  if (recTabs.includes(row.userTab)) {
    // User's tab is a viable alternative
    const userScore = recs.find(r => r.tab === row.userTab)?.score || 0;
    const topScore = recs[0]?.score || 0;
    if (userScore >= topScore * 0.7) {
      return { id: row.id, question: q, userTab: row.userTab, routerTab, confidence, bucket: "both_plausible", reason: `User's tab scored ${userScore} vs router's ${topScore}` };
    }
  }

  // 5. User sticky — generic query where user just stayed on their tab
  // Typically: user on Current, router picks Historical for a generic Part I query
  if (intent.requiredAttributes.length === 0 && !intent.offense) {
    return { id: row.id, question: q, userTab: row.userTab, routerTab, confidence, bucket: "user_sticky", reason: "No offense or attributes detected — ambiguous" };
  }
  if (row.userTab === "current" && routerTab === "historical" && intent.requiredAttributes.length === 0) {
    return { id: row.id, question: q, userTab: row.userTab, routerTab, confidence, bucket: "user_sticky", reason: "Generic Part I query — Current and Historical both viable" };
  }

  // Default: user_sticky if nothing else matched
  return { id: row.id, question: q, userTab: row.userTab, routerTab, confidence, bucket: "user_sticky", reason: "No strong signal either way" };
}

// ── Main ──

const buckets: Record<Bucket, BucketedMismatch[]> = {
  follow_up: [],
  both_plausible: [],
  router_correct: [],
  user_sticky: [],
  unsupported: [],
};

const confidenceByBucket: Record<Bucket, Record<string, number>> = {
  follow_up: { high: 0, medium: 0, low: 0 },
  both_plausible: { high: 0, medium: 0, low: 0 },
  router_correct: { high: 0, medium: 0, low: 0 },
  user_sticky: { high: 0, medium: 0, low: 0 },
  unsupported: { high: 0, medium: 0, low: 0 },
};

// Track mismatch direction
const directionCounts: Record<string, number> = {};

let totalMismatches = 0;
let totalAgreements = 0;
let highConfMismatches = 0;
let highConfAgreements = 0;
let followUpCount = 0;
let skippedCount = 0;

for (const row of rows) {
  if (row.question.length < 3) { skippedCount++; continue; }

  // Follow-ups: autoRoute returns null, UI keeps current tab — not a mismatch
  if (isFollowUp(row.question)) {
    followUpCount++;
    continue;
  }

  const route = autoRoute(row.question);
  if (!route) { skippedCount++; continue; }

  if (route.source === row.userTab) {
    totalAgreements++;
    if (route.confidence === "high") highConfAgreements++;
    continue;
  }

  totalMismatches++;
  if (route.confidence === "high") highConfMismatches++;

  const bucketed = bucketMismatch(row, route.source, route.confidence);
  buckets[bucketed.bucket].push(bucketed);
  confidenceByBucket[bucketed.bucket][route.confidence]++;

  const dir = `${row.userTab}→${route.source}`;
  directionCounts[dir] = (directionCounts[dir] || 0) + 1;
}

// ── Output ──

const total = totalMismatches + totalAgreements;

console.log(`\n${"═".repeat(70)}`);
console.log(`MISMATCH BUCKETING ANALYSIS`);
console.log(`${"═".repeat(70)}`);
console.log(`  Total queries:   ${rows.length}`);
console.log(`  Follow-ups:      ${followUpCount} (kept on user's tab, no routing decision)`);
console.log(`  Routed queries:  ${total} (${skippedCount} unroutable)`);
console.log(`  Agreements:      ${totalAgreements} (${(100 * totalAgreements / total).toFixed(1)}% of routed)`);
console.log(`  Mismatches:      ${totalMismatches} (${(100 * totalMismatches / total).toFixed(1)}% of routed)`);
const totalHigh = highConfMismatches + highConfAgreements;
console.log(`  High-conf disagrees: ${highConfMismatches} of ${totalHigh} high-conf routes (${totalHigh > 0 ? (100 * highConfMismatches / totalHigh).toFixed(1) : "N/A"}%)`);
console.log(`  NOTE: User tab ≠ ground truth. Real accuracy = golden test suite.`);

console.log(`\n═══ Mismatch Buckets (follow-ups excluded — they don't route) ═══`);
const bucketOrder: Bucket[] = ["both_plausible", "router_correct", "user_sticky", "unsupported", "follow_up"];
for (const b of bucketOrder) {
  const count = buckets[b].length;
  const pctOfMismatch = (100 * count / totalMismatches).toFixed(1);
  const pctOfTotal = (100 * count / total).toFixed(1);
  const confBreakdown = Object.entries(confidenceByBucket[b])
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`  ${b.padEnd(18)} ${String(count).padStart(5)} (${pctOfMismatch}% of mismatches, ${pctOfTotal}% of total)  [${confBreakdown}]`);
}

console.log(`\n═══ Mismatch Direction (user→router) ═══`);
for (const [dir, count] of Object.entries(directionCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${dir.padEnd(25)} ${count}`);
}

// Sample each bucket
for (const b of bucketOrder) {
  const items = buckets[b];
  if (items.length === 0) continue;
  console.log(`\n═══ ${b.toUpperCase()} samples (first 15 of ${items.length}) ═══`);
  for (const m of items.slice(0, 15)) {
    console.log(`  #${m.id}: user=${m.userTab} router=${m.routerTab}(${m.confidence})`);
    console.log(`    Q: "${m.question.substring(0, 90)}"`);
    console.log(`    → ${m.reason}`);
  }
}

// High-confidence mismatches that are NOT follow-ups and NOT both_plausible
const problematic = [...buckets.router_correct, ...buckets.user_sticky]
  .filter(m => m.confidence === "high");
console.log(`\n═══ HIGH-CONFIDENCE NON-FOLLOWUP MISMATCHES (${problematic.length}) — first 20 ═══`);
for (const m of problematic.slice(0, 20)) {
  console.log(`  #${m.id}: user=${m.userTab} router=${m.routerTab} [${m.bucket}]`);
  console.log(`    Q: "${m.question.substring(0, 90)}"`);
  console.log(`    → ${m.reason}`);
}

console.log(`\n${"═".repeat(70)}`);
console.log(`BUCKETING COMPLETE`);
console.log(`${"═".repeat(70)}`);
