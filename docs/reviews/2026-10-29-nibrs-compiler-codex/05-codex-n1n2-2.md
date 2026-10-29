**ACCEPT** — commit `5d37aca` fixes the remaining defect. Direct DuckDB execution confirmed t...
[codex] Turn completion inferred after the main thread finished and subagent work drained.
**ACCEPT** — commit `5d37aca` fixes the remaining defect.

Direct DuckDB execution confirmed the new regression: 2024 returns count `1 / VALUE`, share `1.0 / VALUE`; 2025 returns count `0 / REPORTED_ZERO`, share `null / UNAVAILABLE`.

Both existing synthetic cases, offline tests, and comparator self-tests passed. UNKNOWN and conflict propagation remain correct. No further blocking defect found; prior N1/N2 and baseline evidence remains valid. No files edited.

**Necessity check:** No further changes are needed to accept this increment. Broader capabilities and unrelated hardening remain deferred.
