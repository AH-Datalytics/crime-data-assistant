#!/usr/bin/env npx tsx
/**
 * COURT-REFUSAL REGRESSION CONTROLS — the lasting half of the Cause A work.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. `scripts/test-court-refusal-batch.ts` is the comparative
 * proof for one submission: it hashes four product files against an accepted audit bundle and
 * replays a saved capture, so it will legitimately stop being true after later unrelated
 * repairs. That belongs to the history of one change. THIS suite carries the part that must
 * keep holding: the behaviors themselves, stated with explicit local fixtures, no audit bundle,
 * no saved run and no source database. It is in the `npm test` chain.
 *
 * THE DEFECT IT EXISTS FOR (2026-09-25 review, item A1). The court-process rule was widened to
 * recognize a request for a COUNT of prosecutions. The plural noun then also matched the
 * occurrence inside the REVERSED police phrase — "declined prosecutions" — so
 * "Show declined prosecutions by state" moved from `police_record` to `mixed`. Nothing refused
 * the request, but `applyResultDisclosures` consumes `mixed`, and the reader was told
 * "The court and corrections part isn't in any dataset here, so I've left it out rather than
 * guessing" about a question that had asked for no court part at all. A false statement about
 * our own coverage, appended to an otherwise correct answer.
 *
 * So the checks below compare the COMPLETE delivered explanation, not a prefix of it. A prefix
 * comparison is exactly what let the appended sentence through unnoticed.
 *
 * EVIDENCE BOUNDARY. Fixture rows and literal question strings, written here. The guard above
 * denies file-backed SQLite, so the coverage lines `lib/dynamic-facts.ts` reads at import time
 * fall back to their constants rather than reading a developer database. Nothing here is a
 * numerical qualification of any answer against a real source.
 */

import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";

import {
  classifyClearanceReferent,
  mayRefuseAsCourtProcess,
  MIXED_REFERENT_NOTE,
} from "../lib/clearance-referent";
import { courtProcessNoSqlIsTerminal, selectNoSqlRefusal } from "../lib/refusal-safety";
import { applyResultDisclosures } from "../lib/result-disclosure";
import { validateSourceCapabilities } from "../lib/source-capabilities";
import { buildQueryContract } from "../lib/query-contract";
import { runGuardrails } from "../lib/guardrails";

let checks = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  PASS  ${name}${detail ? "   " + detail : ""}`);
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? "   " + detail : ""}`); }
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 0 — THE ISOLATION IS LIVE IN THIS PROCESS
 * ════════════════════════════════════════════════════════════════════════════════════════
 * A guard that silently failed to install would leave every claim below about source access
 * unsupported, and the suite would still be green. So it is asked to deny something.
 */
console.log("\n=== 0  the offline guard, exercised rather than assumed ===");
{
  let denied = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3") as new (file: string, opts?: unknown) => unknown;
    new Database("crime_data.db", { readonly: true });
  } catch {
    denied = true;
  }
  check("a file-backed database open is refused in this process", denied);
  check("  ...and the refusal is recorded", deniedDatabaseOpens().includes("crime_data.db"));
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 1 — THE REFERENT DECISION
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 1  what each request is about ===");

