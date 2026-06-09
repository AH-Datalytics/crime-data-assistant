"""
CDE vs Historical Agency Crime Discrepancy Checker

Scrapes FBI CDE API for 2024-2025 agency crime data and compares
to our historical_agency_crime table. Flags major discrepancies.

Usage:
    python scripts/cde-discrepancy-check.py                  # pop >= 10K
    python scripts/cde-discrepancy-check.py --min-pop 50000  # pop >= 50K
    python scripts/cde-discrepancy-check.py --resume          # resume from checkpoint
"""

import asyncio
import aiohttp
import argparse
import csv
import json
import os
import sqlite3
import time
from pathlib import Path

API_KEY = os.environ.get("CDE_API_KEY", "BPkjHOgf6hpOoYlRm7GOaHbSQqlx87IfiXP3QTJg")
BASE = "https://cde.ucr.cjis.gov/LATEST"
CONCURRENCY = 15
YEARS = [2024, 2025]

OFFENSE_MAP = {
    "homicide": "murder",
    "rape": "rape",
    "robbery": "robbery",
    "aggravated-assault": "assault",
    "burglary": "burglary",
    "larceny": "theft",
    "motor-vehicle-theft": "motor_vehicle_theft",
}

DB_PATH = os.environ.get("DB_PATH", "/opt/nibrs/shared/crime_data.db")
OUTPUT_DIR = Path("audit")
OUTPUT_DIR.mkdir(exist_ok=True)
CHECKPOINT = OUTPUT_DIR / "cde_checkpoint.json"
RESULTS_CSV = OUTPUT_DIR / "cde_discrepancies.csv"
ALL_DATA_CSV = OUTPUT_DIR / "cde_all_data.csv"


def load_our_data(db_path, min_pop):
    """Load our historical_agency_crime data for comparison."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT hac.ori, ha.agency, ha.state, ha.type,
               hac.year, hac.population,
               hac.murder, hac.rape, hac.robbery, hac.assault,
               hac.burglary, hac.theft, hac.motor_vehicle_theft
        FROM historical_agency_crime hac
        JOIN historical_agency ha ON ha.ori = hac.ori
        LEFT JOIN historical_agency_population hap ON hap.ori = hac.ori AND hap.year = hac.year
        WHERE hac.year IN (2024, 2025)
          AND COALESCE(hap.population, hac.population, 0) >= ?
        ORDER BY hac.ori, hac.year
    """, (min_pop,)).fetchall()
    conn.close()

    data = {}
    oris = set()
    for r in rows:
        key = (r["ori"], r["year"])
        data[key] = {
            "agency": r["agency"],
            "state": r["state"],
            "type": r["type"],
            "population": r["population"],
            "murder": r["murder"],
            "rape": r["rape"],
            "robbery": r["robbery"],
            "assault": r["assault"],
            "burglary": r["burglary"],
            "theft": r["theft"],
            "motor_vehicle_theft": r["motor_vehicle_theft"],
        }
        oris.add(r["ori"])

    print(f"Loaded {len(data)} rows for {len(oris)} agencies from DB")
    return data, sorted(oris)


async def fetch_offense(session, sem, ori, offense, from_date, to_date):
    """Fetch one offense for one ORI from CDE."""
    url = f"{BASE}/summarized/agency/{ori}/{offense}"
    params = {"from": from_date, "to": to_date, "API_KEY": API_KEY}
    async with sem:
        for attempt in range(3):
            try:
                async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                    if resp.status == 200:
                        return await resp.json()
                    elif resp.status == 404:
                        return None
                    elif resp.status == 429:
                        await asyncio.sleep(5 * (attempt + 1))
                    else:
                        text = await resp.text()
                        if "not a valid" in text or "not found" in text:
                            return None
                        await asyncio.sleep(2)
            except Exception as e:
                if attempt < 2:
                    await asyncio.sleep(2)
                else:
                    print(f"  ERROR {ori}/{offense}: {e}")
                    return None
    return None


def annual_totals_from_cde(cde_data):
    """Sum monthly CDE data into annual totals."""
    if not cde_data:
        return {}
    totals = {}
    for entry in cde_data:
        year = entry.get("data_year")
        value = entry.get("actual")
        if year and value is not None:
            totals[year] = totals.get(year, 0) + value
    return totals


