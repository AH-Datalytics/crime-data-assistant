CREATE TABLE hate_crime_incidents (
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
    );
CREATE INDEX idx_hc_year ON hate_crime_incidents(year);
CREATE INDEX idx_hc_state_year ON hate_crime_incidents(state, year);
CREATE INDEX idx_hc_bias ON hate_crime_incidents(bias_category, year);
CREATE INDEX idx_hc_offense ON hate_crime_incidents(offense_code, year);
CREATE INDEX idx_hc_ori ON hate_crime_incidents(ori, year);
CREATE TABLE hate_crime_participation (
        year INTEGER, state TEXT,
        total_agencies INTEGER,
        reporting_agencies INTEGER,
        total_incidents INTEGER,
        total_victims INTEGER
    );
CREATE INDEX idx_hcp_year ON hate_crime_participation(year);
CREATE INDEX idx_hcp_state ON hate_crime_participation(state, year);
