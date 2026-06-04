/**
 * Evaluate the dataset router against the full production query log.
 * Run: npx tsx scripts/evaluate-router-on-log.ts
 *
 * Metrics note: "agreement with user tab" is a proxy, not ground truth.
 * Real accuracy is measured by the golden test suite (test-router.ts).
 * Users sometimes ask from the wrong tab, so disagreement ≠ error.
 */

import { readFileSync } from "fs";
import { autoRoute, isFollowUp, parseIntent, type TabId } from "../lib/tab-suggest";

// Parse CSV (simple — no quotes in our data)
const csv = readFileSync("audit/full-query-log.csv", "utf8");
const rows = csv.split("\n").filter(l => l.trim()).map(line => {
  const match = line.match(/^(\d+),(\w*),\"?(.+?)\"?$/);
  if (!match) return null;
  return { id: parseInt(match[1]), userTab: match[2] as TabId, question: match[3].replace(/^"|"$/g, "") };
}).filter(Boolean) as { id: number; userTab: TabId; question: string }[];

console.log(`Loaded ${rows.length} queries from production log\n`);

// Stats
const routeDistribution: Record<string, number> = { current: 0, historical: 0, nibrs: 0, shr: 0, follow_up: 0, null: 0 };
const confidenceCounts: Record<string, number> = { high: 0, medium: 0, low: 0, follow_up: 0, null: 0 };
const userTabDistribution: Record<string, number> = { current: 0, historical: 0, nibrs: 0, shr: 0, other: 0 };
let mismatches = 0;
let agreements = 0;
let followUpCount = 0;
let highConfMismatches = 0;
let highConfAgreements = 0;
const mismatchDetails: { id: number; question: string; userTab: string; routerPrimary: string; confidence: string; reason: string }[] = [];
const unsupportedDetections: { id: number; question: string; concepts: string[] }[] = [];
const lowConfidence: { id: number; question: string; primary: string; reason: string }[] = [];
const attrCounts: Record<string, number> = {};
const followUpSamples: { id: number; userTab: string; question: string }[] = [];

for (const row of rows) {
  // Track user tab distribution
  if (row.userTab in userTabDistribution) userTabDistribution[row.userTab]++;
  else userTabDistribution.other++;

  // Skip very short/empty questions
  if (row.question.length < 3) continue;

  const intent = parseIntent(row.question);
  const followUp = isFollowUp(row.question);

  // Track attributes
  for (const attr of intent.requiredAttributes) {
    attrCounts[attr] = (attrCounts[attr] || 0) + 1;
  }

  // Follow-ups: autoRoute() returns null, UI keeps current tab
  if (followUp) {
    followUpCount++;
    routeDistribution.follow_up++;
    confidenceCounts.follow_up++;
    if (followUpSamples.length < 20) {
      followUpSamples.push({ id: row.id, userTab: row.userTab, question: row.question.substring(0, 80) });
    }
    continue; // Not counted in agreement/mismatch — no routing decision was made
  }

  const route = autoRoute(row.question);

  if (!route) {
    routeDistribution.null++;
    confidenceCounts.null++;
    continue;
  }

  routeDistribution[route.source]++;
  confidenceCounts[route.confidence]++;

  // Compare to user-selected tab
  if (route.source === row.userTab) {
    agreements++;
    if (route.confidence === "high") highConfAgreements++;
  } else {
    mismatches++;
    if (route.confidence === "high") highConfMismatches++;
    mismatchDetails.push({
      id: row.id,
      question: row.question.substring(0, 80),
      userTab: row.userTab,
      routerPrimary: route.source,
      confidence: route.confidence,
      reason: route.reason.substring(0, 60),
    });
  }

  // Unsupported concepts
  if (intent.unsupportedConcepts.length > 0) {
    unsupportedDetections.push({ id: row.id, question: row.question.substring(0, 80), concepts: intent.unsupportedConcepts });
  }

  // Low confidence
  if (route.confidence === "low") {
    lowConfidence.push({ id: row.id, question: row.question.substring(0, 80), primary: route.source, reason: route.reason.substring(0, 60) });
  }
}

// Output
console.log("═══ Route Distribution (including follow-ups) ═══");
for (const [tab, count] of Object.entries(routeDistribution).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${tab.padEnd(12)} ${count} (${(100 * count / rows.length).toFixed(1)}%)`);
}

console.log("\n═══ User Tab Distribution (for comparison) ═══");
for (const [tab, count] of Object.entries(userTabDistribution).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${tab.padEnd(12)} ${count} (${(100 * count / rows.length).toFixed(1)}%)`);
}

console.log("\n═══ Confidence (routed queries only) ═══");
for (const [level, count] of Object.entries(confidenceCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${level.padEnd(12)} ${count} (${(100 * count / rows.length).toFixed(1)}%)`);
}

const routed = agreements + mismatches;
console.log(`\n═══ Agreement with User Tab (routed queries only, not ground truth) ═══`);
console.log(`  Routed queries: ${routed} (${followUpCount} follow-ups excluded)`);
console.log(`  Agreements:     ${agreements} (${(100 * agreements / routed).toFixed(1)}%)`);
console.log(`  Mismatches:     ${mismatches} (${(100 * mismatches / routed).toFixed(1)}%)`);
console.log(`  NOTE: User tab ≠ ground truth. Users sometimes ask from the wrong tab.`);
console.log(`        Real accuracy is measured by the ${169}-case golden test suite.`);

const totalHigh = highConfAgreements + highConfMismatches;
console.log(`\n═══ High-Confidence Agreement with User Tab ═══`);
console.log(`  Agrees:     ${highConfAgreements} of ${totalHigh} (${totalHigh > 0 ? (100 * highConfAgreements / totalHigh).toFixed(1) : "N/A"}%)`);
console.log(`  Disagrees:  ${highConfMismatches} of ${totalHigh} (${totalHigh > 0 ? (100 * highConfMismatches / totalHigh).toFixed(1) : "N/A"}%)`);

console.log(`\n═══ Follow-ups Detected (${followUpCount} — kept on user's current tab) ═══`);
for (const f of followUpSamples) {
  console.log(`  #${f.id}: [${f.userTab}] "${f.question}"`);
}

console.log(`\n═══ Top Mismatches (first 30) ═══`);
for (const m of mismatchDetails.slice(0, 30)) {
  console.log(`  #${m.id}: user=${m.userTab} router=${m.routerPrimary}(${m.confidence}) "${m.question}"`);
}

console.log(`\n═══ Detected Attributes (frequency) ═══`);
for (const [attr, count] of Object.entries(attrCounts).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${attr.padEnd(25)} ${count}`);
}

console.log(`\n═══ Unsupported Concept Detections (${unsupportedDetections.length}) ═══`);
for (const u of unsupportedDetections.slice(0, 15)) {
  console.log(`  #${u.id}: [${u.concepts.join(",")}] "${u.question}"`);
}

console.log(`\n═══ Low Confidence Routes (${lowConfidence.length}) ═══`);
for (const l of lowConfidence.slice(0, 15)) {
  console.log(`  #${l.id}: → ${l.primary} "${l.question}"`);
}

console.log(`\n${"═".repeat(60)}`);
console.log(`EVALUATION COMPLETE: ${rows.length} queries processed`);
console.log(`  ${followUpCount} follow-ups (no route), ${routed} routed, ${rows.length - followUpCount - routed} unroutable`);
console.log(`${"═".repeat(60)}`);