async def scrape_ori(session, sem, ori):
    """Fetch all 7 offenses for one ORI, return {year: {offense: count}}."""
    result = {}
    tasks = []
    for offense in OFFENSE_MAP:
        tasks.append(fetch_offense(session, sem, ori, offense, "01-2024", "12-2025"))

    responses = await asyncio.gather(*tasks)

    for offense, resp in zip(OFFENSE_MAP, responses):
        db_col = OFFENSE_MAP[offense]
        annuals = annual_totals_from_cde(resp)
        for year, total in annuals.items():
            if year not in result:
                result[year] = {}
            result[year][db_col] = total

    return result


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--min-pop", type=int, default=10000)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--db", default=DB_PATH)
    args = parser.parse_args()

    our_data, all_oris = load_our_data(args.db, args.min_pop)

    # Resume from checkpoint
    done_oris = set()
    if args.resume and CHECKPOINT.exists():
        done_oris = set(json.loads(CHECKPOINT.read_text()))
        print(f"Resuming: {len(done_oris)} already done")

    remaining = [o for o in all_oris if o not in done_oris]
    print(f"Scraping {len(remaining)} agencies from CDE (min pop {args.min_pop:,})")

    sem = asyncio.Semaphore(CONCURRENCY)
    discrepancies = []
    all_rows = []

    # Open CSV for incremental writes
    disc_file = open(RESULTS_CSV, "a" if args.resume else "w", newline="")
    disc_writer = csv.writer(disc_file)
    if not args.resume:
        disc_writer.writerow(["ori", "agency", "state", "type", "population", "year",
                              "offense", "our_value", "cde_value", "diff", "pct_diff"])

    all_file = open(ALL_DATA_CSV, "a" if args.resume else "w", newline="")
    all_writer = csv.writer(all_file)
    if not args.resume:
        all_writer.writerow(["ori", "agency", "state", "year",
                             "our_murder", "cde_murder", "our_rape", "cde_rape",
                             "our_robbery", "cde_robbery", "our_assault", "cde_assault",
                             "our_burglary", "cde_burglary", "our_theft", "cde_theft",
                             "our_mvt", "cde_mvt"])

    async with aiohttp.ClientSession() as session:
        batch_size = 50
        for batch_start in range(0, len(remaining), batch_size):
            batch = remaining[batch_start:batch_start + batch_size]
            tasks = [scrape_ori(session, sem, ori) for ori in batch]
            results = await asyncio.gather(*tasks)

            for ori, cde_result in zip(batch, results):
                done_oris.add(ori)

                for year in YEARS:
                    key = (ori, year)
                    ours = our_data.get(key, {})
                    cde_year = cde_result.get(year, {})

                    if not ours and not cde_year:
                        continue

                    agency = ours.get("agency", "?")
                    state = ours.get("state", "?")
                    atype = ours.get("type", "?")
                    pop = ours.get("population", 0)

                    # Write all data row
                    all_writer.writerow([
                        ori, agency, state, year,
                        ours.get("murder"), cde_year.get("murder"),
                        ours.get("rape"), cde_year.get("rape"),
                        ours.get("robbery"), cde_year.get("robbery"),
                        ours.get("assault"), cde_year.get("assault"),
                        ours.get("burglary"), cde_year.get("burglary"),
                        ours.get("theft"), cde_year.get("theft"),
                        ours.get("motor_vehicle_theft"), cde_year.get("motor_vehicle_theft"),
                    ])

                    # Check each offense for discrepancies
                    for col in ["murder", "rape", "robbery", "assault", "burglary", "theft", "motor_vehicle_theft"]:
                        our_val = ours.get(col)
                        cde_val = cde_year.get(col)

                        if our_val is None and cde_val is None:
                            continue
                        if our_val is None:
                            our_val = 0
                        if cde_val is None:
                            continue  # CDE doesn't have it, skip

                        diff = cde_val - our_val
                        if diff == 0:
                            continue

                        # Flag if difference is significant
                        pct = abs(diff) / max(our_val, 1) * 100
                        # Major: diff > 5 AND (pct > 50% OR absolute diff > 20)
                        if abs(diff) > 5 and (pct > 50 or abs(diff) > 20):
                            disc_writer.writerow([ori, agency, state, atype, pop, year,
                                                  col, our_val, cde_val, diff, f"{pct:.0f}%"])
                            discrepancies.append({
                                "ori": ori, "agency": agency, "state": state,
                                "year": year, "offense": col,
                                "ours": our_val, "cde": cde_val, "diff": diff,
                            })

            # Checkpoint
            CHECKPOINT.write_text(json.dumps(list(done_oris)))

            # Progress
            total_done = len(done_oris)
            total = len(all_oris)
            elapsed = batch_start + len(batch)
            print(f"  {total_done}/{total} agencies ({total_done*100//total}%) — {len(discrepancies)} discrepancies found")

            all_file.flush()
            disc_file.flush()

    disc_file.close()
    all_file.close()

    print(f"\nDone. {len(discrepancies)} discrepancies found.")
    print(f"  All data: {ALL_DATA_CSV}")
    print(f"  Discrepancies: {RESULTS_CSV}")

    # Print top discrepancies
    if discrepancies:
        print("\nTop discrepancies by absolute difference:")
        top = sorted(discrepancies, key=lambda d: abs(d["diff"]), reverse=True)[:20]
        for d in top:
            print(f"  {d['agency']:25s} {d['state']:3s} {d['year']} {d['offense']:20s} ours={d['ours']:>6} cde={d['cde']:>6} diff={d['diff']:>+6}")


if __name__ == "__main__":
    asyncio.run(main())
