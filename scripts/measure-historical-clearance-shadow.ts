// READ-ONLY shadow measurement for the Historical state-clearance observation.
// Untracked, measurement-only. Opens the replay snapshot mode=ro. No production contact.
//
// Answers: if this observation were enforced, how many previously answered Historical questions
// would newly decline, which ones, and are any of them false refusals?

import Database from "better-sqlite3";
import { buildQueryContract } from "../lib/query-contract";
import { observeHistoricalClearanceGrain } from "../lib/historical-clearance-grain";

const SNAPSHOT = "C:/tmp/query_log-review-20260810.db";

type Row = { id: number; ts: number; question: string; sql: string; rows: number | null; error: string | null };

const db = new Database(SNAPSHOT, { readonly: true, fileMustExist: true });
const rows = db
  .prepare("SELECT id, ts, question, sql, rows, error FROM query_log WHERE tab = 'historical' AND sql IS NOT NULL AND TRIM(sql) <> ''")
  .all() as Row[];

type Hit = {
  id: number;
  date: string;
  question: string;
  reason: string;
  stateName: string | null;
  stateConfidence: string | null;
  enforceable: boolean;
  topic: string;
  succeeded: boolean;
  returnedRows: number | null;
  usedNationalTable: boolean;
  usedAgencyClearance: boolean;
  usedStateCrimeTable: boolean;
};

const hits: Hit[] = [];
let contractless = 0;

for (const r of rows) {
  const contract = buildQueryContract(r.question, "historical", null);
  if (!contract) { contractless++; continue; }
  const o = observeHistoricalClearanceGrain(contract);
  if (!o) continue;
  hits.push({
    id: r.id,
    date: new Date(Number(r.ts)).toISOString().slice(0, 10),
    question: r.question,
    reason: o.reason,
    stateName: o.stateName,
    stateConfidence: o.stateConfidence,
    enforceable: o.enforceable,
    topic: o.topic,
    succeeded: r.error === null && (r.rows ?? 0) > 0,
    returnedRows: r.rows,
    // Which table the answer actually came from tells us whether the wrong answer really shipped.
    usedNationalTable: /national_clearance_rate/i.test(r.sql),
    usedAgencyClearance: /historical_agency_clearance/i.test(r.sql),
    usedStateCrimeTable: /historical_state_national/i.test(r.sql),
  });
}

const byReason: Record<string, number> = {};
for (const h of hits) byReason[h.reason] = (byReason[h.reason] ?? 0) + 1;
// Observation is wider than enforcement; report both so the gap is visible rather than assumed.
const enforced = hits.filter((h) => h.enforceable);
const observedNotEnforced = hits.filter((h) => !h.enforceable);

const succeeded = hits.filter((h) => h.succeeded);
const wrongAnswerShipped = succeeded.filter((h) => h.reason === "historical-state-clearance-no-aggregate" && h.usedNationalTable);
const aggregatedAgencies = succeeded.filter((h) => h.reason === "historical-state-clearance-no-aggregate" && h.usedAgencyClearance);

console.log(JSON.stringify({
  snapshot: SNAPSHOT,
  historicalRowsWithSql: rows.length,
  contractless,
  observed: hits.length,
  byReason,
  wouldEnforce: enforced.length,
  observedButNotEnforced: observedNotEnforced.map((h) => ({
    id: h.id, reason: h.reason, stateConfidence: h.stateConfidence, question: h.question.slice(0, 90),
  })),
  observedAndPreviouslySucceeded: succeeded.length,
  ofThoseAnsweredFromNationalTable: wrongAnswerShipped.length,
  ofThoseAnsweredByAggregatingAgencies: aggregatedAgencies.length,
  dateRange: rows.length
    ? [new Date(Math.min(...rows.map((r) => Number(r.ts)))).toISOString().slice(0, 10),
       new Date(Math.max(...rows.map((r) => Number(r.ts)))).toISOString().slice(0, 10)]
    : [],
  everyObservedQuestion: hits.map((h) => ({
    id: h.id, date: h.date, reason: h.reason, state: h.stateName,
    stateConfidence: h.stateConfidence, enforceable: h.enforceable, topic: h.topic,
    succeeded: h.succeeded, rows: h.returnedRows,
    source: h.usedNationalTable ? "national_clearance_rate"
      : h.usedAgencyClearance ? "historical_agency_clearance"
      : h.usedStateCrimeTable ? "historical_state_national" : "other",
    question: h.question.slice(0, 130),
  })),
}, null, 2));
