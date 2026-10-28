#!/usr/bin/env python3
"""Applies drafted labels (scripts/fixtures/answer-eval/drafts/<batch>.json) to scripts/fixtures/answer-eval/cases.json.

    python scripts/merge-answer-eval-drafts.py [BATCH ...]

A draft sets `expected`, adds its `policy_add` rows, and marks the label drafted (or unresolved) by
"claude-draft:<batch>". A reviewed label is never overwritten. Run scripts/test-answer-eval-cases.ts afterwards.
"""
import glob
import json
import os
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
CASES = os.path.join(ROOT, "scripts", "fixtures", "answer-eval", "cases.json")
DRAFTS = os.path.join(ROOT, "scripts", "fixtures", "answer-eval", "drafts")

data = json.load(open(CASES, encoding="utf-8"))
by_id = {c["id"]: c for c in data["cases"]}
batches = sys.argv[1:] or sorted(os.path.splitext(os.path.basename(p))[0] for p in glob.glob(os.path.join(DRAFTS, "*.json")))
applied = skipped = 0
for b in batches:
    for cid, d in json.load(open(os.path.join(DRAFTS, f"{b}.json"), encoding="utf-8")).items():
        c = by_id[cid]
        if c["label"]["status"] == "reviewed":
            skipped += 1
            continue
        status = d["status"]
        assert status in ("drafted", "unresolved"), (cid, status)
        c["expected"] = d.get("expected") if status == "drafted" else None
        c["policy"] = sorted(set(c["policy"]) | set(d.get("policy_add", [])))
        c["label"] = {"status": status, "drafted_by": f"claude-draft:{b}", "reviewed_by": None, "notes": d.get("notes", "")}
        applied += 1
with open(CASES, "w", encoding="utf-8", newline="\n") as f:
    json.dump(data, f, indent=1, ensure_ascii=False)
    f.write("\n")
print(f"applied {applied} drafts from {', '.join(batches)}; kept {skipped} reviewed labels")
