#!/usr/bin/env python3
"""Read-only diagnosis of the answer log: where do answers actually go wrong?

    python scripts/diagnose-answer-log.py --snapshot PATH/query_log.db \
        [--crime-db PATH/crime_data.db] [--json out.json]
    python scripts/diagnose-answer-log.py --self-test

This tool NEVER writes to the snapshot. It opens every database with `mode=ro`, and takes the
snapshot path as an argument rather than reaching for production, so a reviewer can point it at
their own copy. No production question, response or database is committed with it -- the fixtures
under `scripts/fixtures/answer-log-classification.json` are synthetic.

WHAT THIS TOOL REPRODUCES, and what it does not. The report
`docs/superpowers/2026-08-18-increment-b-answer-diagnosis.md` draws on three kinds of evidence, and
only the first comes from here:

  1. THIS TOOL -- the zero-row classification and its verdict totals, the question-shape by verdict
     cross-tab, and the query-fidelity counts (place, period, wrong-level substitution). Deterministic:
     same snapshot, same numbers. It prints the snapshot's sha256 so a result can be tied to its input.

  2. MANUAL ADJUDICATION -- the precision of a mechanical flag. 25 place flags were read by hand and
     9 judged genuine (~36%). A flag is not a finding, and no code here decides which flags are real.

  3. READ-ONLY INSPECTION of production and of the crime database, which this tool does not touch.
     Each such figure in the report carries the exact command that produced it: the proof-column and
     proof-mode state, `chart_audit_artifacts` coverage and linkage, the `historical_agency_clearance`
     value ranges, and the replay against both database vintages.

Two things this tool deliberately does NOT claim:

  * It cannot measure a wrong-answer rate. The narrative in a logged answer is a caption -- it
    describes the data rather than stating it -- and the result set is not in `query_log`. What the
    user saw is not recoverable from these columns. `chart_audit_artifacts` is where that evidence
    actually lives.
  * A classification is a lower bound. Rows that match no rule are reported as UNCLASSIFIED and are
    never folded into a verdict, so "genuine failures" is always "at least this many".

It does not sample. Every count is over the full snapshot, which is why there is no seed argument.
"""
import argparse
import collections
import hashlib
import json
import pathlib
import re
import sqlite3
import sys

