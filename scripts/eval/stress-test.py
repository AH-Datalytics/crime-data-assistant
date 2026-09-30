"""
NIBRS Stress Test — Agent-driven query discovery for slow/failing queries.

Uses Claude to generate diverse natural-language queries across all NIBRS
dimensions, runs them against the live API, and reports:
  - Queries > 10s total (slow)
  - Queries that error/timeout
  - Queries that hit raw tables instead of summary tables
  - Queries that silently drop filters

Usage:
  python scripts/eval/stress-test.py                        # full run against prod
  python scripts/eval/stress-test.py --base http://localhost:3000  # local
  python scripts/eval/stress-test.py --count 50             # generate 50 queries (default 100)
  python scripts/eval/stress-test.py --skip-generate        # rerun from previous queries file
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).parent
RESULTS_DIR = SCRIPT_DIR / "results"
QUERIES_PATH = SCRIPT_DIR / "stress-queries.json"
# PRODUCTION IS OPT-IN. This defaulted to https://nibrsai.com, so a bare `python
# scripts/eval/stress-test.py` sent ~100 model-generated queries at production. Now `--base` must name
# it. The site password is removed rather than re-homed: the site is intentionally public, so the login
# step authorized nothing. ANTHROPIC_API_KEY is a genuine non-site credential and is untouched.
DEFAULT_BASE = "http://localhost:3000"
SLOW_THRESHOLD_S = 10

# Categories of queries to stress-test, designed to hit every table and dimension
QUERY_CATEGORIES = """Generate diverse natural-language questions a journalist or analyst would ask about crime data. Cover ALL of these categories, with multiple questions per category:

1. DEMOGRAPHIC BREAKDOWNS (victim, offender, arrestee)
   - Race, sex, age for specific crimes in specific cities/states/nationally
   - "gun murder victims by race in Chicago"
   - "offender age breakdown for robberies in 2024"
   - "arrestee demographics for drug offenses in Ohio"

2. WEAPON QUERIES (specific weapons, not just categories)
   - "handgun vs rifle murders nationally"
   - "what weapons are used in aggravated assaults in Houston?"
   - "murder victims killed by shotgun by year"

3. LOCATION QUERIES
   - "where do robberies happen most?"
   - "murders at schools vs residences in 2024"
   - "burglaries at convenience stores in Texas"

4. HATE CRIME
   - "anti-Jewish hate crimes by year"
   - "hate crimes in California in 2025"
   - "what types of hate crimes are most common?"

5. CIRCUMSTANCE QUERIES (DV, gang, argument)
   - "domestic violence murders by year"
   - "gang-related murders in Chicago"
   - "what percentage of murders are argument-related?"

6. CLEARANCE RATES
   - "murder clearance rate in Detroit"
   - "clearance rate by arrest vs exceptional for rape in Houston"
   - "which cities have the highest murder clearance rate?"

7. DRUG OFFENSES
   - "meth vs cocaine offenses in Texas"
   - "top drugs seized nationally in 2024"
   - "drug offense trends in Ohio"

8. PROPERTY CRIMES
   - "stolen firearms by state"
   - "total value stolen in burglaries in New York"
   - "carjacking trend in Chicago by month"

9. MULTI-YEAR TRENDS
   - "murder trend nationally 2015-2025"
   - "robbery trend in Houston 2020-2025"
   - "how has rape changed in Texas over time?"

10. RATE CALCULATIONS
    - "murder rate per 100K in top 10 cities"
    - "aggravated assault rate by state"
    - "compare murder rates: Chicago vs Houston vs Detroit"

11. CROSS-DIMENSIONAL (combine multiple filters)
    - "firearm murder victims under 25 by race in 2025"
    - "domestic violence murders with firearms nationally"
    - "hate crimes at schools by bias type"

12. EDGE CASES / TRICKY
    - "assault trend" (should ask to clarify agg vs simple)
    - "violent crime in Houston" (should ask SRS vs NIBRS definition)
    - "crime in Springfield" (ambiguous city)
    - "murders in San Francisco" (limited NIBRS data)
    - "how many police officers in Houston?" (not in NIBRS)
    - "justifiable homicides by police vs civilian"
    - "negligent manslaughter trend"

