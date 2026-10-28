/**
 * How much of today's NIBRS traffic the new engine can reach through today's reader, before any SQL exists.
 *
 *   npx tsx scripts/nibrs-plan-reachability.ts        # writes scripts/fixtures/nibrs-replay/reachability/{results.json,summary.md}
 *
 * For each of the 605 questions in the replay inventory: today's reader (accountNibrsRequest + matchNibrsType), then
 * the adapter (lib/nibrs-plan/from-spec.ts), then every validation the plan language defines (schema, structure,
 * NIBRSAI's draft semantic layer, request accounting by value, release resolution). Today's declines are classified
 * by their stated reason: a limit of today's summary tables that the plan language removes, a request for causes, a
 * concept NIBRS does not record, an unresolved place or period, or other. Offline: no database, no model, no network.
 * Places resolve through a stand-in map (reachability/places.json); at run time the route's resolver supplies ORIs.
 */
import fs from "node:fs";
import path from "node:path";
import { accountNibrsRequest } from "../lib/nibrs-request-accounting";
import { matchNibrsType, type NPlace } from "../lib/nibrs-question-types";
import { planFromSpec } from "../lib/nibrs-plan/from-spec";
import { DRAFT_LAYER, DRAFT_SEMANTIC_VERSION } from "../lib/nibrs-plan/draft-layer";
import { parsePlan, type Place } from "../lib/nibrs-plan/plan";
import { validateResolved } from "../lib/nibrs-plan/resolve";
import { validateBindings, validatePlanSemantics, validatePlanShape } from "../lib/nibrs-plan/validate";

const DIR = path.join(__dirname, "fixtures", "nibrs-replay");
const OUT = path.join(DIR, "reachability");
const inventory = JSON.parse(fs.readFileSync(path.join(DIR, "inventory.json"), "utf8"));
const PLACES: Record<string, { ori: string; label: string }> = JSON.parse(fs.readFileSync(path.join(OUT, "places.json"), "utf8"));

const resolvePlace = (value: string, _p: NPlace): Place | null => (PLACES[value] ? { kind: "agency", ori: PLACES[value].ori, label: PLACES[value].label } : null);
const placeAuthority = (value: string) => (PLACES[value] ? { oris: [PLACES[value].ori] } : null);
const release = { id: "reachability", firstMonth: "1991-01", lastMonth: "2026-10" };
const geo = { members: (p: Place) => (p.kind === "agency" ? [p.ori] : ["(any)"]) };

/** Today's decline sentences that name a limit of the summary tables, which the plan language does not have. */
const TABLE_LIMITS = [
  /one breakdown per answer/, /breakdowns come from yearly tables/, /a breakdown for part of a year/, /ask for each year on its own/,
  /a share covers one period/, /one period per answer/, /rankings count each offense in its standard unit/, /a ranking covers (?:a full year|one year)/,
  /a ranking of only part of an offense/, /states are ranked without a population minimum/, /a state ranking covers every state/,
  /a ranking covers the nation or one state/, /I rank places by a level, not by a change/, /I compare one measure for one place/,
  /rates are given for complete years/, /a rate over several years is given per year/, /one counting unit per question/,
  /one minimum population/, /clearance figures count offense records/, /clearance tables don't record it/, /this answer type doesn't list every place/,
  /comparisons are answered as named places side by side/, /that time grain isn't available/, /answered only by its own fixed path/,
  /I couldn't use it in a supported question type/, /up to 10 named places/,
];

