"""
Import FBI CDE Hate Crime master files (1991–present) into SQLite.
Downloads each year, parses fixed-width ASCII, loads into hate_crime.db.

Usage: python3 -u scripts/import-hate-crime.py [--years 2023 2024] [--db path/to/hate_crime.db]
"""

import sqlite3
import requests
import zipfile
import io
import os
import time
import sys
import argparse
from datetime import datetime
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hate_crime_bias import decode as decode_bias  # noqa: E402

# Codes not in the FBI list seen during this run (reported at the end, never given a label).
UNLISTED_BIAS = Counter()

# ── Code Lookups ──────────────────────────────────────────────

STATES = {
    '50':'AK','01':'AL','03':'AR','54':'AS','02':'AZ','04':'CA','05':'CO',
    '06':'CT','52':'CZ','08':'DC','07':'DE','09':'FL','10':'GA','55':'GU',
    '51':'HI','14':'IA','11':'ID','12':'IL','13':'IN','15':'KS','16':'KY',
    '17':'LA','20':'MA','19':'MD','18':'ME','21':'MI','22':'MN','24':'MO',
    '23':'MS','25':'MT','32':'NC','33':'ND','26':'NE','28':'NH','29':'NJ',
    '30':'NM','27':'NV','31':'NY','34':'OH','35':'OK','36':'OR','37':'PA',
    '53':'PR','38':'RI','39':'SC','40':'SD','41':'TN','42':'TX','43':'UT',
    '62':'VI','45':'VA','44':'VT','46':'WA','48':'WI','47':'WV','49':'WY',
    '69':'MP','98':'FS',  # FBI CDE REF_STATE: Northern Mariana Islands; Federal agencies
}

# Bias codes: decoded by (code, data year) from the FBI list in scripts/hate_crime_bias.py (hotfix 2026-10-12;
# the table that was here mislabeled 23 codes, and grouped by keyword).

OFFENSE_CODES = {
    '09A':'Murder','09B':'Negligent Manslaughter','09C':'Justifiable Homicide',
    '100':'Kidnapping','11A':'Rape','11B':'Sodomy',
    '11C':'Sexual Assault With Object','11D':'Fondling',
    '120':'Robbery','13A':'Aggravated Assault','13B':'Simple Assault',
    '13C':'Intimidation','200':'Arson','210':'Extortion',
    '220':'Burglary','23A':'Pocket-picking','23B':'Purse-snatching',
    '23C':'Shoplifting','23D':'Theft From Building',
    '23E':'Theft From Coin Machine','23F':'Theft From Motor Vehicle',
    '23G':'Theft of Motor Vehicle Parts','23H':'All Other Larceny',
    '240':'Motor Vehicle Theft',
    '290':'Vandalism/Destruction of Property',
    '520':'Weapon Violations','720':'Animal Cruelty','90Z':'All Other',
    # Completed from the FBI CDE codebook (hate-crime offenses, scripts/fixtures/cde/NIBRS_OFFENSE_TYPE.csv).
    '23*':"Not Specified",
    '250':"Counterfeiting/Forgery",
    '26A':"False Pretenses/Swindle/Confidence Game",
    '26B':"Credit Card/Automated Teller Machine Fraud",
    '26C':"Impersonation",
    '26D':"Welfare Fraud",
    '26E':"Wire Fraud",
    '26F':"Identity Theft",
    '26G':"Hacking/Computer Invasion",
    '270':"Embezzlement",
    '280':"Stolen Property Offenses",
    '35A':"Drug/Narcotic Violations",
    '35B':"Drug Equipment Violations",
    '36A':"Incest",
    '36B':"Statutory Rape",
    '370':"Pornography/Obscene Material",
    '39A':"Betting/Wagering",
    '39B':"Operating/Promoting/Assisting Gambling",
    '39C':"Gambling Equipment Violation",
    '39D':"Sports Tampering",
    '40A':"Prostitution",
    '40B':"Assisting or Promoting Prostitution",
    '40C':"Purchasing Prostitution",
    '510':"Bribery",
    '64A':"Human Trafficking, Commercial Sex Acts",
    '64B':"Human Trafficking, Involuntary Servitude"
}

