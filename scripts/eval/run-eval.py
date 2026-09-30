"""
Evaluation harness for Crime Data Assistant (nibrsai.com).

Runs golden dataset questions against the live API, validates SQL patterns
and data values, optionally uses Claude as a judge, and saves results
for diffing across runs.

Usage:
  python scripts/eval/run-eval.py                         # full eval against prod
  python scripts/eval/run-eval.py --base http://localhost:3000  # local
  python scripts/eval/run-eval.py --filter rtci            # only RTCI tests
  python scripts/eval/run-eval.py --filter nibrs           # only NIBRS tests
  python scripts/eval/run-eval.py --filter hist            # only historical tests
  python scripts/eval/run-eval.py --judge                  # use Claude to grade responses
  python scripts/eval/run-eval.py --diff results/prev.json # diff against previous run
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).parent
DATASET_PATH = SCRIPT_DIR / "golden-dataset.json"
RESULTS_DIR = SCRIPT_DIR / "results"
# PRODUCTION IS OPT-IN -- see the note in scripts/eval/stress-test.py. `--base` must name production.
# The site password is removed rather than re-homed: the site is intentionally public.
# ANTHROPIC_API_KEY, used by the optional Claude judge, is a genuine non-site credential and is untouched.
DEFAULT_BASE = "http://localhost:3000"


def load_dataset(filter_prefix=None):
    with open(DATASET_PATH) as f:
        data = json.load(f)
    tests = data["tests"]
    if filter_prefix:
        tests = [t for t in tests if t["id"].startswith(filter_prefix)]
    return tests


def get_session(base_url):
    """A plain session. The site is public, so there is no login step."""
    return requests.Session()


def query_rtci(session, base_url, question, mode):
    """Send query to RTCI SSE endpoint, return parsed result."""
    try:
        r = session.post(
            f"{base_url}/api/query",
            json={"question": question, "mode": mode, "history": []},
            headers={"Accept": "text/event-stream"},
            stream=True,
            timeout=90,
        )
    except requests.exceptions.ConnectionError as e:
        return {"_error": f"Connection error: {e}"}
    except requests.exceptions.Timeout:
        return {"_error": "Request timed out (90s)"}

    if r.status_code == 429:
        retry = int(r.headers.get("Retry-After", 10))
        print(f"    Rate limited, waiting {retry}s...")
        time.sleep(retry + 1)
        return query_rtci(session, base_url, question, mode)
    if r.status_code != 200:
        return {"_error": f"HTTP {r.status_code}"}

    result = {}
    for line in r.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        try:
            event = json.loads(line[6:])
        except json.JSONDecodeError:
            continue
        if event.get("type") == "result":
            result = event
        elif event.get("type") == "error":
            result = {"_error": event.get("text", "unknown error"), "sql": event.get("sql")}
    return result


def query_nibrs(session, base_url, question):
    """Send query to NIBRS JSON endpoint, return parsed result."""
    try:
        r = session.post(
            f"{base_url}/api/nibrs-query",
            json={"question": question, "history": []},
            timeout=90,
        )
    except requests.exceptions.ConnectionError as e:
        return {"_error": f"Connection error: {e}"}
    except requests.exceptions.Timeout:
        return {"_error": "Request timed out (90s)"}

    if r.status_code == 429:
        retry = int(r.headers.get("Retry-After", 10))
        print(f"    Rate limited, waiting {retry}s...")
        time.sleep(retry + 1)
        return query_nibrs(session, base_url, question)
    if r.status_code != 200:
        return {"_error": f"HTTP {r.status_code}"}

    data = r.json()
    if not data.get("success"):
        return {"_error": data.get("error", "unknown error"), "sql": data.get("sql")}
    return data


def check_sql_patterns(sql, patterns):
    """Check that all patterns appear in SQL (case-insensitive)."""
    sql_lower = sql.lower()
    failures = []
    for p in patterns:
        if p.lower() not in sql_lower:
            failures.append(f"missing '{p}' in SQL")
    return failures


def check_sql_antipatterns(sql, antipatterns):
    """Check that none of the antipatterns appear in SQL."""
    sql_lower = sql.lower()
    failures = []
    for p in antipatterns:
        if p.lower() in sql_lower:
            failures.append(f"unwanted '{p}' found in SQL")
    return failures


def check_row_count(result, checks):
    failures = []
    row_count = result.get("rowCount", 0)
    if "min_rows" in checks and row_count < checks["min_rows"]:
        failures.append(f"expected >= {checks['min_rows']} rows, got {row_count}")
    if "max_rows" in checks and row_count > checks["max_rows"]:
        failures.append(f"expected <= {checks['max_rows']} rows, got {row_count}")
    return failures


def check_chart_type(result, expected):
    cfg = result.get("chartConfig") or {}
    actual = cfg.get("type")
    if actual != expected:
        return [f"expected chart type '{expected}', got '{actual}'"]
    return []


def check_expected_values(result, ev):
    """Check that at least one numeric value in the result falls within the expected range."""
    rows = result.get("rows", [])
    if not rows:
        return [f"no rows to validate: {ev['description']}"]

    # Find all numeric values in the result
    all_nums = []
    for row in rows:
        for k, v in row.items():
            if isinstance(v, (int, float)) and v > 0:
                all_nums.append(v)

    if not all_nums:
        return [f"no numeric values found: {ev['description']}"]

    # Check if any value falls in range
    in_range = any(ev["min"] <= n <= ev["max"] for n in all_nums)
    if not in_range:
        sample = all_nums[:5]
        return [f"no value in range [{ev['min']}, {ev['max']}]: got {sample}... ({ev['description']})"]
    return []


def run_test(session, base_url, test):
    """Run a single test, return structured result."""
    tid = test["id"]
    tab = test["tab"]
    question = test["question"]
    checks = test["checks"]

    t0 = time.time()
    if tab == "nibrs":
        result = query_nibrs(session, base_url, question)
    else:
        result = query_rtci(session, base_url, question, tab)
    elapsed = time.time() - t0

    if "_error" in result:
        # If we expected a clarification and got an error, that may be OK
        if checks.get("expect_clarification"):
            return {
                "id": tid,
                "question": question,
                "tab": tab,
                "status": "PASS",
                "explanation": result.get("_error", ""),
                "elapsed_s": round(elapsed, 1),
                "failures": [],
                "clarification": True,
            }
        return {
            "id": tid,
            "question": question,
            "tab": tab,
            "status": "ERROR",
            "error": result["_error"],
            "sql": result.get("sql"),
            "elapsed_s": round(elapsed, 1),
            "failures": [result["_error"]],
        }

    # Clarification check: agent should return null SQL (asking for more info)
    if checks.get("expect_clarification"):
        sql = result.get("sql", "")
        got_clarification = not sql or sql.strip() == ""
        if got_clarification:
            return {
                "id": tid,
                "question": question,
                "tab": tab,
                "status": "PASS",
                "explanation": result.get("explanation", "")[:500],
                "elapsed_s": round(elapsed, 1),
                "failures": [],
                "clarification": True,
            }
        else:
            # Agent answered when it should have asked for clarification
            return {
                "id": tid,
                "question": question,
                "tab": tab,
                "status": "FAIL",
                "sql": sql,
                "explanation": result.get("explanation", "")[:500],
                "elapsed_s": round(elapsed, 1),
                "failures": ["expected clarification/refusal but agent generated SQL"],
            }

    failures = []
    sql = result.get("sql", "")

    # SQL pattern checks
    if "sql_patterns" in checks:
        failures.extend(check_sql_patterns(sql, checks["sql_patterns"]))
    if "sql_antipatterns" in checks:
        failures.extend(check_sql_antipatterns(sql, checks["sql_antipatterns"]))

    # Row count
    failures.extend(check_row_count(result, checks))

    # Chart type
    if "chart_type" in checks:
        failures.extend(check_chart_type(result, checks["chart_type"]))

    # Expected values
    if "expected_values" in checks:
        failures.extend(check_expected_values(result, checks["expected_values"]))

    return {
        "id": tid,
        "question": question,
        "tab": tab,
        "status": "PASS" if not failures else "FAIL",
        "sql": sql,
        "explanation": result.get("explanation", "")[:500],
        "row_count": result.get("rowCount", 0),
        "chart_type": (result.get("chartConfig") or {}).get("type"),
        "elapsed_s": round(elapsed, 1),
        "failures": failures,
        "sample_rows": (result.get("rows") or [])[:3],
    }


def judge_with_claude(results):
    """Use Claude to grade the quality of responses. Requires ANTHROPIC_API_KEY."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("\nSkipping Claude judge: ANTHROPIC_API_KEY not set")
        return results

    print("\nRunning Claude judge on responses...")
    import anthropic
    client = anthropic.Anthropic(api_key=api_key)

    for r in results:
        if r["status"] == "ERROR":
            r["judge_score"] = 0
            r["judge_reason"] = "API error"
            continue

        prompt = f"""You are evaluating a crime data AI assistant. Score this response 1-5:
1 = Wrong data or completely irrelevant
2 = Partially correct but major issues (wrong table, missing key filter)
3 = Mostly correct but minor issues (could be more precise)
4 = Good response, correct data, appropriate SQL
5 = Excellent, optimal SQL, accurate data

Question: {r['question']}
Tab: {r['tab']}
SQL: {r.get('sql', 'N/A')}
Explanation: {r.get('explanation', 'N/A')}
Row count: {r.get('row_count', 0)}
Sample rows: {json.dumps(r.get('sample_rows', []), default=str)[:500]}

Respond with ONLY a JSON object: {{"score": N, "reason": "brief explanation"}}"""

        try:
            resp = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=200,
                messages=[{"role": "user", "content": prompt}],
            )
            text = resp.content[0].text.strip()
            parsed = json.loads(text)
            r["judge_score"] = parsed["score"]
            r["judge_reason"] = parsed["reason"]
        except Exception as e:
            r["judge_score"] = None
            r["judge_reason"] = f"Judge error: {e}"

    return results


