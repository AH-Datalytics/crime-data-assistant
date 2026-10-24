"""
Rebuilding the two Historical core tables, as properties rather than as a run log.

The defect this suite exists to stop is a rewrite both importers performed: when every
crime measure for an agency-year was zero, all of them were overwritten with NULL and the
row was called "non-reporting". A reported zero and a missing value became the same thing.
Most of what follows is about keeping those two apart, at every stage, in both eras.

Owner rule 2026-10-24 brings back one part of that rewrite on purpose: an agency-year whose every
stated count (or every cleared count) is zero is blank, because the sources write 0 where nothing
was filed. A zero beside a non-zero value is still a zero, and the tests below pin both sides.

The rest is about determinism. The old annual importer chose among ORIs with an unordered
`SUBSTR(ori,1,7) ... LIMIT 1`, so which agency a year of crime attached to could depend on
SQLite's row order. Nothing here may depend on the order rows arrive in.
"""

import argparse
import json
import os
import sqlite3
import tempfile
import unittest

import historical_core as core


def rows_to_dicts(pairs):
    return [dict(p) for p in pairs]


def base_row(ori, year, **measures):
    """A row shaped like historical_crime_1930_2024.csv. Absent measure = blank cell."""
    row = {"id": ori, "year": year, "population": measures.pop("population", "")}
    for name in core.BASE_MEASURE_COLUMNS:
        row[name] = measures.pop(name, "")
    assert not measures, f"unknown measure(s): {sorted(measures)}"
    return row


def annual_row(ori7, months, **values):
    """A row shaped like the RETA annual CSV."""
    row = {
        "ORI": ori7,
        "Year": "2025",
        "Agency_Name": values.pop("agency", "Somewhere"),
        "State": values.pop("state", "AL"),
        "Population": values.pop("population", "1000"),
        "Months_Reported": str(months),
    }
    for name in core.ANNUAL_MEASURE_COLUMNS:
        row[name] = values.pop(name, "0")
    for name in core._ANNUAL_CLEARED_COLUMNS.values():
        row[name] = values.pop(name, "0")
    assert not values, f"unknown value(s): {sorted(values)}"
    return row


def clearance_row(ori, year, **totals):
    """A row shaped like historical_clearance_1960_2024.csv. Absent pair = blank cells."""
    row = {"id": ori, "year": year}
    for offences, cleared in core.CLEARANCE_SOURCE_PAIRS.values():
        row[offences] = totals.pop(offences, "")
        row[cleared] = totals.pop(cleared, "")
    assert not totals, f"unknown column(s): {sorted(totals)}"
    return row


def agency_row(ori, name, state, type_="city"):
    return {"id": ori, "name": name, "state": state, "type": type_}


