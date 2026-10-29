**ACCEPT** — HEAD `9d21c9d` closes the remaining finding.

The comparator self-test passed. Positive `REPORTED_ZERO` now fails both consistency and exact-status checks; missing, extra, duplicate rows and blank `VALUE` are rejected.

Prior compiler and SQL verification remains valid; this diff changes only the gate. No files edited.

**Necessity check:** No further changes are needed for compiler v0 acceptance. Broader capabilities and certification remain deferred.
