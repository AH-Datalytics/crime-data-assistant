#!/usr/bin/env python3
"""IB-1 tests for nibrs-auto-update.py: Part A population stage, checkpoint settlement, the
server-rollup stage, restart/outcome reporting, and the order of these stages inside main().

Runs in a disposable Linux container. Nothing contacts PM2, CDE or a production database.
"""

import ast
import importlib.util
import json
import os
import re
import secrets
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

from ib1_fixtures import executable, pm2_stub  # noqa: E402
import nibrs_maintenance_lock as ml  # noqa: E402


def load_updater():
    name = "nibrs_auto_update_under_test"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / "nibrs-auto-update.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


U = load_updater()


def live_processes(marker: bytes) -> list[str]:
    """Non-zombie processes whose command line contains marker."""
    found = []
    for entry in os.listdir("/proc"):
        if entry.isdigit():
            try:
                cmd = Path(f"/proc/{entry}/cmdline").read_bytes()
                state = Path(f"/proc/{entry}/stat").read_text().rsplit(")", 1)[1].split()[0]
            except (OSError, IndexError):
                continue
            if marker in cmd and state != "Z":
                found.append(entry)
    return found


class PopulationStage(unittest.TestCase):
    def test_failed_preflight_never_drops_the_table(self):
        calls = []
        status = U.population_stage(object(), ensure=lambda c: calls.append("ensure"),
                                    preflight=lambda: (False, "NODE_MODULE_VERSION 127 vs 137"),
                                    extend=lambda: calls.append("extend") or "ok")
        self.assertEqual(status, "failed-preflight")
        self.assertEqual(calls, [])

    def test_failed_extension_is_a_failed_step(self):
        calls = []
        status = U.population_stage(object(), ensure=lambda c: calls.append("ensure"),
                                    preflight=lambda: (True, "ok"), extend=lambda: "failed")
        self.assertEqual(status, "failed")
        self.assertEqual(calls, ["ensure"])

    def test_success(self):
        order = []
        status = U.population_stage(object(), ensure=lambda c: order.append("ensure"),
                                    preflight=lambda: order.append("preflight") or (True, "ok"),
                                    extend=lambda: order.append("extend") or "ok",
                                    verify=lambda c: order.append("verify") or ("ok", "complete"))
        self.assertEqual(status, "ok")
        self.assertEqual(order, ["preflight", "ensure", "extend", "verify"])

    def test_clean_exit_with_missing_rows_is_partial(self):
        status = U.population_stage(object(), ensure=lambda c: None, preflight=lambda: (True, "ok"),
                                    extend=lambda: "ok", verify=lambda c: ("partial", "5 missing"))
        self.assertEqual(status, "partial")


def population_db(path, historical_through=2024, cde_years=(2025, 2026), drop=()):
    """state_population as ensure_state_population + the extension leave it."""
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE state_population (state TEXT, state_name TEXT, year INT, population INT, "
               "source TEXT, PRIMARY KEY (state, year))")
    for state in U.POPULATION_KEYS:
        db.execute("INSERT INTO state_population VALUES (?,?,?,?,?)",
                   (state, state, historical_through, 1000, "Historical Library historical_state_national population"))
        for year in cde_years:
            if (state, year) not in drop:
                db.execute("INSERT INTO state_population VALUES (?,?,?,?,?)",
                           (state, state, year, 1000, "FBI CDE API populations.population"))
    db.commit()
    return db


