CREATE TABLE agencies (
    ori TEXT NOT NULL,
    year INTEGER NOT NULL,
    state_code TEXT,
    state TEXT,
    city TEXT,
    pop_group TEXT,
    country_division TEXT,
    covered_flag TEXT,
    agency_indicator TEXT,
    population INTEGER, agency_type TEXT,
    PRIMARY KEY (ori, year)
);
CREATE INDEX idx_agencies_state ON agencies(state, year);
CREATE TABLE nibrs_agency_completeness(
  ori TEXT,
  year INT,
  months_reported,
  total_offenses
);
CREATE INDEX idx_nac_ori ON nibrs_agency_completeness(ori);
CREATE INDEX idx_nac_year ON nibrs_agency_completeness(year);
CREATE INDEX idx_nac_months ON nibrs_agency_completeness(year, months_reported);
CREATE TABLE summary_clearance_type (
        year INTEGER,
        month INTEGER,
        state TEXT,
        ori TEXT,
        ucr_offense_code TEXT,
        total_offenses INTEGER,
        cleared_by_arrest INTEGER,
        cleared_exceptional INTEGER,
        PRIMARY KEY (year, month, state, ori, ucr_offense_code)
    );
CREATE INDEX idx_sct_ori_year ON summary_clearance_type(ori, year);
CREATE INDEX idx_sct_state_year ON summary_clearance_type(state, year);
CREATE INDEX idx_sct_offense_year ON summary_clearance_type(ucr_offense_code, year);
CREATE TABLE summary_clearance_detail (
            year INTEGER,
            state TEXT,
            ori TEXT,
            ucr_offense_code TEXT,
            cleared_by_arrest INTEGER,
            cleared_A INTEGER,
            cleared_B INTEGER,
            cleared_C INTEGER,
            cleared_D INTEGER,
            cleared_E INTEGER,
            total_offenses INTEGER,
            PRIMARY KEY (year, state, ori, ucr_offense_code)
        );
CREATE INDEX idx_scd_ori_year ON summary_clearance_detail(ori, year);
CREATE INDEX idx_scd_state_year ON summary_clearance_detail(state, year);
CREATE INDEX idx_scd_offense_year ON summary_clearance_detail(ucr_offense_code, year);
CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year, months_reported);
CREATE TABLE summary_victim_circumstance(
  ori TEXT,
  year INT,
  ucr_offense_code TEXT,
  circumstance_code TEXT,
  victim_count
, state TEXT);
CREATE INDEX idx_svc_ori_year ON summary_victim_circumstance(ori, year);
CREATE INDEX idx_svc_ucr_year ON summary_victim_circumstance(ucr_offense_code, year);
CREATE INDEX idx_svc_circ ON summary_victim_circumstance(circumstance_code, year);
CREATE INDEX idx_svictim_circumstance_state_year ON summary_victim_circumstance(state, year, ucr_offense_code);
CREATE TABLE "summary_city_monthly"(
  year INT,
  month INT,
  state TEXT,
  ori TEXT,
  ucr_offense_code TEXT,
  offense_count INT,
  cleared_count INT
);
CREATE INDEX idx_scm_state_year ON summary_city_monthly(state, year, month);
CREATE INDEX idx_scm_ori_year ON summary_city_monthly(ori, year, month);
CREATE INDEX idx_scm_ucr ON summary_city_monthly(ucr_offense_code, year, month);
CREATE TABLE "summary_victim_city_monthly"(
  year INT,
  month INT,
  state TEXT,
  ori TEXT,
  ucr_offense_code TEXT,
  victim_count INT
);
CREATE INDEX idx_svcm_state ON summary_victim_city_monthly(state, year, month);
CREATE INDEX idx_svcm_ori ON summary_victim_city_monthly(ori, year, month);
CREATE INDEX idx_svcm_ucr ON summary_victim_city_monthly(ucr_offense_code, year);
CREATE TABLE "summary_victim_state_monthly"(
  state TEXT,
  year INT,
  month INT,
  ucr_offense_code TEXT,
  victim_count
);
CREATE INDEX idx_svsm_state ON summary_victim_state_monthly(state, year, month);
CREATE INDEX idx_svsm_ucr ON summary_victim_state_monthly(ucr_offense_code, year);
CREATE TABLE "summary_offender_demographics" (
    ori TEXT, year INT, ucr_offense_code TEXT, weapon_category TEXT,
    race TEXT, sex TEXT, age_group TEXT, ethnicity TEXT,
    offender_count INTEGER, state TEXT
);
CREATE INDEX idx_sod_new_ori_year ON "summary_offender_demographics"(ori, year);
CREATE INDEX idx_sod_new_ucr ON "summary_offender_demographics"(ucr_offense_code, year);
CREATE INDEX idx_sod_new_state ON "summary_offender_demographics"(state, year);
CREATE TABLE "summary_arrestee_demographics" (
    ori TEXT, year INT, ucr_arrest_offense TEXT, weapon_category TEXT,
    race TEXT, sex TEXT, age_group TEXT, ethnicity TEXT,
    arrestee_count INTEGER, state TEXT
);
CREATE INDEX idx_sad_new_ori_year ON "summary_arrestee_demographics"(ori, year);
CREATE INDEX idx_sad_new_ucr ON "summary_arrestee_demographics"(ucr_arrest_offense, year);
CREATE INDEX idx_sad_new_state ON "summary_arrestee_demographics"(state, year);
CREATE TABLE "summary_victim_demographics" (
    ori TEXT, year INT, ucr_offense_code TEXT, weapon_category TEXT,
    race TEXT, sex TEXT, age_group TEXT, ethnicity TEXT,
    victim_count INTEGER, state TEXT
);
CREATE INDEX idx_svd_new_ori_year ON "summary_victim_demographics"(ori, year);
CREATE INDEX idx_svd_new_ucr ON "summary_victim_demographics"(ucr_offense_code, year);
CREATE INDEX idx_svd_new_state ON "summary_victim_demographics"(state, year);
CREATE INDEX idx_sad_offense_state_year
  ON summary_arrestee_demographics(ucr_arrest_offense, state, year);