# Location codes: the FBI CDE codebook (scripts/fixtures/cde/NIBRS_LOCATION_TYPE.csv; CDE's own decoded hate crime
# dataset agrees on every code). The earlier table numbered the newer locations 26-50; CDE numbers them 37-58.
LOCATION_CODES = {
    '01':"Air/Bus/Train Terminal",
    '02':"Bank/Savings and Loan",
    '03':"Bar/Nightclub",
    '04':"Church/Synagogue/Temple/Mosque",
    '05':"Commercial/Office Building",
    '06':"Construction Site",
    '07':"Convenience Store",
    '08':"Department/Discount Store",
    '09':"Drug Store/Doctor's Office/Hospital",
    '10':"Field/Woods",
    '11':"Government/Public Building",
    '12':"Grocery/Supermarket",
    '13':"Highway/Road/Alley/Street/Sidewalk",
    '14':"Hotel/Motel/Etc.",
    '15':"Jail/Prison/Penitentiary/Corrections Facility",
    '16':"Lake/Waterway/Beach",
    '17':"Liquor Store",
    '18':"Parking/Drop Lot/Garage",
    '19':"Rental Storage Facility",
    '20':"Residence/Home",
    '21':"Restaurant",
    '22':"School/College",
    '23':"Service/Gas Station",
    '24':"Specialty Store",
    '25':"Other/Unknown",
    '37':"Abandoned/Condemned Structure",
    '38':"Amusement Park",
    '39':"Arena/Stadium/Fairgrounds/Coliseum",
    '40':"ATM Separate from Bank",
    '41':"Auto Dealership New/Used",
    '42':"Camp/Campground",
    '44':"Daycare Facility",
    '45':"Dock/Wharf/Freight/Modal Terminal",
    '46':"Farm Facility",
    '47':"Gambling Facility/Casino/Race Track",
    '48':"Industrial Site",
    '49':"Military Installation",
    '50':"Park/Playground",
    '51':"Rest Area",
    '52':"School-College/University",
    '53':"School-Elementary/Secondary",
    '54':"Shelter-Mission/Homeless",
    '55':"Shopping Mall",
    '56':"Tribal Lands",
    '57':"Community Center",
    '58':"Cyberspace",
}

RACE_CODES = {
    'W':'White','B':'Black','I':'American Indian/Alaska Native',
    'A':'Asian','P':'Native Hawaiian/Pacific Islander',
    'M':'Multiple','U':'Unknown',
}

ETH_CODES = {'H':'Hispanic or Latino','N':'Not Hispanic or Latino','U':'Unknown','M':'Multiple'}  # FBI CDE NIBRS_ETHNICITY

HATE_CRIME_DUPLICATE_COLUMNS = [
    'year', 'state', 'state_name', 'ori', 'agency_name', 'population',
    'pop_group', 'incident_number', 'incident_date', 'data_source',
    'quarter', 'total_individual_victims', 'total_offenders',
    'offender_race', 'offender_ethnicity', 'offense_group', 'offense_code',
    'offense_name', 'offense_victims', 'location', 'bias_code', 'bias_desc',
    'bias_category', 'victim_types', 'adult_victims', 'juvenile_victims',
    'adult_offenders', 'juvenile_offenders',
]

def safe(s, start, end):
    if start >= len(s):
        return ''
    return s[start:min(end, len(s))]

def num(s):
    s = s.strip()
    return int(s) if s and s.isdigit() else None

def download_year(year):
    """Download and extract hate crime master file for a year."""
    key = f"master_files/hate-crime/hate-crime-{year}.zip"
    resp = requests.get(f"https://cde.ucr.cjis.gov/LATEST/s3/signedurl?key={key}")
    data = resp.json()
    if not data:
        return None
    url = list(data.values())[0]
    r = requests.get(url)
    return master_text_for_year(zipfile.ZipFile(io.BytesIO(r.content)), year)


def master_text_for_year(z, year):
    """The member whose batch-header year is `year` (nested zips included); else the first member, as before."""
    texts = []
    for name in z.namelist():
        data = z.read(name)
        if name.lower().endswith('.zip'):
            inner = zipfile.ZipFile(io.BytesIO(data))
            texts += [inner.read(n).decode('latin1') for n in inner.namelist()]
        else:
            texts.append(data.decode('latin1'))
    for text in texts:
        for line in text.split('\n'):
            if line[:2] == 'BH':
                if safe(line, 225, 229).strip() == str(year):
                    return text
                break
    return texts[0] if texts else None

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

