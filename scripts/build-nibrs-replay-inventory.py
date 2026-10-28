#!/usr/bin/env python3
"""Build the NIBRS replay inventory (the shadow-comparison test set) from read-only query_log exports.

Exports (read-only, on the VPS; the window is fixed so the inventory is reproducible), all into one private folder
outside the repository (they hold raw session ids):

    W='ts >= strftime("%s","2026-08-29")*1000 and ts < strftime("%s","2026-10-28")*1000'
    DB=/opt/nibrs/shared/query_log.db
    qlog_nibrs_60d.json      select id, ts, tab, question, sql, rows, error, ms, response, guardrails, model,
                             session_id, routing_confidence, routing_mode, routing_reason, query_guidance,
                             query_contract, request_id, record_kind, reason_code, delivery_action, result_digest,
                             proof_mode, plan_family from query_log where tab="nibrs" and $W order by id
    qlog_session_turns.json  select id, ts, tab, question, session_id from query_log where session_id in (the window's
                             NIBRS session ids) order by id          -- every tab, for cross-source history
    chart_artifacts.json     select a.* from chart_audit_artifacts a join query_log q on q.id = a.query_log_id
                             where q.tab="nibrs" and q.$W           -- the result data of charted answers
    retained_releases.txt    release, commit and built_at of each release directory still on the VPS
    extracted_at.txt         UTC time of the export

    python scripts/build-nibrs-replay-inventory.py <private folder>

writes scripts/fixtures/nibrs-replay/inventory.json and summary.md. Session ids are replaced by a salted hash prefix:
pseudonymous, not anonymous (the salt is in this file and internal ids are guessable).
"""
import collections
import datetime
import hashlib
import json
import os
import re
import sys

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "nibrs-replay")
WINDOW = ("2026-08-29", "2026-10-28")  # [from, to) UTC
WINDOW_MS = tuple(int(datetime.datetime.fromisoformat(d).replace(tzinfo=datetime.timezone.utc).timestamp() * 1000) for d in WINDOW)
SQL_LOG_LIMIT = 4000  # the logger truncates sql at this length
RUN_GAP_MS = 2 * 60 * 60 * 1000  # turns of one session more than 2 hours apart are separate runs

# Internal traffic: the daily digest's rule (scripts/daily-query-analysis.js INTERNAL_SESSION) plus the named
# baseline and release-check sessions it predates. Everything else is "unmatched": not proven human.
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
    """The outcome recorded at the time, from the decision record."""
    kind, action, reason = r["record_kind"], r["delivery_action"], r["reason_code"]
    if kind is None:
        return "unrecorded"
    if kind == "operational":
        return "operational"
    if action == "answer" and reason == "deterministic_plan":
        return "answer_deterministic"
    if action == "answer" and reason == "model_sql_validated":
        return "answer_model_sql_historical"
    return f"{action}:{reason}"


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def load(folder, name):
    with open(os.path.join(folder, name), encoding="utf-8") as f:
        return json.load(f)


