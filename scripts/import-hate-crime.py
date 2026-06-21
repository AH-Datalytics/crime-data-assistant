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
}

BIAS_CODES = {
    '11':'Anti-White','12':'Anti-Black or African American',
    '13':'Anti-American Indian or Alaska Native','14':'Anti-Asian',
    '15':'Anti-Native Hawaiian or Other Pacific Islander',
    '16':'Anti-Multiple Races, Group','19':'Anti-Arab',
    '21':'Anti-Jewish','22':'Anti-Catholic','23':'Anti-Protestant',
    '24':'Anti-Islamic (Muslim)','25':'Anti-Other Religion',
    '26':'Anti-Multiple Religions, Group','27':'Anti-Atheism/Agnosticism',
    '28':'Anti-Arab','29':'Anti-Sikh',
    '31':'Anti-Gay (Male)','32':'Anti-Lesbian',
    '33':'Anti-LGBT (Mixed Group)','34':'Anti-Heterosexual',
    '35':'Anti-Bisexual',
    '41':'Anti-Physical Disability','42':'Anti-Mental Disability',
    '43':'Anti-Male','44':'Anti-Female',
    '45':'Anti-Gender Non-Conforming',
    '51':'Anti-Male','52':'Anti-Female',
    '61':'Anti-Transgender','62':'Anti-Gender Non-Conforming',
    '71':'Anti-Sikh','72':'Anti-Hindu','73':'Anti-Mormon',
    '74':"Anti-Jehovah's Witness",'75':'Anti-Other Christian',
    '76':'Anti-Eastern Orthodox','81':'Anti-Buddhist',
}

# Bias categories for summary grouping
def bias_category(bias_desc):
    if not bias_desc:
        return 'Unknown'
    b = bias_desc.lower()
    if 'race' in b or 'white' in b or 'black' in b or 'indian' in b or 'asian' in b or 'pacific' in b or 'arab' in b or 'multiple races' in b:
        return 'Race/Ethnicity/Ancestry'
    if 'jewish' in b or 'catholic' in b or 'protestant' in b or 'islamic' in b or 'muslim' in b or 'religion' in b or 'atheism' in b or 'sikh' in b or 'hindu' in b or 'mormon' in b or 'jehovah' in b or 'christian' in b or 'orthodox' in b or 'buddhist' in b:
        return 'Religion'
    if 'gay' in b or 'lesbian' in b or 'lgbt' in b or 'heterosexual' in b or 'bisexual' in b:
        return 'Sexual Orientation'
    if 'disability' in b:
        return 'Disability'
    if 'transgender' in b or 'gender non-conforming' in b:
        return 'Gender Identity'
    if 'male' in b or 'female' in b:
        return 'Gender'
    return 'Other'

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
}

LOCATION_CODES = {
    '01':'Air/Bus/Train Terminal','02':'Bank','03':'Bar/Nightclub',
    '04':'Church/Synagogue/Temple/Mosque','05':'Commercial/Office Building',
    '06':'Construction Site','07':'Convenience Store',
    '08':'Department/Discount Store','09':'Drug Store/Doctor/Hospital',
    '10':'Field/Woods','11':'Government/Public Building',
    '12':'Grocery/Supermarket','13':'Highway/Road/Street',
    '14':'Hotel/Motel','15':'Jail/Prison','16':'Lake/Waterway',
    '17':'Liquor Store','18':'Parking Lot/Garage',
    '19':'Rental Storage','20':'Residence/Home','21':'Restaurant',
    '22':'School/College','23':'Service/Gas Station',
    '24':'Specialty Store','25':'Other/Unknown',
    '26':'Amusement Park','27':'Arena/Stadium','28':'ATM',
    '29':'Auto Dealership','30':'Camp/Campground',
    '32':'Daycare Facility','33':'Dock/Wharf','34':'Farm',
    '35':'Gambling Facility','36':'Industrial Site',
    '37':'Military Installation','38':'Park/Playground',
    '39':'Rest Area','40':'School-Elementary/Secondary',
    '41':'School-College/University','42':'Shelter/Mission/Homeless',
    '43':'Shopping Mall','44':'Tribal Lands',
    '46':'Community Center','48':'Abandoned Structure','50':'Cyberspace',
}

