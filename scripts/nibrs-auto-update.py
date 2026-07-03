#!/usr/bin/env python3
"""
NIBRS Monthly Auto-Update for VPS
Downloads the current year from CDE, detects changes via SHA256,
replaces data for changed years, rebuilds all summary tables for those years only.

Cron (15th of each month, 6 PM UTC / 1 PM ET / 12 PM CT):
  0 18 15 * * /usr/bin/python3 /opt/nibrs/scripts/nibrs-auto-update.py >> /opt/nibrs/update.log 2>&1
"""
import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
import zipfile
from datetime import datetime
from urllib.request import urlopen, Request

SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from build_nibrs_consistent_reporters import rebuild_consistent_reporters


def retry(fn, *args, max_retries=3, delay=30, label="operation", **kwargs):
    """Retry a function up to max_retries times with exponential backoff."""
    for attempt in range(1, max_retries + 1):
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            if attempt == max_retries:
                log(f"  ERROR: {label} failed after {max_retries} attempts: {e}")
                raise
            wait = delay * attempt
            log(f"  WARNING: {label} failed (attempt {attempt}/{max_retries}): {e}")
            log(f"  Retrying in {wait}s...")
            time.sleep(wait)


DB_PATH = "/mnt/HC_Volume_105124811/nibrs/nibrs.db"
HISTORICAL_DB_PATH = os.environ.get("RTCI_DB_PATH", "/opt/nibrs/shared/crime_data.db")
DATA_DIR = "/opt/nibrs/data"
CHECKSUM_FILE = "/opt/nibrs/checksums.json"
TMP_DIR = "/mnt/HC_Volume_105124811/tmp"
BATCH_SIZE = 100_000

CDE_URL = "https://cde.ucr.cjis.gov/LATEST/s3/signedurl?key=master_files/nibrs/nibrs-{year}.zip"

STATE_MAP = {
    '50': 'AK', '01': 'AL', '03': 'AR', '02': 'AZ', '04': 'CA', '05': 'CO',
    '06': 'CT', '52': 'CZ', '08': 'DC', '07': 'DE', '09': 'FL', '10': 'GA',
    '55': 'GM', '51': 'HI', '14': 'IA', '11': 'ID', '12': 'IL', '13': 'IN',
    '15': 'KS', '16': 'KY', '17': 'LA', '20': 'MA', '19': 'MD', '18': 'ME',
    '21': 'MI', '22': 'MN', '24': 'MO', '23': 'MS', '25': 'MT', '32': 'NC',
    '33': 'ND', '26': 'NE', '28': 'NH', '29': 'NJ', '30': 'NM', '27': 'NV',
    '31': 'NY', '34': 'OH', '35': 'OK', '36': 'OR', '37': 'PA', '53': 'PR',
    '38': 'RI', '39': 'SC', '40': 'SD', '41': 'TN', '42': 'TX', '43': 'UT',
    '45': 'VA', '62': 'VI', '44': 'VT', '46': 'WA', '48': 'WI', '47': 'WV',
    '49': 'WY'
}

STATE_NAME_TO_ABBR = {
    'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR',
    'California': 'CA', 'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE',
    'District of Columbia': 'DC', 'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI',
    'Idaho': 'ID', 'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA', 'Kansas': 'KS',
    'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD',
    'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS',
    'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV',
    'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
    'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH', 'Oklahoma': 'OK',
    'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI',
    'South Carolina': 'SC', 'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX',
    'Utah': 'UT', 'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA',
    'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY',
    'United States': 'US',
}

RAW_TABLES = ['agencies', 'incidents', 'offenses', 'property', 'victims',
              'offenders', 'arrestees', 'group_b_arrests']

SUMMARY_TABLES = ['summary_city_monthly', 'summary_state_monthly',
                  'summary_victim_city_monthly', 'summary_victim_state_monthly',
                  'summary_victim_demographics', 'summary_carjacking_monthly',
                  'summary_drug_monthly']

PERSON_CRIMES = (
    "'09A','09B','09C','100','11A','11B','11C','11D',"
    "'13A','13B','13C','36A','36B','64A','64B'"
)


def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def s(line, start, end):
    if end > len(line):
        return ''
    return line[start:end].strip()

def sint(line, start, end):
    v = s(line, start, end)
    if v and v.isdigit():
        return int(v)
    return None


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def load_checksums():
    if os.path.exists(CHECKSUM_FILE):
        with open(CHECKSUM_FILE) as f:
            return json.load(f)
    return {}


