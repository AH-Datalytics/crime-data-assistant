/**
 * The recovery's outcome check (Codex classification review, SC-3): run the application's OWN SHR city ranking
 * (lib/city-ranking-shr.ts, with the route's deterministic validation and the evidence read) against an SHR
 * database opened READ-ONLY, and print what the user would get -- confirmed rows, complete or partial, and the
 * delivered explanation naming unresolved agencies and why. Successful table creation is not GC-064 delivery;
 * this says whether the answer is useful, and reports an inadequate one as inadequate.
 *
 *   SHR_DB_PATH=<shr.db> tsx scripts/shr-ranking-check.ts ["<question>"]
 *
 * The cutoff is the route's own: the latest year in `incidents` and its highest month (lib/dynamic-facts.ts
 * `queryLatestMonth`, repeated here because importing dynamic-facts opens every database). Writes nothing.
 */
import Database from "better-sqlite3";
import path from "node:path";
import { planShrCityRanking, runShrCityRanking } from "../lib/city-ranking-shr";
import { loadShrTypeEvidence } from "../lib/shr-agency-classification";
import { validateDeterministicShrPlanSql } from "../lib/shr-authority";
import { queryContractFailureMessage } from "../lib/query-contract-validator";

const GC064 = "What cities over 100k population have highest homicide rates currently";

function main(): void {
  const question = process.argv[2] || GC064;
  const db = new Database(process.env.SHR_DB_PATH || path.join(process.cwd(), "shr.db"), { readonly: true, fileMustExist: true });
  try {
    const latest = db.prepare(
      "SELECT year, MAX(month) AS month FROM incidents WHERE year = (SELECT MAX(year) FROM incidents) GROUP BY year",
    ).get() as { year: number; month: number } | undefined;
    if (!latest?.year || !latest?.month) throw new Error("no monthly cutoff rows in incidents");
    const cutoff = { year: latest.year, month: latest.month, observed: true };
    const plan = planShrCityRanking(question, cutoff);
    if (plan?.kind !== "deterministic") {
      console.log(JSON.stringify({ question, cutoff, kind: plan?.kind ?? "not-a-ranking", explanation: plan && "explanation" in plan ? plan.explanation : null }, null, 1));
      return;
    }
    const statements: string[] = [];
    const out = runShrCityRanking(plan, {
      typeEvidence: (year) => loadShrTypeEvidence(db, year),
      validate: (sql) => {
        statements.push(sql);
        const c = validateDeterministicShrPlanSql({ question, sql });
        return queryContractFailureMessage(c) ? null : { sql: c.sql, rows: () => db.prepare(c.sql).all() as Record<string, unknown>[] };
      },
    });
    console.log(JSON.stringify(out.kind !== "answer" ? { question, cutoff, kind: out.kind, reason: out.reason, statements: statements.length } : {
      question, cutoff, kind: out.kind, title: out.title, complete: out.complete,
      confirmedRows: out.rows.length,
      rows: out.rows.map((r) => ({ ori: r.ori, city: r.city, state: r.state, victims: r.victims, population: r.population, rate_per_100k: r.rate_per_100k })),
      relevantUnresolved: out.relevantUnresolved.map((u) => ({ ori: u.ori, label: u.label })),
      splitIdentities: out.splitIdentities, statements: statements.length, explanation: out.explanation,
    }, null, 1));
  } finally {
    db.close();
  }
}

main();
