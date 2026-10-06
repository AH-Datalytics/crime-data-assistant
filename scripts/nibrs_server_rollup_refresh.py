#!/usr/bin/env python3
"""Server-side NIBRS rollup refresh, run inside the monthly updater's app-stopped window (S1).

Normally launched by nibrs-auto-update.py after it has settled the WAL, closed the database and
published the new source generation, and before it restarts the app. It inherits the updater's
maintenance lock. An operator may also run it standalone, in which case it takes the lock itself.

Order of work (each step refuses with a named reason, and nothing later runs after a refusal):

  1. ownership: the maintenance lock is held by this attempt; no other updater is running
  2. app stopped (`pm2 pid`, three-state parse), no process holds the source (device:inode /proc
     scan), source settled at the published generation (nibrs_source_state), space reserves met.
     On the production host the source, shared directory and PM2 program are fixed by
     nibrs_maintenance_policy and cannot be overridden.
  3. build with the existing builder under nice/ionice/prlimit in its own process group
  4. verification in a second bounded worker under the SAME limits: file integrity, metadata
     (generation plus this attempt and mode), schema, and fixed model-free cell checks against the
     source. Build and verification share one deadline, memory cap and disk watchdog; on timeout,
     a floor breach or ANY watchdog error the worker's process group is killed and reaped, and if
     it cannot be reaped the run ends "children-remain" so the caller must not restart the app.
  5. source unchanged; rename to the final name; candidate freshness at the candidate's own path
  6. activation (skipped in --mode no-activate): observe the prior target, source unchanged once
     more, atomic two-step link swap, read-back, live freshness. On a failed live check, contain
     to the OBSERVED prior target only after a checked read proves its generation; a failed read
     never swaps. Failed, contained and uncertain attempts register their artifacts in the hold
     file so later successful runs never prune them.
  7. retention of active + observed previous artifacts, by exact name, only after verified activation
  8. one JSON receipt and a status file for the updater

The builder's refusal to run on the production host stays the default; the only way past it is
the consumed, attempt-bound receipt, which the builder re-validates against live conditions.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import resource
import secrets
import signal
import sqlite3
import subprocess
import sys
import time
import traceback
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import nibrs_maintenance_lock as mlock  # noqa: E402
import nibrs_maintenance_policy as policy  # noqa: E402
import nibrs_source_state as srcstate  # noqa: E402

GiB = 1 << 30
ARTIFACT_RE = re.compile(r"^nibrs_rollups-[0-9A-Za-z_-]+\.db$")

EXIT_OK = 0
EXIT_FAILED_BEFORE_ACTIVATION = 10
EXIT_CONTAINED = 11
EXIT_UNCERTAIN = 12
EXIT_REFUSED = 13
EXIT_CHILDREN_REMAIN = 14

STALE_REASONS = {"generation-mismatch", "source-newer-than-rollup"}


def utc() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(message: str) -> None:
    print(f"[server-rollups {utc()}] {message}", flush=True)


class Refused(RuntimeError):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}{': ' + detail if detail else ''}")
        self.code = code


class ChildrenRemain(RuntimeError):
    """A bounded worker's process group could not be reaped: quiescence is not established."""


# ---------------------------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------------------------

def require_app_stopped(pm2_bin: str, app: str) -> str:
    state, detail = policy.pm2_state(pm2_bin, app)
    if state == "running":
        raise Refused("APP_NOT_STOPPED", detail)
    if state != "stopped":
        raise Refused("PM2_UNKNOWN", detail)
    return detail


