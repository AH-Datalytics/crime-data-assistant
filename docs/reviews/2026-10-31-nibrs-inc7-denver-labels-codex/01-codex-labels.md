# Codex review 01: discriminating people cases (LS-397..LS-402) and increment 6's drafted cases (LS-374..LS-376)

Reviewed 2026-10-31, read-only, no network. Verdict: **REVISE** one value contract (LS-376); **ACCEPT** the other eight. Applied, and all nine are frozen.

Why these cases: Codex increment-7 review 04 (a) found that the Memphis 2024 cases cannot tell P49 (the incident's offenders) from P65 (the offenders linked to the victim), because in Memphis every victim is linked to every offender.
- LS-397..LS-400, Denver 2023 aggravated assault: nibrs-model reports 263 against 254 for offenders under 18, and 13 victims with a different linked race set.
- LS-401 and LS-402, Rochester (NY) 2024 murder: nibrs-model's search over every agency, 2017-2025, ranked it first (6 of 46 victims differ).
- LS-374..LS-376: increment 6's drafted cases, never label-reviewed until now.

| Case | Verdict |
|---|---|
| LS-374 Detroit 2024 aggravated assaults by clearance type | ACCEPT |
| LS-375 Denver 2023 by clearance type (P67 ties) | ACCEPT |
| LS-376 Charlotte 2024 vehicle burglaries where a firearm was stolen (negative control) | REVISE: the value contract must name the cross-segment trap. Applied in Codex's exact wording: offenses in incidents with stolen non-firearm property and a recovered firearm, but no stolen firearm, are excluded; give the exclusion count and the contrast with matching the conditions independently across segments (as LS-364). |
| LS-397 Denver, by offender race (P49) | ACCEPT |
| LS-398 Denver, by the race of the linked offender (P65) | ACCEPT. "According to NIBRS" is not needed (P01 already routes the detail to NIBRS) and is harmless; kept. |
| LS-399 Denver, by juveniles (P49) | ACCEPT |
| LS-400 Denver, victims of offenders under 18 (P65) | ACCEPT |
| LS-401 Rochester murder, by offender race (P49) | ACCEPT. The explicit source is needed (homicide detail would route to Homicide Reports); "Rochester, New York" settles P28. |
| LS-402 Rochester murder, by the race of the linked offender (P65) | ACCEPT |

Codex did not recompute the pending numbers (263 vs 254, 13, 6 of 46): that is the value build's job.