Return a JSON array of objects: [{"question": "...", "category": "..."}]
Generate exactly {count} questions, spread evenly across categories. Make them realistic and varied — different cities, states, years, crime types. Include some that SHOULD be fast (summary tables) and some that might accidentally hit raw tables."""


def generate_queries(count=100):
    """Use Claude to generate diverse stress-test queries."""
    import anthropic
    client = anthropic.Anthropic()

    print(f"Generating {count} stress-test queries with Claude...")
    resp = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=8000,
        messages=[{
            "role": "user",
            "content": QUERY_CATEGORIES.replace("{count}", str(count))
        }],
    )

    text = resp.content[0].text
    # Extract JSON array
    match = text[text.index("["):text.rindex("]") + 1]
    queries = json.loads(match)
    print(f"Generated {len(queries)} queries across categories:")

    cats = {}
    for q in queries:
        cat = q.get("category", "unknown")
        cats[cat] = cats.get(cat, 0) + 1
    for cat, n in sorted(cats.items()):
        print(f"  {cat}: {n}")

    # Save for reuse
    with open(QUERIES_PATH, "w") as f:
        json.dump(queries, f, indent=2)
    print(f"Saved to {QUERIES_PATH}\n")

    return queries


def get_session(base_url):
    """A plain session. The site is public, so there is no login step."""
    return requests.Session()


def run_query(session, base_url, question):
    """Run a single NIBRS query, return result + timing."""
    try:
        t0 = time.time()
        r = session.post(
            f"{base_url}/api/nibrs-query",
            json={"question": question, "history": []},
            timeout=120,
        )
        elapsed = time.time() - t0

        if r.status_code == 429:
            retry = int(r.headers.get("Retry-After", 10))
            print(f"      Rate limited, waiting {retry}s...")
            time.sleep(retry + 1)
            return run_query(session, base_url, question)

        if r.status_code != 200:
            return {
                "success": False,
                "error": f"HTTP {r.status_code}",
                "elapsed_s": round(elapsed, 1),
                "sql": None,
            }

        data = r.json()
        return {
            "success": data.get("success", False),
            "error": data.get("error"),
            "sql": data.get("sql"),
            "explanation": (data.get("explanation") or "")[:300],
            "row_count": data.get("rowCount", 0),
            "elapsed_s": round(elapsed, 1),
            "execution_time_ms": data.get("executionTimeMs", 0),
        }

    except requests.exceptions.Timeout:
        return {
            "success": False,
            "error": "Request timed out (120s)",
            "elapsed_s": 120,
            "sql": None,
        }
    except requests.exceptions.ConnectionError as e:
        return {
            "success": False,
            "error": f"Connection error: {e}",
            "elapsed_s": 0,
            "sql": None,
        }


def analyze_sql(sql):
    """Flag potential issues in generated SQL."""
    if not sql:
        return []
    flags = []
    sql_lower = sql.lower()

    # Raw table scans
    raw_tables = {
        "from victims": "raw victims table (use summary_victim_* instead)",
        "from offenses": "raw offenses table (use summary_offense_* or summary_city_monthly instead)",
        "from offenders": "raw offenders table (use summary_offender_demographics instead)",
        "from arrestees": "raw arrestees table (use summary_arrestee_demographics instead)",
        "from incidents": "raw incidents table",
        "from property": "raw property table (use summary_property_offense instead)",
    }
    for pattern, warning in raw_tables.items():
        # Exclude "FROM summary_*" matches
        if pattern in sql_lower and "summary_" not in sql_lower.split(pattern)[0].split("from")[-1]:
            # Make sure it's actually FROM raw table not a subquery referencing summary
            idx = sql_lower.index(pattern)
            after = sql_lower[idx + len(pattern):idx + len(pattern) + 20]
            if "summary" not in after:
                flags.append(f"RAW_TABLE: {warning}")

    # Missing year filter
    if "year" not in sql_lower and "where" in sql_lower:
        flags.append("NO_YEAR_FILTER: query may scan all years")

    return flags


def print_report(results):
    """Print categorized report."""
    slow = [r for r in results if r["elapsed_s"] > SLOW_THRESHOLD_S and r.get("success")]
    errors = [r for r in results if not r.get("success")]
    raw_table = [r for r in results if r.get("sql_flags")]
    fast = [r for r in results if r["elapsed_s"] <= SLOW_THRESHOLD_S and r.get("success")]

    total = len(results)
    avg_time = sum(r["elapsed_s"] for r in results) / total if total else 0

    print(f"\n{'=' * 70}")
    print(f"STRESS TEST RESULTS")
    print(f"{'=' * 70}")
    print(f"Total queries: {total}")
    print(f"Fast (<{SLOW_THRESHOLD_S}s): {len(fast)}")
    print(f"Slow (>{SLOW_THRESHOLD_S}s): {len(slow)}")
    print(f"Errors/timeouts: {len(errors)}")
    print(f"Hit raw tables: {len(raw_table)}")
    print(f"Average response time: {avg_time:.1f}s")

    if slow:
        print(f"\n{'=' * 70}")
        print(f"SLOW QUERIES (>{SLOW_THRESHOLD_S}s)")
        print(f"{'=' * 70}")
        for r in sorted(slow, key=lambda x: -x["elapsed_s"]):
            print(f"\n  [{r['elapsed_s']}s] {r['question']}")
            print(f"    Category: {r.get('category', '?')}")
            if r.get("sql"):
                print(f"    SQL: {r['sql'][:150]}...")
            for f in r.get("sql_flags", []):
                print(f"    FLAG: {f}")

    if errors:
        print(f"\n{'=' * 70}")
        print(f"ERRORS / TIMEOUTS")
        print(f"{'=' * 70}")
        for r in errors:
            print(f"\n  [{r['elapsed_s']}s] {r['question']}")
            print(f"    Error: {r.get('error', '?')}")
            if r.get("sql"):
                print(f"    SQL: {r['sql'][:150]}...")

    if raw_table:
        print(f"\n{'=' * 70}")
        print(f"RAW TABLE USAGE (potential optimization)")
        print(f"{'=' * 70}")
        for r in raw_table:
            print(f"\n  [{r['elapsed_s']}s] {r['question']}")
            for f in r["sql_flags"]:
                print(f"    {f}")
            if r.get("sql"):
                print(f"    SQL: {r['sql'][:150]}...")

    # Timing distribution
    print(f"\n{'=' * 70}")
    print(f"TIMING DISTRIBUTION")
    print(f"{'=' * 70}")
    brackets = [(0, 5), (5, 10), (10, 15), (15, 20), (20, 30), (30, 60), (60, 999)]
    for lo, hi in brackets:
        count = sum(1 for r in results if lo <= r["elapsed_s"] < hi)
        bar = "#" * count
        label = f"{lo}-{hi}s" if hi < 999 else f"{lo}s+"
        print(f"  {label:>8}: {count:3d} {bar}")


def main():
    parser = argparse.ArgumentParser(description="NIBRS Stress Test")
    parser.add_argument("--base", default=DEFAULT_BASE, help="Base URL (default: localhost; production must be named explicitly)")
    parser.add_argument("--count", type=int, default=100, help="Number of queries to generate")
    parser.add_argument("--skip-generate", action="store_true", help="Reuse previous queries file")
    parser.add_argument("--print-target", action="store_true",
                        help="Print the resolved base URL and exit without contacting it")
    args = parser.parse_args()

    if args.print_target:
        print(args.base)
        return

    # Step 1: Generate or load queries
    if args.skip_generate and QUERIES_PATH.exists():
        with open(QUERIES_PATH) as f:
            queries = json.load(f)
        print(f"Loaded {len(queries)} queries from {QUERIES_PATH}")
    else:
        queries = generate_queries(args.count)

    # Step 2: Run all queries
    print(f"Running {len(queries)} queries against {args.base}...")
    print(f"Slow threshold: {SLOW_THRESHOLD_S}s\n")

    session = get_session(args.base)
    print("Authenticated OK\n")

    results = []
    for i, q in enumerate(queries):
        question = q["question"]
        category = q.get("category", "unknown")
        print(f"[{i+1}/{len(queries)}] ({category}) {question}")

        result = run_query(session, args.base, question)
        result["question"] = question
        result["category"] = category
        result["sql_flags"] = analyze_sql(result.get("sql"))

        status = "OK" if result["success"] else "ERR"
        time_flag = " SLOW" if result["elapsed_s"] > SLOW_THRESHOLD_S else ""
        raw_flag = " RAW_TABLE" if result["sql_flags"] else ""
        print(f"  {status} {result['elapsed_s']}s, {result.get('row_count', 0)} rows{time_flag}{raw_flag}")

        results.append(result)

        # Small delay
        if i < len(queries) - 1:
            time.sleep(1)

    # Step 3: Report
    print_report(results)

    # Step 4: Save
    RESULTS_DIR.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_path = RESULTS_DIR / f"stress-{timestamp}.json"
    output = {
        "timestamp": timestamp,
        "base_url": args.base,
        "slow_threshold_s": SLOW_THRESHOLD_S,
        "total": len(results),
        "slow": sum(1 for r in results if r["elapsed_s"] > SLOW_THRESHOLD_S and r.get("success")),
        "errors": sum(1 for r in results if not r.get("success")),
        "raw_table_hits": sum(1 for r in results if r.get("sql_flags")),
        "avg_time_s": round(sum(r["elapsed_s"] for r in results) / len(results), 1),
        "results": results,
    }
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2, default=str)
    print(f"\nFull results saved to {out_path}")


if __name__ == "__main__":
    main()