def source_holders(canonical: str, exclude: set[int], proc: Path = Path("/proc"),
                   budget_seconds: float = 60.0) -> list[int]:
    """PIDs with an open descriptor on the canonical source, matched by device:inode.

    A process or descriptor that disappears during the scan is skipped; any other inspection
    failure refuses, because "could not look" is not "nobody holds it".
    """
    target = os.stat(canonical)
    key = (target.st_dev, target.st_ino)
    deadline = time.monotonic() + budget_seconds
    holders = []
    try:
        pids = [p for p in proc.iterdir() if p.name.isdigit()]
    except OSError as exc:
        raise Refused("HOLDER_SCAN_FAILED", str(exc)) from None
    for pid_dir in pids:
        if time.monotonic() > deadline:
            raise Refused("HOLDER_SCAN_TIMEOUT", f"over {budget_seconds}s")
        pid = int(pid_dir.name)
        if pid in exclude:
            continue
        try:
            fds = list((pid_dir / "fd").iterdir())
        except (FileNotFoundError, ProcessLookupError):
            continue
        except OSError as exc:
            raise Refused("HOLDER_SCAN_FAILED", f"{pid_dir}: {exc}") from None
        for fd in fds:
            try:
                st = os.stat(fd)
            except (FileNotFoundError, ProcessLookupError):
                continue  # the process or descriptor went away during the scan
            except OSError as exc:
                # An unreadable descriptor is not proof that it does not hold the source.
                raise Refused("HOLDER_SCAN_FAILED", f"{fd}: {exc}") from None
            if (st.st_dev, st.st_ino) == key:
                holders.append(pid)
                break
    return sorted(set(holders))


def free_bytes(path: str) -> int:
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize


# ---------------------------------------------------------------------------------------------
# Bounded workers (build and verification)
# ---------------------------------------------------------------------------------------------

def run_watched(cmd: list[str], env: dict, cwd: str, deadline: float, watch: list[tuple[str, int]],
                poll_s: float = 5.0, grace_s: float = 30.0, free=None) -> dict:
    """Run cmd in its own process group under a shared deadline and free-space floors.

    Every way out after the spawn -- normal exit, deadline, floor breach, or an exception in the
    watchdog itself -- ends with the group reaped. If it cannot be reaped, ChildrenRemain is raised
    and the run must not be followed by an app restart.
    """
    free = free or free_bytes
    started = time.monotonic()
    proc = subprocess.Popen(cmd, env=env, cwd=cwd, start_new_session=True)
    reason = None
    lowest: dict[str, int] = {}
    baseline: dict[str, int] = {}
    try:
        baseline = {path: free(path) for path, _ in watch}
        lowest = dict(baseline)
        while True:
            try:
                proc.wait(timeout=poll_s)
                break
            except subprocess.TimeoutExpired:
                pass
            for path, floor in watch:
                value = free(path)
                lowest[path] = min(lowest.get(path, value), value)
                if value < floor:
                    reason = f"free space on {path} fell to {value} below {floor}"
            if time.monotonic() > deadline:
                reason = "timeout: shared build/verification deadline passed"
            if reason:
                log(f"stopping worker process group: {reason}")
                _kill_group(proc, grace_s)
                break
    except ChildrenRemain:
        raise
    except BaseException as exc:
        log(f"watchdog error {type(exc).__name__}: {exc}; stopping worker process group")
        _kill_group(proc, grace_s)
        raise Refused("WATCHDOG_ERROR", f"{type(exc).__name__}: {exc}") from exc
    # A normally exiting leader can still leave group members behind. Only a proved empty group lets
    # the run continue; an unreadable scan (None) goes through the same reaping, which raises
    # ChildrenRemain if emptiness still cannot be proved.
    members = _group_members(proc.pid)
    if members is None or members:
        _kill_group(proc, grace_s)
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {
        "returncode": proc.returncode,
        "stopped_reason": reason,
        "elapsed_s": round(time.monotonic() - started, 1),
        "peak_child_rss_kib": usage.ru_maxrss,
        "max_space_drawn_bytes": {p: baseline.get(p, 0) - lowest.get(p, 0) for p, _ in watch},
    }


def _kill_group(proc: subprocess.Popen, grace_s: float) -> None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=grace_s)
            break
        except subprocess.TimeoutExpired:
            continue
    deadline = time.monotonic() + grace_s
    while time.monotonic() < deadline:
        members = _group_members(proc.pid)
        if members is not None and not members:
            break
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        time.sleep(0.5)
    if proc.poll() is None:
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
    members = _group_members(proc.pid)
    if members is None or members or proc.poll() is None:
        raise ChildrenRemain(f"process group {proc.pid} not reaped: {members}")


def _group_members(pgid: int):
    """Live (non-zombie) members of a process group, or None when /proc cannot be listed."""
    members = []
    try:
        entries = list(Path("/proc").iterdir())
    except OSError:
        return None
    for pid_dir in entries:
        if not pid_dir.name.isdigit():
            continue
        try:
            fields = (pid_dir / "stat").read_text().rsplit(")", 1)[1].split()
        except (FileNotFoundError, ProcessLookupError, IndexError):
            continue
        except OSError:
            return None
        if len(fields) > 2 and fields[2] == str(pgid) and fields[0] != "Z":
            members.append(int(pid_dir.name))
    return members


