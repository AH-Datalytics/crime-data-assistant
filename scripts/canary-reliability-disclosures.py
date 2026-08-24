"""Production canaries for the reliability disclosure + consolidated-successor guard.

Usage:
  python scripts/canary-reliability-disclosures.py                 # production
  python scripts/canary-reliability-disclosures.py http://localhost:3000

Run after any deploy that touches lib/reliability-disclosure.ts,
lib/agency-reliability.ts, lib/agency-consolidations.ts, or the disclosure wiring
in app/api/query/route.ts.

THREE RULES KEEP THESE HONEST -- each one exists because its absence produced a
false pass or a false failure during the 2026-08-07 rollout:

1. Every canary MUST RETURN ROWS. A refusal (rows=0) fails loudly and can never be
   read as "no caveat". The first version of this harness scored four refusals as
   passing silence, which hid a guard bug that was rejecting correct SQL outright.

2. The caveat is checked on the INITIAL result event AND on the refined explanation.
   The whole point of the disclosure fix is that the first (and cached) answer
   carries the note, so a late-only caveat must fail.

3. The page token is minted ONCE and AGED past one second. lib/page-token.ts rejects
   tokens younger than 1s as bot traffic, so a mint-and-use-immediately harness gets
   a blanket 403 that looks like an outage.

SQL generation is model-driven, so each canary gets a few attempts before failing.
Questions are phrased to avoid the countywide-vs-sheriff clarifier, which returns
zero rows by design.
"""
import json
import sys
import time

import requests

# PRODUCTION IS OPT-IN -- see the note in scripts/smoke-test.py. A bare invocation targets localhost.
# The site password is removed rather than re-homed: the site is intentionally public.
DEFAULT_BASE = "http://localhost:3000"
_args = [a for a in sys.argv[1:] if a != "--print-target"]
BASE = _args[0] if _args else DEFAULT_BASE

if "--print-target" in sys.argv:
    print(BASE)
    sys.exit(0)

CAVEAT = "may be incomplete"
ATTEMPTS = 3

# (key, label, mode, question, expect_caveat, note_must_mention)
CANARIES = [
    ("lou_murder", "Louisville murder 2025 -- rows + caveat",
     "historical", "Murders in Louisville in 2025", True, ["murder", "2025"]),
    ("lou_series", "Louisville murder series -- rows + caveat",
     "historical", "Louisville murders by year since 2020", True, ["murder", "2025"]),
    # The 2025 Louisville finding is a murder-only column collapse; it must not taint theft.
    ("lou_theft", "Louisville theft 2025 -- rows, NO murder caveat",
     "historical", "Thefts in Louisville in 2025", False, []),
    # Cook County IL carries a 2022 partial-year flag, which taints every crime measure.
    # Bare "Murders in Cook County" triggers the countywide-vs-sheriff clarifier, so name
    # the county agency explicitly.
    ("cook_agency", "Cook County agency 2022 partial-year -- rows + caveat",
     "historical", "Murders reported by the Cook County police department in Illinois in 2022",
     True, ["2022"]),
    # The countywide sum must NEVER inherit the county agency's flag.
    ("cook_wide", "Cook County countywide -- rows, uncaveated (no sheriff flag)",
     "historical", "Murders across all agencies in Cook County, Illinois in 2022", False, []),
    ("tulsa", "Tulsa 2025 control -- rows, uncaveated",
     "historical", "Murders in Tulsa in 2025", False, []),
    ("chicago", "Chicago 2025 control -- rows, uncaveated",
     "historical", "Murders in Chicago in 2025", False, []),
    ("current", "Current Trends unaffected by this matcher",
     "current", "Murders in Louisville in 2025", False, []),
]


def session():
    """A plain session. The site is public, so there is no login step -- the page token below is what
    the query routes actually require."""
    return requests.Session()


