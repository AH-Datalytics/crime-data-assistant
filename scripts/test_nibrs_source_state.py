#!/usr/bin/env python3
"""Fixture tests for nibrs_source_state (the Python port of the accepted O3 guard semantics).

Scenario numbers in names refer to the accepted laptop suite (scripts/test-nibrs-source-state.ps1
in the O3 bundle) where a scenario is ported. Run in a disposable Linux container; some cases need
a non-root user (unreadable files) and are skipped as root.
"""

import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import nibrs_source_state as ss  # noqa: E402
from ib1_fixtures import publish  # noqa: E402

AS_ROOT = os.geteuid() == 0


class SourceStateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.shared = self.base / "shared"
        self.shared.mkdir()
        self.volume = self.base / "volume"
        self.volume.mkdir()
        self.target = self.volume / "nibrs.db"
        self.target.write_bytes(b"nibrs-source-bytes")
        self.alias = self.base / "nibrs.db"
        os.symlink(self.target, self.alias)
        self.link = str(self.shared / "nibrs_rollups.db")

    def tearDown(self):
        for p in self.base.rglob("*"):
            try:
                os.chmod(p, 0o700)
            except OSError:
                pass
        self.tmp.cleanup()

    def inspect(self):
        return ss.inspect(str(self.alias), str(self.shared), self.link)

    def assertRefused(self, code):
        with self.assertRaises(ss.SourceStateError) as ctx:
            self.inspect()
        self.assertEqual(ctx.exception.code, code, str(ctx.exception))
        return ctx.exception

    # Ported scenarios ------------------------------------------------------------------------

    def test_s4_alias_with_clean_target_reports_canonical(self):
        publish(self.alias, self.shared)
        state = self.inspect()
        self.assertEqual(state.canonical, str(self.target))
        self.assertEqual(state.source_bytes, 18)
        self.assertRegex(state.identity, r"^\d+:\d+$")
        self.assertEqual(state.generation, f"18:{os.stat(self.target).st_mtime_ns}")

    def test_s2_zero_length_wal_is_settled(self):
        (self.volume / "nibrs.db-wal").write_bytes(b"")
        publish(self.alias, self.shared)
        self.inspect()

    def test_s3_s16_nonempty_target_wal_behind_alias_refused(self):
        publish(self.alias, self.shared)
        (self.volume / "nibrs.db-wal").write_bytes(b"\0" * 4096)
        self.assertFalse(Path(str(self.alias) + "-wal").exists())
        err = self.assertRefused("WAL_NOT_EMPTY")
        self.assertIn(str(self.volume / "nibrs.db-wal"), err.detail)

    def test_s5_alias_side_rollback_journal_refused(self):
        publish(self.alias, self.shared)
        Path(str(self.alias) + "-journal").write_bytes(b"frames")
        self.assertRefused("WAL_NOT_EMPTY")

    def test_s6_dangling_alias_refused(self):
        self.alias.unlink()
        os.symlink(self.volume / "missing.db", self.alias)
        publish_marker = self.shared / "nibrs_source.generation"
        publish_marker.write_text("1:1\n")
        self.assertRefused("SOURCE_TARGET_MISSING")

    @unittest.skipIf(AS_ROOT, "root can read mode-000 files")
    def test_s7_unreadable_source_refused(self):
        publish(self.alias, self.shared)
        os.chmod(self.target, 0)
        self.assertRefused("SOURCE_UNREADABLE")

    @unittest.skipIf(AS_ROOT, "root can read mode-000 files")
    def test_s8_unreadable_journal_is_an_error_not_zero(self):
        publish(self.alias, self.shared)
        wal = self.volume / "nibrs.db-wal"
        wal.write_bytes(b"frames")
        os.chmod(wal, 0)
        self.assertRefused("JOURNAL_UNREADABLE")

    @unittest.skipIf(AS_ROOT, "root bypasses directory search permission")
    def test_journal_inspection_error_is_not_absence(self):
        # stat() of a path inside an unsearchable directory fails with EACCES, not ENOENT. That is
        # an inspection error, and must never be reported as "no journal".
        hidden = self.base / "hidden"
        hidden.mkdir()
        os.chmod(hidden, 0o600)
        with self.assertRaises(ss.SourceStateError) as ctx:
            ss._journal_size(hidden / "nibrs.db-wal")
        self.assertEqual(ctx.exception.code, "JOURNAL_UNREADABLE")
        self.assertIsNone(ss._journal_size(self.volume / "absent-wal"))

    def test_s9_missing_marker_refused(self):
        self.assertRefused("GENERATION_MARKER_MISSING")

    def test_s13_same_size_unpublished_write_refused(self):
        publish(self.alias, self.shared)
        self.target.write_bytes(b"NIBRS-SOURCE-BYTES")
        os.utime(self.target, ns=(1700000000123456789, 1700000000123456789))
        err = self.assertRefused("GENERATION_STALE")
        self.assertTrue(err.detail.startswith("18:1700000000123456789:"), err.detail)

    def test_s15_marker_never_republished_refused(self):
        (self.shared / "nibrs_source.generation").write_text("178326818816:1789552694193275369\n")
        self.assertRefused("GENERATION_STALE")

    def test_s17_stable_source_observed_twice_unchanged(self):
        publish(self.alias, self.shared)
        a = self.inspect()
        b = self.inspect()
        ss.assert_unchanged(a, b, "test")

    def test_alias_retarget_detected_by_identity(self):
        publish(self.alias, self.shared)
        before = self.inspect()
        other = self.volume / "other.db"
        other.write_bytes(b"nibrs-source-bytes")
        os.utime(other, ns=(before.mtime_ns, before.mtime_ns))
        self.alias.unlink()
        os.symlink(other, self.alias)
        after = self.inspect()  # same size, same mtime, same marker: only identity differs
        with self.assertRaises(ss.SourceStateError) as ctx:
            ss.assert_unchanged(before, after, "publication")
        self.assertEqual(ctx.exception.code, "SOURCE_CHANGED")
        self.assertIn("identity", ctx.exception.detail)

    def test_active_rollup_generation_reported(self):
        publish(self.alias, self.shared)
        art = self.shared / "nibrs_rollups-20260924.db"
        art.write_bytes(b"x")
        (self.shared / "nibrs_rollups-20260924.db.generation").write_text("176727072768:1786871106929227623\n")
        os.symlink(art.name, self.shared / "nibrs_rollups.db")
        state = self.inspect()
        self.assertEqual(state.active_target, str(art))
        self.assertEqual(state.active_generation, "176727072768:1786871106929227623")

    # Ownership replaces "updater running" ----------------------------------------------------

    def test_other_updater_detected(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", "nibrs-auto-update.py"])
        try:
            time.sleep(0.3)
            found = ss.other_updaters({os.getpid()})
            self.assertIn(child.pid, found)
            self.assertNotIn(child.pid, ss.other_updaters({os.getpid(), child.pid}))
        finally:
            child.kill()
            child.wait()

    def test_no_other_updater(self):
        self.assertEqual(ss.other_updaters({os.getpid()}), [])


if __name__ == "__main__":
    unittest.main()