def assert_no_protected_years(years, protected_years, allow=False):
    blocked = sorted(set(years) & set(protected_years))
    if blocked and not allow:
        raise SystemExit(
            "Refusing to update protected year(s): "
            + ", ".join(str(y) for y in blocked)
            + ". Re-run with --allow-protected-years only if this is intentional."
        )

def default_protected_years(now=None):
    now = now or datetime.now()
    return str(now.year - 1) if now.month >= 6 else ""

def parse_year(text):
    """Parse one year of hate crime master file data. Returns (incidents, bh_counts)."""
    lines = text.split('\n')
    incidents = []
    bh_counts = {}  # state → count of BH records (total participating agencies)

    # Current agency context from BH records
    agency = {'name': '', 'pop': 0, 'group': '', 'div': '', 'year': '', 'state_name': ''}

    for line in lines:
        if len(line) < 10:
            continue
        rec_type = line[0:2]

        if rec_type == 'BH':
            sc = line[2:4]
            st = STATES.get(sc, sc)
            agency['state_name'] = safe(line, 71, 73).strip()
            agency['group'] = safe(line, 73, 75).strip()
            agency['div'] = line[75] if len(line) > 75 else ''
            agency['pop'] = num(safe(line, 105, 114)) or 0
            agency['year'] = safe(line, 225, 229).strip()
            # Agency name: prefer pos 237-267 (2020+), fall back to city name pos 41-71
            agency['name'] = safe(line, 237, 267).strip() or safe(line, 41, 71).strip()
            # Count total participating agencies by state
            bh_counts[st] = bh_counts.get(st, 0) + 1
            continue

        if rec_type == 'IR' and len(line) >= 41:
            sc = line[2:4]
            state = STATES.get(sc, sc)
            ori = line[4:13].strip()
            incident_num = line[13:25].strip()
            incident_date_raw = line[25:33].strip()
            # Format date
            if len(incident_date_raw) == 8 and incident_date_raw.isdigit():
                incident_date = f"{incident_date_raw[:4]}-{incident_date_raw[4:6]}-{incident_date_raw[6:]}"
            else:
                incident_date = incident_date_raw
            data_source = line[33] if len(line) > 33 else ''
            quarter = line[34] if len(line) > 34 else ''
            total_victims = num(safe(line, 35, 38))
            total_offenders = num(safe(line, 38, 40))
            offender_race_code = line[40] if len(line) > 40 else ''
            offender_race = RACE_CODES.get(offender_race_code, offender_race_code)

            year = agency['year'] or (incident_date[:4] if incident_date else '')

            # Parse up to 3 offense groups
            for g in range(3):
                b = 41 + g * 18
                if b + 3 > len(line):
                    break
                oc = safe(line, b, b + 3).strip()
                if not oc:
                    break
                offense_victims = num(safe(line, b + 3, b + 6))
                loc_code = safe(line, b + 6, b + 8).strip()
                bias_code = safe(line, b + 8, b + 10).strip()
                victim_types = safe(line, b + 10, b + 18).strip()

                offense_name = OFFENSE_CODES.get(oc, oc)
                location = LOCATION_CODES.get(loc_code, loc_code)
                bias_desc, bias_group, _unresolved, listed = decode_bias(bias_code, int(year) if year.isdigit() else None)
                if not listed:
                    UNLISTED_BIAS[bias_code] += 1

                # Age breakdowns (2020+ only)
                adult_victims = num(safe(line, 301, 304)) if len(line) >= 307 else None
                juvenile_victims = num(safe(line, 304, 307)) if len(line) >= 307 else None
                adult_offenders = num(safe(line, 307, 309)) if len(line) >= 311 else None
                juvenile_offenders = num(safe(line, 309, 311)) if len(line) >= 311 else None
                eth_code = line[311] if len(line) >= 312 else ''
                offender_ethnicity = ETH_CODES.get(eth_code, eth_code)

                incidents.append({
                    'year': int(year) if year.isdigit() else None,
                    'state': state,
                    'state_name': agency['state_name'],
                    'ori': ori,
                    'agency_name': agency['name'],
                    'population': agency['pop'],
                    'pop_group': agency['group'],
                    'incident_number': incident_num,
                    'incident_date': incident_date,
                    'data_source': data_source,
                    'quarter': quarter,
                    'total_individual_victims': total_victims,
                    'total_offenders': total_offenders,
                    'offender_race': offender_race,
                    'offender_ethnicity': offender_ethnicity or None,
                    'offense_group': g + 1,
                    'offense_code': oc,
                    'offense_name': offense_name,
                    'offense_victims': offense_victims,
                    'location': location,
                    'location_code': loc_code,
                    'bias_code': bias_code,
                    'bias_desc': bias_desc,
                    'bias_category': bias_group,
                    'victim_types': victim_types,
                    'adult_victims': adult_victims,
                    'juvenile_victims': juvenile_victims,
                    'adult_offenders': adult_offenders,
                    'juvenile_offenders': juvenile_offenders,
                })

    return incidents, bh_counts