def page_token(s):
    """Mint once and age it: page-token.ts rejects tokens younger than 1s."""
    r = s.get(f"{BASE}/api/page-token", timeout=30)
    if r.status_code != 200:
        print(f"PAGE TOKEN FAILED {r.status_code}: {r.text[:200]}")
        sys.exit(1)
    token = r.json()["token"]
    time.sleep(2)
    return token


def ask(s, mode, question, token):
    r = s.post(
        f"{BASE}/api/query",
        json={"question": question, "mode": mode, "history": [], "pageToken": token},
        headers={"Accept": "text/event-stream"},
        stream=True,
        timeout=150,
    )
    if r.status_code != 200:
        return {"_error": f"HTTP {r.status_code}"}
    out = {"initial": "", "refined": None, "rows": 0, "sql": ""}
    for line in r.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        try:
            event = json.loads(line[6:])
        except json.JSONDecodeError:
            continue
        kind = event.get("type")
        if kind == "result":
            out["initial"] = event.get("explanation") or ""
            out["rows"] = event.get("rowCount") or 0
            out["sql"] = event.get("sql") or ""
        elif kind == "explanation":
            out["refined"] = event.get("text") or ""
        elif kind == "error":
            out["_error"] = event.get("text", "unknown error")
    return out


def reliability_note(text):
    """The disclosure sentence, skipping other 'Note:' prefixed disclaimers."""
    i = text.find("Note:")
    while i != -1:
        segment = text[i:]
        if CAVEAT in segment.split("Note:", 1)[1][:200]:
            return segment
        i = text.find("Note:", i + 1)
    return text


def evaluate(result, expect, mentions):
    if result.get("_error"):
        return False, f"error: {result['_error']}"
    if result["rows"] == 0:
        return False, f"REFUSED / no rows -- {result['initial'][:110]}"
    initial = result["initial"]
    final = result["refined"] if result["refined"] is not None else initial
    on_initial, on_final = CAVEAT in initial, CAVEAT in final
    ok = (on_initial == expect) and (on_final == expect)
    if ok and expect and mentions:
        note = reliability_note(initial).lower()
        ok = all(m.lower() in note for m in mentions)
    detail = f"rows={result['rows']} caveat_initial={on_initial} caveat_refined={on_final}"
    if on_initial:
        detail += "\n        note: " + reliability_note(initial)[:150]
    return ok, detail


def main():
    print(f"  canaries against {BASE}")
    s = session()
    token = page_token(s)
    failures = []
    passed_runs = {}

    for key, label, mode, question, expect, mentions in CANARIES:
        ok, detail = False, ""
        for _ in range(ATTEMPTS):
            result = ask(s, mode, question, token)
            ok, detail = evaluate(result, expect, mentions)
            if ok:
                passed_runs[key] = result
                break
            time.sleep(1)
        print(f"  {'PASS' if ok else 'FAIL'}  {label}")
        print(f"        {detail}")
        if not ok:
            failures.append(label)

    # A cached repeat must return the SAME caveated answer -- the note is computed
    # before the result event precisely so the cached copy carries it.
    label = "cached repeat is identically caveated"
    first = passed_runs.get("lou_murder")
    if not first:
        print(f"  SKIP  {label} (first Louisville canary did not pass)")
        failures.append(label + " [skipped]")
    else:
        repeat = ask(s, "historical", "Murders in Louisville in 2025", token)
        ok, detail = evaluate(repeat, True, ["murder", "2025"])
        identical = ok and reliability_note(repeat["initial"]).strip() == reliability_note(first["initial"]).strip()
        print(f"  {'PASS' if identical else 'FAIL'}  {label}")
        print(f"        {detail}")
        if not identical:
            failures.append(label)

    total = len(CANARIES) + 1
    print(f"\n  {total - len(failures)}/{total} canaries passed")
    for name in failures:
        print(f"    FAILED: {name}")
    sys.exit(1 if failures else 0)


main()