def bounded_cmd(python: str, memory_bytes: int, args: list[str]) -> list[str]:
    return ["nice", "-n", "10", "ionice", "-c3", "prlimit", f"--as={memory_bytes}", "--", python] + args


# ---------------------------------------------------------------------------------------------
# Candidate checks (run inside the bounded verification worker)
# ---------------------------------------------------------------------------------------------

def load_builder():
    name = "nibrs_rollup_builder"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, SCRIPT_DIR / "build-nibrs-rollups.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # dataclasses resolve annotations through sys.modules
    try:
        spec.loader.exec_module(module)
    except Exception:
        del sys.modules[name]
        raise
    return module


def check_integrity(candidate: str, generation: str, builder, attempt: str | None = None,
                    mode: str | None = None) -> dict:
    conn = sqlite3.connect(f"file:{candidate}?mode=ro", uri=True)
    try:
        integrity = conn.execute("PRAGMA integrity_check").fetchall()
        if integrity != [("ok",)]:
            raise Refused("CANDIDATE_INTEGRITY", repr(integrity[:3]))
        meta = dict(conn.execute("SELECT key, value FROM rollup_metadata").fetchall())
        if str(meta.get("schema_version")) != str(builder.SCHEMA_VERSION):
            raise Refused("CANDIDATE_METADATA", f"schema_version {meta.get('schema_version')}")
        if meta.get("source_generation") != generation:
            raise Refused("CANDIDATE_METADATA", f"source_generation {meta.get('source_generation')}")
        if attempt is not None and meta.get("maintenance_attempt") != attempt:
            raise Refused("CANDIDATE_METADATA", f"maintenance_attempt {meta.get('maintenance_attempt')}")
        if mode is not None and meta.get("maintenance_mode") != mode:
            raise Refused("CANDIDATE_METADATA", f"maintenance_mode {meta.get('maintenance_mode')}")
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        expected = {f"{level}_{spec.source}" for spec in builder.SPECS for level in ("state", "national")}
        missing = sorted(expected - tables)
        if missing:
            raise Refused("CANDIDATE_SCHEMA", f"missing {missing}")
        return {"integrity": "ok", "tables": len(expected)}
    finally:
        conn.close()


def route_checks(candidate: str, source: str, builder) -> list[dict]:
    """Model-free cell checks: for each family, the largest state cell and its national cell.

    These supplement the builder's per-state/year totals: they compare one fully filtered cell per
    family and level with the same filter applied directly to the source summary table. They are
    not full routing or correctness certification.
    """
    q = builder.quote_ident
    results = []
    conn = sqlite3.connect(f"file:{candidate}?mode=ro", uri=True)
    try:
        conn.execute("ATTACH DATABASE ? AS source", (f"file:{source}?mode=ro",))
        for spec in builder.SPECS:
            state_table = q(f"state_{spec.source}")
            dims = list(spec.dimensions)
            measure = spec.measures[0]
            cols = ", ".join(q(c) for c in ["state"] + dims)
            row = conn.execute(
                f"SELECT {cols} FROM {state_table} ORDER BY {q(measure)} DESC, {cols} LIMIT 1"
            ).fetchone()
            if row is None:
                results.append({"family": spec.source, "level": "state", "skipped": "empty"})
                continue
            for level, filter_cols, values, rollup_table in (
                ("state", ["state"] + dims, list(row), state_table),
                ("national", dims, list(row[1:]), q(f"national_{spec.source}")),
            ):
                where = " AND ".join(f"{q(c)} IS ?" for c in filter_cols)
                sums = ", ".join(f"SUM(COALESCE({q(m)},0))" for m in spec.measures)
                rolled = conn.execute(f"SELECT {sums} FROM {rollup_table} WHERE {where}", values).fetchone()
                direct = conn.execute(f"SELECT {sums} FROM source.{q(spec.source)} WHERE {where}", values).fetchone()
                ok = tuple(rolled) == tuple(direct)
                results.append({"family": spec.source, "level": level, "filter": dict(zip(filter_cols, values)),
                                "rollup": list(rolled), "source": list(direct), "equal": ok})
                if not ok:
                    raise Refused("ROUTE_CHECK_MISMATCH", json.dumps(results[-1], default=str))
    finally:
        conn.close()
    return results


