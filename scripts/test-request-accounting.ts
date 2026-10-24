/*
 * Request accounting ledger (stage 1, task 1). Pure in-memory checks of the shared mechanics:
 * overlap refusal, obligations surviving a lost part, outer and interior residue, the five states,
 * per-clause blocking, and binding only after finalize().
 */
import { RequestLedger, couldNotInterpret, refusalSentences, recordContext, recordBetweenFiller, type Span } from "../lib/request-accounting";

let checks = 0;
let failures = 0;
function check(ok: boolean, label: string): void {
  checks += 1;
  if (!ok) { failures += 1; console.log(`  FAIL  ${label}`); } else console.log(`  PASS  ${label}`);
}
const at = (q: string, word: string, from = 0): Span => { const i = q.indexOf(word, from); if (i < 0) throw new Error(word); return [i, i + word.length]; };

// ---- overlap refusal ----
{
  const q = "murders in Texas in 2025";
  const l = new RequestLedger(q);
  check(l.record({ concept: "measure", span: at(q, "murders"), rule: "m" }), "a first claim is recorded");
  check(!l.record({ concept: "weapon", span: at(q, "murders"), rule: "w" }), "an overlapping claim is refused, not merged");
  check(!l.record({ concept: "x", span: [3, 3], rule: "x" }), "an empty span is refused");
  check(l.parts.length === 1 && l.obligations.length === 1, "a refused claim records neither part nor obligation");
}

// ---- residue becomes not-interpreted; punctuation is context ----
{
  const q = "murder via banana in Texas in 2025?";
  const l = new RequestLedger(q);
  l.record({ concept: "measure", value: "murder", span: at(q, "murder"), rule: "m" });
  l.record({ concept: "place", value: "TX", span: at(q, "in Texas"), rule: "p" });
  l.record({ concept: "period", value: "2025", span: at(q, "in 2025"), rule: "y" });
  l.finalize();
  const residue = l.parts.filter((p) => p.rule === "residue").map((p) => p.text);
  check(JSON.stringify(residue) === JSON.stringify(["via", "banana"]), `unclaimed words become residue parts: ${JSON.stringify(residue)}`);
  check(l.parts.filter((p) => p.rule === "residue").every((p) => p.state === "not-interpreted"), "residue is not-interpreted");
  check(l.parts.some((p) => p.text === "?" && p.state === "context"), "trailing punctuation is context, recorded visibly");
  check(l.residue().length === 0, "after finalize nothing is unaccounted");
  check(l.refusedAtRecognition().length === 2, "the two residue words refuse at recognition");
  check(!l.record({ concept: "weapon", span: at(q, "banana"), rule: "late" }), "no part can be recorded after finalize");
}

// ---- interior residue: a broad match does not prove its interior ----
{
  const q = "attempted murders in Texas";
  const l = new RequestLedger(q);
  const whole = at(q, "attempted murders");
  l.record({ concept: "measure", value: "murder", span: whole, explains: [at(q, "murders")], rule: "broad" });
  l.record({ concept: "place", span: at(q, "in Texas"), rule: "p" });
  check(l.interiorResidue().map((r) => r.text).join() === "attempted", "an unexplained word inside a claim is interior residue");
  l.finalize();
  check(l.parts[0].state === "not-interpreted" && l.parts[0].explanation === couldNotInterpret("attempted murders"), "the claim with an unexplained interior is not-interpreted");
}

// ---- obligations survive a lost part ----
{
  const q = "female victims in Ohio";
  const l = new RequestLedger(q);
  l.record({ concept: "victim-sex", span: at(q, "female"), rule: "s" });
  check(l.undischarged().length === 0, "obligation discharged while its part exists");
  l.parts.splice(0, 1);
  check(l.undischarged().length === 1 && l.undischarged()[0].text === "female", "deleting a part leaves its obligation undischarged");
}

