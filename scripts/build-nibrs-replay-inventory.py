#!/usr/bin/env python3
"""Build the NIBRS replay inventory (the shadow-comparison test set) from a query_log export.

Export (read-only, on the VPS; the window is fixed so the inventory is reproducible):

    ssh root@178.156.243.51 'sqlite3 -readonly -json /opt/nibrs/shared/query_log.db "select id, ts, question, sql,
      rows, error, ms, response, guardrails, model, session_id, routing_mode, routing_reason, query_contract,
      request_id, record_kind, reason_code, delivery_action, result_digest, proof_mode, plan_family from query_log
      where tab=\\"nibrs\\" and ts >= strftime(\\"%s\\",\\"2026-08-29\\")*1000
      and ts < strftime(\\"%s\\",\\"2026-10-28\\")*1000 order by id"' > qlog_nibrs_60d.json

Then:

    python scripts/build-nibrs-replay-inventory.py qlog_nibrs_60d.json

writes scripts/fixtures/nibrs-replay/inventory.json and summary.md. Session ids are replaced by a salted hash
prefix (enough to keep a conversation together, not to look the session up).
"""
import collections
import datetime
import hashlib
import json
import os
import re
import sys

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "nibrs-replay")
WINDOW = ("2026-08-29", "2026-10-27")

# Internal traffic: the daily digest's rule (scripts/daily-query-analysis.js INTERNAL_SESSION) plus the named
# baseline and release-check sessions it predates.
INTERNAL = re.compile(r"(?:live-replay|codex|deploy-smoke|targeted-probe|layer3|canary|scoreboard|benchmark|eval"
                      r"|correctness-baseline|presentation-study|^release-)", re.I)

# A question that only makes sense after an earlier one in the same conversation.
FOLLOW_UP = re.compile(r"^\s*(?:now|just|and|also|what about|how about|same|disaggregate|break (?:it|that|this)|"
                       r"show (?:me )?(?:annual|monthly|only|that|it|those)|only|by (?:year|month)|instead|"
                       r"(?:and )?(?:for|in) \d{4}\b|\d{4}\??$|yes|no|option)", re.I)

# Heuristic tags for what a question asks for, to plan the switch by capability. Tags are hints, not judgements.
TAGS = [
    ("monthly", r"\b(?:month|monthly|per month|by month)\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b"),
    ("yearly_series", r"\b(?:by year|per year|annual|each year|yearly|trend|over time|from \d{4} to \d{4}|since \d{4})\b"),
    ("breakdown", r"\bby (?:race|sex|gender|age|ethnicity|weapon|location|relationship|offense|offender|victim|arrestee|type|category|drug|bias|hour|day)\b|\bdisaggregat"),
    ("two_or_more_breakdowns", r"\bby \w+(?: \w+)? (?:and|by|x) (?:by )?(?:race|sex|gender|age|ethnicity|weapon|month|year|location)\b"),
    ("share", r"\b(?:share|percent|percentage|proportion|what fraction|how many of)\b"),
    ("rate", r"\b(?:rate|per capita|per 100,?000|per 100k)\b"),
    ("ranking", r"\b(?:top|highest|lowest|most|least|rank|ranking|which (?:city|cities|state|states|agency|agencies))\b"),
    ("change", r"\b(?:change|increase|decrease|rise|fall|compared? to|versus|vs\.?)\b"),
    ("rolling", r"\brolling\b|\btrailing\b"),
    ("clearance", r"\bclear(?:ed|ance)s?\b"),
    ("arrests", r"\barrest(?:s|ed|ee|ees)?\b"),
    ("offenders", r"\boffenders?\b|\bsuspects?\b"),
    ("victims", r"\bvictims?\b"),
    ("property", r"\b(?:stolen|recovered|property|value|firearm stolen|guns? stolen)\b"),
    ("weapon", r"\b(?:gun|guns|firearm|firearms|handgun|knife|weapon)\b"),
    ("national", r"\b(?:nationwide|national|nationally|united states|the us|u\.s\.|america|country)\b"),
    ("cohort", r"\b(?:consistent(?:ly)? report|same agencies|all reporting)\b"),
    ("city_size", r"\b(?:large cities|big cities|cities (?:of|over|with|above) [\d,]+|\d{3},?\d{3}\+? (?:people|residents|population))\b"),
    ("explain", r"\bwhy\b|\bcause|\bexplain\b"),
]
TAGS = [(t, re.compile(p, re.I)) for t, p in TAGS]