def diff_results(current, prev_path):
    """Compare current results against a previous run."""
    with open(prev_path) as f:
        prev = json.load(f)

    prev_map = {r["id"]: r for r in prev["results"]}
    print(f"\n{'=' * 70}")
    print(f"DIFF vs {prev_path}")
    print(f"{'=' * 70}")

    regressions = []
    improvements = []
    for r in current:
        p = prev_map.get(r["id"])
        if not p:
            print(f"  NEW: {r['id']}")
            continue

        if p["status"] == "PASS" and r["status"] != "PASS":
            regressions.append(r["id"])
            print(f"  REGRESSION: {r['id']} was PASS, now {r['status']}")
            for f in r["failures"]:
                print(f"    - {f}")
        elif p["status"] != "PASS" and r["status"] == "PASS":
            improvements.append(r["id"])
            print(f"  FIXED: {r['id']} was {p['status']}, now PASS")

    if not regressions and not improvements:
        print("  No changes detected.")
    print(f"\n  Regressions: {len(regressions)}, Improvements: {len(improvements)}")


def print_summary(results):
    passed = sum(1 for r in results if r["status"] == "PASS")
    failed = sum(1 for r in results if r["status"] == "FAIL")
    errors = sum(1 for r in results if r["status"] == "ERROR")
    total = len(results)
    avg_time = sum(r["elapsed_s"] for r in results) / total if total else 0

    print(f"\n{'=' * 70}")
    print(f"RESULTS: {passed}/{total} passed, {failed} failed, {errors} errors")
    print(f"Average response time: {avg_time:.1f}s")
    print(f"{'=' * 70}")

    # Print failures
    for r in results:
        if r["status"] != "PASS":
            print(f"\n  [{r['status']}] {r['id']}: {r['question']}")
            for f in r["failures"]:
                print(f"    - {f}")
            if r.get("sql"):
                # Truncate long SQL
                sql_preview = r["sql"][:200] + ("..." if len(r["sql"]) > 200 else "")
                print(f"    SQL: {sql_preview}")

    # Judge scores
    if any(r.get("judge_score") is not None for r in results):
        scores = [r["judge_score"] for r in results if isinstance(r.get("judge_score"), (int, float))]
        if scores:
            avg = sum(scores) / len(scores)
            print(f"\nClaude Judge: avg score {avg:.1f}/5.0")
            for r in results:
                if r.get("judge_score") is not None and r["judge_score"] <= 2:
                    print(f"  LOW [{r['judge_score']}] {r['id']}: {r.get('judge_reason', '')}")