def hate_crime_duplicate_count(conn, years):
    if not years:
        raise RuntimeError('Hate Crime duplicate verification requires explicit years')
    years = sorted(set(int(y) for y in years))
    year_list = ','.join(str(y) for y in years)
    cols = ', '.join(HATE_CRIME_DUPLICATE_COLUMNS)
    return conn.execute(f"""
        SELECT COUNT(*) AS duplicate_groups, COALESCE(SUM(extra_rows), 0) AS extra_rows
        FROM (
            SELECT COUNT(*) - 1 AS extra_rows
            FROM hate_crime_incidents
            WHERE year IN ({year_list})
            GROUP BY {cols}
            HAVING COUNT(*) > 1
        )
    """).fetchone()


def verify_hate_crime_duplicates(conn, years):
    years = sorted(set(int(y) for y in years))
    duplicate_groups, extra_rows = hate_crime_duplicate_count(conn, years)
    duplicate_groups = duplicate_groups or 0
    extra_rows = extra_rows or 0
    year_label = ','.join(str(y) for y in years)
    if duplicate_groups:
        raise RuntimeError(
            f"hate_crime_incidents has {duplicate_groups:,} exact duplicate groups "
            f"({extra_rows:,} extra rows) for {year_label}"
        )
    print(f"  hate_crime_incidents exact-duplicate check passed for {year_label}")


def dedupe_hate_crime_incidents(conn, years):
    years = sorted(set(int(y) for y in years))
    cols = ', '.join(HATE_CRIME_DUPLICATE_COLUMNS)
    total_deleted = 0
    for year in years:
        duplicate_groups, extra_rows = hate_crime_duplicate_count(conn, [year])
        duplicate_groups = duplicate_groups or 0
        extra_rows = extra_rows or 0
        if not duplicate_groups:
            print(f"  hate_crime_incidents [{year}]: no exact duplicates")
            continue
        print(f"  hate_crime_incidents [{year}]: removing {extra_rows:,} exact duplicate rows from {duplicate_groups:,} groups")
        cur = conn.execute(f"""
            DELETE FROM hate_crime_incidents
            WHERE year = ?
              AND rowid NOT IN (
                  SELECT MIN(rowid)
                  FROM hate_crime_incidents
                  WHERE year = ?
                  GROUP BY {cols}
              )
        """, (year, year))
        total_deleted += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        conn.commit()
    print(f"  Hate Crime exact duplicate cleanup removed {total_deleted:,} rows")
    verify_hate_crime_duplicates(conn, years)



