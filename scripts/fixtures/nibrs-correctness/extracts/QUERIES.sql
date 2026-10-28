-- Read-only queries against /opt/nibrs/nibrs.db (raw segment tables), run 2026-10-28 00:45-01:30 UTC through
--   ssh root@178.156.243.51 'nice -n 19 timeout 600 sqlite3 -readonly -csv -header /opt/nibrs/nibrs.db'
-- after checking with fuser that /opt/nibrs/release.lock and /opt/nibrs/maintenance.lock were not held and that the
-- UTC day was not the 15th-19th. Each query filters on an indexed ORI prefix plus data year (and offense code).
-- Column projections and the per-case incident filters were applied locally afterwards (see each file's header).

-- agency_month_incident_counts_2017_2026.csv
select ori, year as data_year, substr(incident_date,1,6) as ym, count(*) n from incidents
 where ori in ("TXHPD0000","MDBPD0000","TNMPD0000") and year>=2017 group by 1,2,3 order by 1,3,2;

-- houston_09a_victims_2018_2026.csv
select * from victims where ori="TXHPD0000" and year between 2018 and 2026
 and (connected_offense_1="09A" or connected_offense_2="09A" or connected_offense_3="09A")
 order by incident_date, incident_num, victim_sequence;

-- houston_09a_offenses_2018_2026.csv (projected locally to year..attempted_completed and the three weapons)
select * from offenses where ori="TXHPD0000" and year between 2018 and 2026 and ucr_offense_code="09A"
 order by incident_date, incident_num;

-- houston_09c_offenses_2018_2026.csv
select year,ori,incident_num,incident_date,ucr_offense_code from offenses
 where ori="TXHPD0000" and year between 2018 and 2026 and ucr_offense_code="09C" order by incident_date;

-- baltimore_240_offenses_2022_2026.csv.gz
select year,ori,incident_num,incident_date,ucr_offense_code,attempted_completed from offenses
 where ori="MDBPD0000" and year between 2022 and 2026 and ucr_offense_code="240" order by incident_date,incident_num;

-- baltimore_vehicle_property_for_240_incidents_2022_2026.csv.gz (kept locally: incidents that hold a 240 offense)
select year,ori,incident_num,incident_date,type_property_loss,property_description,value,
       num_stolen_motor_vehicles,num_recovered_motor_vehicles from property
 where ori="MDBPD0000" and year between 2022 and 2026 and property_description in ("03","05","24","28","37")
 order by incident_date,incident_num;

-- memphis_120_offenses_2017_2026.csv.gz (code 120 kept locally) and memphis_23f_offenses_2024.csv.gz (23F, 2024 kept)
select year,ori,incident_num,incident_date,ucr_offense_code,attempted_completed from offenses
 where ori="TNMPD0000" and year between 2017 and 2026 and ucr_offense_code in ("120","23F")
 order by incident_date,incident_num;

-- memphis_vehicle_property_for_120_incidents_2017_2026.csv.gz (vehicle codes, 120 incidents kept) and
-- memphis_firearm_property_for_23f_incidents_2024.csv (code 13, 2024 23F incidents kept)
select year,ori,incident_num,incident_date,type_property_loss,property_description,value,
       num_stolen_motor_vehicles,num_recovered_motor_vehicles from property
 where ori="TNMPD0000" and year between 2017 and 2026 and property_description in ("03","05","24","28","37","13")
 order by incident_date,incident_num;

-- memphis_23f_incidents_with_other_offenses_2024.csv
select incident_num, group_concat(ucr_offense_code) codes from offenses where ori="TNMPD0000" and year=2024
 group by incident_num having sum(ucr_offense_code="23F")>0 and count(*)>=2;

-- micro/*.csv: every row of each table for the seven incidents
-- (<table> in incidents, offenses, victims, offenders, property, arrestees)
select * from <table> where
    (ori="TXHPD0000" and year=2019 and incident_num in ("008261219","026992719"))
 or (ori="TXHPD0000" and year=2021 and incident_num in ("6V139B1EZU72","729X9A1EZU72"))
 or (ori="TNMPD0000" and year=2024 and incident_num in ("0U0S3UG6NNFF","0U0S3UJ2H0FF","0U023-G72OFF"))
 order by ori,incident_num;
