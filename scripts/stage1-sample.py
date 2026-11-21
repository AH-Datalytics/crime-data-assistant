#!/usr/bin/env python3
"""Draws the side-by-side sample for stage 1 (engine switch scope, section 5): N first questions of one tab, and a few follow-ups with the turn before, from a READ-ONLY COPY of the
query log (never the production file). Deterministic: the same copy, seed and arguments give the same ids.

    python scripts/stage1-sample.py --db <query_log_copy.db> --out <sample.json> [--tab nibrs] [--n 30] [--followups 5] [--days 30] [--seed 20261119]

Rules:
  - the window is the last --days days of the copy (by the newest row's own timestamp, not today's date);
  - a first question is the first row of a session in the tab; a follow-up is a later row of that session, taken with the question before it; a row with no session id is a first question;
  - distinct normalized questions only (lower-case, whitespace squeezed, trailing ?.! removed); rows the old app logged no reply for are skipped;
  - stratified to the log's own mix: questions are put in four groups by their words (rate, ranking, breakdown, count), the sample takes each group in proportion to its share of the
    window (at least one from every group that has any), by a seeded shuffle inside the group;
  - each sample row carries the old answer as logged: its reply text, whether it had SQL, the row count and the error tag, with the log row's id and time.
Writes only --out. Needs python 3 only (sqlite3 is in the standard library)."""
import argparse, collections, json, random, re, sqlite3

ap = argparse.ArgumentParser()
ap.add_argument("--db", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--tab", default="nibrs")
ap.add_argument("--n", type=int, default=30)
ap.add_argument("--followups", type=int, default=5)
ap.add_argument("--days", type=int, default=30)
ap.add_argument("--seed", type=int, default=20261119)
a = ap.parse_args()

norm = lambda q: " ".join((q or "").lower().split()).rstrip("?.! ")
RATE = re.compile(r"\b(per\s*100\s*,?\s*000|per capita|rate)\b", re.I)
RANK = re.compile(r"\b(top|highest|lowest|most|least|rank|ranking|worst|safest|largest|biggest)\b", re.I)
BREAK = re.compile(r"\bby\s+(year|month|age|race|sex|gender|weapon|location|relationship|offense|type|state|county|city|hour|time)\b|\bbreakdown\b|\bbroken down\b", re.I)
group_of = lambda q: "rate" if RATE.search(q) else "ranking" if RANK.search(q) else "breakdown" if BREAK.search(q) else "count"

c = sqlite3.connect("file:%s?mode=ro" % a.db.replace("\\", "/"), uri=True)
c.row_factory = sqlite3.Row
newest = c.execute("SELECT max(ts) FROM query_log").fetchone()[0]
since = newest - a.days * 86400 * 1000
rows = c.execute("SELECT id, ts, tab, session_id, question, sql, rows, error, response FROM query_log WHERE tab = ? ORDER BY id", (a.tab,)).fetchall()
last = {}
firsts, follows = [], []
for r in rows:
    q = (r["question"] or "").strip()
    if not q:
        continue
    sid = r["session_id"]
    prev = last.get(sid) if sid is not None else None
    if sid is not None:
        last[sid] = q
    if r["ts"] < since or not (r["response"] or "").strip():
        continue
    rec = {"id": r["id"], "ts": r["ts"], "question": q, "previous": prev, "group": group_of(q),
           "old": {"response": r["response"], "had_sql": bool(r["sql"]), "rows": r["rows"], "error": r["error"]}}
    (follows if prev else firsts).append(rec)

def distinct(items):
    seen, out = set(), []
    for x in items:
        k = (norm(x["previous"] or ""), norm(x["question"]))
        if k not in seen:
            seen.add(k); out.append(x)
    return out

firsts, follows = distinct(firsts), distinct(follows)
rng = random.Random(a.seed)
by = collections.defaultdict(list)
for x in firsts:
    by[x["group"]].append(x)
total = sum(len(v) for v in by.values())
want = {g: max(1, round(a.n * len(v) / total)) for g, v in by.items()}
# trim or top up to exactly n, taking from the largest group
while sum(want.values()) > a.n:
    g = max(want, key=lambda k: want[k]); want[g] -= 1
while sum(want.values()) < a.n and total >= a.n:
    g = max(by, key=lambda k: len(by[k]) - want[k]); want[g] += 1
sample = []
for g in sorted(by):
    pool = sorted(by[g], key=lambda x: x["id"])
    rng.shuffle(pool)
    sample += pool[:want[g]]
fl = sorted(follows, key=lambda x: x["id"])
rng.shuffle(fl)
sample += fl[:a.followups]
sample.sort(key=lambda x: x["id"])
json.dump({"db": a.db, "tab": a.tab, "seed": a.seed, "window_days": a.days, "newest_ts": newest, "groups_in_window": {g: len(v) for g, v in by.items()},
           "wanted": want, "followups_available": len(follows), "sample": sample}, open(a.out, "w", encoding="utf-8"), indent=1)
print("window rows: %d first questions (%s), %d follow-ups; drew %d first + %d follow-up" % (total, ", ".join("%s %d" % (g, len(v)) for g, v in sorted(by.items())), len(follows), len(sample) - min(a.followups, len(fl)), min(a.followups, len(fl))))
