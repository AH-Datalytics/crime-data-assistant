/**
 * Read-only probe: re-run the live guardrails against the FINAL delivered SQL of
 * production rows that D8 flagged for retaining an unresolved contract tag.
 *
 * The question this answers: is the contract checker wrong about the SQL, or was
 * the tag inherited from a superseded retry attempt and never marked resolved?
 * Those are different bugs with different fixes, and reasoning from the regexes
 * alone is not reliable enough to tell them apart.
 *
 * Usage: npx tsx scripts/probe-d8-contract-tags.ts <cases.json>
 */
import fs from "node:fs";
import { validateQueryContractSql, queryContractGuardrails } from "../lib/query-contract-validator";

type Case = { id: number; question: string; sql: string; tab: string; guardrails: string };

const cases: Case[] = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

/**
 * IMPORTANT: the tag's bare-vs-resolved state is decided by
 * finalizeGuardrailTags(tags, queryContractGuardrails(runContractValidation(sql))),
 * and each route's runContractValidation closure calls validateQueryContractSql.
 * That is a DIFFERENT checker from runGuardrails/extractQueryContext -- probing the
 * latter answers the wrong question entirely.
 *
 * Caveat: routes pass `contractQuestion`, which for follow-ups is a rewritten
 * question rather than the logged text. Using the logged question is an
 * approximation, so a handful of verdicts may differ from what the route saw.
 */
function sourceFor(tab: string): "historical" | "current" | "nibrs" | "shr" | "hate_crime" {
  if (tab === "historical") return "historical";
  if (tab === "nibrs") return "nibrs";
  if (tab === "shr") return "shr";
  if (tab === "hate_crime") return "hate_crime";
  return "current";
}

for (const item of cases) {
  let fired: string[] = [];
  try {
    const contract = validateQueryContractSql({
      question: item.question,
      source: sourceFor(item.tab) as never,
      sql: item.sql,
    } as never);
    fired = queryContractGuardrails(contract);
  } catch (error) {
    console.log(`row ${item.id}: validation threw -- ${(error as Error).message}`);
    continue;
  }
  const loggedTags = (item.guardrails || "").split(",").map((t) => t.trim()).filter(Boolean);
  const contractTagsLogged = loggedTags.filter((t) => t.startsWith("contract-"));
  const contractTagsNow = fired.filter((t) => t.startsWith("contract-"));

  console.log("=".repeat(76));
  console.log(`row ${item.id} [${item.tab}]  ${item.question}`);
  console.log(`  tags LOGGED at the time : ${contractTagsLogged.join(", ") || "(none)"}`);
  console.log(`  tags FIRING on final SQL: ${contractTagsNow.join(", ") || "(none)"}`);

  const stillFires = contractTagsLogged.filter((t) => contractTagsNow.includes(t));
  const noLongerFires = contractTagsLogged.filter((t) => !contractTagsNow.includes(t));

  if (noLongerFires.length && !stillFires.length) {
    console.log(`  VERDICT: INHERITED TAG -- the delivered SQL satisfies the contract.`);
    console.log(`           '${noLongerFires.join(", ")}' should have been suffixed -resolved-on-retry.`);
  } else if (stillFires.length) {
    console.log(`  VERDICT: GENUINELY FIRES on the delivered SQL -- a real contract-checker gap.`);
  } else {
    console.log(`  VERDICT: no contract tags either way.`);
  }
}
