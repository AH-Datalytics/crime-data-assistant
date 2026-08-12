/**
 * Deterministic omission wording, and the disclosure check built on it.
 *
 * This module replaced a substring test that asked whether each omitted entity's name
 * appeared anywhere in the narrative. That passed on "Dallas had 10 murders in 2020" --
 * a sentence that mentions Dallas, discloses nothing about its absence, and in a
 * comparison context implies the opposite. The assertions below are mostly about what
 * must NOT count as disclosure.
 *
 * The other property under test is the source/capability split (handoff §2.4): a
 * reason outside SOURCE_ATTRIBUTABLE_OMISSION_REASONS must never produce wording that
 * blames the data, so an `unknown` attribution cannot become "not in this source"
 * merely by reaching the wording layer.
 */
import assert from "node:assert";
import {
  buildOmissionNotice,
  narrativeDisclosesOmissions,
  reasonMayBlameSource,
  MAX_INLINE_OMISSION_LABELS,
} from "../lib/omission-wording";
import { OMISSION_REASONS, type Omission, type OmissionReason } from "../lib/proof-contract";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}\n        ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function omission(label: string, reason: OmissionReason = "unknown"): Omission {
  return {
    entityId: label.toLowerCase(),
    label,
    reason,
    evidence: reason === "unknown" ? null : `probe: evidence for ${label}`,
  };
}

console.log("\nevery reason in the closed set has approved wording");
{
  check("all ten reasons produce a notice", () => {
    // A reason with no template would silently produce no disclosure at all, which
    // would read as "nothing was omitted".
    for (const reason of OMISSION_REASONS) {
      const notice = buildOmissionNotice([omission("Dallas", reason)]);
      assert.ok(notice, `${reason} produced no notice`);
      assert.match(notice!, /Dallas/, `${reason} did not name the entity`);
    }
  });

  check("no notice for no omissions", () => {
    assert.strictEqual(buildOmissionNotice([]), null);
  });

  check("omissions with blank labels are skipped, not rendered empty", () => {
    assert.strictEqual(buildOmissionNotice([{ entityId: "", label: "  ", reason: "unknown", evidence: null }]), null);
  });
}

console.log("\nthe source/capability split holds in the wording");
{
  const SOURCE_CLAIM = /(could not be found in this source|falls outside the years|did not report data|enough reporting coverage|excluded by the definition)/;

  check("only source-attributable reasons make a claim about the data", () => {
    for (const reason of OMISSION_REASONS) {
      const notice = buildOmissionNotice([omission("Dallas", reason)])!;
      const makesSourceClaim = SOURCE_CLAIM.test(notice);
      if (reasonMayBlameSource(reason)) continue; // may, but need not
      assert.strictEqual(
        makesSourceClaim,
        false,
        `${reason} is not source-attributable but its wording blames the data: "${notice}"`,
      );
    }
  });

  check("unknown uses capability framing, never a source limitation", () => {
    const notice = buildOmissionNotice([omission("Dallas", "unknown")])!;
    assert.match(notice, /cannot currently be included through this path/);
    assert.doesNotMatch(notice, /not (?:in|present in|found in) this source/);
  });

  check("capability_path_unavailable and unknown read identically to a user", () => {
    // Deliberate: the user-visible difference between "we don't know why" and "our
    // path can't do it" is nothing, and inventing one would imply knowledge we lack.
    assert.strictEqual(
      buildOmissionNotice([omission("Dallas", "unknown")]),
      buildOmissionNotice([omission("Dallas", "capability_path_unavailable")]),
    );
  });

  check("source_unhealthy does not imply the data is missing", () => {
    const notice = buildOmissionNotice([omission("Dallas", "source_unhealthy")])!;
    assert.doesNotMatch(notice, SOURCE_CLAIM);
  });
}

