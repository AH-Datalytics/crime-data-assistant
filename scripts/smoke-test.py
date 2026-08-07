"""
Smoke test for nibrsai.com — runs test queries and validates responses.

Usage:
  python scripts/smoke-test.py                    # test production
  python scripts/smoke-test.py http://localhost:3000  # test local

Checks:
  - API returns valid JSON/SSE
  - SQL was generated (not null)
  - Rows returned (not empty) — enforced structurally, see below
  - Chart config has correct columns
  - Rate queries include population-based calculation
  - Multi-city queries are pivoted (separate columns per city)

TWO OPERATIONAL RULES, both learned the hard way on 2026-08-07:

1. Every query needs a page token, and the token must be AGED. lib/page-token.ts
   rejects tokens younger than one second as bot traffic (and older than an hour).
   Without one the API answers 403 to everything, which reads like a total outage
   when the service is perfectly healthy. Mint once, sleep, reuse.

2. A zero-row response is a FAILURE, structurally — not a per-test checkbox that a
   future test can forget to include. The API answers refusals and clarifying
   questions with HTTP 200, no SQL, and zero rows, so a smoke test that only
   inspects the checks it was given will score a refusal as a pass. When that
   happens the refusal text is printed, because "the model declined" and "the
   service is down" demand completely different responses at 3am.
"""
import json
import sys
import time
import requests

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "https://nibrsai.com"
PASS = "NIBRSAHD"

# SQL is model-generated, so an occasional run produces no usable query for a question
# that succeeds on the next attempt. Retry before calling it a failure — otherwise the
# smoke test cries outage over ordinary nondeterminism.
ATTEMPTS = 3

# (tab, question, checks)
# checks: list of (description, lambda response_data -> bool)
# "has rows" is NOT a per-test check — it is enforced for every test in run_query.
TESTS = [
    # Current Trends
    ("current", "National murder trend", [
        ("has SQL", lambda d: bool(d.get("sql"))),
        ("uses national_monthly", lambda d: "national_monthly" in d.get("sql", "").lower()),
        ("has offense filter", lambda d: "murder" in d.get("sql", "").lower()),
    ]),
    ("current", "Murder rate in Houston per 100K", [
        ("has SQL", lambda d: bool(d.get("sql"))),
        ("joins population", lambda d: "population" in d.get("sql", "").lower()),
        ("has rate calculation", lambda d: "100000" in d.get("sql", "")),
    ]),
    # "Baltimore" alone now returns the city-vs-county clarifier (zero rows by design),
    # so these name the city explicitly.
    ("current", "Compare monthly murders in Baltimore city and Detroit", [
        ("has SQL", lambda d: bool(d.get("sql"))),
        ("pivoted with CASE WHEN", lambda d: "case" in d.get("sql", "").lower()),
        ("chart is line", lambda d: d.get("chartConfig", {}).get("type") == "line" if d.get("chartConfig") else False),
    ]),
    ("current", "Murder rates in Baltimore city, Washington DC, and Detroit", [
        ("has SQL", lambda d: bool(d.get("sql"))),
        ("joins population", lambda d: "population" in d.get("sql", "").lower()),
        ("pivoted with CASE WHEN", lambda d: "case" in d.get("sql", "").lower()),
        ("DC state filter", lambda d: "'DC'" in d.get("sql", "") or "'dc'" in d.get("sql", "").lower()),
    ]),
    # Historical Library
    ("historical", "National robbery clearance rate since 1960", [
        ("has SQL", lambda d: bool(d.get("sql"))),
        ("uses clearance table", lambda d: "clearance" in d.get("sql", "").lower()),
    ]),
    ("historical", "Chicago murder rate per 100K since 1980", [
        ("has SQL", lambda d: bool(d.get("sql"))),
        ("joins population", lambda d: "population" in d.get("sql", "").lower()),
    ]),
]


def get_session():
    """Get an authenticated session."""
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth", json={"password": PASS})
    if r.status_code != 200:
        print(f"  AUTH FAILED: {r.status_code} {r.text[:200]}")
        sys.exit(1)
    return s


def get_page_token(session):
    """Mint a page token and let it age past the one-second floor.

    page-token.ts treats a token used within 1s of issue as a bot and returns 403,
    so minting per request would fail every query. One aged token serves the whole
    run (they stay valid for an hour).
    """
    try:
        r = session.get(f"{BASE_URL}/api/page-token", timeout=30)
    except requests.exceptions.RequestException as e:
        print(f"  PAGE TOKEN FAILED: {e}")
        sys.exit(1)
    if r.status_code != 200:
        print(f"  PAGE TOKEN FAILED: {r.status_code} {r.text[:200]}")
        sys.exit(1)
    token = r.json().get("token")
    if not token:
        print("  PAGE TOKEN FAILED: response contained no token")
        sys.exit(1)
    time.sleep(2)
    return token


def run_query(session, mode, question, page_token):
    """Send a query and parse the SSE response."""
    try:
        r = session.post(
            f"{BASE_URL}/api/query",
            json={"question": question, "mode": mode, "history": [], "pageToken": page_token},
            headers={"Accept": "text/event-stream"},
            stream=True,
            timeout=60,
        )
    except requests.exceptions.ConnectionError as e:
        return {"_error": f"Connection error: {e}"}
    except requests.exceptions.Timeout:
        return {"_error": "Request timed out"}
    if r.status_code == 403:
        return {"_error": "HTTP 403 — page token rejected (expired, or used under 1s old)"}
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

    if "_error" in result:
        return result
    if not result:
        return {"_error": "no result event in stream"}
    # A refusal or clarifying question arrives as HTTP 200 with zero rows. That is a
    # failure, and the text is what distinguishes it from an outage.
    if (result.get("rowCount") or 0) == 0:
        detail = (result.get("explanation") or "").strip().replace("\n", " ")
        return {"_error": f"zero rows — {detail[:180] or 'no explanation returned'}"}
    return result


def main():
    print(f"Smoke test: {BASE_URL}")
    print(f"{'=' * 60}")

    session = get_session()
    page_token = get_page_token(session)
    print("Authenticated OK, page token aged\n")

    passed = 0
    failed = 0
    errors = []

    for mode, question, checks in TESTS:
        tag = f"[{mode}]"
        print(f"{tag} {question}")
        t = time.time()
        for attempt in range(ATTEMPTS):
            result = run_query(session, mode, question, page_token)
            if "_error" not in result:
                break
            if attempt < ATTEMPTS - 1:
                time.sleep(1)
        elapsed = time.time() - t

        if "_error" in result:
            print(f"  ERROR ({elapsed:.1f}s): {result['_error']}")
            # Count the whole test as failed, plus the implicit rows requirement.
            failed += len(checks) + 1
            errors.append((question, result["_error"]))
            print()
            continue

        # The structural requirement, counted like any other check.
        passed += 1

        all_ok = True
        for desc, check_fn in checks:
            try:
                ok = check_fn(result)
            except Exception:
                ok = False
            if not ok:
                all_ok = False
                failed += 1
                errors.append((question, desc))
                print(f"  FAIL: {desc}")
            else:
                passed += 1

        status_icon = "OK" if all_ok else "ISSUES"
        print(f"  {status_icon} ({elapsed:.1f}s, {result.get('rowCount', 0)} rows)")
        print()

    print(f"{'=' * 60}")
    print(f"Results: {passed} passed, {failed} failed")
    if errors:
        print("\nFailures:")
        for q, desc in errors:
            print(f"  - [{desc}] {q}")
        sys.exit(1)
    print("All checks passed!")


if __name__ == "__main__":
    main()
