"""
Import historical crime data into crime_data.db.

Sources (all from "Crime and Staffing - HO Ready/final files"):
  - geographies.csv                  → historical_agency
  - populations.csv                  → historical_agency_population
  - historical_crime_1930_2024.csv   → historical_agency_crime
  - historical_clearance_1960_2024.csv → historical_agency_clearance
  - historical_staffing_1930_2024.csv  → historical_staffing
  - State_National_Historical.xlsx     → historical_state_national (unchanged)
"""

import sqlite3
import pandas as pd
import numpy as np

DB_PATH = r"C:\Users\jeffm\crime-data-assistant\crime_data.db"
DATA_DIR = r"C:\OneDrive\OneDrive - ahdatalytics.com\Clients\Real Time Crime Index\Open Source Data\Historical Data - 1930-1959"
FINAL_DIR = f"{DATA_DIR}/Crime and Staffing - HO Ready/final files"


def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # ── 1. historical_agency ──────────────────────────────────────────────
    cur.execute("DROP TABLE IF EXISTS historical_agency")
    cur.execute("""
        CREATE TABLE historical_agency (
            ori       TEXT PRIMARY KEY,
            agency    TEXT,
            state     TEXT,
            type      TEXT,
            region    TEXT,
            division  TEXT,
            size      TEXT,
            latitude  REAL,
            longitude REAL,
            start     TEXT,
            end       TEXT
        )
    """)

    df_agency = pd.read_csv(f"{FINAL_DIR}/geographies.csv")
    df_agency = df_agency.rename(columns={
        "id": "ori",
        "name": "agency",
    })
    cols = ["ori", "agency", "state", "type", "region", "division", "size", "latitude", "longitude", "start", "end"]
    df_agency = df_agency[cols]
    df_agency = df_agency.where(df_agency.notna(), None)

    # Standardize county/parish names
    import re
    def standardize_county_name(row):
        if row["type"] != "county" or row["agency"] is None:
            return row["agency"]
        name = row["agency"]
        state = row["state"]
        suffix = "Parish" if state == "la" else "County"
        # Already has the correct suffix as a standalone name (e.g., "Baltimore County")
        if name == f"{name.split(' County')[0]} County" and not re.search(r'(Police|Sheriff|Bureau)', name):
            return name.split(" County")[0] + f" {suffix}"
        if name == f"{name.split(' Parish')[0]} Parish" and not re.search(r'(Police|Sheriff|Bureau)', name):
            return name
        # Strip "County Police Department", "County Bureau of Police", "Sheriff's Office", "Police Department"
        stripped = re.sub(r'\s*(County\s+)?(Police\s+Department|Bureau\s+of\s+Police|Sheriff\'?s?\s+Office)\s*$', '', name, flags=re.IGNORECASE).strip()
        # Strip trailing "County" or "Parish" if present (we'll re-add it)
        stripped = re.sub(r'\s+(County|Parish)\s*$', '', stripped, flags=re.IGNORECASE).strip()
        if stripped:
            return f"{stripped} {suffix}"
        return name
    df_agency["agency"] = df_agency.apply(standardize_county_name, axis=1)

    cur.executemany(
        f"INSERT OR REPLACE INTO historical_agency ({', '.join(cols)}) VALUES ({', '.join(['?'] * len(cols))})",
        df_agency.values.tolist(),
    )
    count = cur.execute("SELECT COUNT(*) FROM historical_agency").fetchone()[0]
    print(f"historical_agency: {count:,} rows")

    # Show type breakdown
    for row in cur.execute("SELECT type, COUNT(*) FROM historical_agency GROUP BY type ORDER BY COUNT(*) DESC").fetchall():
        print(f"  {row[0]}: {row[1]:,}")

    # ── 2. historical_agency_population ───────────────────────────────────
    cur.execute("DROP TABLE IF EXISTS historical_agency_population")
    cur.execute("""
        CREATE TABLE historical_agency_population (
            ori        TEXT,
            year       INTEGER,
            population INTEGER,
            PRIMARY KEY (ori, year)
        )
    """)

    df_pop = pd.read_csv(f"{FINAL_DIR}/populations.csv")
    df_pop = df_pop.rename(columns={"id": "ori"})
    df_pop = df_pop[["ori", "year", "population"]]
    df_pop = df_pop.replace("", np.nan)
    df_pop = df_pop.where(df_pop.notna(), None)

    cur.executemany(
        "INSERT OR REPLACE INTO historical_agency_population (ori, year, population) VALUES (?, ?, ?)",
        df_pop.values.tolist(),
    )
    count = cur.execute("SELECT COUNT(*) FROM historical_agency_population").fetchone()[0]
    print(f"historical_agency_population: {count:,} rows")

    # ── 3. historical_agency_crime ────────────────────────────────────────
    cur.execute("DROP TABLE IF EXISTS historical_agency_crime")
    cur.execute("""
        CREATE TABLE historical_agency_crime (
            ori                  TEXT,
            year                 INTEGER,
            population           INTEGER,
            violent              INTEGER,
            murder               INTEGER,
            rape                 INTEGER,
            robbery              INTEGER,
            assault              INTEGER,
            property             INTEGER,
            burglary             INTEGER,
            theft                INTEGER,
            motor_vehicle_theft  INTEGER,
            PRIMARY KEY (ori, year)
        )
    """)

    df_crime = pd.read_csv(f"{FINAL_DIR}/historical_crime_1930_2024.csv")
    col_map = {
        "id": "ori",
        "year": "year",
        "population": "population",
        "violent_total": "violent",
        "murder_total": "murder",
        "rape_total": "rape",
        "robbery_total": "robbery",
        "assault_total": "assault",
        "property_total": "property",
        "burglary_total": "burglary",
        "theft_total": "theft",
        "motor_total": "motor_vehicle_theft",
    }
    df_crime = df_crime.rename(columns=col_map)[list(col_map.values())]
    df_crime = df_crime.replace("", np.nan)
    df_crime = df_crime.where(df_crime.notna(), None)

    # NULL out rows where all crime columns are 0 (non-reporting)
    crime_cols = ["violent", "murder", "rape", "robbery", "assault", "property", "burglary", "theft", "motor_vehicle_theft"]
    all_zero = (df_crime[crime_cols] == 0).all(axis=1)
    df_crime.loc[all_zero, crime_cols] = None
    print(f"  {all_zero.sum():,} rows with all-zero crime data -> NULLed (non-reporting agencies)")

    insert_cols = list(col_map.values())
    cur.executemany(
        f"INSERT OR REPLACE INTO historical_agency_crime ({', '.join(insert_cols)}) VALUES ({', '.join(['?'] * len(insert_cols))})",
        df_crime.values.tolist(),
    )
    count = cur.execute("SELECT COUNT(*) FROM historical_agency_crime").fetchone()[0]
    print(f"historical_agency_crime: {count:,} rows")

    # ── 4. historical_agency_clearance ────────────────────────────────────
    cur.execute("DROP TABLE IF EXISTS historical_agency_clearance")
    cur.execute("""
        CREATE TABLE historical_agency_clearance (
            ori                    TEXT,
            year                   INTEGER,
            murder_clr             REAL,
            rape_clr               REAL,
            robbery_clr            REAL,
            assault_clr            REAL,
            burglary_clr           REAL,
            theft_clr              REAL,
            motor_vehicle_theft_clr REAL,
            violent_clr            REAL,
            property_clr           REAL,
            PRIMARY KEY (ori, year)
        )
    """)

    df_clr = pd.read_csv(f"{FINAL_DIR}/historical_clearance_1960_2024.csv")
    df_clr = df_clr.rename(columns={"id": "ori"})

    # Compute clearance percentages from all/cleared pairs
    crime_pairs = [
        ("murder", "murder_all_total", "murder_cleared_total"),
        ("rape", "rape_all_total", "rape_cleared_total"),
        ("robbery", "robbery_all_total", "robbery_cleared_total"),
        ("assault", "assault_all_total", "assault_cleared_total"),
        ("burglary", "burglary_all_total", "burglary_cleared_total"),
        ("theft", "theft_all_total", "theft_cleared_total"),
        ("motor_vehicle_theft", "motor_all_total", "motor_cleared_total"),
        ("violent", "violent_all_total", "violent_cleared_total"),
        ("property", "property_all_total", "property_cleared_total"),
    ]

    for name, all_col, cleared_col in crime_pairs:
        clr_col = f"{name}_clr"
        total = pd.to_numeric(df_clr[all_col], errors="coerce")
        cleared = pd.to_numeric(df_clr[cleared_col], errors="coerce")
        # Clearance rate = (cleared / total) * 100, NULL if total is 0 or missing
        rate = np.where(total > 0, (cleared / total) * 100.0, np.nan)
        df_clr[clr_col] = rate

    # Treat 0% clearance as missing (non-reporting) — same convention as before
    clr_cols = [f"{p[0]}_clr" for p in crime_pairs]
    all_zero_clr = True
    for c in clr_cols:
        all_zero_clr = all_zero_clr & ((df_clr[c] == 0) | df_clr[c].isna())
    df_clr.loc[all_zero_clr, clr_cols] = np.nan

    out_cols = ["ori", "year"] + clr_cols
    df_clr_out = df_clr[out_cols].copy()
    df_clr_out = df_clr_out.where(df_clr_out.notna(), None)

    # Round to 1 decimal
    for c in clr_cols:
        df_clr_out[c] = df_clr_out[c].apply(lambda x: round(x, 1) if x is not None else None)

    cur.executemany(
        f"INSERT OR REPLACE INTO historical_agency_clearance ({', '.join(out_cols)}) VALUES ({', '.join(['?'] * len(out_cols))})",
        df_clr_out.values.tolist(),
    )
    count = cur.execute("SELECT COUNT(*) FROM historical_agency_clearance").fetchone()[0]
    print(f"historical_agency_clearance: {count:,} rows")

    # ── 5. historical_staffing ────────────────────────────────────────────
    cur.execute("DROP TABLE IF EXISTS historical_staffing")
    cur.execute("""
        CREATE TABLE historical_staffing (
            ori            TEXT,
            year           INTEGER,
            all_total      INTEGER,
            officer_total  INTEGER,
            civilian_total INTEGER,
            PRIMARY KEY (ori, year)
        )
    """)

    df_staff = pd.read_csv(f"{FINAL_DIR}/historical_staffing_1930_2024.csv")
    df_staff = df_staff.rename(columns={"id": "ori"})
    staff_cols = ["ori", "year", "all_total", "officer_total", "civilian_total"]
    df_staff = df_staff[staff_cols]
    df_staff = df_staff.replace("", np.nan)
    df_staff = df_staff.where(df_staff.notna(), None)

    cur.executemany(
        f"INSERT OR REPLACE INTO historical_staffing ({', '.join(staff_cols)}) VALUES ({', '.join(['?'] * len(staff_cols))})",
        df_staff.values.tolist(),
    )
    count = cur.execute("SELECT COUNT(*) FROM historical_staffing").fetchone()[0]
    print(f"historical_staffing: {count:,} rows")

    # ── 6. historical_state_national (unchanged — from Excel) ─────────────
    cur.execute("DROP TABLE IF EXISTS historical_state_national")
    cur.execute("""
        CREATE TABLE historical_state_national (
            state                  TEXT,
            year                   INTEGER,
            population             INTEGER,
            murder                 INTEGER,
            rape                   INTEGER,
            robbery                INTEGER,
            aggravated_assault     INTEGER,
            burglary               INTEGER,
            theft                  INTEGER,
            auto_theft             INTEGER,
            total_offenses         INTEGER,
            murder_rate            REAL,
            rape_rate              REAL,
            robbery_rate           REAL,
            aggravated_assault_rate REAL,
            burglary_rate          REAL,
            theft_rate             REAL,
            auto_theft_rate        REAL,
            total_offenses_rate    REAL,
            PRIMARY KEY (state, year)
        )
    """)

    df_state = pd.read_excel(f"{DATA_DIR}/State_National_Historical.xlsx")
    df_state = df_state.drop(columns=["table", "file"], errors="ignore")
    df_state = df_state.rename(columns={
        "murder_and_nonnegligent_manslaughter": "murder",
        "murder_and_nonnegligent_manslaughter_rate": "murder_rate",
    })
    df_state = df_state.replace("", np.nan)

    def sanitize(val):
        if pd.isna(val) if not isinstance(val, str) else False:
            return None
        if hasattr(val, 'total_seconds'):
            return None
        if hasattr(val, 'timestamp'):
            return None
        return val

    for col in df_state.columns:
        df_state[col] = df_state[col].apply(sanitize)
    df_state = df_state.where(df_state.notna(), None)

    dest_cols = [
        "state", "year", "population", "murder", "rape", "robbery",
        "aggravated_assault", "burglary", "theft", "auto_theft",
        "total_offenses", "murder_rate", "rape_rate", "robbery_rate",
        "aggravated_assault_rate", "burglary_rate", "theft_rate",
        "auto_theft_rate", "total_offenses_rate",
    ]
    df_state = df_state[dest_cols]

    cur.executemany(
        f"INSERT OR REPLACE INTO historical_state_national ({', '.join(dest_cols)}) VALUES ({', '.join(['?'] * len(dest_cols))})",
        df_state.values.tolist(),
    )
    count = cur.execute("SELECT COUNT(*) FROM historical_state_national").fetchone()[0]
    print(f"historical_state_national: {count:,} rows")

    # ── 7. Indexes ────────────────────────────────────────────────────────
    cur.execute("CREATE INDEX IF NOT EXISTS idx_hac_ori_year ON historical_agency_crime (ori, year)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_hac_year ON historical_agency_crime (year)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_hap_ori_year ON historical_agency_population (ori, year)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_hap_year ON historical_agency_population (year)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_hsn_state_year ON historical_state_national (state, year)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_hsn_year ON historical_state_national (year)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_hclr_ori_year ON historical_agency_clearance (ori, year)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_hclr_year ON historical_agency_clearance (year)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_hstaff_ori_year ON historical_staffing (ori, year)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_hstaff_year ON historical_staffing (year)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ha_type ON historical_agency (type)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ha_state ON historical_agency (state)")

    conn.commit()
    conn.close()
    print("\nDone.")


if __name__ == "__main__":
    main()
