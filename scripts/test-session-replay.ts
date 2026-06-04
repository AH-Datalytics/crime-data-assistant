/**
 * Session-aware replay tests.
 * Simulates multi-turn conversations to verify:
 *   - First query routes normally
 *   - Follow-ups inherit previous source (no re-routing)
 *   - Chart/style changes don't trigger SQL routing
 *   - "compare to Chicago" keeps the same metric, changes geography
 *   - "now make it per capita" keeps source unless the new requirement forces a switch
 *
 * Run: npx tsx scripts/test-session-replay.ts
 */

import { autoRoute, isFollowUp, parseIntent, type TabId } from "../lib/tab-suggest";

interface SessionStep {
  question: string;
  /** What the router should do */
  expect: "route" | "follow_up";
  /** For "route" steps: which tab(s) are acceptable */
  expectedTab?: TabId | TabId[];
  /** For "route" steps that should force a source switch */
  mustSwitch?: boolean;
  note?: string;
}

interface Session {
  name: string;
  /** The tab the user starts on (for follow-up inheritance) */
  startTab: TabId;
  steps: SessionStep[];
}

// ══════════════════════════════════════════════════════════════════════
//  Session definitions — extracted from production log
// ══════════════════════════════════════════════════════════════════════

const sessions: Session[] = [
  {
    name: "DC crime deep-dive (ids 81-97)",
    startTab: "current",
    steps: [
      { question: "is DC safer than it used to be?", expect: "route", expectedTab: ["current", "historical"], note: "Ambiguous opener — either tab works" },
      { question: "All violent crime, please. But murder is maybe the best benchmark.", expect: "route", expectedTab: ["current", "historical"] },
      { question: "I need to know the monthly murder trend in DC", expect: "route", expectedTab: "current" },
      { question: "Normalize that please", expect: "follow_up" },
      { question: "Ok. Now compare the monthly murder trend in Baltimore with the trend in DC. Is DC improving more than Balto?", expect: "route", expectedTab: "current", note: "New geography + keeps monthly + keeps murder" },
      { question: "Your chart looks weird.", expect: "follow_up" },
      { question: "Show me a chart that compares the monthly murder rate in Baltimore and DC", expect: "route", expectedTab: "current" },
      { question: "Great. Now add a vertical line for August 2025", expect: "follow_up" },
      { question: "Ok but make the DC line yellow", expect: "follow_up" },
      { question: "Ok fine but the DC line needs to be darker and yellow.", expect: "follow_up" },
      { question: "DC murder trend. Did Trump's anti-crime surge work?", expect: "route", expectedTab: ["current", "historical"] },
    ],
  },
  {
    name: "Chart modification session (ids 135-148)",
    startTab: "current",
    steps: [
      { question: "Show me a chart of the three-month moving average for murders in DC and Baltimore.", expect: "route", expectedTab: ["current", "historical"], note: "Moving average implies monthly, but both tabs could work" },
      { question: "Great. Please also add Detroit. And make the DC line darker", expect: "follow_up", note: "Adds city + changes style — still a follow-up" },
      { question: "And add a vertical line marking Aug. 1, 2025", expect: "follow_up" },
      { question: "That's great. Now show me the three-month rolling average murder rate for the 10 cities with the highest homicide rate in 2025, plus DC.", expect: "route", expectedTab: ["current", "historical"], note: "Substantially new query — ranking + new cities" },
      { question: "Give me a list of the 10 cities with the highest annual murder rate in 2024", expect: "route", expectedTab: ["current", "historical"] },
      { question: "St Louis, MO\t150\t277,294\t54.1 Memphis, TN\t250\t613,207\t40.8", expect: "follow_up", note: "Pasted data — follow-up context" },
    ],
  },
  {
    name: "New Orleans deep-dive (ids 238-244)",
    startTab: "current",
    steps: [
      { question: "new orleans murders per month", expect: "route", expectedTab: "current" },
      { question: "how does the murder trend align with the robbery trend", expect: "route", expectedTab: ["current", "historical"], note: "Adds offense — but still a trend comparison" },
      { question: "can we look at murder in terms of percentage change by month?", expect: "follow_up", note: "'can we look at' + percentage change of prior result" },
      { question: "Great can we overlay robbery percentage change by month and murder percentage change by month?", expect: "route", expectedTab: ["current", "historical"], note: "Adds robbery to murder comparison — could be follow-up or new query" },
      { question: "now take out robbery", expect: "follow_up" },
      { question: "can you make that a line chart", expect: "follow_up" },
    ],
  },
  {
    name: "Officers/staffing session (ids 182-185)",
    startTab: "historical",
    steps: [
      { question: "New Orleans officers per year", expect: "route", expectedTab: "historical" },
      { question: "Per capita rate of officers in New York City and Chicago since 1930", expect: "route", expectedTab: "historical" },
      { question: "can you compare the two?", expect: "follow_up" },
    ],
  },
  {
    name: "Ranking refinement session (ids 58-64)",
    startTab: "current",
    steps: [
      { question: "Cities with the most murders in 2026", expect: "route", expectedTab: ["current", "historical"] },
      { question: "Top 10 auto theft rates in 2026", expect: "route", expectedTab: ["current", "historical"], note: "New offense — still a ranking" },
      { question: "Cities with highest murder rate in 2025", expect: "route", expectedTab: ["current", "historical"] },
      { question: "what cities have seen the largest drops in homicide rate since 2019", expect: "route", expectedTab: ["current", "historical"] },
      { question: "largest percentage decline compared to 2019 and use preliminary 2025 data. please only look at cities that had at least 50 homicides in 2019", expect: "route", expectedTab: ["current", "historical"] },
      { question: "what if you lower the number to 25 homicides in 2019", expect: "follow_up", note: "Threshold modification of prior query" },
    ],
  },
  {
    name: "Region homicide session (ids 76-78)",
    startTab: "current",
    steps: [
      { question: "can we look at total homicides by year in the dataset in northeast, midwest, west, and south?", expect: "route", expectedTab: ["current", "historical"] },
      { question: "get rid of 2026 since there's no data", expect: "follow_up" },
      { question: "index to 100 from 2017 for each region so we can compare over time", expect: "follow_up" },
    ],
  },
  {
    name: "NIBRS rape clearance session (ids 186-196)",
    startTab: "nibrs",
    steps: [
      { question: "rape exceptional clearances by type in Virginia per year from 2022 to 2025", expect: "route", expectedTab: "nibrs" },
      { question: "Which states have the highest share of rapes cleared by exception in 2025?", expect: "route", expectedTab: "nibrs" },
      { question: "Now what about just the share that's prosecution declined", expect: "follow_up", note: "'Now what about' — narrows the previous result" },
      { question: "give me the share of all rape clearances that were prosecution declined in 2025", expect: "route", expectedTab: "nibrs" },
    ],
  },
  {
    name: "City comparison with format changes (ids 248-253)",
    startTab: "current",
    steps: [
      { question: "show me the four largest cities homicide trends 2010-2025", expect: "route", expectedTab: ["current", "historical"] },
      { question: "please show me 2018-2025 trends here for the four largest cities (New York City, Los Angeles, Chicago, and Philadelphia).", expect: "route", expectedTab: ["current", "historical"] },
      { question: "can you show me the same data annually", expect: "follow_up", note: "'the same data' — clearly refers to previous result" },
      { question: "can you make that a line chart", expect: "follow_up" },
      { question: "trim the end date to 2025", expect: "follow_up" },
      { question: "now make it per capita", expect: "follow_up", note: "Per-capita transformation of the same data" },
    ],
  },
  {
    name: "Carjacking session on NIBRS (ids 254-257)",
    startTab: "nibrs",
    steps: [
      { question: "Show carjacking trend by month/year", expect: "route", expectedTab: "nibrs" },
      { question: "show carjackings per capita", expect: "route", expectedTab: "nibrs", note: "New query, same topic — not a follow-up (has its own offense+measure)" },
      { question: "can you show trends in gunshot victimization", expect: "route", expectedTab: ["nibrs", "shr"], note: "Topic change — still routes" },
    ],
  },
  {
    name: "County narrowing (ids 282-284)",
    startTab: "current",
    steps: [
      { question: "baltimore murders per year", expect: "route", expectedTab: ["current", "historical"] },
      { question: "Virginia murder rates per agency in 2024", expect: "route", expectedTab: "historical" },
      { question: "how about just counties in VA", expect: "follow_up", note: "'how about just' — narrows geography from previous query" },
    ],
  },
  {
    name: "Domestic homicide deep-dive",
    startTab: "nibrs",
    steps: [
      { question: "What percentage of murders are domestic violence related nationally?", expect: "route", expectedTab: "shr", mustSwitch: true, note: "Domestic + homicide → SHR, forced source switch" },
      { question: "What's the trend in domestic violence homicides in Texas over the past decade?", expect: "route", expectedTab: "shr" },
      { question: "How many domestic violence murders involved firearms in Texas?", expect: "route", expectedTab: "shr" },
      { question: "now break it down by relationship type", expect: "follow_up", note: "Drill-down of previous result" },
    ],
  },
  {
    name: "Historical staffing then NIBRS switch",
    startTab: "historical",
    steps: [
      { question: "NYPD staffing levels since 1970", expect: "route", expectedTab: "historical" },
      { question: "How many police officers are employed in Houston?", expect: "route", expectedTab: "historical" },
      { question: "hate crimes in New York City since 2019", expect: "route", expectedTab: "nibrs", mustSwitch: true, note: "Bias attribute forces switch to NIBRS" },
    ],
  },
  {
    name: "Pie chart / bar chart formatting",
    startTab: "nibrs",
    steps: [
      { question: "robbery by weapon type in Philadelphia", expect: "route", expectedTab: "nibrs" },
      { question: "Make it a pie chart", expect: "follow_up" },
      { question: "make it a bar chart", expect: "follow_up" },
      { question: "in a table", expect: "follow_up" },
      { question: "in the csv below", expect: "follow_up" },
    ],
  },
  {
    name: "Mixed confirmations and denials",
    startTab: "current",
    steps: [
      { question: "National murder trend", expect: "route", expectedTab: ["current", "historical"] },
      { question: "yes", expect: "follow_up" },
      { question: "no", expect: "follow_up" },
      { question: "never mind, go back", expect: "follow_up" },
      { question: "Murder rate in Houston per 100K", expect: "route", expectedTab: ["current", "historical"], note: "New query with its own intent" },
    ],
  },
  {
    name: "Homicide methods word-change routing",
    startTab: "historical",
    steps: [
      { question: "murders in Houston since 2010", expect: "route", expectedTab: "historical", note: "No attributes → Historical" },
      { question: "firearm murders in Houston since 2010", expect: "route", expectedTab: "shr", mustSwitch: true, note: "Adding 'firearm' forces SHR" },
      { question: "murder victim race in Houston since 2010", expect: "route", expectedTab: ["shr", "nibrs"], note: "Adding 'victim race' forces SHR/NIBRS — staying on SHR is fine" },
    ],
  },
];