type Row = { id: number; origin: string; outcome_then: string; reader: string; category: string; detail?: string; rules?: string[] };
const rows: Row[] = [];
for (const it of inventory.items) {
  const base = { id: it.id, origin: it.origin, outcome_then: it.outcome_then };
  let ledger, d;
  try {
    ledger = accountNibrsRequest(it.question);
    d = matchNibrsType(ledger);
  } catch (e) {
    rows.push({ ...base, reader: "error", category: "reader_error", detail: String(e).slice(0, 200) });
    continue;
  }
  if (d.kind === "none") { rows.push({ ...base, reader: "none", category: it.context.follow_up_likely ? "no_typed_reading_follow_up" : "no_typed_reading" }); continue; }
  if (d.kind === "clarify") { rows.push({ ...base, reader: "clarify", category: "clarify" }); continue; }
  if (d.kind === "decline") {
    // By the declined parts themselves, most specific first; the sentence is used only for the table limits.
    const concepts = new Set(d.parts.map((p) => p.concept));
    const has = (...c: string[]) => c.some((x) => concepts.has(x));
    const cat = /can't explain causes/.test(d.explanation) || has("explain") ? "decline_explanation_requested"
      : d.parts.some((p) => p.state === "not-recorded") ? "decline_not_recorded_in_nibrs"
        : d.parts.some((p) => p.concept === "unrecognized" || p.state === "not-interpreted") ? "decline_reader_vocabulary_gap"
          : has("peer") ? "decline_peer_selection_not_in_plan_v1"
            : has("coverage-lookup", "completeness") ? "decline_coverage_question_not_in_plan_v1"
              : has("cohort") ? "decline_cohort_supported_by_plan"
                : /couldn't resolve that place|couldn't read that as a period/.test(d.explanation) ? "decline_unresolved_place_or_period"
                  : TABLE_LIMITS.some((re) => re.test(d.explanation)) ? "decline_table_limit_removed_by_plan_language" : "decline_other";
    rows.push({ ...base, reader: "decline", category: cat, detail: d.explanation.slice(0, 240) });
    continue;
  }
  const adapted = planFromSpec(d.spec, ledger, { semanticVersion: DRAFT_SEMANTIC_VERSION, resolvePlace });
  if (adapted.kind === "unmapped") { rows.push({ ...base, reader: `spec:${d.spec.type}`, category: "spec_unmapped", detail: adapted.reason }); continue; }
  const { plan, parts } = adapted;
  const problems = [
    ...parsePlan(plan).problems, ...validatePlanShape(plan), ...validatePlanSemantics(plan, DRAFT_LAYER),
    ...validateBindings(plan, parts, placeAuthority),
    ...validateResolved(plan, release, DRAFT_LAYER, geo).problems,
  ];
  rows.push({ ...base, reader: `spec:${d.spec.type}`, category: problems.length ? "plan_invalid" : "plan_valid",
              ...(problems.length ? { rules: [...new Set(problems.map((p) => p.rule))].sort(), detail: problems.slice(0, 3).map((p) => `${p.rule} ${p.path}: ${p.message}`).join(" | ").slice(0, 400) } : {}) });
}

const count = (sel: Row[], f: (r: Row) => string) => Object.entries(sel.reduce((m: Record<string, number>, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ _comment: "Built by scripts/nibrs-plan-reachability.ts; see summary.md.", rows }, null, 1) + "\n");
const pub = rows.filter((r) => r.origin === "unmatched");
const lines = ["# Plan-language reachability over the replay inventory", "",
  "Today's reader, then the adapter, then every plan validation (draft semantic layer). Offline; no SQL.", "",
  "| Category | All (605) | Unmatched (358) | Internal (247) |", "|---|---|---|---|"];
for (const [c, n] of count(rows, (r) => r.category)) lines.push(`| ${c} | ${n} | ${pub.filter((r) => r.category === c).length} | ${n - pub.filter((r) => r.category === c).length} |`);
lines.push("", "## Valid plans by today's outcome", "", "| Outcome then | Valid plans |", "|---|---|");
for (const [o, n] of count(rows.filter((r) => r.category === "plan_valid"), (r) => r.outcome_then)) lines.push(`| ${o} | ${n} |`);
lines.push("", "## Invalid plans by rule", "", "| Rules | Plans |", "|---|---|");
for (const [k, n] of count(rows.filter((r) => r.category === "plan_invalid"), (r) => (r.rules ?? []).join(" "))) lines.push(`| ${k} | ${n} |`);
fs.writeFileSync(path.join(OUT, "summary.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
