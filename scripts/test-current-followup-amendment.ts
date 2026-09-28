#!/usr/bin/env npx tsx
/**
 * GC-070 — carrying an explicit amendment forward as the effective request, and refusing to guess.
 *
 * THE CONVERSATION (frozen, v7): a rolling-12 national murder series, then "show me by per capita",
 * then a place change, then "range", then two more place changes. The scored turn, "now detroit",
 * came back as a MIN/MAX year range. From the third turn on, the route handed the contract and the
 * guardrails a bare fragment and nothing could see the measure the conversation had established.
 *
 * WHAT THIS VERSION PROVES. The effective request is now the existing QueryContract, built field
 * by field with where each field came from, and the route hands that object — not a sentence to be
 * parsed again — to the validator and to proof finalization. The checks below assert on that
 * contract directly, run the route's own expressions, and then drive the actual consumers with and
 * without it, so a consumer that quietly went back to parsing the fragment would show up here.
 *
 * AND IT STOPS RATHER THAN GUESSING. Every unresolved turn is kept as its own open question until
 * the reader answers it. Two values for one field in one turn is declined, not chosen between.
 *
 * EVIDENCE BOUNDARY. The frozen turns are quoted from the gold set. The clean counterpart — the
 * same sequence with a readable 2026 — is written here and labelled as such; it is not a repaired
 * GC-070 capture, no model call is made, and no statement below is a model output. The fixture is
 * built in memory from the repository's own Current Trends DDL.
 */

import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";

import { readFileSync } from "fs";

import {
  resolveCurrentFollowupAmendment,
  renderingDisagreements,
  CURRENT_AMENDMENT_CLARIFICATIONS,
  type AmendmentResolution,
} from "../lib/current-followup-amendment";
import { buildQueryContract, type QueryContract } from "../lib/query-contract";
import { validateQueryContractSql } from "../lib/query-contract-validator";
import { requestedScope } from "../lib/structural-semantics";
import { finalizeProof } from "../lib/proof-finalize";
import { validateGrain } from "../lib/requested-grain";
import { detectFollowupTransform } from "../lib/followup-transform";
import { detectQueryBearingFollowup } from "../lib/query-bearing-followup";
import { buildCrossSourceFollowupTransform } from "../lib/cross-source-followup";
import { normalizeHistoryForTab } from "../lib/chat-history";
import { branchCondition, extractBranch, extractDeclaration, runRouteExpression } from "./decision1-terminal-harness";

let checks = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  PASS  ${name}${detail ? "   " + detail : ""}`);
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? "   " + detail : ""}`); }
}

/** Every composed result this suite sees, so the rendering agreement is checked on all of them. */
const composedSeen: Array<Extract<AmendmentResolution, { kind: "composed" }>> = [];
function resolve(q: string, history: unknown): AmendmentResolution {
  const r = resolveCurrentFollowupAmendment(q, history, "current");
  if (r.kind === "composed") composedSeen.push(r);
  return r;
}
const brief = (r: AmendmentResolution) =>
  r.kind === "composed" ? r.effectiveQuestion : r.kind === "clarify" ? `clarify: ${JSON.stringify(r.openQuestions)}` : `none: ${r.reason}`;

/* ── the conversations ───────────────────────────────────────────────────────────────── */
const ANCHOR = "Can I see murders rolling over 12 months nationally, 2018 to present?";
type Turn = { role: string; content: string; source?: string; tab?: string };
const answer = (text: string, sql: string): Turn => ({ role: "assistant", content: `${text}\n[SQL: ${sql}]` });
const ROLLING_SQL = "SELECT year, month, rolling_12 FROM national_monthly WHERE offense = 'Murder'";
const user = (content: string): Turn => ({ role: "user", content, source: "current" });
const reply = (content: string): Turn => ({ role: "assistant", content, source: "current" });

/** The CLEAN counterpart. Written here, with a readable 2026. Not a capture, not a rescore. */
function cleanHistory(upTo: number): Turn[] {
  const turns: Array<[string, string]> = [
    [ANCHOR, "Rolling 12-month murder totals nationally from 2018 to present."],
    ["show me by per capita", "Rolling 12-month national murder rate per 100,000."],
    ["show seattle for 2026", "Rolling 12-month murder rate per 100,000 for Seattle in 2026."],
    ["do for nyc", "Rolling 12-month murder rate per 100,000 for New York City in 2026."],
  ];
  const history: Turn[] = [];
  for (const [q, a] of turns.slice(0, upTo)) {
    history.push(user(q));
    history.push({ ...answer(a, ROLLING_SQL), source: "current" });
  }
  return history;
}