def rebuild_hate_crime_derived_tables(conn, all_bh_counts=None, commit=True):
    """Rebuild the summary and participation tables. commit=False leaves the transaction to the caller (the
    re-decode validates before it commits)."""
    all_bh_counts = all_bh_counts or {}
    existing_total_agencies = {}
    if conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hate_crime_participation'").fetchone():
        existing_total_agencies = {
            (int(year), state): int(total or 0)
            for year, state, total in conn.execute(
                "SELECT year, state, total_agencies FROM hate_crime_participation"
            ).fetchall()
        }

    print("Building summary tables...")

    conn.execute("DROP TABLE IF EXISTS summary_hate_crime_bias_trend")
    conn.execute("""
    CREATE TABLE summary_hate_crime_bias_trend AS
    SELECT year, bias_category, bias_desc,
        COUNT(DISTINCT incident_number || ori) as incident_count,
        SUM(offense_victims) as victim_count
    FROM hate_crime_incidents
    GROUP BY year, bias_category, bias_desc
    """)
    conn.execute("CREATE INDEX idx_hcbt_year ON summary_hate_crime_bias_trend(year)")
    conn.execute("CREATE INDEX idx_hcbt_cat ON summary_hate_crime_bias_trend(bias_category, year)")

    conn.execute("DROP TABLE IF EXISTS summary_hate_crime_offense_trend")
    conn.execute("""
    CREATE TABLE summary_hate_crime_offense_trend AS
    SELECT year, offense_code, offense_name,
        COUNT(*) as offense_count,
        SUM(offense_victims) as victim_count
    FROM hate_crime_incidents
    GROUP BY year, offense_code, offense_name
    """)
    conn.execute("CREATE INDEX idx_hcot_year ON summary_hate_crime_offense_trend(year)")

    conn.execute("DROP TABLE IF EXISTS summary_hate_crime_state")
    conn.execute("""
    CREATE TABLE summary_hate_crime_state AS
    SELECT year, state, bias_category,
        COUNT(DISTINCT incident_number || ori) as incident_count,
        SUM(offense_victims) as victim_count
    FROM hate_crime_incidents
    GROUP BY year, state, bias_category
    """)
    conn.execute("CREATE INDEX idx_hcs_state_year ON summary_hate_crime_state(state, year)")

    conn.execute("DROP TABLE IF EXISTS summary_hate_crime_location")
    conn.execute("""
    CREATE TABLE summary_hate_crime_location AS
    SELECT year, location,
        COUNT(*) as offense_count,
        SUM(offense_victims) as victim_count
    FROM hate_crime_incidents
    GROUP BY year, location
    """)
    conn.execute("CREATE INDEX idx_hcl_year ON summary_hate_crime_location(year)")

    print("Building participation table...")
    conn.execute("DROP TABLE IF EXISTS hate_crime_participation")
    conn.execute("""
    CREATE TABLE hate_crime_participation (
        year INTEGER, state TEXT,
        total_agencies INTEGER,
        reporting_agencies INTEGER,
        total_incidents INTEGER,
        total_victims INTEGER
    )""")
    conn.execute("""
    INSERT INTO hate_crime_participation
    SELECT
        hci.year, hci.state,
        0 as total_agencies,
        COUNT(DISTINCT hci.ori) as reporting_agencies,
        COUNT(DISTINCT hci.incident_number || hci.ori) as total_incidents,
        SUM(hci.offense_victims) as total_victims
    FROM hate_crime_incidents hci
    GROUP BY hci.year, hci.state
    """)

    touched = set()
    rows = conn.execute("SELECT year, state FROM hate_crime_participation").fetchall()
    for year, state in rows:
        year = int(year)
        count = all_bh_counts.get(year, {}).get(state)
        if count is None:
            count = existing_total_agencies.get((year, state), 0)
        conn.execute(
            "UPDATE hate_crime_participation SET total_agencies = ? WHERE year = ? AND state = ?",
            (count, year, state),
        )
        touched.add((year, state))

    for year, state_counts in all_bh_counts.items():
        for state, count in state_counts.items():
            if (int(year), state) in touched:
                continue
            conn.execute("INSERT INTO hate_crime_participation VALUES (?, ?, ?, 0, 0, 0)", (year, state, count))
            touched.add((int(year), state))

    for (year, state), count in existing_total_agencies.items():
        if (year, state) in touched:
            continue
        conn.execute("INSERT INTO hate_crime_participation VALUES (?, ?, ?, 0, 0, 0)", (year, state, count))

    conn.execute("CREATE INDEX idx_hcp_year ON hate_crime_participation(year)")
    conn.execute("CREATE INDEX idx_hcp_state ON hate_crime_participation(state, year)")
    if commit:
        conn.commit()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--years', nargs='*', type=int, help='Specific years to import')
    parser.add_argument('--db', default='data/hate-crime/hate_crime.db', help='Output database path')
    parser.add_argument(
        '--protected-years',
        default=os.environ.get('PROTECTED_UPDATE_YEARS', default_protected_years()),
        help='Comma-separated years the importer must not delete/reimport. Defaults to the prior year from June through December.',
    )
    parser.add_argument(
        '--allow-protected-years',
        action='store_true',
        help='Allow importing protected years. Requires an explicit operator decision.',
    )
    parser.add_argument(
        '--verify-raw-duplicates',
        action='store_true',
        help='Read-only maintenance mode: verify exact duplicate hate_crime_incidents rows. Requires --years.',
    )
    parser.add_argument(
        '--dedupe-raw-years',
        nargs='+',
        type=int,
        help='Maintenance mode: delete exact duplicate hate_crime_incidents rows for existing years, then rebuild summaries.',
    )
    args = parser.parse_args()

    years = args.years or list(range(1991, 2026))
    protected_years = parse_year_csv(args.protected_years)
    if not args.verify_raw_duplicates:
        assert_no_protected_years(args.dedupe_raw_years or years, protected_years, args.allow_protected_years)
    db_path = args.db

    if args.verify_raw_duplicates and not args.years:
        raise SystemExit('--verify-raw-duplicates requires --years')

    if args.verify_raw_duplicates:
        print(f"Verifying Hate Crime duplicate rows for {args.years} in {db_path}")
    elif args.dedupe_raw_years:
        print(f"Deduping Hate Crime duplicate rows for {args.dedupe_raw_years} in {db_path}")
    else:
        print(f"Importing hate crime data for {len(years)} years into {db_path}")

    conn = sqlite3.connect(db_path)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA synchronous=OFF')

    # Create tables
    conn.execute("""
    CREATE TABLE IF NOT EXISTS hate_crime_incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        year INTEGER,
        state TEXT,
        state_name TEXT,
        ori TEXT,
        agency_name TEXT,
        population INTEGER,
        pop_group TEXT,
        incident_number TEXT,
        incident_date TEXT,
        data_source TEXT,
        quarter TEXT,
        total_individual_victims INTEGER,
        total_offenders INTEGER,
        offender_race TEXT,
        offender_ethnicity TEXT,
        offense_group INTEGER,
        offense_code TEXT,
        offense_name TEXT,
        offense_victims INTEGER,
        location TEXT,
        location_code TEXT,
        bias_code TEXT,
        bias_desc TEXT,
        bias_category TEXT,
        victim_types TEXT,
        adult_victims INTEGER,
        juvenile_victims INTEGER,
        adult_offenders INTEGER,
        juvenile_offenders INTEGER
    )""")
    # CDE codebook fix (2026-10-13): the raw location code is kept, so a label can always be re-derived from it.
    if 'location_code' not in [r[1] for r in conn.execute("PRAGMA table_info(hate_crime_incidents)")]:
        conn.execute("ALTER TABLE hate_crime_incidents ADD COLUMN location_code TEXT")
    conn.commit()

    if args.verify_raw_duplicates:
        verify_hate_crime_duplicates(conn, args.years)
        conn.close()
        return

    if args.dedupe_raw_years:
        dedupe_hate_crime_incidents(conn, args.dedupe_raw_years)
        rebuild_hate_crime_derived_tables(conn)
        conn.close()
        return

    insert = conn.prepare if hasattr(conn, 'prepare') else None
    insert_sql = """INSERT INTO hate_crime_incidents (
        year, state, state_name, ori, agency_name, population, pop_group,
        incident_number, incident_date, data_source, quarter,
        total_individual_victims, total_offenders, offender_race, offender_ethnicity,
        offense_group, offense_code, offense_name, offense_victims,
        location, bias_code, bias_desc, bias_category, victim_types,
        adult_victims, juvenile_victims, adult_offenders, juvenile_offenders, location_code
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"""

    total_incidents = 0
    all_bh_counts = {}  # year -> {state -> count}
    imported_years = []
    t0 = time.time()

    for year in years:
        yt = time.time()
        print(f"  {year}: downloading...", end=' ', flush=True)

        text = download_year(year)
        if text is None:
            print("NOT AVAILABLE")
            continue

        # Delete existing data for this year
        conn.execute("DELETE FROM hate_crime_incidents WHERE year = ?", (year,))

        incidents, bh_counts = parse_year(text)
        all_bh_counts[year] = bh_counts

        # Batch insert
        rows = [(
            i['year'], i['state'], i['state_name'], i['ori'], i['agency_name'],
            i['population'], i['pop_group'], i['incident_number'], i['incident_date'],
            i['data_source'], i['quarter'], i['total_individual_victims'],
            i['total_offenders'], i['offender_race'], i['offender_ethnicity'],
            i['offense_group'], i['offense_code'], i['offense_name'],
            i['offense_victims'], i['location'], i['bias_code'], i['bias_desc'],
            i['bias_category'], i['victim_types'],
            i['adult_victims'], i['juvenile_victims'],
            i['adult_offenders'], i['juvenile_offenders'], i['location_code'],
        ) for i in incidents]

        conn.executemany(insert_sql, rows)
        conn.commit()

        elapsed = time.time() - yt
        print(f"{len(incidents)} offense-records in {elapsed:.1f}s")
        total_incidents += len(incidents)
        imported_years.append(year)

    if imported_years:
        dedupe_hate_crime_incidents(conn, imported_years)

    # Create indexes
    print("\nCreating indexes...")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_hc_year ON hate_crime_incidents(year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_hc_state_year ON hate_crime_incidents(state, year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_hc_bias ON hate_crime_incidents(bias_category, year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_hc_offense ON hate_crime_incidents(offense_code, year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_hc_ori ON hate_crime_incidents(ori, year)")
    conn.commit()

    rebuild_hate_crime_derived_tables(conn, all_bh_counts)

    # Caveats table — baked-in documentation for the model
    conn.execute("DROP TABLE IF EXISTS hate_crime_caveats")
    conn.execute("""
    CREATE TABLE hate_crime_caveats (
        id INTEGER PRIMARY KEY,
        caveat_type TEXT,
        description TEXT
    )""")
    caveats = [
        ('reporting', 'Hate crime reporting is voluntary. Many agencies report zero hate crimes — this reflects non-reporting, NOT an absence of hate crimes. Zero does not mean zero.'),
        ('participation', 'The number of agencies reporting hate crimes has grown from ~2,700 in 1991 to ~15,000+ today. Increases in hate crime counts over time partly reflect increased reporting, not necessarily increased hate crime activity.'),
        ('definitions', 'Bias categories were expanded: gender and gender identity added in 2013; Arab, Hindu, Sikh, and other religious categories added in 2015; age breakdowns added in 2020. Comparing across these boundary years can be misleading.'),
        ('undercounting', 'The FBI acknowledges that hate crimes are significantly undercounted. The Bureau of Justice Statistics estimates actual hate crime victimization is 2-4x higher than what appears in FBI data.'),
        ('agency_variation', 'Reporting quality varies enormously by agency. Some agencies have robust hate crime identification training; others classify very few incidents as hate crimes regardless of circumstances.'),
        ('data_source', 'Incidents come from two systems: NIBRS (more detailed) and SRS (legacy). The mix has shifted toward NIBRS over time, which may affect what gets classified as a hate crime.'),
    ]
    conn.executemany("INSERT INTO hate_crime_caveats (caveat_type, description) VALUES (?, ?)", caveats)
    conn.commit()

    # Verify
    total = conn.execute("SELECT COUNT(*) FROM hate_crime_incidents").fetchone()[0]
    years_range = conn.execute("SELECT MIN(year), MAX(year) FROM hate_crime_incidents").fetchone()
    bias_cats = conn.execute("SELECT bias_category, COUNT(*) FROM hate_crime_incidents GROUP BY bias_category ORDER BY COUNT(*) DESC").fetchall()

    elapsed = time.time() - t0
    print(f"\nDone! {total:,} offense-records loaded, {years_range[0]}-{years_range[1]}")
    print(f"Total time: {elapsed/60:.1f} min")
    print("\nBias category breakdown:")
    for cat, cnt in bias_cats:
        print(f"  {cat}: {cnt:,}")
    if UNLISTED_BIAS:
        print("\nWARNING: bias codes not in the FBI list (stored as themselves, group Other): "
              + ", ".join(f"{c or '(blank)'} x{n}" for c, n in sorted(UNLISTED_BIAS.items())))

    conn.close()

if __name__ == '__main__':
    main()
