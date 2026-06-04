-- Build summary_victim_circumstance_clearance_demo (OPTIMIZED)
-- Pre-filters to person-crime victims first, then JOINs clearance data
-- Run on VPS: sqlite3 /opt/nibrs/nibrs.db < /opt/nibrs/app/scripts/build-victim-circumstance-clearance-demo.sql
--
-- Optimization vs v1: instead of scanning ALL incidents then JOINing to victims,
-- we first build a small victim+offense set (~20M rows for person crimes),
-- then JOIN only those to incidents for clearance status.

PRAGMA busy_timeout = 300000;
PRAGMA cache_size = -512000;
PRAGMA temp_store = MEMORY;

.print "Step 1: Pre-joining victims to offenses for person crimes only..."

CREATE TEMP TABLE _tmp_person_victims AS
SELECT
    v.state,
    v.ori,
    v.year,
    v.incident_num,
    o.ucr_offense_code,
    v.aggravated_assault_homicide_1 AS circumstance_code,
    v.sex,
    v.race,
    CASE
        WHEN v.age IS NULL OR v.age = '' OR v.age = 'BB' OR v.age = 'NB' OR v.age = 'NN' OR v.age = '00' THEN 'Under 1'
        WHEN CAST(v.age AS INTEGER) BETWEEN 1 AND 17 THEN 'Under 18'
        WHEN CAST(v.age AS INTEGER) BETWEEN 18 AND 24 THEN '18-24'
        WHEN CAST(v.age AS INTEGER) BETWEEN 25 AND 34 THEN '25-34'
        WHEN CAST(v.age AS INTEGER) BETWEEN 35 AND 44 THEN '35-44'
        WHEN CAST(v.age AS INTEGER) BETWEEN 45 AND 54 THEN '45-54'
        WHEN CAST(v.age AS INTEGER) BETWEEN 55 AND 64 THEN '55-64'
        WHEN CAST(v.age AS INTEGER) >= 65 THEN '65+'
        ELSE 'Unknown'
    END AS age_group
FROM victims v
JOIN offenses o
    ON o.year = v.year AND o.state = v.state AND o.ori = v.ori
    AND o.incident_num = v.incident_num
    AND o.ucr_offense_code = v.connected_offense_1
WHERE o.ucr_offense_code IN ('09A','09B','09C','13A')
    AND v.aggravated_assault_homicide_1 IS NOT NULL
    AND v.aggravated_assault_homicide_1 != '';

CREATE INDEX _tmp_pv_idx ON _tmp_person_victims(ori, incident_num, year);

.print "Step 2: Building summary with clearance status from incidents..."

DROP TABLE IF EXISTS summary_victim_circumstance_clearance_demo;

CREATE TABLE summary_victim_circumstance_clearance_demo AS
SELECT
    pv.state,
    pv.ori,
    pv.year,
    pv.ucr_offense_code,
    pv.circumstance_code,
    CASE
        WHEN i.cleared_exceptionally IN ('A','B','C','D','E') THEN 'exceptional'
        WHEN EXISTS (
            SELECT 1 FROM arrestees ar
            WHERE ar.ori = pv.ori AND ar.incident_num = pv.incident_num AND ar.year = pv.year
        ) THEN 'arrest'
        ELSE 'not_cleared'
    END AS clearance_status,
    pv.sex,
    pv.race,
    pv.age_group,
    COUNT(*) AS victim_count
FROM _tmp_person_victims pv
JOIN incidents i
    ON i.year = pv.year AND i.state = pv.state AND i.ori = pv.ori
    AND i.incident_num = pv.incident_num
GROUP BY pv.state, pv.ori, pv.year, pv.ucr_offense_code,
    pv.circumstance_code, clearance_status,
    pv.sex, pv.race, pv.age_group;

.print "Step 3: Creating indexes..."

CREATE INDEX idx_vccd_state_year ON summary_victim_circumstance_clearance_demo(state, year, ucr_offense_code);
CREATE INDEX idx_vccd_ori_year ON summary_victim_circumstance_clearance_demo(ori, year);
CREATE INDEX idx_vccd_circ_year ON summary_victim_circumstance_clearance_demo(circumstance_code, year);
CREATE INDEX idx_vccd_clearance ON summary_victim_circumstance_clearance_demo(clearance_status, year);
CREATE INDEX idx_vccd_sex ON summary_victim_circumstance_clearance_demo(sex, year);
CREATE INDEX idx_vccd_race ON summary_victim_circumstance_clearance_demo(race, year);

.print "=== Verification ==="
SELECT 'Total rows: ' || COUNT(*) FROM summary_victim_circumstance_clearance_demo;
SELECT ucr_offense_code, clearance_status, SUM(victim_count) as victims
FROM summary_victim_circumstance_clearance_demo
WHERE year = 2023
GROUP BY ucr_offense_code, clearance_status
ORDER BY ucr_offense_code, clearance_status;

.print "=== DV murder clearance by sex (2023) ==="
SELECT sex, clearance_status, SUM(victim_count) as victims
FROM summary_victim_circumstance_clearance_demo
WHERE year = 2023 AND ucr_offense_code = '09A' AND circumstance_code = '06'
GROUP BY sex, clearance_status
ORDER BY sex, clearance_status;

DROP TABLE _tmp_person_victims;
.print "DONE"