console.log("\nthe notice is deterministic");
{
  check("identical omissions always produce an identical string", () => {
    // A notice that varied run to run could not be compared against a narrative at all.
    const omissions = [omission("Dallas", "not_in_source"), omission("Austin", "nonreporting_period")];
    assert.strictEqual(buildOmissionNotice(omissions), buildOmissionNotice(omissions));
  });

  check("input order does not change the output", () => {
    const a = [omission("Dallas", "not_in_source"), omission("Austin", "not_in_source")];
    const b = [omission("Austin", "not_in_source"), omission("Dallas", "not_in_source")];
    assert.strictEqual(buildOmissionNotice(a), buildOmissionNotice(b));
  });

  check("reasons are grouped into one sentence each", () => {
    const notice = buildOmissionNotice([
      omission("Dallas", "not_in_source"),
      omission("Austin", "not_in_source"),
      omission("Houston", "nonreporting_period"),
    ])!;
    assert.match(notice, /Austin and Dallas could not be found in this source\./);
    assert.match(notice, /Houston did not report data/);
  });
}

console.log("\nlong omission lists are bounded");
{
  check(`more than ${MAX_INLINE_OMISSION_LABELS} entities collapse to a count`, () => {
    // §2.4: "For large omitted sets, show a concise count and a bounded list in the
    // main response" -- an unbounded preamble is not required and would be unreadable.
    const many = Array.from({ length: 12 }, (_, i) => omission(`City${i}`, "not_in_source"));
    const notice = buildOmissionNotice(many)!;
    assert.match(notice, /and 7 others/, `expected a count, got: ${notice}`);
    assert.ok(notice.length < 200, `notice was ${notice.length} chars`);
  });

  check("a two-entity list reads naturally", () => {
    const notice = buildOmissionNotice([omission("Dallas", "not_in_source"), omission("Austin", "not_in_source")])!;
    assert.match(notice, /Austin and Dallas/);
  });

  check("a single entity gets no conjunction", () => {
    const notice = buildOmissionNotice([omission("Dallas", "not_in_source")])!;
    assert.doesNotMatch(notice, / and /);
  });
}

console.log("\ndisclosure requires the generated notice");
{
  const omissions = [omission("Dallas", "capability_path_unavailable")];
  const notice = buildOmissionNotice(omissions)!;

  check("a mere mention of the entity is NOT disclosure", () => {
    // The defect this module replaces.
    assert.strictEqual(narrativeDisclosesOmissions("Dallas had 10 murders in 2020.", omissions), false);
  });

  check("a narrative that implies the opposite is not disclosure", () => {
    assert.strictEqual(
      narrativeDisclosesOmissions("Results cover Austin, Dallas and Houston.", omissions),
      false,
      "listing the entity as included must not count as disclosing its omission",
    );
  });

  check("similar hand-written prose is not disclosure", () => {
    assert.strictEqual(
      narrativeDisclosesOmissions("Dallas is unfortunately not available here.", omissions),
      false,
      "only the generated notice qualifies",
    );
  });

  check("the generated notice IS disclosure", () => {
    assert.strictEqual(narrativeDisclosesOmissions(`Results cover Austin. ${notice}`, omissions), true);
  });

  check("whitespace and case reflow do not break it", () => {
    const reflowed = notice.replace(/ /g, "\n   ").toUpperCase();
    assert.strictEqual(narrativeDisclosesOmissions(`Results cover Austin.\n\n${reflowed}`, omissions), true);
  });

  check("a missing or empty narrative is not disclosure", () => {
    assert.strictEqual(narrativeDisclosesOmissions(null, omissions), false);
    assert.strictEqual(narrativeDisclosesOmissions(undefined, omissions), false);
    assert.strictEqual(narrativeDisclosesOmissions("", omissions), false);
  });

  check("no omissions is trivially disclosed", () => {
    assert.strictEqual(narrativeDisclosesOmissions(null, []), true);
    assert.strictEqual(narrativeDisclosesOmissions("anything", []), true);
  });

  check("disclosing SOME reasons does not disclose the others", () => {
    // Partial disclosure is still a silent drop for whatever was left out.
    const mixed = [omission("Dallas", "not_in_source"), omission("Houston", "nonreporting_period")];
    const partial = buildOmissionNotice([omission("Dallas", "not_in_source")])!;
    assert.strictEqual(narrativeDisclosesOmissions(`Results. ${partial}`, mixed), false);
    assert.strictEqual(narrativeDisclosesOmissions(`Results. ${buildOmissionNotice(mixed)!}`, mixed), true);
  });
}

console.log(`\nomission wording tests: ${passed} passed`);
if (process.exitCode) {
  console.log("omission wording tests: FAILED");
} else {
  console.log("omission wording tests: passed");
}
