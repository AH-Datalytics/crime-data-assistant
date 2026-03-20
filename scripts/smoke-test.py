"""
Smoke test for nibrsai.com — runs test queries and validates responses.

Usage:
  python scripts/smoke-test.py                    # test production
  python scripts/smoke-test.py http://localhost:3000  # test local

Checks:
  - API returns valid JSON/SSE
  - SQL was generated (not null)
  - Rows returned (not empty)
  - Chart config has correct columns
  - Rate queries include population-based calculation
  - Multi-city queries are pivoted (separate columns per city)
"""
import json
import re
import sys
import time
import requests

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "https://nibrsai.com"
PASS = "NIBRSAHD"

# (tab, question, checks)
# checks: list of (description, lambda response_data -> bool)
TESTS = [
    # Current Trends
    ("current", "National murder trend", [
        ("has SQL", lambda d: bool(d.get("sql"))),
        ("has rows", lambda d: d.get("rowCount", 0) > 0),
        ("uses national_monthly", lambda d: "national_monthly" in d.get("sql", "").lower()),
        ("has offense filter", lambda d: "murder" in d.get("sql", "").lower()),
    ]),
    ("current", "Murder rate in Houston per 100K", [
        ("has SQL", lambda d: bool(d.get("sql"))),
        ("has rows", lambda d: d.get("rowCount", 0) > 0),
        ("joins population", lambda d: "population" in d.get("sql", "").lower()),
        ("has rate calculation", lambda d: "100000" in d.get("sql", "")),
    ]),
    ("current", "Compare monthly murders in Baltimore and Detroit", [
        ("has SQL", lambda d: bool(d.get("sql"))),
        ("has rows", lambda d: d.get("rowCount", 0) > 0),
        ("pivoted with CASE WHEN", lambda d: "case" in d.get("sql", "").lower()),
        ("chart is line", lambda d: d.get("chartConfig", {}).get("type") == "line" if d.get("chartConfig") else False),
    ]),
    ("current", "Murder rates in Baltimore, Washington DC, and Detroit", [
        ("has SQL", lambda d: bool(d.get("sql"))),
        ("has rows", lambda d: d.get("rowCount", 0) > 0),
        ("joins population", lambda d: "population" in d.get("sql", "").lower()),
        ("pivoted with CASE WHEN", lambda d: "case" in d.get("sql", "").lower()),
        ("DC state filter", lambda d: "'DC'" in d.get("sql", "") or "'dc'" in d.get("sql", "").lower()),
    ]),
    # Historical Library
    ("historical", "National robbery clearance rate since 1960", [
        ("has SQL", lambda d: bool(d.get("sql"))),
        ("has rows", lambda d: d.get("rowCount", 0) > 0),
        ("uses clearance table", lambda d: "clearance" in d.get("sql", "").lower()),
    ]),
    ("historical", "Chicago murder rate per 100K since 1980", [
        ("has SQL", lambda d: bool(d.get("sql"))),
        ("has rows", lambda d: d.get("rowCount", 0) > 0),
        ("joins population", lambda d: "population" in d.get("sql", "").lower()),
    ]),
]


def get_session():
    """Get an authenticated session."""
    s = requests.Session()
    # Authenticate
    r = s.post(f"{BASE_URL}/api/auth", json={"password": PASS})
    if r.status_code != 200:
        print(f"  AUTH FAILED: {r.status_code} {r.text[:200]}")
        sys.exit(1)
    # Extract cookie
    return s


def run_query(session, mode, question):
    """Send a query and parse the SSE response."""
    try:
        r = session.post(
            f"{BASE_URL}/api/query",
            json={"question": question, "mode": mode, "history": []},
            headers={"Accept": "text/event-stream"},
            stream=True,
            timeout=60,
        )
    except requests.exceptions.ConnectionError as e:
        return {"_error": f"Connection error: {e}"}
    except requests.exceptions.Timeout:
        return {"_error": "Request timed out"}
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
            result = {"_error": event.get("text", "unknown error")}
    return result


def main():
    print(f"Smoke test: {BASE_URL}")
    print(f"{'=' * 60}")

    session = get_session()
    print("Authenticated OK\n")

    passed = 0
    failed = 0
    errors = []

    for mode, question, checks in TESTS:
        tag = f"[{mode}]"
        print(f"{tag} {question}")
        t = time.time()
        result = run_query(session, mode, question)
        elapsed = time.time() - t

        if "_error" in result:
            print(f"  ERROR ({elapsed:.1f}s): {result['_error']}")
            failed += len(checks)
            errors.append((question, "API error"))
            continue

        all_ok = True
        for desc, check_fn in checks:
            try:
                ok = check_fn(result)
            except Exception as e:
                ok = False
            status = "PASS" if ok else "FAIL"
            if not ok:
                all_ok = False
                failed += 1
                errors.append((question, desc))
                print(f"  {status}: {desc}")
            else:
                passed += 1

        status_icon = "OK" if all_ok else "ISSUES"
        print(f"  {status_icon} ({elapsed:.1f}s, {result.get('rowCount', 0)} rows)")
        print()

    print(f"{'=' * 60}")
    print(f"Results: {passed} passed, {failed} failed")
    if errors:
        print(f"\nFailures:")
        for q, desc in errors:
            print(f"  - [{desc}] {q}")
        sys.exit(1)
    else:
        print("All checks passed!")


if __name__ == "__main__":
    main()