def verify_worker(argv) -> int:
    """Entry point of the bounded verification worker: checks, then one JSON result file."""
    p = argparse.ArgumentParser()
    p.add_argument("--verify-worker", action="store_true")
    p.add_argument("--candidate", required=True)
    p.add_argument("--source-canonical", required=True)
    p.add_argument("--generation", required=True)
    p.add_argument("--attempt", required=True)
    p.add_argument("--mode", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args(argv)
    builder = load_builder()
    result: dict = {}
    try:
        result["integrity"] = check_integrity(a.candidate, a.generation, builder, a.attempt, a.mode)
        checks = route_checks(a.candidate, a.source_canonical, builder)
        result["route_checks"] = {"count": len(checks), "all_equal": all(c.get("equal", True) for c in checks),
                                  "checks": checks}
        result["ok"] = True
    except Refused as exc:
        result.update({"ok": False, "code": exc.code, "detail": str(exc)})
    Path(a.out).write_text(json.dumps(result, default=str), encoding="utf-8")
    return 0 if result["ok"] else 2


def run_freshness(cmd: list[str], cwd: str, source_alias: str, shared: str, rollup_path: str,
                  timeout: int = 300) -> dict:
    env = dict(os.environ)
    env.update({
        "NIBRS_DB_PATH": source_alias,
        "NIBRS_SOURCE_GENERATION_PATH": str(Path(shared) / "nibrs_source.generation"),
        "NIBRS_ROLLUP_DB_PATH": rollup_path,
    })
    try:
        done = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc), "status": None}
    parsed = None
    try:
        parsed = json.loads(done.stdout.strip().splitlines()[-1]) if done.stdout.strip() else None
    except ValueError:
        parsed = None
    ok = done.returncode == 0 and isinstance(parsed, dict) and parsed.get("available") is True \
        and parsed.get("reason") == "rollup-current"
    return {"ok": ok, "returncode": done.returncode, "status": parsed, "stderr": done.stderr.strip()[-500:]}


# ---------------------------------------------------------------------------------------------
# Activation, containment, holds, retention
# ---------------------------------------------------------------------------------------------

def swap_link(shared: str, link: str, basename: str, tag: str) -> None:
    staging = str(Path(shared) / f"nibrs_rollups.db.staging-{tag}")
    if os.path.lexists(staging):
        raise Refused("STAGING_EXISTS", staging)
    os.symlink(basename, staging)
    os.replace(staging, link)


def read_link_target(link: str) -> str:
    try:
        return os.path.realpath(link, strict=True)
    except OSError:
        return ""


def read_sidecar_checked(path: str) -> str:
    """The generation sidecar of an artifact. Raises if absent, unreadable or empty."""
    text = Path(path + ".generation").read_text(encoding="utf-8")
    value = text.replace("\r", "").replace("\n", "")
    if not value:
        raise ValueError(f"{path}.generation is empty")
    return value


def hold(hold_file: str, names: list[str]) -> list[str]:
    """Durably add artifact basenames to the hold list (prune never deletes held artifacts)."""
    names = [n for n in names if n]
    if not names:
        return []
    existing: list[str] = []
    try:
        existing = [line.strip() for line in Path(hold_file).read_text(encoding="utf-8").splitlines() if line.strip()]
    except FileNotFoundError:
        pass
    merged = existing + [n for n in names if n not in existing]
    tmp = f"{hold_file}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("\n".join(merged) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, hold_file)
    return names


def prune(shared: str, keep: set[str], hold_file: str) -> list[str]:
    held: set[str] = set()
    try:
        held = {line.strip() for line in Path(hold_file).read_text(encoding="utf-8").splitlines() if line.strip()}
    except FileNotFoundError:
        pass
    shared_real = os.path.realpath(shared)
    removed = []
    for entry in sorted(os.listdir(shared)):
        if not ARTIFACT_RE.match(entry) or entry in keep or entry in held:
            continue
        full = os.path.join(shared, entry)
        if os.path.islink(full) or not os.path.isfile(full):
            continue
        if os.path.dirname(os.path.realpath(full)) != shared_real:
            continue
        os.remove(full)
        removed.append(entry)
        sidecar = full + ".generation"
        if os.path.isfile(sidecar) and not os.path.islink(sidecar):
            os.remove(sidecar)
            removed.append(entry + ".generation")
    return removed


