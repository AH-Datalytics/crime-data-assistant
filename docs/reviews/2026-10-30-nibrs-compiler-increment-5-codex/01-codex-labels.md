# Codex review 01: increment-5 held-out labels, before the build (two passes)

Reviewed 2026-10-30 against docs/policy (P01, P03, P14, P18, P31, P52, P53, P54, P57, P61, P62, P63, D04, D18, D22,
D30) and the plan (increment-5-draft-cases.md r2). No files changed by Codex.

Pass 1 (f342e60, LS-334..LS-351): 13 ACCEPT, 5 FIX.
- LS-338: violent crime counted the FBI way ("victim (robbery by offense)", as LS-188).
- LS-345: P61's full disclaimer, an explicit button, one fixed 84-month cohort after the click.
- LS-348: the current-source caveat; through the latest reported month (P52); P63 cited.
- LS-349: the Homicide Reports coverage caveat; P63 cited.
- LS-351: name the full range (1960-2025); P53 cited.
Missing: a P61 button continuation (written into LS-341 and LS-345); a partly covered historical span (LS-352); a
historical property aggregate (LS-353); a state gun-violence refusal (LS-354).

Pass 2 (2311f1a): 8 ACCEPT, 1 FIX (LS-352: name both ends of the range, D04), applied. No separate button case is
needed; when verified, the button must be clicked and its answer checked.

Scorer caveats for later: "not a re-added sum" needs source provenance, not equal numbers; coverage must follow D22
(month by month); routing cases (LS-348, LS-349) verify the route only.

21 labels frozen (LS-334..LS-354). The state NIBRS rate case is held for Jeff's decision on P62 and gets its own check.

Pass 3 (b76169b): LS-355, "Carjacking rate in Texas in 2024", after Jeff clarified P62 ("state rates in nibrs are
relative to the sum of reporting agencies"): ACCEPT. The all-months sum over the summed FBI populations of every
reporting agency, partial reporters disclosed (P61), the every-month button, P63's source line; P58 is for agency rates.
22 labels frozen (LS-334..LS-355).