// ---- bind: applied vs not-applied-here, terminal states kept, only after finalize ----
{
  const q = "murders of female victims in Ohio for a report";
  const l = new RequestLedger(q);
  l.record({ concept: "measure", span: at(q, "murders"), rule: "m" });
  l.record({ concept: "victim-sex", span: at(q, "of female victims"), rule: "s" });
  l.record({ concept: "place", span: at(q, "in Ohio"), rule: "p" });
  l.record({ concept: "purpose", span: at(q, "for a report"), rule: "purpose", state: "context" });
  let threw = false;
  try { l.bind(0, new Set(["measure"]), () => "x"); } catch { threw = true; }
  check(threw, "bind before finalize throws");
  l.finalize();
  l.bind(0, new Set(["measure", "place"]), (p) => `I can't limit this answer by ${p.concept} yet.`);
  const sex = l.parts.find((p) => p.concept === "victim-sex")!;
  check(sex.state === "not-applied-here" && sex.explanation === "I can't limit this answer by victim-sex yet.", "an unbound recognized part is not-applied-here with the planner's wording");
  check(l.parts.find((p) => p.concept === "purpose")!.state === "context", "a context part is never overwritten by bind");
  check(l.blocking(0).length === 1 && l.blocking(0)[0] === sex, "only the unapplied part blocks the clause");
  l.bind(0, new Set(["victim-sex"]), () => "y");
  check(sex.state === "not-applied-here", "a terminal state is never rebound");
}
{
  const q = "murders in Texas and banana";
  const l = new RequestLedger(q);
  l.record({ concept: "measure", span: at(q, "murders"), rule: "m" });
  l.record({ concept: "place", value: "TX", span: at(q, "Texas"), rule: "p" });
  l.record({ concept: "place", value: null, span: at(q, "banana"), rule: "place:unresolved" });
  l.record({ concept: "connector", span: at(q, "and"), rule: "c" });
  l.finalize();
  l.bind(0, (p) => p.concept === "measure" || (p.concept === "place" && p.value === "TX"), (p) => `I couldn't find "${p.text}".`);
  const banana = l.parts.find((p) => p.text === "banana")!;
  check(banana.state === "not-applied-here" && l.blocking(0).includes(banana), "a predicate binds the resolved place only; an unresolved place of the same concept still blocks");
  check(l.parts.find((p) => p.text === "and")!.state === "not-applied-here", "a connector the planner does not apply blocks");
}

// ---- per-clause blocking keeps a supported clause answerable ----
{
  const q = "murders in Ohio in 2024 and immigration status of the victims";
  const l = new RequestLedger(q);
  l.record({ concept: "measure", span: at(q, "murders"), rule: "m", clause: 0 });
  l.record({ concept: "place", span: at(q, "in Ohio"), rule: "p", clause: 0 });
  l.record({ concept: "period", span: at(q, "in 2024"), rule: "y", clause: 0 });
  l.record({ concept: "connector", span: at(q, "and"), rule: "between-clauses", clause: 0, state: "context" });
  l.record({ concept: "immigration-status", span: at(q, "immigration status of the victims"), rule: "imm", clause: 1, state: "not-recorded", explanation: "Homicide Reports don't record immigration status." });
  l.finalize();
  l.bind(0, new Set(["measure", "place", "period"]), () => "z");
  check(l.blocking(0).length === 0, "clause 0 is fully applied and may answer");
  check(l.blocking(1).length === 1 && l.blocking(1)[0].state === "not-recorded", "clause 1 is blocked by its not-recorded part");
  check(JSON.stringify(refusalSentences(l.blocking(1))) === JSON.stringify(["Homicide Reports don't record immigration status."]), "the refusal sentence is the part's own wording");
  check(JSON.stringify(l.clauses()) === "[0,1]", "both clauses are kept in the ledger");
}

// ---- refusal sentences are ordered and deduplicated ----
{
  const q = "zz murders yy";
  const l = new RequestLedger(q);
  l.record({ concept: "measure", span: at(q, "murders"), rule: "m" });
  l.finalize();
  const s = refusalSentences(l.refusedAtRecognition());
  check(s.length === 2 && s[0].includes('"zz"') && s[1].includes('"yy"'), "one sentence per residue, in written order");
}

