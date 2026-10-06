#!/usr/bin/env python3
"""Tests for the builder's narrow --maintenance-window exception (Linux container).

The fixture source, shared directory and PM2 stub are supplied through the NIBRS_MAINT_*
overrides, which nibrs_maintenance_policy honors only off the production host. The tests that
make this container count as the production host prove those overrides then stop working.
"""

import importlib.util
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import nibrs_maintenance_lock as ml  # noqa: E402
import nibrs_maintenance_policy as policy  # noqa: E402
from ib1_fixtures import make_source, pm2_stub, publish  # noqa: E402

BUILDER = SCRIPTS / "build-nibrs-rollups.py"


class MaintenanceWindowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = self.base = Path(self.tmp.name)
        self.shared = base / "shared"
        self.shared.mkdir()
        self.source = base / "nibrs.db"
        make_source(self.source)
        self.generation = publish(self.source, self.shared)
        self.output = self.shared / "nibrs_rollups-20261106_070000-abcd.db.building"
        self.receipt = base / "build-receipt.json"
        self.env = dict(os.environ)
        self.env.pop("NIBRS_PRODUCTION_HOSTNAMES", None)
        self.env.update({
            "NIBRS_MAINTENANCE_LOCK": str(base / "maintenance.lock"),
            "NIBRS_MAINT_SOURCE_ALIAS": str(self.source),
            "NIBRS_MAINT_SHARED": str(self.shared),
            "NIBRS_MAINT_PM2_BIN": str(pm2_stub(base, "0")),
            "NIBRS_MAINT_APP": "nibrs",
        })
        os.environ["NIBRS_MAINTENANCE_LOCK"] = self.env["NIBRS_MAINTENANCE_LOCK"]
        self.holding = None

    def tearDown(self):
        if self.holding:
            self.holding.release()
        os.environ.pop("NIBRS_MAINTENANCE_LOCK", None)
        self.tmp.cleanup()

    def production_host(self):
        self.env["NIBRS_PRODUCTION_HOSTNAMES"] = socket.gethostname()

    def hold_lock(self, attempt="a1", phase="published"):
        self.holding = ml.acquire("refresh", attempt)
        self.holding.set_phase(phase)

    def write_receipt(self, **overrides):
        st = os.stat(self.source)
        receipt = {
            "attempt_id": "a1", "owner_pid": os.getpid(), "owner_phase": "published", "mode": "activate",
            "source_alias": str(self.source), "source_canonical": str(self.source.resolve()),
            "source_identity": f"{st.st_dev}:{st.st_ino}", "generation": self.generation,
            "output": str(self.output), "created_epoch": time.time(), "nonce": "n",
        }
        receipt.update(overrides)
        self.receipt.write_text(json.dumps(receipt))

    def build(self, *extra, output=None):
        cmd = [sys.executable, str(BUILDER), "--source", str(self.source.resolve()),
               "--output", str(output or self.output), "--source-generation", self.generation, *extra]
        return subprocess.run(cmd, env=self.env, capture_output=True, text=True, timeout=120)

    def maintenance_build(self, output=None):
        return self.build("--maintenance-window", "--receipt", str(self.receipt), output=output)

    def test_default_refusal_unchanged_on_production_host(self):
        self.production_host()
        done = self.build()
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("Refusing heavy rollup build on production web host", done.stderr)
        self.assertFalse(self.output.exists())

    def test_flag_requires_receipt(self):
        done = self.build("--maintenance-window")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("requires --receipt", done.stderr)

    def test_skip_verify_forbidden(self):
        self.hold_lock()
        self.write_receipt()
        done = self.build("--maintenance-window", "--receipt", str(self.receipt), "--skip-verify")
        self.assertIn("--skip-verify is not allowed", done.stderr)

    def test_refused_without_lock(self):
        self.write_receipt()
        done = self.maintenance_build()
        self.assertIn("Maintenance receipt refused", done.stderr)
        self.assertFalse(self.output.exists())

    def test_refused_stale_receipt(self):
        self.hold_lock()
        self.write_receipt(created_epoch=time.time() - 4000)
        self.assertIn("stale", self.maintenance_build().stderr)

    def test_refused_wrong_owner(self):
        self.hold_lock()
        self.write_receipt(attempt_id="someone-else")
        self.assertIn("lock owner does not match", self.maintenance_build().stderr)

    def test_refused_after_owner_moves_past_the_build_phase(self):
        # Codex's F2 witness: lock acquired, receipt issued, owner phase then changed to "restarted".
        self.hold_lock(phase="published")
        self.write_receipt()
        self.holding.set_phase("restarted")
        done = self.maintenance_build()
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("phase 'restarted' does not allow a build", done.stderr)
        self.assertFalse(self.output.exists())

    def test_refused_when_receipt_phase_is_not_a_build_phase(self):
        self.hold_lock(phase="running")
        self.write_receipt(owner_phase="running")
        self.assertIn("phase 'running' does not allow a build", self.maintenance_build().stderr)

    def test_refused_while_app_running(self):
        self.env["NIBRS_MAINT_PM2_BIN"] = str(pm2_stub(self.base, "0\n4242"))
        self.hold_lock()
        self.write_receipt()
        done = self.maintenance_build()
        self.assertIn("app state running", done.stderr)
        self.assertFalse(self.output.exists())

    def test_refused_when_pm2_state_unknown(self):
        self.env["NIBRS_MAINT_PM2_BIN"] = str(pm2_stub(self.base, "", exit_code=1))
        self.hold_lock()
        self.write_receipt()
        self.assertIn("app state unknown", self.maintenance_build().stderr)

    def test_refused_when_source_unsettled(self):
        self.hold_lock()
        self.write_receipt()
        Path(str(self.source) + "-wal").write_bytes(b"\0" * 64)
        done = self.maintenance_build()
        self.assertIn("source not settled: WAL_NOT_EMPTY", done.stderr)
        self.assertFalse(self.output.exists())

    def test_refused_output_outside_directory(self):
        self.hold_lock()
        elsewhere = self.base / "nibrs_rollups-x.db.building"
        self.write_receipt(output=str(elsewhere))
        done = self.maintenance_build(output=elsewhere)
        self.assertIn("is not the receipt's output inside", done.stderr)
        self.assertFalse(elsewhere.exists())

    def test_refused_generation_mismatch(self):
        self.hold_lock()
        self.write_receipt(generation="1:1")
        self.assertIn("generation does not match", self.maintenance_build().stderr)

    def test_production_host_ignores_fixture_overrides(self):
        # On the production host the policy fixes /opt/nibrs paths: the same fixture receipt that
        # builds off production is refused, so the overrides cannot become a production bypass.
        self.production_host()
        self.hold_lock()
        self.write_receipt()
        done = self.maintenance_build()
        self.assertNotEqual(done.returncode, 0)
        self.assertIn(f"is not the policy source '{policy.PRODUCTION_SOURCE_ALIAS}'", done.stderr)
        self.assertFalse(self.output.exists())

    def test_valid_receipt_builds_once_binds_metadata_and_cannot_be_reused(self):
        self.hold_lock()
        self.write_receipt()
        done = self.maintenance_build()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue(self.output.exists())
        self.assertEqual(Path(str(self.output) + ".generation").read_text().strip(), self.generation)
        self.assertTrue(Path(str(self.receipt) + ".used").exists())
        db = sqlite3.connect(self.output)
        meta = dict(db.execute("SELECT key, value FROM rollup_metadata").fetchall())
        db.close()
        self.assertEqual((meta["maintenance_attempt"], meta["maintenance_mode"]), ("a1", "activate"))
        self.output.unlink()
        Path(str(self.output) + ".generation").unlink()
        again = self.maintenance_build()
        self.assertIn("absent or already used", again.stderr)

    def test_operator_phase_is_allowed(self):
        self.hold_lock(phase="operator")
        self.write_receipt(owner_phase="operator", mode="no-activate")
        done = self.maintenance_build()
        self.assertEqual(done.returncode, 0, done.stderr)