# --------------------------------------------------------------------------------------------
# Classification rules.
#
# Anchored to templates that exist in the application -- `lib/refusal-safety.ts`,
# `lib/county-clarifier.ts`, `lib/claude.ts` -- rather than invented. First match wins, so failure
# markers are tested before refusal markers: a failure message can quote the question back.
# --------------------------------------------------------------------------------------------
RULES = [
    ("system could not build a query", "FAILURE",
     r"(I could not generate a database query for that request"
     r"|I could?n.?t build a (reliable|valid)|I was?n.?t able to build a valid"
     r"|I could?n.?t generate the requested query|I could?n.?t find a way to answer that"
     r"|Sorry, I was?n.?t able to process that request)"),
    ("unverified-absence claim, neutralized", "FAILURE",
     r"I could?n.?t verify that the requested data is unavailable"),
    ("envelope/parse failure (retired build)", "FAILURE",
     r"I had trouble formatting my response"),
    ("timed out", "FAILURE", r"(Query timed out after|timed out)"),

    ("clarify: county scope", "CLARIFY", r"do you want the countywide total"),
    ("clarify: ambiguous place", "CLARIFY",
     r"(Say Washington, DC or Washington State|Kansas City can mean|Portland usually needs"
     r"|Los Angeles can mean|Cook County exists in multiple states|Say New York City or New York State"
     r"|Use Baltimore city or Baltimore County|is ambiguous|Add the state so|to avoid the wrong city"
     r"|to avoid ambiguity|multiple cities named|Please specify Kansas City"
     r"|I need to clarify which|served by more than one law enforcement)"),
    ("clarify: which measure/definition", "CLARIFY",
     r"(There are two common definitions|NIBRS tracks three types of assault"
     r"|Your question is ambiguous|I need to clarify|I need clarification|Did you mean"
     r"|Could you clarify|which cities would you like)"),

    ("decline: place not covered", "DECLINE",
     r"(is not in our dataset of|no active city-agency ORI|could?n.?t safely resolve"
     r"|could?n.?t build a reliable query for that specific geography)"),
    ("decline: measure not in this dataset", "DECLINE",
     r"(does not track|does not contain|does?n.?t track|does?n.?t contain|does?n.?t include"
     r"|is not tracked|are not tracked|contains only|tracks the 7 Part I UCR offenses"
     r"|not one of the 7 Part I|tracks a sample of agencies|does not have crime data below"
     r"|does not report crime data below|no general use-of-force field|contains reported crime counts"
     r"|Historical Library contains|includes only total population|annual crime data only"
     r"|does not classify arrests by charge severity)"),
    ("decline: method not sound", "DECLINE",
     r"(I can.?t calculate|I can.?t reliably|I cannot provide a reliable|cannot be answered reliably"
     r"|cannot calculate clearance rates|would be misleading|no reliable denominator|I can.?t compute"
     r"|I can.?t safely|not a sound|is per-agency, not a statewide|requires comparing"
     r"|cannot be answered with crime data alone|was?n.?t able to calculate a valid per-capita)"),
    ("decline: period not covered", "DECLINE",
     r"(is not yet available|not yet available in this database|partial and preliminary"
     r"|only available through|currently contains crime data through"
     r"|currently has (annual|clearance) data through|This tab covers|are not available in Current Trends)"),
    ("redirect: wrong tab for this question", "DECLINE",
     r"(please use the \*\*Historical Li|is available in the \*\*Historical Library\*\* tab"
     r"|Try switching|available in the \*\*)"),
]

# A sentence asserting that a query ran and came back empty.
CLAIMS_A_QUERY_RAN = re.compile(
    r"(th(is|at|e) query returned no results|the query ran|no data was (found|returned) for that"
    r"|all the values came back empty|I ran that query)", re.I)

RANKING = re.compile(
    r"\b(top\s+\d+|top\s+(ten|twenty|five)|highest|lowest|most\s+\w+|fewest|worst|safest|"
    r"biggest|largest|smallest|rank(ed|ing)?|leading|which (city|cities|state|states|agency|agencies"
    r"|county|counties)\s+ha[sd]|deadliest|greatest)\b", re.I)
COMPARISON = re.compile(
    r"\b(compare[ds]?|comparison|versus|\bvs\.?\b|compared (to|with)|relative to|"
    r"than\s+(?:in\s+)?[A-Z]|difference between|against)\b", re.I)
CHANGE = re.compile(
    r"\b(change|changed|increase[ds]?|decrease[ds]?|rise|risen|rose|fall|fell|drop(ped)?|"
    r"trend|since \d{4}|from \d{4} to \d{4}|year[- ]over[- ]year|growth|decline[ds]?)\b", re.I)

YEAR = re.compile(r"\b(19[3-9]\d|20[0-2]\d)\b")
AGGREGATE_ONLY = re.compile(
    r"\b(historical_state_national|national_clearance_rate|national_monthly|state_monthly)\b", re.I)
LOCAL_TABLE = re.compile(
    r"\b(agency_monthly|historical_agency\w*|agency_population|historical_staffing|agencies)\b", re.I)
LOCAL_WORD = re.compile(r"\b(city|cities|county|counties|parish|department|pd\b|police)\b", re.I)


