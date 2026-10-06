"""Source-state predicate for the server-side rollup refresh.

A Python port of the accepted laptop guard (O3, scripts/nibrs-source-state.ps1), so the VPS does
not need PowerShell. The semantics are kept:

  * the configured source alias is resolved to one canonical file, and every check reads that file;
  * rollback journals and WAL files are inspected beside BOTH the alias (when it is a symlink) and
    the canonical file; an absent journal is settled, a journal that cannot be inspected is an
    error and never a zero;
  * device:inode pins the object, and the alias size must equal the canonical size;
  * the source's actual size:mtime_ns must equal the published generation marker, so a same-size
    write that was not republished is refused;
  * the identity is compared again immediately before the candidate check and before activation.

One policy condition differs by design. The laptop payload refused whenever nibrs-auto-update.py
was running. Here the refresh normally runs INSIDE that updater, so the condition is replaced by
proof of ownership: the maintenance lock is held by the expected attempt at the expected phase
(see nibrs_maintenance_lock.py), and no OTHER updater process is running.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path


class SourceStateError(RuntimeError):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}{': ' + detail if detail else ''}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class SourceState:
    generation: str
    source_bytes: int
    mtime_ns: int
    canonical: str
    identity: str
    active_target: str
    active_generation: str


def _read_marker(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise SourceStateError("GENERATION_MARKER_MISSING", str(path)) from None
    except OSError as exc:
        raise SourceStateError("GENERATION_MARKER_UNREADABLE", f"{path}: {exc}") from None
    value = text.replace("\r", "").replace("\n", "")
    if not value:
        raise SourceStateError("GENERATION_MARKER_MISSING", f"{path} is empty")
    return value


def other_updaters(exclude_pids: set[int], proc: Path = Path("/proc"), budget_seconds: float = 30.0) -> list[int]:
    """PIDs whose command line runs nibrs-auto-update.py, other than the excluded ones.

    A process that exits during the scan is skipped. Any other inspection failure is an error,
    because "could not look" is not "nothing running".
    """
    found = []
    try:
        entries = list(proc.iterdir())
    except OSError as exc:
        raise SourceStateError("UPDATER_PROBE_FAILED", str(exc)) from None
    deadline = time.monotonic() + budget_seconds
    for entry in entries:
        if time.monotonic() > deadline:
            raise SourceStateError("UPDATER_PROBE_FAILED", f"scan exceeded {budget_seconds}s")
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid in exclude_pids:
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes()
        except FileNotFoundError:
            continue
        except ProcessLookupError:
            continue
        except PermissionError as exc:
            raise SourceStateError("UPDATER_PROBE_FAILED", f"{entry}: {exc}") from None
        except OSError as exc:
            raise SourceStateError("UPDATER_PROBE_FAILED", f"{entry}: {exc}") from None
        if b"nibrs-auto-update.py" in cmdline:
            found.append(pid)
    return sorted(found)


def _journal_size(path: Path) -> int | None:
    """None when absent; size when inspectable; raises on anything else."""
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise SourceStateError("JOURNAL_UNREADABLE", f"{path}: {exc}") from None
    if not os.access(path, os.R_OK):
        raise SourceStateError("JOURNAL_UNREADABLE", f"{path}: not readable")
    return st.st_size


def inspect(source_alias: str, shared_dir: str, rollup_link: str) -> SourceState:
    """Gate-mode inspection. Raises SourceStateError naming the first refused condition."""
    alias = Path(source_alias)
    marker = Path(shared_dir) / "nibrs_source.generation"
    generation = _read_marker(marker)

    if not os.path.lexists(alias):
        raise SourceStateError("SOURCE_RESOLUTION_FAILED", str(alias))
    try:
        canonical = Path(os.path.realpath(alias, strict=True))
    except OSError:
        if os.path.islink(alias):
            raise SourceStateError("SOURCE_TARGET_MISSING", str(alias)) from None
        raise SourceStateError("SOURCE_RESOLUTION_FAILED", str(alias)) from None
    if not os.access(canonical, os.R_OK):
        raise SourceStateError("SOURCE_UNREADABLE", str(canonical))

    probes = [canonical]
    if alias.is_symlink():
        probes.insert(0, alias)
    for probe in probes:
        for suffix in ("-wal", "-journal"):
            journal = Path(str(probe) + suffix)
            size = _journal_size(journal)
            if size:
                raise SourceStateError("WAL_NOT_EMPTY", f"{journal}:{size}")

    try:
        st = os.stat(canonical)
        alias_st = os.stat(alias)
    except OSError as exc:
        raise SourceStateError("SOURCE_STAT_FAILED", str(exc)) from None
    if alias_st.st_size != st.st_size:
        raise SourceStateError("SOURCE_IDENTITY_AMBIGUOUS", f"{alias_st.st_size}:{st.st_size}")

    actual = f"{st.st_size}:{st.st_mtime_ns}"
    if actual != generation:
        raise SourceStateError("GENERATION_STALE", f"{actual}:{generation}")

    active_target = ""
    active_generation = ""
    try:
        active_target = os.path.realpath(rollup_link, strict=True)
    except OSError:
        active_target = ""
    if active_target:
        try:
            active_generation = _read_marker(Path(active_target + ".generation"))
        except SourceStateError:
            active_generation = ""

    return SourceState(
        generation=generation,
        source_bytes=st.st_size,
        mtime_ns=st.st_mtime_ns,
        canonical=str(canonical),
        identity=f"{st.st_dev}:{st.st_ino}",
        active_target=active_target,
        active_generation=active_generation,
    )


def assert_unchanged(before: SourceState, after: SourceState, stage: str) -> None:
    changes = []
    for field in ("generation", "source_bytes", "mtime_ns", "canonical", "identity"):
        if getattr(before, field) != getattr(after, field):
            changes.append(f"{field} {getattr(before, field)} -> {getattr(after, field)}")
    if changes:
        raise SourceStateError("SOURCE_CHANGED", f"during {stage}: {'; '.join(changes)}")
