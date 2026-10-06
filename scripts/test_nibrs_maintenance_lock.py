#!/usr/bin/env python3
"""Tests for the shared maintenance-ownership lock (Linux container)."""

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import nibrs_maintenance_lock as ml  # noqa: E402

SCRIPTS = Path(__file__).resolve().parent


class LockTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.lock = Path(self.tmp.name) / "maintenance.lock"
        os.environ["NIBRS_MAINTENANCE_LOCK"] = str(self.lock)

    def tearDown(self):
        os.environ.pop("NIBRS_MAINTENANCE_LOCK", None)
        self.tmp.cleanup()

    def test_exclusive_and_owner_record(self):
        h = ml.acquire("updater", "attempt-1")
        try:
            owner = ml.read_owner()
            self.assertEqual(owner["attempt_id"], "attempt-1")
            self.assertEqual(owner["pid"], os.getpid())
            self.assertTrue(ml.lock_is_held_elsewhere())
            with self.assertRaises(ml.LockError):
                ml.acquire("other", "attempt-2", wait_seconds=0)
        finally:
            h.release()
        self.assertFalse(ml.lock_is_held_elsewhere())

    def test_waits_then_obtains(self):
        holder = subprocess.Popen([sys.executable, "-c", textwrap.dedent(f"""
            import sys, time; sys.path.insert(0, {str(SCRIPTS)!r})
            import nibrs_maintenance_lock as ml
            h = ml.acquire('holder', 'h'); print('held', flush=True); time.sleep(1.5); h.release()
        """)], stdout=subprocess.PIPE, text=True, env=dict(os.environ))
        self.assertEqual(holder.stdout.readline().strip(), "held")
        h = ml.acquire("waiter", "w", wait_seconds=10, poll=0.1)
        h.release()
        holder.wait()

    def _child_adopt(self, attempt, phase, fd_env=True):
        code = textwrap.dedent(f"""
            import sys; sys.path.insert(0, {str(SCRIPTS)!r})
            import nibrs_maintenance_lock as ml
            try:
                ml.adopt_inherited('refresh', {attempt!r}, {phase!r}); print('ADOPTED')
            except ml.LockError as e:
                print('REFUSED', e)
        """)
        h = ml.acquire("updater", "attempt-9")
        h.set_phase("published")
        env = dict(os.environ)
        if fd_env:
            env[ml.FD_ENV] = str(h.fd)
        try:
            out = subprocess.run([sys.executable, "-c", code], env=env, pass_fds=(h.fd,),
                                 capture_output=True, text=True, timeout=30).stdout.strip()
        finally:
            h.release()
        return out

    def test_adopt_inherited_matching(self):
        self.assertEqual(self._child_adopt("attempt-9", "published"), "ADOPTED")

    def test_adopt_refuses_wrong_attempt(self):
        self.assertTrue(self._child_adopt("attempt-X", "published").startswith("REFUSED"))

    def test_adopt_refuses_wrong_phase(self):
        self.assertTrue(self._child_adopt("attempt-9", "running").startswith("REFUSED"))

    def test_adopt_refuses_without_descriptor(self):
        self.assertTrue(self._child_adopt("attempt-9", "published", fd_env=False).startswith("REFUSED"))

    def test_held_context_runs_unlocked_without_directory(self):
        os.environ["NIBRS_MAINTENANCE_LOCK"] = str(Path(self.tmp.name) / "missing-dir" / "maintenance.lock")
        with ml.held("coverage") as h:
            self.assertIsNone(h)

    def test_held_context_locks_on_server_layout(self):
        with ml.held("coverage") as h:
            self.assertIsNotNone(h)
            self.assertTrue(ml.lock_is_held_elsewhere())
            self.assertEqual(json.loads(ml.owner_path().read_text())["program"], "coverage")
        self.assertFalse(ml.lock_is_held_elsewhere())


if __name__ == "__main__":
    unittest.main()