def classify(text, has_sql=False):
    """Return (category, verdict) for one row. UNCLASSIFIED is never folded into a verdict.

    Failure precedence is the whole point of the ordering, and it has to hold in ONE decision.
    An earlier version tested the rules here and then let a separate `CLAIMS_A_QUERY_RAN` check
    overwrite the answer, so a row reading

        "Query timed out after 30 seconds. The query returned no results."

    was classified FAILURE and then downgraded to EMPTY_RESULT -- a failure counted as a healthy
    empty result. The query-ran test now sits between the failure rules and the refusal rules, so
    it can never replace a failure.
    """
    body = re.sub(r"\s+", " ", (text or "")).strip()
    if not body:
        return ("empty response (an error with no prose)", "FAILURE")

    for key, verdict, pattern in RULES:
        if verdict == "FAILURE" and re.search(pattern, body, re.I):
            return (key, verdict)

    if CLAIMS_A_QUERY_RAN.search(body):
        if has_sql:
            return ("honest empty result (a query really ran)", "EMPTY_RESULT")
        return ("FALSE CLAIM: says a query ran, none was produced", "FAILURE")

    for key, verdict, pattern in RULES:
        if verdict != "FAILURE" and re.search(pattern, body, re.I):
            return (key, verdict)
    return ("UNCLASSIFIED", "UNCLASSIFIED")


def shapes_of(question):
    q = question or ""
    found = set()
    if RANKING.search(q):
        found.add("ranking")
    if COMPARISON.search(q):
        found.add("comparison")
    if CHANGE.search(q):
        found.add("change over time")
    return found or {"neither"}


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def analyse(snapshot, crime_db=None):
    con = sqlite3.connect(f"file:{snapshot}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT id, ts, tab, question, sql, rows, response, error FROM query_log").fetchall()

    out = {
        "snapshot": str(snapshot),
        "snapshot_sha256": digest(snapshot),
        "total_questions": len(rows),
    }

    # ---- 1. classification of zero-row answers -------------------------------------------
    zero = [r for r in rows if (r["rows"] or 0) == 0]
    verdicts, cats = collections.Counter(), collections.Counter()
    per_row_verdict = {}
    for r in zero:
        key, verdict = classify(r["response"], has_sql=bool((r["sql"] or "").strip()))
        verdicts[verdict] += 1
        cats[key] += 1
        per_row_verdict[r["id"]] = verdict

    out["zero_row"] = {
        "count": len(zero),
        "share_of_all": round(100 * len(zero) / max(len(rows), 1), 1),
        "verdicts": dict(verdicts),
        "categories": dict(cats),
    }

    # ---- 2. question shape x outcome, the cross-tab -------------------------------------
    # Raw zero-row rate mixes failures with correct clarifications and declines, so it cannot
    # answer "do ranking questions fail more". This reports the verdict distribution per shape.
    tab = collections.defaultdict(collections.Counter)
    for r in rows:
        answered = (r["rows"] or 0) > 0
        verdict = "ANSWERED" if answered else per_row_verdict.get(r["id"], "UNCLASSIFIED")
        for s in shapes_of(r["question"]):
            tab[s][verdict] += 1
            tab[s]["_total"] += 1
        if {"ranking", "comparison"} & shapes_of(r["question"]):
            tab["ranking OR comparison"][verdict] += 1
            tab["ranking OR comparison"]["_total"] += 1
    tab["ALL QUESTIONS"] = collections.Counter()
    for r in rows:
        answered = (r["rows"] or 0) > 0
        verdict = "ANSWERED" if answered else per_row_verdict.get(r["id"], "UNCLASSIFIED")
        tab["ALL QUESTIONS"][verdict] += 1
        tab["ALL QUESTIONS"]["_total"] += 1
    out["by_shape"] = {k: dict(v) for k, v in tab.items()}

    # ---- 3. query fidelity, where a crime database is available -------------------------
    if crime_db:
        out["fidelity"] = fidelity(rows, crime_db)

    return out