def outcome(r):
    """Today's outcome category, from the decision record."""
    kind, action, reason, model = r["record_kind"], r["delivery_action"], r["reason_code"], r["model"]
    if kind is None:
        return "unrecorded"
    if kind == "operational":
        return "operational"
    if action == "answer" and reason == "deterministic_plan":
        return "answer_deterministic"
    if action == "answer" and reason == "model_sql_validated":
        return "answer_model_sql_historical"
    if action in ("answer", "answer_limited_scope"):
        return f"{action}:{reason}"
    return f"{action}:{reason}"


def main(src):
    with open(src, encoding="utf-8") as f:
        rows = json.load(f)
    salt = "nibrs-replay-2026-10-28"
    sess = lambda s: hashlib.sha256((salt + s).encode()).hexdigest()[:10] if s else None
    turns = collections.Counter()
    last_by_session = {}
    last_no_session = None
    items = []
    for r in rows:
        t = datetime.datetime.fromtimestamp(r["ts"] / 1000, datetime.timezone.utc)
        sid = r["session_id"]
        origin = "internal" if sid and INTERNAL.search(sid) else "public"
        key = sess(sid)
        prev = None
        if sid:
            turns[sid] += 1
            prev = last_by_session.get(sid)
            last_by_session[sid] = r
        else:
            # Embedded and API requests carry no session id; the previous one within 30 minutes is the likely context.
            if last_no_session and r["ts"] - last_no_session["ts"] < 30 * 60 * 1000:
                prev = last_no_session
            last_no_session = r
        q = r["question"] or ""
        items.append({
            "id": r["id"],
            "at": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "origin": origin,
            "session": key,
            "turn": turns[sid] if sid else None,
            "question": q,
            "follow_up_likely": bool(prev) and bool(FOLLOW_UP.search(q) or len(q.split()) <= 4),
            "previous_question_id": prev["id"] if prev else None,
            "outcome": outcome(r),
            "today": {
                "record_kind": r["record_kind"], "delivery_action": r["delivery_action"], "reason_code": r["reason_code"],
                "model": r["model"], "plan_family": r["plan_family"], "rows": r["rows"], "ms": r["ms"],
                "error": r["error"], "result_digest": r["result_digest"], "sql": r["sql"],
                "response": r["response"],
            },
            "tags": [t for t, p in TAGS if p.search(q)],
        })

    public = [i for i in items if i["origin"] == "public"]
    by_outcome = collections.Counter(i["outcome"] for i in public)
    os.makedirs(OUT, exist_ok=True)
    doc = {
        "_comment": "NIBRS replay inventory: every NIBRS-tab request in the window, with today's outcome. The shadow-comparison test set (restructure plan phase 5). Built by scripts/build-nibrs-replay-inventory.py; see README.md.",
        "window_utc": {"from": WINDOW[0], "to_inclusive": WINDOW[1]},
        "counts": {"all": len(items), "public": len(public), "internal": len(items) - len(public),
                   "public_by_outcome": dict(by_outcome.most_common())},
        "items": items,
    }
    with open(os.path.join(OUT, "inventory.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
        f.write("\n")

    lines = [f"# NIBRS replay inventory, {WINDOW[0]} to {WINDOW[1]} (UTC)", "",
             f"{len(items)} NIBRS requests: {len(public)} public, {len(items) - len(public)} internal "
             "(correctness and presentation baselines, release checks).", "",
             "## Public requests by today's outcome", "", "| Outcome | Requests | Follow-ups among them |", "|---|---|---|"]
    for o, n in by_outcome.most_common():
        fu = sum(1 for i in public if i["outcome"] == o and i["follow_up_likely"])
        lines.append(f"| {o} | {n} | {fu} |")
    internal = [i for i in items if i["origin"] == "internal"]
    lines += ["", "## Internal requests by today's outcome", "",
              "Kept in the inventory: the correctness baselines are gold questions. They are reported apart from public traffic.",
              "", "| Outcome | Requests |", "|---|---|"]
    for o, n in collections.Counter(i["outcome"] for i in internal).most_common():
        lines.append(f"| {o} | {n} |")
    lines += ["", "## Public requests by tag (heuristic) and outcome", "",
              "| Tag | Requests | Answered today (deterministic) | Answered historically by model SQL | Declined or clarified |",
              "|---|---|---|---|---|"]
    for t, _ in TAGS:
        sel = [i for i in public if t in i["tags"]]
        if not sel:
            continue
        a = sum(i["outcome"] == "answer_deterministic" for i in sel)
        m = sum(i["outcome"] == "answer_model_sql_historical" for i in sel)
        lines.append(f"| {t} | {len(sel)} | {a} | {m} | {len(sel) - a - m} |")
    with open(os.path.join(OUT, "summary.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print(json.dumps(doc["counts"], indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
