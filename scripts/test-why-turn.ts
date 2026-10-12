/*
 * Request accounting, stage 3b ("why" questions; plan 2026-10-11-request-accounting-stage3b-why.md r1-r1.4, amendment A1):
 *
 *   1. UNITS: explanation spans and masking (F1), topic classification by the thing explained (F5), every W template on
 *      hand-built answers (F4), causes (round 3: the decline alone), W1 field binding and rate methods (R3.1, R3.2), the guard and the
 *      matched capture of the scoped inner run (R4.2/R4.3, A1).
 *   2. STRUCTURE: each of the three routes has exactly ONE why branch, guarded by !isInnerRun(); its outer exit finalizes
 *      with narrative = the composed text and emits that same text; admission checks are skipped only inside an inner run;
 *      the four in-scope model clients are guarded; the cache read is guarded; the proof chokepoints record the capture;
 *      the NIBRS why branch leaves the accepted GC-091 follow-up to its own path (r1.2).
 */
import "./offline-evidence-guard";
import fs from "node:fs";
import path from "node:path";
import { findExplanationSpans, maskSpans, hasDataRequest } from "../lib/why-spans";
import { whyTopic, answerTopic, w3, subClauses, WHY_SENTENCES, type WhyAnswerFacts } from "../lib/why-answers";
import { runInner, guardModelClient, assertModelAllowed, recordFinalization, recordEmission, resultCapture, isInnerRun, RebuildBlocked, carriedOutcome } from "../lib/why-context";

let checks = 0;
let failures = 0;
function check(ok: boolean, label: string): void {
  checks += 1;
  if (!ok) { failures += 1; console.log(`  FAIL  ${label}`); } else if (!process.env.QUIET) console.log(`  PASS  ${label}`);
}

// ---------------------------------------------------------------- 1. spans and masking (F1)
{
  const q = "Show robberies in Nashville, TN in 2025 by month, and why is March missing?";
  const spans = findExplanationSpans(q);
  const masked = maskSpans(q, spans);
  check(spans.length === 1 && spans[0].clause === "is March missing", "numeric-first: one span, its clause after the introducer");
  check(masked.length === q.length && masked.trimEnd() === "Show robberies in Nashville, TN in 2025 by month", "masking keeps offsets and removes the leading conjunction with the span");
  check(hasDataRequest(masked), "numeric-first: a data request remains");
}
{
  const q = "Why is March missing? Show robberies in Nashville, TN in 2025 by month";
  const spans = findExplanationSpans(q);
  check(spans.length === 1 && maskSpans(q, spans).trim() === "Show robberies in Nashville, TN in 2025 by month", "why-first: the span ends at the question mark");
}
check(!hasDataRequest(maskSpans("Why did murders rise in 2025?", findExplanationSpans("Why did murders rise in 2025?"))), "a year inside the span is the explanation's subject, not a data request");
check(hasDataRequest(maskSpans("OK just do it for 2022, why are the location codes not all filled in?", findExplanationSpans("OK just do it for 2022, why are the location codes not all filled in?"))), "same-sentence mixed: the data part before the introducer remains");
for (const [q, intro] of [["how come there are no lines in the chart?", "how come"], ["explain how the rate is calculated", "explain"], ["what causes missing location codes?", "what causes"], ["Is there evidence for why an increase in 2025", "evidence for why"]] as const) {
  const s = findExplanationSpans(q);
  check(s.length === 1 && s[0].introducer.toLowerCase() === intro && !hasDataRequest(maskSpans(q, s)), `introducer "${intro}" opens a span and leaves no data request`);
}
check(findExplanationSpans("robberies in Seattle in 2025").length === 0, "no introducer, no span (the turn is untouched)");

