#!/usr/bin/env python3
"""End-to-end fixture tests for nibrs_server_rollup_refresh.py (Linux container).

Each test builds a throwaway server layout: a source database behind an alias symlink, a shared
directory with a generation marker and a live rollup link, a PM2 stub, a freshness stub that
implements the router's availability rules, and its own maintenance lock. The real builder runs.
"""

import errno
import json
import os
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import nibrs_maintenance_lock as ml  # noqa: E402
import nibrs_server_rollup_refresh as refresh  # noqa: E402
from ib1_fixtures import (executable, freshness_stub, make_source, old_artifact, pm2_stub,  # noqa: E402
                          publish, read_json)

REFRESH = SCRIPTS / "nibrs_server_rollup_refresh.py"


class RefreshFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        b = self.base = Path(self.tmp.name)
        (b / "volume").mkdir()
        self.shared = b / "shared"
        self.shared.mkdir()
        (b / "tmpdir").mkdir()
        (b / "bin").mkdir()
        self.target = b / "volume" / "nibrs.db"
        make_source(self.target)
        self.alias = b / "nibrs.db"
        os.symlink(self.target, self.alias)
        self.prior = old_artifact(self.shared, "nibrs_rollups-20260924_025232-aaaa.db", "1:1")
        self.older = old_artifact(self.shared, "nibrs_rollups-20260823_180321-bbbb.db", "1:2")
        self.held = old_artifact(self.shared, "nibrs_rollups-20260724.db", "1:3")
        (self.shared / ".rollup-hold").write_text("nibrs_rollups-20260724.db\n")
        os.symlink(self.prior.name, self.shared / "nibrs_rollups.db")
        time.sleep(0.05)
        self.generation = publish(self.alias, self.shared)
        self.pm2 = pm2_stub(b / "bin", "0")
        self.fresh = freshness_stub(b / "bin")
        self.status = b / "status.json"
        self.env = dict(os.environ)
        self.env["NIBRS_MAINTENANCE_LOCK"] = str(b / "maintenance.lock")
        self.env["PYTHONDONTWRITEBYTECODE"] = "1"

    def tearDown(self):
        self.tmp.cleanup()

    def args(self, mode="activate", **over):
        a = {
            "--mode": mode, "--source": str(self.alias), "--shared": str(self.shared),
            "--app-dir": str(self.base), "--pm2-bin": str(self.pm2),
            "--freshness-cmd": json.dumps([str(self.fresh)]), "--tmpdir": str(self.base / "tmpdir"),
            "--receipts-dir": str(self.base / "runs"), "--status-file": str(self.status),
            "--hold-file": str(self.shared / ".rollup-hold"), "--min-free-tmp-bytes": "1",
            "--min-free-output-fallback-bytes": "1", "--abort-free-tmp-bytes": "0",
            "--abort-free-output-bytes": "0", "--poll-s": "0.2", "--timeout-s": "300",
        }
        a.update({k: str(v) for k, v in over.items()})
        out = []
        for k, v in a.items():
            if v is None:
                continue
            out += [k, v] if v != "" else [k]
        return out

    def run_refresh(self, mode="activate", extra_env=None, **over):
        env = dict(self.env)
        env.update(extra_env or {})
        done = subprocess.run([sys.executable, str(REFRESH)] + self.args(mode, **over),
                              env=env, capture_output=True, text=True, timeout=600)
        status = read_json(self.status) if self.status.exists() else {}
        return done, status

    def live_target(self):
        return os.path.realpath(self.shared / "nibrs_rollups.db")

    def artifacts(self):
        return sorted(p.name for p in self.shared.iterdir() if p.name.startswith("nibrs_rollups-"))

    def new_artifacts(self):
        return [n for n in self.artifacts() if n.endswith(".db") and n not in
                {self.prior.name, self.older.name, self.held.name}]

    def held_names(self):
        return (self.shared / ".rollup-hold").read_text().split()


def live_processes(marker: bytes) -> list[str]:
    """Non-zombie processes whose command line contains marker."""
    found = []
    for pid_dir in Path("/proc").iterdir():
        if pid_dir.name.isdigit():
            try:
                cmd = (pid_dir / "cmdline").read_bytes()
                state = (pid_dir / "stat").read_text().rsplit(")", 1)[1].split()[0]
            except OSError:
                continue
            if marker in cmd and state != "Z":
                found.append(pid_dir.name)
    return found


