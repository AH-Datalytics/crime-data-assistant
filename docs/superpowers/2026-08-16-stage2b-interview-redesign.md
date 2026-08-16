# Stage 2B decision readiness

The pilot did not reveal a wording problem. It revealed that no human decision is ready.

The former interview combined source absence, local data loss, undefined detectors, time
applicability, and operational routing into one capability card. The reader could not explain the
card because it did not correspond to one coherent decision.

For the two pilot examples, the safe response follows once engineering identifies the cause:

| Verified cause | Safe response |
|---|---|
| The named product source lacks the requested data | Say that the named source has no data for the request. |
| The source has the data but our copy, mapping, or update lost it | Do not present an empty result as truth; raise the internal failure. |
| The cause is unknown | Make the cause observable before asking for policy. |

Those are not tradeoffs for a policy owner. Year applicability, the controlling dated field, the
detector definition, and the local investigation route are engineering facts as well.

Stage 2B should therefore stop generating capability cards. Engineering should first produce a
short list of concrete situations where two or more safe, implementable responses remain possible.
Only those situations should become human questions. Each question must fit in one sentence and use
the exact product-visible source name: **Current Trends**, **Historical Library**, **NIBRS**,
**Homicide Reports**, or **Hate Crime**. Descriptive aliases such as “recent-trends” are not names.

Until such a tradeoff is identified, the honest count of human decisions is zero.
