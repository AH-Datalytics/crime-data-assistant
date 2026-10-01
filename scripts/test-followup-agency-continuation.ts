/*
 * Can a follow-up walk around the multi-agency ownership restriction?
 *
 * The gap, from the September 14 capture: GC-073's 36-city request was refused (log 918,
 * `nibrs-unowned-multi-agency-stopped`, 0 rows). One turn later "now do it for 2024" returned 35
 * agencies from the model path with no attribution (log 919). The restriction reads the plan
 * resolved for the CURRENT turn, and that turn names no place.
 *
 * The danger in fixing it is over-correction, so most of this file is about what must NOT inherit.
 * A place-free question is not automatically a continuation: a nationwide request, a state-level
 * request, a different topic, a later single-agency question, or a detour to another source all end
 * the chain. Each is asserted here, because a restriction that fires on a valid new question is a
 * worse defect than the one it fixes.
 */
import {
  inheritedMultiAgencyRequest,
  isTemporalContinuation,
} from "../lib/followup-agency-continuation";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) console.log(`  PASS  ${message}`);
  else { failures += 1; console.log(`  FAIL  ${message}`); }
}

// History as the CLIENT sends it: role, content and a source tag. The helper does its own bounded,
// source-aware normalisation, so these are raw rather than pre-filtered — which is the point of R2.
type Entry = { role: "user" | "assistant"; content: string; source?: string };
const user = (content: string, source = "nibrs"): Entry => ({ role: "user", content, source });
const bot = (content: string, source = "nibrs"): Entry => ({ role: "assistant", content, source });
/** An older client that sends no source tags at all. */
const legacyUser = (content: string): Entry => ({ role: "user", content });

// GC-073's actual setup question, as the user wrote it.
const GC073_SETUP = "Give me the number of murder clearances broken down by type for these cities in 2025: "
  + "Chicago, IL New York, NY Houston, TX Los Angeles, CA Philadelphia, PA Memphis, TN Detroit, MI "
  + "Baltimore, MD Dallas, TX Washington, DC Indianapolis, IN St. Louis, MO Louisville, KY "
  + "Kansas City, MO Phoenix, AZ Milwaukee, WI San Antonio, TX Birmingham, AL Columbus, OH "
  + "Charlotte, NC Cleveland, OH Las Vegas, NV Albuquerque, NM Nashville, TN Atlanta, GA Oakland, CA "
  + "Minneapolis, MN Fort Worth, TX Oklahoma City, OK Denver, CO Cincinnati, OH Portland, OR "
  + "Austin, TX Richmond, VA Seattle, WA Stockton, CA";
// The refusal the restriction produced, which carries no SQL — the reason the query-bearing
// follow-up detector never sees this sequence.
const GC073_REFUSAL = "You asked about more than one agency. I can only give figures for several "
  + "agencies at once when I can build that comparison myself and confirm which agency each number "
  + "belongs to, and I can't do that for this request — so rather than show figures I can't "
  + "attribute, I've stopped.";

console.log("\n1 - the captured GC-073 sequence, which is why this exists");
{
  const inherited = inheritedMultiAgencyRequest("now do it for 2024", [user(GC073_SETUP), bot(GC073_REFUSAL)], "nibrs");
  check(Boolean(inherited), "'now do it for 2024' after a refused 36-city request inherits the restriction");
  check((inherited?.places ?? 0) >= 2, `and it carries the multi-agency scope (${inherited?.places ?? 0} requested local members)`);
  check(inherited?.turnsBack === 1, "from the immediately preceding user turn");
  // The preceding answer was a refusal with no SQL. Inheritance must not depend on a successful
  // prior query, which is exactly what the existing query-bearing detector requires.
  check(
    Boolean(inheritedMultiAgencyRequest("now do it for 2024", [user(GC073_SETUP)], "nibrs")),
    "and it does not depend on the assistant's reply at all, successful or otherwise",
  );
}

console.log("\n2 - a second temporal continuation after the refusal");
{
  const history = [user(GC073_SETUP), bot(GC073_REFUSAL), user("now do it for 2024"), bot(GC073_REFUSAL)];
  const inherited = inheritedMultiAgencyRequest("what about 2023", history, "nibrs");
  check(Boolean(inherited), "'what about 2023' two turns later still inherits");
  check(inherited?.turnsBack === 2, "the chain passes through the intervening continuation rather than stopping at it");
}

console.log("\n3 - requested AGENCIES, not named geographies");
{
  // R1. The place resolver keeps only city, agency and campus when it builds requested members
  // (nibrs-place-resolver.ts:512). Counting every named geography made a state into an agency, so a
  // single-city request inherited a multi-agency restriction it never made.
  const cityPlusState = [user("murders in Baltimore in Maryland in 2025"), bot("Here are the figures.")];
  check(
    inheritedMultiAgencyRequest("now do it for 2024", cityPlusState, "nibrs") === null,
    "one city named inside its state is ONE requested agency, so its continuation does not inherit",
  );
  const twoStates = [user("compare Texas and California in 2025"), bot("Here are the figures.")];
  check(
    inheritedMultiAgencyRequest("now do it for 2024", twoStates, "nibrs") === null,
    "two states are zero requested agencies, so their continuation does not inherit either",
  );
  // ...and the true multi-local counterpart still must.
  const twoCities = [user("compare murders in Chicago, IL and Detroit, MI in 2025"), bot(GC073_REFUSAL)];
  const inherited = inheritedMultiAgencyRequest("now do it for 2024", twoCities, "nibrs");
  check(Boolean(inherited), "two actual cities still inherit, so the narrower count has not disabled the protection");
  check((inherited?.places ?? 0) >= 2, `and are counted as requested agencies (${inherited?.places ?? 0})`);
}

