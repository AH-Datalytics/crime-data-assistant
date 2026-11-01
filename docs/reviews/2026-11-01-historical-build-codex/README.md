# Codex reviews: Historical increment (agencies from the Crime Index build), 2026-11-01

## 01, full review: REVISE (six P2s), all fixed with tests
1. "Robbery victims" was answered as the file's robbery offenses. Now declined plainly, with NIBRS offered (`historicalUnitFits`).
2. "Combined" agencies were answered as separate rows. Now declined, with the side-by-side question offered.
3. A clearance span reaching before 1960 was answered for the year it covered. Now declined: clearances are one agency and one year.
4. The build cast lossy values ("0.4" became 0, "1,234" became NULL). Every non-blank cell must now be exactly its type's number, or the build stops.
5. The --out check was a case-sensitive prefix. It is now component-wise and case-folded.
6. The scorer didn't check a one-figure sentence's number against the table. It does now.

## 02, confirmation: REVISE (one P2), fixed
- The sentence check still accepted "351,000" or "351.9" for 351. Nothing numeric may continue the number now.

Also caught by the scored run, not Codex: the unit decline (fix 1) caught arrests and offenders, which are NIBRS's own counts. It now applies to victims and offenses only, with a regression test.

Per review discipline, one full review and one confirmation; further P3 edge cases are known limits.
