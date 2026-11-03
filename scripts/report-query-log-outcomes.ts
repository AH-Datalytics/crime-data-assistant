/**
 * The milestone report of real first questions (coordinator 2026-11-02): for a live source, the share of the first
 * questions from its old query-log tab that the engine answers, asks about, declines well (a runnable next step or an
 * honest, specific reason) and declines badly. Answered wrong comes from the accuracy pilot, once it exists.
 *
 *   npx tsx scripts/report-query-log-outcomes.ts --source historical --questions <first-questions.json> [--root <canonical>]
 *     [--historical <crime index build>] [--python <python with duckdb>] [--label "after #NNN"]
 *
 * The questions file (from the production query log, read-only: `[{ "id", "question" }]`) stays outside the repo; only
 * the counts are written, to docs/reports/query-log-outcomes.md (one section per source, replaced in place). Run by hand
 * at milestones; never in CI or harness:test.
 */
import fs from "node:fs";
import path from "node:path";
import { shadowAnswer, type ShadowDeps, type ShadowOutcome } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { loadNibrsRelease } from "../lib/nibrs-shadow/release";
import { duckdbExecutor } from "../lib/nibrs-shadow/duckdb";
import { historicalBuildAt } from "../lib/nibrs-shadow/historical";

const arg = (name: string, dflt?: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const SOURCE = arg("--source")!;
const QUESTIONS = arg("--questions")!;
if (!SOURCE || !QUESTIONS) throw new Error("--source and --questions are required");
// Through the month before the build's CDE release's month (Jeff 2026-11-03), from the release recorded with it.
const { released: _r, ...release } = loadNibrsRelease(arg("--release-file"), arg("--root", "C:/Users/jeffm/nibrs-model/work/buildhost/test6-20261031/release/canonical"));
const deps: ShadowDeps = {
  places: loadPlaceIndex(), release: { ...release, asOf: "2026-10-29" },
  target: { root: arg("--root", "C:/Users/jeffm/nibrs-model/work/buildhost/test6-20261031/release/canonical")!, builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] },
  execute: duckdbExecutor(arg("--python", "C:/Users/jeffm/nibrs-model/.venv/Scripts/python.exe")!),
  historical: historicalBuildAt(arg("--historical", "C:/Users/jeffm/crimeindex-build/crimeindex-20261101")),
} as ShadowDeps;

/** A decline is "well" when it gives a runnable next step or names an honest, specific limit; otherwise "badly". */
const WELL = /court outcomes|below the level of an agency|cannot predict|staffing .* isn't available|no state clearance rate|is outside them|is not in the data|doesn't include|aren't available here|isn't available here|isn't one category|among the places here|states and the nation here/;
const HONEST = new Set(["explanation_requested", "court_outcome", "below_agency_level", "outside_release_coverage"]);
type Class = "answered" | "asked" | "declined well" | "declined badly" | "error";
function classify(o: ShadowOutcome): Class {
  if (o.kind === "answer" || o.kind === "historical" || o.kind === "srs") return "answered";
  if (o.kind === "clarify") return "asked";
  if (o.kind === "route") return "declined well";
  // A decline whose reason is an honest, specific limit (causes, court outcomes, below an agency, a period outside the
  // data) is "well" by that reason, not only by its words. A place not found is "well" only in the shared wording that
  // names the places here, never the reader's older refusal (a misspelling such as "batlimore" has the same reason).
  if (o.kind === "decline") return o.alternative || WELL.test(o.explanation) || HONEST.has(o.reason) ? "declined well" : "declined badly";
  return "error";
}

const questions = JSON.parse(fs.readFileSync(QUESTIONS, "utf8")) as { question: string }[];
const counts: Record<Class, number> = { answered: 0, asked: 0, "declined well": 0, "declined badly": 0, error: 0 };
for (const q of questions) {
  try { counts[classify(shadowAnswer(q.question, deps))]++; } catch { counts.error++; }
}
const n = questions.length, pct = (k: Class) => `${counts[k]} (${Math.round((100 * counts[k]) / n)}%)`;
const section = [`## ${SOURCE}`, "", `${arg("--label", "")}${arg("--label") ? ": " : ""}${n} first questions from the old ${SOURCE} tab, release ${deps.release.id}, run ${new Date().toISOString().slice(0, 10)}.`, "",
  "| Answers | Asks a clarifying question | Declines well | Declines badly | Answers wrong |", "|---|---|---|---|---|",
  `| ${pct("answered")} | ${pct("asked")} | ${pct("declined well")} | ${pct("declined badly")} | (from the accuracy pilot) |`,
  ...(counts.error ? ["", `${counts.error} questions failed to run.`] : []), ""].join("\n");

const OUT = path.join(__dirname, "..", "docs", "reports", "query-log-outcomes.md");
const head = "# Real first questions, by source\n\nMilestone report (coordinator 2026-11-02): the share of each live source's real first questions that the engine answers, asks about, declines well (a runnable next step or an honest, specific limit) or declines badly. Counts only; the questions stay outside the repo. Regenerated by hand at milestones with scripts/report-query-log-outcomes.ts, never in CI.\n\n";
const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : head;
const re = new RegExp(`## ${SOURCE}\\n[\\s\\S]*?(?=\\n## |$)`);
const next = re.test(old) ? old.replace(re, section.trimEnd() + "\n") : `${old.trimEnd()}\n\n${section}`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, next.trimEnd() + "\n");
console.log(section);
process.exit(0);
