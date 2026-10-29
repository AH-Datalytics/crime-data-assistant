#!/usr/bin/env python3
"""Applies drafted labels to scripts/fixtures/answer-eval/cases.json.

    python scripts/merge-answer-eval-drafts.py [--round 2] [BATCH ...]

Round 1 reads scripts/fixtures/answer-eval/drafts/<batch>.json; round N > 1 reads drafts<N>/. A draft sets
`expected`, adds its `policy_add` rows, and marks the label drafted (or unresolved) by "claude-draft[-rN]:<batch>".
A reviewed label is never overwritten.

Round 2 drafts also say what the reviewer (Codex, one pass) decided. A label counts as reviewed only when the
reviewer accepted it and round 2 left it unchanged: the reviewer then judged exactly this label. Every changed label
stays "drafted" until a reviewer sees the change. Run scripts/test-answer-eval-cases.ts afterwards.
"""
import glob
import json
import os
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
CASES = os.path.join(ROOT, "scripts", "fixtures", "answer-eval", "cases.json")
args = sys.argv[1:]
rnd = 1
if args[:1] == ["--round"]:
    rnd, args = int(args[1]), args[2:]
DRAFTS = os.path.join(ROOT, "scripts", "fixtures", "answer-eval", "drafts" if rnd == 1 else f"drafts{rnd}")

data = json.load(open(CASES, encoding="utf-8"))
by_id = {c["id"]: c for c in data["cases"]}
batches = args or sorted(os.path.splitext(os.path.basename(p))[0] for p in glob.glob(os.path.join(DRAFTS, "*.json")))
applied = skipped = reviewed = 0
for b in batches:
    for cid, d in json.load(open(os.path.join(DRAFTS, f"{b}.json"), encoding="utf-8")).items():
        c = by_id[cid]
        if c["label"]["status"] == "reviewed":
            skipped += 1
            continue
        status = d["status"]
        assert status in ("drafted", "unresolved"), (cid, status)
        drafter = f"claude-draft:{b}" if rnd == 1 else f"claude-draft-r{rnd}:{b}"
        c["expected"] = d.get("expected") if status == "drafted" else None
        c["policy"] = sorted(set(c["policy"]) | set(d.get("policy_add", [])))
        accepted_unchanged = rnd > 1 and d.get("codex") == "accept" and d.get("applied") == "unchanged" and status == "drafted"
        notes = d.get("notes", "")
        if d.get("superseded"):
            notes = f"{notes} [superseded by {', '.join(d['superseded'])}]".strip()
        c["label"] = {"status": "reviewed" if accepted_unchanged else status, "drafted_by": drafter,
                      "reviewed_by": "codex:labels-1" if accepted_unchanged else None, "notes": notes}
        reviewed += accepted_unchanged
        applied += 1
with open(CASES, "w", encoding="utf-8", newline="\n") as f:
    json.dump(data, f, indent=1, ensure_ascii=False)
    f.write("\n")
print(f"round {rnd}: applied {applied} drafts from {', '.join(batches)} ({reviewed} reviewed as accepted and unchanged); kept {skipped} reviewed labels")