class PolicyConstants(unittest.TestCase):
    def test_policy_hostnames_equal_builder_hostnames(self):
        spec = importlib.util.spec_from_file_location("builder_constants", BUILDER)
        module = importlib.util.module_from_spec(spec)
        sys.modules["builder_constants"] = module
        spec.loader.exec_module(module)
        self.assertEqual(policy.PRODUCTION_HOSTNAMES, module.PRODUCTION_HOSTNAMES)


class Pm2Parser(unittest.TestCase):
    """The single PM2 parser shared by the refresh, builder and updater."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def state(self, text, code=0):
        return policy.pm2_state(str(pm2_stub(self.dir, text, code)), "nibrs")[0]

    def test_stopped_single_and_multiworker(self):
        self.assertEqual(self.state("0"), "stopped")
        self.assertEqual(self.state("0\n0\n0"), "stopped")

    def test_running_when_any_worker_has_a_pid(self):
        self.assertEqual(self.state("1234"), "running")
        self.assertEqual(self.state("0\n1234"), "running")

    def test_unknown_is_never_stopped(self):
        self.assertEqual(self.state(""), "unknown")           # PM2 does not know the app
        self.assertEqual(self.state("0", code=1), "unknown")  # failed command
        self.assertEqual(self.state("0\nerror"), "unknown")   # unparseable line
        self.assertEqual(policy.pm2_state(str(self.dir / "absent"), "nibrs")[0], "unknown")


if __name__ == "__main__":
    unittest.main()
