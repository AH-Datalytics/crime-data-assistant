**ACCEPT.** (Codex re-review of `021feab..dc56148`, read-only.) All seven required fixes satisfied; no new blocking defect.

1. Cross-segment joins: incident keys between families, occurrence only parent to child (BUILD-RULES T1). The three ZZ
   fixtures executed in memory: 2 offenders sharing `##`; robbery by offender sex M 1, F 1; victim occurrence 2 with a
   handgun on offense occurrence 1: 1 victim.
2. P49: only the "by men and women" parts' filters removed; the "Female ... by men and women" case declines; handgun
   restrictions before and after the phrase kept, remapped to `filters[0]`, disclosed; a race restriction declines
   rather than being dropped; "by men and men" rejected.
3. D19 beside another crime declines; standalone drug crimes 2,797 + 2,213 = 5,010 agree with V51.
4. Composite guard (measure ids and part count) declines gun crimes + murders, stabbings + murders, robbery and reversed
   orders; LS-295, LS-296 match their fixtures, the stabbings total withheld when a component is unknown.
5. Weapon and relationship selections named ("with a weapon recorded as Handgun"); unnamed restrictions decline before
   execution; the property path for carjacking unchanged.
6. Category adapter: declared field, five batch-5 fields, aliases, overlapping categories never summed; V50-V68 at
   nibrs-model `684c274` inspected; carjacking matcher unique on V52; missing or ambiguous matches stay unverified.
7. Combined total parsed and compared exactly: 252/2520 and 21/210 regressions fail as they should.

Necessity check: no further change needed to accept this increment. Deferred: two-way LS-282/LS-294, older reader
limitations, broader scorer hardening.