CREATE INDEX idx_agencies_year_state_population
  ON agencies(year, state, population);
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
CREATE INDEX idx_svd_continuous_age ON summary_victim_demographics(ucr_offense_code, year, ori, age_group, victim_count);
CREATE INDEX idx_sod_continuous_age ON summary_offender_demographics(ucr_offense_code, year, ori, age_group, offender_count);
CREATE INDEX idx_sad_age_year_ori
ON summary_arrestee_demographics(age_group, year, ori, arrestee_count);
CREATE INDEX idx_sod_age_year_ori
ON summary_offender_demographics(age_group, year, ori, offender_count);
CREATE TABLE nibrs_consistent_reporters (
          start_year INTEGER NOT NULL,
          end_year INTEGER NOT NULL,
          ori TEXT NOT NULL,
          years_required INTEGER NOT NULL,
          PRIMARY KEY (start_year, end_year, ori)
        ) WITHOUT ROWID;
CREATE INDEX idx_ncr_ori_range
          ON nibrs_consistent_reporters(ori, start_year, end_year);
CREATE INDEX idx_ncr_end_start
          ON nibrs_consistent_reporters(end_year, start_year);
CREATE INDEX idx_agencies_state_city_year ON agencies(state, city, year, agency_type, population);
CREATE TABLE "summary_juvenile_offender_incidents"(
  year INT,
  month INT,
  state TEXT,
  ori TEXT,
  offense_scope TEXT,
  incident_count INT
);
CREATE UNIQUE INDEX idx_sjoi_key ON summary_juvenile_offender_incidents(year,month,ori,offense_scope);
CREATE INDEX idx_sjoi_scope_year ON summary_juvenile_offender_incidents(offense_scope,year);
CREATE INDEX idx_sjoi_state_year ON summary_juvenile_offender_incidents(state,year,offense_scope);
CREATE TABLE nibrs_state_coverage (
            state TEXT NOT NULL,
            year INTEGER NOT NULL,
            total_agencies INTEGER,
            reporting_agencies INTEGER,
            total_population INTEGER,
            reporting_population INTEGER,
            coverage_pct REAL,
            PRIMARY KEY (state, year)
        );
CREATE TABLE IF NOT EXISTS "summary_state_monthly"(
  year INT,
  month INT,
  state TEXT,
  ucr_offense_code TEXT,
  offense_count,
  cleared_count
);
CREATE INDEX idx_ssm_state ON summary_state_monthly(state, year, month);
CREATE INDEX idx_ssm_ucr ON summary_state_monthly(ucr_offense_code, year, month);
