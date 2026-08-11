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
from pathlib import Path
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
SOURCE_GENERATION_PATH = os.environ.get("NIBRS_SOURCE_GENERATION_PATH", "/opt/nibrs/shared/nibrs_source.generation")
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
                  'summary_victim_demographics', 'summary_victim_weapon',
                  'summary_carjacking_monthly', 'summary_drug_monthly',
                  'summary_arrestee_demographics',
                  'summary_carjacking_victim_demographics',
                  'summary_carjacking_offender_demographics',
                  'summary_carjacking_arrestee_demographics',
                  'summary_juvenile_offender_incidents']

INCIDENT_OFFENSE_SCOPES = json.loads(
    (Path(__file__).resolve().parents[1] / 'lib' / 'nibrs-incident-offense-scopes.json').read_text(encoding='utf-8')
)

RAW_DUPLICATE_CHECKS = {
    'incidents': [
        'year', 'state', 'ori', 'incident_num', 'incident_date',
        'report_date_indicator', 'incident_hour', 'total_offense_segments',
        'total_victim_segments', 'total_offender_segments',
        'total_arrestee_segments', 'cleared_exceptionally',
        'clearance_date', 'cargo_theft',
    ],
    'offenses': [
        'year', 'state', 'ori', 'incident_num', 'incident_date',
        'ucr_offense_code', 'attempted_completed',
        'offender_suspected_of_using_1', 'offender_suspected_of_using_2',
        'offender_suspected_of_using_3', 'location_type',
        'num_premises_entered', 'method_of_entry',
        'type_criminal_activity_1', 'type_criminal_activity_2',
        'type_criminal_activity_3', 'type_weapon_1', 'type_weapon_2',
        'type_weapon_3', 'bias_motivation',
    ],
    'property': [
        'year', 'state', 'ori', 'incident_num', 'incident_date',
        'type_property_loss', 'property_description', 'value',
        'date_recovered', 'num_stolen_motor_vehicles',
        'num_recovered_motor_vehicles', 'suspected_drug_type_1',
        'suspected_drug_type_2', 'suspected_drug_type_3',
    ],
    'victims': [
        'year', 'state', 'ori', 'incident_num', 'incident_date',
        'victim_sequence', 'victim_type', 'age', 'sex', 'race', 'ethnicity',
        'resident_status', 'aggravated_assault_homicide_1',
        'aggravated_assault_homicide_2', 'additional_justifiable_homicide',
        'injury_type_1', 'injury_type_2', 'injury_type_3', 'injury_type_4',
        'injury_type_5', 'offender_number_1', 'relationship_1',
        'offender_number_2', 'relationship_2', 'offender_number_3',
        'relationship_3', 'connected_offense_1', 'connected_offense_2',
        'connected_offense_3',
    ],
    'offenders': [
        'year', 'state', 'ori', 'incident_num', 'incident_date',
        'offender_sequence', 'age', 'sex', 'race', 'ethnicity',
    ],
    'arrestees': [
        'year', 'state', 'ori', 'incident_num', 'incident_date',
        'arrestee_sequence', 'arrest_number', 'arrest_date', 'arrest_type',
        'multiple_indicator', 'ucr_arrest_offense', 'arrestee_weapon_1',
        'arrestee_weapon_2', 'age', 'sex', 'race', 'ethnicity',
        'resident_status', 'disposition_under_18',
    ],
    'group_b_arrests': [
        'year', 'state', 'ori', 'segment_action_type', 'incident_num',
        'arrest_date', 'arrest_type', 'ucr_arrest_offense',
        'arrestee_weapon_1', 'arrestee_weapon_2', 'age', 'sex', 'race',
        'ethnicity', 'resident_status', 'disposition_under_18',
    ],
}

PERSON_CRIMES = (
    "'09A','09B','09C','100','11A','11B','11C','11D',"
    "'13A','13B','13C','36A','36B','64A','64B'"
)

WEAPON_VICTIM_CRIMES = "'09A','09B','09C','11A','11B','11C','13A','13B','120'"
FIREARM_WEAPON_CODES = "'11','11A','12','12A','13','13A','14','14A','15','15A'"

SUMMARY_DUPLICATE_CHECKS = {
    'summary_victim_demographics': {
        'year_col': 'year',
        'key_cols': ['ori', 'year', 'ucr_offense_code', 'weapon_category', 'race', 'sex', 'age_group', 'ethnicity', 'state'],
    },
    'summary_arrestee_demographics': {
        'year_col': 'year',
        'key_cols': ['ori', 'year', 'ucr_arrest_offense', 'weapon_category', 'race', 'sex', 'age_group', 'ethnicity', 'state'],
    },
    'summary_drug_monthly': {
        'year_col': 'year',
        'key_cols': ['year', 'month', 'state', 'ori', 'ucr_offense_code', 'suspected_drug_type'],
    },
    'summary_victim_state_monthly': {
        'year_col': 'year',
        'key_cols': ['state', 'year', 'month', 'ucr_offense_code'],
    },
    'summary_domestic_violence': {
        'year_col': 'data_year',
        'key_cols': [
            'data_year', 'state', 'ori', 'incident_num', 'incident_date', 'victim_sequence',
            'offense_code', 'relationship_code', 'dv_category', 'victim_sex', 'victim_age',
            'victim_race',
        ],
    },
    'summary_carjacking_victim_demographics': {
        'year_col': 'year',
        'key_cols': ['ori', 'year', 'weapon_category', 'race', 'sex', 'age_group', 'state'],
    },
    'summary_carjacking_offender_demographics': {
        'year_col': 'year',
        'key_cols': ['ori', 'year', 'weapon_category', 'race', 'sex', 'age_group', 'state'],
    },
    'summary_carjacking_arrestee_demographics': {
        'year_col': 'year',
        'key_cols': ['ori', 'year', 'weapon_category', 'race', 'sex', 'age_group', 'state'],
    },
    'summary_juvenile_offender_incidents': {
        'year_col': 'year',
        'key_cols': ['year', 'month', 'ori', 'offense_scope'],
    },
}


def weapon_category_expr(col):
    return f"""
                CASE
                    WHEN {col} IN ({FIREARM_WEAPON_CODES}) THEN 'Firearm'
                    WHEN {col} IN ('20') THEN 'Knife'
                    WHEN {col} IN ('30') THEN 'Blunt Object'
                    WHEN {col} IN ('90','95','99','') OR {col} IS NULL THEN 'Unknown'
                    ELSE 'Other'
                END
    """


def age_group_expr(col):
    return f"""
                CASE
                    WHEN {col} = '' OR {col} IS NULL OR {col} = '00' THEN 'Unknown'
                    WHEN CAST({col} AS INT) < 18 THEN 'Under 18'
                    WHEN CAST({col} AS INT) BETWEEN 18 AND 24 THEN '18-24'
                    WHEN CAST({col} AS INT) BETWEEN 25 AND 34 THEN '25-34'
                    WHEN CAST({col} AS INT) BETWEEN 35 AND 44 THEN '35-44'
                    WHEN CAST({col} AS INT) BETWEEN 45 AND 54 THEN '45-54'
                    WHEN CAST({col} AS INT) BETWEEN 55 AND 64 THEN '55-64'
                    WHEN CAST({col} AS INT) >= 65 THEN '65+'
                    ELSE 'Unknown'
                END
    """