def save_checksums(checksums):
    with open(CHECKSUM_FILE, 'w') as f:
        json.dump(checksums, f, indent=2)


def parse_year_csv(value):
    years = set()
    if not value:
        return years
    for part in str(value).replace(" ", "").split(","):
        if not part:
            continue
        try:
            years.add(int(part))
        except ValueError:
            raise SystemExit(f"Invalid protected year: {part}")
    return years


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--years",
        nargs="*",
        type=int,
        help="Specific CDE NIBRS years to update. Defaults to current year only.",
    )
    parser.add_argument(
        "--protected-years",
        default=os.environ.get("PROTECTED_UPDATE_YEARS", default_protected_years()),
        help="Comma-separated years the updater must not delete/reimport. Defaults to the prior year from June through December.",
    )
    parser.add_argument(
        "--allow-protected-years",
        action="store_true",
        help="Allow updating protected years. Requires an explicit operator decision.",
    )
    return parser.parse_args()


def default_protected_years(now=None):
    now = now or datetime.now()
    return str(now.year - 1) if now.month >= 6 else ""


def get_years_to_update(years_arg=None, now=None):
    if years_arg:
        return sorted(set(years_arg))
    now = now or datetime.now()
    if now.month < 6:
        return [now.year - 1, now.year]
    return [now.year]