class SuccessAndTrial(RefreshFixture):
    def test_activate_applies_verifies_and_prunes_by_exact_name(self):
        done, status = self.run_refresh()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(status["rollup_status"], "applied")
        live = self.live_target()
        self.assertNotEqual(live, str(self.prior))
        self.assertEqual(Path(live + ".generation").read_text().strip(), self.generation)
        names = self.artifacts()
        self.assertIn(self.prior.name, names)                 # observed previous kept
        self.assertIn(self.held.name, names)                  # incident hold kept
        self.assertNotIn(self.older.name, names)              # older pruned
        self.assertNotIn(self.older.name + ".generation", names)
        self.assertFalse(any(n.endswith(".building") for n in names))
        receipt = read_json(status["receipt"])
        steps = [s["step"] for s in receipt["steps"]]
        for expected in ("ownership", "preconditions", "build", "verify",
                         "candidate-freshness", "observed-prior", "activation", "live-freshness", "retention"):
            self.assertIn(expected, steps)
        verify = next(s for s in receipt["steps"] if s["step"] == "verify")
        self.assertTrue(verify["ok"])
        self.assertIsNone(verify["stopped_reason"])   # checks ran inside the bounded worker
        self.assertTrue(verify["route_checks"]["all_equal"])
        self.assertGreaterEqual(verify["route_checks"]["count"], 18)

    def test_no_activate_trial_leaves_live_untouched_and_removes_outputs(self):
        before = self.artifacts()
        done, status = self.run_refresh("no-activate")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(status["rollup_status"], "measured")
        self.assertEqual(self.live_target(), str(self.prior))
        self.assertEqual(self.artifacts(), before)

    def test_already_current_is_a_no_op(self):
        current = old_artifact(self.shared, "nibrs_rollups-20261016_090000-cccc.db", self.generation)
        os.utime(current, None)
        (self.shared / "nibrs_rollups.db").unlink()
        os.symlink(current.name, self.shared / "nibrs_rollups.db")
        before = self.artifacts()
        done, status = self.run_refresh()
        self.assertEqual(status["rollup_status"], "already-current", done.stdout)
        self.assertEqual(self.artifacts(), before)


class Refusals(RefreshFixture):
    def assertRefusedWith(self, status, code):
        self.assertEqual(status["rollup_status"], "refused")
        self.assertIn(code, status["detail"])
        self.assertEqual(self.live_target(), str(self.prior))
        self.assertFalse(any(n.endswith(".building") or "20261" in n for n in self.artifacts()))

    def test_app_running(self):
        self.pm2 = pm2_stub(self.base / "bin", "4242")
        done, status = self.run_refresh()
        self.assertEqual(done.returncode, refresh.EXIT_REFUSED)
        self.assertRefusedWith(status, "APP_NOT_STOPPED")

    def test_one_running_worker_of_several(self):
        self.pm2 = pm2_stub(self.base / "bin", "0\n4242")
        _, status = self.run_refresh()
        self.assertRefusedWith(status, "APP_NOT_STOPPED")

    def test_pm2_empty_output_is_not_proof_of_stopped(self):
        self.pm2 = pm2_stub(self.base / "bin", "")
        _, status = self.run_refresh()
        self.assertRefusedWith(status, "PM2_UNKNOWN")

    def test_pm2_failure(self):
        self.pm2 = pm2_stub(self.base / "bin", "0", exit_code=1)
        _, status = self.run_refresh()
        self.assertRefusedWith(status, "PM2_UNKNOWN")

    def test_production_host_refuses_path_overrides(self):
        _, status = self.run_refresh(extra_env={"NIBRS_PRODUCTION_HOSTNAMES": socket.gethostname()})
        self.assertRefusedWith(status, "PRODUCTION_PATH_OVERRIDE")

    def test_source_held_by_another_process(self):
        holder = subprocess.Popen([sys.executable, "-c",
                                   f"f=open({str(self.target)!r},'rb');import time;time.sleep(60)"])
        try:
            time.sleep(0.3)
            _, status = self.run_refresh()
            self.assertRefusedWith(status, "SOURCE_HELD")
        finally:
            holder.kill()
            holder.wait()

    def test_stale_generation(self):
        (self.shared / "nibrs_source.generation").write_text("1:1\n")
        _, status = self.run_refresh()
        self.assertRefusedWith(status, "GENERATION_STALE")

    def test_lock_held_by_someone_else(self):
        os.environ["NIBRS_MAINTENANCE_LOCK"] = self.env["NIBRS_MAINTENANCE_LOCK"]
        h = ml.acquire("someone", "x")
        try:
            _, status = self.run_refresh()
            self.assertRefusedWith(status, "held")
        finally:
            h.release()
            os.environ.pop("NIBRS_MAINTENANCE_LOCK", None)

    def test_other_updater_running(self):
        other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "nibrs-auto-update.py"])
        try:
            time.sleep(0.3)
            _, status = self.run_refresh()
            self.assertRefusedWith(status, "UPDATE_RUNNING")
        finally:
            other.kill()
            other.wait()

    def test_low_output_space(self):
        _, status = self.run_refresh(**{"--min-free-output-fallback-bytes": str(1 << 62)})
        self.assertRefusedWith(status, "LOW_OUTPUT_SPACE")