def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def source_generation_token(path=DB_PATH):
    """Return the cheap source identity used to invalidate compact rollups."""
    stat = os.stat(path)
    return f"{stat.st_size}:{stat.st_mtime_ns}"


def publish_source_generation():
    """Atomically advance the generation only after a successful DB update."""
    token = source_generation_token()
    os.makedirs(os.path.dirname(SOURCE_GENERATION_PATH), exist_ok=True)
    temporary = f"{SOURCE_GENERATION_PATH}.tmp.{os.getpid()}"
    with open(temporary, "w", encoding="utf-8") as handle:
        handle.write(token + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, SOURCE_GENERATION_PATH)
    log(f"Published source generation {token}; old compact rollups now fail closed")

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
    parser.add_argument(
        "--rebuild-derived-years",
        nargs="+",
        type=int,
        help="Maintenance mode: rebuild derived summary tables for existing raw-data years, without downloading or reimporting CDE files.",
    )
    parser.add_argument(
        "--rebuild-victim-demographics-years",
        nargs="+",
        type=int,
        help="Maintenance mode: rebuild only summary_victim_demographics for existing raw-data years, then verify duplicate keys.",
    )
    parser.add_argument(
        "--rebuild-arrestee-demographics-years",
        nargs="+",
        type=int,
        help="Maintenance mode: rebuild only summary_arrestee_demographics for existing raw-data years, then verify duplicate keys.",
    )
    parser.add_argument(
        "--rebuild-carjacking-demographics-years",
        nargs="+",
        type=int,
        help="Maintenance mode: rebuild carjacking demographic summaries for existing raw-data years, then verify duplicate keys.",
    )
    parser.add_argument(
        "--verify-derived-duplicates",
        action="store_true",
        help="Read-only maintenance mode: verify duplicate keys on derived summary tables. Use --years to limit the scan.",
    )
    parser.add_argument(
        "--verify-raw-duplicates",
        action="store_true",
        help="Read-only maintenance mode: verify exact duplicate rows in raw NIBRS segment tables. Requires --years.",
    )
    parser.add_argument(
        "--dedupe-raw-years",
        nargs="+",
        type=int,
        help="Maintenance mode: delete exact duplicate raw segment rows for existing years, then rebuild and verify derived summaries.",
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
    conn.execute("""
        CREATE TABLE IF NOT EXISTS nibrs_summary_freshness (
          summary_name TEXT PRIMARY KEY, ready INTEGER NOT NULL,
          refreshed_at TEXT NOT NULL, max_year INTEGER
        )
    """)
    conn.execute(
        "INSERT OR REPLACE INTO nibrs_summary_freshness(summary_name,ready,refreshed_at,max_year) VALUES ('summary_juvenile_offender_incidents',0,datetime('now'),NULL)"
    )
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

def rebuild_summary_victim_demographics(conn, years):
    """Rebuild summary_victim_demographics for the given years only."""
    log("  Building summary_victim_demographics...")
    t = time.time()
    weapon_cat = weapon_category_expr("o.type_weapon_1")
    race_expr = "COALESCE(NULLIF(v.race, ''), 'U')"
    sex_expr = "COALESCE(NULLIF(v.sex, ''), 'U')"
    age_grp = age_group_expr("v.age")
    ethnicity_expr = "COALESCE(v.ethnicity, 'U')"
    conn.execute("""
        CREATE TABLE IF NOT EXISTS summary_victim_demographics (
            ori TEXT,
            year INT,
            ucr_offense_code TEXT,
            weapon_category TEXT,
            race TEXT,
            sex TEXT,
            age_group TEXT,
            ethnicity TEXT,
            victim_count INT,
            state TEXT
        )
    """)
    for yr in years:
        conn.execute(f"DELETE FROM summary_victim_demographics WHERE year = {yr}")
        conn.execute(f"""
            INSERT INTO summary_victim_demographics (
                ori, year, ucr_offense_code, weapon_category, race, sex,
                age_group, ethnicity, victim_count, state
            )
            SELECT
                v.ori, v.year, v.connected_offense_1 AS ucr_offense_code,
                {weapon_cat} AS weapon_category,
                {race_expr} AS race,
                {sex_expr} AS sex,
                {age_grp} AS age_group,
                {ethnicity_expr} AS ethnicity,
                COUNT(*) AS victim_count,
                v.state
            FROM victims v
            LEFT JOIN offenses o ON o.year = v.year AND o.ori = v.ori
                AND o.incident_num = v.incident_num AND o.ucr_offense_code = v.connected_offense_1
            WHERE v.year = {yr}
              AND v.connected_offense_1 IN ({PERSON_CRIMES}) AND v.victim_type = 'I'
            GROUP BY v.ori, v.year, v.connected_offense_1,
                {weapon_cat}, {race_expr}, {sex_expr}, {age_grp}, {ethnicity_expr}, v.state
        """)
        conn.commit()
    log(f"    Done ({time.time()-t:.0f}s)")


def rebuild_summary_arrestee_demographics(conn, years):
    """Rebuild summary_arrestee_demographics for the given years only."""
    log("  Building summary_arrestee_demographics...")
    t = time.time()
    weapon_offense = weapon_category_expr("off.type_weapon_1")
    weapon_arrestee = weapon_category_expr("a.arrestee_weapon_1")
    race_expr = "COALESCE(a.race, 'U')"
    sex_expr = "COALESCE(a.sex, 'U')"
    age_grp = age_group_expr("a.age")
    ethnicity_expr = "COALESCE(a.ethnicity, 'U')"
    conn.execute("""
        CREATE TABLE IF NOT EXISTS summary_arrestee_demographics (
            ori TEXT,
            year INT,
            ucr_arrest_offense TEXT,
            weapon_category TEXT,
            race TEXT,
            sex TEXT,
            age_group TEXT,
            ethnicity TEXT,
            arrestee_count INT,
            state TEXT
        )
    """)
    for yr in years:
        conn.execute(f"DELETE FROM summary_arrestee_demographics WHERE year = {yr}")
        conn.execute(f"""
            INSERT INTO summary_arrestee_demographics (
                ori, year, ucr_arrest_offense, weapon_category, race, sex,
                age_group, ethnicity, arrestee_count, state
            )
            WITH offense_weapon AS (
                SELECT year, ori, incident_num, ucr_offense_code, MIN(type_weapon_1) AS type_weapon_1
                FROM offenses
                WHERE year = {yr}
                GROUP BY year, ori, incident_num, ucr_offense_code
            )
            SELECT
                a.ori, a.year, a.ucr_arrest_offense,
                {weapon_offense} AS weapon_category,
                {race_expr} AS race,
                {sex_expr} AS sex,
                {age_grp} AS age_group,
                {ethnicity_expr} AS ethnicity,
                COUNT(*) AS arrestee_count,
                a.state
            FROM arrestees a
            JOIN offense_weapon off ON a.year = off.year AND a.ori = off.ori
                AND a.incident_num = off.incident_num
                AND off.ucr_offense_code = a.ucr_arrest_offense
            WHERE a.year = {yr} AND a.ucr_arrest_offense NOT LIKE '90%'
            GROUP BY a.ori, a.year, a.ucr_arrest_offense,
                {weapon_offense}, {race_expr}, {sex_expr}, {age_grp}, {ethnicity_expr}, a.state
        """)
        conn.execute(f"""
            INSERT INTO summary_arrestee_demographics (
                ori, year, ucr_arrest_offense, weapon_category, race, sex,
                age_group, ethnicity, arrestee_count, state
            )
            SELECT
                a.ori, a.year, a.ucr_arrest_offense,
                {weapon_arrestee} AS weapon_category,
                {race_expr} AS race,
                {sex_expr} AS sex,
                {age_grp} AS age_group,
                {ethnicity_expr} AS ethnicity,
                COUNT(*) AS arrestee_count,
                a.state
            FROM arrestees a
            WHERE a.year = {yr} AND a.ucr_arrest_offense LIKE '90%'
            GROUP BY a.ori, a.year, a.ucr_arrest_offense,
                {weapon_arrestee}, {race_expr}, {sex_expr}, {age_grp}, {ethnicity_expr}, a.state
        """)
        conn.commit()
    log(f"    Done ({time.time()-t:.0f}s)")


def rebuild_summary_carjacking_demographics(conn, years):
    """Rebuild carjacking victim/offender/arrestee demographic summaries."""
    log("  Building summary_carjacking_*_demographics...")
    t = time.time()
    year_list = ','.join(str(y) for y in years)
    conn.execute("DROP TABLE IF EXISTS _tmp_carjacking_incidents")
    conn.execute(f"""
        CREATE TEMP TABLE _tmp_carjacking_incidents AS
        SELECT o.ori, o.incident_num, o.year, MIN(o.type_weapon_1) AS weapon
        FROM offenses o
        WHERE o.year IN ({year_list})
          AND o.ucr_offense_code = '120'
          AND EXISTS (
            SELECT 1 FROM property p
            WHERE p.ori = o.ori AND p.incident_num = o.incident_num AND p.year = o.year
              AND p.type_property_loss = '7'
              AND p.property_description IN ('03','05','24','28','37')
          )
        GROUP BY o.ori, o.incident_num, o.year
    """)
    conn.execute("CREATE UNIQUE INDEX idx_tmp_carjacking_incidents ON _tmp_carjacking_incidents(ori, incident_num, year)")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS summary_carjacking_victim_demographics (
            ori TEXT, year INT, weapon_category TEXT, race TEXT, sex TEXT,
            age_group TEXT, victim_count INT, state TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS summary_carjacking_offender_demographics (
            ori TEXT, year INT, weapon_category TEXT, race TEXT, sex TEXT,
            age_group TEXT, offender_count INT, state TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS summary_carjacking_arrestee_demographics (
            ori TEXT, year INT, weapon_category TEXT, race TEXT, sex TEXT,
            age_group TEXT, arrestee_count INT, state TEXT
        )
    """)

    for table in [
        'summary_carjacking_victim_demographics',
        'summary_carjacking_offender_demographics',
        'summary_carjacking_arrestee_demographics',
    ]:
        conn.execute(f"DELETE FROM {table} WHERE year IN ({year_list})")

    victim_weapon = weapon_category_expr("cj.weapon")
    victim_race = "COALESCE(NULLIF(v.race, ''), 'U')"
    victim_sex = "COALESCE(NULLIF(v.sex, ''), 'U')"
    victim_age = age_group_expr("v.age")
    conn.execute(f"""
        INSERT INTO summary_carjacking_victim_demographics (
            ori, year, weapon_category, race, sex, age_group, victim_count, state
        )
        SELECT
            v.ori, v.year,
            {victim_weapon} AS weapon_category,
            {victim_race} AS race,
            {victim_sex} AS sex,
            {victim_age} AS age_group,
            COUNT(*) AS victim_count,
            v.state
        FROM victims v
        INNER JOIN _tmp_carjacking_incidents cj
            ON v.ori = cj.ori AND v.incident_num = cj.incident_num AND v.year = cj.year
        WHERE v.victim_type = 'I'
        GROUP BY v.ori, v.year, {victim_weapon}, {victim_race}, {victim_sex}, {victim_age}, v.state
    """)

    offender_weapon = weapon_category_expr("cj.weapon")
    offender_race = "COALESCE(NULLIF(off.race, ''), 'U')"
    offender_sex = "COALESCE(NULLIF(off.sex, ''), 'U')"
    offender_age = age_group_expr("off.age")
    conn.execute(f"""
        INSERT INTO summary_carjacking_offender_demographics (
            ori, year, weapon_category, race, sex, age_group, offender_count, state
        )
        SELECT
            off.ori, off.year,
            {offender_weapon} AS weapon_category,
            {offender_race} AS race,
            {offender_sex} AS sex,
            {offender_age} AS age_group,
            COUNT(*) AS offender_count,
            off.state
        FROM offenders off
        INNER JOIN _tmp_carjacking_incidents cj
            ON off.ori = cj.ori AND off.incident_num = cj.incident_num AND off.year = cj.year
        GROUP BY off.ori, off.year, {offender_weapon}, {offender_race}, {offender_sex}, {offender_age}, off.state
    """)

    arrestee_weapon = weapon_category_expr("a.arrestee_weapon_1")
    arrestee_race = "COALESCE(NULLIF(a.race, ''), 'U')"
    arrestee_sex = "COALESCE(NULLIF(a.sex, ''), 'U')"
    arrestee_age = age_group_expr("a.age")
    conn.execute(f"""
        INSERT INTO summary_carjacking_arrestee_demographics (
            ori, year, weapon_category, race, sex, age_group, arrestee_count, state
        )
        SELECT
            a.ori, a.year,
            {arrestee_weapon} AS weapon_category,
            {arrestee_race} AS race,
            {arrestee_sex} AS sex,
            {arrestee_age} AS age_group,
            COUNT(*) AS arrestee_count,
            a.state
        FROM arrestees a
        INNER JOIN _tmp_carjacking_incidents cj
            ON a.ori = cj.ori AND a.incident_num = cj.incident_num AND a.year = cj.year
        GROUP BY a.ori, a.year, {arrestee_weapon}, {arrestee_race}, {arrestee_sex}, {arrestee_age}, a.state
    """)
    conn.execute("DROP TABLE IF EXISTS _tmp_carjacking_incidents")
    conn.commit()

    conn.execute("CREATE INDEX IF NOT EXISTS idx_scvd_ori_year ON summary_carjacking_victim_demographics(ori, year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scvd_state_year ON summary_carjacking_victim_demographics(state, year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scvd_year ON summary_carjacking_victim_demographics(year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scod_ori_year ON summary_carjacking_offender_demographics(ori, year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scod_state_year ON summary_carjacking_offender_demographics(state, year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scod_year ON summary_carjacking_offender_demographics(year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scad_ori_year ON summary_carjacking_arrestee_demographics(ori, year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scad_state_year ON summary_carjacking_arrestee_demographics(state, year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scad_year ON summary_carjacking_arrestee_demographics(year)")
    conn.commit()
    log(f"    Done ({time.time()-t:.0f}s)")


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
        INSERT INTO summary_victim_state_monthly (
            year, month, state, ucr_offense_code, victim_count
        )
        SELECT year, month, state, ucr_offense_code, SUM(victim_count) AS victim_count
        FROM summary_victim_city_monthly
        WHERE year IN ({year_list})
        GROUP BY year, month, state, ucr_offense_code
    """)
    conn.commit()
    log(f"    Done ({time.time()-t:.0f}s)")

    # ---- 6. summary_victim_demographics ----
    rebuild_summary_victim_demographics(conn, years)

    # ---- 7. summary_victim_weapon ----
    log("  Building summary_victim_weapon...")
    t = time.time()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS summary_victim_weapon (
            ori TEXT,
            year INT,
            ucr_offense_code TEXT,
            weapon_type TEXT,
            victim_count INT,
            state TEXT
        )
    """)
    for yr in years:
        conn.execute(f"DELETE FROM summary_victim_weapon WHERE year = {yr}")
        conn.execute(f"""
            INSERT INTO summary_victim_weapon
            SELECT ori, year, ucr_offense_code, weapon_type, COUNT(*) AS victim_count, state
            FROM (
                SELECT v.ori, v.year, v.connected_offense_1 AS ucr_offense_code,
                       o.type_weapon_1 AS weapon_type, v.state, v.incident_num, v.victim_sequence
                FROM victims v
                JOIN offenses o ON o.year = v.year AND o.ori = v.ori
                    AND o.incident_num = v.incident_num AND o.ucr_offense_code = v.connected_offense_1
                WHERE v.year = {yr}
                  AND v.connected_offense_1 IN ({WEAPON_VICTIM_CRIMES}) AND v.victim_type = 'I'
                  AND o.type_weapon_1 IS NOT NULL AND o.type_weapon_1 != ''
                UNION
                SELECT v.ori, v.year, v.connected_offense_1 AS ucr_offense_code,
                       o.type_weapon_2 AS weapon_type, v.state, v.incident_num, v.victim_sequence
                FROM victims v
                JOIN offenses o ON o.year = v.year AND o.ori = v.ori
                    AND o.incident_num = v.incident_num AND o.ucr_offense_code = v.connected_offense_1
                WHERE v.year = {yr}
                  AND v.connected_offense_1 IN ({WEAPON_VICTIM_CRIMES}) AND v.victim_type = 'I'
                  AND o.type_weapon_2 IS NOT NULL AND o.type_weapon_2 != ''
                UNION
                SELECT v.ori, v.year, v.connected_offense_1 AS ucr_offense_code,
                       o.type_weapon_3 AS weapon_type, v.state, v.incident_num, v.victim_sequence
                FROM victims v
                JOIN offenses o ON o.year = v.year AND o.ori = v.ori
                    AND o.incident_num = v.incident_num AND o.ucr_offense_code = v.connected_offense_1
                WHERE v.year = {yr}
                  AND v.connected_offense_1 IN ({WEAPON_VICTIM_CRIMES}) AND v.victim_type = 'I'
                  AND o.type_weapon_3 IS NOT NULL AND o.type_weapon_3 != ''
            ) victim_weapons
            GROUP BY ori, year, ucr_offense_code, weapon_type, state
        """)
        conn.commit()
    log(f"    Done ({time.time()-t:.0f}s)")

    # ---- 8. summary_carjacking_monthly ----
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

    # ---- 9. summary_drug_monthly ----
    log("  Building summary_drug_monthly...")
    t = time.time()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS summary_drug_monthly (
            year INT,
            month INT,
            state TEXT,
            ori TEXT,
            ucr_offense_code TEXT,
            suspected_drug_type TEXT,
            offense_count INT
        )
    """)
    property_cols = {
        row[1]
        for row in conn.execute("PRAGMA table_info(property)").fetchall()
    }
    drug_cols = ['suspected_drug_type_1', 'suspected_drug_type_2', 'suspected_drug_type_3']
    missing_drug_cols = [col for col in drug_cols if col not in property_cols]
    for yr in years:
        conn.execute(f"DELETE FROM summary_drug_monthly WHERE year = {yr}")
        if missing_drug_cols:
            log(f"    WARNING: missing drug columns {missing_drug_cols}, skipping summary_drug_monthly for {yr}")
            continue
        conn.execute(f"""
            INSERT INTO summary_drug_monthly (
                year, month, state, ori, ucr_offense_code, suspected_drug_type, offense_count
            )
            SELECT
                year, month, state, ori, ucr_offense_code, suspected_drug_type,
                COUNT(DISTINCT ori || ':' || incident_num) AS offense_count
            FROM (
                SELECT DISTINCT o.year,
                       CAST(SUBSTR(o.incident_date, 5, 2) AS INT) AS month,
                       o.state, o.ori, o.incident_num, o.ucr_offense_code,
                       p.suspected_drug_type_1 AS suspected_drug_type
                FROM offenses o
                JOIN property p ON p.year = o.year AND p.ori = o.ori
                    AND p.incident_num = o.incident_num
                WHERE o.year = {yr}
                  AND o.ucr_offense_code IN ('35A', '35B')
                  AND o.incident_date IS NOT NULL AND LENGTH(o.incident_date) >= 6
                  AND p.suspected_drug_type_1 IS NOT NULL AND p.suspected_drug_type_1 != ''
                UNION
                SELECT DISTINCT o.year,
                       CAST(SUBSTR(o.incident_date, 5, 2) AS INT) AS month,
                       o.state, o.ori, o.incident_num, o.ucr_offense_code,
                       p.suspected_drug_type_2 AS suspected_drug_type
                FROM offenses o
                JOIN property p ON p.year = o.year AND p.ori = o.ori
                    AND p.incident_num = o.incident_num
                WHERE o.year = {yr}
                  AND o.ucr_offense_code IN ('35A', '35B')
                  AND o.incident_date IS NOT NULL AND LENGTH(o.incident_date) >= 6
                  AND p.suspected_drug_type_2 IS NOT NULL AND p.suspected_drug_type_2 != ''
                UNION
                SELECT DISTINCT o.year,
                       CAST(SUBSTR(o.incident_date, 5, 2) AS INT) AS month,
                       o.state, o.ori, o.incident_num, o.ucr_offense_code,
                       p.suspected_drug_type_3 AS suspected_drug_type
                FROM offenses o
                JOIN property p ON p.year = o.year AND p.ori = o.ori
                    AND p.incident_num = o.incident_num
                WHERE o.year = {yr}
                  AND o.ucr_offense_code IN ('35A', '35B')
                  AND o.incident_date IS NOT NULL AND LENGTH(o.incident_date) >= 6
                  AND p.suspected_drug_type_3 IS NOT NULL AND p.suspected_drug_type_3 != ''
            ) incident_drugs
            GROUP BY year, month, state, ori, ucr_offense_code, suspected_drug_type
        """)
        conn.commit()
    log(f"    Done ({time.time()-t:.0f}s)")

    # ---- 10. summary_arrestee_demographics ----
    rebuild_summary_arrestee_demographics(conn, years)

    # ---- 11. summary_carjacking_*_demographics ----
    rebuild_summary_carjacking_demographics(conn, years)

    # ---- 12. summary_victims_per_incident ----
    # Incidents bucketed by individual-victim count per offense code
    # (state-level; see scripts/build-victims-per-incident.py for the initial build)
    log("  Building summary_victims_per_incident...")
    t = time.time()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS summary_victims_per_incident (
            year INT, state TEXT, ucr_offense_code TEXT,
            victims_in_incident INT, incident_count INT
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_svpi_code_year
        ON summary_victims_per_incident(ucr_offense_code, year)
    """)
    for yr in years:
        conn.execute(f"DELETE FROM summary_victims_per_incident WHERE year = {yr}")
        conn.execute(f"""
            INSERT INTO summary_victims_per_incident
            SELECT year, state, code, vc AS victims_in_incident, COUNT(*) AS incident_count
            FROM (
                SELECT year, state, ori, incident_num, code, COUNT(*) AS vc
                FROM (
                    SELECT year, state, ori, incident_num, connected_offense_1 AS code FROM victims
                      WHERE year = {yr} AND victim_type = 'I'
                      AND connected_offense_1 IS NOT NULL AND connected_offense_1 != ''
                    UNION ALL
                    SELECT year, state, ori, incident_num, connected_offense_2 FROM victims
                      WHERE year = {yr} AND victim_type = 'I'
                      AND connected_offense_2 IS NOT NULL AND connected_offense_2 != ''
                    UNION ALL
                    SELECT year, state, ori, incident_num, connected_offense_3 FROM victims
                      WHERE year = {yr} AND victim_type = 'I'
                      AND connected_offense_3 IS NOT NULL AND connected_offense_3 != ''
                )
                GROUP BY year, state, ori, incident_num, code
            )
            GROUP BY year, state, code, vc
        """)
        conn.commit()
    log(f"    Done ({time.time()-t:.0f}s)")

    # ---- 13. summary_juvenile_offender_incidents ----
    rebuild_summary_juvenile_offender_incidents(conn, years)

    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    elapsed = time.time() - total_start
    log(f"  Summary rebuild complete ({elapsed:.0f}s / {elapsed/60:.1f} min)")


def rebuild_summary_juvenile_offender_incidents(conn, years):
    """Count distinct offense incidents with at least one known offender age 1-17."""
    log("  Building summary_juvenile_offender_incidents...")
    started = time.time()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS summary_juvenile_offender_incidents (
          year INTEGER NOT NULL, month INTEGER, state TEXT, ori TEXT NOT NULL,
          offense_scope TEXT NOT NULL, incident_count INTEGER NOT NULL
        )
    """)
    has_year_age_index = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_offenders_year_age'"
    ).fetchone() is not None
    offender_hint = " INDEXED BY idx_offenders_year_age" if has_year_age_index else ""
    for yr in years:
        conn.execute("DELETE FROM summary_juvenile_offender_incidents WHERE year=?", (yr,))
        conn.execute("DROP TABLE IF EXISTS _tmp_juvenile_incidents")
        conn.execute("""
            CREATE TEMP TABLE _tmp_juvenile_incidents (
              year INTEGER NOT NULL, ori TEXT NOT NULL, incident_num TEXT NOT NULL,
              state TEXT, month INTEGER, PRIMARY KEY(year,ori,incident_num)
            ) WITHOUT ROWID
        """)
        conn.execute(f"""
            INSERT OR IGNORE INTO _tmp_juvenile_incidents
            SELECT year,ori,incident_num,state,
                   CASE WHEN length(incident_date)>=6 THEN CAST(substr(incident_date,5,2) AS INTEGER) END
            FROM offenders{offender_hint}
            WHERE year=? AND age GLOB '[0-9][0-9]' AND CAST(age AS INTEGER) BETWEEN 1 AND 17
              AND ori IS NOT NULL AND incident_num IS NOT NULL
        """, (yr,))
        conn.execute("DROP TABLE IF EXISTS _tmp_juvenile_scopes")
        conn.execute("""
            CREATE TEMP TABLE _tmp_juvenile_scopes (
              year INTEGER NOT NULL, ori TEXT NOT NULL, incident_num TEXT NOT NULL,
              state TEXT, month INTEGER, offense_scope TEXT NOT NULL,
              PRIMARY KEY(year,ori,incident_num,offense_scope)
            ) WITHOUT ROWID
        """)
        conn.execute("""
            INSERT OR IGNORE INTO _tmp_juvenile_scopes
            SELECT j.year,j.ori,j.incident_num,COALESCE(o.state,j.state),
                   COALESCE(CASE WHEN length(o.incident_date)>=6 THEN CAST(substr(o.incident_date,5,2) AS INTEGER) END,j.month),
                   o.ucr_offense_code
            FROM offenses o INDEXED BY idx_offenses_year
            JOIN _tmp_juvenile_incidents j
              ON j.year=o.year AND j.ori=o.ori AND j.incident_num=o.incident_num
            WHERE o.year=? AND o.ucr_offense_code IS NOT NULL AND o.ucr_offense_code<>''
        """, (yr,))
        for scope, codes in INCIDENT_OFFENSE_SCOPES.items():
            placeholders = ",".join("?" for _ in codes)
            conn.execute(f"""
                INSERT OR IGNORE INTO _tmp_juvenile_scopes
                SELECT year,ori,incident_num,state,month,?
                FROM _tmp_juvenile_scopes
                WHERE offense_scope IN ({placeholders})
            """, (scope, *codes))
        conn.execute("""
            INSERT INTO summary_juvenile_offender_incidents
            SELECT year,month,state,ori,offense_scope,COUNT(*)
            FROM _tmp_juvenile_scopes
            GROUP BY year,month,state,ori,offense_scope
        """)
        conn.commit()
        rows = conn.execute(
            "SELECT COUNT(*) FROM summary_juvenile_offender_incidents WHERE year=?", (yr,)
        ).fetchone()[0]
        log(f"    [{yr}] Juvenile-offender incident groups: {rows:,}")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_sjoi_key ON summary_juvenile_offender_incidents(year,month,ori,offense_scope)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sjoi_scope_year ON summary_juvenile_offender_incidents(offense_scope,year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sjoi_state_year ON summary_juvenile_offender_incidents(state,year,offense_scope)")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS nibrs_summary_freshness (
          summary_name TEXT PRIMARY KEY, ready INTEGER NOT NULL,
          refreshed_at TEXT NOT NULL, max_year INTEGER
        )
    """)
    conn.execute("""
        INSERT OR REPLACE INTO nibrs_summary_freshness(summary_name,ready,refreshed_at,max_year)
        SELECT 'summary_juvenile_offender_incidents',1,datetime('now'),MAX(year)
        FROM summary_juvenile_offender_incidents
    """)
    conn.execute("DROP TABLE IF EXISTS _tmp_juvenile_incidents")
    conn.execute("DROP TABLE IF EXISTS _tmp_juvenile_scopes")
    conn.commit()
    log(f"    Done ({time.time()-started:.0f}s)")


def verify_summary_duplicate_keys(conn, years=None, table_names=None):
    """Fail if protected summary tables have duplicate logical-key rows."""
    names = table_names or list(SUMMARY_DUPLICATE_CHECKS.keys())
    years = sorted(set(int(y) for y in years)) if years else None
    year_label = ",".join(str(y) for y in years) if years else "all years"

    for table in names:
        config = SUMMARY_DUPLICATE_CHECKS[table]
        if not conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone():
            raise RuntimeError(f"{table} is missing")

        where = ""
        if years:
            year_list = ','.join(str(y) for y in years)
            where = f"WHERE {config['year_col']} IN ({year_list})"

        key_cols = ', '.join(config['key_cols'])
        row = conn.execute(f"""
            SELECT COUNT(*) AS duplicate_groups, COALESCE(SUM(extra_rows), 0) AS extra_rows
            FROM (
                SELECT COUNT(*) - 1 AS extra_rows
                FROM {table}
                {where}
                GROUP BY {key_cols}
                HAVING COUNT(*) > 1
            )
        """).fetchone()
        duplicate_groups = row[0] or 0
        extra_rows = row[1] or 0
        if duplicate_groups:
            raise RuntimeError(
                f"{table} has {duplicate_groups:,} duplicate key groups "
                f"({extra_rows:,} extra rows) for {year_label}"
            )
        log(f"  {table} duplicate-key check passed for {year_label}")



def raw_duplicate_count(conn, table, years):
    config = RAW_DUPLICATE_CHECKS[table]
    years = sorted(set(int(y) for y in years))
    year_list = ','.join(str(y) for y in years)
    key_cols = ', '.join(config)
    return conn.execute(f"""
        SELECT COUNT(*) AS duplicate_groups, COALESCE(SUM(extra_rows), 0) AS extra_rows
        FROM (
            SELECT COUNT(*) - 1 AS extra_rows
            FROM {table}
            WHERE year IN ({year_list})
            GROUP BY {key_cols}
            HAVING COUNT(*) > 1
        )
    """).fetchone()


def verify_raw_duplicate_keys(conn, years):
    """Fail if raw segment tables contain exact duplicate rows for selected years."""
    if not years:
        raise RuntimeError("Raw duplicate verification requires explicit years")
    years = sorted(set(int(y) for y in years))
    year_label = ",".join(str(y) for y in years)
    for table in RAW_DUPLICATE_CHECKS:
        duplicate_groups, extra_rows = raw_duplicate_count(conn, table, years)
        duplicate_groups = duplicate_groups or 0
        extra_rows = extra_rows or 0
        if duplicate_groups:
            raise RuntimeError(
                f"{table} has {duplicate_groups:,} exact duplicate groups "
                f"({extra_rows:,} extra rows) for {year_label}"
            )
        log(f"  {table} raw exact-duplicate check passed for {year_label}")


def dedupe_raw_duplicates(conn, years):
    """Delete exact duplicate raw segment rows, keeping the first rowid per group."""
    if not years:
        raise RuntimeError("Raw duplicate dedupe requires explicit years")
    years = sorted(set(int(y) for y in years))
    total_deleted = 0
    for year in years:
        for table, key_cols in RAW_DUPLICATE_CHECKS.items():
            duplicate_groups, extra_rows = raw_duplicate_count(conn, table, [year])
            duplicate_groups = duplicate_groups or 0
            extra_rows = extra_rows or 0
            if not duplicate_groups:
                log(f"  {table} [{year}]: no raw exact duplicates")
                continue
            cols = ', '.join(key_cols)
            log(f"  {table} [{year}]: removing {extra_rows:,} exact duplicate rows from {duplicate_groups:,} groups")
            cur = conn.execute(f"""
                DELETE FROM {table}
                WHERE year = ?
                  AND rowid NOT IN (
                      SELECT MIN(rowid)
                      FROM {table}
                      WHERE year = ?
                      GROUP BY {cols}
                  )
            """, (year, year))
            total_deleted += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
            conn.commit()
    log(f"  Raw exact duplicate cleanup removed {total_deleted:,} rows")
    verify_raw_duplicate_keys(conn, years)


def verify_summary_victim_demographics_unique(conn, years):
    """Backward-compatible wrapper for the older victim-only maintenance path."""
    verify_summary_duplicate_keys(conn, years, ['summary_victim_demographics'])


def ensure_performance_indexes(conn):
    """Create idempotent indexes used by live query paths."""
    log("Ensuring performance indexes...")
    t = time.time()
    deterministic_indexes = [
        ("idx_scm_ori_year", "summary_city_monthly", "ori, year"),
        ("idx_svcm_ori", "summary_victim_city_monthly", "ori"),
        ("idx_nac_ori_year", "nibrs_agency_completeness", "ori, year"),
        ("idx_sct_ori_year", "summary_clearance_type", "ori, year"),
        ("idx_sct_state_year", "summary_clearance_type", "state, year"),
        ("idx_svd_new_ori_year", "summary_victim_demographics", "ori, year"),
        ("idx_sod_new_ori_year", "summary_offender_demographics", "ori, year"),
        ("idx_sad_new_ori_year", "summary_arrestee_demographics", "ori, year"),
        ("idx_scd_ori_year", "summary_clearance_detail", "ori, year"),
        ("idx_agencies_state_city_year", "agencies", "state, city, year, agency_type, population"),
    ]
    for index_name, table_name, columns in deterministic_indexes:
        if conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table_name,),
        ).fetchone():
            conn.execute(
                f"CREATE INDEX IF NOT EXISTS {index_name} ON {table_name}({columns})"
            )

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
        CREATE INDEX IF NOT EXISTS idx_svw_ori_year
        ON summary_victim_weapon(ori, year)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_svw_ucr_year
        ON summary_victim_weapon(ucr_offense_code, year)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_svw_weapon
        ON summary_victim_weapon(weapon_type, year)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_svictim_weapon_state_year
        ON summary_victim_weapon(state, year, ucr_offense_code)
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


def rebuild_dv_trends(conn):
    """Precomputed annual DV incident counts (year x state x category).

    COUNT DISTINCT over summary_domestic_violence is CPU-bound (~15s per live
    query, ~70s for this full rebuild) — precomputing makes DV trend questions
    millisecond lookups. 'all_dv' rows hold the deduplicated total (an incident
    can appear in both categories, so category rows must not be summed for
    totals). See docs/query-audit-2026-07-03-proposals.md (pre-aggregation).
    """
    log("Rebuilding summary_dv_trends...")
    t = time.time()
    conn.execute("DROP TABLE IF EXISTS summary_dv_trends")
    conn.execute("""
        CREATE TABLE summary_dv_trends AS
        SELECT data_year, state, dv_category,
               COUNT(DISTINCT ori || ':' || data_year || ':' || incident_num) AS incident_count
        FROM summary_domestic_violence
        GROUP BY data_year, state, dv_category
        UNION ALL
        SELECT data_year, state, 'all_dv',
               COUNT(DISTINCT ori || ':' || data_year || ':' || incident_num)
        FROM summary_domestic_violence
        GROUP BY data_year, state
    """)
    conn.execute("CREATE INDEX idx_dvt_cat_year ON summary_dv_trends(dv_category, data_year)")
    conn.execute("CREATE INDEX idx_dvt_state_year ON summary_dv_trends(state, data_year)")
    conn.commit()
    count = conn.execute("SELECT COUNT(*) FROM summary_dv_trends").fetchone()[0]
    log(f"  summary_dv_trends ready: {count:,} rows ({time.time()-t:.0f}s)")


def refresh_planner_statistics(conn):
    """Sampled ANALYZE on summary/lookup tables after rebuilds.

    Without sqlite_stat1 rows the planner picks catastrophically bad plans
    (e.g. driving a state-filtered demographics query through the ORI index:
    34s instead of 0.1s — 2026-07-03 diagnosis). Rebuilt tables lose their
    statistics, so this must run after every rebuild. analysis_limit keeps it
    to ~1000 sampled rows per index (<1s total).
    """
    log("Refreshing query-planner statistics (ANALYZE)...")
    t = time.time()
    conn.execute("PRAGMA analysis_limit=1000")
    tables = conn.execute("""
        SELECT name FROM sqlite_master WHERE type = 'table' AND (
            name LIKE 'summary_%' OR name IN (
                'agencies','nibrs_consistent_reporters','nibrs_agency_completeness',
                'agency_county_crosswalk','state_population','county_lookup'
            )
        )
    """).fetchall()
    for (table,) in tables:
        conn.execute(f"ANALYZE {table}")
    conn.commit()
    log(f"  ANALYZE done: {len(tables)} tables ({time.time()-t:.0f}s)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    log("=" * 60)
    log("NIBRS AUTO-UPDATE STARTING")
    log("=" * 60)

    args = parse_args()
    maintenance_modes = [
        args.rebuild_derived_years,
        args.rebuild_victim_demographics_years,
        args.rebuild_arrestee_demographics_years,
        args.rebuild_carjacking_demographics_years,
        args.dedupe_raw_years,
    ]
    if sum(1 for mode in maintenance_modes if mode) > 1:
        raise SystemExit(
            "Choose only one maintenance mode: --rebuild-derived-years, "
            "--rebuild-victim-demographics-years, --rebuild-arrestee-demographics-years, "
            "--rebuild-carjacking-demographics-years, or --dedupe-raw-years."
        )
    has_maintenance_mode = any(maintenance_modes)

    years = []
    if not has_maintenance_mode and not args.verify_derived_duplicates and not args.verify_raw_duplicates:
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

    if args.verify_derived_duplicates and not has_maintenance_mode:
        affected_years = sorted(set(args.years)) if args.years else None
        log(f"Maintenance mode: verifying derived duplicate keys for {affected_years or 'all years'}")
        conn = sqlite3.connect(DB_PATH)
        try:
            retry(verify_summary_duplicate_keys, conn, affected_years, label="derived duplicate-key check")
        finally:
            conn.close()
        log("AUTO-UPDATE COMPLETE")
        return

    if args.verify_raw_duplicates and not has_maintenance_mode:
        if not args.years:
            raise SystemExit("--verify-raw-duplicates requires --years")
        affected_years = sorted(set(args.years))
        log(f"Maintenance mode: verifying raw exact duplicates for {affected_years}")
        conn = sqlite3.connect(DB_PATH)
        try:
            retry(verify_raw_duplicate_keys, conn, affected_years, label="raw duplicate-key check")
        finally:
            conn.close()
        log("AUTO-UPDATE COMPLETE")
        return

    if args.dedupe_raw_years:
        affected_years = sorted(set(args.dedupe_raw_years))
        protected_years = parse_year_csv(args.protected_years)
        assert_no_protected_years(affected_years, protected_years, args.allow_protected_years)
        log(f"Maintenance mode: deduping raw segment rows and rebuilding summaries for years: {affected_years}")
        log("Stopping nibrs app for raw dedupe/rebuild...")
        subprocess.run(["pm2", "stop", "nibrs"], capture_output=True, text=True)
        time.sleep(3)
        subprocess.run(["fuser", "-k", DB_PATH], capture_output=True, text=True)
        time.sleep(1)

        conn = sqlite3.connect(DB_PATH)
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA cache_size = -256000")
        conn.execute("PRAGMA temp_store = FILE")
        conn.execute("PRAGMA mmap_size = 0")
        total_start = time.time()
        try:
            retry(dedupe_raw_duplicates, conn, affected_years, label="raw duplicate cleanup")
            retry(rebuild_summaries, conn, affected_years, label="rebuild summaries")
            retry(verify_summary_duplicate_keys, conn, affected_years, label="summary duplicate-key check")
            retry(rebuild_consistent_reporters, conn, log, label="consistent reporters")
            retry(rebuild_dv_trends, conn, label="dv trends")
            retry(ensure_performance_indexes, conn, label="performance indexes")
            retry(refresh_planner_statistics, conn, label="planner statistics")
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()

        elapsed = time.time() - total_start
        log(f"Raw dedupe/rebuild complete in {elapsed:.0f}s ({elapsed/60:.1f} min)")
        log("Restarting nibrs app...")
        result = subprocess.run(["pm2", "restart", "nibrs"], capture_output=True, text=True)
        if result.returncode == 0:
            log("  App restarted successfully")
        else:
            log(f"  pm2 restart failed: {result.stderr}")
        log("AUTO-UPDATE COMPLETE")
        return

    if args.rebuild_victim_demographics_years:
        affected_years = sorted(set(args.rebuild_victim_demographics_years))
        log(f"Maintenance mode: rebuilding summary_victim_demographics for years: {affected_years}")
        log("Stopping nibrs app for victim-demographics rebuild...")
        subprocess.run(["pm2", "stop", "nibrs"], capture_output=True, text=True)
        time.sleep(3)
        subprocess.run(["fuser", "-k", DB_PATH], capture_output=True, text=True)
        time.sleep(1)

        conn = sqlite3.connect(DB_PATH)
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA cache_size = -256000")
        conn.execute("PRAGMA temp_store = FILE")
        conn.execute("PRAGMA mmap_size = 0")
        total_start = time.time()
        try:
            retry(rebuild_summary_victim_demographics, conn, affected_years, label="rebuild summary_victim_demographics")
            retry(verify_summary_victim_demographics_unique, conn, affected_years, label="summary victim demographics duplicate check")
            retry(ensure_performance_indexes, conn, label="performance indexes")
            retry(refresh_planner_statistics, conn, label="planner statistics")
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()

        elapsed = time.time() - total_start
        log(f"summary_victim_demographics rebuild complete in {elapsed:.0f}s ({elapsed/60:.1f} min)")
        log("Restarting nibrs app...")
        result = subprocess.run(["pm2", "restart", "nibrs"], capture_output=True, text=True)
        if result.returncode == 0:
            log("  App restarted successfully")
        else:
            log(f"  pm2 restart failed: {result.stderr}")
        log("AUTO-UPDATE COMPLETE")
        return

    if args.rebuild_arrestee_demographics_years:
        affected_years = sorted(set(args.rebuild_arrestee_demographics_years))
        log(f"Maintenance mode: rebuilding summary_arrestee_demographics for years: {affected_years}")
        log("Stopping nibrs app for arrestee-demographics rebuild...")
        subprocess.run(["pm2", "stop", "nibrs"], capture_output=True, text=True)
        time.sleep(3)
        subprocess.run(["fuser", "-k", DB_PATH], capture_output=True, text=True)
        time.sleep(1)

        conn = sqlite3.connect(DB_PATH)
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA cache_size = -256000")
        conn.execute("PRAGMA temp_store = FILE")
        conn.execute("PRAGMA mmap_size = 0")
        total_start = time.time()
        try:
            retry(rebuild_summary_arrestee_demographics, conn, affected_years, label="rebuild summary_arrestee_demographics")
            retry(verify_summary_duplicate_keys, conn, affected_years, ['summary_arrestee_demographics'], label="summary arrestee demographics duplicate check")
            retry(ensure_performance_indexes, conn, label="performance indexes")
            retry(refresh_planner_statistics, conn, label="planner statistics")
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()

        elapsed = time.time() - total_start
        log(f"summary_arrestee_demographics rebuild complete in {elapsed:.0f}s ({elapsed/60:.1f} min)")
        log("Restarting nibrs app...")
        result = subprocess.run(["pm2", "restart", "nibrs"], capture_output=True, text=True)
        if result.returncode == 0:
            log("  App restarted successfully")
        else:
            log(f"  pm2 restart failed: {result.stderr}")
        log("AUTO-UPDATE COMPLETE")
        return

    if args.rebuild_carjacking_demographics_years:
        affected_years = sorted(set(args.rebuild_carjacking_demographics_years))
        log(f"Maintenance mode: rebuilding carjacking demographic summaries for years: {affected_years}")
        log("Stopping nibrs app for carjacking-demographics rebuild...")
        subprocess.run(["pm2", "stop", "nibrs"], capture_output=True, text=True)
        time.sleep(3)
        subprocess.run(["fuser", "-k", DB_PATH], capture_output=True, text=True)
        time.sleep(1)

        conn = sqlite3.connect(DB_PATH)
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA cache_size = -256000")
        conn.execute("PRAGMA temp_store = FILE")
        conn.execute("PRAGMA mmap_size = 0")
        total_start = time.time()
        try:
            retry(rebuild_summary_carjacking_demographics, conn, affected_years, label="rebuild carjacking demographics")
            retry(
                verify_summary_duplicate_keys,
                conn,
                affected_years,
                [
                    'summary_carjacking_victim_demographics',
                    'summary_carjacking_offender_demographics',
                    'summary_carjacking_arrestee_demographics',
                ],
                label="carjacking demographics duplicate check",
            )
            retry(ensure_performance_indexes, conn, label="performance indexes")
            retry(refresh_planner_statistics, conn, label="planner statistics")
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()

        elapsed = time.time() - total_start
        log(f"Carjacking demographic rebuild complete in {elapsed:.0f}s ({elapsed/60:.1f} min)")
        log("Restarting nibrs app...")
        result = subprocess.run(["pm2", "restart", "nibrs"], capture_output=True, text=True)
        if result.returncode == 0:
            log("  App restarted successfully")
        else:
            log(f"  pm2 restart failed: {result.stderr}")
        log("AUTO-UPDATE COMPLETE")
        return

    if args.rebuild_derived_years:
        affected_years = sorted(set(args.rebuild_derived_years))
        log(f"Maintenance mode: rebuilding derived summaries for years: {affected_years}")
        log("Stopping nibrs app for derived-summary rebuild...")
        subprocess.run(["pm2", "stop", "nibrs"], capture_output=True, text=True)
        time.sleep(3)
        subprocess.run(["fuser", "-k", DB_PATH], capture_output=True, text=True)
        time.sleep(1)

        conn = sqlite3.connect(DB_PATH)
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA cache_size = -256000")
        conn.execute("PRAGMA temp_store = FILE")
        conn.execute("PRAGMA mmap_size = 0")
        total_start = time.time()
        try:
            retry(rebuild_summaries, conn, affected_years, label="rebuild summaries")
            retry(verify_summary_duplicate_keys, conn, affected_years, label="summary duplicate-key check")
            retry(ensure_performance_indexes, conn, label="performance indexes")
            retry(refresh_planner_statistics, conn, label="planner statistics")
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()

        elapsed = time.time() - total_start
        log(f"Derived-summary rebuild complete in {elapsed:.0f}s ({elapsed/60:.1f} min)")
        log("Restarting nibrs app...")
        result = subprocess.run(["pm2", "restart", "nibrs"], capture_output=True, text=True)
        if result.returncode == 0:
            log("  App restarted successfully")
        else:
            log(f"  pm2 restart failed: {result.stderr}")
        log("AUTO-UPDATE COMPLETE")
        return

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
        publish_source_generation()
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

    # Backfill blank cities from the ORI's most recent prior-year nonblank city.
    # FBI 2025+ batch headers blanked ~600 agency cities (Menifee, Carmel, Pontiac...)
    # and re-addressed Boston PD as ROXBURY CROSSING, which broke every
    # city = '...' lookup for those agencies (July 5 audit, P05).
    for yr in affected_years:
        cur = conn.execute("""
            UPDATE agencies SET city = (
                SELECT p.city FROM agencies p
                WHERE p.ori = agencies.ori AND p.year < agencies.year AND p.city != ''
                ORDER BY p.year DESC LIMIT 1
            )
            WHERE year = ? AND city = ''
              AND EXISTS (SELECT 1 FROM agencies p
                          WHERE p.ori = agencies.ori AND p.year < agencies.year AND p.city != '')
        """, (yr,))
        log(f"  Backfilled {cur.rowcount} blank agency cities for {yr}")
    conn.execute("""
        UPDATE agencies SET city = 'BOSTON'
        WHERE ori = 'MA0130100' AND city = 'ROXBURY CROSSING'
    """)
    conn.commit()

    # Some CDE monthly files can contain exact duplicate segment rows. Remove
    # duplicates before summaries are materialized so counts cannot inflate.
    retry(dedupe_raw_duplicates, conn, affected_years, label="raw duplicate cleanup")

    # Rebuild summary tables for affected years only
    retry(rebuild_summaries, conn, affected_years, label="rebuild summaries")
    retry(verify_summary_duplicate_keys, conn, affected_years, label="summary duplicate-key check")
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
    retry(rebuild_dv_trends, conn, label="dv trends")
    retry(ensure_performance_indexes, conn, label="performance indexes")
    retry(refresh_planner_statistics, conn, label="planner statistics")

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
    publish_source_generation()

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
