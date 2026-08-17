"""
Rebuilding the two Historical core tables, as properties rather than as a run log.

The defect this suite exists to stop is a rewrite both importers performed: when every
crime measure for an agency-year was zero, all of them were overwritten with NULL and the
row was called "non-reporting". A reported zero and a missing value became the same thing.
Most of what follows is about keeping those two apart, at every stage, in both eras.

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
    assert not values, f"unknown value(s): {sorted(values)}"
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
    """1930-2024. The upstream R builder already blanked zero-month rows, so a zero that
    survives into the CSV is a value and must arrive as a value."""

    def test_all_zero_row_stays_zero(self):
        core.load_agencies(self.conn, [agency_row("AK0012500", "Metlakatla Tribal", "ak")])
        core.load_base_crime(self.conn, [base_row("AK0012500", 2024, **{m: "0" for m in core.BASE_MEASURE_COLUMNS})])
        self.assertEqual(self.crime("AK0012500", 2024), {m: 0 for m in core.CRIME_MEASURES})

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

    def test_twelve_months_of_zero_stays_zero(self):
        core.load_annual(self.conn, [annual_row("AL00120", 12)], exact_map=[], year=2025)
        got = self.crime("AL0012000", 2025)
        self.assertEqual(got["murder"], 0)
        self.assertEqual(got["violent"], 0)
        self.assertEqual(got["property"], 0)

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
                import_historical.main(["--db", target, "--source-dir", tmp])
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
        with tempfile.TemporaryDirectory() as tmp:
            source = os.path.join(tmp, "Geographies.csv")
            open(source, "w").close()
            with self.assertRaises(core.BuildError):
                core.assert_distinct_outputs([source], [os.path.join(tmp, "geographies.csv")])

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
                geographies=source, base_crime=source, annual=None, annual_year=2025,
                consolidations=source, ori_map=None, out=os.path.join(tmp, "new.db"),
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