/** The FROZEN turns, verbatim. */
const FROZEN_TURNS = [
  ANCHOR, "show me by per capita", "show seattle for 20206", "range", "do for nyc", "now detroit",
];
function frozenHistory(upTo: number): Turn[] {
  const history: Turn[] = [];
  for (const q of FROZEN_TURNS.slice(0, upTo)) {
    history.push(user(q));
    history.push({ ...answer("…", ROLLING_SQL), source: "current" });
  }
  return history;
}
/** Plain user/assistant pairs with placeholder answers. */
const pairs = (...qs: string[]): Turn[] => qs.flatMap((q) => [user(q), reply("…")]);

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 0 — ISOLATION
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 0  the guard ===");
{
  let denied = false;
  try { new (require("better-sqlite3") as new (f: string) => unknown)("crime_data.db"); } catch { denied = true; }
  check("a file-backed database open is refused in this process", denied);
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 1 — THE CLEAN COUNTERPART, AS A CONTRACT
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 1  anchor plus amendments, carried field by field ===");
const CLEAN = resolve("now detroit", cleanHistory(4));
{
  const r = CLEAN;
  check("the place amendment resolves", r.kind === "composed", brief(r));
  if (r.kind === "composed") {
    const c = r.contract;
    const p = c.request.provenance;
    console.log(`    anchor   : "${r.anchor}"`);
    console.log(`    applied  : ${r.applied.map((a) => `"${a.turn}" [${a.fields.join(",")}]`).join("  ")}`);
    console.log(`    rendered : "${r.effectiveQuestion}"`);
    check("  the anchor is the last full user request, not the previous fragment", r.anchor === ANCHOR);
    check("  offense: murder, stated in the anchor and carried", c.metric.topic === "murder"
      && p.offense.origin === "stated" && p.offense.turn === ANCHOR && p.offense.inherited);
    check("  measure: a rate, stated in the per-capita turn and carried", c.metric.unit === "rate_per_100k"
      && c.metric.denominator === "population" && p.unit.turn === "show me by per capita" && p.unit.inherited);
    check("  series: rolling 12 months, stated in the anchor", c.request.window === "rolling_12"
      && p.window.turn === ANCHOR);
    check("  place: Detroit, stated in this turn", c.geography.kind === "city" && /detroit/i.test(c.geography.name ?? "")
      && c.geography.state === "MI" && p.geography.turn === "now detroit" && !p.geography.inherited);
    check("  period: 2026, stated in the Seattle turn", c.time.startYear === 2026 && c.time.endYear === 2026
      && p.period.turn === "show seattle for 2026");
    check("  nothing is concatenated: one place, and the anchor's 2018 is gone",
      c.geographies.length === 1 && c.time.startYear !== 2018);
    check("  the contract is a new object, not the anchor's parse mutated",
      buildQueryContract(ANCHOR, "current")!.request === undefined);
  }
}

console.log("\n  each step of the clean sequence:");
for (const [turn, upTo, geoKind] of [
  ["show me by per capita", 1, "national"],
  ["show seattle for 2026", 2, "city"],
  ["do for nyc", 3, "city"],
] as Array<[string, number, string]>) {
  const r = resolve(turn, cleanHistory(upTo));
  check(`"${turn}" carries murder, a rate and the rolling window`, r.kind === "composed"
    && r.contract.metric.topic === "murder" && r.contract.metric.unit === "rate_per_100k"
    && r.contract.request.window === "rolling_12" && r.contract.geography.kind === geoKind, brief(r));
}
{
  const r = resolve("show me by per capita", cleanHistory(1));
  check("the national scope the parser cannot read in \"nationally\" is carried as national",
    r.kind === "composed" && r.contract.geography.kind === "national"
    && r.contract.time.startYear === 2018 && r.contract.time.endYear === null, brief(r));
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 2 — DEFAULTS DO NOT OVERWRITE WHAT THE READER SAID
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 2  stated, defaulted and inherited are kept apart ===");
{
  const r = resolve("now robberies", cleanHistory(2));
  check("an offense turn replaces only the offense; its parser-default count does not undo per capita",
    r.kind === "composed" && r.contract.metric.topic === "robbery" && r.contract.metric.unit === "rate_per_100k"
    && r.contract.request.provenance.unit.turn === "show me by per capita" && r.contract.request.window === "rolling_12",
    brief(r));
  const defaulted = resolve("now detroit", pairs("murders in Seattle in 2025"));
  check("a unit the reader never stated is recorded as a default",
    defaulted.kind === "composed" && defaulted.contract.metric.unit === "count"
    && defaulted.contract.request.provenance.unit.origin === "defaulted", brief(defaulted));
  const later = resolve("show me per capita", pairs("murders in Seattle in 2025", "now detroit"));
  check("and a later explicit unit replaces that default",
    later.kind === "composed" && later.contract.metric.unit === "rate_per_100k"
    && later.contract.request.provenance.unit.origin === "stated", brief(later));
  const back = resolve("show the counts", cleanHistory(2));
  check("an explicit count after a rate is a stated count, not ignored",
    back.kind === "composed" && back.contract.metric.unit === "count"
    && back.contract.request.provenance.unit.origin === "stated", brief(back));
  const noWindow = resolve("now detroit", pairs("murders in Seattle in 2025"));
  check("a series form nobody stated stays absent rather than defaulted",
    noWindow.kind === "composed" && noWindow.contract.request.window === null
    && noWindow.contract.request.provenance.window.origin === "absent", brief(noWindow));
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 3 — COMPETING VALUES ARE DECLINED, NOT CHOSEN BETWEEN (N2)
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 3  two values for one field in one turn ===");
for (const [turn, field] of [
  ["show counts and rates", "unit"],
  ["show counts and rates per capita", "unit"],
  ["by month and by year", "window"],
  ["show it monthly and annually", "window"],
  ["now Detroit and Chicago", "geography"],
  ["now murders and robberies", "offense"],
] as Array<[string, string]>) {
  const r = resolve(turn, cleanHistory(4));
  check(`"${turn}" declines ownership (${field})`, r.kind === "none" && r.reason.includes(field), brief(r));
}
{
  const r = resolve("now detroit", [...cleanHistory(2), user("show counts and rates"), reply("…")]);
  check("a competing turn earlier in the window declines the composition too", r.kind === "none", brief(r));
  const grain = resolve("show it rolling 12 months by month", pairs("murders in Detroit in 2025"));
  check("a rolling series shown by month is one form, not two", grain.kind === "composed"
    && grain.contract.request.window === "rolling_12", brief(grain));
  const single = resolve("show it by year", cleanHistory(4));
  check("a single stated form still replaces the rolling window", single.kind === "composed"
    && single.contract.request.window === "annual", brief(single));
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 4 — EVERY UNRESOLVED TURN STAYS OPEN UNTIL IT IS ANSWERED (N1)
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 4  open questions ===");
{
  const malformed = resolve("show seattle for 20206", frozenHistory(2));
  check("the malformed year is not read as 2026", malformed.kind === "clarify"
    && malformed.reason === "malformed-year", brief(malformed));
  check("  and the reader is asked about it",
    malformed.kind === "clarify" && malformed.question === CURRENT_AMENDMENT_CLARIFICATIONS["malformed-year"](malformed.unresolvedTurn));

  const frozen = resolve("now detroit", frozenHistory(5));
  check("the frozen GC-070 conversation asks rather than delivering a rolling series",
    frozen.kind === "clarify", brief(frozen));
  check("  it keeps BOTH unresolved turns, the typo and \"range\"",
    frozen.kind === "clarify" && frozen.openQuestions.length === 2
    && frozen.openQuestions[0].turn === "show seattle for 20206" && frozen.openQuestions[1].turn === "range");
  check("  it asks about the earliest and says another is waiting",
    frozen.kind === "clarify" && frozen.unresolvedTurn === "show seattle for 20206"
    && /one more question/.test(frozen.question));
}
{
  // N1: the typo is answered by the later year; "range" never was.
  const n1 = resolve("2026", pairs(ANCHOR, "show me by per capita", "show seattle for 20206", "range", "now Detroit"));
  check("N1: a later year answers the unreadable year but not \"range\"", n1.kind === "clarify"
    && n1.openQuestions.length === 1 && n1.openQuestions[0].turn === "range", brief(n1));

  const yearOnly = resolve("2026", pairs(ANCHOR, "show seattle for 2026", "range"));
  check("a year the reader was never asked for does not erase \"range\"", yearOnly.kind === "clarify", brief(yearOnly));

  const asked = [...pairs(ANCHOR, "show me by per capita", "show seattle for 2026"),
    user("range"), reply(CURRENT_AMENDMENT_CLARIFICATIONS["ambiguous-amendment"]("range"))];
  const answered = resolve("from 2018 to present", asked);
  check("a reply to this path's question about \"range\" answers it", answered.kind === "composed"
    && answered.contract.time.startYear === 2018 && answered.contract.time.endYear === null
    && /seattle/i.test(answered.contract.geography.name ?? ""), brief(answered));
  const ignored = resolve("now detroit", asked);
  check("a place-only reply does not pick either thing the question offered", ignored.kind === "clarify", brief(ignored));
  const seriesReply = resolve("show it by year", asked);
  check("a reply that changes the series answers it", seriesReply.kind === "composed"
    && seriesReply.contract.request.window === "annual", brief(seriesReply));
  // CR1 (Codex P3.3 continuation ruling): only the two things the question offered answer it.
  const offenseOnly = resolve("robberies", asked);
  check("CR1: an offense-only reply does not answer the question about \"range\"",
    offenseOnly.kind === "clarify" && offenseOnly.unresolvedTurn === "range", brief(offenseOnly));
  const unitOnly = resolve("show counts", asked);
  check("CR1: a unit-only reply does not answer it either", unitOnly.kind === "clarify" && unitOnly.unresolvedTurn === "range", brief(unitOnly));
  const both = resolve("robberies from 2018 to present", asked);
  check("CR1: a reply that is a complete request on its own is still a standalone reset (preserved)",
    both.kind === "none" && /stands on its own/.test(both.reason), brief(both));
  // The retained witness: anchor -> "range" -> this path's question -> "robberies" -> asked again -> an explicit answer.
  const CR1_ANCHOR = "murders rolling over 12 months per capita in Seattle in 2026";
  const QUESTION = CURRENT_AMENDMENT_CLARIFICATIONS["ambiguous-amendment"]("range");
  const cr1 = [user(CR1_ANCHOR), reply("A series."), user("range"), reply(QUESTION)];
  const cr1Offense = resolve("robberies", cr1);
  check("CR1 retained witness: \"robberies\" keeps the question about \"range\" open",
    cr1Offense.kind === "clarify" && cr1Offense.unresolvedTurn === "range" && cr1Offense.question === QUESTION, brief(cr1Offense));
  const askedAgain = [...cr1, user("robberies"), reply(QUESTION)];
  const cr1Years = resolve("from 2018 to present", askedAgain);
  check("CR1: the explicit years answer completes the request with the offense change carried",
    cr1Years.kind === "composed" && cr1Years.contract.metric.topic === "robbery" && cr1Years.contract.metric.unit === "rate_per_100k"
    && cr1Years.contract.request.window === "rolling_12" && cr1Years.contract.time.startYear === 2018 && cr1Years.contract.time.endYear === null
    && /seattle/i.test(cr1Years.contract.geography.name ?? "") && cr1Years.contract.request.provenance.offense.turn === "robberies", brief(cr1Years));
  const cr1Series = resolve("show it by year", askedAgain);
  check("CR1: a series answer completes it too, with the offense change carried",
    cr1Series.kind === "composed" && cr1Series.contract.metric.topic === "robbery" && cr1Series.contract.request.window === "annual", brief(cr1Series));
  const cr1Place = resolve("now Detroit", askedAgain);
  check("CR1: a place-only reply after the offense change still leaves it open", cr1Place.kind === "clarify" && cr1Place.unresolvedTurn === "range", brief(cr1Place));
  const otherQuestion = [...pairs(ANCHOR, "show seattle for 2026"), user("range"), reply("Which did you mean?")];
  check("an assistant turn that is not this path's question is not taken as one",
    resolve("from 2018 to present", otherQuestion).kind === "clarify");
}
{
  const PENDING_TYPO: Turn[] = [...cleanHistory(2), user("show seattle for 20206"), reply("I could not read a year in that.")];
  const answered = resolve("2026", PENDING_TYPO);
  check("a bare year answers the malformed-year question", answered.kind === "composed"
    && answered.contract.time.startYear === 2026 && /seattle/i.test(answered.contract.geography.name ?? "")
    && answered.contract.metric.unit === "rate_per_100k", brief(answered));
  check("a place-only fragment does not", resolve("now detroit", PENDING_TYPO).kind === "clarify");
  const late = resolve("2026", [...PENDING_TYPO, user("now Detroit"), reply("…")]);
  check("the answer still lands after an intervening place, and keeps it", late.kind === "composed"
    && /detroit/i.test(late.contract.geography.name ?? "") && late.contract.time.startYear === 2026, brief(late));
  check("a standalone request is not held hostage by an unresolved turn",
    resolve("How many robberies in Chicago in 2025?", PENDING_TYPO).kind === "none");
  check("nor is a clear metadata request",
    resolve("what years are available for Detroit", PENDING_TYPO).kind === "none");
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 5 — THE BOUNDARIES
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 5  what resets, what is out of reach, what is left alone ===");
{
  const standalone = [...cleanHistory(2), user("how many robberies were there in Chicago in 2024"),
    { ...answer("Robberies in Chicago, 2024.", "SELECT SUM(count) FROM agency_monthly"), source: "current" }];
  const r = resolve("now detroit", standalone);
  check("a self-contained request becomes the new anchor", r.kind === "composed"
    && r.contract.metric.topic === "robbery" && r.contract.request.window === null, brief(r));
}
check("with no history there is nothing to compose", resolve("now detroit", []).kind === "none");
check("with no anchor in the window, nothing is invented",
  resolve("now detroit", [user("do for nyc"), reply("…")]).kind === "none");
{
  const long: Turn[] = [...cleanHistory(1)];
  for (let i = 0; i < 6; i += 1) long.push(user(`do for city${i}`), reply("…"));
  check("an anchor beyond the retained window is not reached for", resolve("now detroit", long).kind === "none",
    `${long.length} messages supplied`);
}
for (const key of ["source", "tab"] as const) {
  const tagged: Turn[] = [...cleanHistory(1),
    { role: "user", content: "show me by per capita", [key]: "historical" } as Turn,
    { role: "assistant", content: "…", [key]: "historical" } as Turn];
  const r = resolve("now detroit", tagged);
  check(`a turn tagged \`${key}: historical\` ends the reconstruction`, r.kind === "none", brief(r));
}
check("the Historical tab is not this path",
  resolveCurrentFollowupAmendment("now detroit", cleanHistory(4), "historical").kind === "none");
check("a clear metadata request keeps its own behavior",
  resolve("what years are available for Detroit", cleanHistory(2)).kind === "none");
{
  const r = resolve("now detroit", pairs("how many murders were there in 2023"));
  check("an anchor that names what and WHEN but no place still anchors", r.kind === "composed"
    && r.contract.time.startYear === 2023 && /detroit/i.test(r.contract.geography.name ?? ""), brief(r));
  const y = resolve("for 2024", cleanHistory(2));
  check("an explicit new year replaces only the year", y.kind === "composed" && y.contract.time.startYear === 2024
    && y.contract.time.endYear === 2024 && y.contract.request.window === "rolling_12", brief(y));
  const rate = resolve("show me per 100000", cleanHistory(1));
  check("a rate written as per 100000 is a unit amendment, not a bad year", rate.kind === "composed"
    && rate.contract.metric.unit === "rate_per_100k", brief(rate));
}
for (const [anchorText, why] of [
  ["How many murders in Seattle in May, 2026?", "a month behind a comma"],
  ["Show murders in Seattle in 2026 excluding January", "an explicit exclusion"],
  ["Show murders and robberies in Seattle in 2026", "two offenses"],
] as Array<[string, string]>) {
  const r = resolve("now Detroit", pairs(anchorText));
  check(`ownership is declined — ${why}`, r.kind === "none", brief(r));
}
check("a question about something else does not become a place amendment",
  resolve("What is the population of Detroit?", cleanHistory(2)).kind === "none");

console.log("\n  a place the resolver cannot settle is never picked for the reader:");
{
  // The parser returns a first candidate for "Portland" (Maine) and flags it for clarification.
  const unsettled = resolve("show me by per capita", pairs(ANCHOR, "now Portland"));
  check("an ambiguous place earlier in the window is not carried as its first candidate",
    unsettled.kind === "none" && /never settled/.test(unsettled.reason), brief(unsettled));
  const settled = resolve("show me by per capita", [...pairs(ANCHOR), user("now Portland"),
    reply("Which Portland did you mean?"), user("Portland, OR"), reply("…")]);
  check("the reader's own settling of it is carried", settled.kind === "composed"
    && settled.contract.geography.state === "OR", brief(settled));
  const anchorAmbiguous = resolve("show me by per capita", pairs("murders in Springfield in 2025"));
  check("an anchor with an ambiguous place anchors, but carries nothing until it is settled",
    anchorAmbiguous.kind === "none" && /never settled/.test(anchorAmbiguous.reason), brief(anchorAmbiguous));
  const withRange = resolve("show me by per capita", pairs(ANCHOR, "now Portland", "range"));
  check("an unanswered \"range\" is still asked about before the unsettled place declines",
    withRange.kind === "clarify" && withRange.unresolvedTurn === "range", brief(withRange));
}
{
  // A county renders as "in Cook County, IL", which the parser does not read back as the same
  // place. The text-only guardrails would see a different request, so this path declines.
  const county = resolve("now Cook County, IL", cleanHistory(2));
  check("a rendering that would not read back to the same place declines ownership",
    county.kind === "none" && /does not read back/.test(county.reason) && /geography/.test(county.reason), brief(county));
}

console.log("\n  the follow-ups the product already recognized are left alone:");
for (const q of ["what about Detroit", "compare it to Chicago"]) {
  const existing = detectFollowupTransform(q, normalizeHistoryForTab(cleanHistory(2) as never, "current" as never));
  check(`"${q}" still has its existing transform`, Boolean(existing), existing ? existing.contextQuestion : "(null)");
}
check("\"show the rates instead\" is still recognized by the query-bearing detector",
  Boolean(detectQueryBearingFollowup("show the rates instead", cleanHistory(2) as never)));

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 6 — THE ROUTE'S OWN EXPRESSIONS
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 6  the route: one effective request, handed to each consumer ===");
const routeText = readFileSync("app/api/query/route.ts", "utf8");
/** The right-hand side of a plain `name = …;` assignment in the route, as source text. */
function assignment(name: string): { text: string; line: number } {
  const re = new RegExp(`^\\s*${name}\\s*=\\s*([^;]+);`, "m");
  const match = re.exec(routeText);
  if (!match) throw new Error(`no assignment to ${name} in the route`);
  return { text: match[1], line: routeText.slice(0, match.index).split("\n").length + 1 };
}
const transformDecl = extractDeclaration("query", "followupTransform");
const amendedDecl = extractDeclaration("query", "amendedContract");
const guardrailDecl = extractDeclaration("query", "guardrailQuestion");
const deliveryDecl = extractDeclaration("query", "deliveryQuestion");
const contractQuestionAssign = assignment("contractQuestion");
const contractOverrideAssign = assignment("contractOverride");
const proofContractAssign = assignment("proofContract");
console.log(`    app/api/query/route.ts:${transformDecl.line} :${amendedDecl.line} :${guardrailDecl.line} :${deliveryDecl.line}`
  + ` :${contractQuestionAssign.line} :${contractOverrideAssign.line} :${proofContractAssign.line}`);

type RouteState = {
  followupTransform: { contextQuestion: string; instruction: string } | null;
  amendedContract: QueryContract | null;
  guardrailQuestion: string;
  contractQuestion: string;
  contractOverride: QueryContract | null;
  proofContract: QueryContract | null;
  deliveryQuestion: string;
};
function runRoute(mode: string, q: string, history: Turn[]): RouteState {
  const normalized = normalizeHistoryForTab(history as never, "current" as never);
  const currentAmendment = resolveCurrentFollowupAmendment(q, history, "current");
  const base = {
    plannerMode: mode, followupPlan: null, detectFollowupTransform, buildCrossSourceFollowupTransform,
    currentAmendment, question: q, history: normalized, body: { history }, isHistorical: false,
  };
  const followupTransform = runRouteExpression<RouteState["followupTransform"]>(transformDecl.text, base);
  const amendedContract = runRouteExpression<QueryContract | null>(amendedDecl.text, { ...base, followupTransform });
  const guardrailQuestion = runRouteExpression<string>(guardrailDecl.text, { ...base, followupTransform });
  const scope = { ...base, followupTransform, amendedContract, guardrailQuestion };
  return {
    followupTransform, amendedContract, guardrailQuestion,
    contractQuestion: runRouteExpression<string>(contractQuestionAssign.text, scope),
    contractOverride: runRouteExpression<QueryContract | null>(contractOverrideAssign.text, scope),
    proofContract: runRouteExpression<QueryContract | null>(proofContractAssign.text, scope),
    deliveryQuestion: runRouteExpression<string>(deliveryDecl.text, scope),
  };
}
for (const mode of ["off", "compare"]) {
  const out = runRoute(mode, "now detroit", cleanHistory(4));
  check(`${mode}: the validator and proof receive the amended contract itself`,
    out.amendedContract !== null && out.contractOverride === out.amendedContract && out.proofContract === out.amendedContract
    && out.amendedContract.request !== undefined);
  check(`${mode}: the validator's question stays the reader's own words`, out.contractQuestion === "now detroit");
  check(`${mode}: the text guardrails and delivery checks read the verified rendering`,
    out.guardrailQuestion === out.deliveryQuestion && CLEAN.kind === "composed" && out.guardrailQuestion === CLEAN.effectiveQuestion,
    out.guardrailQuestion);
  check(`${mode}: the model instruction is rendered from the same contract`,
    Boolean(out.followupTransform) && out.followupTransform!.instruction.includes(out.guardrailQuestion)
    && /- measure: rate per 100,000 residents \(stated in "show me by per capita"\)/.test(out.followupTransform!.instruction)
    && /- series: rolling 12-month totals/.test(out.followupTransform!.instruction)
    && /- place: Detroit, MI \(stated in "now detroit"\)/.test(out.followupTransform!.instruction)
    && /- period: 2026 \(stated in "show seattle for 2026"\)/.test(out.followupTransform!.instruction));
}
{
  const untouched = runRoute("off", "what about Detroit", cleanHistory(2));
  check("a follow-up the product already recognized carries no amended contract",
    Boolean(untouched.followupTransform) && untouched.amendedContract === null && untouched.contractOverride === null
    && untouched.contractQuestion === untouched.guardrailQuestion && untouched.deliveryQuestion === "what about Detroit",
    untouched.guardrailQuestion);
  const firstTurn = runRoute("off", ANCHOR, []);
  check("a first turn is left exactly as the reader wrote it", firstTurn.guardrailQuestion === ANCHOR
    && firstTurn.contractQuestion === ANCHOR && firstTurn.amendedContract === null && firstTurn.deliveryQuestion === ANCHOR);
  const declined = runRoute("off", "show counts and rates", cleanHistory(4));
  check("a declined turn keeps the legacy wiring: no contract, the raw question everywhere",
    declined.amendedContract === null && declined.contractQuestion === "show counts and rates"
    && declined.deliveryQuestion === "show counts and rates");
}
check("the validator call passes the override", /contract:\s*contractOverride/.test(routeText));
check("every proof exit passes the amended contract", /question:\s*proofQuestion,\s*\n\s*contract:\s*proofContract/.test(routeText));
{
  const exit = extractBranch("query", { condStartsWith: "currentAmendment.kind===\"clarify\"", mustInclude: "current-amendment:" });
  console.log(`    the clarification exit at app/api/query/route.ts:${exit.line}`);
  check("the clarification exit is terminal and dispatches no model call", /\breturn\b/.test(exit.text)
    && !/translate\(|translateToSql/.test(exit.text));
  check("  it delivers the question and nothing else",
    /sql:\s*null/.test(exit.text) && /rows:\s*\[\]/.test(exit.text) && /rowCount:\s*0/.test(exit.text));
  const entered = (resolution: { kind: string }) => runRouteExpression<boolean>(branchCondition(exit), { currentAmendment: resolution });
  check("  it is entered for the frozen conversation and for N1",
    entered(resolveCurrentFollowupAmendment("now detroit", frozenHistory(5), "current")) === true
    && entered(resolveCurrentFollowupAmendment("2026", pairs(ANCHOR, "show me by per capita", "show seattle for 20206", "range", "now Detroit"), "current")) === true);
  check("  and not for one that composes",
    entered(resolveCurrentFollowupAmendment("now detroit", cleanHistory(4), "current")) === false);
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 7 — THE CONSUMERS, WITH AND WITHOUT THE CONTRACT
 * ════════════════════════════════════════════════════════════════════════════════════════
 * Each consumer is run twice: with the amended contract the route now passes, and the way it would
 * behave if it went back to parsing the reader's fragment. The second run is the mismatch control:
 * if a consumer's result does not change, this suite could not tell whether it reads the contract.
 */
console.log("\n=== 7  the validator, structural semantics, proof and the grain check ===");
if (CLEAN.kind !== "composed") throw new Error("the clean sequence must compose for the consumer checks");
const carried = CLEAN.contract;

const COUNT_SQL = "SELECT year, month, SUM(count) AS murders FROM agency_monthly WHERE agency = 'Detroit' AND state = 'MI' "
  + "AND offense = 'Murder' AND year = 2026 GROUP BY year, month ORDER BY year, month LIMIT 100";
const ROLLING_RATE_SQL = "SELECT a.year, a.month, ROUND(SUM(b.count) * 100000.0 / p.population, 2) AS rolling_rate_per_100k "
  + "FROM agency_monthly a JOIN agency_monthly b ON b.ori = a.ori AND b.offense = a.offense "
  + "AND (b.year * 12 + b.month) BETWEEN (a.year * 12 + a.month - 11) AND (a.year * 12 + a.month) "
  + "JOIN agency_population p ON p.ori = a.ori AND p.year = a.year "
  + "WHERE a.agency = 'Detroit' AND a.state = 'MI' AND a.offense = 'Murder' AND a.year = 2026 "
  + "GROUP BY a.year, a.month, p.population ORDER BY a.year, a.month LIMIT 100";
/** The same rolling rate, filtered by `year >= 2025` because the window reaches into 2025. */
const ROLLING_WIDE_SQL = ROLLING_RATE_SQL.replace("AND a.year = 2026", "AND a.year >= 2025 AND (a.year * 12 + a.month) >= (2026 * 12 + 1)");
const MONTHLY_RATE_SQL = "SELECT a.year, a.month, ROUND(SUM(a.count) * 100000.0 / p.population, 2) AS rate_per_100k "
  + "FROM agency_monthly a JOIN agency_population p ON p.ori = a.ori AND p.year = a.year "
  + "WHERE a.agency = 'Detroit' AND a.state = 'MI' AND a.offense = 'Murder' AND a.year = 2026 "
  + "GROUP BY a.year, a.month, p.population ORDER BY a.year, a.month LIMIT 100";

console.log("\n  the validator:");
{
  const validate = (sql: string, contract: QueryContract | null) =>
    validateQueryContractSql({ question: "now detroit", source: "current", sql, contract });
  const withContract = validate(COUNT_SQL, carried);
  const fromFragment = validate(COUNT_SQL, null);
  check("a count query under a carried per-capita request is sent back for its denominator",
    withContract.enforced.includes("current-rate-population"), JSON.stringify(withContract.enforced));
  check("  CONTROL: parsing the fragment instead lets the count through unchallenged",
    !fromFragment.enforced.includes("current-rate-population"), JSON.stringify(fromFragment.enforced));

  const rolling = validate(ROLLING_WIDE_SQL, carried);
  const { request, ...withoutWindow } = carried;
  void request;
  const textIntent = validate(ROLLING_WIDE_SQL, withoutWindow as QueryContract);
  check("a rolling query that reaches into 2025 is not forced to a single-year filter",
    !rolling.enforced.includes("contract-single-year-temporal-scope") && rolling.blockReasons.length === 0,
    JSON.stringify(rolling.enforced));
  check("  CONTROL: read \"rolling\" from the fragment and the same correct query is refused",
    textIntent.enforced.includes("contract-single-year-temporal-scope"), JSON.stringify(textIntent.enforced));

  const clean = validate(ROLLING_RATE_SQL, carried);
  check("the controlled rolling per-capita query passes every check with the carried contract",
    clean.blockReasons.length === 0 && clean.retryIssues.length === 0, JSON.stringify(clean.enforced));
  const foreign = validateQueryContractSql({ question: "now detroit", source: "historical", sql: COUNT_SQL, contract: carried });
  check("a contract for a different source is not trusted", !foreign.enforced.includes("current-rate-population"));
}

console.log("\n  structural semantics:");
{
  const annual = resolve("show it by year", pairs("murders in Detroit in 2025"));
  if (annual.kind !== "composed") throw new Error(brief(annual));
  const withContract = requestedScope("now detroit", annual.contract);
  const fromFragment = requestedScope("now detroit", buildQueryContract("now detroit", "current")!);
  check("the requested grain comes from the carried series form", withContract.grain === "annual", String(withContract.grain));
  check("  CONTROL: the fragment names no grain", fromFragment.grain === null, String(fromFragment.grain));
  check("a rolling series asks for monthly figures, as the text detector would read it",
    requestedScope("now detroit", carried).grain === "monthly");
}

console.log("\n  proof finalization:");
{
  const shadow = { PROOF_MODE: "shadow" } as Record<string, string | undefined>;
  const seattleRows = [{ year: 2026, month: 1, agency: "Seattle", rolling_rate_per_100k: 5.1 }];
  const common = {
    sourceId: "current" as const, sql: ROLLING_RATE_SQL, rows: seattleRows, columns: Object.keys(seattleRows[0]),
    truncated: false, planFamily: null, returnedEntities: ["seattle"], intendedAction: "answer" as const, env: shadow,
  };
  const withContract = finalizeProof({ ...common, question: "per capita", contract: carried });
  const fromFragment = finalizeProof({ ...common, question: "per capita" });
  check("proof finds the requested place missing when the carried contract names Detroit",
    withContract.mode === "shadow" && withContract.decision.requested === 1
    && withContract.decision.omissions.length === 1, JSON.stringify(withContract.decision));
  check("  CONTROL: from the fragment it has no requested place to miss",
    fromFragment.decision.requested === null && fromFragment.decision.omissions.length === 0,
    JSON.stringify(fromFragment.decision));
  const off = finalizeProof({ ...common, question: "per capita", contract: carried, env: {} });
  check("off mode stays inert; it is not evidence that the contract was read", off.mode === "off" && off.digest === null);
}

console.log("\n  the post-execution grain check, through the route's delivery question:");
{
  const annualHistory = pairs("murders in Detroit in 2025", "show it by year");
  const route = runRoute("off", "now detroit", annualHistory);
  const monthlyRows = [{ year: 2025, month: 1, murders: 20 }, { year: 2025, month: 2, murders: 22 }];
  const viaRoute = validateGrain(route.deliveryQuestion, monthlyRows, COUNT_SQL);
  const viaFragment = validateGrain("now detroit", monthlyRows, COUNT_SQL);
  check("monthly rows for a carried by-year request are caught", route.amendedContract !== null && !viaRoute.ok,
    route.deliveryQuestion);
  check("  CONTROL: the reader's fragment would have let them through", viaFragment.ok);
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 8 — A ROLLING ANSWER IS NOT A MONTHLY ONE
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 8  the fixture, with monthly and rolling deliberately different ===");
{
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3") as new (f: string) => {
    exec: (s: string) => void;
    prepare: (s: string) => { run: (...a: unknown[]) => void; all: () => Record<string, unknown>[] };
  };
  const ddl = readFileSync("scripts/fixtures/operation-taxonomy/crime_data.ddl.sql", "utf8");
  const table = (name: string) => {
    const from = ddl.slice(ddl.indexOf(`CREATE TABLE ${name} `));
    return from.slice(0, from.indexOf(";") + 1);
  };
  const db = new Database(":memory:");
  db.exec(table("agency_monthly"));
  db.exec(table("agency_population"));
  const monthly = db.prepare("INSERT INTO agency_monthly (ori, agency, state, type, offense, year, month, count) VALUES (?,?,?,?,?,?,?,?)");
  const pop = db.prepare("INSERT INTO agency_population (ori, year, population) VALUES (?,?,?)");
  pop.run("MI0000000", 2025, 600_000);
  pop.run("MI0000000", 2026, 600_000);
  // 2025 runs at 30 a month; 2026 at 1 a month except December. Every 2026 rolling value carries
  // 2025 months, so a monthly figure and a rolling one cannot be mistaken for each other.
  for (let month = 1; month <= 12; month += 1) {
    monthly.run("MI0000000", "Detroit", "MI", "City", "Murder", 2025, month, 30);
    monthly.run("MI0000000", "Detroit", "MI", "City", "Murder", 2026, month, month === 12 ? 60 : 1);
  }
  const rolling = db.prepare(ROLLING_RATE_SQL).all();
  const monthlyRates = db.prepare(MONTHLY_RATE_SQL).all();
  check("the controlled rolling query returns twelve 2026 months", rolling.length === 12
    && rolling.every((row) => Number(row.year) === 2026));
  const jan = { rolling: Number(rolling[0].rolling_rate_per_100k), monthly: Number(monthlyRates[0].rate_per_100k) };
  check("January's rolling rate carries eleven 2025 months and differs from its monthly rate",
    jan.rolling === Math.round((11 * 30 + 1) * 100000 / 600000 * 100) / 100 && jan.rolling !== jan.monthly,
    `rolling ${jan.rolling} vs monthly ${jan.monthly}`);
  const validated = validateQueryContractSql({ question: "now detroit", source: "current", sql: ROLLING_RATE_SQL, contract: carried });
  const detroitRows = rolling.map((row) => ({ ...row, agency: "Detroit" }));
  const proof = finalizeProof({
    sourceId: "current", question: CLEAN.effectiveQuestion, contract: carried, sql: ROLLING_RATE_SQL,
    rows: detroitRows, columns: Object.keys(detroitRows[0]), truncated: false, planFamily: null,
    returnedEntities: ["detroit"], intendedAction: "answer", env: { PROOF_MODE: "shadow" },
  });
  check("that query passes validation and proof finds the requested place present",
    validated.blockReasons.length === 0 && validated.retryIssues.length === 0
    && proof.decision.requested === 1 && proof.decision.included === 1 && proof.decision.omissions.length === 0,
    JSON.stringify(proof.decision));
  const monthlyValidated = validateQueryContractSql({ question: "now detroit", source: "current", sql: MONTHLY_RATE_SQL, contract: carried });
  console.log(`    NOTE: the monthly-rate query also passes validation (${monthlyValidated.blockReasons.length} blocks, `
    + `${monthlyValidated.retryIssues.length} retries). No SQL rule checks that a rolling window was computed; the`);
  console.log("          series form reaches the model instruction, the single-year check and the grain check only.");
  console.log("          Both statements are written here and executed on the fixture. Neither is a model output.");
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 9 — EVERY RENDERING READS BACK TO ITS CONTRACT
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 9  the rendering the text-only consumers read ===");
{
  const disagreeing = composedSeen.filter((r) => renderingDisagreements(r.effectiveQuestion, r.contract).length > 0);
  check(`all ${composedSeen.length} composed results render to the same request`, composedSeen.length > 20 && disagreeing.length === 0,
    disagreeing.map((r) => r.effectiveQuestion).join(" | "));
  const tampered = { ...carried, request: { ...carried.request, window: "annual" as const } };
  check("a rendering that disagrees with its contract is detected",
    renderingDisagreements(CLEAN.effectiveQuestion, tampered).includes("window"));
}

/* ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("");
console.log(`  isolation: ${deniedDatabaseOpens().length} file-backed database opens denied, `
  + `${deniedNetworkCalls().length} network calls denied`);
console.log(failures.length === 0
  ? `ALL CHECKS PASSED  (${checks})`
  : `FAILURES: ${failures.length} of ${checks} -> ${failures.join(" | ")}`);
process.exit(failures.length === 0 ? 0 : 1);
