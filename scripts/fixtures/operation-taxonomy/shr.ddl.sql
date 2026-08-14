CREATE TABLE incidents (
      id INTEGER PRIMARY KEY,
      year INTEGER NOT NULL,
      month INTEGER,
      state TEXT NOT NULL,
      state_name TEXT,
      ori TEXT,
      agency TEXT,
      population INTEGER,
      division INTEGER,
      homicide_type TEXT,
      situation TEXT,
      weapon TEXT,
      weapon_group TEXT,
      relationship TEXT,
      relationship_group TEXT,
      circumstance TEXT,
      circumstance_group TEXT,
      sub_circumstance TEXT,
      action_type TEXT,
      incident_num TEXT,
      off_age TEXT,
      off_age_num INTEGER,
      off_sex TEXT,
      off_race TEXT,
      off_ethnicity TEXT
    , agency_type TEXT);
CREATE TABLE victims (
      id INTEGER PRIMARY KEY,
      incident_id INTEGER NOT NULL,
      victim_num INTEGER NOT NULL,
      age TEXT,
      age_num INTEGER,
      sex TEXT,
      race TEXT,
      ethnicity TEXT,
      FOREIGN KEY (incident_id) REFERENCES incidents(id)
    );
CREATE INDEX idx_incidents_year ON incidents(year);
CREATE INDEX idx_incidents_state ON incidents(state);
CREATE INDEX idx_incidents_year_state ON incidents(year, state);
CREATE INDEX idx_incidents_weapon_group ON incidents(weapon_group);
CREATE INDEX idx_incidents_circumstance_group ON incidents(circumstance_group);
CREATE INDEX idx_incidents_relationship_group ON incidents(relationship_group);
CREATE INDEX idx_incidents_homicide_type ON incidents(homicide_type);
CREATE INDEX idx_victims_incident ON victims(incident_id);
CREATE INDEX idx_victims_race ON victims(race);
CREATE INDEX idx_victims_sex ON victims(sex);
CREATE INDEX idx_incidents_agency_type ON incidents(agency_type);
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