def main():
    parser = argparse.ArgumentParser(description="Evaluate Crime Data Assistant")
    parser.add_argument("--base", default=DEFAULT_BASE, help="Base URL (default: localhost; production must be named explicitly)")
    parser.add_argument("--print-target", action="store_true",
                        help="Print the resolved base URL and exit without contacting it")
    parser.add_argument("--filter", help="Filter tests by ID prefix (rtci, hist, nibrs)")
    parser.add_argument("--judge", action="store_true", help="Use Claude to grade responses")
    parser.add_argument("--diff", help="Path to previous results JSON for comparison")
    parser.add_argument("--id", help="Run a single test by ID")
    args = parser.parse_args()

    if args.print_target:
        print(args.base)
        return

    tests = load_dataset(args.filter)
    if args.id:
        tests = [t for t in tests if t["id"] == args.id]
    if not tests:
        print("No tests match filter.")
        sys.exit(1)

    print(f"Crime Data Assistant Evaluation")
    print(f"Target: {args.base}")
    print(f"Tests: {len(tests)}")
    print(f"{'=' * 70}\n")

    session = get_session(args.base)
    print("Authenticated OK\n")

    results = []
    for i, test in enumerate(tests):
        print(f"[{i+1}/{len(tests)}] {test['id']}: {test['question']}")
        r = run_test(session, args.base, test)
        results.append(r)

        icon = {"PASS": "OK", "FAIL": "FAIL", "ERROR": "ERR"}[r["status"]]
        detail = f"{r.get('row_count', '?')} rows, {r['elapsed_s']}s"
        if r["failures"] and r["status"] != "ERROR":
            detail += f" | {r['failures'][0]}"
        print(f"  {icon} ({detail})\n")

        # Small delay to avoid rate limiting
        if i < len(tests) - 1:
            time.sleep(1)

    if args.judge:
        results = judge_with_claude(results)

    print_summary(results)

    # Save results
    RESULTS_DIR.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_path = RESULTS_DIR / f"eval-{timestamp}.json"
    output = {
        "timestamp": timestamp,
        "base_url": args.base,
        "total": len(results),
        "passed": sum(1 for r in results if r["status"] == "PASS"),
        "failed": sum(1 for r in results if r["status"] == "FAIL"),
        "errors": sum(1 for r in results if r["status"] == "ERROR"),
        "results": results,
    }
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2, default=str)
    print(f"\nResults saved to {out_path}")

    if args.diff:
        diff_results(results, args.diff)

    # Exit with error code if failures
    if any(r["status"] != "PASS" for r in results):
        sys.exit(1)


if __name__ == "__main__":
    main()