def valid_observed_prior(observed: str, shared: str) -> bool:
    return bool(observed) and os.path.isfile(observed) and not os.path.islink(observed) \
        and os.path.dirname(observed) == os.path.realpath(shared) \
        and bool(ARTIFACT_RE.match(os.path.basename(observed)))


def contain(ctx: dict, observed_prior: str, final: str) -> tuple[str, int, str]:
    """Fail closed after a failed live check, or report uncertainty. Never swaps on an unproved read."""
    args, link, generation, step = ctx["args"], ctx["link"], ctx["generation"], ctx["step"]
    new_name = os.path.basename(final)
    if not valid_observed_prior(observed_prior, args.shared):
        step("containment-refused", reason="observed prior target is not a valid artifact", target=observed_prior)
        return "uncertain", EXIT_UNCERTAIN, "live check failed; no valid observed prior to contain to"
    try:
        prior_generation = read_sidecar_checked(observed_prior)
    except (OSError, ValueError) as exc:
        step("containment-refused", reason=f"prior generation unreadable: {exc}")
        return "uncertain", EXIT_UNCERTAIN, "live check failed; prior generation unreadable, no swap"
    swap_link(args.shared, link, os.path.basename(observed_prior), f"contain-{ctx['attempt']}")
    target = read_link_target(link)
    live = run_freshness(ctx["freshness_cmd"], args.app_dir, args.source, args.shared, link)
    step("containment", target=target, observed_prior=observed_prior, prior_generation=prior_generation,
         live=live, retained=new_name)
    if target != observed_prior:
        return "uncertain", EXIT_UNCERTAIN, f"containment read-back {target} is not the observed prior"
    if prior_generation == generation:
        # The prior already describes this generation: it is restored, not called stale.
        if live["ok"]:
            return "contained", EXIT_CONTAINED, "new artifact failed live check; matching prior restored"
        return "uncertain", EXIT_UNCERTAIN, "matching prior restored but its live check fails"
    reason = (live.get("status") or {}).get("reason")
    if not live["ok"] and reason in STALE_REASONS:
        return "contained", EXIT_CONTAINED, "fail-closed: stale prior active, rollups unavailable"
    return "uncertain", EXIT_UNCERTAIN, f"containment not verified (live {reason!r})"


# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------

