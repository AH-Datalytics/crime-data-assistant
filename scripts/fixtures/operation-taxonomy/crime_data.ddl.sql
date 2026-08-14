CREATE TABLE agency_monthly (
            ori TEXT NOT NULL,
            agency TEXT NOT NULL,
            state TEXT NOT NULL,
            type TEXT NOT NULL,
            year INTEGER NOT NULL,
            month INTEGER NOT NULL,
            offense TEXT NOT NULL,
            count INTEGER NOT NULL,
            PRIMARY KEY (ori, year, month, offense)
        );
CREATE TABLE agencies (
            ori TEXT PRIMARY KEY,
            agency TEXT NOT NULL,
            state TEXT NOT NULL,
            type TEXT NOT NULL,
            total_months INTEGER NOT NULL,
            national_sample INTEGER NOT NULL
        );
CREATE TABLE national_monthly (
            year INTEGER NOT NULL,
            month INTEGER NOT NULL,
            offense TEXT NOT NULL,
            count INTEGER NOT NULL,
            agency_count INTEGER NOT NULL,
            PRIMARY KEY (year, month, offense)
        );
CREATE TABLE agency_population (
            ori TEXT NOT NULL,
            year INTEGER NOT NULL,
            population INTEGER NOT NULL,
            PRIMARY KEY (ori, year)
        );
CREATE INDEX idx_am_agency ON agency_monthly(agency, state);
CREATE INDEX idx_am_state ON agency_monthly(state, year, month);
CREATE INDEX idx_am_offense ON agency_monthly(offense, year, month);
CREATE INDEX idx_ap_year ON agency_population(year);
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
        );
CREATE TABLE historical_agency_population (
            ori        TEXT,
            year       INTEGER,
            population INTEGER,
            PRIMARY KEY (ori, year)
        );
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
        );
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
        );
CREATE TABLE historical_staffing (
            ori            TEXT,
            year           INTEGER,
            all_total      INTEGER,
            officer_total  INTEGER,
            civilian_total INTEGER,
            PRIMARY KEY (ori, year)
        );
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
        );
CREATE INDEX idx_hac_ori_year ON historical_agency_crime (ori, year);
CREATE INDEX idx_hac_year ON historical_agency_crime (year);
CREATE INDEX idx_hap_ori_year ON historical_agency_population (ori, year);
CREATE INDEX idx_hap_year ON historical_agency_population (year);
CREATE INDEX idx_hsn_state_year ON historical_state_national (state, year);
CREATE INDEX idx_hsn_year ON historical_state_national (year);
CREATE INDEX idx_hclr_ori_year ON historical_agency_clearance (ori, year);
CREATE INDEX idx_hclr_year ON historical_agency_clearance (year);
CREATE INDEX idx_hstaff_ori_year ON historical_staffing (ori, year);
CREATE INDEX idx_hstaff_year ON historical_staffing (year);
CREATE INDEX idx_ha_type ON historical_agency (type);
CREATE INDEX idx_ha_state ON historical_agency (state);
CREATE TABLE sample_agencies (
      ori TEXT PRIMARY KEY,
      agency TEXT NOT NULL,
      state TEXT NOT NULL,
      type TEXT NOT NULL
    );
CREATE INDEX idx_am_type ON agency_monthly(type);
CREATE INDEX idx_ha_agency_state ON historical_agency(agency, state);
CREATE INDEX idx_ha_agency_state_type ON historical_agency(agency, state, type);
CREATE INDEX idx_agencies_state ON agencies(state, national_sample);
CREATE INDEX idx_agencies_agency_state ON agencies(agency, state);
CREATE INDEX idx_ap_ori_year ON agency_population(ori, year);
CREATE INDEX idx_am_ori_offense ON agency_monthly(ori, offense, year, month);
CREATE TABLE agency_county_crosswalk (
      ori TEXT PRIMARY KEY,
      ori9 TEXT,
      agency_name TEXT,
      state TEXT,
      fips_state_code INTEGER,
      fips_county_code INTEGER,
      county_fips TEXT,
      county_name TEXT,
      county_key TEXT,
      source TEXT NOT NULL
    );
CREATE INDEX idx_agency_county_crosswalk_ori9
      ON agency_county_crosswalk(ori9);
CREATE INDEX idx_agency_county_crosswalk_state_fips
      ON agency_county_crosswalk(state, county_fips);
CREATE INDEX idx_agency_county_crosswalk_state_county
      ON agency_county_crosswalk(state, county_key);
CREATE INDEX idx_agency_county_crosswalk_county
      ON agency_county_crosswalk(county_key);
CREATE TABLE "agency_year_reliability" (
    ori TEXT NOT NULL,
    year INTEGER NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    columns_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    PRIMARY KEY (ori, year, kind, source)
  );
CREATE INDEX idx_agency_year_reliability_ori ON agency_year_reliability (ori, year);
CREATE TABLE national_clearance_rate (
    year INTEGER PRIMARY KEY,
    violent_rate REAL,
    property_rate REAL,
    murder_rate REAL,
    rape_rate REAL,
    robbery_rate REAL,
    assault_rate REAL,
    burglary_rate REAL,
    theft_rate REAL,
    auto_theft_rate REAL
);