def assert_no_protected_years(years, protected_years, allow=False):
    blocked = sorted(set(years) & set(protected_years))
    if blocked and not allow:
        raise SystemExit(
            "Refusing to update protected year(s): "
            + ", ".join(str(y) for y in blocked)
            + ". Re-run with --allow-protected-years only if this is intentional."
        )


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def download_year(year):
    """Download nibrs-{year}.zip from CDE. Returns path to zip or None."""
    dest = os.path.join(DATA_DIR, f"nibrs-{year}.zip")

    log(f"  Fetching signed URL for {year}...")
    try:
        req = Request(CDE_URL.format(year=year), headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            # Response is a dict with the key path -> signed URL
            key = f"master_files/nibrs/nibrs-{year}.zip"
            if isinstance(data, dict) and key in data:
                signed_url = data[key]
            elif isinstance(data, str):
                signed_url = data
            else:
                signed_url = data.get("url", data.get("signedUrl", ""))
    except Exception as e:
        log(f"  Failed to get signed URL for {year}: {e}")
        return None

    if not signed_url:
        log(f"  No signed URL returned for {year}")
        return None

    log(f"  Downloading nibrs-{year}.zip...")
    try:
        req = Request(signed_url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req, timeout=1800) as resp:
            total = int(resp.headers.get('Content-Length', 0))
            downloaded = 0
            with open(dest, 'wb') as f:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
            size_gb = downloaded / (1024**3)
            log(f"  Downloaded nibrs-{year}.zip ({size_gb:.2f} GB)")
    except Exception as e:
        log(f"  Download failed for {year}: {e}")
        if os.path.exists(dest):
            os.remove(dest)
        return None

    return dest


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

def find_txt_in_zip(zf):
    for name in zf.namelist():
        if name.endswith('.txt') and 'MASTER' in name.upper():
            return name
    for name in zf.namelist():
        if name.endswith('.txt'):
            return name
    return None


def delete_year(conn, year):
    """Delete all rows for a given year from raw + summary tables."""
    log(f"  Deleting existing data for {year}...")
    t = time.time()
    for table in RAW_TABLES:
        conn.execute(f"DELETE FROM {table} WHERE year = ?", (year,))
    for table in SUMMARY_TABLES:
        try:
            conn.execute(f"DELETE FROM {table} WHERE year = ?", (year,))
        except sqlite3.OperationalError:
            pass  # table may not exist yet
    conn.commit()
    log(f"  Deleted {year} data in {time.time()-t:.0f}s")


def import_year(year, zip_path, conn):
    """Import a year from a zip file into the database."""
    log(f"  Importing {year} from {os.path.basename(zip_path)}...")
    start = time.time()

    bh_state_map = {}
    batches = {t: [] for t in RAW_TABLES}
    counts = {t: 0 for t in RAW_TABLES}

    def flush_batch(table):
        if not batches[table]:
            return
        rows = batches[table]
        ncols = len(rows[0])
        placeholders = ','.join(['?'] * ncols)
        if table == "agencies":
            cols = "ori, year, state_code, state, city, pop_group, country_division, covered_flag, agency_indicator, population"
            conn.executemany(f"INSERT INTO {table} ({cols}) VALUES ({placeholders})", rows)
        else:
            conn.executemany(f"INSERT INTO {table} VALUES ({placeholders})", rows)
        counts[table] += len(rows)
        batches[table] = []

    def flush_all():
        for t in RAW_TABLES:
            flush_batch(t)
        conn.commit()

    lines = 0
    try:
        zf = zipfile.ZipFile(zip_path)
        entry = find_txt_in_zip(zf)
        if not entry:
            log(f"  No .txt file found in {zip_path}")
            zf.close()
            return False
        log(f"  Entry: {entry}")
        f = zf.open(entry)
    except Exception as e:
        log(f"  Cannot open zip {zip_path}: {e}")
        return False

    try:
        for raw in f:
            lines += 1
            if lines % 5_000_000 == 0:
                flush_all()
                elapsed = time.time() - start
                log(f"  {lines:,} lines ({elapsed:.0f}s) — "
                    + " ".join(f"{k}:{counts[k]:,}" for k in counts if counts[k]))

            line = raw.decode('ascii', errors='replace').rstrip('\n')
            seg = line[0:2]

            if seg == 'BH':
                sc = s(line, 2, 4)
                ori = s(line, 4, 13)
                sa = s(line, 71, 73) or STATE_MAP.get(sc, sc)
                bh_state_map[sc] = sa
                batches['agencies'].append((
                    ori, year, sc, sa,
                    s(line, 41, 71), s(line, 73, 75),
                    s(line, 75, 76), s(line, 78, 79), s(line, 95, 96), sint(line, 105, 114),
                ))
                if len(batches['agencies']) >= BATCH_SIZE:
                    flush_batch('agencies')
                continue

            if seg in ('01', '02', '03', '04', '05', '06'):
                sc = s(line, 2, 4)
                ori = s(line, 4, 13)
                inc = s(line, 13, 25)
                dt = s(line, 25, 33)
                st = bh_state_map.get(sc, STATE_MAP.get(sc, sc))

            if seg == '01':
                batches['incidents'].append((
                    year, st, ori, inc, dt,
                    s(line, 33, 34), s(line, 34, 36),
                    sint(line, 36, 38), sint(line, 38, 40),
                    sint(line, 40, 42), sint(line, 42, 44),
                    s(line, 49, 50), s(line, 50, 58), s(line, 88, 89),
                ))
                if len(batches['incidents']) >= BATCH_SIZE:
                    flush_batch('incidents')

            elif seg == '02':
                batches['offenses'].append((
                    year, st, ori, inc, dt,
                    s(line, 33, 36), s(line, 36, 37),
                    s(line, 37, 38), s(line, 38, 39), s(line, 39, 40),
                    s(line, 40, 42), s(line, 42, 44), s(line, 44, 45),
                    s(line, 45, 46), s(line, 46, 47), s(line, 47, 48),
                    s(line, 48, 51), s(line, 51, 54), s(line, 54, 57),
                    s(line, 57, 59),
                ))
                if len(batches['offenses']) >= BATCH_SIZE:
                    flush_batch('offenses')

            elif seg == '03':
                val = sint(line, 36, 45)
                batches['property'].append((
                    year, st, ori, inc, dt,
                    s(line, 33, 34), s(line, 34, 36), val,
                    s(line, 45, 53), s(line, 53, 55), s(line, 55, 57),
                    s(line, 57, 59), s(line, 59, 61), s(line, 61, 63),
                ))
                if len(batches['property']) >= BATCH_SIZE:
                    flush_batch('property')

            elif seg == '04':
                batches['victims'].append((
                    year, st, ori, inc, dt,
                    s(line, 33, 36), s(line, 66, 67), s(line, 67, 69),
                    s(line, 69, 70), s(line, 70, 71), s(line, 71, 72),
                    s(line, 72, 73), s(line, 73, 75), s(line, 75, 77),
                    s(line, 77, 78), s(line, 78, 79), s(line, 79, 80),
                    s(line, 80, 81), s(line, 81, 82), s(line, 82, 83),
                    s(line, 83, 85), s(line, 85, 87), s(line, 87, 89),
                    s(line, 89, 91), s(line, 91, 93), s(line, 93, 95),
                    s(line, 36, 39), s(line, 39, 42), s(line, 42, 45),
                ))
                if len(batches['victims']) >= BATCH_SIZE:
                    flush_batch('victims')

            elif seg == '05':
                batches['offenders'].append((
                    year, st, ori, inc, dt,
                    s(line, 33, 35), s(line, 35, 37),
                    s(line, 37, 38), s(line, 38, 39), s(line, 39, 40),
                ))
                if len(batches['offenders']) >= BATCH_SIZE:
                    flush_batch('offenders')

            elif seg == '06':
                batches['arrestees'].append((
                    year, st, ori, inc, dt,
                    s(line, 33, 35), s(line, 35, 47), s(line, 47, 55),
                    s(line, 55, 56), s(line, 56, 57), s(line, 57, 60),
                    s(line, 60, 63), s(line, 63, 66), s(line, 66, 68),
                    s(line, 68, 69), s(line, 69, 70), s(line, 70, 71),
                    s(line, 71, 72), s(line, 72, 73),
                ))
                if len(batches['arrestees']) >= BATCH_SIZE:
                    flush_batch('arrestees')

            elif seg == '07':
                sc07 = s(line, 2, 4)
                st07 = bh_state_map.get(sc07, STATE_MAP.get(sc07, sc07))
                batches['group_b_arrests'].append((
                    year, st07,
                    s(line, 4, 13), s(line, 13, 14), s(line, 14, 26),
                    s(line, 26, 34), s(line, 34, 35), s(line, 35, 38),
                    s(line, 38, 41), s(line, 41, 44), s(line, 44, 46),
                    s(line, 46, 47), s(line, 47, 48), s(line, 48, 49),
                    s(line, 49, 50), s(line, 50, 51),
                ))
                if len(batches['group_b_arrests']) >= BATCH_SIZE:
                    flush_batch('group_b_arrests')

        flush_all()
    finally:
        f.close()
        zf.close()

    elapsed = time.time() - start
    log(f"  Done: {lines:,} lines in {elapsed:.0f}s ({elapsed/60:.1f} min)")
    for k in counts:
        if counts[k]:
            log(f"    {k}: {counts[k]:,}")
    return True


# ---------------------------------------------------------------------------
# Summary table rebuilds (incremental — only affected years)
# ---------------------------------------------------------------------------

def rebuild_summaries(conn, years):
    """Rebuild all summary tables for the given years only."""
    year_list = ','.join(str(y) for y in years)
    log(f"Rebuilding summary tables for years: {year_list}")
    total_start = time.time()

    # ---- 1. summary_city_monthly (offense counts) ----
    log("  Building summary_city_monthly...")
    t = time.time()
    conn.execute("DELETE FROM summary_city_monthly WHERE year IN (" + year_list + ")")
    conn.execute(f"""
        INSERT INTO summary_city_monthly
        SELECT
            o.year,
            CAST(SUBSTR(o.incident_date, 5, 2) AS INT) AS month,
            o.state, o.ori, o.ucr_offense_code,
            COUNT(*) AS offense_count,
            0 AS cleared_count
        FROM offenses o
        WHERE o.year IN ({year_list})
          AND o.incident_date IS NOT NULL AND LENGTH(o.incident_date) >= 6
        GROUP BY o.year, SUBSTR(o.incident_date, 5, 2), o.state, o.ori, o.ucr_offense_code
    """)
    conn.commit()
    log(f"    Offense counts done ({time.time()-t:.0f}s)")

    # ---- 2. Clearance pass for affected years ----
    log("  Computing clearances...")
    t = time.time()

    # Build temp table of cleared incidents (only for affected years)
    conn.execute("DROP TABLE IF EXISTS temp_cleared")
    conn.execute("""
        CREATE TEMP TABLE temp_cleared (
            year INT, ori TEXT, incident_num TEXT,
            UNIQUE(year, ori, incident_num)
        )
    """)
    conn.execute(f"""
        INSERT OR IGNORE INTO temp_cleared
        SELECT DISTINCT year, ori, incident_num FROM incidents
        WHERE year IN ({year_list}) AND cleared_exceptionally != 'N'
    """)
    conn.execute(f"""
        INSERT OR IGNORE INTO temp_cleared
        SELECT DISTINCT year, ori, incident_num FROM arrestees
        WHERE year IN ({year_list})
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS temp.idx_cleared ON temp_cleared(year, ori, incident_num)")
    total_cleared = conn.execute("SELECT COUNT(*) FROM temp_cleared").fetchone()[0]
    log(f"    Cleared incidents: {total_cleared:,}")

    for yr in years:
        conn.execute("DROP TABLE IF EXISTS temp_yr_clearances")
        conn.execute(f"""
            CREATE TEMP TABLE temp_yr_clearances AS
            SELECT o.state, o.ori, o.ucr_offense_code,
                   CAST(SUBSTR(o.incident_date, 5, 2) AS INT) AS month,
                   COUNT(*) AS cleared_count
            FROM offenses o
            JOIN temp_cleared tc ON tc.year = o.year AND tc.ori = o.ori AND tc.incident_num = o.incident_num
            WHERE o.year = {yr}
              AND o.incident_date IS NOT NULL AND LENGTH(o.incident_date) >= 6
            GROUP BY o.state, o.ori, o.ucr_offense_code, SUBSTR(o.incident_date, 5, 2)
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS temp.idx_yrc ON temp_yr_clearances(state, ori, ucr_offense_code, month)")
        conn.execute(f"""
            UPDATE summary_city_monthly
            SET cleared_count = COALESCE((
                SELECT tc.cleared_count FROM temp_yr_clearances tc
                WHERE tc.state = summary_city_monthly.state
                  AND tc.ori = summary_city_monthly.ori
                  AND tc.ucr_offense_code = summary_city_monthly.ucr_offense_code
                  AND tc.month = summary_city_monthly.month
            ), 0)
            WHERE year = {yr}
        """)
        conn.commit()
        rows = conn.execute("SELECT COUNT(*) FROM temp_yr_clearances").fetchone()[0]
        conn.execute("DROP TABLE IF EXISTS temp_yr_clearances")
        log(f"    [{yr}] Clearances: {rows:,} groups")

    conn.execute("DROP TABLE IF EXISTS temp_cleared")
    log(f"    Clearance pass done ({time.time()-t:.0f}s)")

    # ---- 3. summary_state_monthly ----
    log("  Building summary_state_monthly...")
    t = time.time()
    conn.execute("DELETE FROM summary_state_monthly WHERE year IN (" + year_list + ")")
    conn.execute(f"""
        INSERT INTO summary_state_monthly
        SELECT year, month, state, ucr_offense_code,
               SUM(offense_count) AS offense_count,
               SUM(cleared_count) AS cleared_count
        FROM summary_city_monthly
        WHERE year IN ({year_list})
        GROUP BY year, month, state, ucr_offense_code
    """)
    conn.commit()
    log(f"    Done ({time.time()-t:.0f}s)")

    # ---- 4. summary_victim_city_monthly ----
    log("  Building summary_victim_city_monthly...")
    t = time.time()
    for yr in years:
        conn.execute(f"DELETE FROM summary_victim_city_monthly WHERE year = {yr}")
        conn.execute(f"""
            INSERT INTO summary_victim_city_monthly
            SELECT year, CAST(SUBSTR(incident_date, 5, 2) AS INT) AS month,
                state, ori, connected_offense_1 AS ucr_offense_code, COUNT(*) AS victim_count
            FROM victims
            WHERE year = {yr} AND incident_date IS NOT NULL AND LENGTH(incident_date) >= 6
              AND connected_offense_1 IN ({PERSON_CRIMES}) AND victim_type = 'I'
            GROUP BY year, SUBSTR(incident_date, 5, 2), state, ori, connected_offense_1
        """)
        conn.commit()
    log(f"    Done ({time.time()-t:.0f}s)")

    # ---- 5. summary_victim_state_monthly ----
    log("  Building summary_victim_state_monthly...")
    t = time.time()
    conn.execute("DELETE FROM summary_victim_state_monthly WHERE year IN (" + year_list + ")")
    conn.execute(f"""
        INSERT INTO summary_victim_state_monthly
        SELECT year, month, state, ucr_offense_code, SUM(victim_count) AS victim_count
        FROM summary_victim_city_monthly
        WHERE year IN ({year_list})
        GROUP BY year, month, state, ucr_offense_code
    """)
    conn.commit()
    log(f"    Done ({time.time()-t:.0f}s)")

    # ---- 6. summary_victim_demographics ----
    log("  Building summary_victim_demographics...")
    t = time.time()
    for yr in years:
        conn.execute(f"DELETE FROM summary_victim_demographics WHERE year = {yr}")
        conn.execute(f"""
            INSERT INTO summary_victim_demographics
            SELECT
                v.ori, v.year, v.connected_offense_1 AS ucr_offense_code,
                CASE
                    WHEN o.type_weapon_1 IN ('11','12','13','14','15') THEN 'Firearm'
                    WHEN o.type_weapon_1 IN ('20') THEN 'Knife'
                    WHEN o.type_weapon_1 IN ('30') THEN 'Blunt Object'
                    WHEN o.type_weapon_1 IN ('90','95','99','') THEN 'Unknown'
                    ELSE 'Other'
                END AS weapon_category,
                COALESCE(NULLIF(v.race, ''), 'U') AS race,
                COALESCE(NULLIF(v.sex, ''), 'U') AS sex,
                CASE
                    WHEN v.age = '' OR v.age IS NULL OR v.age = '00' THEN 'Unknown'
                    WHEN CAST(v.age AS INT) < 18 THEN 'Under 18'
                    WHEN CAST(v.age AS INT) BETWEEN 18 AND 24 THEN '18-24'
                    WHEN CAST(v.age AS INT) BETWEEN 25 AND 34 THEN '25-34'
                    WHEN CAST(v.age AS INT) BETWEEN 35 AND 44 THEN '35-44'
                    WHEN CAST(v.age AS INT) BETWEEN 45 AND 54 THEN '45-54'
                    WHEN CAST(v.age AS INT) BETWEEN 55 AND 64 THEN '55-64'
                    WHEN CAST(v.age AS INT) >= 65 THEN '65+'
                    ELSE 'Unknown'
                END AS age_group,
                COALESCE(v.ethnicity, 'U') AS ethnicity,
                COUNT(*) AS victim_count,
                v.state
            FROM victims v
            LEFT JOIN offenses o ON o.year = v.year AND o.ori = v.ori
                AND o.incident_num = v.incident_num AND o.ucr_offense_code = v.connected_offense_1
            WHERE v.year = {yr}
              AND v.connected_offense_1 IN ({PERSON_CRIMES}) AND v.victim_type = 'I'
            GROUP BY v.ori, v.year, v.connected_offense_1, weapon_category, race, sex, age_group, ethnicity, v.state
        """)
        conn.commit()
    log(f"    Done ({time.time()-t:.0f}s)")

    # ---- 7. summary_carjacking_monthly ----
    log("  Building summary_carjacking_monthly...")
    t = time.time()
    for yr in years:
        conn.execute(f"DELETE FROM summary_carjacking_monthly WHERE year = {yr}")
        conn.execute(f"""
            INSERT INTO summary_carjacking_monthly
            SELECT o.year, CAST(SUBSTR(o.incident_date, 5, 2) AS INT) AS month,
                o.state, o.ori, COUNT(DISTINCT o.ori || o.incident_num) AS offense_count
            FROM offenses o
            JOIN property p ON p.year = o.year AND p.ori = o.ori AND p.incident_num = o.incident_num
            WHERE o.year = {yr} AND o.ucr_offense_code = '120'
              AND p.type_property_loss = '7' AND p.property_description IN ('03','05','24','28','37')
              AND o.incident_date IS NOT NULL AND LENGTH(o.incident_date) >= 6
            GROUP BY o.year, SUBSTR(o.incident_date, 5, 2), o.state, o.ori
        """)
        conn.commit()
    log(f"    Done ({time.time()-t:.0f}s)")

    # ---- 8. summary_drug_monthly ----
    log("  Building summary_drug_monthly...")
    t = time.time()
    for yr in years:
        conn.execute(f"DELETE FROM summary_drug_monthly WHERE year = {yr}")
        for col_num, col_name in [(1, 'suspected_drug_type_1'), (2, 'suspected_drug_type_2'), (3, 'suspected_drug_type_3')]:
            try:
                conn.execute(f"""
                    INSERT INTO summary_drug_monthly
                    SELECT o.year,
                           CAST(SUBSTR(o.incident_date, 5, 2) AS INT) AS month,
                           o.state, o.ori, o.ucr_offense_code,
                           p.{col_name} AS suspected_drug_type,
                           COUNT(DISTINCT o.ori || o.incident_num) AS offense_count
                    FROM offenses o
                    JOIN property p ON p.year = o.year AND p.ori = o.ori
                        AND p.incident_num = o.incident_num
                    WHERE o.year = {yr}
                      AND o.ucr_offense_code IN ('35A', '35B')
                      AND o.incident_date IS NOT NULL AND LENGTH(o.incident_date) >= 6
                      AND p.{col_name} IS NOT NULL AND p.{col_name} != ''
                    GROUP BY o.year, SUBSTR(o.incident_date, 5, 2), o.state, o.ori,
                             o.ucr_offense_code, p.{col_name}
                """)
            except sqlite3.OperationalError:
                log(f"    WARNING: {col_name} column missing, skipping")
                break
        conn.commit()
    log(f"    Done ({time.time()-t:.0f}s)")

    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    elapsed = time.time() - total_start
    log(f"  Summary rebuild complete ({elapsed:.0f}s / {elapsed/60:.1f} min)")


def ensure_performance_indexes(conn):
    """Create idempotent indexes used by live query paths."""
    log("Ensuring performance indexes...")
    t = time.time()
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_sad_offense_state_year
        ON summary_arrestee_demographics(ucr_arrest_offense, state, year)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_agencies_year_state_population
        ON agencies(year, state, population)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_svd_continuous_age
        ON summary_victim_demographics(ucr_offense_code, year, ori, age_group, victim_count)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_sod_continuous_age
        ON summary_offender_demographics(ucr_offense_code, year, ori, age_group, offender_count)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_sad_age_year_ori
        ON summary_arrestee_demographics(age_group, year, ori, arrestee_count)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_sod_age_year_ori
        ON summary_offender_demographics(age_group, year, ori, offender_count)
    """)
    if conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'state_population'").fetchone():
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_state_population_year
            ON state_population(year, state)
        """)
    if conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nibrs_consistent_reporters'").fetchone():
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_ncr_ori_range
            ON nibrs_consistent_reporters(ori, start_year, end_year)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_ncr_end_start
            ON nibrs_consistent_reporters(end_year, start_year)
        """)
    conn.commit()
    log(f"  Performance indexes ready ({time.time()-t:.0f}s)")


def ensure_state_population(conn):
    """Materialize canonical state/national population denominators in NIBRS."""
    log("Ensuring state_population...")
    t = time.time()
    if not os.path.exists(HISTORICAL_DB_PATH):
        log(f"  WARNING: historical DB not found at {HISTORICAL_DB_PATH}; leaving existing state_population unchanged")
        return

    historical = sqlite3.connect(HISTORICAL_DB_PATH)
    try:
        source_rows = historical.execute("""
            SELECT state, year, population
            FROM historical_state_national
            WHERE population IS NOT NULL AND population > 0
            ORDER BY state, year
        """).fetchall()
    finally:
        historical.close()

    rows = []
    for state_name, year, population in source_rows:
        normalized = " ".join(str(state_name).strip().split())
        abbr = STATE_NAME_TO_ABBR.get(normalized)
        if not abbr:
            continue
        rows.append((
            abbr,
            normalized,
            int(year),
            int(population),
            "Historical Library historical_state_national population",
        ))

    if not rows:
        raise RuntimeError("No mappable state population rows found")

    conn.execute("DROP TABLE IF EXISTS state_population")
    conn.execute("""
        CREATE TABLE state_population (
            state TEXT NOT NULL,
            state_name TEXT NOT NULL,
            year INTEGER NOT NULL,
            population INTEGER NOT NULL,
            source TEXT NOT NULL,
            PRIMARY KEY (state, year)
        )
    """)
    conn.executemany("""
        INSERT INTO state_population (state, state_name, year, population, source)
        VALUES (?, ?, ?, ?, ?)
    """, rows)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_state_population_year
        ON state_population(year, state)
    """)
    conn.commit()

    first_year = min(row[2] for row in rows)
    last_year = max(row[2] for row in rows)
    states = len({row[0] for row in rows})
    log(f"  state_population ready: {len(rows):,} rows, {states} entities, {first_year}-{last_year} ({time.time()-t:.0f}s)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    log("=" * 60)
    log("NIBRS AUTO-UPDATE STARTING")
    log("=" * 60)

    args = parse_args()
    years = get_years_to_update(args.years)
    protected_years = parse_year_csv(args.protected_years)
    assert_no_protected_years(years, protected_years, args.allow_protected_years)
    log(f"Protected years: {sorted(protected_years)}")
    log(f"Years to check: {years}")

    os.environ['SQLITE_TMPDIR'] = TMP_DIR
    os.makedirs(TMP_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)

    if not os.path.exists(DB_PATH):
        log(f"ERROR: Database not found: {DB_PATH}")
        sys.exit(1)

    checksums = load_checksums()
    years_to_process = []

    # Download and check for changes
    for year in years:
        zip_path = download_year(year)
        if not zip_path:
            log(f"  {year}: download failed, skipping")
            continue

        # Validate zip
        try:
            zf = zipfile.ZipFile(zip_path)
            entry = find_txt_in_zip(zf)
            zf.close()
            if not entry:
                log(f"  {year}: no data file in zip, skipping")
                os.remove(zip_path)
                continue
        except Exception as e:
            log(f"  {year}: invalid zip ({e}), skipping")
            if os.path.exists(zip_path):
                os.remove(zip_path)
            continue

        # Compare checksums
        new_hash = sha256_file(zip_path)
        old_hash = checksums.get(str(year))

        if new_hash == old_hash:
            log(f"  {year}: UNCHANGED (hash match), skipping")
            os.remove(zip_path)
            continue

        log(f"  {year}: CHANGED (new data detected)")
        years_to_process.append((year, zip_path, new_hash))

    if not years_to_process:
        log("No changes detected. Nothing to do.")
        log("AUTO-UPDATE COMPLETE")
        return

    # Stop app to release DB lock
    log("Stopping nibrs app for update...")
    subprocess.run(["pm2", "stop", "nibrs"], capture_output=True, text=True)
    time.sleep(3)

    # Kill any stale DB connections
    subprocess.run(["fuser", "-k", DB_PATH], capture_output=True, text=True)
    time.sleep(1)

    # Open database with safe settings
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA cache_size = -256000")  # 256MB
    conn.execute("PRAGMA temp_store = FILE")
    conn.execute("PRAGMA mmap_size = 0")

    total_start = time.time()

    # Delete old data + import new data for each changed year
    for year, zip_path, new_hash in years_to_process:
        log(f"\n--- Processing year {year} ---")
        retry(delete_year, conn, year, label=f"delete {year}")

        success = retry(import_year, year, zip_path, conn, label=f"import {year}")
        if success:
            checksums[str(year)] = new_hash
            log(f"  {year}: import complete")
        else:
            log(f"  {year}: IMPORT FAILED")

        # Clean up zip
        try:
            os.remove(zip_path)
        except Exception:
            pass

        # Checkpoint to keep WAL manageable
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    # Populate agency_type from pop_group (1-7 = City, 8-9 = County)
    affected_years = [y for y, _, _ in years_to_process]
    for yr in affected_years:
        conn.execute("""
            UPDATE agencies SET agency_type = CASE
                WHEN substr(pop_group, 1, 1) IN ('1','2','3','4','5','6','7') THEN 'City'
                WHEN substr(pop_group, 1, 1) IN ('8','9') THEN 'County'
                ELSE '' END
            WHERE year = ? AND (agency_type IS NULL OR agency_type = '')
        """, (yr,))
    conn.commit()
    log(f"  Updated agency_type for years: {','.join(str(y) for y in affected_years)}")

    # Rebuild summary tables for affected years only
    retry(rebuild_summaries, conn, affected_years, label="rebuild summaries")
    retry(ensure_state_population, conn, label="state population")
    # ensure_state_population drops/rebuilds from historical data (ends ~currentYear-2);
    # extend with FBI CDE API figures so current-year rate queries keep working (F26)
    log("Extending state_population with FBI CDE current-year figures...")
    cde_result = subprocess.run(
        ["npx", "tsx", "scripts/extend-state-population-cde.ts", f"--db={DB_PATH}", "--apply"],
        cwd="/opt/nibrs/repo", capture_output=True, text=True, timeout=600,
    )
    log(cde_result.stdout.strip() or cde_result.stderr.strip())
    if cde_result.returncode != 0:
        log("  WARNING: CDE state_population extension failed; current-year rates may return empty")
    retry(rebuild_consistent_reporters, conn, log, label="consistent reporters")
    retry(ensure_performance_indexes, conn, label="performance indexes")

    # Save checksums
    save_checksums(checksums)

    # Final stats
    log("\n" + "=" * 60)
    log("POST-UPDATE STATS")
    for year in affected_years:
        for table in RAW_TABLES:
            c = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE year = ?", (year,)).fetchone()[0]
            log(f"  {table} [{year}]: {c:,}")

    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()

    fsize = os.path.getsize(DB_PATH) / (1024**3)
    elapsed = time.time() - total_start
    log(f"\nDatabase: {fsize:.2f} GB")
    log(f"Total time: {elapsed:.0f}s ({elapsed/60:.1f} min)")

    # Restart the app
    log("Restarting nibrs app...")
    result = subprocess.run(["pm2", "restart", "nibrs"], capture_output=True, text=True)
    if result.returncode == 0:
        log("  App restarted successfully")
    else:
        log(f"  pm2 restart failed: {result.stderr}")

    log("AUTO-UPDATE COMPLETE")


if __name__ == '__main__':
    main()