def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--mode", required=True, choices=["activate", "no-activate"])
    p.add_argument("--source", default=policy.PRODUCTION_SOURCE_ALIAS)
    p.add_argument("--shared", default=policy.PRODUCTION_SHARED)
    p.add_argument("--app-dir", default="/opt/nibrs/current")
    p.add_argument("--app-name", default=policy.PRODUCTION_APP)
    p.add_argument("--pm2-bin", default=policy.PRODUCTION_PM2_BIN)
    p.add_argument("--python", default=sys.executable)
    p.add_argument("--freshness-cmd", help="JSON list; defaults to node + release tsx + check-nibrs-rollup-freshness.ts")
    p.add_argument("--tmpdir", default="/mnt/HC_Volume_105124811/tmp")
    p.add_argument("--receipts-dir", default="/opt/nibrs/rollup-runs")
    p.add_argument("--status-file", help="JSON status for the caller")
    p.add_argument("--hold-file", default="/opt/nibrs/shared/.rollup-hold")
    p.add_argument("--attempt-id")
    p.add_argument("--inherit-lock", action="store_true", help="Adopt the caller's held maintenance lock")
    p.add_argument("--expected-phase", default="published")
    p.add_argument("--timeout-s", type=int, default=7200, help="shared deadline for build plus verification")
    p.add_argument("--memory-bytes", type=int, default=8 * GiB)
    p.add_argument("--min-free-tmp-bytes", type=int, default=20 * GiB)
    p.add_argument("--min-free-output-fallback-bytes", type=int, default=4 * GiB)
    p.add_argument("--abort-free-tmp-bytes", type=int, default=5 * GiB)
    p.add_argument("--abort-free-output-bytes", type=int, default=1 * GiB)
    p.add_argument("--poll-s", type=float, default=5.0)
    return p.parse_args(argv)


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if "--verify-worker" in argv:
        return verify_worker(argv)
    args = parse_args(argv)
    attempt = args.attempt_id or os.environ.get(mlock.ATTEMPT_ENV) or \
        time.strftime("%Y%m%d_%H%M%S", time.gmtime()) + "-" + secrets.token_hex(4)
    run_dir = Path(args.receipts_dir) / attempt
    run_dir.mkdir(parents=True, exist_ok=False)
    record = {"attempt_id": attempt, "mode": args.mode, "started_at": utc(), "steps": []}
    owned: list[str] = []
    link = str(Path(args.shared) / "nibrs_rollups.db")

    def step(name: str, **data) -> None:
        record["steps"].append({"step": name, "at": utc(), **data})
        log(f"{name}: {json.dumps(data, default=str)[:400]}")

    def finish(final_status: str, final_code: int, detail: str = "") -> int:
        record.update({"status": final_status, "detail": detail, "finished_at": utc(), "owned_paths": owned})
        (run_dir / "receipt.json").write_text(json.dumps(record, indent=2, default=str), encoding="utf-8")
        if args.status_file:
            Path(args.status_file).write_text(json.dumps(
                {"attempt_id": attempt, "rollup_status": final_status, "detail": detail,
                 "receipt": str(run_dir / "receipt.json")}), encoding="utf-8")
        log(f"RESULT {final_status} {detail}")
        return final_code

    def remove_owned() -> None:
        for path in list(owned):
            try:
                if os.path.lexists(path):
                    os.remove(path)
                    step("removed-owned", path=path)
            except OSError as exc:
                step("remove-owned-failed", path=path, error=str(exc))

    def hold_owned_artifacts(reason: str) -> None:
        # Only finished artifact names can ever be pruned (ARTIFACT_RE), so those are what is held.
        names = sorted({os.path.basename(p) for p in owned
                        if os.path.exists(p) and ARTIFACT_RE.match(os.path.basename(p))})
        if names:
            step("held", names=hold(args.hold_file, names), reason=reason)

    holding = None
    final = ""
    try:
        # 0. Production policy: fixed paths on the production host.
        paths = policy.maintenance_paths()
        if paths.production and (args.source, args.shared, args.pm2_bin, args.app_name) != \
                (paths.source_alias, paths.shared, paths.pm2_bin, paths.app):
            raise Refused("PRODUCTION_PATH_OVERRIDE", "source/shared/pm2/app differ from the fixed production policy")

        # 1. Ownership
        if args.inherit_lock:
            holding = mlock.adopt_inherited("server-rollup-refresh", attempt, args.expected_phase)
            exclude = {os.getpid(), os.getppid()}
        else:
            holding = mlock.acquire("server-rollup-refresh", attempt, wait_seconds=0)
            holding.set_phase("operator")
            exclude = {os.getpid()}
        owner = mlock.read_owner()
        step("ownership", owner=owner)
        others = srcstate.other_updaters(exclude)
        if others:
            raise Refused("UPDATE_RUNNING", f"other updater pids {others}")

        # 2. Preconditions
        pm2 = require_app_stopped(args.pm2_bin, args.app_name)
        before = srcstate.inspect(args.source, args.shared, link)
        holders = source_holders(before.canonical, exclude={os.getpid()})
        if holders:
            raise Refused("SOURCE_HELD", f"pids {holders}")
        step("preconditions", pm2=pm2, source=before.__dict__)

        freshness_cmd = json.loads(args.freshness_cmd) if args.freshness_cmd else [
            "/usr/bin/node", str(Path(args.app_dir) / "node_modules/tsx/dist/cli.mjs"),
            "scripts/check-nibrs-rollup-freshness.ts"]

        if before.active_generation == before.generation and before.active_target:
            live = run_freshness(freshness_cmd, args.app_dir, args.source, args.shared, link)
            step("already-current-check", live=live)
            if live["ok"]:
                return finish("already-current", EXIT_OK, f"active {before.active_target} matches {before.generation}")

        prior_target = before.active_target
        prior_generation = before.active_generation
        active_size = os.path.getsize(prior_target) if prior_target and os.path.isfile(prior_target) else 0
        need_output = max(2 * active_size, args.min_free_output_fallback_bytes)
        free_out, free_tmp = free_bytes(args.shared), free_bytes(args.tmpdir)
        step("space", free_output=free_out, need_output=need_output, free_tmp=free_tmp, need_tmp=args.min_free_tmp_bytes)
        if free_out < need_output:
            raise Refused("LOW_OUTPUT_SPACE", f"{free_out} < {need_output}")
        if free_tmp < args.min_free_tmp_bytes:
            raise Refused("LOW_TMP_SPACE", f"{free_tmp} < {args.min_free_tmp_bytes}")

        # 3. Build, and 4. verification: two bounded workers sharing one deadline and watchdog.
        deadline = time.monotonic() + args.timeout_s
        watch = [(args.tmpdir, args.abort_free_tmp_bytes), (args.shared, args.abort_free_output_bytes)]
        env = dict(os.environ)
        env["SQLITE_TMPDIR"] = args.tmpdir
        if not paths.production:
            env["NIBRS_MAINT_SOURCE_ALIAS"] = args.source
            env["NIBRS_MAINT_SHARED"] = args.shared
            env["NIBRS_MAINT_PM2_BIN"] = args.pm2_bin
            env["NIBRS_MAINT_APP"] = args.app_name
        basename = f"nibrs_rollups-{time.strftime('%Y%m%d_%H%M%S', time.gmtime())}-{secrets.token_hex(8)}.db"
        final = str(Path(os.path.realpath(args.shared)) / basename)
        building = final + ".building"
        owned += [building, building + ".generation"]
        receipt = run_dir / "build-receipt.json"
        receipt.write_text(json.dumps({
            "attempt_id": attempt, "owner_pid": owner.get("pid"), "owner_phase": owner.get("phase"),
            "mode": args.mode, "source_alias": args.source, "source_canonical": before.canonical,
            "source_identity": before.identity, "generation": before.generation, "output": building,
            "created_epoch": time.time(), "nonce": secrets.token_hex(8)}), encoding="utf-8")
        os.chmod(receipt, 0o600)
        build = run_watched(
            bounded_cmd(args.python, args.memory_bytes,
                        [str(SCRIPT_DIR / "build-nibrs-rollups.py"), "--source", before.canonical,
                         "--output", building, "--source-generation", before.generation,
                         "--maintenance-window", "--receipt", str(receipt)]),
            env, str(SCRIPT_DIR), deadline, watch, poll_s=args.poll_s)
        step("build", **build)
        if build["stopped_reason"] or build["returncode"] != 0:
            remove_owned()
            return finish("failed-before-activation", EXIT_FAILED_BEFORE_ACTIVATION,
                          build["stopped_reason"] or f"builder exit {build['returncode']}")

        verify_out = run_dir / "verify.json"
        verify = run_watched(
            bounded_cmd(args.python, args.memory_bytes,
                        [str(Path(__file__).resolve()), "--verify-worker", "--candidate", building,
                         "--source-canonical", before.canonical, "--generation", before.generation,
                         "--attempt", attempt, "--mode", args.mode, "--out", str(verify_out)]),
            env, str(SCRIPT_DIR), deadline, watch, poll_s=args.poll_s)
        try:
            verdict = json.loads(verify_out.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            verdict = {"ok": False, "detail": "verification worker wrote no result"}
        step("verify", **verify, ok=verdict.get("ok"), integrity=verdict.get("integrity"),
             route_checks={k: v for k, v in (verdict.get("route_checks") or {}).items() if k != "checks"},
             detail=verdict.get("detail"))
        if verify["stopped_reason"] or verify["returncode"] != 0 or not verdict.get("ok"):
            remove_owned()
            return finish("failed-before-activation", EXIT_FAILED_BEFORE_ACTIVATION,
                          verify["stopped_reason"] or verdict.get("detail") or f"verifier exit {verify['returncode']}")

        # 5. Source unchanged, rename, candidate freshness
        srcstate.assert_unchanged(before, srcstate.inspect(args.source, args.shared, link), "the build")
        os.rename(building + ".generation", final + ".generation")
        owned = [p for p in owned if p != building + ".generation"] + [final + ".generation"]
        os.rename(building, final)
        owned = [p for p in owned if p != building] + [final]
        if read_sidecar_checked(final) != before.generation:
            raise Refused("SIDECAR_MISMATCH", final)
        candidate = run_freshness(freshness_cmd, args.app_dir, args.source, args.shared, final)
        step("candidate-freshness", **candidate)
        if not candidate["ok"]:
            remove_owned()
            return finish("failed-before-activation", EXIT_FAILED_BEFORE_ACTIVATION, "candidate freshness failed")

        if args.mode == "no-activate":
            if prior_target:
                try:
                    unchanged = read_link_target(link) == prior_target and read_sidecar_checked(prior_target) == prior_generation
                except (OSError, ValueError):
                    unchanged = False
            else:
                unchanged = not os.path.lexists(link)
            step("no-activate-live-unchanged", unchanged=unchanged)
            remove_owned()
            if not unchanged:
                return finish("uncertain", EXIT_UNCERTAIN, "live rollup target changed during a no-activate trial")
            return finish("measured", EXIT_OK, "no-activate trial complete; live target unchanged")

        # 6. Activation
        srcstate.assert_unchanged(before, srcstate.inspect(args.source, args.shared, link), "pre-activation")
        if source_holders(before.canonical, exclude={os.getpid()}):
            raise Refused("SOURCE_HELD", "a process opened the source before activation")
        observed_prior = read_link_target(link)
        step("observed-prior", target=observed_prior)
        try:
            swap_link(args.shared, link, basename, attempt)
            activation = "applied"
        except Refused:
            raise
        except Exception as exc:  # the swap raised: read back before deciding anything
            now = read_link_target(link)
            activation = "reconciled-active" if now == final else \
                "reconciled-prior-active" if now == observed_prior else "unknown"
            step("swap-exception", error=str(exc), readback=now, state=activation)
        if activation == "applied" and read_link_target(link) != final:
            activation = "unknown"
        step("activation", state=activation, target=read_link_target(link))
        if activation == "unknown":
            hold_owned_artifacts("activation unknown")
            return finish("uncertain", EXIT_UNCERTAIN, "activation state unknown; artifacts retained and held")
        if activation == "reconciled-prior-active":
            remove_owned()
            return finish("failed-before-activation", EXIT_FAILED_BEFORE_ACTIVATION, "swap failed; prior still active")
        activated_owned = list(owned)
        owned = []  # the active artifact is no longer the attempt's to remove

        live = run_freshness(freshness_cmd, args.app_dir, args.source, args.shared, link)
        step("live-freshness", **live)
        if not live["ok"]:
            owned = activated_owned
            ctx = {"args": args, "link": link, "generation": before.generation, "step": step,
                   "attempt": attempt, "freshness_cmd": freshness_cmd}
            try:
                status, code, detail = contain(ctx, observed_prior, final)
            except Exception as exc:  # after activation, an error here is never a clean refusal
                step("containment-error", error=str(exc), target=read_link_target(link))
                status, code, detail = "uncertain", EXIT_UNCERTAIN, f"containment error: {exc}"
            hold_owned_artifacts(f"live verification failed ({status})")
            owned = []
            return finish(status, code, detail + "; new artifact retained and held")

        # 7. Retention
        keep = {basename}
        if valid_observed_prior(observed_prior, args.shared):
            keep.add(os.path.basename(observed_prior))
        step("retention", removed=prune(args.shared, keep, args.hold_file), kept=sorted(keep))
        return finish(activation, EXIT_OK, f"active {final}")

    except ChildrenRemain as exc:
        hold_owned_artifacts("worker process group not reaped")
        return finish("children-remain", EXIT_CHILDREN_REMAIN, f"{exc}; app must not be restarted")
    except (Refused, srcstate.SourceStateError, mlock.LockError) as exc:
        remove_owned()
        return finish("refused", EXIT_REFUSED, str(exc))
    except Exception as exc:  # unexpected: never claim anything changed or not; keep evidence
        record["traceback"] = traceback.format_exc()
        log(record["traceback"])
        hold_owned_artifacts("unexpected error")
        return finish("uncertain", EXIT_UNCERTAIN, f"unexpected {type(exc).__name__}: {exc}")
    finally:
        if holding is not None and not args.inherit_lock:
            holding.release()


if __name__ == "__main__":
    sys.exit(main())
