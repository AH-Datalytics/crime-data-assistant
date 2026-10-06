"""Fixed production policy for the server-side rollup maintenance exception.

On the production web host every path and program used by the exception is FIXED here and no
environment variable can change it. Off production (fixture tests in disposable containers) the
same values can be overridden through NIBRS_MAINT_* variables, so the tests exercise the real code
paths without those overrides ever becoming a production bypass.

Also holds the one PM2 parser used by the refresh, the builder and the updater, so "stopped",
"running" and "unknown" mean the same thing everywhere.
"""

from __future__ import annotations

import os
import socket
import subprocess
from dataclasses import dataclass

# Must equal build-nibrs-rollups.py PRODUCTION_HOSTNAMES (asserted by the tests).
PRODUCTION_HOSTNAMES = {"ubuntu-8gb-ash-2"}

PRODUCTION_SOURCE_ALIAS = "/opt/nibrs/nibrs.db"
PRODUCTION_SHARED = "/opt/nibrs/shared"
PRODUCTION_PM2_BIN = "pm2"
PRODUCTION_APP = "nibrs"

# Owner phases at which a build may run: the updater after a settled publication, or a standalone
# operator run that took the lock itself.
BUILD_PHASES = {"published", "operator"}


def is_production_host() -> bool:
    hostname = socket.gethostname().lower()
    configured = {h.strip().lower() for h in os.environ.get("NIBRS_PRODUCTION_HOSTNAMES", "").split(",") if h.strip()}
    return hostname in PRODUCTION_HOSTNAMES | configured


@dataclass(frozen=True)
class MaintenancePaths:
    source_alias: str
    shared: str
    pm2_bin: str
    app: str
    production: bool


def maintenance_paths() -> MaintenancePaths:
    if is_production_host():
        return MaintenancePaths(PRODUCTION_SOURCE_ALIAS, PRODUCTION_SHARED, PRODUCTION_PM2_BIN, PRODUCTION_APP, True)
    env = os.environ
    return MaintenancePaths(
        env.get("NIBRS_MAINT_SOURCE_ALIAS", PRODUCTION_SOURCE_ALIAS),
        env.get("NIBRS_MAINT_SHARED", PRODUCTION_SHARED),
        env.get("NIBRS_MAINT_PM2_BIN", PRODUCTION_PM2_BIN),
        env.get("NIBRS_MAINT_APP", PRODUCTION_APP),
        False,
    )


def pm2_state(pm2_bin: str, app: str, timeout: int = 60) -> tuple[str, str]:
    """Return ("stopped" | "running" | "unknown", raw detail) for `pm2 pid <app>`.

    PM2 prints one PID per instance, one per line, and 0 for an instance that is not running.
    Stopped means at least one line and every line is 0. Running means any line is a positive PID.
    Anything else -- a failed or timed-out command, empty output (PM2 does not know the app), or a
    line that is not a number -- is unknown, and unknown is never treated as stopped.
    """
    try:
        done = subprocess.run([pm2_bin, "pid", app], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return "unknown", f"pm2 could not run: {exc}"
    raw = done.stdout.strip()
    if done.returncode != 0:
        return "unknown", f"exit {done.returncode}: {done.stderr.strip()[:200]}"
    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    if not lines or not all(line.isdigit() for line in lines):
        return "unknown", repr(raw)
    if all(int(line) == 0 for line in lines):
        return "stopped", repr(raw)
    return "running", repr(raw)