// ---- shared context rules, each paired with a near-miss that must NOT be context ----
{
  const ctx = (q: string) => { const l = new RequestLedger(q); recordContext(l); return l.parts.filter((p) => p.state === "context").map((p) => `${p.rule}:${p.text}`); };
  const purpose = (q: string) => ctx(q).find((s) => s.startsWith("purpose-clause:")) ?? null;
  check(purpose("murders in Alabama in 2025 for an immigration research report") === "purpose-clause:for an immigration research report", "a whole topical purpose clause is context");
  check(purpose("murders in Alabama in 2025 for a report limited to immigrants") === null, "a purpose phrase with a restriction after it is not context");
  check(purpose("murders in Alabama in 2025 for a report on immigrants") === null, "\"report on X\" is not a whole purpose clause");
  check(purpose("murders in Alabama for a report of only immigrant victims") === null, "a purpose clause with restriction words inside is not context");
  check(purpose("murders in Alabama for an ICE hockey research report.") === "purpose-clause:for an ICE hockey research report", "an ICE topical purpose clause is context, punctuation excluded");
  check(purpose("murders in Alabama for a report about 2019 murders") === null, "a purpose clause with a number inside is not context");
  check(purpose("homicides in Alabama in 2025 for an Immigration and Customs Enforcement research report") === "purpose-clause:for an Immigration and Customs Enforcement research report", "a named agency with 'and' inside a whole purpose clause is context");
  check(purpose("murders for a report in Alabama") === null, "a purpose clause not ending the request is not context");
  check(ctx("Can you show me murders in Texas?").includes("request-opener:Can you show me") , "a leading request opener is context");
  check(ctx("How many murders in Texas").includes("question-opener:How many"), "a leading how-many opener is context");
  check(!ctx("murders in Texas, can you show me").some((s) => s.startsWith("request-opener")), "an opener mid-request is not context");
  // Bounded fix (2026-10-23): a leading "can you" before an unlisted verb; the longer openers still win.
  check(ctx("can you rank order cities by murders").includes("can-you-opener:can you"), "a leading 'can you' is context (SHR L8971)");
  check(ctx("Can you show me murders in Texas?").includes("request-opener:Can you show me"), "the longer request opener still takes 'can you show me'");
  check(!ctx("murders in Texas, can you rank them").some((s) => s.startsWith("can-you-opener")), "'can you' mid-request is not context");
  check(ctx("murders in Texas please").includes("trailing-polite:please"), "trailing please is context");
  check(ctx("not murders in Texas").length === 0, "a leading negation is never context");
  check(ctx("murders in Texas or Ohio").length === 0, "and/or are never context");
  // Round 1 step B (STEP-B-LEFTOVER-RULE-r2.md): the two closed openers take their WHOLE prefix, ahead of the generic
  // question / yes-no openers, only at the start, and never swallow what follows.
  check(ctx("What can you tell me about DC violent crime trends?").includes("tell-me-opener:What can you tell me about"), "tell-me opener takes its whole prefix (L9552)");
  check(ctx("What data can you tell me about crime at apartment complexes").includes("tell-me-opener:What data can you tell me about"), "tell-me opener with 'data' (L2577)");
  check(!ctx("What can you tell me about DC violent crime trends?").some((s) => s.startsWith("question-opener")), "the generic question opener does not take the tell-me prefix");
  check(ctx("create a dataset of monthly homicides by state").includes("dataset-opener:create a dataset of"), "dataset opener (L9062)");
  check(ctx("create dataset of monthly homicides by state").includes("dataset-opener:create dataset of"), "dataset opener without 'a' (L9060)");
  check(ctx("Is it possible to create a dataset of violent offenses").includes("dataset-opener:Is it possible to create a dataset of"), "dataset opener ahead of the yes-no opener (L9015)");
  check(!ctx("dataset of robberies by state").some((s) => s.startsWith("dataset-opener")), "'dataset of' without 'create' is not an opener (L9067)");
  check(ctx("make that monthly").includes("make-it-opener:make that"), "W22: a leading 'make that' opens a follow-up");
  check(ctx("Now make it a rate").includes("make-it-opener:Now make it"), "W22: 'now make it'");
  check(!ctx("murders in Texas, make that monthly").some((s) => s.startsWith("make-it-opener")), "'make that' mid-request is not context");
  check(!ctx("make them monthly").some((s) => s.startsWith("make-it-opener")) && !ctx("make those a rate").some((s) => s.startsWith("make-it-opener")), "Codex W22: plural 'make them/those' is not an opener (it would escape follow-up detection)");
  check(!ctx("robberies in Texas, then create a dataset of murders").some((s) => s.startsWith("dataset-opener")), "the dataset opener mid-request is not context");
  check(!ctx("murders in Texas: what can you tell me about them").some((s) => s.startsWith("tell-me-opener")), "the tell-me opener mid-request is not context");
  {
    const q = "create a dataset of murders via banana in Texas";
    const l = new RequestLedger(q);
    recordContext(l);
    l.record({ concept: "measure", span: at(q, "murders"), rule: "m" });
    l.record({ concept: "place", span: at(q, "Texas"), rule: "p" });
    recordBetweenFiller(l);
    l.finalize();
    check(l.refusedAtRecognition().some((p) => p.text.includes("banana")), "after the dataset opener an unknown restriction still refuses");
  }
}
{
  const q = "murders in the state of Texas";
  const l = new RequestLedger(q);
  l.record({ concept: "measure", span: at(q, "murders"), rule: "m" });
  l.record({ concept: "place", span: at(q, "state of Texas"), rule: "p" });
  recordBetweenFiller(l);
  check(l.parts.filter((p) => p.rule === "between-filler").map((p) => p.text).join() === "in,the", "a run of linking words between two parts is context");
  const q2 = "murders in Texas";
  const l2 = new RequestLedger(q2);
  l2.record({ concept: "measure", span: at(q2, "murders"), rule: "m" });
  l2.record({ concept: "place", span: at(q2, "Texas"), rule: "p" });
  recordBetweenFiller(l2);
  check(l2.parts.some((p) => p.rule === "between-filler" && p.text === "in"), "a single filler word between two parts is context");
  const q3 = "murders via banana";
  const l3 = new RequestLedger(q3);
  l3.record({ concept: "measure", span: at(q3, "murders"), rule: "m" });
  recordBetweenFiller(l3);
  check(!l3.parts.some((p) => p.rule === "between-filler"), "\"via\" next to residue is never filler");
  const q4 = "murders with Texas";
  const l4 = new RequestLedger(q4);
  l4.record({ concept: "measure", span: at(q4, "murders"), rule: "m" });
  l4.record({ concept: "place", span: at(q4, "Texas"), rule: "p" });
  recordBetweenFiller(l4);
  check(l4.parts.some((p) => p.rule === "between-filler" && p.text === "with"), "a linking word between two recorded parts is context (the parts carry the meaning)");
  const q5 = "murders with banana";
  const l5 = new RequestLedger(q5);
  l5.record({ concept: "measure", span: at(q5, "murders"), rule: "m" });
  recordBetweenFiller(l5);
  check(!l5.parts.some((p) => p.rule === "between-filler"), "a linking word next to residue is never context");
  // Bounded fix (2026-10-23): a source's own linking words ("where", "when", "seen" on SHR) link two recorded parts only:
  // never next to residue (a negation), never at the start of the question, and never for a source that doesn't pass them.
  {
    const LINK = /^(?:where|when|seen)$/i;
    const ledgerOf = (q: string, parts: [string, string][], link?: RegExp) => {
      const l = new RequestLedger(q);
      for (const [concept, text] of parts) l.record({ concept, span: at(q, text), rule: concept });
      recordBetweenFiller(l, link); l.finalize();
      return l;
    };
    const lw = ledgerOf("murders where victims were black", [["measure", "murders"], ["role", "victims"], ["race", "black"]], LINK);
    check(lw.parts.some((p) => p.rule === "between-filler" && p.text === "where") && lw.refusedAtRecognition().length === 0, "a passed linking word between two parts is context; the condition parts remain");
    const lx = ledgerOf("murders where victims were black", [["measure", "murders"], ["role", "victims"], ["race", "black"]]);
    check(lx.refusedAtRecognition().some((p) => p.text === "where"), "without the source's linking words \"where\" still refuses");
    const ln = ledgerOf("murders where victims were not black", [["measure", "murders"], ["role", "victims"], ["race", "black"]], LINK);
    check(ln.refusedAtRecognition().some((p) => p.text.includes("not")), "a negation after \"where\" still refuses");
    const le = ledgerOf("states have seen an increase", [["entity", "states"], ["change", "increase"]], LINK);
    check(le.parts.filter((p) => p.rule === "between-filler").map((p) => p.text).join() === "have,seen,an", "\"have seen an\" between two parts is context");
    const lh = ledgerOf("murders when banana", [["measure", "murders"]], LINK);
    check(!lh.parts.some((p) => p.rule === "between-filler"), "\"when\" next to residue is never context");
    const ll = ledgerOf("Where does Chicago rank", [["place", "Chicago"], ["rank", "rank"]], LINK);
    check(ll.refusedAtRecognition().some((p) => /Where/.test(p.text)), "a leading \"Where\" asks a question; it is never a link");
  }
  const q6 = "murders in Texas not in 2025";
  const l6 = new RequestLedger(q6);
  l6.record({ concept: "measure", span: at(q6, "murders"), rule: "m" });
  l6.record({ concept: "place", span: at(q6, "Texas"), rule: "p" });
  l6.record({ concept: "period", span: at(q6, "2025"), rule: "y" });
  recordBetweenFiller(l6);
  check(!l6.parts.some((p) => p.text === "not") && l6.residue().map((r) => r.text).join() === "not,in", "a negation breaks a filler run and is never context");
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