def main(folder):
    rows = load(folder, "qlog_nibrs_60d.json")
    turns_all = load(folder, "qlog_session_turns.json")
    charts = {c["query_log_id"]: c for c in load(folder, "chart_artifacts.json")}
    with open(os.path.join(folder, "extracted_at.txt"), encoding="utf-8") as f:
        extracted_at = f.read().strip()

    # Validate the input: the window, unique ids, one tab.
    ids = [r["id"] for r in rows]
    assert len(ids) == len(set(ids)), "duplicate ids in the export"
    assert all(WINDOW_MS[0] <= r["ts"] < WINDOW_MS[1] and r["tab"] == "nibrs" for r in rows), "a row outside the window or tab"
    assert extracted_at >= WINDOW[1], "the export ran before the window closed"

    salt = "nibrs-replay-2026-10-28"
    pseud = lambda s: hashlib.sha256((salt + s).encode()).hexdigest()[:10] if s else None

    # Every turn of every session, any tab, split into runs at gaps over two hours.
    by_session = collections.defaultdict(list)
    for t in turns_all:
        by_session[t["session_id"]].append(t)
    run_of = {}
    for sid, ts in by_session.items():
        ts.sort(key=lambda t: t["id"])
        run, last = 0, None
        for t in ts:
            if last is not None and t["ts"] - last > RUN_GAP_MS:
                run += 1
            run_of[t["id"]] = run
            last = t["ts"]

    items, last_sessionless = [], None
    for r in rows:
        sid, q = r["session_id"], r["question"] or ""
        origin = "internal" if sid and INTERNAL.search(sid) else "unmatched"
        follow = bool(FOLLOW_UP.search(q) or len(q.split()) <= 4)
        if sid:
            run = run_of[r["id"]]
            prior = [t for t in by_session[sid] if t["id"] < r["id"] and run_of[t["id"]] == run]
            context = {
                "status": "session_chain" if prior else "first_turn",
                "run": f"{pseud(sid)}-{run}",
                "prior_turns": [{"id": t["id"], "tab": t["tab"], "question": t["question"]} for t in prior],
                "prior_turns_other_tabs": sum(t["tab"] != "nibrs" for t in prior),
                "candidate_predecessor_id": None,
            }
        else:
            cand = last_sessionless if last_sessionless and r["ts"] - last_sessionless["ts"] < 30 * 60 * 1000 else None
            context = {"status": "no_session", "run": None, "prior_turns": [], "prior_turns_other_tabs": 0,
                       "candidate_predecessor_id": cand["id"] if cand else None}
            last_sessionless = r
        context["assistant_history"] = "not_logged"
        context["follow_up_likely"] = follow and context["status"] != "first_turn"
        # How phase 5 replays the item. A chain is replayed turn by turn in one session, so the engine sees its own
        # earlier answers; the history users actually saw is not logged. Sessionless follow-ups need a person.
        if context["status"] == "no_session":
            context["replay"] = "human_review" if follow and context["candidate_predecessor_id"] else "standalone"
        elif context["status"] == "session_chain":
            context["replay"] = "replay_chain"
        else:
            context["replay"] = "standalone"

        chart = charts.get(r["id"])
        sql = r["sql"] or ""
        baseline = {
            "kind": "historical_observation",
            "answer_data": None if not chart else {
                "columns": json.loads(chart["columns_json"]), "data": json.loads(chart["data_json"]),
                "row_count": chart["row_count"], "captured_row_count": chart["captured_row_count"],
                "truncated": bool(chart["truncated"]), "truncation_reason": chart["truncation_reason"],
                "data_hash": chart["data_hash"], "chart_config": json.loads(chart["chart_config"]),
            },
            "answer_data_status": ("captured_truncated" if chart["truncated"] else "captured") if chart
                                  else ("not_applicable" if not r["rows"] else "unavailable"),
            "row_count": r["rows"],
            "explanation": r["response"],
            "sql": r["sql"],
            "sql_truncated": len(sql) >= SQL_LOG_LIMIT,
            "result_digest": r["result_digest"],
            "error": r["error"],
            "ms": r["ms"],
            "release": "unknown",
        }
        items.append({
            "id": r["id"],
            "ts_ms": r["ts"],
            "at": datetime.datetime.fromtimestamp(r["ts"] / 1000, datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "origin": origin,
            "session": pseud(sid),
            "question": q,
            "request": {
                "endpoint": "/api/nibrs-query", "tab": r["tab"], "request_id": r["request_id"],
                "routing_mode": r["routing_mode"], "routing_reason": r["routing_reason"], "routing_confidence": r["routing_confidence"],
                "query_contract": r["query_contract"], "query_guidance": r["query_guidance"], "guardrails": r["guardrails"],
            },
            "context": context,
            "outcome_then": outcome(r),
            "decision_then": {"record_kind": r["record_kind"], "delivery_action": r["delivery_action"], "reason_code": r["reason_code"],
                              "model": r["model"], "plan_family": r["plan_family"], "proof_mode": r["proof_mode"]},
            "baseline": baseline,
            "tags": [t for t, p in TAGS if p.search(q)],
        })

    releases = []
    with open(os.path.join(folder, "retained_releases.txt"), encoding="utf-8") as f:
        for line in f:
            kv = dict(x.split("=", 1) for x in line.split() if "=" in x)
            if kv:
                releases.append(kv)

    unmatched = [i for i in items if i["origin"] == "unmatched"]
    internal = [i for i in items if i["origin"] == "internal"]
    count = lambda sel, f: dict(collections.Counter(f(i) for i in sel).most_common())
    doc = {
        "_comment": "NIBRS replay inventory: every NIBRS-tab request in the window with the outcome and answer recorded at the time. The shadow-comparison test set (restructure plan phase 5). Built by scripts/build-nibrs-replay-inventory.py; see README.md.",
        "provenance": {
            "window_utc": {"from": WINDOW[0], "to_exclusive": WINDOW[1]},
            "extracted_at": extracted_at,
            "latest_record": items[-1]["at"],
            "source": "/opt/nibrs/shared/query_log.db (read-only), queries in the builder's header",
            "input_sha256": {n: sha256(os.path.join(folder, n)) for n in ("qlog_nibrs_60d.json", "qlog_session_turns.json", "chart_artifacts.json", "retained_releases.txt")},
            "input_location": "C:\\Users\\jeffm\\nibrs-engine-private\\ (not in the repository: raw session ids)",
            "release_identity": "unknown per request. Release directories retained on the VPS go back only to 2026-10-21, and their built_at time is not the time they were live (rollbacks, e.g. 2026-10-24). They are listed under retained_releases as evidence, not as an attribution.",
            "retained_releases": releases,
        },
        "counts": {
            "all": len(items), "unmatched": len(unmatched), "internal": len(internal),
            "unmatched_by_outcome": count(unmatched, lambda i: i["outcome_then"]),
            "internal_by_outcome": count(internal, lambda i: i["outcome_then"]),
            "by_answer_data_status": count(items, lambda i: i["baseline"]["answer_data_status"]),
            "by_replay": count(items, lambda i: i["context"]["replay"]),
            "sql_truncated": sum(i["baseline"]["sql_truncated"] for i in items),
        },
        "items": items,
    }
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "inventory.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
        f.write("\n")

    lines = [f"# NIBRS replay inventory, {WINDOW[0]} to {WINDOW[1]} (exclusive), UTC", "",
             f"{len(items)} NIBRS requests: {len(unmatched)} not matched by the internal-session rule, {len(internal)} internal "
             f"(correctness and presentation baselines, release checks). Extracted {extracted_at}; latest record {items[-1]['at']}.", "",
             "## Outcomes recorded at the time", "", "| Outcome then | Unmatched | Internal |", "|---|---|---|"]
    outs = sorted({i["outcome_then"] for i in items}, key=lambda o: -sum(i["outcome_then"] == o for i in items))
    for o in outs:
        lines.append(f"| {o} | {sum(i['outcome_then'] == o for i in unmatched)} | {sum(i['outcome_then'] == o for i in internal)} |")
    lines += ["", "## Baseline answer data", "", "| Status | Requests |", "|---|---|"]
    for k, v in doc["counts"]["by_answer_data_status"].items():
        lines.append(f"| {k} | {v} |")
    lines += [f"| sql at the logger's {SQL_LOG_LIMIT}-character limit | {doc['counts']['sql_truncated']} |", "",
              "## Replay mode", "", "| Mode | Requests |", "|---|---|"]
    for k, v in doc["counts"]["by_replay"].items():
        lines.append(f"| {k} | {v} |")
    lines += ["", "## Unmatched requests by tag (heuristic) and outcome then", "",
              "| Tag | Requests | Answered, deterministic | Answered, model SQL | Declined or clarified | Operational or unrecorded |",
              "|---|---|---|---|---|---|"]
    for t, _ in TAGS:
        sel = [i for i in unmatched if t in i["tags"]]
        if not sel:
            continue
        a = sum(i["outcome_then"] == "answer_deterministic" for i in sel)
        m = sum(i["outcome_then"] == "answer_model_sql_historical" for i in sel)
        o = sum(i["outcome_then"] in ("operational", "unrecorded") for i in sel)
        lines.append(f"| {t} | {len(sel)} | {a} | {m} | {len(sel) - a - m - o} | {o} |")
    with open(os.path.join(OUT, "summary.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print(json.dumps(doc["counts"], indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
