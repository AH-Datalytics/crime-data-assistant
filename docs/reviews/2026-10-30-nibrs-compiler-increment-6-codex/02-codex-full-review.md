# Codex review 02: the increment-6 build, full review (REVISE)

Branch nibrs-engine/compiler-increment-6 at 8432741, diff from 82ac68d (dev after increment 5). Reviewed 2026-10-30,
read-only; test-nibrs-compile, test-nibrs-shadow and test-nibrs-plan-language pass. Nothing found that touches a live
route.

1. P2, answer.ts:256: a property condition was dropped by the Historical route ("Robbery clearance rate in Atlanta in
   2023 where a firearm was stolen" routed to the plain rate). Check the restriction flags before routing.
2. P2, reading.ts:235: "car" became every vehicle description (03, 05, 24, 28, 37). Keep an automobile selection (03)
   or decline the wording.
3. P2, compare.ts:352: the own-share shortcut accepted any denominator starting with "all" ("all robbery offenses"
   against a shoplifting share). Match the denominator's measure and unit; leave other wording unverified.

Applied (this commit): (1) the route takes only the plain rate (no property, clearance, through-incident, cohort,
composite, breakdown, filter or share); (2) "car" is description 03, named "a car"; the scorer reads "car" too; (3) the
shortcut requires "all <the label's measure> <its unit> in the period". Each with a regression in test-nibrs-shadow.