const REFERENT_CASES: Array<{ q: string; referent: string; refuse: boolean; why: string }> = [
  // The police clearance reason, in every word order the product has actually seen.
  { q: "give me the share of all rape clearances that were prosecution declined in 2025 by state",
    referent: "police_record", refuse: false, why: "NIBRS cleared_B, the canonical form" },
  { q: "how many prosecutions declined by state in 2025",
    referent: "police_record", refuse: false, why: "plural, noun first" },
  { q: "Show declined prosecutions by state",
    referent: "police_record", refuse: false, why: "plural, REVERSED — the A1 regression" },
  { q: "How many declined prosecutions were recorded in 2025?",
    referent: "police_record", refuse: false, why: "plural, reversed, counted — the A1 regression" },
  { q: "what share of clearances were prosecutions were declined",
    referent: "police_record", refuse: false, why: "the 'prosecutions were declined' form" },
  { q: "declination rate for aggravated assault clearances",
    referent: "police_record", refuse: false, why: "the NIBRS word for the same reason" },

  // A genuine request for court counts. This is the widening Cause A was for (GC-005).
  { q: "Can you provide the number or percentage of gun prosecutions per year over the last 20 years?",
    referent: "court_process", refuse: true, why: "a count of prosecutions brought" },
  { q: "how many prosecution filings were there in Cook County",
    referent: "court_process", refuse: true, why: "filings are a court record" },
  { q: "conviction rates for murders in Houston",
    referent: "court_process", refuse: true, why: "the original Decision 1 witness" },

  // Both referents, separately stated. The police half must still be answered.
  { q: "Show clearance rates and prosecution rates",
    referent: "mixed", refuse: false, why: "a separately stated prosecution rate" },
  { q: "clearance rates and the prison population in Texas",
    referent: "mixed", refuse: false, why: "a separately stated corrections topic" },
  { q: "Show declined prosecutions by state and the conviction rate for each",
    referent: "mixed", refuse: false, why: "police phrase PLUS a separate court request" },
  { q: "clearance rates, and how many prosecutions were filed that year",
    referent: "mixed", refuse: false, why: "a second prosecution occurrence, outside the police phrase" },

  // Neither.
  { q: "was the prosecution notified of the clearance",
    referent: "police_record", refuse: false, why: "the bare word is never the trigger" },
  { q: "murders in Houston since 2010",
    referent: "not_applicable", refuse: false, why: "an ordinary crime question" },
];

for (const c of REFERENT_CASES) {
  const d = classifyClearanceReferent(c.q);
  check(`${c.referent.padEnd(14)} ${c.why}`, d.referent === c.referent && d.refuseWholeRequest === c.refuse,
    `got ${d.referent}/${d.refuseWholeRequest} for "${c.q}"`);
}
check("mayRefuseAsCourtProcess agrees with the classification on every case above",
  REFERENT_CASES.every((c) => mayRefuseAsCourtProcess(c.q) === c.refuse));

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 2 — WHAT THE READER ACTUALLY RECEIVES
 * ════════════════════════════════════════════════════════════════════════════════════════
 * The classification only matters because `applyResultDisclosures` consumes it. These compare
 * the COMPLETE delivered explanation against a literal, because the defect was an extra
 * sentence at the end and a prefix comparison cannot see one.
 */
console.log("\n=== 2  the delivered answer, compared in full ===");

const FIXTURE = {
  rows: [{ state: "IL", year: 2025, prosecution_declined: 20 }] as Record<string, unknown>[],
  sql: "SELECT state, year, SUM(cleared_B) AS prosecution_declined FROM summary_clearance_detail "
     + "WHERE year=2025 GROUP BY state,year",
  explanation: "Reported prosecution-declined clearances by state in 2025.",
  tab: "nibrs" as const,
};
const deliver = (question: string) =>
  applyResultDisclosures({ ...FIXTURE, question });

const CLEARANCE_NOTE =
  "Clearance note: FBI clearance means cleared by arrest or exceptional means; it is not the same "
  + "as conviction or prosecution.";

for (const q of ["Show declined prosecutions by state", "How many declined prosecutions were recorded in 2025?"]) {
  const delivered = deliver(q);
  check(`no court-omission sentence is appended to "${q}"`,
    delivered === FIXTURE.explanation,
    JSON.stringify(delivered));
  check(`  ...and the omission wording is absent outright`, !delivered.includes(MIXED_REFERENT_NOTE));
}

