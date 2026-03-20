"""
Import historical crime data into crime_data.db.

Sources:
  - agency_reference.csv        → historical_agency
  - historical_crime_1930_2024.csv → historical_agency_crime
  - State_National_Historical.xlsx → historical_state_national
"""

import sqlite3
import pandas as pd
import numpy as np

DB_PATH = r"C:\Users\jeffm\crime-data-assistant\crime_data.db"
DATA_DIR = r"C:\OneDrive\OneDrive - ahdatalytics.com\Clients\Real Time Crime Index\Open Source Data\Historical Data - 1930-1959"


def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # ── 1. historical_agency ──────────────────────────────────────────────
    cur.execute("DROP TABLE IF EXISTS historical_agency")
    cur.execute("""
        CREATE TABLE historical_agency (
            ori   TEXT PRIMARY KEY,
            agency TEXT,
            state  TEXT,
            type   TEXT
        )
    """)

    df_agency = pd.read_csv(f"{DATA_DIR}/agency_reference.csv")
    df_agency = df_agency.rename(columns={
        "ori": "ori",
        "pub_agency_name": "agency",
        "state_abbr": "state",
        "agency_type_name": "type",
    })[["ori", "agency", "state", "type"]]

    df_agency = df_agency.where(df_agency.notna(), None)
    cur.executemany(
        "INSERT OR REPLACE INTO historical_agency (ori, agency, state, type) VALUES (?, ?, ?, ?)",
        df_agency.values.tolist(),
    )
    print(f"historical_agency: {cur.execute('SELECT COUNT(*) FROM historical_agency').fetchone()[0]:,} rows")

    # ── 2. historical_agency_crime ────────────────────────────────────────
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

    df_crime = pd.read_csv(f"{DATA_DIR}/historical_crime_1930_2024.csv")
    # Keep only the columns we need (skip _change columns)
    col_map = {
        "id": "ori",
        "year": "year",
        "size": "population",
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

    # Convert empty strings to NaN, then NaN to None
    df_crime = df_crime.replace("", np.nan)
    df_crime = df_crime.where(df_crime.notna(), None)

    insert_cols = list(col_map.values())
    placeholders = ", ".join(["?"] * len(insert_cols))
    cur.executemany(
        f"INSERT OR REPLACE INTO historical_agency_crime ({', '.join(insert_cols)}) VALUES ({placeholders})",
        df_crime.values.tolist(),
    )
    print(f"historical_agency_crime: {cur.execute('SELECT COUNT(*) FROM historical_agency_crime').fetchone()[0]:,} rows")

    # ── 3. historical_state_national ──────────────────────────────────────
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
    # Drop the 'table' and 'file' columns
    df_state = df_state.drop(columns=["table", "file"], errors="ignore")
    # Rename murder_and_nonnegligent_manslaughter → murder (count and rate)
    df_state = df_state.rename(columns={
        "murder_and_nonnegligent_manslaughter": "murder",
        "murder_and_nonnegligent_manslaughter_rate": "murder_rate",
    })

    df_state = df_state.replace("", np.nan)

    # Convert any non-standard types (timedelta, Timestamp, etc.) to native Python types
    def sanitize(val):
        if pd.isna(val) if not isinstance(val, str) else False:
            return None
        if hasattr(val, 'total_seconds'):
            return None  # timedelta — likely bad data
        if hasattr(val, 'timestamp'):
            return None  # Timestamp — likely bad data
        return val

    for col in df_state.columns:
        df_state[col] = df_state[col].apply(sanitize)
    df_state = df_state.where(df_state.notna(), None)

    state_cols = [
        "state", "year", "population", "murder", "rape", "robbery",
        "aggravated_assault", "burglary", "theft", "auto_theft",
        "total_offenses", "total_offenses_rate", "murder_rate", "rape_rate",
        "robbery_rate", "aggravated_assault_rate", "burglary_rate",
        "theft_rate", "auto_theft_rate",
    ]
    df_state = df_state[state_cols]

    placeholders = ", ".join(["?"] * len(state_cols))
    # Reorder to match CREATE TABLE column order
    dest_cols = [
        "state", "year", "population", "murder", "rape", "robbery",
        "aggravated_assault", "burglary", "theft", "auto_theft",
        "total_offenses", "murder_rate", "rape_rate", "robbery_rate",
        "aggravated_assault_rate", "burglary_rate", "theft_rate",
        "auto_theft_rate", "total_offenses_rate",
    ]
    df_state = df_state[dest_cols]

    placeholders = ", ".join(["?"] * len(dest_cols))
    cur.executemany(
        f"INSERT OR REPLACE INTO historical_state_national ({', '.join(dest_cols)}) VALUES ({placeholders})",
        df_state.values.tolist(),
    )
    print(f"historical_state_national: {cur.execute('SELECT COUNT(*) FROM historical_state_national').fetchone()[0]:,} rows")

    # ── 4. Indexes ────────────────────────────────────────────────────────
    cur.execute("CREATE INDEX IF NOT EXISTS idx_hac_ori_year ON historical_agency_crime (ori, year)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_hac_year ON historical_agency_crime (year)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_hsn_state_year ON historical_state_national (state, year)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_hsn_year ON historical_state_national (year)")

    conn.commit()
    conn.close()
    print("Done.")


if __name__ == "__main__":
    main()
