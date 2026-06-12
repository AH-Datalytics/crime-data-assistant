#!/usr/bin/env python3
import os
import sqlite3
import tempfile

from build_nibrs_consistent_reporters import rebuild_consistent_reporters


def has_span(conn, ori, start_year, end_year):
    row = conn.execute(
        """
        SELECT 1
        FROM nibrs_consistent_reporters
        WHERE ori = ? AND start_year = ? AND end_year = ?
        """,
        (ori, start_year, end_year),
    ).fetchone()
    return row is not None


def main():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "fixture.db")
        conn = sqlite3.connect(path)
        conn.execute(
            """
            CREATE TABLE nibrs_agency_completeness (
              ori TEXT,
              year INTEGER,
              months_reported INTEGER,
              total_offenses INTEGER
            )
            """
        )
        conn.executemany(
            "INSERT INTO nibrs_agency_completeness VALUES (?, ?, ?, ?)",
            [
                ("A", 2018, 12, 10),
                ("A", 2019, 12, 10),
                ("A", 2020, 11, 10),
                ("A", 2021, 12, 10),
                ("B", 2018, 12, 10),
                ("B", 2020, 12, 10),
                ("C", 2020, 12, 10),
                ("C", 2021, 12, 10),
                ("C", 2022, 12, 10),
            ],
        )
        conn.commit()

        rebuild_consistent_reporters(conn, log=lambda _msg: None)

        assert has_span(conn, "A", 2018, 2018)
        assert has_span(conn, "A", 2018, 2019)
        assert not has_span(conn, "A", 2018, 2020), "11-month year must break the span"
        assert not has_span(conn, "A", 2019, 2021), "partial 2020 must exclude multi-year span"
        assert has_span(conn, "A", 2021, 2021)

        assert has_span(conn, "B", 2018, 2018)
        assert has_span(conn, "B", 2020, 2020)
        assert not has_span(conn, "B", 2018, 2020), "missing 2019 must break the span"

        expected_c = {
            (2020, 2020),
            (2020, 2021),
            (2020, 2022),
            (2021, 2021),
            (2021, 2022),
            (2022, 2022),
        }
        actual_c = set(
            conn.execute(
                "SELECT start_year, end_year FROM nibrs_consistent_reporters WHERE ori = 'C'"
            ).fetchall()
        )
        assert actual_c == expected_c, actual_c

        conn.close()

    print("nibrs consistent reporter tests passed")


if __name__ == "__main__":
    main()