// ---------------------------------------------------------------- 2. topics by the thing explained (F5)
const T: [string, string][] = [
  ["are the location codes not all filled in", "W1"], ["causes missing location codes", "W1"], ["are some ages unknown", "W1"],
  ["is there no number for March", "W2"], ["is 2020 missing", "W2"], ["is July missing", "W2"],
  ["is cybercrime not included when we say \"crime\"", "W3"], ["isn't cybercrime counted", "W3"],
  ["are there no trend lines in the chart", "W4"], ["is there no chart", "W4"],
  ["are the numbers the same", "W5"], ["is there no change given", "W5"],
  ["is the national total only from some agencies", "W6"], ["the rate is calculated", "W6"],
  ["did robberies rise", "cause"], ["is Seattle higher than Denver", "cause"], ["did murders rise in 2025", "cause"], ["an increase in 2025", "cause"],
  ["does the data look weird", "unsupported"],
];
for (const [clause, want] of T) check(whyTopic(clause) === want, `topic of "${clause}" is ${want} (got ${whyTopic(clause)})`);

// ---------------------------------------------------------------- 3. templates on hand-built answers (F4)
const typed = (rows: Record<string, unknown>[], extra: Partial<WhyAnswerFacts> = {}): WhyAnswerFacts => ({ question: "robberies", columns: Object.keys(rows[0] ?? {}), rows, chartConfig: null, notes: [], facts: [], ...extra });
// Round 2 (R2.4', R2.6''): W1's total is the PRODUCER's recorded denominator for the row's own keys, never the row sum. The
// round 1 check ("60 of the 460 ... (6.3%)") was internally inconsistent and is replaced here.
const LOC_KEY = { place: "Fort Worth, TX", measure: "robbery", period: "2025", dimension: "location", unit: "offenses" };
const loc = typed([
  { period: 2025, place: "Fort Worth, TX", measure: "robbery", unit: "offenses", filter: null, dimension: "location", category: "Highway/Road/Alley/Street", count: 400, share: 41.7, note: null },
  { period: 2025, place: "Fort Worth, TX", measure: "robbery", unit: "offenses", filter: null, dimension: "location", category: "Other/Unknown", count: 60, share: 6.3, note: null },
], { facts: [{ kind: "breakdown", key: LOC_KEY, denominator: 960, overlap: false }] });
const w1 = answerTopic("W1", "are the location codes not all filled in", loc, "nibrs") ?? "";
check(w1.startsWith('60 of the 960 robbery offenses in this answer (6.3%) are recorded as "Other/Unknown".') && /doesn't separate the two/.test(w1), "W1: the share over the producer's own denominator (960), with the combined-code sentence");
check(/^60 robbery offenses in this answer are recorded as "Other\/Unknown"\./.test(answerTopic("W1", "are the location codes not all filled in", { ...loc, facts: [{ kind: "breakdown", key: LOC_KEY, denominator: null, overlap: false }] }, "nibrs") ?? ""), "W1: a null producer denominator gives the count only, no share and no invented total");
const weapons = typed([{ period: 2025, place: "Fort Worth, TX", measure: "murder", unit: "victims", filter: null, dimension: "weapon", category: "Handgun", count: 60, share: 75, note: null }, { period: 2025, place: "Fort Worth, TX", measure: "murder", unit: "victims", filter: null, dimension: "weapon", category: "Rifle", count: 25, share: 31.3, note: null }],
  { facts: [{ kind: "breakdown", key: { place: "Fort Worth, TX", measure: "murder", period: "2025", dimension: "weapon", unit: "victims" }, denominator: 80, overlap: true }] });
check(answerTopic("W1", "are some weapons unknown", weapons, "nibrs") === "None of the 80 murder victims in this answer (a category total that counts each one once) has the weapon recorded as unknown or left blank.", "W1: overlapping categories use the unique denominator (80), never the row sum (85)");
check(!/unknown only/i.test(w1) && !/blank/i.test(w1), "W1: code 25 is never described as unknown-only or blank");
const monthly = typed([
  { period: "2025-02", place: "Nashville, TN", measure: "robbery", statistic: "count", value: 100, note: null },
  { period: "2025-03", place: "Nashville, TN", measure: "robbery", statistic: "count", value: null, note: "no report for March 2025" },
]);
check(answerTopic("W2", "is there no number for March", monthly, "current") === "No data was received for Nashville, TN for March 2025, so it is shown as missing, not as zero.", "W2: the missing month from the row note");
check(answerTopic("W2", "is there no number for February", monthly, "current") === "February 2025 isn't missing in this answer: it shows 100.", "W2: an asked month that is present is said to be present");
const nm = typed([{ year: 2021, month: 6, burglaries: 352 }, { year: 2021, month: 8, burglaries: 352 }]);
check(/^No offenses were recorded for July 2021 in this answer's data/.test(answerTopic("W2", "is July missing", nm, "nibrs") ?? ""), "W2 NIBRS: the activity-proxy wording, never \"didn't report\" as fact");
check(w3('is cybercrime not included when we say "crime"', "current") === "Current Trends counts 7 offenses: murder, rape, robbery, aggravated assault, burglary, theft and motor vehicle theft. Cybercrime isn't one of them.", "W3 Current: the seven offenses, no substitute");
check(w3("isn't cybercrime counted", "nibrs") === 'NIBRS has no category called "cybercrime", so I can\'t say which of its records you mean.', "W3 NIBRS: unresolved, never \"exists nowhere\"");
const overview = typed(["murder", "rape", "robbery"].flatMap((m) => [{ period: "2025-01", place: "Seattle, WA", measure: m, statistic: "count", value: 1, note: null }, { period: "2025-02", place: "Seattle, WA", measure: m, statistic: "count", value: 2, note: null }]), { chartConfig: { type: "line", xAxis: "period", yAxis: ["value"] } });
check(answerTopic("W4", "are there no trend lines in the chart", overview, "current") === "This answer's chart does draw lines: one line per measure (3 lines), by period.", "W4: the series count comes from the client's own pivot");
check(answerTopic("W4", "is there no chart", loc, "nibrs") === "This answer has no chart; it is shown as a table.", "W4: a null chart configuration draws no chart");
const pair = typed([{ period: 2024, place: "Seattle, WA", measure: "robbery", statistic: "count", value: 1024, note: null }, { period: 2024, place: "Denver, CO", measure: "robbery", statistic: "count", value: 957, note: null }]);
check(answerTopic("W5", "are the numbers the same", pair, "current") === "They aren't the same in this answer: they range from 957 to 1,024.", "W5: unequal values said to be unequal");
const withheld = typed([{ period: 2024, place: "Nashville, TN", measure: "robbery", statistic: "count", value: 903, note: null }, { period: 2025, place: "Nashville, TN", measure: "robbery", statistic: "count", value: null, note: null }], { notes: ["Nashville, TN: no report for March 2025."] });
check(answerTopic("W5", "is there no change given", withheld, "current") === "No change is given because Nashville, TN has no value for 2025: no data was received for March 2025.", "W5: a withheld change with its recorded reason (structured notes)");
const rate = typed([{ year: 2021, place: "Fort Worth, TX", measure: "murder", statistic: "rate_per_100k", value: 9.8, note: null }, { year: 2022, place: "Fort Worth, TX", measure: "murder", statistic: "rate_per_100k", value: null, note: "no population" }], { facts: [{ kind: "rate", method: "historical-annual", per: 100000, places: ["Fort Worth, TX"] }] }); // r2: the method is the producer's recorded fact
check(answerTopic("W6", "the rate is calculated", rate, "historical") === "Each rate is Fort Worth, TX's count for a year divided by its population for that year, times 100,000. 2022 has no population recorded, so no rate is given.", "W6: the producer's own denominator method");

// ---------------------------------------------------------------- 4. causes (round 3: the decline alone, owner decision 2026-10-12)
check(WHY_SENTENCES.cause("shr") === "I can't explain why: Homicide Reports record reported homicides, not their causes.", "cause: the per-source decline sentence");
check(answerTopic("cause", "did robberies rise", loc, "nibrs") === null, "R3.0: no answer topic produces a sentence for a cause");

// ---------------------------------------------------------------- 4a. round 3: W1 bound to the asked field, rate methods (R3.1', R3.2')
check(answerTopic("W1", "are some ages unknown", loc, "nibrs") === "This answer doesn't show age.", "R3.1': a field the answer doesn't show is never explained by another");
{
  const both = answerTopic("W1", "are location and age codes unknown", loc, "nibrs") ?? "";
  check(both.startsWith('60 of the 960 robbery offenses in this answer (6.3%) are recorded as "Other/Unknown".') && both.endsWith("This answer doesn't show age."), `R3.1': each named field bound in written order (${both.slice(0, 80)}...)`);
  const twice = answerTopic("W1", "are location codes and locations unknown", loc, "nibrs") ?? "";
  check((twice.match(/60 of the 960/g) ?? []).length === 1, "R3.1': the same field named twice is answered once");
  // Polish (Codex r3 item 6): across sub-clauses of one turn, a field already answered adds nothing ("").
  const seen = new Set<string>();
  const first = answerTopic("W1", "are location and age codes unknown", loc, "nibrs", seen) ?? "";
  const again = answerTopic("W1", "ages unknown", loc, "nibrs", seen);
  check(/doesn't show age\.$/.test(first) && again === "", `polish: a field already answered in the turn is not answered again (${JSON.stringify(again)})`);
  // Polish amendment 1 (Codex): a clause with no named field marks the field it actually explains (the answer's own).
  const ages = typed([
    { period: 2025, place: "Fort Worth, TX", measure: "robbery", unit: "offenders", filter: null, dimension: "age", category: "18-24", count: 40, share: null, note: null },
    { period: 2025, place: "Fort Worth, TX", measure: "robbery", unit: "offenders", filter: null, dimension: "age", category: "Unknown", count: 10, share: null, note: null },
  ]);
  const s2 = new Set<string>();
  const generic = answerTopic("W1", "are codes unknown", ages, "nibrs", s2) ?? "";
  const located = answerTopic("W1", "locations unknown", ages, "nibrs", s2);
  const agedAgain = answerTopic("W1", "ages unknown", ages, "nibrs", s2);
  check(/"Unknown"/.test(generic) && located === "This answer doesn't show location." && agedAgain === "", `polish A1: a generic clause marks the answer's own field, never another (${JSON.stringify([generic.slice(0, 40), located, agedAgain])})`);
  const nibrsRate = (facts: WhyAnswerFacts["facts"]) => answerTopic("W6", "how the rate is calculated", typed([{ year: 2025, value: 1 }], { facts }), "nibrs") ?? "";
  check(nibrsRate([{ kind: "rate", method: "nibrs-agency-annual", per: 100000, places: ["Fort Worth, TX"] }, { kind: "rate", method: "nibrs-agency-annual", per: 100000, places: ["Columbus, OH"] }])
    === "Each rate is that place's reported count for a year divided by its own population for that year, times 100,000.", "R3.2': one method's facts merge, and several places never get one place's name");
  check(nibrsRate([{ kind: "rate", method: "nibrs-clearance", per: 100, places: ["Fort Worth, TX"] }]) === "Each clearance rate is the offenses cleared divided by the offenses reported, times 100.", "R3.2'': a clearance rate gets the clearance sentence, no population");
  check(nibrsRate([]) === "This answer doesn't record how its rates or totals were formed.", "R3.2'': no recorded method keeps the named decline");
}

// ---------------------------------------------------------------- 4b. round 2 rules (R2.1', R2.3', R2.5', R2.6')
{
  const subs = (c: string, tab: "current" | "nibrs" = "current", f: WhyAnswerFacts | null = null) => subClauses(c, tab, f).map((x) => `${x.topic}${x.leftover.length ? `[${x.leftover.join(" ")}]` : ""}`).join(" + ");
  check(subs("are the location codes not all filled in and robberies so high", "nibrs") === "W1 + cause", `R2.1': two independent requests are split and both kept (${subs("are the location codes not all filled in and robberies so high", "nibrs")})`);
  check(subs("are there no lines and March missing") === "W4 + W2", `R2.1': W4 + W2 (${subs("are there no lines and March missing")})`);
  check(subs("whether the chart proves policing caused the decline") === "cause", `R2.1'/F5: attribution of a crime level is a cause, not W4 (${subs("whether the chart proves policing caused the decline")})`);
  check(subs("the reason for missing location codes", "nibrs") === "W1", `F5: "reason" about an artifact stays W1 (${subs("the reason for missing location codes", "nibrs")})`);
  check(subs("are robberies in Seattle, WA and Denver, CO the same") === "W5", `R2.1': a coordinated subject list is never split (${subs("are robberies in Seattle, WA and Denver, CO the same")})`);
  check(subs("are the location codes not filled in by the clerks", "nibrs") === "unsupported[clerks]", `R2.1': leftover words decline the sub-clause by name (${subs("are the location codes not filled in by the clerks", "nibrs")})`);
}
check(w3("is murder not counted", "current") === "Current Trends counts murder (one of its 7 offenses: murder, rape, robbery, aggravated assault, burglary, theft and motor vehicle theft).", "R2.3': a counted offense is said to be counted, never missing");
check(w3("is violent crime counted", "current") === "Current Trends counts violent crime as murder, rape, robbery and aggravated assault together.", "R2.3': a composite measure is described by its parts");
check(/has no category called "murder-suicide clusters"/.test(w3("aren't murder-suicide clusters counted", "current")), "R2.3': partial recognition is unresolved, never included");
check(w3("isn't robbery counted", "nibrs") === "NIBRS does count robbery.", "R2.3': NIBRS included through its own ledger");
{
  let threw = false; try { carriedOutcome(null); } catch { threw = true; }
  check(threw, "R2.6': carriedOutcome never defaults on a missing input");
  check(JSON.stringify(carriedOutcome({ outcome: { action: "clarify", reason: "measure_ambiguous" } })) === JSON.stringify({ action: "clarify", reason: "measure_ambiguous" }), "R2.6': carriedOutcome returns the captured site's own outcome");
}

// ---------------------------------------------------------------- 5. the inner run: guard, capture, scope (R4.2/R4.3, A1)
async function units(): Promise<void> {
  let invoked = 0;
  const client = guardModelClient({ messages: { create: async () => { invoked += 1; return "ok"; } } });
  check(!isInnerRun(), "outside any inner run");
  await client.messages.create();
  check(invoked === 1, "outside an inner run the model is called as before");
  const data = await runInner("data", async () => { await client.messages.create(); });
  check(invoked === 2 && !data.blocked, "a mixed turn's data part may call the model");
  let threw = false;
  const rebuild = await runInner("rebuild", async () => { try { await client.messages.create(); } catch (e) { threw = e instanceof RebuildBlocked; } });
  check(invoked === 2 && threw && rebuild.blocked, "a rebuild is blocked BEFORE the model is invoked, and the store records it");
  let cacheThrew = false;
  const cached = await runInner("rebuild", async () => { try { assertModelAllowed("cached model answer"); } catch { cacheThrew = true; } });
  check(cacheThrew && cached.blocked, "a rebuild never reads a cached model answer");
  const cap = await runInner("data", async () => {
    const f1 = {}; const f2 = {};
    recordFinalization(f1, { tag: "result-input" }); recordFinalization(f2, { tag: "explanation-input" });
    recordEmission(f1, { type: "result", rows: [{ a: 1 }], columns: ["a"], explanation: "x" });
    recordEmission(f2, { type: "explanation", text: "streamed" });
  });
  const r = resultCapture(cap);
  check(Boolean(r) && (r!.input as { tag: string }).tag === "result-input" && Array.isArray(r!.payload.rows), "capture: the result keeps its rows and its OWN finalization input, not the later text event's");
  const outside = {}; recordFinalization(outside, {}); recordEmission(outside, { rows: [] });
  check(!isInnerRun(), "the store does not leak out of the scoped run");
}

// ---------------------------------------------------------------- 6. structure of the wiring
function structure(): void {
  const root = path.resolve(__dirname, "..");
  const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
  for (const f of ["app/api/query/route.ts", "app/api/nibrs-query/route.ts", "app/api/shr-query/route.ts"]) {
    const s = read(f);
    check((s.match(/await handleWhyTurn\(/g) ?? []).length === 1, `${f}: exactly one why branch`);
    check(/if \(!isInnerRun\(\)[^)]*\)[\s\S]{0,400}await handleWhyTurn\(/.test(s), `${f}: the why branch never runs inside an inner run`);
    check((s.match(/const whyProof = /g) ?? []).length === 1 && (s.match(/const whyTextProof = /g) ?? []).length === 1
      && /if \(why\.kind === "data" && why\.capture\.input\) \{[\s\S]{0,200}const whyProof = finalizeExit\(\{ \.\.\.\(cap\.input as Partial<ProofFinalizationInput>\), outcome: carriedOutcome<QueryLogOutcome>\(cap\.input\), narrative: why\.text \}\);/.test(s)
      && /const whyTextProof = finalizeExit\(\{ planFamily: "why-turn", guardrails: why\.tags, outcome: answered \? OUTCOMES\.deterministic_plan : OUTCOMES\.capability_path_unavailable, narrative: why\.text \}\);/.test(s),
      `${f}: the carried and text why exits each finalize once, with narrative = the composed text (R2.6')`);
    check(/explanation: why\.text/.test(s), `${f}: the outer exit displays that same composed text`);
    check(/isInnerRun\(\) \? \(\{ allowed: true, remaining: 0 \}/.test(s) && /!isInnerRun\(\) && !validatePageToken\(/.test(s) && /isInnerRun\(\) \? \(\{ allowed: true \} as ReturnType<typeof checkSessionLimit>\) : checkSessionLimit\(/.test(s), `${f}: rate limit, page token and session limit skipped only inside an inner run`);
  }
  check(/!resolveRankingExplanationFollowup\(question, body\?\.history\)/.test(read("app/api/nibrs-query/route.ts")), "NIBRS: the accepted GC-091 follow-up keeps its own path (r1.2)");
  for (const f of ["lib/claude.ts", "lib/explain.ts", "lib/nibrs-claude.ts"]) check(/const client = guardModelClient\(new Anthropic\(\)\);/.test(read(f)) && !/= new Anthropic\(\);/.test(read(f)), `${f}: the model client is guarded`);
  check(/const client = guardModelClient\(new Anthropic\(\)\);/.test(read("app/api/shr-query/route.ts")), "shr-query: the model client is guarded");
  check(/assertModelAllowed\("cached model answer"\);/.test(read("lib/response-cache.ts")), "response cache: reads are guarded");
  const pf = read("lib/proof-finalize.ts");
  check(/const finalization = finalizeProofPaths\(input\);\n  recordFinalization\(finalization, input\);/.test(pf), "proof-finalize: every finalization path is recorded (before any early return)");
  check(/export function emitFactualPayload<T>[^\n]*\n[^\n]*\n  recordEmission\(finalization, payload\);/.test(pf), "proof-finalize: every emission is captured first");
  for (const f of ["lib/rtci-db.ts", "lib/nibrs-db.ts"]) check(/if \(isInnerRun\(\)\) return null;/.test(read(f)), `${f}: an inner run writes no log row`);
}

units().then(() => {
  structure();
  console.log(`\n${checks - failures}/${checks} passed`);
  if (failures > 0) process.exit(1);
}).catch((e) => { console.error(e); process.exit(1); });