def fidelity(rows, crime_db):
    """Does the SQL restrict to the place and period the question named?

    Only fires when the question is unambiguous. A mechanical flag is not a finding: the published
    report states the hand-measured precision of these flags (about 36% for place).
    """
    # Accepts a path (opened read-only) or an already-open connection, so the self-test can pass a
    # synthetic in-memory database instead of shipping a fixture file.
    db = crime_db if isinstance(crime_db, sqlite3.Connection) else sqlite3.connect(
        f"file:{crime_db}?mode=ro", uri=True)
    noise = {"north", "south", "east", "west", "central", "major", "county", "city", "state",
             "police", "sheriff", "department", "university", "college", "district", "park",
             "union", "index", "washington", "columbia", "mobile", "normal", "reading",
             "surprise", "hope", "many", "why", "jersey", "mexico"}

    # `agencies` and `historical_agency` hold records named for whole states -- state police and
    # highway patrol. Left in, a question like "California murder rate" reads as a *city* question,
    # and answering it from `historical_state_national` then looks like a wrong-level substitution
    # when it is exactly right. Leaving these in inflated the count from 7 to 132.
    state_names = {r[0].strip().lower() for r in db.execute(
        "SELECT DISTINCT state FROM historical_state_national WHERE state IS NOT NULL")}

    cities = set()
    for table in ("agencies", "historical_agency"):
        try:
            for (name,) in db.execute(f"SELECT DISTINCT agency FROM {table} WHERE agency IS NOT NULL"):
                key = (name or "").strip().lower()
                if len(key) >= 5 and key not in noise and key not in state_names:
                    cities.add(key)
        except sqlite3.OperationalError:
            pass

    counts = collections.Counter()
    examples = []
    for r in rows:
        if (r["rows"] or 0) <= 0 or r["tab"] not in ("historical", "current"):
            continue
        sql = r["sql"] or ""
        if not sql.strip():
            continue
        q = r["question"] or ""
        counts["answered with SQL (historical+current)"] += 1
        ql = " " + re.sub(r"[^a-z0-9 ]+", " ", q.lower()) + " "

        named = {c for c in cities if f" {c} " in ql}
        if named or LOCAL_WORD.search(q):
            counts["question is about a city/county"] += 1
            if AGGREGATE_ONLY.search(sql) and not LOCAL_TABLE.search(sql):
                counts["answered ONLY from a state/national table"] += 1
                if any(c in (r["response"] or "").lower() for c in named):
                    counts["...and the caption names the place anyway"] += 1
                    examples.append({"id": r["id"], "tab": r["tab"],
                                     "question": re.sub(r"\s+", " ", q)[:120]})

        qyears = {int(y) for y in YEAR.findall(q)}
        if qyears:
            counts["question names a year"] += 1
            syears = {int(y) for y in YEAR.findall(sql)}
            if syears and not (qyears & syears) and not any(
                    min(syears) <= y <= max(syears) for y in qyears):
                counts["PERIOD MISMATCH"] += 1
    return {"counts": dict(counts), "wrong_level_examples": examples[:10]}


def self_test():
    """Exercise every classification rule against synthetic rows -- no production text."""
    fixture = pathlib.Path(__file__).parent / "fixtures" / "answer-log-classification.json"
    cases = json.loads(fixture.read_text(encoding="utf-8"))
    failed = 0
    for case in cases:
        key, verdict = classify(case["response"], has_sql=case.get("has_sql", False))
        got_shapes = sorted(shapes_of(case.get("question", "")))
        ok = verdict == case["expect_verdict"]
        if "expect_shapes" in case:
            ok = ok and got_shapes == sorted(case["expect_shapes"])
        if not ok:
            failed += 1
            print(f"  FAIL  {case['name']}")
            print(f"        verdict {verdict!r} expected {case['expect_verdict']!r}")
            if "expect_shapes" in case:
                print(f"        shapes  {got_shapes} expected {sorted(case['expect_shapes'])}")
        else:
            print(f"  PASS  {case['name']}")
    failed += _fidelity_self_test()
    print(f"\ndiagnose-answer-log self-test: {len(cases)+FIDELITY_CASES-failed} passed, {failed} failed")
    return 1 if failed else 0


FIDELITY_CASES = 3


