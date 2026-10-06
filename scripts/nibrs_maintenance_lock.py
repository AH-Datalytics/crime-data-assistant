"""One maintenance-ownership lock for every program that writes the NIBRS source.

The monthly updater holds it from before it stops the app until after it restarts it. The
server-side rollup refresh it launches inherits the same open lock (an inherited descriptor shares
the lock), so the build runs inside the owner's interval instead of competing with it. A standalone
operator run of the refresh, and the coverage scripts, take it themselves. A program that does not
take this lock is not excluded by it; such writers are named and coordinated in the runbook rather
than assumed away.

The owner record next to the lock names the holder (pid, program, attempt, phase). It is written
atomically and only by the holder. It is an accident-prevention and evidence mechanism for one host,
not a security boundary against root.
"""

from __future__ import annotations

import errno
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

try:
    import fcntl
except ImportError:  # Windows developer machines: the lock exists only on the Linux server
    fcntl = None

DEFAULT_LOCK_PATH = "/opt/nibrs/maintenance.lock"
FD_ENV = "NIBRS_MAINTENANCE_LOCK_FD"
ATTEMPT_ENV = "NIBRS_MAINTENANCE_ATTEMPT"


class LockError(RuntimeError):
    pass


def lock_path() -> Path:
    return Path(os.environ.get("NIBRS_MAINTENANCE_LOCK", DEFAULT_LOCK_PATH))


def owner_path(path: Path | None = None) -> Path:
    path = path or lock_path()
    return path.with_name(path.name + ".owner.json")


@dataclass
class Holding:
    fd: int
    path: Path
    attempt_id: str
    program: str

    def set_phase(self, phase: str, **extra) -> None:
        write_owner(self.path, self.attempt_id, self.program, phase, **extra)

    def release(self) -> None:
        try:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
        finally:
            os.close(self.fd)


def write_owner(path: Path, attempt_id: str, program: str, phase: str, **extra) -> None:
    record = {
        "pid": os.getpid(),
        "program": program,
        "attempt_id": attempt_id,
        "phase": phase,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **extra,
    }
    target = owner_path(path)
    tmp = target.with_name(f"{target.name}.tmp.{os.getpid()}")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(record, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, target)


def read_owner(path: Path | None = None) -> dict:
    target = owner_path(path or lock_path())
    try:
        with open(target, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        raise LockError(f"no owner record at {target}") from None
    except (OSError, ValueError) as exc:
        raise LockError(f"owner record unreadable at {target}: {exc}") from None


def acquire(program: str, attempt_id: str, wait_seconds: float = 0, path: Path | None = None,
            poll: float = 5.0) -> Holding:
    """Take the lock exclusively, waiting up to wait_seconds. Raises LockError when not obtained."""
    if fcntl is None:
        raise LockError("file locking is unavailable on this platform")
    path = path or lock_path()
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    deadline = time.monotonic() + max(0.0, wait_seconds)
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError as exc:
            if exc.errno not in (errno.EWOULDBLOCK, errno.EAGAIN):
                os.close(fd)
                raise LockError(f"cannot lock {path}: {exc}") from None
            if time.monotonic() >= deadline:
                holder = "unknown holder"
                try:
                    holder = json.dumps(read_owner(path))
                except LockError:
                    pass
                os.close(fd)
                raise LockError(f"maintenance lock {path} is held ({holder})") from None
            time.sleep(min(poll, max(0.05, deadline - time.monotonic())))
    holding = Holding(fd=fd, path=path, attempt_id=attempt_id, program=program)
    holding.set_phase("acquired")
    return holding


class held:
    """Context manager for writers that are not the updater (e.g. the coverage scripts).

    On a host without the lock directory (a developer machine) it runs unlocked and says so, so
    local use is unchanged; on the server it waits up to wait_seconds for the lock.
    """

    def __init__(self, program: str, wait_seconds: float = 3600):
        self.program = program
        self.wait_seconds = wait_seconds
        self.holding: Holding | None = None

    def __enter__(self):
        path = lock_path()
        if fcntl is None or not path.parent.is_dir():
            print(f"[{self.program}] no maintenance lock directory {path.parent}; running unlocked", flush=True)
            return None
        attempt = time.strftime("%Y%m%d_%H%M%S", time.gmtime()) + f"-{os.getpid()}"
        self.holding = acquire(self.program, attempt, wait_seconds=self.wait_seconds)
        self.holding.set_phase("running")
        return self.holding

    def __exit__(self, *exc):
        if self.holding is not None:
            self.holding.release()
        return False


def lock_is_held_elsewhere(path: Path | None = None) -> bool:
    """True when some open file description other than a fresh one holds the lock."""
    path = path or lock_path()
    try:
        fd = os.open(path, os.O_RDWR)
    except FileNotFoundError:
        return False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in (errno.EWOULDBLOCK, errno.EAGAIN):
                return True
            raise LockError(f"cannot probe {path}: {exc}") from None
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


def adopt_inherited(program: str, expected_attempt: str, expected_phase: str,
                    path: Path | None = None) -> Holding:
    """Verify that the descriptor named in the environment is the held lock of this attempt.

    Three conditions, all required: the descriptor refers to the lock file itself (device and
    inode), the lock is held (a fresh descriptor cannot take it), and the owner record names this
    attempt at the expected phase and the owner process is our parent.
    """
    path = path or lock_path()
    raw = os.environ.get(FD_ENV, "")
    if not raw.isdigit():
        raise LockError(f"{FD_ENV} is not set to an inherited descriptor")
    fd = int(raw)
    try:
        fd_stat = os.fstat(fd)
        file_stat = os.stat(path)
    except OSError as exc:
        raise LockError(f"inherited lock descriptor unusable: {exc}") from None
    if (fd_stat.st_dev, fd_stat.st_ino) != (file_stat.st_dev, file_stat.st_ino):
        raise LockError("inherited descriptor is not the maintenance lock file")
    if not lock_is_held_elsewhere(path):
        raise LockError("maintenance lock is not held")
    owner = read_owner(path)
    if owner.get("attempt_id") != expected_attempt:
        raise LockError(f"lock owner attempt {owner.get('attempt_id')!r} is not {expected_attempt!r}")
    if owner.get("phase") != expected_phase:
        raise LockError(f"lock owner phase {owner.get('phase')!r} is not {expected_phase!r}")
    if owner.get("pid") != os.getppid():
        raise LockError(f"lock owner pid {owner.get('pid')} is not this process's parent {os.getppid()}")
    return Holding(fd=fd, path=path, attempt_id=expected_attempt, program=program)