class BoundsAndFailures(RefreshFixture):
    def test_timeout_kills_and_reaps_the_build_group(self):
        slow = executable(self.base / "bin" / "slowpython", f"""
            #!/bin/sh
            {sys.executable} -c "import time; time.sleep(120)" &
            exec {sys.executable} -c "import time; time.sleep(120)"
        """)
        started = time.monotonic()
        done, status = self.run_refresh(**{"--python": str(slow), "--timeout-s": "2"})
        self.assertLess(time.monotonic() - started, 90)
        self.assertEqual(status["rollup_status"], "failed-before-activation")
        self.assertIn("timeout", status["detail"])
        self.assertEqual(self.live_target(), str(self.prior))
        self.assertEqual(live_processes(b"time.sleep(120)"), [], "build process group not reaped")

    def test_verification_worker_is_bounded_by_the_shared_deadline(self):
        # The builder runs normally; the verification worker hangs. The integrity and cell checks
        # now run in that worker, so the shared deadline stops them and reaps the group.
        marker = f"verify-hang-{secrets.token_hex(4)}"
        wrapper = executable(self.base / "bin" / "verifyhang", f"""
            #!/bin/sh
            case "$*" in *--verify-worker*) exec {sys.executable} -c "import time; time.sleep(120)" {marker} ;; esac
            exec {sys.executable} "$@"
        """)
        started = time.monotonic()
        _, status = self.run_refresh(**{"--python": str(wrapper), "--timeout-s": "15"})
        self.assertLess(time.monotonic() - started, 90)
        self.assertEqual(status["rollup_status"], "failed-before-activation", status)
        self.assertIn("timeout", status["detail"])
        receipt = read_json(status["receipt"])
        build = next(s for s in receipt["steps"] if s["step"] == "build")
        verify = next(s for s in receipt["steps"] if s["step"] == "verify")
        self.assertIsNone(build["stopped_reason"])
        self.assertIn("timeout", verify["stopped_reason"])
        self.assertEqual(live_processes(marker.encode()), [], "verification worker not reaped")
        self.assertEqual(self.live_target(), str(self.prior))
        self.assertFalse(any(n.endswith(".building") for n in self.artifacts()))

    def test_watchdog_exception_reaps_the_worker(self):
        # Codex's F1 witness: an exception in the space watchdog after the spawn used to leave the
        # child running.
        marker = f"watchdog-witness-{secrets.token_hex(4)}"

        def broken_free(path):
            raise OSError("injected statvfs failure")

        with self.assertRaises(refresh.Refused) as ctx:
            refresh.run_watched([sys.executable, "-c", "import time; time.sleep(120)", marker],
                                dict(os.environ), str(self.base), time.monotonic() + 300,
                                [(str(self.base), 0)], poll_s=0.2, grace_s=5, free=broken_free)
        self.assertEqual(ctx.exception.code, "WATCHDOG_ERROR")
        self.assertEqual(live_processes(marker.encode()), [], "child still running after watchdog error")

    def test_unknown_group_membership_is_not_success(self):
        # Residual F1 (Codex witness 1): after a normal exit, an unreadable group scan (None) must
        # follow the reaping path and end in ChildrenRemain, never in a successful return.
        with mock.patch.object(refresh, "_group_members", return_value=None):
            with self.assertRaises(refresh.ChildrenRemain):
                refresh.run_watched([sys.executable, "-c", "pass"], dict(os.environ), str(self.base),
                                    time.monotonic() + 30, [], poll_s=0.1, grace_s=1)

    def test_unreadable_descriptor_refuses_the_holder_scan(self):
        # Residual F1 (Codex witness 2): EIO on one descriptor is not "no holder".
        source = self.base / "holder-source"
        source.write_text("x")
        fd = self.base / "proc" / "4242" / "fd" / "3"
        fd.parent.mkdir(parents=True)
        fd.write_text("x")
        real_stat = os.stat

        def broken(path, *a, **k):
            if str(path) == str(fd):
                raise OSError(errno.EIO, "injected descriptor inspection error")
            return real_stat(path, *a, **k)

        with mock.patch.object(refresh.os, "stat", side_effect=broken):
            with self.assertRaises(refresh.Refused) as ctx:
                refresh.source_holders(str(source), set(), self.base / "proc")
        self.assertEqual(ctx.exception.code, "HOLDER_SCAN_FAILED")

    def test_vanished_descriptor_is_still_skipped(self):
        source = self.base / "holder-source"
        source.write_text("x")
        fd_dir = self.base / "proc" / "4242" / "fd"
        fd_dir.mkdir(parents=True)
        os.symlink(self.base / "gone", fd_dir / "3")    # dangling: the descriptor closed mid-scan
        self.assertEqual(refresh.source_holders(str(source), set(), self.base / "proc"), [])

    def test_space_watchdog_stops_build(self):
        slow = executable(self.base / "bin" / "slowpython", f"""
            #!/bin/sh
            exec {sys.executable} -c "import time; time.sleep(120)"
        """)
        done, status = self.run_refresh(**{"--python": str(slow), "--abort-free-output-bytes": str(1 << 62)})
        self.assertEqual(status["rollup_status"], "failed-before-activation")
        self.assertIn("free space", status["detail"])

    def test_builder_failure_removes_owned_outputs(self):
        failing = executable(self.base / "bin" / "failpython", """
            #!/bin/sh
            exit 7
        """)
        _, status = self.run_refresh(**{"--python": str(failing)})
        self.assertEqual(status["rollup_status"], "failed-before-activation")
        self.assertIn("builder exit 7", status["detail"])
        self.assertFalse(any(n.endswith(".building") for n in self.artifacts()))

    def test_candidate_freshness_failure_never_activates(self):
        _, status = self.run_refresh(extra_env={"FRESHNESS_FORCE_FAIL": "all"})
        self.assertEqual(status["rollup_status"], "failed-before-activation")
        self.assertEqual(self.live_target(), str(self.prior))
        self.assertFalse(any("2026100" in n or "2026110" in n for n in self.artifacts() if n != self.prior.name))

    def test_unverifiable_containment_is_uncertain_and_retains_artifacts(self):
        done, status = self.run_refresh(extra_env={"FRESHNESS_FORCE_FAIL": "live"})
        self.assertEqual(done.returncode, refresh.EXIT_UNCERTAIN, done.stdout)
        self.assertEqual(status["rollup_status"], "uncertain")
        self.assertIn("containment not verified", status["detail"])
        self.assertIn(self.older.name, self.artifacts(), "no pruning when the outcome is uncertain")
        new = self.new_artifacts()
        self.assertEqual(len(new), 1)
        self.assertIn(new[0], self.held_names())

    def test_failed_live_check_contains_to_proven_stale_prior(self):
        done, status = self.run_refresh(extra_env={"FRESHNESS_FORCE_FAIL": "live-new"})
        self.assertEqual(done.returncode, refresh.EXIT_CONTAINED, done.stdout)
        self.assertEqual(status["rollup_status"], "contained", status)
        self.assertEqual(self.live_target(), str(self.prior))
        new = self.new_artifacts()
        self.assertEqual(len(new), 1, "new artifact retained as evidence")
        self.assertIn(new[0], self.held_names(), "retained evidence registered in the hold list")
        self.assertIn(self.older.name, self.artifacts(), "no pruning after a failed activation")

    def test_failed_prior_read_never_swaps_and_holds_the_new_artifact(self):
        # F4: the observed prior's generation cannot be read, so its mismatch is unproved.
        (self.shared / (self.prior.name + ".generation")).unlink()
        done, status = self.run_refresh(extra_env={"FRESHNESS_FORCE_FAIL": "live-new"})
        self.assertEqual(done.returncode, refresh.EXIT_UNCERTAIN, done.stdout)
        self.assertEqual(status["rollup_status"], "uncertain")
        self.assertIn("prior generation unreadable, no swap", status["detail"])
        new = self.new_artifacts()
        self.assertEqual(len(new), 1)
        self.assertEqual(os.path.basename(self.live_target()), new[0], "no containment swap happened")
        self.assertIn(new[0], self.held_names())
        receipt = read_json(status["receipt"])
        self.assertNotIn("containment", [s["step"] for s in receipt["steps"]])

    def test_held_evidence_survives_a_later_successful_prune(self):
        # F4 across attempts: attempt 1 is contained and its artifact held; attempt 2 succeeds and
        # prunes, but must not delete attempt 1's unresolved evidence.
        _, first = self.run_refresh(extra_env={"FRESHNESS_FORCE_FAIL": "live-new"})
        self.assertEqual(first["rollup_status"], "contained", first)
        evidence = self.new_artifacts()
        self.assertEqual(len(evidence), 1)
        self.status.unlink()
        done, second = self.run_refresh()
        self.assertEqual(second["rollup_status"], "applied", done.stdout + done.stderr)
        names = self.artifacts()
        self.assertIn(evidence[0], names, "held evidence of the earlier attempt was pruned")
        self.assertIn(evidence[0] + ".generation", names)
        self.assertNotIn(self.older.name, names)       # ordinary pruning still happens
        self.assertIn(self.held.name, names)

    def test_route_check_mismatch_is_refused(self):
        builder = refresh.load_builder()
        out = self.base / "check.db"
        subprocess.run([sys.executable, str(SCRIPTS / "build-nibrs-rollups.py"), "--source", str(self.target),
                        "--output", str(out), "--source-generation", "g"], check=True, capture_output=True)
        c = sqlite3.connect(out)
        c.execute("UPDATE state_summary_victim_weapon SET victim_count = victim_count + 1 WHERE state='TX'")
        c.commit()
        c.close()
        with self.assertRaises(refresh.Refused) as ctx:
            refresh.route_checks(str(out), str(self.target), builder)
        self.assertEqual(ctx.exception.code, "ROUTE_CHECK_MISMATCH")


