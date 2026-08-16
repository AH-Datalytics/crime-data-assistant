# Stage 2B decision-readiness audit

## Verdict

There are **no decision-ready human policy questions in the current 52-capability workbook**.

The workbook should not be used for interviews or confirmations yet. Its four repeated prompts ask a person to decide matters that are either facts engineering must establish or behavior already fixed by the verified-answer-only contract.

## Evidence

| Product source | Capabilities checked | Carry a year | Do not carry a year | Integrity tags awaiting executable definitions | Human choices ready now |
|---|---:|---:|---:|---:|---:|
| Current Trends | 7 | 3 | 4 | 18 | 0 |
| Historical Library | 9 | 5 | 4 | 24 | 0 |
| Hate Crime | 4 | 1 | 3 | 9 | 0 |
| NIBRS | 27 | 23 | 4 | 77 | 0 |
| Homicide Reports | 5 | 2 | 3 | 12 | 0 |
| **Total** | **52** | **34** | **18** | **140** | **0** |

Every catalogued capability appears in exactly one row. The companion test compares these totals with the live catalog and the 51 operation-backed registry entries plus the one sweep-only capability.

## What the four prompts really are

| Workbook prompt | Classification | What must happen next |
|---|---|---|
| Does the answer carry a year? | Structural engineering fact | Bind each capability to its real table and year column, or record that it has no year dimension. Do not ask a person to choose this. |
| What if data silently drops, disagrees, or becomes stale? | Undefined engineering check | Replace each of the 140 scenario tags with an executable check and a named observable boundary. Until then the failure cannot be detected reliably. |
| Is the capability always available? | Source and build fact | Distinguish “the named source does not contain this” from “our copy, mapping, or build lost it.” The latter is an internal failure, not an empty result. |
| Who is responsible? | Runbook fact | Connect the seven existing build/import routes to actual monitoring and escalation ownership. A contact sentence is not executable ownership. |

## Behavior is already determined

The proof contract requires a healthy source, a known data version, passing requested coverage, and passing proof checks before a factual answer is permitted. An unknown or failed condition blocks factual delivery. The specified enforced outcome is a capability decline; it must not be independently changed to “warn” or “no special handling” on each card.

That does not mean all failures should look identical to the user. Engineering still needs to identify the cause so the product can truthfully say whether the source lacks the requested data or the product could not establish the answer. Wording comes after that distinction is observable.

## The “97 questions” correction

There were never 97 human policy questions. The earlier total combined 23 year-carrying tables, one shared no-year rule, 33 artifact/table owner pairs, and 40 emitted-table integrity sets. That arithmetic described database structure and unfinished engineering work. Availability was not even included. The number should be retired rather than converted into an interview.

## Next engineering gate

For each capability, engineering must supply:

1. a bound coverage basis;
2. executable integrity checks rather than scenario prose;
3. a reliable distinction between source absence and local failure; and
4. an operational owner or automated recovery route.

Only after those exist should the residue be reviewed for a genuine tradeoff: one concrete, observable situation with at least two safe and implementable responses. If no such residue remains, Stage 2B requires no policy interview at all.