console.log("\n4 - what must NOT inherit: the over-correction controls");
{
  const base = [user(GC073_SETUP), bot(GC073_REFUSAL)];
  check(
    inheritedMultiAgencyRequest("murders nationwide in 2024", base, "nibrs") === null,
    "an explicit nationwide request does not inherit a stale multi-city restriction",
  );
  check(
    inheritedMultiAgencyRequest("show me murders in Chicago for 2024", base, "nibrs") === null,
    "a replacement single city does not inherit",
  );
  check(
    inheritedMultiAgencyRequest("how does this data work?", base, "nibrs") === null,
    "a new topic with no place does not inherit, because it is not a temporal continuation",
  );
  check(
    inheritedMultiAgencyRequest("what offenses are available?", base, "nibrs") === null,
    "nor does a capability question",
  );
  const moved = [
    user(GC073_SETUP), bot(GC073_REFUSAL),
    user("show me murders in Baltimore, MD for 2025"), bot("Here are the figures."),
  ];
  check(
    inheritedMultiAgencyRequest("now do it for 2024", moved, "nibrs") === null,
    "an intervening single-agency request ends the chain, so the later continuation does not resurrect the old group",
  );
  check(
    inheritedMultiAgencyRequest("Add 2026", [user("NYPD shoplifting per month"), bot("Here are the figures.")], "nibrs") === null,
    "GC-049's 'Add 2026' after a single-agency request does not inherit",
  );
  check(
    inheritedMultiAgencyRequest("now do it for 2024", [user("murders nationwide 2025")], "nibrs") === null,
    "a nationwide setup does not make its continuation a multi-agency request",
  );
  check(inheritedMultiAgencyRequest("now do it for 2024", [], "nibrs") === null, "absent history inherits nothing");
  check(inheritedMultiAgencyRequest("now do it for 2024", null, "nibrs") === null, "null history inherits nothing");
  check(
    inheritedMultiAgencyRequest("now do it for 2024", [bot(GC073_REFUSAL)], "nibrs") === null,
    "history truncated to the assistant's reply alone inherits nothing — an answer is not authority",
  );
}

console.log("\n5 - the temporal-continuation predicate itself");
{
  for (const q of ["now do it for 2024", "same for 2023", "what about 2022", "do it for 2020-2024", "for 2024", "and now for 2019?"]) {
    check(isTemporalContinuation(q), `recognised: "${q}"`);
  }
  for (const q of [
    "murders nationwide in 2024",
    "show me Chicago for 2024",
    "how does this data work?",
    "compare Chicago and Detroit for 2024",
    "give me the number of murder clearances broken down by type for these cities in 2024: Chicago, IL New York, NY",
  ]) {
    check(!isTemporalContinuation(q), `not a bare period change: "${q}"`);
  }
}

console.log("\n6 - a source change the route's own filtering would have erased");
{
  // R2. normalizeHistoryForTab DELETES other-source turns, leaving the older NIBRS turns adjacent —
  // so an intervening question about another database looks like it never happened. Reading the
  // source-tagged history instead keeps the boundary the filtering removes.
  const mixed = [
    user("murders in Chicago, IL and Detroit, MI in 2025"), bot(GC073_REFUSAL),
    user("murders in Baltimore, MD in 2025", "shr"), bot("Here are the SHR figures.", "shr"),
  ];
  check(
    inheritedMultiAgencyRequest("now do it for 2024", mixed, "nibrs") === null,
    "an intervening question about another source ends the chain, so the older group is not resurrected",
  );
  const unbroken = [user("murders in Chicago, IL and Detroit, MI in 2025"), bot(GC073_REFUSAL)];
  check(
    Boolean(inheritedMultiAgencyRequest("now do it for 2024", unbroken, "nibrs")),
    "while an unbroken same-source chain still inherits, so the boundary is not simply refusing everything",
  );
  // Older clients send no tags; they must behave exactly as before rather than start refusing.
  const legacy = [legacyUser("murders in Chicago, IL and Detroit, MI in 2025"), bot(GC073_REFUSAL)];
  check(
    Boolean(inheritedMultiAgencyRequest("now do it for 2024", legacy, "nibrs")),
    "untagged legacy history is treated as same-source, preserving existing behaviour",
  );
}

console.log("\n7 - both corrections are load-bearing, shown against their opposites");
{
  // Pre-R1: every named geography counted as a requested agency. The shipped count refuses where the
  // old one would have inherited.
  check(
    inheritedMultiAgencyRequest("now do it for 2024", [user("murders in Baltimore in Maryland in 2025")], "nibrs") === null,
    "the local-member filter is what stops 'Baltimore in Maryland' (1 city + 1 state) inheriting",
  );
  // Pre-R2: history already filtered to this tab, with the other-source turns deleted. Those exact
  // same turns, minus their tags, DO reconnect the chain — which is the failure the tags prevent.
  const asFilteredByTab = [user("murders in Chicago, IL and Detroit, MI in 2025"), bot(GC073_REFUSAL)];
  check(
    Boolean(inheritedMultiAgencyRequest("now do it for 2024", asFilteredByTab, "nibrs")),
    "with the other-source turns already deleted the chain reconnects and inherits",
  );
  check(
    inheritedMultiAgencyRequest("now do it for 2024", [
      user("murders in Chicago, IL and Detroit, MI in 2025"), bot(GC073_REFUSAL),
      user("murders in Baltimore, MD in 2025", "shr"), bot("figures", "shr"),
    ], "nibrs") === null,
    "...and refuses once the same turns carry their source tags, so reading raw tagged history is what prevents it",
  );
}

console.log(`\nfollow-up agency continuation: ${checks - failures} passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
