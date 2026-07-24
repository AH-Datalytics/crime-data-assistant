#!/usr/bin/env python3
"""Replay eligible May-July slow NIBRS SQL against the compact rollup DB."""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import statistics
import time
from pathlib import Path


TABLES = (
    "summary_arrestee_demographics", "summary_victim_demographics",
    "summary_offender_demographics", "summary_victim_relationship",
    "summary_victim_weapon", "summary_victim_circumstance",
    "summary_victim_weapon_circumstance_demo", "summary_clearance_type",
    "summary_clearance_detail",
)
BLOCKED = re.compile(r"\b(?:ori|agencies|agency_county_crosswalk|nibrs_(?:consistent_reporters|agency_completeness)|city|county)\b", re.I)


def route(sql: str) -> tuple[str, str] | None:
    cleaned = re.sub(r"'(?:''|[^'])*'", "''", sql)
    sources = [table for table in TABLES if re.search(rf"\b(?:FROM|JOIN)\s+(?:main\.)?{table}\b", cleaned, re.I)]
    if len(sources) != 1 or BLOCKED.search(cleaned):
        return None
    level = "state" if re.search(r"\bstate\b", cleaned, re.I) else "national"
    return re.sub(rf"(\b(?:FROM|JOIN)\s+)(?:main\.)?{sources[0]}\b", rf"\1rollup.{level}_{sources[0]}", sql, flags=re.I), level


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, int(len(ordered) * pct + 0.999999) - 1))]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--query-log", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--rollup", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--start", default="2026-05-01")
    parser.add_argument("--end", default="2026-08-01")
    parser.add_argument("--min-baseline-ms", type=int, default=10_000)
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--timeout-seconds", type=float, default=30.0)
    args = parser.parse_args()

    log = sqlite3.connect(f"{args.query_log.resolve().as_uri()}?mode=ro", uri=True)
    corpus = log.execute("""
      SELECT id, question, sql, ms FROM query_log
      WHERE tab='nibrs' AND sql IS NOT NULL AND ms >= ?
        AND ts >= CAST(strftime('%s', ?) AS INTEGER) * 1000
        AND ts < CAST(strftime('%s', ?) AS INTEGER) * 1000
      ORDER BY ms DESC LIMIT ?
    """, (args.min_baseline_ms, args.start, args.end, args.limit)).fetchall()
    log.close()

    db = sqlite3.connect(f"{args.source.resolve().as_uri()}?mode=ro", uri=True)
    db.execute("ATTACH DATABASE ? AS rollup", (f"{args.rollup.resolve().as_uri()}?mode=ro",))
    db.execute("PRAGMA query_only=ON")
    results = []
    for query_id, question, sql, baseline_ms in corpus:
        routed = route(sql)
        if not routed:
            continue
        routed_sql, level = routed
        deadline = time.monotonic() + args.timeout_seconds
        db.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 10_000)
        started = time.perf_counter()
        try:
            rows = db.execute(routed_sql).fetchall()
            elapsed_ms = (time.perf_counter() - started) * 1000
            results.append({"id": query_id, "question": question, "level": level, "baseline_ms": baseline_ms, "rollup_ms": round(elapsed_ms, 3), "rows": len(rows), "error": None})
        except sqlite3.Error as exc:
            results.append({"id": query_id, "question": question, "level": level, "baseline_ms": baseline_ms, "rollup_ms": None, "rows": 0, "error": str(exc)})
    db.set_progress_handler(None, 0)
    db.close()

    successful = [row for row in results if row["rollup_ms"] is not None]
    rollup_times = [row["rollup_ms"] for row in successful]
    baseline_times = [row["baseline_ms"] for row in successful]
    report = {
        "window": {"start": args.start, "end_exclusive": args.end},
        "corpus_candidates": len(corpus),
        "eligible": len(results),
        "successful": len(successful),
        "failed": len(results) - len(successful),
        "baseline_ms": {"median": round(statistics.median(baseline_times), 3) if baseline_times else 0, "p95": percentile(baseline_times, .95)},
        "rollup_ms": {"median": round(statistics.median(rollup_times), 3) if rollup_times else 0, "p95": percentile(rollup_times, .95), "max": max(rollup_times, default=0)},
        "queries": results,
    }
    rendered = json.dumps(report, indent=2)
    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 1 if report["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
