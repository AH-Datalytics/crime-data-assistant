# Verifying a PR's new answers against independent values

Process approved by Jeff, 2026-11-07: every PR's new answers are verified on the runner laptop as part of its scorecard job. An answer counts as *correct* on the scorecard only when its numbers match values computed independently, at the same table digest (`scripts/fixtures/answer-eval/qlog-verified.json`). Until then it is *unverified*.

**What "blind" means.** The checker (Codex) never sees the application's code or the engine's SQL, and never sees the engine's values. It gets, for each answer, the question, the figure family, measure, statistic, grain, places and period, and for each cell its column and where it sits (a year, a month, a place). It reads the build's schema and manifest, writes its own queries, and produces its own value for every cell. The compare step then sets those against the engine's.

## 1. Find the new answers and write the requests

After the PR's scorecard run (`<run>.jsonl`) and with dev's run as the baseline:

```
npx tsx scripts/make-verify-requests.ts --labels <labels> --progress <run>.jsonl --baseline <dev run>.jsonl --out <dir>/requests.jsonl
```

- Picks every label the run answered whose table digest is not already verified and is not the same answer in the baseline (new or changed answers). `--ids a,b,c` picks given labels instead.
- Reruns each question on the same builds (`--root`, `--historical`, `--python`; run at Idle priority) and keeps it only if the rerun's table digest equals the run's. A different digest is listed and the script exits 1: the answer is not stable, so do not verify it.
- Writes two files: `requests.jsonl` (full: engine values, digest and reading, for steps 3 and 4) and `requests.blind.jsonl` (what the checker sees). No SQL is in either.
- `--labels` takes the repo's `qlog-labels.json` or a local array.

## 2. Codex writes the blind queries

Make a folder holding only: `requests.blind.jsonl`, `schema.txt`, `manifest.json` (both builds' manifests if NIBRS answers are included), and the parquet files they name. Nothing from the repository.

`schema.txt` for the Crime Index build:

```
python -c "import duckdb,glob,os;r='<crimeindex build>';c=duckdb.connect();print('Parquet files in',r);[print(os.path.basename(f)+': '+', '.join(f'{x[0]} {x[1]}' for x in c.execute(f\"DESCRIBE SELECT * FROM read_parquet('{f}')\").fetchall())) for f in sorted(glob.glob(r+'/*.parquet'))]" > schema.txt
```

Prompt (adapt the list of figure families to the requests):

> Proceed now; edit no files and write nothing to disk; print your answer. You are writing an independent check of published crime figures. You have, in this folder only: requests.blind.jsonl (one request per line: the question asked of a crime-data site, the figure family, the measure, the statistic, the grain, the places (an agency's ORI, a state's postal code, or the nation), the period, and the cells the site showed: each cell is a column header and the grouping it sits at, a year, a month, a place, or nothing for a single figure); schema.txt (the columns of every parquet file of the build); manifest.json (the build's description of its inputs and tables). Do not look for, open or infer from any application code. Work only from these files and the parquet files they name (read-only, with Python and duckdb). Write ONE standalone Python 3 script that, for every request and every cell, computes the expected value directly from the parquet files with duckdb SQL, and writes one JSON line per cell to the path given as its first argument: {"id": <request id>, "column": <cell column>, "at": <cell at>, "value": <number or null>, "how": <short: file, column, filter>}. Decide from the schema and manifest which file and column answer each measure and statistic, how an agency, a state and the nation are selected, and how a year's or a month's figure is read. Use null when the build has no figure; never 0 for a missing figure. Rates per 100,000 are as the build publishes them. For a computed rate use the site's rule (P75): the build's published rate first; where it has none but has the count and the population, the count per 100,000 of that population, to one decimal; null when either is missing. A percent change is (later - earlier) / earlier * 100 to one decimal, null from a zero base. A staffing rate or a clearance rate is as the build publishes it, converted to another base only where the question asks (per 1,000: the per-100,000 figure divided by 100, its decimals kept). Print only the script, in one python block, then one short paragraph naming each choice you made.

The families, by a request's `source`: `crimeindex_agency` (agency tables, yearly), `crimeindex_state_national` (state and nation tables or the historical file, yearly), `crimeindex_agency+state_national` (both, side by side), `current_trends` (monthly), `nibrs` (the canonical NIBRS build).

Read the script before running it. It must open the parquet files read-only and write only its output path.

## 3. Run it and compare

On the runner, in the Codex folder: `python check.py expected.jsonl`, then, in the repository:

```
npx tsx scripts/compare-verify-expected.ts --requests <dir>/requests.jsonl --expected <dir>/expected.jsonl --out <dir>/results.jsonl
```

A number is *matched* when both are missing, or both are numbers within a fixed tolerance of 0.000001 plus one part in a billion (57 and 57.0; 3.084 and 308.4 / 100). The tolerance never depends on how many decimals a value has: 57 and 57.4 are different. Anything else is a *mismatch* (the engine and the checker disagree), *no value* (the checker wrote none), *duplicate value* (it wrote the cell more than once; neither is trusted) or *extra cell* (it wrote a cell the request doesn't show). Checker output for a request that doesn't exist is listed as a problem. The script exits 1 if there is anything other than matched.

An answer whose table has two cells at one column and place (a repeated header or row) is **not verifiable**: the request is marked so, never sent to the checker, and the answer stays unverified.

**A mismatch is a finding, not noise.** Look at it before anything else: read the build for that cell by hand. Either the engine is wrong (fix it, in its own PR before this one merges), or the checker chose a different column or rule (say which, fix the checker's script or prompt, rerun). Never relabel a mismatch as matched.

## 4. Matched answers become verified entries

```
npx tsx scripts/apply-verify-results.ts --requests <dir>/requests.jsonl --results <dir>/results.jsonl --by runner-codex-blind --batch <pr>-<date>
```

A request whose every number matched is added to `qlog-verified.json` at its table digest; any other is listed and left out. The apply step re-checks each result against the request it is applied to (the cell, the engine value that request shows, and the checker's value), so results from an earlier run can never verify a changed answer, whatever they say. An id already verified at the same digest is left as it is. One already verified at *another* digest is a conflict and is not replaced (the script exits 1); replacing it is the owner's decision, said on the command with `--replace <id>` and in the commit message. Commit the file as a follow-up commit on the PR, with the run's counts in the message. The scorecard then counts those answers as correct, and a later change to their numbers puts them back to unverified.

## Not covered

- Routes and clarifies show no numbers and need no verification.
- The checker verifies the figures, not the wording, the labels or which answer a question should get; the scorecard's labels and Codex's code review cover those.