def _fidelity_self_test():
    """Wrong-level substitution, against a synthetic database -- no production data.

    The case that matters is the third: `agencies` really does contain records named for whole
    states, and counting those as cities inflated this measure by a factor of nearly twenty.
    """
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE agencies (agency TEXT)")
    db.execute("CREATE TABLE historical_agency (agency TEXT)")
    db.execute("CREATE TABLE historical_state_national (state TEXT)")
    db.executemany("INSERT INTO agencies VALUES (?)",
                   [("Example City",), ("California",), ("Sample County",)])
    db.executemany("INSERT INTO historical_state_national VALUES (?)",
                   [("California",), ("Texas",)])
    db.commit()

    def row(rid, question, sql, response):
        return {"id": rid, "tab": "historical", "rows": 1, "question": question,
                "sql": sql, "response": response}

    cases = [
        (row(1, "crime in Example City over time",
             "SELECT year FROM historical_state_national WHERE state = 'Texas'",
             "Crime rates for Example City from 1960 to 2024."),
         1, "a city question served from a state table, captioned with the city"),
        (row(2, "crime in Example City over time",
             "SELECT year FROM historical_agency_crime WHERE ori = 'XX0010100'",
             "Crime for Example City."),
         0, "a city question served from an agency table is not flagged"),
        (row(3, "California murder rate over time",
             "SELECT year FROM historical_state_national WHERE state = 'California'",
             "Statewide murder rate for California."),
         0, "a STATE question served from a state table is not a wrong-level substitution"),
    ]

    bad = 0
    for r, expected, name in cases:
        got = fidelity([r], db)["counts"].get("...and the caption names the place anyway", 0)
        if got == expected:
            print(f"  PASS  fidelity: {name}")
        else:
            bad += 1
            print(f"  FAIL  fidelity: {name} -- flagged {got}, expected {expected}")
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--snapshot", help="read-only copy of query_log.db")
    ap.add_argument("--crime-db", help="read-only copy of crime_data.db, enables fidelity checks")
    ap.add_argument("--json", help="write the full result here")
    ap.add_argument("--self-test", action="store_true", help="run fixtures and exit")
    args = ap.parse_args()

    if args.self_test:
        raise SystemExit(self_test())
    if not args.snapshot:
        ap.error("--snapshot is required unless --self-test is given")

    result = analyse(pathlib.Path(args.snapshot), args.crime_db)

    print(f"snapshot      : {result['snapshot']}")
    print(f"sha256        : {result['snapshot_sha256']}")
    print(f"questions     : {result['total_questions']}")
    z = result["zero_row"]
    print(f"zero-row      : {z['count']} ({z['share_of_all']}% of all questions)\n")

    print("--- zero-row verdicts (UNCLASSIFIED is never folded into another verdict) ---")
    for v, n in sorted(z["verdicts"].items(), key=lambda kv: -kv[1]):
        print(f"{n:6d}  {100*n/max(z['count'],1):5.1f}% of zero-row  "
              f"{100*n/max(result['total_questions'],1):5.1f}% of all   {v}")

    print("\n--- question shape x outcome ---")
    hdr = ["ANSWERED", "CLARIFY", "DECLINE", "FAILURE", "EMPTY_RESULT", "UNCLASSIFIED"]
    print(f"{'shape':24s} {'n':>6s} " + " ".join(f"{h[:9]:>9s}" for h in hdr))
    for shape in ["ranking", "comparison", "ranking OR comparison", "change over time",
                  "neither", "ALL QUESTIONS"]:
        c = result["by_shape"].get(shape)
        if not c:
            continue
        tot = c.get("_total", 0)
        cells = " ".join(f"{100*c.get(h,0)/max(tot,1):8.1f}%" for h in hdr)
        print(f"{shape:24s} {tot:6d} {cells}")

    if "fidelity" in result:
        print("\n--- query fidelity ---")
        for k, n in result["fidelity"]["counts"].items():
            print(f"{n:6d}  {k}")

    if args.json:
        pathlib.Path(args.json).write_text(json.dumps(result, indent=1), encoding="utf-8")
        print(f"\nwrote {args.json}")


if __name__ == "__main__":
    main()