class InheritedOwnership(RefreshFixture):
    def parent_runs_refresh(self, phase="published", attempt="upd-1", child_attempt="upd-1"):
        code = textwrap.dedent(f"""
            import json, os, subprocess, sys
            sys.path.insert(0, {str(SCRIPTS)!r})
            import nibrs_maintenance_lock as ml
            h = ml.acquire('nibrs-auto-update', {attempt!r})
            h.set_phase({phase!r})
            env = dict(os.environ); env[ml.FD_ENV] = str(h.fd); env[ml.ATTEMPT_ENV] = {child_attempt!r}
            args = json.loads(sys.argv[1])
            p = subprocess.run([sys.executable, {str(REFRESH)!r}, '--inherit-lock', '--attempt-id', {child_attempt!r}] + args,
                               env=env, pass_fds=(h.fd,))
            # the parent still holds the lock after the child returns
            print('PARENT_STILL_HOLDS', ml.lock_is_held_elsewhere())
            sys.exit(p.returncode)
        """)
        done = subprocess.run([sys.executable, "-c", code, json.dumps(self.args())], env=self.env,
                              capture_output=True, text=True, timeout=600)
        return done, (read_json(self.status) if self.status.exists() else {})

    def test_inherited_lock_applies(self):
        done, status = self.parent_runs_refresh()
        self.assertEqual(status.get("rollup_status"), "applied", done.stdout + done.stderr)
        self.assertIn("PARENT_STILL_HOLDS True", done.stdout)

    def test_inherited_wrong_phase_refused(self):
        _, status = self.parent_runs_refresh(phase="running")
        self.assertEqual(status["rollup_status"], "refused")
        self.assertIn("phase", status["detail"])

    def test_inherited_wrong_attempt_refused(self):
        _, status = self.parent_runs_refresh(child_attempt="upd-2")
        self.assertEqual(status["rollup_status"], "refused")


if __name__ == "__main__":
    unittest.main()