// ══════════════════════════════════════════════════════════════════════
//  Test runner
// ══════════════════════════════════════════════════════════════════════

let pass = 0;
let fail = 0;
const failures: { session: string; step: number; question: string; issue: string }[] = [];

for (const session of sessions) {
  let activeSource: TabId = session.startTab;

  for (let i = 0; i < session.steps.length; i++) {
    const step = session.steps[i];
    const q = step.question;
    const followUp = isFollowUp(q);
    const route = autoRoute(q);

    if (step.expect === "follow_up") {
      // Follow-ups should be detected by isFollowUp AND autoRoute returns null
      if (!followUp) {
        fail++;
        failures.push({ session: session.name, step: i + 1, question: q, issue: `Expected follow_up but isFollowUp()=false` });
        continue;
      }
      if (route !== null) {
        fail++;
        failures.push({ session: session.name, step: i + 1, question: q, issue: `Expected follow_up (null route) but got route to ${route.source}` });
        continue;
      }
      // Active source stays the same — follow-up inherits
      pass++;
    } else {
      // "route" — should produce a routing decision
      if (followUp) {
        fail++;
        failures.push({ session: session.name, step: i + 1, question: q, issue: `Expected route but isFollowUp()=true (would be kept on current tab)` });
        continue;
      }
      if (!route) {
        fail++;
        failures.push({ session: session.name, step: i + 1, question: q, issue: `Expected route but autoRoute() returned null` });
        continue;
      }

      const acceptable = Array.isArray(step.expectedTab) ? step.expectedTab : step.expectedTab ? [step.expectedTab] : [];
      if (acceptable.length > 0 && !acceptable.includes(route.source)) {
        fail++;
        failures.push({ session: session.name, step: i + 1, question: q, issue: `Routed to ${route.source}, expected ${acceptable.join("|")}` });
        continue;
      }

      // Check mustSwitch
      if (step.mustSwitch && route.source === activeSource) {
        fail++;
        failures.push({ session: session.name, step: i + 1, question: q, issue: `Expected source switch from ${activeSource} but stayed on ${route.source}` });
        continue;
      }

      activeSource = route.source;
      pass++;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════════

console.log("═".repeat(60));
console.log(`SESSION REPLAY: ${pass} passed, ${fail} failed out of ${pass + fail}`);
console.log(`Sessions: ${sessions.length}, Steps: ${sessions.reduce((s, sess) => s + sess.steps.length, 0)}`);
console.log("═".repeat(60));

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  FAIL [${f.session}] step ${f.step}: "${f.question}"`);
    console.log(`        ${f.issue}`);
  }
}

process.exit(fail > 0 ? 1 : 0);