RACE_CODES = {
    'W':'White','B':'Black','I':'American Indian/Alaska Native',
    'A':'Asian','P':'Native Hawaiian/Pacific Islander',
    'M':'Multiple','U':'Unknown',
}

ETH_CODES = {'H':'Hispanic or Latino','N':'Not Hispanic or Latino','U':'Unknown'}

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
    z = zipfile.ZipFile(io.BytesIO(r.content))
    name = z.namelist()[0]
    return z.read(name).decode('latin1')

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
                bias_desc = BIAS_CODES.get(bias_code, bias_code)

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
                    'bias_code': bias_code,
                    'bias_desc': bias_desc,
                    'bias_category': bias_category(bias_desc),
                    'victim_types': victim_types,
                    'adult_victims': adult_victims,
                    'juvenile_victims': juvenile_victims,
                    'adult_offenders': adult_offenders,
                    'juvenile_offenders': juvenile_offenders,
                })

    return incidents, bh_counts


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
    args = parser.parse_args()

    years = args.years or list(range(1991, 2026))
    protected_years = parse_year_csv(args.protected_years)
    assert_no_protected_years(years, protected_years, args.allow_protected_years)
    db_path = args.db

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
        bias_code TEXT,
        bias_desc TEXT,
        bias_category TEXT,
        victim_types TEXT,
        adult_victims INTEGER,
        juvenile_victims INTEGER,
        adult_offenders INTEGER,
        juvenile_offenders INTEGER
    )""")
    conn.commit()

    insert = conn.prepare if hasattr(conn, 'prepare') else None
    insert_sql = """INSERT INTO hate_crime_incidents (
        year, state, state_name, ori, agency_name, population, pop_group,
        incident_number, incident_date, data_source, quarter,
        total_individual_victims, total_offenders, offender_race, offender_ethnicity,
        offense_group, offense_code, offense_name, offense_victims,
        location, bias_code, bias_desc, bias_category, victim_types,
        adult_victims, juvenile_victims, adult_offenders, juvenile_offenders
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"""

    total_incidents = 0
    all_bh_counts = {}  # year → {state → count}
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
            i['adult_offenders'], i['juvenile_offenders'],
        ) for i in incidents]

        conn.executemany(insert_sql, rows)
        conn.commit()

        elapsed = time.time() - yt
        print(f"{len(incidents)} offense-records in {elapsed:.1f}s")
        total_incidents += len(incidents)

    # Create indexes
    print("\nCreating indexes...")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_hc_year ON hate_crime_incidents(year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_hc_state_year ON hate_crime_incidents(state, year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_hc_bias ON hate_crime_incidents(bias_category, year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_hc_offense ON hate_crime_incidents(offense_code, year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_hc_ori ON hate_crime_incidents(ori, year)")
    conn.commit()

    # Build summary tables
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

    conn.commit()

    # Build participation table (BH counts = total participating, IR = those with incidents)
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
    # First get incident counts from the data
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
    # Update total_agencies from BH counts (all participating, including zero-reporters)
    for year, state_counts in all_bh_counts.items():
        for state, count in state_counts.items():
            existing = conn.execute("SELECT rowid FROM hate_crime_participation WHERE year = ? AND state = ?", (year, state)).fetchone()
            if existing:
                conn.execute("UPDATE hate_crime_participation SET total_agencies = ? WHERE year = ? AND state = ?", (count, year, state))
            else:
                # State participated but reported zero incidents
                conn.execute("INSERT INTO hate_crime_participation VALUES (?, ?, ?, 0, 0, 0)", (year, state, count))
    conn.execute("CREATE INDEX idx_hcp_year ON hate_crime_participation(year)")
    conn.execute("CREATE INDEX idx_hcp_state ON hate_crime_participation(state, year)")

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

    conn.close()

if __name__ == '__main__':
    main()