class PopulationVerification(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "nibrs.db"

    def tearDown(self):
        self.tmp.cleanup()

    def test_keys_match_lib_state_population(self):
        text = (SCRIPTS.parent / "lib" / "state-population.ts").read_text(encoding="utf-8")
        block = text.split("STATE_NAME_TO_ABBR", 1)[1].split("};", 1)[0]
        self.assertEqual(set(re.findall(r':\s*"([A-Z]{2})"', block)), set(U.POPULATION_KEYS))
        self.assertEqual(len(U.POPULATION_KEYS), 52)

    def test_complete(self):
        db = population_db(self.path)
        self.assertEqual(U.verify_state_population(db, current_year=2026)[0], "ok")

    def test_missing_state_year_is_partial(self):
        db = population_db(self.path, drop={("WY", 2026), ("US", 2025)})
        status, detail = U.verify_state_population(db, current_year=2026)
        self.assertEqual(status, "partial")
        self.assertIn("2 of 104", detail)

    def test_zero_population_is_partial(self):
        db = population_db(self.path)
        db.execute("UPDATE state_population SET population = 0 WHERE state='TX' AND year=2026")
        self.assertEqual(U.verify_state_population(db, current_year=2026)[0], "partial")

    def test_expected_range_follows_the_last_historical_year(self):
        # Same range as the extension: last non-CDE year + 1 through the current year.
        db = population_db(self.path, cde_years=(2025,))
        self.assertEqual(U.verify_state_population(db, current_year=2026)[0], "partial")  # 2026 missing
        db.execute("INSERT INTO state_population VALUES ('TX','TX',2026,5,'Historical Library x')")
        self.assertEqual(U.verify_state_population(db, current_year=2026)[0], "ok")       # nothing expected

    def test_unreadable_table_is_unverified(self):
        db = sqlite3.connect(self.path)
        self.assertEqual(U.verify_state_population(db, current_year=2026)[0], "unverified")

    def test_partial_fetch_with_exit_zero_is_not_ok(self):
        # Codex's F3 witness, offline: the extension exits 0 and prints applied JSON after writing
        # only part of the rows (its 90% acceptance). The stage must not report ok.
        db = population_db(self.path, drop={(s, 2026) for s in ("AK", "AL", "AR", "AZ")})
        node = executable(Path(self.tmp.name) / "node", """
            #!/bin/sh
            echo '{"applied":true,"rows":100,"years":[2025,2026]}'
            exit 0
        """)
        app = Path(self.tmp.name) / "release"
        app.mkdir()
        status = U.population_stage(
            db, ensure=lambda c: None, preflight=lambda: (True, "ok"),
            extend=lambda: U.run_population_extension(str(self.path), str(app), str(node)),
            verify=lambda c: U.verify_state_population(c, current_year=2026))
        self.assertEqual(status, "partial")


class PopulationPreflightAndRun(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        app = self.app = Path(self.tmp.name) / "release"
        (app / "scripts").mkdir(parents=True)
        (app / "scripts" / "extend-state-population-cde.ts").write_text("// stub")
        (app / "node_modules" / "tsx" / "dist").mkdir(parents=True)
        (app / "node_modules" / "tsx" / "dist" / "cli.mjs").write_text("// stub")
        (app / "node_modules" / "better-sqlite3").mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def node(self, code, out):
        return str(executable(Path(self.tmp.name) / f"node{code}", f"""
            #!/bin/sh
            echo '{out}' 1>&2
            echo '{out}'
            exit {code}
        """))

    def test_abi_mismatch_fails_preflight(self):
        ok, detail = U.population_extension_preflight(str(self.app), self.node(1, "NODE_MODULE_VERSION 127 requires 137"))
        self.assertFalse(ok)
        self.assertIn("NODE_MODULE_VERSION", detail)

    def test_preflight_ok(self):
        ok, detail = U.population_extension_preflight(str(self.app), self.node(0, "abi=137"))
        self.assertTrue(ok, detail)

    def test_missing_bundle_fails_preflight(self):
        (self.app / "node_modules" / "tsx" / "dist" / "cli.mjs").unlink()
        ok, detail = U.population_extension_preflight(str(self.app), self.node(0, "abi=137"))
        self.assertFalse(ok)
        self.assertIn("missing", detail)

    def test_extension_runs_from_release_and_reports(self):
        self.assertEqual(U.run_population_extension("/x/nibrs.db", str(self.app), self.node(0, '{"applied":true}')), "ok")
        self.assertEqual(U.run_population_extension("/x/nibrs.db", str(self.app), self.node(1, "boom")), "failed")


class Settlement(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "nibrs.db"
        sqlite3.connect(self.db).close()

    def tearDown(self):
        self.tmp.cleanup()

    def test_settled(self):
        self.assertTrue(U.checkpoint_settled((0, 5, 5), str(self.db))[0])

    def test_busy_or_partial_is_not_settled(self):
        self.assertFalse(U.checkpoint_settled((1, 5, 5), str(self.db))[0])
        self.assertFalse(U.checkpoint_settled((0, 5, 3), str(self.db))[0])
        self.assertFalse(U.checkpoint_settled(None, str(self.db))[0])

    def test_remaining_wal_is_not_settled(self):
        Path(str(self.db) + "-wal").write_bytes(b"\0" * 32)
        ok, detail = U.checkpoint_settled((0, 0, 0), str(self.db))
        self.assertFalse(ok)
        self.assertIn("-wal", detail)


class ServerRollupStage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        os.environ["NIBRS_MAINTENANCE_LOCK"] = str(self.base / "maintenance.lock")
        self.holding = ml.acquire("nibrs-auto-update", "upd-test")

    def tearDown(self):
        self.holding.release()
        os.environ.pop("NIBRS_MAINTENANCE_LOCK", None)
        self.tmp.cleanup()

    def test_unsettled_source_skips(self):
        self.assertEqual(U.run_server_rollups(self.holding, False, status_dir=str(self.base)), "skipped-unsettled")

    def test_child_inherits_the_held_lock_and_reports_status(self):
        stub = executable(self.base / "refresh_stub.py", f"""
            #!{sys.executable}
            import json, os, sys
            sys.path.insert(0, {str(SCRIPTS)!r})
            import nibrs_maintenance_lock as ml
            args = sys.argv[1:]
            status_file = args[args.index('--status-file') + 1]
            h = ml.adopt_inherited('refresh', os.environ[ml.ATTEMPT_ENV], 'published')
            json.dump({{'rollup_status': 'applied', 'fd': h.fd}}, open(status_file, 'w'))
        """)
        status = U.run_server_rollups(self.holding, True, refresh_script=str(stub), status_dir=str(self.base))
        self.assertEqual(status, "applied")
        self.assertEqual(ml.read_owner()["phase"], "published")

    def detached_child_stub(self, name, then):
        """A refresh stand-in that starts a 'builder' in its own session (as the real refresh does),
        carrying the attempt id in its command line, and then does `then`."""
        return executable(self.base / name, f"""
            #!{sys.executable}
            import json, subprocess, sys, time
            args = sys.argv[1:]
            subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)',
                              '/runs/upd-test/build-receipt.json'], start_new_session=True)
            {then}
        """)

    def test_timeout_kills_the_refresh_group_then_disposes_of_the_detached_build(self):
        stub = self.detached_child_stub("slow_stub.py", "time.sleep(120)")
        restarts = []
        started = time.monotonic()
        tail = U.finish_changed_run(
            self.holding, True, True, publish=lambda: None,
            run_rollups=lambda h, s: U.run_server_rollups(h, s, refresh_script=str(stub), timeout=2,
                                                          status_dir=str(self.base)),
            killer=lambda a: U.kill_attempt_processes(a, grace=5),
            restart=lambda: restarts.append(1) or "up")
        self.assertLess(time.monotonic() - started, 90)
        self.assertEqual(tail["rollups"], "timeout")
        self.assertEqual(restarts, [1], "quiescence proved, so the app is restarted")
        self.assertEqual(live_processes(b"/runs/upd-test/"), [])

    def test_failed_refresh_leaving_a_child_is_disposed_of_before_restart(self):
        # Updater-level witness of F1: the refresh fails after spawning a detached child that it
        # did not reap (the old watchdog-error path). The updater must find and kill it before any
        # restart, and must report the refresh outcome as degraded.
        stub = self.detached_child_stub("leaky_stub.py", """
            status_file = args[args.index('--status-file') + 1]
            json.dump({'rollup_status': 'refused'}, open(status_file, 'w'))
            sys.exit(13)
        """)
        order = []

        def killer(attempt):
            order.append(("killer", tuple(live_processes(b"/runs/upd-test/"))))
            return U.kill_attempt_processes(attempt, grace=5)

        tail = U.finish_changed_run(
            self.holding, True, True, publish=lambda: None,
            run_rollups=lambda h, s: U.run_server_rollups(h, s, refresh_script=str(stub),
                                                          status_dir=str(self.base)),
            killer=killer, restart=lambda: order.append(("restart", tuple(live_processes(b"/runs/upd-test/")))) or "up")
        self.assertEqual(tail["rollups"], "refused")
        self.assertEqual([o[0] for o in order], ["killer", "restart"])
        self.assertNotEqual(order[0][1], (), "the detached child was running when the updater checked")
        self.assertEqual(order[1][1], (), "no attempt process remained at restart")


class FinishChangedRun(unittest.TestCase):
    """Publication, rollup stage and restart decision, with every effect stubbed."""

    class Holding:
        attempt_id = "upd-unit"

    def run_tail(self, settled=True, enabled=True, rollups="applied", survivors=(), killer=None):
        calls = []
        tail = U.finish_changed_run(
            self.Holding(), settled, enabled,
            publish=lambda: calls.append("publish"),
            run_rollups=lambda h, s: calls.append(("rollups", s)) or rollups,
            killer=killer or (lambda a: calls.append("killer") or list(survivors)),
            restart=lambda: calls.append("restart") or "up")
        return tail, calls

    def test_settled_publishes_builds_disposes_and_restarts(self):
        tail, calls = self.run_tail()
        self.assertEqual(calls, ["publish", ("rollups", True), "killer", "restart"])
        self.assertEqual(tail, {"publication": "published", "rollups": "applied", "restart": "up"})

    def test_busy_checkpoint_withholds_publication(self):
        # F3: an unsettled source is never published, whether or not rollups are enabled.
        for enabled in (False, True):
            tail, calls = self.run_tail(settled=False, enabled=enabled, rollups="skipped-unsettled")
            self.assertNotIn("publish", calls)
            self.assertEqual(tail["publication"], "withheld-unsettled")
            self.assertIn("restart", calls)
            if enabled:
                self.assertIn(("rollups", False), calls)

    def test_disabled_never_runs_the_stage(self):
        tail, calls = self.run_tail(enabled=False)
        self.assertEqual(calls, ["publish", "restart"])
        self.assertEqual(tail["rollups"], "disabled")

    def test_survivors_block_the_restart(self):
        tail, calls = self.run_tail(survivors=[4242])
        self.assertNotIn("restart", calls)
        self.assertEqual(tail["restart"], "not-restarted-children-remain")

    def test_unknown_quiescence_blocks_the_restart(self):
        tail, calls = self.run_tail(killer=lambda a: None)
        self.assertNotIn("restart", calls)
        self.assertEqual(tail["restart"], "not-restarted-children-remain")

    def test_refresh_reporting_children_remain_blocks_the_restart(self):
        tail, calls = self.run_tail(rollups="children-remain")
        self.assertIn("killer", calls)
        self.assertNotIn("restart", calls)

    def test_stage_exception_still_disposes_and_decides(self):
        calls = []

        def boom(h, s):
            raise RuntimeError("refresh could not start")

        tail = U.finish_changed_run(self.Holding(), True, True, publish=lambda: None, run_rollups=boom,
                                    killer=lambda a: calls.append("killer") or [],
                                    restart=lambda: calls.append("restart") or "up")
        self.assertEqual(calls, ["killer", "restart"])
        self.assertTrue(tail["rollups"].startswith("error:"))

    def test_failed_publication_does_not_build(self):
        calls = []

        def fail():
            raise OSError("disk full")

        tail = U.finish_changed_run(self.Holding(), True, True, publish=fail,
                                    run_rollups=lambda h, s: calls.append(s) or "skipped-unsettled",
                                    killer=lambda a: [], restart=lambda: "up")
        self.assertEqual(calls, [False])
        self.assertTrue(tail["publication"].startswith("failed:"))


class ProcessDispositionAndRestart(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_unreadable_process_table_is_unknown_not_empty(self):
        self.assertIsNone(U.kill_attempt_processes("x", proc_root=str(self.dir / "no-proc"), grace=1))

    def test_restart_health_uses_the_shared_pm2_parser(self):
        self.assertEqual(U.restart_and_check(pm2_bin=str(pm2_stub(self.dir, "0\n1234"))), "up")
        self.assertEqual(U.restart_and_check(pm2_bin=str(pm2_stub(self.dir, "0\n0"))), "down")
        self.assertEqual(U.restart_and_check(pm2_bin=str(pm2_stub(self.dir, ""))), "health-unknown")
        self.assertEqual(U.restart_and_check(pm2_bin=str(pm2_stub(self.dir, "0", exit_code=1))), "restart-failed")

    def test_restart_is_bounded(self):
        hang = executable(self.dir / "pm2hang", """
            #!/bin/sh
            exec sleep 30
        """)
        started = time.monotonic()
        self.assertEqual(U.restart_and_check(pm2_bin=str(hang), timeout=1), "restart-unknown")
        self.assertLess(time.monotonic() - started, 20)


class Outcome(unittest.TestCase):
    def test_degraded_is_explicit(self):
        with tempfile.TemporaryDirectory() as tmp:
            U.STATUS_FILE = str(Path(tmp) / "update-status.json")
            ok = {"import": "ok", "population": "ok", "publication": "published", "rollups": "disabled",
                  "restart": "up"}
            self.assertEqual(U.report_outcome(**ok), "ok")
            self.assertEqual(U.report_outcome(**{**ok, "population": "failed"}), "degraded")
            self.assertEqual(U.report_outcome(**{**ok, "population": "partial"}), "degraded")
            self.assertEqual(U.report_outcome(**{**ok, "restart": "not-restarted-children-remain"}), "degraded")
            self.assertEqual(U.report_outcome(**{**ok, "publication": "withheld-unsettled"}), "degraded")
            self.assertEqual(U.report_outcome(**{**ok, "rollups": "contained"}), "degraded")
            saved = json.loads(Path(U.STATUS_FILE).read_text())
            self.assertEqual(saved["degraded"], ["rollups"])


class MainStructure(unittest.TestCase):
    """Order and placement inside main(), read from the source with the parser."""

    @classmethod
    def setUpClass(cls):
        source = (SCRIPTS / "nibrs-auto-update.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main")
        cls.text = ast.get_source_segment(source, main)
        cls.source = source

    def pos(self, needle, start=0):
        i = self.text.find(needle, start)
        self.assertGreaterEqual(i, 0, f"{needle!r} not found in main()")
        return i

    def test_lock_taken_before_any_stop(self):
        self.assertLess(self.pos("nibrs_maintenance_lock.acquire("), self.pos('["pm2", "stop", "nibrs"]'))

    def test_population_stage_between_summaries_and_reporters(self):
        changed = self.pos("Stopping nibrs app for update")
        a = self.pos("retry(rebuild_summaries, conn, affected_years", changed)
        b = self.pos("population_status = population_stage(conn)", changed)
        c = self.pos("retry(rebuild_consistent_reporters", changed)
        self.assertTrue(a < b < c)

    def test_old_repo_invocation_is_gone(self):
        self.assertNotIn('cwd="/opt/nibrs/repo"', self.source)
        self.assertNotIn('["npx", "tsx", "scripts/extend-state-population-cde.ts"', self.source)

    def test_settle_then_one_tail_then_outcome(self):
        changed = self.pos("Stopping nibrs app for update")
        settle = self.pos("checkpoint_settled(checkpoint)", changed)
        tail = self.pos("finish_changed_run(holding, settled, server_rollups_enabled(args))", settle)
        outcome = self.pos("report_outcome(", tail)
        self.assertTrue(settle < tail < outcome)
        # the changed path no longer publishes, builds or restarts outside finish_changed_run
        for direct in ("publish_source_generation()", "run_server_rollups(", "restart_and_check("):
            self.assertNotIn(direct, self.text[changed:])

    def test_no_changes_branch_never_builds(self):
        start = self.pos("No changes detected. Nothing to do.")
        end = self.pos("return", start)
        self.assertNotIn("run_server_rollups", self.text[start:end])

    def test_server_rollups_default_off(self):
        class A:
            server_rollups = False
        os.environ.pop("NIBRS_SERVER_ROLLUPS", None)
        self.assertFalse(U.server_rollups_enabled(A()))
        os.environ["NIBRS_SERVER_ROLLUPS"] = "1"
        try:
            self.assertTrue(U.server_rollups_enabled(A()))
        finally:
            os.environ.pop("NIBRS_SERVER_ROLLUPS", None)


if __name__ == "__main__":
    unittest.main()