class CoreBuildTestCase(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        core.create_core_tables(self.conn)

    def tearDown(self):
        self.conn.close()

    def crime(self, ori, year):
        cur = self.conn.execute(
            "SELECT " + ", ".join(core.CRIME_MEASURES) + " FROM historical_agency_crime WHERE ori=? AND year=?",
            (ori, year),
        )
        row = cur.fetchone()
        return None if row is None else dict(zip(core.CRIME_MEASURES, row))


class BaseEraSemantics(CoreBuildTestCase):
    """1930-2024. The upstream R builder blanked zero-month rows, but the CSV still writes 0 where
    nothing was filed, so a row of nothing but zeroes is blank (owner rule 2026-10-24); a zero
    beside a non-zero value is a value and arrives as a value."""

    def test_all_zero_row_is_blank(self):
        # Owner rule 2026-10-24: a row of nothing but zeroes is unreported (the sources write 0
        # where an agency filed nothing). Accepted cost: Metlakatla's genuine 2024 zeroes read blank.
        core.load_agencies(self.conn, [agency_row("AK0012500", "Metlakatla Tribal", "ak")])
        core.load_base_crime(self.conn, [base_row("AK0012500", 2024, **{m: "0" for m in core.BASE_MEASURE_COLUMNS})])
        self.assertEqual(self.crime("AK0012500", 2024), {m: None for m in core.CRIME_MEASURES})

    def test_zeroes_beside_blanks_only_are_blank(self):
        core.load_agencies(self.conn, [agency_row("X00000100", "Somewhere", "tx")])
        core.load_base_crime(self.conn, [base_row("X00000100", 2020, murder_total="0", robbery_total="0")])
        self.assertEqual(self.crime("X00000100", 2020), {m: None for m in core.CRIME_MEASURES})

    def test_blank_row_stays_null(self):
        core.load_agencies(self.conn, [agency_row("AK0011900", "Seldovia", "ak")])
        core.load_base_crime(self.conn, [base_row("AK0011900", 2024)])
        self.assertEqual(self.crime("AK0011900", 2024), {m: None for m in core.CRIME_MEASURES})

    def test_partial_zero_stays_zero_beside_a_real_number(self):
        core.load_agencies(self.conn, [agency_row("X00000100", "Somewhere", "tx")])
        core.load_base_crime(self.conn, [base_row("X00000100", 2020, murder_total="0", burglary_total="5")])
        got = self.crime("X00000100", 2020)
        self.assertEqual(got["murder"], 0)
        self.assertEqual(got["burglary"], 5)
        self.assertIsNone(got["rape"])

    def test_conflicting_duplicate_agency_year_is_refused(self):
        core.load_agencies(self.conn, [agency_row("X00000100", "Somewhere", "tx")])
        with self.assertRaises(core.BuildError):
            core.load_base_crime(self.conn, [
                base_row("X00000100", 2020, murder_total="1"),
                base_row("X00000100", 2020, murder_total="2"),
            ])


class AnnualEraSemantics(CoreBuildTestCase):
    """2025. Reporting status comes from Months_Reported, never from the totals."""

    def setUp(self):
        super().setUp()
        core.load_agencies(self.conn, [agency_row("AL0012000", "Lipscomb", "al")])

    def test_twelve_months_of_zero_is_blank(self):
        # Owner rule 2026-10-24 applies to every year, 2025 included: all zeroes read blank.
        core.load_annual(self.conn, [annual_row("AL00120", 12)], exact_map=[], year=2025)
        self.assertEqual(self.crime("AL0012000", 2025), {m: None for m in core.CRIME_MEASURES})

    def test_a_zero_beside_a_count_stays_zero_in_2025(self):
        core.load_annual(self.conn, [annual_row("AL00120", 12, Actual_Burglary_Total="3")], exact_map=[], year=2025)
        got = self.crime("AL0012000", 2025)
        self.assertEqual(got["murder"], 0)
        self.assertEqual(got["burglary"], 3)

    def test_zero_months_is_missing_even_when_totals_are_present(self):
        # The totals say 7 murders; Months_Reported says the agency filed nothing. The
        # reporting field decides, and the totals are never consulted to infer status.
        core.load_annual(self.conn, [annual_row("AL00120", 0, Actual_Murder="7")], exact_map=[], year=2025)
        got = self.crime("AL0012000", 2025)
        self.assertIsNotNone(got, "a zero-month agency-year still gets a row, as in the base era")
        self.assertEqual(got, {m: None for m in core.CRIME_MEASURES})

    def test_one_month_of_reporting_preserves_supplied_values(self):
        core.load_annual(self.conn, [annual_row("AL00120", 1, Actual_Murder="0", Actual_Burglary_Total="3")], exact_map=[], year=2025)
        got = self.crime("AL0012000", 2025)
        self.assertEqual(got["murder"], 0)
        self.assertEqual(got["burglary"], 3)


class OriResolution(CoreBuildTestCase):
    def setUp(self):
        super().setUp()
        core.load_agencies(self.conn, [
            agency_row("IN0494900", "Indianapolis", "in"),
            agency_row("MI631900X", "Pontiac", "mi"),
            agency_row("MI6367300", "Pontiac", "mi"),
            agency_row("TX0111100", "Unique Prefix Town", "tx"),
            agency_row("PA0252400", "Ambiguous", "pa"),
            agency_row("PA025240X", "Ambiguous", "pa"),
            agency_row("PA025249E", "Ambiguous", "pa"),
        ])
        self.index = core.build_prefix_index(self.conn)

    def test_exact_mapping_wins(self):
        mapping = [core.OriMapping("INIPD00", "IN0494900", "Indianapolis", "IN")]
        ori, how = core.resolve_annual_ori("INIPD00", mapping, self.index)
        self.assertEqual(ori, "IN0494900")
        self.assertEqual(how, core.RESOLVED_EXACT)

    def test_pontiac_exact_mapping_beats_the_predecessor_prefix(self):
        # MI63190 prefix-matches MI631900X, the ORI the consolidation step later removes.
        # Without the exact mapping winning first, 2025 Pontiac attaches to a row that is
        # then deleted, and the year disappears. This is the ordering trap.
        mapping = [core.OriMapping("MI63190", "MI6367300", "Pontiac", "MI")]
        ori, how = core.resolve_annual_ori("MI63190", mapping, self.index)
        self.assertEqual(ori, "MI6367300")
        self.assertEqual(how, core.RESOLVED_EXACT)

    def test_unique_prefix_resolves(self):
        ori, how = core.resolve_annual_ori("TX01111", [], self.index)
        self.assertEqual(ori, "TX0111100")
        self.assertIn(how, (core.RESOLVED_PADDED, core.RESOLVED_PADDED_UNVERIFIED, core.RESOLVED_PREFIX))

    def test_canonical_padded_form_wins_over_its_own_variants(self):
        # PA0252400 sits beside the X and 9E variants the FBI issues for the same agency.
        # Preferring the canonical +00 form is a stated rule, not a pick among equals, and it
        # is what the reference importer did before its unordered fallback took over.
        # With no name supplied there is nothing to confirm the choice against, so the
        # resolution is labelled as the weaker class the manifest counts separately.
        ori, how = core.resolve_annual_ori("PA02524", [], self.index)
        self.assertEqual(ori, "PA0252400")
        self.assertEqual(how, core.RESOLVED_PADDED_UNVERIFIED)

    def test_ambiguous_prefix_with_no_canonical_form_refuses_instead_of_choosing(self):
        core.load_agencies(self.conn, [
            agency_row("NC012340X", "Twinned", "nc"),
            agency_row("NC012349E", "Twinned", "nc"),
        ])
        index = core.build_prefix_index(self.conn)
        with self.assertRaises(core.AmbiguousOri) as raised:
            core.resolve_annual_ori("NC01234", [], index)
        message = str(raised.exception)
        for candidate in ("NC012340X", "NC012349E"):
            self.assertIn(candidate, message, "the report must name every candidate")

    def test_unknown_prefix_becomes_a_new_agency_deterministically(self):
        ori, how = core.resolve_annual_ori("ZZ99999", [], self.index)
        self.assertEqual(ori, "ZZ9999900")
        self.assertEqual(how, core.RESOLVED_NEW)

    def test_mapping_whose_state_disagrees_with_the_source_is_refused(self):
        errors = core.validate_ori_mappings(
            [core.OriMapping("INIPD00", "IN0494900", "Indianapolis", "TX")], self.conn
        )
        self.assertTrue(errors)
        self.assertIn("state", errors[0].lower())

    def test_mapping_whose_target_is_absent_is_refused(self):
        errors = core.validate_ori_mappings(
            [core.OriMapping("ZZ00000", "ZZ0000000", "Nowhere", "ZZ")], self.conn
        )
        self.assertTrue(errors)

    def test_valid_mapping_passes_validation(self):
        self.assertEqual(
            core.validate_ori_mappings([core.OriMapping("MI63190", "MI6367300", "Pontiac", "MI")], self.conn),
            [],
        )

    def test_colliding_rows_are_separated_by_the_name_the_source_supplies(self):
        # The annual file carries seven-character ORIs, which are not unique: Sheffield and a
        # district attorney's office both file under AL02001. The directory holds both under
        # distinct nine-character ORIs, and the agency name on each source row says which is
        # which. Letting the later row win is what overwrote Huntsville's real 2025 figures
        # with another agency's zeroes in the current database.
        core.load_agencies(self.conn, [
            agency_row("AL0200100", "Sheffield", "al"),
            agency_row("AL020015A", "District Attorney:", "al", "other"),
        ])
        report = core.load_annual(
            self.conn,
            [annual_row("AL02001", 12, agency="SHEFFIELD", state="AL", Actual_Murder="2"),
             annual_row("AL02001", 4, agency="DISTRICT ATTORNEY: 31ST", state="AL", Actual_Murder="1")],
            exact_map=[], year=2025,
        )
        self.assertEqual(report["excluded"]["ori_collision"], 0)
        self.assertEqual(self.crime("AL0200100", 2025)["murder"], 2)
        self.assertEqual(self.crime("AL020015A", 2025)["murder"], 1)

    def test_a_colliding_row_the_directory_cannot_place_is_dropped_not_substituted(self):
        # Huntsville's shape: the directory knows the city but not the university filing under
        # the same prefix. The city keeps its year; the unplaceable row is excluded and named,
        # never allowed to overwrite the agency the directory does know.
        core.load_agencies(self.conn, [agency_row("AL0470100", "Huntsville", "al")])
        report = core.load_annual(
            self.conn,
            [annual_row("AL04701", 12, agency="HUNTSVILLE", state="AL", Actual_Murder="23"),
             annual_row("AL04701", 12, agency="OAKWOOD UNIVERSITY", state="AL", Actual_Murder="0")],
            exact_map=[], year=2025,
        )
        self.assertEqual(self.crime("AL0470100", 2025)["murder"], 23)
        self.assertEqual(report["excluded"]["ori_collision"], 1)
        self.assertTrue(any("OAKWOOD" in note.upper() for note in report["ambiguities"]))

    def test_a_validated_mapping_outranks_a_name_match_in_a_collision(self):
        # Pontiac files 2025 under MI63190, and a second row files under MI63673, which pads
        # straight onto the survivor ORI. Both are called Pontiac, so a name match cannot
        # separate them -- and the name of the *predecessor* would pull the real row back onto
        # the ORI consolidation deletes. A validated mapping is evidence someone checked; it
        # outranks the heuristic, and the row it does not cover is the one that gives way.
        core.load_agencies(self.conn, [agency_row("MI6367300", "Pontiac", "mi")])
        report = core.load_annual(
            self.conn,
            [annual_row("MI63190", 12, agency="PONTIAC", state="MI", population="62702", Actual_Murder="6"),
             annual_row("MI63673", 0, agency="PONTIAC", state="MI", population="0")],
            exact_map=[core.OriMapping("MI63190", "MI6367300", "Pontiac", "MI")],
            year=2025,
        )
        got = self.crime("MI6367300", 2025)
        self.assertEqual(got["murder"], 6, "the reported year lost to a row that filed nothing")
        self.assertEqual(report["excluded"]["ori_collision"], 1)

    def test_when_the_directory_can_place_neither_row_nothing_is_loaded(self):
        # Silently letting the later row win is how the reference importer lost agencies, and
        # which one won depended on file order. With no name the directory recognises, the
        # honest outcome is an empty agency-year and two named exclusions, not a guess.
        report = core.load_annual(
            self.conn,
            [annual_row("TX01111", 12, agency="Neither One", state="TX", Actual_Murder="1"),
             annual_row("TX01111", 12, agency="Nor The Other", state="TX", Actual_Murder="2")],
            exact_map=[], year=2025,
        )
        self.assertEqual(report["excluded"]["ori_collision"], 2)
        self.assertIsNone(self.crime("TX0111100", 2025))
        self.assertEqual(len(report["ambiguities"]), 2, "each dropped row is named on its own")


class ReportingBeatsNonReporting(CoreBuildTestCase):
    """One row that filed and one that did not is not an ambiguity.

    Las Vegas is the case: `NV00201` carries both "LAS VEGAS METRO PD" with twelve months and
    "CITY OF LAS VEGAS DEPT O" with none, and the directory holds only the Metropolitan Police
    Department under that prefix. Neither abbreviation prefix-matches the directory's full name,
    so both were dropped -- taking 1.7 million people and 86 murders with them.
    """

    def setUp(self):
        super().setUp()
        core.load_agencies(self.conn, [
            agency_row("NV0020100", "Las Vegas Metropolitan Police Department", "nv"),
        ])

    def test_the_reporting_row_is_kept_when_its_rivals_filed_nothing(self):
        report = core.load_annual(
            self.conn,
            [annual_row("NV00201", 12, agency="LAS VEGAS METRO PD", state="NV",
                        population="1712136", Actual_Murder="86"),
             annual_row("NV00201", 0, agency="CITY OF LAS VEGAS DEPT O", state="NV", population="0")],
            exact_map=[], year=2025,
        )
        self.assertEqual(self.crime("NV0020100", 2025)["murder"], 86)
        self.assertEqual(report["excluded"]["ori_collision"], 1)

    def test_the_agency_that_is_the_named_one_beats_a_name_that_merely_starts_with_it(self):
        # `AURORA` and `AURORA UNIVERSITY` both file under IL04501 and both report, so the
        # reporting rule cannot separate them and the city of 170,585 lost its year. One of
        # them is the directory's `Aurora`; the other only begins with it.
        core.load_agencies(self.conn, [agency_row("IL0450100", "Aurora", "il")])
        rows = [annual_row("IL04501", 2, agency="AURORA", state="IL", population="109698",
                           Actual_Murder="1"),
                annual_row("IL04501", 12, agency="AURORA UNIVERSITY", state="IL", population="0")]
        report = core.load_annual(self.conn, rows, [], 2025)
        self.assertEqual(report["written"], 1)
        self.assertEqual(self.crime("IL0450100", 2025)["murder"], 1)
        self.assertEqual(report["excluded"]["ori_collision"], 1)

    def test_two_competitors_with_the_same_exact_name_are_still_refused(self):
        # The rule only fires when exactly one competitor is the named agency.
        core.load_agencies(self.conn, [agency_row("IL0450100", "Aurora", "il")])
        rows = [annual_row("IL04501", 12, agency="AURORA", state="IL", Actual_Murder="1"),
                annual_row("IL04501", 12, agency="Aurora", state="IL", Actual_Murder="9")]
        report = core.load_annual(self.conn, rows, [], 2025)
        self.assertEqual(report["written"], 0)

    def test_an_exact_name_does_not_override_a_row_nobody_can_place(self):
        # Las Vegas still resolves by the reporting rule: neither abbreviation is the
        # directory's full name, so the exact-name rule must decline rather than guess.
        core.load_agencies(self.conn, [
            agency_row("NV0020100", "Las Vegas Metropolitan Police Department", "nv")])
        rows = [annual_row("NV00201", 12, agency="LAS VEGAS METRO PD", state="NV",
                           Actual_Murder="86"),
                annual_row("NV00201", 0, agency="CITY OF LAS VEGAS DEPT O", state="NV")]
        report = core.load_annual(self.conn, rows, [], 2025)
        self.assertEqual(report["written"], 1)
        self.assertEqual(self.crime("NV0020100", 2025)["murder"], 86)

    def test_two_rows_that_both_filed_are_still_refused(self):
        report = core.load_annual(
            self.conn,
            [annual_row("NV00201", 12, agency="ONE THING", state="NV", Actual_Murder="5"),
             annual_row("NV00201", 11, agency="ANOTHER THING", state="NV", Actual_Murder="7")],
            exact_map=[], year=2025,
        )
        self.assertIsNone(self.crime("NV0020100", 2025))
        self.assertEqual(report["excluded"]["ori_collision"], 2)

    def test_no_reporting_row_at_all_is_still_refused(self):
        report = core.load_annual(
            self.conn,
            [annual_row("NV00201", 0, agency="ONE THING", state="NV"),
             annual_row("NV00201", 0, agency="ANOTHER THING", state="NV")],
            exact_map=[], year=2025,
        )
        self.assertIsNone(self.crime("NV0020100", 2025))
        self.assertEqual(report["excluded"]["ori_collision"], 2)


class StateCodeAliases(CoreBuildTestCase):
    """The two sources spell two states differently, and the application already knows it.

    The annual file writes Nebraska as NE and Guam as GU; Historical writes them nb and gm.
    Read as a contradiction, that rejected Omaha, Lincoln, Douglas County, Sarpy County and the
    Guam Police Department outright. `lib/query-contract.ts` carries the same two aliases.
    """

    def setUp(self):
        super().setUp()
        core.load_agencies(self.conn, [
            agency_row("NB0280200", "Omaha", "nb"),
            agency_row("GM0010000", "Guam Police Department", "gm"),
            agency_row("MT0010100", "Elsewhere", "mt"),
        ])

    def resolve(self, ori7, agency, state):
        return core.resolve_annual_ori(
            ori7, [], core.build_prefix_index(self.conn),
            agency_name=agency, state=state, name_index=core.build_prefix_name_index(self.conn),
        )

    def test_nebraska_resolves_across_the_spelling(self):
        ori, _ = self.resolve("NB02802", "OMAHA", "NE")
        self.assertEqual(ori, "NB0280200")

    def test_guam_resolves_across_the_spelling(self):
        ori, _ = self.resolve("GM00100", "GUAM POLICE DEPARTMENT", "GU")
        self.assertEqual(ori, "GM0010000")

    def test_a_genuinely_wrong_state_is_still_refused(self):
        # The two aliases are named, not a general loosening of the check.
        with self.assertRaises(core.AmbiguousOri):
            self.resolve("MT00101", "Elsewhere", "WY")

    def test_omaha_loads_through_the_annual_step(self):
        report = core.load_annual(
            self.conn,
            [annual_row("NB02802", 12, agency="OMAHA", state="NE",
                        population="488395", Actual_Murder="26")],
            exact_map=[], year=2025,
        )
        self.assertEqual(report["excluded"]["ambiguous_ori"], 0)
        self.assertEqual(self.crime("NB0280200", 2025)["murder"], 26)


class Consolidations(CoreBuildTestCase):
    def setUp(self):
        super().setUp()
        core.load_agencies(self.conn, [
            agency_row("MI631900X", "Pontiac", "mi"),
            agency_row("MI6367300", "Pontiac", "mi"),
            agency_row("KY0600500", "Knott", "ky"),
            agency_row("KY0600000", "Knott", "ky"),
        ])

    def transition(self, **over):
        entry = {"predecessor": "MI631900X", "survivor": "MI6367300", "name": "Pontiac",
                 "state": "mi", "scope": core.SCOPE_CRIME_TRANSITION, "evidence": "both listed as Pontiac, MI"}
        entry.update(over)
        return core.Consolidation.from_dict(entry)

    def test_valid_transition_moves_crime_and_removes_the_predecessor(self):
        core.load_base_crime(self.conn, [
            base_row("MI631900X", 1950, murder_total="4"),
            base_row("MI6367300", 1990, murder_total="9"),
        ])
        report = core.apply_consolidations(self.conn, [self.transition()])
        self.assertEqual(report["applied"], 1)
        self.assertEqual(self.crime("MI6367300", 1950)["murder"], 4)
        self.assertEqual(self.crime("MI6367300", 1990)["murder"], 9)
        self.assertIsNone(self.crime("MI631900X", 1950))
        self.assertIsNone(self.conn.execute("SELECT 1 FROM historical_agency WHERE ori='MI631900X'").fetchone())

    def test_transition_never_overwrites_a_year_the_survivor_already_has(self):
        core.load_base_crime(self.conn, [
            base_row("MI631900X", 1990, murder_total="4"),
            base_row("MI6367300", 1990, murder_total="9"),
        ])
        core.apply_consolidations(self.conn, [self.transition()])
        self.assertEqual(self.crime("MI6367300", 1990)["murder"], 9)

    def test_reapplying_to_an_already_consolidated_build_fails_loudly(self):
        # The build always starts from a new database, so a predecessor that has already gone
        # means the manifest and the data disagree. Skipping quietly would let a stale entry
        # sit there looking applied.
        core.load_base_crime(self.conn, [base_row("MI631900X", 1950, murder_total="4")])
        core.apply_consolidations(self.conn, [self.transition()])
        before = core.table_digest(self.conn, "historical_agency_crime")
        with self.assertRaises(core.BuildError):
            core.apply_consolidations(self.conn, [self.transition()])
        self.assertEqual(core.table_digest(self.conn, "historical_agency_crime"), before)

    def test_identity_duplicate_carrying_crime_is_left_unapplied(self):
        # The untracked SQL called these "zero-crime ORIs". Against the real source most of
        # them are not: deleting them would destroy history. Refusing is the whole point.
        core.load_base_crime(self.conn, [base_row("KY0600500", 1975, murder_total="3")])
        entry = core.Consolidation.from_dict({
            "predecessor": "KY0600500", "survivor": "KY0600000", "name": "Knott", "state": "ky",
            "scope": core.SCOPE_IDENTITY_DUPLICATE, "evidence": "same name and state",
        })
        report = core.apply_consolidations(self.conn, [entry])
        self.assertEqual(report["applied"], 0)
        self.assertEqual(len(report["refused"]), 1)
        self.assertIn("crime", report["refused"][0]["reason"].lower())
        self.assertEqual(self.crime("KY0600500", 1975)["murder"], 3)
        self.assertIsNotNone(self.conn.execute("SELECT 1 FROM historical_agency WHERE ori='KY0600500'").fetchone())

    def test_identity_duplicate_without_crime_applies(self):
        entry = core.Consolidation.from_dict({
            "predecessor": "KY0600500", "survivor": "KY0600000", "name": "Knott", "state": "ky",
            "scope": core.SCOPE_IDENTITY_DUPLICATE, "evidence": "same name and state",
        })
        report = core.apply_consolidations(self.conn, [entry])
        self.assertEqual(report["applied"], 1)
        self.assertIsNone(self.conn.execute("SELECT 1 FROM historical_agency WHERE ori='KY0600500'").fetchone())

    def test_missing_survivor_is_a_hard_failure(self):
        with self.assertRaises(core.BuildError):
            core.apply_consolidations(self.conn, [self.transition(survivor="ZZ0000000")])

    def test_state_disagreement_is_a_hard_failure(self):
        with self.assertRaises(core.BuildError):
            core.apply_consolidations(self.conn, [self.transition(state="tx")])


class ClearanceSemantics(CoreBuildTestCase):
    """A rate is a measurement or it is nothing. It is never a stand-in for silence.

    The importer this replaces computed nine rates and then, if all nine came out zero,
    blanked the row and called it non-reporting. An agency that reported offences and
    cleared none of them was recorded as having reported nothing at all.
    """

    def clearance(self, ori, year):
        row = self.conn.execute(
            "SELECT " + ", ".join(core.CLEARANCE_COLUMNS)
            + " FROM historical_agency_clearance WHERE ori=? AND year=?", (ori, year),
        ).fetchone()
        return None if row is None else dict(zip(core.CLEARANCE_COLUMNS, row))

    def test_offences_with_no_clearances_is_zero_percent_beside_a_clearance(self):
        core.load_base_clearance(self.conn, [
            clearance_row("X00000100", 1975, murder_all_total="8", murder_cleared_total="0",
                          robbery_all_total="10", robbery_cleared_total="4"),
        ])
        got = self.clearance("X00000100", 1975)
        self.assertEqual(got["murder_clr"], 0.0)
        self.assertEqual(got["robbery_clr"], 40.0)

    def test_lapd_1960_offences_with_no_clearance_at_all_is_blank(self):
        # LAPD 1960 in the source: 154 murders, 6,068 robberies ... and 0 cleared in every
        # category. Owner rule 2026-10-24: every cleared count zero means clearances unreported.
        core.load_base_clearance(self.conn, [
            clearance_row("X00000100", 1960, murder_all_total="154", murder_cleared_total="0",
                          robbery_all_total="6068", robbery_cleared_total="0"),
        ])
        self.assertEqual(set(self.clearance("X00000100", 1960).values()), {None})

    def test_no_offences_leaves_the_rate_undefined(self):
        core.load_base_clearance(self.conn, [
            clearance_row("X00000100", 1975, murder_all_total="0", murder_cleared_total="0"),
        ])
        self.assertIsNone(self.clearance("X00000100", 1975)["murder_clr"])

    def test_a_missing_denominator_leaves_the_rate_undefined(self):
        core.load_base_clearance(self.conn, [
            clearance_row("X00000100", 1975, murder_cleared_total="3"),
        ])
        self.assertIsNone(self.clearance("X00000100", 1975)["murder_clr"])

    def test_a_missing_numerator_leaves_the_rate_undefined(self):
        core.load_base_clearance(self.conn, [
            clearance_row("X00000100", 1975, murder_all_total="8"),
        ])
        self.assertIsNone(self.clearance("X00000100", 1975)["murder_clr"])

    def test_a_row_of_zero_percent_is_blank(self):
        # Owner rule 2026-10-24 (as before 2026-08-16): every cleared count zero is unreported.
        totals = {}
        for offences, cleared in core.CLEARANCE_SOURCE_PAIRS.values():
            totals[offences] = "5"
            totals[cleared] = "0"
        core.load_base_clearance(self.conn, [clearance_row("X00000100", 1975, **totals)])
        rates = self.clearance("X00000100", 1975)
        self.assertEqual(set(rates.values()), {None})

    def test_a_rate_is_computed_per_measure_not_per_row(self):
        core.load_base_clearance(self.conn, [
            clearance_row("X00000100", 1975,
                          murder_all_total="4", murder_cleared_total="1",
                          robbery_all_total="0", robbery_cleared_total="0"),
        ])
        rates = self.clearance("X00000100", 1975)
        self.assertEqual(rates["murder_clr"], 25.0)
        self.assertIsNone(rates["robbery_clr"])

    def test_annual_derived_totals_need_every_part(self):
        # Violent is not on the annual file, so it is summed. A sum missing one of its parts
        # is not a smaller total, it is an unknown one.
        core.load_agencies(self.conn, [agency_row("AL0012000", "Lipscomb", "al")])
        row = annual_row("AL00120", 12, agency="Lipscomb",
                         Actual_Murder="2", Cleared_Murder="1", Actual_Rape_Total="")
        core.load_annual(self.conn, [row], [], 2025)
        rates = self.clearance("AL0012000", 2025)
        self.assertEqual(rates["murder_clr"], 50.0)
        self.assertIsNone(rates["violent_clr"])

    def test_a_year_nobody_filed_carries_no_rates(self):
        core.load_agencies(self.conn, [agency_row("AL0012000", "Lipscomb", "al")])
        core.load_annual(self.conn, [annual_row("AL00120", 0, agency="Lipscomb")], [], 2025)
        rates = self.clearance("AL0012000", 2025)
        self.assertEqual(set(rates.values()), {None})


class SiblingTableSemantics(CoreBuildTestCase):
    """Population and staffing keep a zero apart from a blank, exactly as crime does."""

    def test_a_population_of_zero_is_a_stated_population(self):
        core.load_base_population(self.conn, [{"id": "X00000100", "year": 1975, "population": "0"}])
        self.assertEqual(self.conn.execute(
            "SELECT population FROM historical_agency_population WHERE ori='X00000100'").fetchone()[0], 0)

    def test_a_blank_population_stays_missing(self):
        core.load_base_population(self.conn, [{"id": "X00000100", "year": 1975, "population": ""}])
        self.assertIsNone(self.conn.execute(
            "SELECT population FROM historical_agency_population WHERE ori='X00000100'").fetchone()[0])

    def test_zero_employees_is_a_count(self):
        core.load_base_staffing(self.conn, [
            {"id": "X00000100", "year": 1975, "all_total": "0", "officer_total": "0", "civilian_total": ""},
        ])
        row = self.conn.execute(
            "SELECT all_total, officer_total, civilian_total FROM historical_staffing").fetchone()
        self.assertEqual((row[0], row[1]), (0, 0))
        self.assertIsNone(row[2], "a blank civilian count is not a zero")

    def test_a_conflicting_duplicate_stops_the_build(self):
        with self.assertRaises(core.BuildError):
            core.load_base_staffing(self.conn, [
                {"id": "X00000100", "year": 1975, "all_total": "5", "officer_total": "5", "civilian_total": "0"},
                {"id": "X00000100", "year": 1975, "all_total": "9", "officer_total": "9", "civilian_total": "0"},
            ])


class PseudoIdentifiers(CoreBuildTestCase):
    """`us` and the two-letter state rows are not agencies and are not written as agencies.

    `historical_state_national` is the application's authority for state and national
    questions -- `CLAUDE.md` and `lib/claude.ts` both say so, `lib/guardrails.ts` warns that
    an unfiltered agency ranking can pick these rows up by accident, and the geo catalogue
    generator already excludes them twice over. The clearance and staffing sources do not
    carry them at all, so keeping them in the other three is what stops the five tables
    describing the same world.
    """

    STATE_ROW = {"id": "al", "name": "Alabama", "state": "", "type": "state"}
    NATION_ROW = {"id": "us", "name": "United States", "state": "", "type": "nation"}

    def test_pseudo_rows_are_recognised_by_all_three_marks(self):
        self.assertTrue(core.is_pseudo_directory_row(self.STATE_ROW))
        self.assertTrue(core.is_pseudo_directory_row(self.NATION_ROW))
        self.assertFalse(core.is_pseudo_directory_row(agency_row("AL0012000", "Lipscomb", "al")))
        # A nine-character agency typed `state` is a state police force, not a state.
        self.assertFalse(core.is_pseudo_directory_row(
            {"id": "AL0010000", "name": "State Police", "state": "al", "type": "state"}))

    def test_they_are_kept_out_of_the_agency_table_and_named(self):
        result = core.load_agencies(self.conn, [
            self.STATE_ROW, self.NATION_ROW, agency_row("AL0012000", "Lipscomb", "al"),
        ])
        self.assertEqual(result["written"], 1)
        self.assertEqual(sorted(result["pseudo_identifiers"]), ["al", "us"])
        self.assertIsNone(self.conn.execute("SELECT 1 FROM historical_agency WHERE ori='us'").fetchone())

    def test_their_crime_and_population_rows_go_with_them(self):
        loaded = core.load_agencies(self.conn, [self.NATION_ROW, agency_row("AL0012000", "Lipscomb", "al")])
        policy = core.IdentifierPolicy(loaded["pseudo_identifiers"])
        crime = core.load_base_crime(self.conn, [
            base_row("us", 2021, murder_total="22536"), base_row("AL0012000", 2021, murder_total="0"),
        ], policy)
        self.assertEqual(crime["pseudo_rows_excluded"], 1)
        self.assertEqual(crime["written"], 1)
        population = core.load_base_population(self.conn, [
            {"id": "us", "year": 2021, "population": "331894354"},
            {"id": "AL0012000", "year": 2021, "population": "2000"},
        ], policy)
        self.assertEqual(population["pseudo_rows_excluded"], 1)
        self.assertEqual(self.crime("us", 2021), None)

    def test_an_unexplained_short_identifier_stops_the_build(self):
        # Silently skipping it would be the same habit that let unexplained state be
        # inherited from one rebuild to the next.
        with self.assertRaises(core.BuildError):
            core.load_base_crime(self.conn, [base_row("zz", 2021, murder_total="1")])


class OrphanIdentifiers(CoreBuildTestCase):
    """A row that joins to no agency may not survive a build.

    It answers no question, appears in no ranking and is reachable by nothing -- while still
    counting towards the row totals `lib/dynamic-facts.ts` publishes into the system prompt.
    Reporting the count in a manifest is not reconciliation; it is unexplained state being
    inherited one layer down. `CA0349950` is the real case: 14 staffing rows, 1940-1959,
    naming an agency no source holds.

    The check runs at the end rather than at load time, because the annual step creates 323
    agencies and a base row read before it would otherwise be judged against a directory that
    is not finished yet.
    """

    def setUp(self):
        super().setUp()
        core.load_agencies(self.conn, [agency_row("CA0349900", "Highway Patrol:", "ca", "state_police")])
        self.tables = [t for t in core.BUILT_TABLES if t != "historical_agency"]

    def stage_orphan(self):
        core.load_base_staffing(self.conn, [
            {"id": "CA0349950", "year": 1959, "all_total": "17", "officer_total": "", "civilian_total": ""},
        ])

    def test_an_orphan_row_fails_the_build(self):
        self.stage_orphan()
        with self.assertRaises(core.BuildError) as raised:
            core.assert_no_orphan_rows(self.conn, self.tables)
        self.assertIn("CA0349950", str(raised.exception))

    def test_a_prefix_sibling_is_not_a_join(self):
        # CA0349950 and CA0349900 share seven characters. That is not identity, and the
        # assertion must not be satisfied by it.
        self.stage_orphan()
        with self.assertRaises(core.BuildError):
            core.assert_no_orphan_rows(self.conn, self.tables)

    def test_every_child_table_is_covered(self):
        for table, rows in (
            ("historical_agency_crime", [base_row("ZZ9999999", 1990, murder_total="1")]),
            ("historical_agency_population", [{"id": "ZZ9999999", "year": 1990, "population": "5"}]),
            ("historical_agency_clearance", [clearance_row("ZZ9999999", 1990, murder_all_total="4",
                                                           murder_cleared_total="1")]),
            ("historical_staffing", [{"id": "ZZ9999999", "year": 1990, "all_total": "3",
                                      "officer_total": "3", "civilian_total": "0"}]),
        ):
            with self.subTest(table=table):
                self.conn.execute("DELETE FROM " + table)
                loader = {"historical_agency_crime": core.load_base_crime,
                          "historical_agency_population": core.load_base_population,
                          "historical_agency_clearance": core.load_base_clearance,
                          "historical_staffing": core.load_base_staffing}[table]
                loader(self.conn, rows)
                with self.assertRaises(core.BuildError):
                    core.assert_no_orphan_rows(self.conn, self.tables)
                self.conn.execute("DELETE FROM " + table)

    def test_a_clean_build_passes(self):
        core.load_base_staffing(self.conn, [
            {"id": "CA0349900", "year": 1971, "all_total": "0", "officer_total": "0", "civilian_total": "0"},
        ])
        core.assert_no_orphan_rows(self.conn, self.tables)


class IdentifierExclusions(CoreBuildTestCase):
    """An exclusion is tracked evidence, and it is checked before it is trusted."""

    ENTRY = {
        "identifier": "CA0349950", "table": "historical_staffing", "rows": 14,
        "reason": "no agency in any source that these rows can be shown to belong to",
        "evidence": ["appears in one source file only"],
    }

    def write(self, entries, tmp):
        path = os.path.join(tmp, "exclusions.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"version": 1, "exclusions": entries}, handle)
        return path

    def test_an_entry_without_evidence_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            bare = {k: v for k, v in self.ENTRY.items() if k != "evidence"}
            with self.assertRaises(core.BuildError):
                core.load_identifier_exclusions(self.write([bare], tmp))

    def test_a_duplicate_entry_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(core.BuildError):
                core.load_identifier_exclusions(self.write([self.ENTRY, self.ENTRY], tmp))

    CHILD_TABLES = [t for t in core.BUILT_TABLES if t != "historical_agency"]

    def staffing_row(self, ori, year):
        return {"id": ori, "year": year, "all_total": "17", "officer_total": "", "civilian_total": ""}

    def load_with_policy(self, rows, table="historical_staffing"):
        """Run one source through the policy so the observed counts are real."""
        policy = core.IdentifierPolicy(pseudo=(), excluded={"CA0349950"})
        loader = {
            "historical_staffing": core.load_base_staffing,
            "historical_agency_population": core.load_base_population,
            "historical_agency_crime": core.load_base_crime,
        }[table]
        loader(self.conn, rows, policy)
        return policy

    def test_a_stale_entry_is_refused(self):
        # The directory now holds the identifier, so the claim that it cannot be placed is
        # false, and honouring it would discard rows that have somewhere to go.
        core.load_agencies(self.conn, [agency_row("CA0349950", "Somewhere", "ca")])
        with tempfile.TemporaryDirectory() as tmp:
            entries = core.load_identifier_exclusions(self.write([self.ENTRY], tmp))
            with self.assertRaises(core.BuildError):
                core.verify_identifier_exclusions(self.conn, entries, self.CHILD_TABLES)

    def test_an_entry_that_excluded_nothing_is_refused(self):
        # The source no longer holds the identifier. The entry would sit in the file
        # reporting its declared 14 forever, describing data nobody has.
        policy = self.load_with_policy([self.staffing_row("CA0349900", 1971)])
        with tempfile.TemporaryDirectory() as tmp:
            entries = core.load_identifier_exclusions(self.write([self.ENTRY], tmp))
            with self.assertRaises(core.BuildError) as raised:
                core.verify_identifier_exclusions(self.conn, entries, self.CHILD_TABLES, policy)
            self.assertIn("no source row was withheld", str(raised.exception))

    def test_a_changed_row_count_is_refused(self):
        # 14 is a measurement, not a label. A source that gains or loses rows for this
        # identifier has changed what the evidence is about.
        policy = self.load_with_policy([self.staffing_row("CA0349950", year) for year in (1940, 1946)])
        with tempfile.TemporaryDirectory() as tmp:
            entries = core.load_identifier_exclusions(self.write([self.ENTRY], tmp))
            with self.assertRaises(core.BuildError) as raised:
                core.verify_identifier_exclusions(self.conn, entries, self.CHILD_TABLES, policy)
            self.assertIn("withheld 2", str(raised.exception))

    def test_the_wrong_table_is_refused(self):
        # The evidence is about staffing. Excluding population rows on the strength of it
        # would be exactly the silent drop this machinery exists to prevent.
        policy = self.load_with_policy(
            [{"id": "CA0349950", "year": 1940, "population": "3053"}],
            table="historical_agency_population",
        )
        with tempfile.TemporaryDirectory() as tmp:
            entries = core.load_identifier_exclusions(self.write([self.ENTRY], tmp))
            with self.assertRaises(core.BuildError) as raised:
                core.verify_identifier_exclusions(self.conn, entries, self.CHILD_TABLES, policy)
            self.assertIn("historical_agency_population", str(raised.exception))

    def test_appearing_in_a_second_table_is_refused(self):
        # Right count in the right table, and one stray row somewhere else. The entry does
        # not cover that row, so the build stops rather than dropping it quietly.
        policy = core.IdentifierPolicy(pseudo=(), excluded={"CA0349950"})
        core.load_base_staffing(
            self.conn, [self.staffing_row("CA0349950", 1940 + n) for n in range(14)], policy)
        core.load_base_crime(self.conn, [base_row("CA0349950", 1940, murder_total="1")], policy)
        with tempfile.TemporaryDirectory() as tmp:
            entries = core.load_identifier_exclusions(self.write([self.ENTRY], tmp))
            with self.assertRaises(core.BuildError) as raised:
                core.verify_identifier_exclusions(self.conn, entries, self.CHILD_TABLES, policy)
            self.assertIn("historical_agency_crime", str(raised.exception))

    def test_the_real_fourteen_row_staffing_exclusion_passes(self):
        policy = core.IdentifierPolicy(pseudo=(), excluded={"CA0349950"})
        core.load_base_staffing(
            self.conn, [self.staffing_row("CA0349950", 1940 + n) for n in range(14)], policy)
        with tempfile.TemporaryDirectory() as tmp:
            entries = core.load_identifier_exclusions(self.write([self.ENTRY], tmp))
            accounting = core.verify_identifier_exclusions(
                self.conn, entries, self.CHILD_TABLES, policy)
        self.assertEqual(accounting["CA0349950"]["rows_observed"], 14)
        self.assertEqual(accounting["CA0349950"]["rows_declared"], 14)
        self.assertEqual(accounting["CA0349950"]["table"], "historical_staffing")

    def test_an_entry_whose_rows_survived_is_refused(self):
        core.load_agencies(self.conn, [agency_row("CA0349900", "Highway Patrol:", "ca")])
        core.load_base_staffing(self.conn, [
            {"id": "CA0349950", "year": 1959, "all_total": "17", "officer_total": "", "civilian_total": ""},
        ])
        with tempfile.TemporaryDirectory() as tmp:
            entries = core.load_identifier_exclusions(self.write([self.ENTRY], tmp))
            with self.assertRaises(core.BuildError) as raised:
                core.verify_identifier_exclusions(
                    self.conn, entries, [t for t in core.BUILT_TABLES if t != "historical_agency"])
            self.assertIn("survived", str(raised.exception))

    def test_a_listed_identifier_is_kept_out_of_every_table(self):
        core.load_agencies(self.conn, [agency_row("CA0349900", "Highway Patrol:", "ca")])
        policy = core.IdentifierPolicy(pseudo=(), excluded={"CA0349950"})
        report = core.load_base_staffing(self.conn, [
            {"id": "CA0349950", "year": 1959, "all_total": "17", "officer_total": "", "civilian_total": ""},
            {"id": "CA0349900", "year": 1971, "all_total": "0", "officer_total": "0", "civilian_total": "0"},
        ], policy)
        self.assertEqual(report["unplaceable_rows_excluded"], 1)
        self.assertEqual(report["written"], 1)
        core.assert_no_orphan_rows(self.conn, [t for t in core.BUILT_TABLES if t != "historical_agency"])

    def test_the_tracked_file_describes_the_real_source(self):
        # The file that ships with the pipeline, not a fixture: if someone edits it into
        # something the loader will not accept, this fails rather than the next build.
        here = os.path.dirname(os.path.abspath(__file__))
        entries = core.load_identifier_exclusions(
            os.path.join(here, "historical_identifier_exclusions.json"))
        self.assertIn("CA0349950", entries)
        self.assertEqual(entries["CA0349950"]["table"], "historical_staffing")
        self.assertEqual(entries["CA0349950"]["rows"], 14)


class SourceNamesAreNotRewritten(CoreBuildTestCase):
    """The directory's name is the source's name.

    The importer this replaces rewrote 3,151 county names: `Jefferson` became
    `Jefferson County`, and `Baltimore County Police Department` became `Baltimore County`.
    Neither string appears in any source. Whether the application can still find a county by
    name is a question about the application.
    """

    def test_a_bare_county_name_is_not_given_a_suffix(self):
        core.load_agencies(self.conn, [agency_row("AL0010000", "Jefferson", "al", "county")])
        self.assertEqual(self.conn.execute(
            "SELECT agency FROM historical_agency WHERE ori='AL0010000'").fetchone()[0], "Jefferson")

    def test_a_full_department_name_is_not_shortened(self):
        core.load_agencies(self.conn, [
            agency_row("MD0030000", "Baltimore County Police Department", "md", "county")])
        self.assertEqual(self.conn.execute(
            "SELECT agency FROM historical_agency WHERE ori='MD0030000'").fetchone()[0],
            "Baltimore County Police Department")


class AlignedIdentity(CoreBuildTestCase):
    """One resolution, four tables. An agency restored in one must be restored in all.

    A per-capita question joins crime to population. If the annual step resolved the same
    seven-character ORI one way for crime and another way for population -- or wrote one and
    not the other -- the join returns nothing and the answer is an empty result rather than
    an error. Silence is the failure mode this class exists to prevent.
    """

    def setUp(self):
        super().setUp()
        core.load_agencies(self.conn, [agency_row("NV0020100", "Las Vegas Metropolitan Police Department", "nv")])

    def test_the_annual_year_lands_in_crime_population_and_clearance_together(self):
        row = annual_row("NV00201", 12, agency="LAS VEGAS METRO PD", state="NV",
                         population="1712136", Actual_Murder="86", Cleared_Murder="43")
        core.load_annual(self.conn, [row], [], 2025)
        self.assertEqual(self.crime("NV0020100", 2025)["murder"], 86)
        self.assertEqual(self.conn.execute(
            "SELECT population FROM historical_agency_population WHERE ori='NV0020100' AND year=2025"
        ).fetchone()[0], 1712136)
        self.assertEqual(self.conn.execute(
            "SELECT murder_clr FROM historical_agency_clearance WHERE ori='NV0020100' AND year=2025"
        ).fetchone()[0], 50.0)

    def test_a_row_the_directory_cannot_place_is_written_to_none_of_them(self):
        # Both rows resolve to one agency and neither filed, so neither is loaded. The point
        # is that all three tables agree about that, rather than one of them keeping a row.
        rows = [annual_row("NV00201", 0, agency="LAS VEGAS METRO PD", state="NV"),
                annual_row("NV00201", 0, agency="CITY OF LAS VEGAS DEPT O", state="NV")]
        report = core.load_annual(self.conn, rows, [], 2025)
        self.assertEqual(report["written"], 0)
        self.assertEqual(report["population_written"], 0)
        self.assertEqual(report["clearance_written"], 0)

    def test_every_table_writes_the_same_number_of_annual_rows(self):
        rows = [annual_row("NV00201", 12, agency="LAS VEGAS METRO PD", state="NV")]
        report = core.load_annual(self.conn, rows, [], 2025)
        self.assertEqual(report["written"], report["population_written"])
        self.assertEqual(report["written"], report["clearance_written"])


class UnknownStateCodes(CoreBuildTestCase):
    """An alias is a claim that two sources spell one place differently. It needs evidence."""

    def setUp(self):
        super().setUp()
        core.load_agencies(self.conn, [
            agency_row("AM0010100", "dept of public safety, p", "am", "other"),
            agency_row("AL0012000", "Lipscomb", "al"),
        ])

    def test_american_samoa_resolves_across_the_spelling(self):
        # The annual row is filed under State `AS`; its own ORI is `AM00101` and the
        # directory holds that agency under `AM`. Both sources agree on the identity.
        row = annual_row("AM00101", 12, agency="DEPT OF PUBLIC SAFETY, P", state="AS",
                         Actual_Murder="1")
        report = core.load_annual(self.conn, [row], [], 2025)
        self.assertEqual(report["written"], 1)
        self.assertEqual(self.crime("AM0010100", 2025)["murder"], 1)
        self.assertEqual(report["unknown_state_codes"], {})

    def test_a_code_the_directory_never_uses_is_reported_not_mapped(self):
        row = annual_row("AL00120", 12, agency="Lipscomb", state="ZQ")
        report = core.load_annual(self.conn, [row], [], 2025)
        self.assertEqual(report["unknown_state_codes"], {"ZQ": 1})

    def test_a_numeric_code_carries_no_state_claim(self):
        # `98` is how federal agencies are filed and `69` appears once. Neither is a state,
        # so neither is reported as an unknown one nor allowed to contradict anything.
        row = annual_row("AL00120", 12, agency="Lipscomb", state="98")
        report = core.load_annual(self.conn, [row], [], 2025)
        self.assertEqual(report["unknown_state_codes"], {})
        self.assertEqual(report["written"], 1)

    def test_an_exact_mapping_compares_normalized_states(self):
        # The mapping says NE and the row says NB, or the other way about. Spelling is not
        # evidence of a different place, and comparing the raw strings refused the row.
        core.load_agencies(self.conn, [agency_row("NB0028000", "Omaha", "nb")])
        mapping = core.OriMapping("NB00280", "NB0028000", "Omaha", "NE")
        target, how = core.resolve_annual_ori(
            "NB00280", [mapping], core.build_prefix_index(self.conn),
            agency_name="Omaha", state="NB", name_index=core.build_prefix_name_index(self.conn))
        self.assertEqual((target, how), ("NB0028000", core.RESOLVED_EXACT))


class ConsolidationAcrossTables(CoreBuildTestCase):
    """One identity cannot be half-absorbed.

    Every keyed table is checked before anything moves in any of them, and the predecessor's
    rows are copied before it is deleted. Both rules come from real entries: Pontiac's two
    ORIs agree on every crime year and disagree on 2015's population, and Indianapolis's
    `INIPD0000` was listed as an empty duplicate while holding the department's entire
    staffing history on an ORI whose survivor has none.
    """

    def setUp(self):
        super().setUp()
        core.load_agencies(self.conn, [
            agency_row("MI631900X", "Pontiac", "mi"),
            agency_row("MI6367300", "Pontiac", "mi"),
            agency_row("INIPD0000", "Indianapolis", "in"),
            agency_row("IN0494900", "Indianapolis", "in"),
        ])

    def transition(self):
        return core.Consolidation.from_dict({
            "predecessor": "MI631900X", "survivor": "MI6367300", "name": "Pontiac", "state": "mi",
            "scope": core.SCOPE_CRIME_TRANSITION, "evidence": "both listed as Pontiac, MI"})

    def duplicate(self):
        return core.Consolidation.from_dict({
            "predecessor": "INIPD0000", "survivor": "IN0494900", "name": "Indianapolis", "state": "in",
            "scope": core.SCOPE_IDENTITY_DUPLICATE, "evidence": "Unigov identifier for the same department"})

    def test_a_population_conflict_refuses_a_transition_whose_crime_agrees(self):
        core.load_base_crime(self.conn, [base_row("MI631900X", 1950, murder_total="4")])
        core.load_base_population(self.conn, [
            {"id": "MI631900X", "year": 2015, "population": "59888"},
            {"id": "MI6367300", "year": 2015, "population": "72884"},
        ])
        report = core.apply_consolidations(self.conn, [self.transition()])
        self.assertEqual(report["applied"], 0)
        self.assertEqual(report["refused"][0]["tables"], {"historical_agency_population": 1})
        self.assertEqual(self.crime("MI631900X", 1950)["murder"], 4, "the predecessor's crime survived")

    def test_a_staffing_conflict_refuses_a_transition_too(self):
        core.load_base_staffing(self.conn, [
            {"id": "MI631900X", "year": 1958, "all_total": "40", "officer_total": "38", "civilian_total": "2"},
            {"id": "MI6367300", "year": 1958, "all_total": "51", "officer_total": "48", "civilian_total": "3"},
        ])
        report = core.apply_consolidations(self.conn, [self.transition()])
        self.assertEqual(report["applied"], 0)
        self.assertIn("historical_staffing", report["refused"][0]["tables"])

    def test_a_duplicate_carries_its_staffing_across_before_it_is_deleted(self):
        core.load_base_staffing(self.conn, [
            {"id": "INIPD0000", "year": 1975, "all_total": "1200", "officer_total": "1100", "civilian_total": "100"},
        ])
        report = core.apply_consolidations(self.conn, [self.duplicate()])
        self.assertEqual(report["applied"], 1)
        self.assertEqual(report["survivor_rows_added"]["historical_staffing"], 1)
        self.assertEqual(self.conn.execute(
            "SELECT officer_total FROM historical_staffing WHERE ori='IN0494900' AND year=1975"
        ).fetchone()[0], 1100)
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM historical_staffing WHERE ori='INIPD0000'").fetchone()[0], 0)

    def test_a_duplicate_whose_rows_the_survivor_already_holds_loses_nothing(self):
        core.load_base_population(self.conn, [
            {"id": "INIPD0000", "year": 1975, "population": "745000"},
            {"id": "IN0494900", "year": 1975, "population": "745000"},
        ])
        report = core.apply_consolidations(self.conn, [self.duplicate()])
        self.assertEqual(report["applied"], 1)
        self.assertEqual(self.conn.execute(
            "SELECT population FROM historical_agency_population WHERE ori='IN0494900' AND year=1975"
        ).fetchone()[0], 745000)

    def test_the_zero_crime_premise_is_still_tested_against_crime(self):
        # 30 of the 38 entries claim an ORI carries no crime and are wrong about it. Widening
        # the safety check to the sibling tables must not quietly turn those into copies.
        core.load_base_crime(self.conn, [base_row("INIPD0000", 1975, murder_total="3")])
        report = core.apply_consolidations(self.conn, [self.duplicate()])
        self.assertEqual(report["applied"], 0)
        self.assertIn("no crime", report["refused"][0]["reason"])
        self.assertEqual(self.crime("INIPD0000", 1975)["murder"], 3)


class OverlappingHistory(CoreBuildTestCase):
    """A transition may only be applied where the two ORIs do not both hold the same years.

    Copying the predecessor's rows in with INSERT OR IGNORE and then deleting the predecessor
    silently discarded whichever years the survivor already had. Allegheny County is the worst
    case in the real sources: 53 overlapping years, 48 of which differ. Losing 48 years of a
    county's history to a merge nobody could see is not a consolidation.
    """

    def setUp(self):
        super().setUp()
        core.load_agencies(self.conn, [
            agency_row("PA0020000", "Allegheny", "pa"),
            agency_row("PA0022800", "Allegheny County Police Department", "pa"),
        ])

    def entry(self):
        return core.Consolidation.from_dict({
            "predecessor": "PA0020000", "survivor": "PA0022800", "name": "Allegheny",
            "state": "pa", "scope": core.SCOPE_CRIME_TRANSITION, "evidence": "both listed in PA",
        })

    def test_conflicting_overlap_is_refused_and_both_agencies_survive(self):
        core.load_base_crime(self.conn, [
            base_row("PA0020000", 1975, murder_total="7"),
            base_row("PA0022800", 1975, murder_total="9"),
        ])
        report = core.apply_consolidations(self.conn, [self.entry()])
        self.assertEqual(report["applied"], 0)
        self.assertEqual(len(report["refused"]), 1)
        self.assertIn("overlap", report["refused"][0]["reason"].lower())
        self.assertEqual(self.crime("PA0020000", 1975)["murder"], 7, "the predecessor's year was destroyed")
        self.assertEqual(self.crime("PA0022800", 1975)["murder"], 9)
        self.assertIsNotNone(self.conn.execute("SELECT 1 FROM historical_agency WHERE ori='PA0020000'").fetchone())

    def test_overlap_the_predecessor_left_blank_is_not_a_conflict(self):
        # Franklin and Broomfield look like this in the real sources: years in common, but the
        # predecessor holds nothing for them, so the survivor loses nothing.
        core.load_base_crime(self.conn, [
            base_row("PA0020000", 1975),
            base_row("PA0020000", 1950, murder_total="4"),
            base_row("PA0022800", 1975, murder_total="9"),
        ])
        report = core.apply_consolidations(self.conn, [self.entry()])
        self.assertEqual(report["applied"], 1)
        self.assertEqual(self.crime("PA0022800", 1950)["murder"], 4)
        self.assertEqual(self.crime("PA0022800", 1975)["murder"], 9)

    def test_identical_overlapping_values_are_not_a_conflict(self):
        core.load_base_crime(self.conn, [
            base_row("PA0020000", 1975, murder_total="9"),
            base_row("PA0022800", 1975, murder_total="9"),
        ])
        self.assertEqual(core.apply_consolidations(self.conn, [self.entry()])["applied"], 1)

    def test_a_population_conflict_is_a_conflict(self):
        # The comparison looked at crime and skipped population, so Franklin and Broomfield
        # still applied while losing 25 and 23 differing predecessor populations. Broomfield's
        # 2002 pair is 20,752 against 40,098: those are not one jurisdiction's history.
        core.load_base_crime(self.conn, [
            base_row("PA0020000", 2002, population="20752", murder_total="1"),
            base_row("PA0022800", 2002, population="40098", murder_total="1"),
        ])
        report = core.apply_consolidations(self.conn, [self.entry()])
        self.assertEqual(report["applied"], 0)
        self.assertIn("overlap", report["refused"][0]["reason"].lower())
        self.assertEqual(
            self.conn.execute("SELECT population FROM historical_agency_crime WHERE ori='PA0020000'").fetchone()[0],
            20752,
        )

    def test_a_population_the_predecessor_left_blank_is_not_a_conflict(self):
        core.load_base_crime(self.conn, [
            base_row("PA0020000", 2002, murder_total="1"),
            base_row("PA0022800", 2002, population="40098", murder_total="1"),
        ])
        self.assertEqual(core.apply_consolidations(self.conn, [self.entry()])["applied"], 1)

    def test_an_absent_predecessor_is_a_hard_failure(self):
        entry = core.Consolidation.from_dict({
            "predecessor": "ZZ9999999", "survivor": "PA0022800", "name": "Allegheny",
            "state": "pa", "scope": core.SCOPE_CRIME_TRANSITION, "evidence": "x",
        })
        with self.assertRaises(core.BuildError):
            core.apply_consolidations(self.conn, [entry])


class IdentityFromStateAndName(CoreBuildTestCase):
    """The canonical +00 form is a default, not a licence to contradict the row."""

    def setUp(self):
        super().setUp()
        core.load_agencies(self.conn, [
            agency_row("NY0511100", "Bellport Village", "ny"),
            agency_row("NY05111TZ", "Port Jefferson", "ny"),
            agency_row("AK0012600", "Fairbanks International Airport", "ak"),
            agency_row("AL0013500", "norfolk southern railway", "al"),
            agency_row("AL001359E", "Norfolk Southern Railway", "al"),
            agency_row("MT0010100", "Elsewhere", "mt"),
        ])

    def resolve(self, ori7, agency, state, exact_map=()):
        return core.resolve_annual_ori(
            ori7, list(exact_map), core.build_prefix_index(self.conn),
            agency_name=agency, state=state, name_index=core.build_prefix_name_index(self.conn),
        )

    def test_a_sibling_that_matches_the_row_beats_the_padded_form(self):
        # PORT JEFFERSON was being filed as Bellport Village purely because Bellport holds the
        # +00 ORI. The directory names Port Jefferson under the same prefix.
        ori, how = self.resolve("NY05111", "PORT JEFFERSON", "NY")
        self.assertEqual(ori, "NY05111TZ")
        self.assertEqual(how, core.RESOLVED_NAME)

    def test_an_abbreviated_name_still_reaches_the_padded_form(self):
        # "FAIRBANKS INTRNL AIRPORT" does not contradict "Fairbanks International Airport";
        # it abbreviates it, and no sibling fits better. Refusing this class would drop
        # thousands of correct rows.
        ori, how = self.resolve("AK00126", "FAIRBANKS INTRNL AIRPORT", "AK")
        self.assertEqual(ori, "AK0012600")
        self.assertEqual(how, core.RESOLVED_PADDED_UNVERIFIED)

    def test_the_padded_form_wins_among_equally_matching_siblings(self):
        ori, how = self.resolve("AL00135", "NORFOLK SOUTHERN RAILWAY", "AL")
        self.assertEqual(ori, "AL0013500")
        self.assertEqual(how, core.RESOLVED_PADDED)

    def test_a_state_that_contradicts_the_row_is_refused(self):
        with self.assertRaises(core.AmbiguousOri):
            self.resolve("MT00101", "Elsewhere", "WY")

    def test_a_numeric_state_code_is_absent_information_not_a_contradiction(self):
        # Federal agencies are filed with State "98", which is not a state at all. Reading it
        # as one refused 351 rows -- ATF and FBI field offices whose ORI resolves perfectly.
        ori, how = self.resolve("MT00101", "Elsewhere", "98")
        self.assertEqual(ori, "MT0010100")
        self.assertIn(how, (core.RESOLVED_PADDED, core.RESOLVED_PADDED_UNVERIFIED))

    def test_a_mapping_is_refused_when_the_row_contradicts_it(self):
        # The mapping file is checked against the directory, but the row was never checked
        # against the mapping. A Texas row named something else was being filed as Pontiac
        # purely because it carried the mapped seven-character ORI.
        core.load_agencies(self.conn, [agency_row("MI6367300", "Pontiac", "mi")])
        mapping = [core.OriMapping("MI63190", "MI6367300", "Pontiac", "MI")]
        with self.assertRaises(core.AmbiguousOri) as raised:
            self.resolve("MI63190", "DIFFERENT AGENCY", "TX", exact_map=mapping)
        message = str(raised.exception)
        self.assertIn("MI63190", message)
        self.assertTrue("TX" in message or "DIFFERENT AGENCY" in message.upper())

    def test_a_mapping_survives_a_federal_state_code(self):
        core.load_agencies(self.conn, [agency_row("MI6367300", "Pontiac", "mi")])
        ori, how = self.resolve("MI63190", "PONTIAC", "98",
                                exact_map=[core.OriMapping("MI63190", "MI6367300", "Pontiac", "MI")])
        self.assertEqual(ori, "MI6367300")
        self.assertEqual(how, core.RESOLVED_EXACT)

    def test_a_validated_mapping_still_outranks_every_name_rule(self):
        core.load_agencies(self.conn, [agency_row("MI6367300", "Pontiac", "mi"),
                                       agency_row("MI631900X", "Pontiac", "mi")])
        ori, how = self.resolve("MI63190", "PONTIAC", "MI",
                                exact_map=[core.OriMapping("MI63190", "MI6367300", "Pontiac", "MI")])
        self.assertEqual(ori, "MI6367300")
        self.assertEqual(how, core.RESOLVED_EXACT)


class AnnualSourceChecks(CoreBuildTestCase):
    def test_a_row_from_another_year_stops_the_build(self):
        core.load_agencies(self.conn, [agency_row("AL0012000", "Lipscomb", "al")])
        row = annual_row("AL00120", 12, agency="Lipscomb", state="AL")
        row["Year"] = "2024"
        with self.assertRaises(core.BuildError) as raised:
            core.load_annual(self.conn, [row], exact_map=[], year=2025)
        self.assertIn("2024", str(raised.exception))


class OfflineSafety(unittest.TestCase):
    """Neither entry point may be able to open a real database."""

    FORBIDDEN = ("crime_data.db", "nibrs.db", "shr.db", "query_log.db",
                 os.path.join("C:\\", "Users", "jeffm", "crime-data-assistant", "crime_data.db"),
                 "/opt/nibrs/shared/crime_data.db")

    def test_the_strict_destination_guard_refuses_canonical_names(self):
        for path in self.FORBIDDEN:
            with self.assertRaises(core.BuildError, msg=f"{path} was accepted"):
                core.assert_safe_destination(path)

    def test_the_importer_guard_refuses_canonical_names(self):
        for path in self.FORBIDDEN:
            with self.assertRaises(core.BuildError, msg=f"{path} was accepted"):
                core.assert_not_canonical(path)

    def test_the_importer_refuses_before_it_opens_anything(self):
        # The guard has to run before sqlite3.connect, or a refused run still creates a file.
        import import_historical
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "crime_data.db")
            with self.assertRaises(core.BuildError):
                # --state-workbook is required since the historical national rape fix (amendment 1/2); the refusal
                # this test proves still comes before anything is opened.
                import_historical.main(["--db", target, "--source-dir", tmp,
                                        "--state-workbook", os.path.join(tmp, "State_National_Historical.xlsx")])
            self.assertFalse(os.path.exists(target), "a refused destination was still created")

    def test_a_rebuildable_copy_is_accepted_by_the_importer_guard(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "historical_copy.db")
            core.assert_not_canonical(path)
            open(path, "wb").close()
            core.assert_not_canonical(path)  # re-runnable, unlike the strict guard

    def test_outputs_must_differ_from_every_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = os.path.join(tmp, "geographies.csv")
            open(source, "w").close()
            with self.assertRaises(core.BuildError):
                core.assert_distinct_outputs([source], [source])
            core.assert_distinct_outputs([source], [os.path.join(tmp, "out.db")])

    def test_a_collision_hiding_behind_letter_case_is_still_a_collision(self):
        # Windows paths are case-insensitive, so comparing them case-sensitively lets an output
        # sit on an input under a different spelling.
        #
        # Where the filesystem itself folds case, the real call is the test. On a case-sensitive
        # filesystem (the Linux CI runner) the two spellings really are two files, so the Windows
        # rule is exercised by giving the guard Windows path folding (ntpath.normcase) -- the same
        # assertion, against the same code, on every platform.
        with tempfile.TemporaryDirectory() as tmp:
            source = os.path.join(tmp, "Geographies.csv")
            open(source, "w").close()
            other = os.path.join(tmp, "geographies.csv")
            if os.path.exists(other):
                with self.assertRaises(core.BuildError):
                    core.assert_distinct_outputs([source], [other])
            else:
                import ntpath
                from unittest import mock
                with mock.patch.object(core.os.path, "normcase", ntpath.normcase):
                    with self.assertRaises(core.BuildError):
                        core.assert_distinct_outputs([source], [other])
                # Non-vacuity: unpatched, the case-sensitive filesystem's answer stands.
                core.assert_distinct_outputs([source], [other])

    def test_an_existing_manifest_is_refused_before_anything_is_written(self):
        # assert_distinct_outputs stopped inputs being clobbered, but the manifest was later
        # opened with "w", so a build could quietly replace the evidence from an earlier run.
        import build_historical_core
        with tempfile.TemporaryDirectory() as tmp:
            manifest = os.path.join(tmp, "manifest.json")
            with open(manifest, "w", encoding="utf-8") as handle:
                handle.write('{"status": "evidence from an earlier build"}')
            source = os.path.join(tmp, "geographies.csv")
            open(source, "w").close()
            args = argparse.Namespace(
                geographies=source, base_crime=source, populations=source, clearance=source,
                staffing=source, annual=None, annual_year=2025,
                consolidations=source, ori_map=None, exclusions=None,
                out=os.path.join(tmp, "new.db"),
                manifest=manifest, reverse_input_order=False,
            )
            with self.assertRaises(core.BuildError):
                build_historical_core.build(args)
            with open(manifest, encoding="utf-8") as handle:
                self.assertIn("earlier build", handle.read(), "the earlier manifest was overwritten")
            self.assertFalse(os.path.exists(args.out), "a database was created despite the refusal")


class Determinism(unittest.TestCase):
    AGENCIES = [
        agency_row("AL0012000", "Lipscomb", "al"),
        agency_row("AK0012500", "Metlakatla Tribal", "ak"),
        agency_row("MI631900X", "Pontiac", "mi"),
        agency_row("MI6367300", "Pontiac", "mi"),
    ]
    BASE = [
        base_row("AK0012500", 2024, **{m: "0" for m in core.BASE_MEASURE_COLUMNS}),
        base_row("AL0012000", 2023, murder_total="2"),
        base_row("MI631900X", 1950, murder_total="4"),
        base_row("MI6367300", 1990, murder_total="9"),
    ]
    ANNUAL = [
        annual_row("AL00120", 12, agency="Lipscomb", state="AL"),
        annual_row("AK00125", 0, agency="Metlakatla Tribal", state="AK"),
        annual_row("MI63190", 12, agency="Pontiac", state="MI", Actual_Murder="6"),
    ]

    def build(self, agencies, base, annual):
        conn = sqlite3.connect(":memory:")
        core.create_core_tables(conn)
        core.load_agencies(conn, agencies)
        core.load_base_crime(conn, base)
        core.load_annual(conn, annual, exact_map=[core.OriMapping("MI63190", "MI6367300", "Pontiac", "MI")], year=2025)
        core.apply_consolidations(conn, [core.Consolidation.from_dict({
            "predecessor": "MI631900X", "survivor": "MI6367300", "name": "Pontiac", "state": "mi",
            "scope": core.SCOPE_CRIME_TRANSITION, "evidence": "both listed as Pontiac, MI",
        })])
        digests = (core.table_digest(conn, "historical_agency"), core.table_digest(conn, "historical_agency_crime"))
        conn.close()
        return digests

    def test_shuffled_input_produces_identical_digests(self):
        forward = self.build(self.AGENCIES, self.BASE, self.ANNUAL)
        reversed_ = self.build(self.AGENCIES[::-1], self.BASE[::-1], self.ANNUAL[::-1])
        self.assertEqual(forward, reversed_)

    def test_pontiac_2025_survives_the_consolidation(self):
        # The ordering trap, end to end: 2025 attaches to the survivor, so removing the
        # predecessor afterwards cannot take the year with it.
        conn = sqlite3.connect(":memory:")
        core.create_core_tables(conn)
        core.load_agencies(conn, self.AGENCIES)
        core.load_base_crime(conn, self.BASE)
        core.load_annual(conn, self.ANNUAL, exact_map=[core.OriMapping("MI63190", "MI6367300", "Pontiac", "MI")], year=2025)
        core.apply_consolidations(conn, [core.Consolidation.from_dict({
            "predecessor": "MI631900X", "survivor": "MI6367300", "name": "Pontiac", "state": "mi",
            "scope": core.SCOPE_CRIME_TRANSITION, "evidence": "both listed as Pontiac, MI",
        })])
        row = conn.execute("SELECT murder FROM historical_agency_crime WHERE ori='MI6367300' AND year=2025").fetchone()
        conn.close()
        self.assertIsNotNone(row, "2025 Pontiac was lost with its predecessor ORI")
        self.assertEqual(row[0], 6)


class DestinationSafety(unittest.TestCase):
    """The maintained pipeline must never be able to open the canonical database."""

    def test_canonical_database_is_refused(self):
        for path in ("crime_data.db", os.path.join("C:\\", "Users", "jeffm", "crime-data-assistant", "crime_data.db"),
                     "/opt/nibrs/shared/crime_data.db", "nibrs.db"):
            with self.assertRaises(core.BuildError, msg=f"{path} was accepted"):
                core.assert_safe_destination(path)

    def test_a_fresh_temporary_destination_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            core.assert_safe_destination(os.path.join(tmp, "historical_core.db"))


class ConsolidationManifestFile(unittest.TestCase):
    """The shipped manifest is data, and every entry has to carry its own evidence."""

    def test_shipped_manifest_parses_and_is_fully_evidenced(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "historical_consolidations.json")
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)
        entries = [core.Consolidation.from_dict(e) for e in payload["entries"]]
        self.assertTrue(entries)
        seen = set()
        for entry in entries:
            self.assertTrue(entry.evidence.strip(), f"{entry.predecessor} has no evidence")
            self.assertIn(entry.scope, (core.SCOPE_CRIME_TRANSITION, core.SCOPE_IDENTITY_DUPLICATE))
            self.assertNotIn(entry.predecessor, seen, f"{entry.predecessor} appears twice")
            seen.add(entry.predecessor)
            self.assertNotEqual(entry.predecessor, entry.survivor)


if __name__ == "__main__":
    unittest.main(verbosity=2)