{
  // The other half of the rule: a request that really does name a court topic must still be
  // told what was left out. If this ever goes quiet, the repair above has over-reached.
  const q = "clearance rates and the prison population in Texas";
  const delivered = deliver(q);
  check("a genuinely mixed request still carries the omission sentence, in full",
    delivered === `${FIXTURE.explanation}\n\n${CLEARANCE_NOTE}\n\n${MIXED_REFERENT_NOTE}`,
    JSON.stringify(delivered));
}
{
  const q = "Show declined prosecutions by state and the conviction rate for each";
  const delivered = deliver(q);
  check("a police phrase alongside a separate court request still discloses the omission",
    delivered.endsWith(MIXED_REFERENT_NOTE) && delivered.startsWith(FIXTURE.explanation),
    JSON.stringify(delivered));
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 3 — THE TERMINAL DECISION AND THE RECOVERY IT MUST NOT COST
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 3  when a no-SQL reply is already terminal ===");

check("a court-count request is terminal on the request alone",
  courtProcessNoSqlIsTerminal("Can you provide the number or percentage of gun prosecutions per year over the last 20 years?"));
check("a conviction-rate request is terminal",
  courtProcessNoSqlIsTerminal("conviction rates for murders in Houston"));
check("a police clearance request is NOT terminal, in either word order",
  !courtProcessNoSqlIsTerminal("how many prosecutions declined by state in 2025")
  && !courtProcessNoSqlIsTerminal("Show declined prosecutions by state"));
check("an ordinary request the product simply failed on is NOT terminal",
  !courtProcessNoSqlIsTerminal("how many burglaries were there in Springfield in 2024"));

check("the court request receives the court limitation, named as such",
  (() => { const r = selectNoSqlRefusal("conviction rates for murders in Houston", "historical");
    return r.reason === "court-data-out-of-scope" && /not court outcomes/i.test(r.explanation); })());
check("an unclassified failure keeps the honest generic template, not a borrowed excuse",
  (() => { const r = selectNoSqlRefusal("how many burglaries were there in Springfield in 2024", "nibrs");
    return r.reason === "no-sql-server-template" && /could not generate a database query/i.test(r.explanation); })());
check("a police clearance request keeps the generic template too — it is not a court refusal",
  selectNoSqlRefusal("Show declined prosecutions by state", "nibrs").reason === "no-sql-server-template");

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 4 — THE CAPABILITY GUARD BEHIND IT
 * ════════════════════════════════════════════════════════════════════════════════════════
 * Terminating earlier means the model is never asked to produce a substitute. That is a reason
 * to keep checking the guard that would have caught one, not a reason to retire it: if this
 * ever goes quiet, a substitute reaching the reader is one route change away.
 */
console.log("\n=== 4  the substitute guard, reached on its own ===");
{
  const q = "Can you provide one bar per city with the race of defendants reflected in each bar?";
  const substituteSql =
    "SELECT city, race, COUNT(*) AS arrestees FROM nibrs_arrestee GROUP BY city, race ORDER BY city";
  const contract = buildQueryContract(q, "nibrs");
  check("the request builds a contract at all", Boolean(contract));
  const findings = contract
    ? validateSourceCapabilities({ question: q, source: "nibrs", contract, sql: substituteSql })
    : [];
  const court = findings.find((f) => f.ruleId === "unsupported-court-policy-topic");
  check("an arrestee substitute for a defendant question is refused at `unsupported` severity",
    Boolean(court) && court!.severity === "unsupported", court?.message?.slice(0, 58) ?? "(no finding)");

  const guard = runGuardrails({ question: q, sql: substituteSql, tab: "nibrs" } as never) as unknown as
    { fired?: string[]; overrideResponse?: string | null };
  check("the guardrail pipeline overrides it as well",
    (guard.fired ?? []).includes("out-of-scope-override") || Boolean(guard.overrideResponse),
    JSON.stringify(guard.fired ?? []).slice(0, 60));
}
{
  // The same guard must stay silent on the police clearance question, or the repair in §1 buys
  // nothing: the request would simply be refused one layer further down.
  const q = "how many prosecutions declined by state in 2025";
  const contract = buildQueryContract(q, "nibrs");
  const findings = contract
    ? validateSourceCapabilities({ question: q, source: "nibrs", contract, sql: FIXTURE.sql })
    : [];
  check("the court capability rule does not fire on a prosecution-declined clearance query",
    findings.every((f) => f.ruleId !== "unsupported-court-policy-topic"));
}

/* ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("");
console.log(`  isolation: ${deniedDatabaseOpens().length} file-backed database opens denied, `
  + `${deniedNetworkCalls().length} network calls denied`);
console.log(failures.length === 0
  ? `ALL CHECKS PASSED  (${checks})`
  : `FAILURES: ${failures.length} of ${checks} -> ${failures.join(" | ")}`);
process.exit(failures.length === 0 ? 0 : 1);
