# Stage 2B: response-completeness audit

What each question actually asks, and proof that the interface can represent every answer a policy
owner might reasonably give. Written because a control that cannot express a real position does not
merely inconvenience someone — it silently records a different decision from the one they hold. The
trust question did exactly that: a row of checkboxes could not say "warn but still answer", could
not say "this genuinely needs nothing", and could not tell either of those from "nobody has looked
at it yet", because all three were an untouched box.

Nothing here is added speculatively to satisfy a test. Each entry states the real decision first,
then the responses offered, then why they cover it.

---

## 1. Can someone reasonably ask this question for a particular year?

**The real decision.** Should the chatbot turn down a request for a year this data does not go back
to, or answer without looking at the year at all? This is a judgment about the subject matter — is
this a figure reported year by year, or a standing list?

| Position | Offered as | Result |
|---|---|---|
| Year matters | `years` | Refuse years outside the first and last available. Does not detect a year missing inside the range, and says so. |
| Not about a year | `no-years` | No year check runs. Recorded as a decision, with no justification demanded. |
| Undecided | `unsure` | Unfinished. Nothing enabled. |

- **Something else:** not applicable. The question is genuinely binary — either a year is a sensible
  thing to ask about or it is not. There is no third substantive position.
- **Not applicable / no special handling:** `no-years` **is** that position, stated positively.
- **I'm not sure:** offered, and leaves the question unanswered rather than defaulting.
- **Engineering follow-up:** yes, and this is the case that most needed one. A person may correctly
  say a year matters while the answer reads nothing dated (2 of 52), or reads several with none
  reviewed (23 of 52). Their judgment is recorded; settling what to read is engineering's, is named
  as such, and no policy is derived meanwhile. **The person is never asked to choose a field.**

**Coverage claim.** Complete. The one thing a person cannot express here is *which* dated field
bounds the answer — deliberately, because that is not a judgment about crime data.

---

## 2. What should the chatbot do if one of these problems is detected?

**The real decision.** For each problem worth worrying about in this data, what should happen when
it occurs? This is the policy itself, not a report of concern.

Asked once **per listed problem**, from the reviewed catalog, plus one the person may describe.

| Position | Offered as | Result |
|---|---|---|
| Stop | `refuse` | Recorded as a rule: do not answer when this is detected. |
| Answer, but say so | `warn` | Recorded exactly as chosen. Cannot be carried out yet → engineering follow-up. |
| This needs nothing | `none` | Recorded as a decision. Cannot be represented explicitly yet → engineering follow-up. |
| Undecided | `unsure` | Unfinished. Nothing enabled. |

- **Something else:** yes — "Another problem not listed", free text, which then takes one of the same
  four responses. A described problem without a response is an unfinished item, not a note.
- **Not applicable / no special handling:** `none`, stated positively and distinguishable in the
  answer, in the counters and on the page from an untouched control.
- **I'm not sure:** per problem, and one anywhere leaves the whole section unfinished.
- **Engineering follow-up:** yes, for `warn` and for `none`. Only `refuse` can be expressed by the
  technical policy today, and even that authorizes nothing because no integrity rule is executable.
  **Neither `warn` nor `none` is collapsed into a refusal rule** — writing a refusal for someone who
  asked for a warning would record the opposite of what they said.

**Coverage claim.** Complete for the four responses a governance owner can hold. Absent by design:
per-problem severity, thresholds, and "warn only above N occurrences" — none can be expressed by any
part of the system, and offering them would collect intent that nothing could ever honour.

---

## 3. If this data is missing, does that mean something is broken?

**The real decision.** When this data is not there at all, is that a fault to raise or an expected
state to report plainly?

| Position | Offered as | Result |
|---|---|---|
| Should be there | `always` | Absence treated as a problem needing attention. |
| Legitimately absent sometimes | `sometimes` + when | Chatbot says the answer is unavailable rather than reporting a fault. |
| Undecided | `unsure` | Unfinished. Nothing enabled. |

- **Something else:** the free-text *when* carries it. The condition is the person's own words.
- **Not applicable:** `always` is the positive form of "nothing special applies here".
- **I'm not sure:** offered.
- **Engineering follow-up:** not needed. Both positions are fully representable today
  (`{kind:"always"}` / `{kind:"conditional", condition}`).

**Coverage claim.** Complete. The one omission is *partial* absence — "present but thin" — which is
a different question from this one and is not asked here rather than being half-asked.

---

## 4. Who should be contacted if this data is missing or out of date?

**The real decision.** Who does someone go to. An accountability fact, not a technical owner field.

| Position | Offered as | Result |
|---|---|---|
| A named update process | one of the plausible processes for this answer | Recorded as the thing to investigate. |
| Someone or something else | `other` + free text | Recorded verbatim. |
| Undecided | `unsure` | Unfinished. Nothing enabled. |

- **Something else:** yes, free text, so no list can trap anyone.
- **Not applicable:** **this is the known gap.** There is no positive way to say *nobody here — the
  agencies are responsible for submitting their data, not us*, which is a real and probably common
  answer. Today it must be typed into "Something else", where it is stored as though it named a
  contact. Recorded as a known incompleteness rather than papered over; a `not-ours` position is the
  obvious addition and was not made here because it is outside the requested change.
- **I'm not sure:** offered.
- **Engineering follow-up:** not needed; a named owner is representable today.

**Coverage claim.** Incomplete in one identified way, stated above.

---

## Notes for future reviewers (not a question)

Optional. Empty blocks nothing — not completion, not confirmation, not import, not eligibility. It
replaced *"How do you know these answers are right?"*, which demanded that the policy owner prove
their own judgment to an authority that does not exist. Nothing is ever synthesised into it: no
"verified", no "confirmed with", no restatement of the person's choices dressed up as a citation.

## Standing property

None of these answers can switch anything on. Authorization additionally requires an integrity rule
something can execute, and `integrityIsExecutable` returns false by construction, so every
combination of answers above yields zero authorization-eligible capabilities.
