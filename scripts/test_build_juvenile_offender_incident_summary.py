#!/usr/bin/env python3
import importlib.util
import sqlite3
import tempfile
from pathlib import Path


SCRIPT = Path(__file__).with_name("build-juvenile-offender-incident-summary.py")
spec = importlib.util.spec_from_file_location("juvenile_rollup_builder", SCRIPT)
builder = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(builder)

AUTO_SCRIPT = Path(__file__).with_name("nibrs-auto-update.py")
auto_spec = importlib.util.spec_from_file_location("nibrs_auto_update", AUTO_SCRIPT)
auto_update = importlib.util.module_from_spec(auto_spec)
assert auto_spec and auto_spec.loader
auto_spec.loader.exec_module(auto_update)


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    source = root / "source.db"
    work = root / "work.db"
    db = sqlite3.connect(source)
    db.executescript("""
      CREATE TABLE offenders(year INT,state TEXT,ori TEXT,incident_num TEXT,incident_date TEXT,offender_sequence TEXT,age TEXT,sex TEXT,race TEXT,ethnicity TEXT);
      CREATE TABLE offenses(year INT,state TEXT,ori TEXT,incident_num TEXT,incident_date TEXT,ucr_offense_code TEXT);
      INSERT INTO offenders VALUES
        (2025,'IL','ORI1','A','20250102','01','16','','',''),
        (2025,'IL','ORI1','A','20250102','02','17','','',''),
        (2025,'IL','ORI1','B','20250202','01','22','','',''),
        (2025,'IL','ORI1','C','20250302','01','17','','',''),
        (2025,'IL','ORI1','D','20250402','01','00','','',''),
        (2025,'IL','ORI1','E','','01','15','','','');
      INSERT INTO offenses VALUES
        (2025,'IL','ORI1','A','20250102','120'),
        (2025,'IL','ORI1','A','20250102','120'),
        (2025,'IL','ORI1','A','20250102','13A'),
        (2025,'IL','ORI1','B','20250202','120'),
        (2025,'IL','ORI1','C','20250302','23A'),
        (2025,'IL','ORI1','C','20250302','220'),
        (2025,'IL','ORI1','D','20250402','09A'),
        (2025,'IL','ORI1','E','','120');
    """)
    db.commit()
    db.close()

    builder.build(source, work)
    result = sqlite3.connect(work)
    rows = {
        (row[0], row[1]): row[2]
        for row in result.execute(
            "SELECT month,offense_scope,incident_count FROM summary_juvenile_offender_incidents"
        )
    }
    assert rows[(1, "120")] == 1
    assert rows[(1, "13A")] == 1
    assert rows[(1, "violent_crime")] == 1
    assert rows[(0, "violent_crime")] == 1
    assert rows[(3, "23A")] == 1
    assert rows[(3, "220")] == 1
    assert rows[(3, "property_crime")] == 1
    assert rows[(3, "theft")] == 1
    assert len(rows) == 9
    result.close()

    builder.publish(source, work, allow_production=True)
    published = sqlite3.connect(source)
    assert published.execute(
        "SELECT SUM(incident_count) FROM summary_juvenile_offender_incidents WHERE offense_scope='violent_crime'"
    ).fetchone()[0] == 2
    published.execute("DROP TABLE summary_juvenile_offender_incidents")
    published.execute("CREATE INDEX idx_offenses_year ON offenses(year)")
    published.execute("CREATE INDEX idx_offenders_year_age ON offenders(year,age)")
    auto_update.rebuild_summary_juvenile_offender_incidents(published, [2025])
    assert published.execute(
        "SELECT SUM(incident_count) FROM summary_juvenile_offender_incidents WHERE offense_scope='violent_crime'"
    ).fetchone()[0] == 2
    assert published.execute(
        "SELECT SUM(incident_count) FROM summary_juvenile_offender_incidents WHERE offense_scope='property_crime'"
    ).fetchone()[0] == 1
    published.close()

print("juvenile offender incident summary builder tests passed")
